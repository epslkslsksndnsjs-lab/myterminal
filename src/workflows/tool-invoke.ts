import { STRUCTURED_OUTPUT_TOOL, toolByName } from './tool-face.js';
import { gateJsonSchema } from './json-gate.js';
import { encodeToolResult, toolFailure, MAX_TOOL_RESULT_CHARS } from './tool-output.js';
import type { ToolContext, ToolMode } from './tool-face.js';
import type { EncodedToolResult } from './tool-output.js';

/**
 * 一次工具调用的通路——先过面、再过形状、最后才动文件与进程。
 *
 * 三段判定各有具名拒因，全部以"结构化 JSON 的失败载荷"回给模型，绝不抛出后静默：
 *   1. 不在这一跑的工具面上 → tool-not-on-this-face；落在 floor 禁令里 → floor-tool-forbidden，
 *      文案直说这一跑不能扇出、不能说话、不能碰控制面（模型改得动，人看得懂）；
 *   2. 入参形状不合 → bad-tool-input，逐条给出可定位的违例；
 *   3. 工具自己抛错 → tool-failed，把原文带回去，不粉饰也不吞。
 *
 * 每一步都过一遍 floor 结构断言：面是算出来的，也是可证的。
 */

export type ToolCall = { id: string; name: string; input: unknown };

export type ToolFace = { names: readonly string[]; mode: ToolMode };

const FLOOR_HINT: Record<string, string> = {
  workflow_start: 'a workflow path cannot start another run',
  workflow_cancel: 'a workflow path cannot cancel runs',
  subagent_start: 'a workflow path cannot spawn subagents',
  subagent_status: 'a workflow path cannot inspect subagents',
  subagent_abort: 'a workflow path cannot abort subagents',
  wait_for_path: 'waiting on a run is the reducer\'s job, not this path\'s',
  agent: 'a workflow path cannot fan out',
  parallel: 'fan-out lives in the script, not in a tool',
  message_send: 'a workflow path cannot send messages',
  message_inbox: 'a workflow path cannot read an inbox',
  session_context: 'a workflow path cannot read the session',
  session_checkpoint: 'a workflow path cannot checkpoint a session',
  session_inherit: 'a workflow path cannot take over a session',
  ask_user_question: 'a workflow path cannot ask a human',
  enter_plan_mode: 'a workflow path cannot change the host plan mode',
  exit_plan_mode: 'a workflow path cannot change the host plan mode',
  control_send: 'a workflow path cannot touch the control channel',
  skill: 'a workflow path cannot load skills',
  task_create: 'a workflow path keeps no task ledger',
  task_update: 'a workflow path keeps no task ledger',
  task_list: 'a workflow path keeps no task ledger',
  task_get: 'a workflow path keeps no task ledger',
};

/** structured_output 由循环自己接（它带次数上限与终止语义），不走这条通路。 */
export function isStructuredSubmissionCall(call: ToolCall): boolean {
  return call.name === STRUCTURED_OUTPUT_TOOL;
}

export async function invokeToolCall(call: ToolCall, face: ToolFace, context: ToolContext): Promise<EncodedToolResult> {
  if (!face.names.includes(call.name)) {
    const hint = FLOOR_HINT[call.name];
    const reason = hint ? 'floor-tool-forbidden' : 'tool-not-on-this-face';
    const message = hint ?? 'This tool is not on the face resolved for this path.';
    return encodeToolResult(toolFailure(`"${call.name}" is not available here: ${message}`, reason, { available: face.names.join(', ') }));
  }
  const tool = toolByName(call.name);
  if (!tool) throw new Error(`tool face and module catalogue disagree: ${call.name}`);
  if (call.input === undefined || call.input === null || typeof call.input !== 'object' || Array.isArray(call.input)) {
    return encodeToolResult(toolFailure(`${call.name} expects an object of arguments.`, 'bad-tool-input'));
  }
  const input = call.input as Record<string, unknown>;
  try {
    // 形状闸与执行同一条边界：入站对象带 getter / Proxy 时，读它也可能抛——
    // 那同样是这一跑的失败，不外溢成引擎的事故。
    const problems = gateJsonSchema(input, tool.inputSchema);
    if (problems.length > 0) {
      return encodeToolResult(toolFailure(`${call.name}: ${problems.map((problem) => `${problem.path} ${problem.message}`).join('; ')}`, 'bad-tool-input'));
    }
    return encodeToolResult(await tool.run(input, context));
  } catch (error) {
    const message = error && typeof error === 'object' && 'message' in error ? String((error as Error).message) : String(error);
    return encodeToolResult(toolFailure(`${call.name} threw: ${message.slice(0, MAX_TOOL_RESULT_CHARS)}`, 'tool-failed'));
  }
}
