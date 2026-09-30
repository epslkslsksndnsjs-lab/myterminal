import type { Clock } from './clock.js';
import type { WorkflowAgentAdapter, WorkflowAgentRequest } from './adapter.js';

/**
 * LLM 传输层的瞬态重试（ADR-0052 §18①）——模块自持，不复用既有 subagent 的重试策略。
 *
 * 与 stall 看门狗是各管各的两层：这里只看"传输面抛回的瞬时错误"（限流 / 过载 / 连接），
 * 按有界 backoff 退避重发；对 dispatch 完全透明（脚本侧仍只见一次 agent 调用）。
 *
 * 一条推导耦合钉死（§18① / digest 08）：整条 backoff 阶梯的最坏静默必须 < stall 窗，
 * 否则一次真在恢复的重试会被看门狗误判成"无进展"而整路重跑。TRANSIENT_BACKOFF_CEILING_MS
 * 就是这个阶梯之和，测试断言它 < DEFAULT_STALL_MS（180s）。
 *
 * 归类一律鸭子读 kind / status，绝不 instanceof（错误要穿沙箱边界与传输包装）。
 */

/** stall 窗默认值（§6 时钟清单唯一账本里的 stallWindow=180s，本模块据此定容 backoff）。 */
export const DEFAULT_STALL_MS = 180_000;

/** 瞬态错误 kinds：与传输层错误分类同源，但重试阶梯是本模块自持的（不复用 subagent 策略）。 */
export const TRANSIENT_LLM_KINDS: readonly string[] = ['rate_limit', 'server_overload', 'connection'];

/** 明确不重试的传输错误 kinds：鉴权 / 上下文超长 / 系统性——重试大概率同果。 */
const NON_TRANSIENT_LLM_KINDS: readonly string[] = ['auth', 'prompt_too_long', 'system'];

/**
 * 退避阶梯（毫秒，模块自定、非搬运）。和 = 67_000ms，远小于 180_000ms stall 窗，
 * 且逐档有界，杜绝任何"无限等待把 dispatch 拖挂"的形态。
 */
export const TRANSIENT_BACKOFF_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 30_000];

/** backoff 上界 = 阶梯之和（唯一出处，测试用它钉 stall 窗关系）。 */
export const TRANSIENT_BACKOFF_CEILING_MS = TRANSIENT_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0);

/** 第 retryIndex 次重试前的等待毫秒；越界（耗尽）返回 null。 */
export function computeTransientBackoffMs(retryIndex: number): number | null {
  if (!Number.isInteger(retryIndex) || retryIndex < 0 || retryIndex >= TRANSIENT_BACKOFF_MS.length) return null;
  return TRANSIENT_BACKOFF_MS[retryIndex];
}

/** 是否瞬态可重试：先认 kind，再按 HTTP 状态码兜（429 / 5xx 瞬态，其余 4xx 不重试）。 */
export function isTransientLlmError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind === 'string') {
    if (TRANSIENT_LLM_KINDS.includes(kind)) return true;
    if (NON_TRANSIENT_LLM_KINDS.includes(kind)) return false;
  }
  const status = record.status;
  if (typeof status === 'number') {
    if (status === 429) return true;
    return status >= 500 && status < 600;
  }
  return false;
}

/** 在注入时钟上睡一段（虚拟钟测试靠 advance 推进即续跑）；父信号 abort 立即收手。 */
function sleep(ms: number, clock: Clock, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let handle: ReturnType<Clock['setTimeout']> | undefined;
    const finish = (): void => {
      if (handle) clock.clearTimeout(handle);
      resolve();
    };
    if (signal.aborted) { resolve(); return; }
    signal.addEventListener('abort', finish, { once: true });
    handle = clock.setTimeout(finish, ms);
  });
}

export type TransientRetryOptions = {
  clock: Clock;
  /** 观测缝：每次退避前回调（测试据此断 backoff 序列，而非真实计时）。 */
  onBackoff?: (delayMs: number) => void;
};

/**
 * 给一路 adapter 套上瞬态重试装饰器：瞬态错按阶梯退避重发同一请求（prompt / 选项全同），
 * 非瞬态即时抛，阶梯耗尽把最后一笔瞬态错原样抛回（交 dispatch 层归类为该路失败）。
 */
export function withTransientRetry(inner: WorkflowAgentAdapter, opts: TransientRetryOptions): WorkflowAgentAdapter {
  return {
    complete: async (request: WorkflowAgentRequest) => {
      let retryIndex = 0;
      for (;;) {
        try {
          return await inner.complete(request);
        } catch (error) {
          if (!isTransientLlmError(error)) throw error;
          if (request.signal.aborted) throw error;
          const delay = computeTransientBackoffMs(retryIndex);
          if (delay === null) throw error;
          opts.onBackoff?.(delay);
          await sleep(delay, opts.clock, request.signal);
          retryIndex += 1;
        }
      }
    },
  };
}
