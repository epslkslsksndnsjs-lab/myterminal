import type { Clock, TimerHandle } from './clock.js';
import { agentFailure, runLevelError } from './failures.js';

/**
 * 路级停滞治理——dispatch 层的 stall 看门狗与有限重试（ADR-0052 §18②）。
 *
 * 两层重试互不相干，这里是其中一层（另一层 LLM 传输瞬态重试在 llm-retry.ts）：
 *   只有"无进展"才重试——180s 无进展 → abort 该次尝试 → 重试，总计 ≤3（含首次）；
 *   耗尽即该路判败 error=stalled。非 stall 失败（模型/启动错误、缺结构化输出、
 *   dispatch 窗口到期、轮数越界）一律不重试，直接该路记账。
 *
 * 三条纪律：
 *   1. 每次尝试新建 AbortController（重试只换控制器，prompt / 选项全同、缓存键不变，
 *      脚本侧始终只见一次调用）；run 级取消随父信号止损且从不重试（父在先判）。
 *   2. 三只钟各归各位（ADR §16 时钟清单）：stall 无进展、dispatchWindow 墙钟、
 *      dispatchTurns 轮数——都由引擎持有、都走注入时钟；工具在飞时 stall 计时挂起。
 *   3. 被中止的尝试不带结果回来：靠 race 把挂死的 mock 弃在一边，以先 settled 的那次为准。
 *
 * 判定一律靠看门狗自己的 fired 标志与父信号的 aborted，绝不靠错误文本。
 */

/** 单路 dispatch 的总尝试数（含首次），钉死于 §18。 */
export const MAX_STALL_ATTEMPTS = 3;

/** stall 看门狗独占的 abort reason（与失败 kind 'stalled' 同值异用：区分重试与取消）。 */
export const WORKFLOW_ABORT_REASON_STALLED = 'stalled';

/** 看门狗自触发的中止种类——决定是否重试全看它。 */
export type StallFiredReason = 'stalled' | 'timeout' | 'max_turns';

/**
 * 单次尝试的进展通道——attemptFn 用它的四个动词告诉看门狗"我在动"：
 *   round()     一个传输/循环轮次发生：计入轮数预算并重置无进展计时；
 *   activity()  任何进展（流式增量等）：只重置无进展计时，不计轮数；
 *   toolStart() 工具上飞：挂起无进展计时（慢工具不是 stall）；
 *   toolEnd()   工具落地：无在飞工具时重新挂上计时。
 */
export type StallProgress = {
  round(): void;
  activity(): void;
  toolStart(): void;
  toolEnd(): void;
};

/**
 * 每路 stallMs 的取值优先级（§18：per-call agent({stallMs}) > run 闸门默认）：
 *   per-call 有限数：0 显式禁用、>0 原样采用、负数视为调用方 bug → 落默认；
 *   per-call 缺省 / 非有限：用 run 闸门默认。
 */
export function resolveStallMs(perCall: number | undefined, fallbackMs: number): number {
  if (typeof perCall === 'number' && Number.isFinite(perCall)) {
    if (perCall === 0) return 0;
    if (perCall > 0) return perCall;
  }
  return Math.max(0, fallbackMs);
}

export type StallDeps = {
  clock: Clock;
  /** 已解析的单次无进展窗口；<=0 关看门狗（只做一次尝试）。 */
  stallMs: number;
  /** 单次尝试的墙钟上限（§16 dispatchWindow）。 */
  dispatchWindowMs: number;
  /** 单次尝试的轮数预算（§16 dispatchTurns）。 */
  dispatchTurns: number;
  /** run 级取消 / 墙钟信号：一旦 abort，尝试随其止损且不重试。 */
  parentSignal: AbortSignal;
  /** 该路展示名，进 stall 耗尽的失败文案。 */
  label: string;
  /** 观测缝：每次尝试起跑即上报当前尝试序号（引擎据此把重试次数写进该路终态记账）。 */
  onAttempt?: (attempt: number) => void;
};

export type StallOutcome<T> = { value: T; attempts: number };

function displayName(label: string): string {
  return label && label.trim() ? label : 'workflow-agent';
}

/**
 * 带 stall 看门狗的弹性执行器：把 attemptFn 跑到底，无进展即换控制器重试，至多
 * MAX_STALL_ATTEMPTS 次。返回值带本次真正 settled 所用的尝试数（进终态记账）。
 */
