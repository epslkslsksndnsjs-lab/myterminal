/**
 * 结算阶段的故障注入点——给"进程在这里死掉"留一只可确定命中的手。
 *
 * 崩溃帧只有三张，照 §22ⓕ 的矩阵钉死：快照后 / 终态标记后 / 通知投递前。
 * 三条路径各管一种用法：
 *   · 测试内注入 `crash` 钩子——抛出即视为死亡，用来断"这一帧盘上留什么形状"；
 *   · 进程环境变量 `MYTERMINAL_WORKFLOWS_CRASH_AT=<帧名>`——真把本进程 SIGKILL 掉，
 *     供子进程崩溃矩阵用（优雅退出留不下半截状态，那正是要的形状）；
 *   · 两者都没给——纯旁观，什么都不做，默认路径与没这层功能时逐字节一致。
 * 未命中或值拼错一律不动作：注入面绝不能因为一个错值就把正常 run 判坏。
 */

export const CRASH_AT_ENV = 'MYTERMINAL_WORKFLOWS_CRASH_AT';

export const CRASH_POINTS = ['after-snapshot', 'after-terminal', 'before-notice'] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export type CrashPlan = (point: CrashPoint) => void;

export type CrashPlanOptions = {
  env?: Record<string, string | undefined>;
  /** 缺省打到本进程；测试里注入它就是断言"动手了几次、在哪个点"。 */
  pid?: number;
  kill?: (pid: number, signal: 'SIGKILL') => void;
};

function isCrashPoint(value: unknown): value is CrashPoint {
  return typeof value === 'string' && (CRASH_POINTS as readonly string[]).includes(value);
}

/** 从环境里取出要命中的那一帧；任何不合形态的值都当"没设"。 */
export function crashPointFromEnv(env: Record<string, string | undefined> | undefined): CrashPoint | undefined {
  const raw = env?.[CRASH_AT_ENV];
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim();
  return isCrashPoint(normalized) ? normalized : undefined;
}

export function resolveCrashPlan(options: CrashPlanOptions = {}): CrashPlan {
  const target = crashPointFromEnv(options.env);
  if (!target) return () => { /* 未注入 = 不动 */ };
  const pid = options.pid ?? process.pid;
  const kill = options.kill ?? ((who, signal) => { process.kill(who, signal); });
  return (point) => {
    if (point !== target) return;
    // 同步调用；真进程路线下这一行之后就没有"之后"了。
    kill(pid, 'SIGKILL');
  };
}
