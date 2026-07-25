import { mascotMoodFor, type MascotMood } from '../model/mascot-mood.js';
import type { TuiSnapshot } from '../state.js';

/** 最近多少条日志内出现 error 视为"近期异常" */
const RECENT_LOG_WINDOW = 20;

/**
 * useMascotMood — 从 TUI 快照推导吉祥物表情（ADR-0004 决策 5）。
 * 纯读取 snapshot，渲染期调用，无内部状态。
 */
export function useMascotMood(snapshot: TuiSnapshot, fatalError?: Error): MascotMood {
  const { state, runtime } = snapshot;
  const pending = state.sessions.filter(
    (session) => !['completed', 'cancelled'].includes(session.phase) && session.presence !== 'claimed',
  );
  const stalePending = pending.filter((session) => session.presence === 'stale').length;
  const recentError = runtime.logs.slice(-RECENT_LOG_WINDOW).some((log) => log.level === 'error');
  return mascotMoodFor({
    fatalError: Boolean(fatalError),
    topologyDegraded: runtime.processTopology().mode === 'degraded',
    recentError,
    pendingUnclaimed: pending.length,
    stalePending,
    busy: false,
  });
}
