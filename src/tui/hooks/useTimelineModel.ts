/**
 * useTimelineModel — 从 TuiSnapshot 取数 + memoize 归并。
 * 每次渲染调用，内部按 revision 字符串缓存，避免重复 O(n log n)。
 */
import type { TuiSnapshot } from '../state.js';
import { memoizedMergeActivity, type ActivityEntry } from '../model/timeline-merge.js';

export function useTimelineModel(snapshot: TuiSnapshot, limit: number): ActivityEntry[] {
  const { state, runtime } = snapshot;
  const messages = state.messages;
  const audits = runtime.store.auditFacts(5000);
  const revision = `${runtime.store.revision()}:${runtime.runtimeLogRevision()}`;
  return memoizedMergeActivity(revision, messages, audits, limit);
}