export async function runStallResilient<T>(
  deps: StallDeps,
  attemptFn: (signal: AbortSignal, progress: StallProgress) => Promise<T>,
): Promise<StallOutcome<T>> {
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_STALL_ATTEMPTS; attempt++) {
    attempts = attempt;
    deps.onAttempt?.(attempts);

    const controller = new AbortController();
    let fired: StallFiredReason | undefined;
    let disposed = false;
    let inFlightTools = 0;
    let rounds = 0;
    let stallTimer: TimerHandle | undefined;
    const windowTimer: TimerHandle = deps.clock.setTimeout(() => fire('timeout'), deps.dispatchWindowMs);

    let rejectSentinel!: (error: Error) => void;
    const abortSentinel = new Promise<never>((_resolve, reject) => { rejectSentinel = reject; });

    // 看门狗自触发唯一入口：置 fired、用 reason 中止本尝试、把挂死的 attemptFn 弃在一边。
    function fire(reason: StallFiredReason): void {
      if (fired || disposed) return;
      fired = reason;
      try { controller.abort(reason); } catch { /* reason 只是标记，不依赖它判定 */ }
      rejectSentinel(new Error(`workflow stall watchdog fired: ${reason}`));
    }

    const disarmStall = (): void => { if (stallTimer) { deps.clock.clearTimeout(stallTimer); stallTimer = undefined; } };
    const armStall = (): void => {
      if (deps.stallMs <= 0 || fired || inFlightTools > 0) return;
      disarmStall();
      stallTimer = deps.clock.setTimeout(() => fire('stalled'), deps.stallMs);
    };

    const progress: StallProgress = {
      round() {
        if (fired || disposed) return;
        rounds += 1;
        if (rounds > deps.dispatchTurns) { fire('max_turns'); return; }
        armStall();
      },
      activity() {
        if (fired || disposed) return;
        armStall();
      },
      toolStart() {
        if (fired || disposed) return;
        inFlightTools += 1;
        disarmStall();
      },
      toolEnd() {
        if (fired || disposed) return;
        inFlightTools = Math.max(0, inFlightTools - 1);
        if (inFlightTools === 0) armStall();
      },
    };

    // 父信号只中止尝试控制器（让守信号的 adapter 自己拒），不主动 reject sentinel——
    // 全局终结由引擎自己的赛跑兜，保持"迟归不覆盖"的既有语义。
    const onParentAbort = (): void => { try { controller.abort(deps.parentSignal.reason); } catch { /* 忽略 */ } };
    if (deps.parentSignal.aborted) controller.abort(deps.parentSignal.reason);
    else deps.parentSignal.addEventListener('abort', onParentAbort, { once: true });

    // 起手即挂 stall 计时：time-to-first-response 窗口被监视（§18 参考 ROUND_START 语义）。
    armStall();

    try {
      const value = await Promise.race([attemptFn(controller.signal, progress), abortSentinel]);
      return { value, attempts };
    } catch (error) {
      // ① 父在先判：取消 / 墙钟终结永不重试。
      if (deps.parentSignal.aborted) {
        throw runLevelError('cancelled', `Workflow run was aborted while "${displayName(deps.label)}" was in flight.`);
      }
      // ②③ 看门狗触发：timeout / max_turns 是确定性终态不重试；stalled 未耗尽即重试。
      if (fired === 'timeout') throw agentFailure('timeout', `agent "${displayName(deps.label)}" exceeded its ${deps.dispatchWindowMs}ms dispatch window.`);
      if (fired === 'max_turns') throw agentFailure('max_turns', `agent "${displayName(deps.label)}" exceeded its ${deps.dispatchTurns}-turn dispatch budget.`);
      if (fired === 'stalled') {
        if (attempt < MAX_STALL_ATTEMPTS) continue;
        throw agentFailure('stalled', `agent "${displayName(deps.label)}" stalled on all ${MAX_STALL_ATTEMPTS} attempts (no progress for ${deps.stallMs}ms each).`);
      }
      // ④ 尝试自抛的错误（模型 / 启动 / 其它确定性失败）——非 stall，不重试，原样上抛。
      throw error;
    } finally {
      disposed = true;
      disarmStall();
      deps.clock.clearTimeout(windowTimer);
      deps.parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  // 循环每轮都 return 或 throw，理论不可达；留一条与"耗尽判败"同义的兜底。
  throw agentFailure('stalled', `agent "${displayName(deps.label)}" stalled on all ${MAX_STALL_ATTEMPTS} attempts.`);
}
