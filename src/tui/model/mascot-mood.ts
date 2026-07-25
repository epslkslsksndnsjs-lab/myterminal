/**
 * 吉祥物 mood 映射（ADR-0004 决策 5）——纯函数，可单测。
 * 优先级：sad（致命/异常）> worried（等待超阈值）> expectant（有等待接管）> thinking（忙）> happy。
 */
export type MascotMood = 'happy' | 'expectant' | 'worried' | 'sad' | 'thinking';

export type MascotMoodInput = {
  /** 致命渲染错误（FatalErrorBoundary 已接管） */
  fatalError?: boolean;
  /** 进程拓扑 degraded */
  topologyDegraded?: boolean;
  /** 近期有 error 级运行时日志 */
  recentError?: boolean;
  /** 等待接管的 session 数（非终态且未被认领） */
  pendingUnclaimed?: number;
  /** 等待接管且已 stale（等待超阈值） */
  stalePending?: number;
  /** 刷新/校验等忙碌中 */
  busy?: boolean;
};

export function mascotMoodFor(input: MascotMoodInput): MascotMood {
  if (input.fatalError || input.topologyDegraded || input.recentError) return 'sad';
  if ((input.stalePending ?? 0) > 0) return 'worried';
  if ((input.pendingUnclaimed ?? 0) > 0) return 'expectant';
  if (input.busy) return 'thinking';
  return 'happy';
}
