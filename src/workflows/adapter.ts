import { createAdapter, type LlmAdapter } from '../subagent/llm-adapter.js';
import type { SubagentSettings } from '../types.js';
import { systemClock, type Clock } from './clock.js';
import { withTransientRetry } from './llm-retry.js';
import type { StallProgress } from './stall.js';

/**
 * 每路 agent 的模型通道——只继承既有 LlmAdapter，端点三元组与会话侧同源单配。
 *
 * 每路必须新建独立 adapter 实例：缓存断点是实例态，共享实例会让一路撞到的
 * 限流把其余并发路的缓存断点一起关掉。工厂签名即这条纪律的落点。
 *
 * 两层重试各归各位：这里挂的是 LLM 传输层的瞬态重试（withTransientRetry，backoff
 * 上界 < stall 窗）；路级 stall 看门狗与重试在引擎的 dispatch 层，彼此独立。
 *
 * 一次 complete() = 一次模型往返，也就是循环眼里的一轮：工具表与既有对话随请求进出，
 * 工具块原样带回来，判轮、判进展、判终止都由调用方（模块自己的循环）做。
 */

/** 递给模型的工具声明：名字、描述、入参形状。 */
export type WorkflowAgentTool = { name: string; description: string; input_schema: Record<string, unknown> };

export type WorkflowAgentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean };

export type WorkflowAgentMessage = { role: 'user' | 'assistant'; content: WorkflowAgentBlock[] };

export type WorkflowAgentToolUse = { id: string; name: string; input: unknown };

export type WorkflowAgentRequest = {
  system: string;
  prompt: string;
  maxTokens: number;
  model?: string;
  signal: AbortSignal;
  /** 引擎注入的进展通道：一次传输往返记一轮（重置无进展计时、计入轮数预算）。可缺省。 */
  progress?: StallProgress;
  /** 这一跑的工具面；缺省即不给模型任何工具（单发形态）。 */
  tools?: WorkflowAgentTool[];
  /** 既有对话（首轮只有那条 prompt）。 */
  messages?: WorkflowAgentMessage[];
};

export type WorkflowAgentResult = {
  text: string;
  outputTokens: number;
  /** 模型这一轮要调的工具；没有即空表——单发形态天然为空。 */
  toolUses?: WorkflowAgentToolUse[];
};

export type WorkflowAgentAdapter = {
  complete(request: WorkflowAgentRequest): Promise<WorkflowAgentResult>;
};

export type AdapterFactory = (context: { runId: string; dispatchId: string; clock?: Clock }) => WorkflowAgentAdapter;

/** 回程块的鸭子读法：适配器给的联合类型字段窄，这里只按存在的字段读。 */
type ResponseBlock = { type?: string; text?: string; id?: string; name?: string; input?: unknown };

function textOf(content: readonly ResponseBlock[]): string {
  return content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('').trim();
}

function toolUsesOf(content: readonly ResponseBlock[]): WorkflowAgentToolUse[] {
  const out: WorkflowAgentToolUse[] = [];
  for (const block of content) {
    if (block.type !== 'tool_use') continue;
    out.push({ id: String(block.id ?? ''), name: String(block.name ?? ''), input: block.input });
  }
  return out;
}

export function llmBackedFactory(settings: SubagentSettings, make?: () => LlmAdapter): AdapterFactory {
  return (context) => {
    // 一切时间经引擎注入的时钟（无则系统钟）：瞬态 backoff 与 stall 看门狗共用一只钟，
    // 测试里可整栈在虚拟钟上协同驱动（ADR §16 "每只钟只有一个持有者"）。
    const base: WorkflowAgentAdapter = {
      complete: async (request) => {
        // 一次传输往返 = 一轮进展：重置 stall 计时、计入 dispatch 轮数预算。
        request.progress?.round();
        // 测试注入缝：make 缺省走真实端点适配器（与会话侧同源）。
        const adapter = make ? make() : createAdapter(settings);
        const messages = request.messages?.length
          ? request.messages.map((message) => ({ role: message.role, content: message.content.map((block) => ({ ...block })) }))
          : [{ role: 'user' as const, content: [{ type: 'text' as const, text: request.prompt }] }];
        const { message, usage } = await adapter.create(
          {
            model: request.model ?? settings.model,
            system: request.system,
            messages,
            tools: request.tools ?? [],
            maxTokens: request.maxTokens > 0 ? request.maxTokens : settings.maxOutput ?? 32_000,
          },
          request.signal,
        );
        const content = message.content as readonly ResponseBlock[];
        return {
          text: textOf(content),
          outputTokens: usage.output_tokens ?? 0,
          toolUses: toolUsesOf(content),
        };
      },
    };
    // 传输层瞬态重试（模块自持，不复用 subagent 策略）——对 dispatch 透明。
    return withTransientRetry(base, { clock: context.clock ?? systemClock() });
  };
}
