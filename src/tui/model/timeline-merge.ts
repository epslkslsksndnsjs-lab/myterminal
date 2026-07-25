/**
 * timeline-merge — 消息 + 审计按时间降序归并（ADR-0004 决策 7/8）。
 * 纯函数 + 单槽 memoize，不可变输入。
 */
import type { MyTerminalMessage, ToolAuditEvent } from '../../types.js';

export type ActivityEntry =
  | { kind: 'audit'; at: string; action: string; source: string; status: ToolAuditEvent['status']; durationMs?: number; sessionName?: string; errorCode?: string }
  | { kind: 'message'; at: string; fromId: string; toId: string; body: string };

/** 消息 + 审计按时间降序归并（最新在前），limit 截断。输入只读不修改。 */
export function mergeActivity(
  messages: MyTerminalMessage[],
  audits: { at: string; action: string; source: string; status: ToolAuditEvent['status']; durationMs?: number; sessionName?: string; errorCode?: string }[],
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
    });
  }

  items.sort((a, b) => b.at.localeCompare(a.at));
  return limit > 0 ? items.slice(0, limit) : items;
}

type MemoSlot = { revision: string; result: ActivityEntry[] } | undefined;
let slot: MemoSlot;

/** 按 revision 字符串 memoize 的版本：同 revision 直接返回缓存（同一引用）。 */
export function memoizedMergeActivity(
  revision: string,
  messages: MyTerminalMessage[],
  audits: { at: string; action: string; source: string; status: ToolAuditEvent['status']; durationMs?: number; sessionName?: string; errorCode?: string }[],
  limit: number,
): ActivityEntry[] {
  if (slot?.revision === revision) return slot.result;
  const result = mergeActivity(messages, audits, limit);
  slot = { revision, result };
  return result;
}
