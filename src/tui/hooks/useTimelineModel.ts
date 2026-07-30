/**
 * useTimelineModel — 从 TuiSnapshot 取数 + memoize 归并。
 * 每次渲染调用，内部按 revision 字符串缓存，避免重复 O(n log n)。
 */
import type { TuiSnapshot } from '../state.js';
import { memoizedMergeActivity, type ActivityEntry } from '../model/timeline-merge.js';

export function useTimelineModel(snapshot: TuiSnapshot, limit: number): ActivityEntry[] {
  const { state, runtime } = snapshot;
  const messages = state.messages;
  const revision = `${runtime.store.revision()}:${runtime.runtimeLogRevision()}`;
  // ADR-0032 #63 S4: auditFacts(5000) 仅在 memo miss 时取数，避免每次渲染都重建 5000 条 fact。
  // 行为不变：命中缓存时直接返回缓存结果（无需 audits），miss 时仍用同批 audits 归并。
  return memoizedMergeActivity(revision, messages, () => runtime.store.auditFacts(5000), limit);
}
