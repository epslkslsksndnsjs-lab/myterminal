/**
 * timeline-merge — 消息 + 审计按时间降序归并（ADR-0004 决策 7/8）。
 * 纯函数 + 单槽 memoize，不可变输入。
 */
import type { MyTerminalMessage, ToolAuditEvent } from '../../types.js';

export type ActivityEntry =
  | { kind: 'audit'; at: string; action: string; source: ToolAuditEvent['source']; status: ToolAuditEvent['status']; durationMs?: number; sessionName?: string; errorCode?: string; args?: unknown; result?: unknown }
  | { kind: 'message'; at: string; fromId: string; toId: string; body: string };

/** mergeActivity 的 audit 输入形状（与 store.auditFacts 的 AuditFact 结构兼容） */
export type MergeAuditInput = { at: string; action: string; source: ToolAuditEvent['source']; status: ToolAuditEvent['status']; durationMs?: number; sessionName?: string; errorCode?: string; args?: unknown; result?: unknown };

/** 消息 + 审计按时间降序归并（最新在前），limit 截断。输入只读不修改。 */
export function mergeActivity(
  messages: MyTerminalMessage[],
  audits: MergeAuditInput[],
  limit: number,
): ActivityEntry[] {
  const items: ActivityEntry[] = [];

  for (const msg of messages) {
    items.push({ kind: 'message', at: msg.createdAt, fromId: msg.from, toId: msg.to, body: msg.body });
  }

  for (const a of audits) {
    items.push({
      kind: 'audit',
      at: a.at,
      action: a.action,
      source: a.source,
      status: a.status,
      durationMs: a.durationMs,
      sessionName: a.sessionName,
      errorCode: a.errorCode,
      args: a.args,
      result: a.result,
    });
  }

  items.sort((a, b) => b.at.localeCompare(a.at));
  return limit > 0 ? items.slice(0, limit) : items;
}

type MemoSlot = { revision: string; limit: number; result: ActivityEntry[] } | undefined;
let slot: MemoSlot;

/**
 * 按 (revision, limit) memoize 的版本：同 revision 且同 limit 直接返回缓存（同一引用）。
 * 注意：Home(limit=7) 与 Timeline(limit=0) 同 revision 交替渲染时单槽会互相覆盖（miss 重算），
 * 这是正确性优先的取舍——重算成本 O(n log n) 仅在切换时发生一次，可接受。
 */
export function memoizedMergeActivity(
  revision: string,
  messages: MyTerminalMessage[],
  audits: () => MergeAuditInput[],
  limit: number,
): ActivityEntry[] {
  if (slot?.revision === revision && slot.limit === limit) return slot.result;
  const result = mergeActivity(messages, audits(), limit);
  slot = { revision, limit, result };
  return result;
}
