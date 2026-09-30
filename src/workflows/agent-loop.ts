import { agentFailure } from './failures.js';
import { gateJsonSchema } from './json-gate.js';
import { STRUCTURED_OUTPUT_TOOL, toolDeclarations } from './tool-face.js';
import { invokeToolCall, isStructuredSubmissionCall } from './tool-invoke.js';
import { encodeToolResult, toolFailure } from './tool-output.js';
import type { ToolCall } from './tool-invoke.js';
import type { ToolContext } from './tool-face.js';
import type { WorkflowAgentAdapter, WorkflowAgentMessage } from './adapter.js';
import type { StallProgress } from './stall.js';

/**
 * 每路 agent 自己的循环——模块的第二条 agent loop，与会话侧执行器零共享。
 *
 * 四段语义：
 *   1. 一轮 = 一次模型往返；轮数由外层的 dispatch 轮数预算管着，这里另设一道闸，
 *      以免假模型不报进展时无限打转（越闸即该路 max_turns 判败）。
 *   2. 工具在飞时挂起无进展计时（慢工具不是 stall），落地即恢复；中止信号贯穿每个工具。
 *   3. 最终文本 = 返回值：模型不再调工具时，它这一轮说的话就是这一路交回脚本的东西。
 *   4. schema 模式只有 structured_output 一个出口：校验通过即终止这一路并带对象回去；
 *      不合规的提交回错误给模型重试，第三次仍不合即这一路判败（缺结构化输出，该路无结果）。
 */

export const MAX_FAILED_STRUCTURED_SUBMISSIONS = 3;

export type AgentPathOutcome = {
  text: string;
  outputTokens: number;
  rounds: number;
  hasStructured: boolean;
  structured?: unknown;
};

export type AgentLoopOptions = {
  adapter: WorkflowAgentAdapter;
  system: string;
  prompt: string;
  maxTokens: number;
  model?: string;
  signal: AbortSignal;
  progress?: StallProgress;
  toolNames: readonly string[];
  context: ToolContext;
  schema?: Record<string, unknown>;
  /** 轮数闸：由外层 dispatch 轮数预算给（引擎传 gates.dispatchTurns），这里不设默认。 */
  maxRounds: number;
};

/** 结构化出口的对外声明：参数形状就是这一路的 schema，成功与否由循环判。 */
export function structuredOutputDeclaration(schema: Record<string, unknown>): { name: string; description: string; input_schema: Record<string, unknown> } {
  return {
    name: STRUCTURED_OUTPUT_TOOL,
    description: 'Hand back this path\'s result. The arguments must be the result object itself, shaped exactly as the schema above. This is the only accepted way to finish a schema path.',
    input_schema: schema,
  };
}

function toolUseBlocks(calls: readonly ToolCall[], text: string): WorkflowAgentMessage['content'] {
  const blocks: WorkflowAgentMessage['content'] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const call of calls) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input as Record<string, unknown> });
  return blocks;
}

function submissionProblem(submission: unknown, schema: Record<string, unknown> | undefined): string | undefined {
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) return 'the submission must be one JSON object';
  const violations = gateJsonSchema(submission, schema ?? {});
  if (violations.length === 0) return undefined;
  return violations.map((violation) => `${violation.path} ${violation.message}`).join('; ');
}

export async function runAgentPath(options: AgentLoopOptions): Promise<AgentPathOutcome> {
  const schema = options.schema;
  const declarations = toolDeclarations(options.toolNames);
  if (schema) declarations.push(structuredOutputDeclaration(schema));
  const maxRounds = Math.max(1, Math.floor(options.maxRounds));

  const messages: WorkflowAgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }];
  let outputTokens = 0;
  let failedSubmissions = 0;

  for (let round = 1; round <= maxRounds; round++) {
    const result = await options.adapter.complete({
      system: options.system,
      prompt: options.prompt,
      maxTokens: options.maxTokens,
      ...(options.model ? { model: options.model } : {}),
      signal: options.signal,
      ...(options.progress ? { progress: options.progress } : {}),
      tools: declarations,
      messages,
    });
    outputTokens += result.outputTokens;

    const calls = result.toolUses ?? [];
    messages.push({ role: 'assistant', content: toolUseBlocks(calls, result.text) });
    if (calls.length === 0) return { text: result.text, outputTokens, rounds: round, hasStructured: false };

    const batch: Array<{ call: ToolCall; outcome: Awaited<ReturnType<typeof invokeToolCall>> }> = [];
    for (const call of calls) {
      if (isStructuredSubmissionCall(call)) {
        const problem = schema ? submissionProblem(call.input, schema) : 'this path has no schema, so structured_output is not accepted';
        if (!problem) {
          return { text: result.text, outputTokens, rounds: round, hasStructured: true, structured: call.input };
        }
        failedSubmissions += 1;
        if (failedSubmissions >= MAX_FAILED_STRUCTURED_SUBMISSIONS) {
          throw agentFailure('no_structured_output', `This path refused ${failedSubmissions} structured submissions; the last one failed: ${problem}`);
        }
        batch.push({
          call,
          outcome: encodeToolResult(toolFailure(`The submission does not fit the schema: ${problem}. Submission ${failedSubmissions} of ${MAX_FAILED_STRUCTURED_SUBMISSIONS}.`, 'bad-structured-submission')),
        });
        continue;
      }
      options.progress?.toolStart();
      try {
        const outcome = await invokeToolCall(call, { names: options.toolNames, mode: options.context.mode }, options.context);
        batch.push({ call, outcome });
      } finally {
        options.progress?.toolEnd();
      }
    }
    // 一轮里的全部工具结果合成一条 user 消息：协议要求 tool_result 成批回填，逐个发会拆散配对。
    messages.push({
      role: 'user',
      content: batch.map(({ call, outcome }) => ({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, is_error: outcome.isError })),
    });
  }

  throw agentFailure('max_turns', `This path used all ${maxRounds} rounds without handing back a result.`);
}
