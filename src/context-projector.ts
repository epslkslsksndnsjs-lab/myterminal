import type { JsonObject, MyTerminalMessage, MyTerminalSession, SessionHistoryEntry } from './types.js';

/**
 * ADR-0032 batch5 knife#11 (#63): pure context-projection seam.
 *
 * `store.context()` used to hand-roll projection assembly plus an O(n²)
 * budget-fitting loop (one full `JSON.stringify` per `shift()`). This module
 * owns both steps as pure functions over in-memory slices: the store stays the
 * IO adapter (history reads, session lookup) and injects everything else, so
 * the projection logic is testable without a filesystem and reusable by other
 * context consumers.
 *
 * Behaviour contract (locked byte-for-byte by test/context-projector-issue63):
 * assembly shape, the trim order, the minimal fallback and the truncated tail
 * path are all unchanged from the pre-knife store implementation.
 */

export interface ContextProjectionInput {
  session: MyTerminalSession;
  /** Recent history tail for `session` (store's HISTORY_TAIL_LIMIT window). */
  history: SessionHistoryEntry[];
  /** Full message list in store order; the projector applies its own filters. */
  messages: MyTerminalMessage[];
  parent?: MyTerminalSession;
  parentHistory?: SessionHistoryEntry[];
  predecessor?: MyTerminalSession;
  predecessorHistory?: SessionHistoryEntry[];
  /** Injected session view to avoid a store↔projector import cycle (same pattern as AuditLogIo). */
  toPublic: (session: MyTerminalSession) => JsonObject;
}

export const CONTEXT_PROJECTION_LIMIT = 16_000;

/** Assembly step — verbatim semantics of the pre-knife `store.context()` body. */
export function buildContextProjection(input: ContextProjectionInput): JsonObject {
  const { session, history, parent, predecessor, toPublic } = input;
  const audits = history.filter((item) => item.type === 'tool_audit').slice(-10).map((item) => item.data);
  const candidates = input.messages.filter((message) => message.from === session.id || message.to === session.id);
  const unread = candidates.filter((message) => message.to === session.id && !message.readAt).slice(-20);
  const messages = [...candidates.filter((message) => message.readAt || message.to !== session.id).slice(-(20 - unread.length)), ...unread];
  const parentAudits = parent ? (input.parentHistory ?? []).filter((item) => item.type === 'tool_audit').slice(-10).map((item) => item.data) : [];
  const predecessorAudits = predecessor ? (input.predecessorHistory ?? []).filter((item) => item.type === 'tool_audit').slice(-10).map((item) => item.data) : [];
  const predecessorMessages = predecessor ? input.messages.filter((message) => message.from === predecessor.id || message.to === predecessor.id).slice(-20) : [];
  return {
    session: toPublic(session), objective: session.task?.objective,
    finalSummary: session.finalSummary,
    latestSummary: session.latestCheckpoint?.summary,
    parentContext: parent ? { session: toPublic(parent), finalSummary: parent.finalSummary, latestSummary: parent.latestCheckpoint?.summary } : undefined,
    parentRecentToolCalls: parentAudits,
    inheritedFrom: predecessor ? toPublic(predecessor) : undefined,
    inheritedRecentToolCalls: predecessorAudits,
    inheritedRecentMessages: predecessorMessages,
    recentToolCalls: audits, recentMessages: messages,
  };
}

/** Trim order is part of the contract: least critical context is dropped first. */
const TRIM_ORDER = ['recentMessages', 'recentToolCalls', 'inheritedRecentMessages', 'inheritedRecentToolCalls', 'parentRecentToolCalls'] as const;

/**
 * Budget fitting — same observable behaviour as the pre-knife O(n²) loop, but
 * O(n): the projection is stringified once, then each shifted element only
 * subtracts its own encoded length (plus a comma while a neighbour remains)
 * instead of re-stringifying the whole projection per iteration.
 */
export function fitProjection(projection: JsonObject, limit: number): JsonObject {
  let result = structuredClone(projection);
  let total = JSON.stringify(result).length;
  for (const key of TRIM_ORDER) {
    if (total <= limit) break;
    const value = result[key];
    if (!Array.isArray(value)) continue;
    while (total > limit && value.length) {
      const element = value.shift();
      // Inside an array, values JSON cannot encode standalone become `null`.
      const encoded = JSON.stringify(element) ?? 'null';
      total -= encoded.length + (value.length ? 1 : 0);
    }
  }
  if (total > limit) result = { session: projection.session, objective: projection.objective, finalSummary: projection.finalSummary, latestSummary: projection.latestSummary };
  const encoded = JSON.stringify(result);
  return encoded.length <= limit ? result : { objective: String(projection.objective || '').slice(0, 4000), finalSummary: String(projection.finalSummary || projection.latestSummary || '').slice(0, 4000), truncated: true };
}

/** Assembly + budget fitting in one call — the shape `store.context()` consumes. */
export function projectContext(input: ContextProjectionInput, limit = CONTEXT_PROJECTION_LIMIT): JsonObject {
  return fitProjection(buildContextProjection(input), limit);
}
