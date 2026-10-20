// M2：原生 agent loop——subagent executor 的 loop 心脏提升为主系统循环。
//
// 与 runSubagent 的关系：compact/弹性/工具管道全部复用 subagent 既有模块
// （microCompact / autoCompact / ResiliencePolicy / collectStream / executeToolCalls），
// 但本模块不碰 store、不发 AG-UI、不记账落盘——它只 yield AgentEvent
// （src/nativetui/events.ts 形态），由宿主（cli-host）决定如何消费。
// 子代理路径（runSubagent）保持原样。

import type { AgentEvent } from '../nativetui/events.js';
import type { LlmAdapter, StreamChunk } from '../subagent/llm-adapter.js';
import { LlmError, collectStream, normalizeMessages } from '../subagent/llm-adapter.js';
import type { NormalizedMessage } from '../subagent/token-counter.js';
import { estimateMessageTokens } from '../subagent/token-counter.js';
import { ResiliencePolicy, MAX_SERVER_RETRIES } from '../subagent/resilience-policy.js';
import { MAX_COMPACT_FAILURES, autoCompact, microCompact } from '../subagent/executor.js';
import { clearFileState } from '../subagent/file-state.js';
import type { ToolCall } from '../subagent/tool-executor.js';
import { executeToolCalls } from '../subagent/tool-executor.js';
import { getAllToolSchemas, getToolNames } from '../subagent/tools.js';
import type { JsonSchema } from '../types.js';

// ════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════

/** 会话上下文：messages 就地突变，宿主跨轮持有。 */
export type AgentContext = {
  system: string;
  messages: NormalizedMessage[];
};

export type ToolSchema = { name: string; description: string; input_schema: JsonSchema };

export type AgentLoopOptions = {
  adapter: LlmAdapter;
  model: string;
  context: AgentContext;
  cwd: string;
  agentId: string;
  signal: AbortSignal;
  /** 决策 5：LLM 调用轮次上限（一次 runAgent = 一个用户轮的内部循环）。 */
  maxTurns?: number;
  maxTokens?: number;
  /** ADR-0045 D5：autocompact 阈值，缺省 80000（与 executor 一致）。 */
  compactThreshold?: number;
  /** 决策 21：server_overload 降级模型。 */
  fallbackModel?: string;
  /** 覆盖工具面（测试注入）；缺省取 subagent 注册表。 */
  toolSchemas?: ToolSchema[];
};

/** 可中止 sleep：退避期间用户 abort 立刻结束。 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function toAgentUsage(usage: { input_tokens: number; output_tokens: number }) {
  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
  };
}

/**
 * 流事件桥：collectStream 的 onChunk 是回调，runAgent 是异步生成器。
 * 回调推来的事件入队，drain() 按到达顺序 yield；collectStream 结束
 * （resolve 或 reject）后队列排空并结束。
 */
class EventQueue {
  private items: AgentEvent[] = [];
  private waiters: Array<() => void> = [];
  private settled = false;

  push(event: AgentEvent): void {
    this.items.push(event);
    this.wake();
  }

  watch(settle: Promise<unknown>): void {
    const done = () => {
      this.settled = true;
      this.wake();
    };
    settle.then(done, done);
  }

  /** 消费者提前退出时调用：唤醒挂起的 drain() 并丢弃后续事件。 */
  close(): void {
    this.settled = true;
    this.items.length = 0;
    this.wake();
  }

  async *drain(): AsyncGenerator<AgentEvent> {
    while (true) {
      if (this.items.length > 0) {
        yield* this.items.splice(0);
        continue;
      }
      if (this.settled) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const resolve of pending) resolve();
  }
}

/** 就地替换消息（保持 context.messages 引用不变）。 */
function replaceMessages(target: NormalizedMessage[], next: NormalizedMessage[]): void {
  // microCompact 会原样返回同一数组引用——先快照，否则清空即抹掉历史
  const snapshot = next === target ? [...next] : next;
  target.length = 0;
  // 逐条 push：spread 在超长历史上会触发 RangeError
  for (const m of snapshot) target.push(m);
}

// ════════════════════════════════════════════════════════════════
// runAgent：一个用户轮的内部循环
// ════════════════════════════════════════════════════════════════

