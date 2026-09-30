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
 */

export type WorkflowAgentRequest = {
  system: string;
  prompt: string;
  maxTokens: number;
  model?: string;
  signal: AbortSignal;
  /** 引擎注入的进展通道：一次传输往返记一轮（重置无进展计时、计入轮数预算）。可缺省。 */
  progress?: StallProgress;
};

export type WorkflowAgentResult = {
  text: string;
  outputTokens: number;
};

export type WorkflowAgentAdapter = {
  complete(request: WorkflowAgentRequest): Promise<WorkflowAgentResult>;
};

export type AdapterFactory = (context: { runId: string; dispatchId: string; clock?: Clock }) => WorkflowAgentAdapter;

/**
 * 子 agent 的行为约束——模块自足拼接，与会话侧提示词互不引用。
 * 三条硬要求：最终文本即返回值、禁止确认语、结构化模式下只经结构化出口产出。
 */
export const AGENT_SYSTEM_PROMPT = [
  'You are one agent inside a local workflow run.',
  'Return your final answer as plain text: the last text you produce is the result handed back to the script.',
  'Do not ask questions, do not ask for confirmation, and do not narrate next steps; produce the work itself.',
  'You work in isolation: another agent may be running the same task in a separate directory at the same time.',
].join(' ');

export function llmBackedFactory(settings: SubagentSettings, make?: () => LlmAdapter): AdapterFactory {
  return (context) => {
    // 一切时间经引擎注入的时钟（无则系统钟）：瞬态 backoff 与 stall 看门狗共用一只钟，
    // 测试里可整栈在虚拟钟上协同驱动（ADR §16 "每只钟只有一个持有者"）。
    const base: WorkflowAgentAdapter = {
      complete: async (request) => {
        // 一次传输往返 = 一轮进展：重置 stall 计时、计入 dispatch 轮数预算。
        // 流式增量 / 工具在飞的 activity()/toolStart()/toolEnd() 随执行器接入（#228/#231）补发。
        request.progress?.round();
        // 测试注入缝：make 缺省走真实端点适配器（与会话侧同源）。
        const adapter = make ? make() : createAdapter(settings);
        const { message, usage } = await adapter.create(
          {
            model: request.model ?? settings.model,
            system: request.system,
            messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
            tools: [],
            maxTokens: request.maxTokens > 0 ? request.maxTokens : settings.maxOutput ?? 32_000,
          },
          request.signal,
        );
        const text = message.content
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('')
          .trim();
        return { text, outputTokens: usage.output_tokens ?? 0 };
      },
    };
    // 传输层瞬态重试（模块自持，不复用 subagent 策略）——对 dispatch 透明。
    return withTransientRetry(base, { clock: context.clock ?? systemClock() });
  };
}
