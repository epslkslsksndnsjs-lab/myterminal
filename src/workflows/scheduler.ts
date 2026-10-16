import os from 'node:os';

/**
 * 并发窗口——N 路全员入队，任一路结算即补下一路（滚动补位）。
 *
 * 三条纪律：
 *   1. 队列 FIFO，补位序 = admission 序：不因谁先结束而插队；
 *   2. 只节流交给它的叶子任务（一次模型调用），脚本层的 thunk 不占槽——
 *      否则嵌套 fan-out 在窗口 1 下必死锁；
 *   3. abort 后排队的任务立即拒且从不执行、从不占槽；已在飞的不重写结果，
 *      由各自的信号去止损。
 * 这里没有超时、没有重试、没有优先级——那是看门狗与闸门的事，别在这里臆造。
 */

export const MIN_CONCURRENCY = 2;
export const MAX_DEFAULT_CONCURRENCY = 16;
/** 硬顶：任何来源的并发值都不得越过它。 */
export const HARD_CONCURRENCY_CEILING = 64;

type Job = {
  thunk: () => unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export type DispatchWindow = {
  /** 交一票叶子任务进窗口；返回该任务的兑现值。 */
  run<T>(thunk: () => Promise<T> | T): Promise<T>;
  /** 当前在飞数（水位）。 */
  inFlight(): number;
  /** 当前排队数。 */
  queued(): number;
  limit(): number;
  readonly aborted: boolean;
  abort(): void;
};

function abortError(): Error {
  const error = new Error('Workflow dispatch window aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * 默认窗口 = max(2, min(16, 核数−2))。
 * 下限刻意是 2：窗口 1 会把 parallel 静默串行化，脚本以为在并发、其实在排队。
 */
export function defaultConcurrencyWindow(availableParallelism: number = os.availableParallelism()): number {
  const cores = Number.isFinite(availableParallelism) ? Math.floor(availableParallelism) : 0;
  return Math.max(MIN_CONCURRENCY, Math.min(MAX_DEFAULT_CONCURRENCY, cores - 2));
}

/** 本机设置面的取值闸属 T3；这里只表达窗口本身的语义。 */

export function createDispatchWindow(limit: number, options?: { signal?: AbortSignal }): DispatchWindow {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError(`Workflow dispatch window limit must be a positive integer; received: ${String(limit)}`);
  }
  const queue: Job[] = [];
  const abortedError = abortError();
  let inFlight = 0;
  let aborted = false;

  const drainQueue = (reason: Error): void => {
    const pending = queue.splice(0, queue.length);
    for (const job of pending) job.reject(reason);
  };

  const pump = (): void => {
    while (!aborted && inFlight < limit && queue.length > 0) {
      const job = queue.shift() as Job;
      inFlight += 1;
      Promise.resolve()
        .then(job.thunk)
        .then(
          (value) => {
            inFlight -= 1;
            job.resolve(value);
            pump();
          },
          (error) => {
            inFlight -= 1;
            job.reject(error);
            pump();
          },
        );
    }
  };

  const abortWindow = (): void => {
    if (aborted) return;
    aborted = true;
    drainQueue(abortedError);
  };

  if (options?.signal) {
    if (options.signal.aborted) abortWindow();
    else options.signal.addEventListener('abort', abortWindow, { once: true });
  }

  return {
    run<T>(thunk: () => Promise<T> | T): Promise<T> {
      if (aborted) return Promise.reject(abortedError);
      return new Promise<T>((resolve, reject) => {
        queue.push({ thunk: thunk as () => unknown, resolve: resolve as (value: unknown) => void, reject });
        pump();
      });
    },
    inFlight: () => inFlight,
    queued: () => queue.length,
    limit: () => limit,
    get aborted() {
      return aborted;
    },
    abort: abortWindow,
  };
}