/**
 * 运行一个用户轮：stream LLM → 执行 tool_calls → 结果回填 context →
 * 直到模型不再调工具（end_turn/max_tokens）、abort、错误或 maxTurns 耗尽。
 *
 * 事件流即渲染契约：assistant_text（流式）、tool_call（参数完整后发）、
 * tool_result（is_error 带 'error:' 前缀，event-adapter 据此标红）、
 * usage、retry、turn_end（end_turn | max_tokens | aborted | error）。
 */
export async function* runAgent(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const { adapter, model, context, signal, cwd, agentId } = options;
  const messages = context.messages;
  const maxTurns = options.maxTurns ?? 700;
  const maxTokens = options.maxTokens ?? 32_000;
  const threshold = options.compactThreshold ?? 80_000;

  const toolSchemas =
    options.toolSchemas ?? (() => {
      const names = new Set(getToolNames());
      return getAllToolSchemas().filter((s) => names.has(s.name));
    })();

  const resilience = new ResiliencePolicy();
  let currentModel = model;
  let compactFailures = 0;
  let reactiveCompactUsed = false;
  let attempt = 0;

  /** 决策 20：第 1 层微压缩 + （超阈值时）第 2 层 autocompact；返回是否可继续。 */
  const compactIfNeeded = async (): Promise<boolean> => {
    replaceMessages(messages, microCompact(messages));
    if (estimateMessageTokens(messages) <= threshold) return true;
    try {
      replaceMessages(messages, await autoCompact(messages, adapter, currentModel, () => {}));
      clearFileState(agentId); // 决策 26：compact 后清文件状态
      compactFailures = 0;
      return true;
    } catch {
      compactFailures++;
      return compactFailures < MAX_COMPACT_FAILURES;
    }
  };

  let turns = 0;
  while (turns < maxTurns) {
    if (signal.aborted) {
      yield { type: 'turn_end', stopReason: 'aborted' };
      return;
    }
    turns++;

    if (!(await compactIfNeeded())) {
      yield { type: 'assistant_text', delta: '\n[error] Compact circuit breaker: 3 consecutive failures' };
      yield { type: 'turn_end', stopReason: 'error' };
      return;
    }

    // 决策 37：发送前配对检查
    replaceMessages(messages, normalizeMessages(messages));

    // 决策 21：熔断器——与 executor 一致，调 API 前必须先过闸
    try {
      resilience.assertBreakerClosed();
    } catch (err) {
      yield { type: 'assistant_text', delta: `\n[error] ${(err as Error).message}` };
      yield { type: 'turn_end', stopReason: 'error' };
      return;
    }

    // ── stream LLM（回调事件 → 队列 → yield）──
    const queue = new EventQueue();
    let stopReasonFromStream: string | undefined;
    let emittedText = false;
    const pending = collectStream({
      adapter,
      chatParams: { model: currentModel, system: context.system, messages, tools: toolSchemas, maxTokens },
      signal,
      onChunk: (chunk: StreamChunk) => {
        if (chunk.type === 'text_delta') {
          emittedText = true;
          queue.push({ type: 'assistant_text', delta: chunk.text });
        }
        if (chunk.type === 'message_end') stopReasonFromStream = chunk.stopReason;
      },
    });
    queue.watch(pending);
    try {
      yield* queue.drain();
    } finally {
      // 消费者提前退出（宿主 break）时释放队列，避免 collectStream 继续堆积无人读的事件
      queue.close();
    }

    let streamResult: Awaited<typeof pending>;
    try {
      streamResult = await pending;
      resilience.recordSuccess();
      attempt = 0;
    } catch (err) {
      if (isAbortError(err)) {
        yield { type: 'turn_end', stopReason: 'aborted' };
        return;
      }
      if (!(err instanceof LlmError)) {
        yield { type: 'assistant_text', delta: `\n[error] ${err instanceof Error ? err.message : String(err)}` };
        yield { type: 'turn_end', stopReason: 'error' };
        return;
      }

      const decision = resilience.decideOnFailure(err);

      if (!decision.retry) {
        if (decision.action === 'compact') {
          // 决策 20 第 3 层：prompt_too_long → 响应式压缩，整轮仅一次
          if (!reactiveCompactUsed) {
            reactiveCompactUsed = true;
            replaceMessages(messages, microCompact(messages));
            try {
              replaceMessages(messages, await autoCompact(messages, adapter, currentModel, () => {}));
              clearFileState(agentId);
            } catch {
              /* compact 自身失败 → 交回模型窗口，下一轮仍会报 prompt_too_long */
            }
            continue;
          }
          yield { type: 'assistant_text', delta: '\n[error] Context too long: prompt exceeds model window. Compacting did not resolve the issue.' };
          yield { type: 'turn_end', stopReason: 'error' };
          return;
        }
        const message =
          err.kind === 'auth'
            ? 'API key is invalid or expired.'
            : err.kind === 'connection'
              ? `Network error after ${MAX_SERVER_RETRIES} retries: ${err.message}`
              : err.message;
        yield { type: 'assistant_text', delta: `\n[error] ${message}` };
        yield { type: 'turn_end', stopReason: 'error' };
        return;
      }

      // 整轮重试会重新流式——本轮已产出过文本时重试会在 transcript 里重复渲染，
      // 故仅在无部分输出时重试（min-agent retryAssistantCall 同规则），否则判死。
      if (emittedText) {
        yield { type: 'assistant_text', delta: `\n[error] ${err.message}` };
        yield { type: 'turn_end', stopReason: 'error' };
        return;
      }

      if (decision.action === 'fallbackModel' && options.fallbackModel) {
        currentModel = options.fallbackModel;
      }

      attempt++;
      yield {
        type: 'retry',
        attempt,
        maxAttempts: MAX_SERVER_RETRIES + 1,
        delayMs: decision.delayMs,
        errorMessage: err.message,
      };
      try {
        await abortableSleep(decision.delayMs, signal);
      } catch {
        yield { type: 'turn_end', stopReason: 'aborted' };
        return;
      }
      continue;
    }

    // ── usage（决策 29 的精确值；loop 不落账，宿主自行统计）──
    yield { type: 'usage', usage: toAgentUsage(streamResult.usage) };

    const assistantMsg = streamResult.message;
    messages.push(assistantMsg);

    // ── 决策 24：content 检测退出 ──
    const toolCalls: ToolCall[] = assistantMsg.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    if (toolCalls.length === 0) {
      yield {
        type: 'turn_end',
        stopReason: stopReasonFromStream === 'max_tokens' ? 'max_tokens' : 'end_turn',
      };
      return;
    }

    // ── max_tokens 截断：参数可能不完整，不执行，回填错误让模型重试 ──
    if (stopReasonFromStream === 'max_tokens') {
      for (const tc of toolCalls) {
        yield { type: 'tool_result', id: tc.id, name: tc.name, result: 'error: output truncated by max_tokens' };
      }
      messages.push({
        role: 'user',
        content: toolCalls.map((tc) => ({
          type: 'tool_result' as const,
          tool_use_id: tc.id,
          content: `error: output truncated by max_tokens, tool "${tc.name}" args may be incomplete.`,
          is_error: true,
        })),
      });
      continue;
    }

    for (const tc of toolCalls) {
      yield { type: 'tool_call', id: tc.id, name: tc.name, args: tc.input };
    }

    // ── 执行工具（复用 subagent 管道：schema 校验/权限/hooks/审计/预算）──
    const results = await executeToolCalls(
      toolCalls,
      { cwd, signal, agentId },
      () => {},
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      // event-adapter 用 'error:' 前缀判定红色标记
      const content = r.is_error && !r.content.startsWith('error:') ? `error: ${r.content}` : r.content;
      yield { type: 'tool_result', id: r.tool_use_id, name: toolCalls[i].name, result: content };
    }

    messages.push({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
        is_error: r.is_error,
      })),
    });

    if (signal.aborted) {
      yield { type: 'turn_end', stopReason: 'aborted' };
      return;
    }
  }

  yield { type: 'assistant_text', delta: `\n[error] Max turns reached (${maxTurns})` };
  yield { type: 'turn_end', stopReason: 'error' };
}
