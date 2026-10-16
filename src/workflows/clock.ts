/**
 * 时间缝——模块内部一切时间都经这里，不直接调 Date。
 *
 * 单测要断言 30 分钟墙钟 / 180s stall / 35 分钟等待这类路径，真实等待不可行，
 * 故时钟是构造器注入件：默认实现走系统时间，测试注入虚拟钟（手动推进毫秒）。
 */

export type TimerHandle = { readonly id: unknown };

export type Clock = {
  /** 单调无关：返回 epoch 毫秒，供时间戳与时长计算共用。 */
  now(): number;
  /** ISO 时间戳字符串，落盘用。 */
  iso(): string;
  /**
   * 定时回调。实现必须返回可 clear 的句柄；
   * 系统时钟下定时器应 unref，避免拖住进程退出。
   */
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

type NodeTimeout = ReturnType<typeof setTimeout>;

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    iso: () => new Date().toISOString(),
    setTimeout: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      // 后台 run 的看门狗不该成为进程不退出的理由。
      if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
      return { id: timer };
    },
    clearTimeout: (handle) => clearTimeout(handle.id as NodeTimeout),
  };
}

/**
 * 虚拟钟——测试专用：时间只随 advance() 前进，定时器按到期时刻顺序触发。
 * 单测因此不真实等待任何一毫秒。
 */
export type VirtualClock = Clock & {
  advance(ms: number): void;
  pending(): number;
};

export function virtualClock(startMs = 1_700_000_000_000): VirtualClock {
  let current = startMs;
  let seq = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const fireDue = () => {
    for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])) {
      if (timer.at > current) break;
      timers.delete(id);
      timer.callback();
    }
  };
  return {
    now: () => current,
    iso: () => new Date(current).toISOString(),
    setTimeout: (callback, ms) => {
      const id = ++seq;
      timers.set(id, { at: current + Math.max(0, ms), callback });
      return { id };
    },
    clearTimeout: (handle) => { timers.delete(handle.id as number); },
    advance: (ms) => {
      current += Math.max(0, ms);
      fireDue();
    },
    pending: () => timers.size,
  };
}
