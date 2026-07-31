import type { JsonObject, MyTerminalSession, SessionHistoryEntry, ToolAuditEvent } from './types.js';
import { redact as defaultRedact } from './redact.js';

/**
 * ADR-0032 batch5 knife#6 (#64): audit seam extracted from MyTerminalStore.
 *
 * AuditLog owns the tool-audit derived cache plus the write/read logic. IO is
 * injected so the core stays testable without a filesystem, and the persisted
 * shape (history JSONL `tool_audit` entries) is deliberately unchanged.
 */

export type AuditFact = ToolAuditEvent & {
  sessionId: string;
  sessionName: string;
  at: string;
  tool: string;
  ok: boolean;
  errorCode?: string;
};

export type AuditFactsPage = { total: number; offset: number; nextOffset?: number; facts: AuditFact[] };

/** Upper bound on facts any single reader pass considers. */
const MAX_WINDOW = 5000;

/** Seam boundary: everything AuditLog needs from the surrounding store. */
export interface AuditLogIo {
  appendToolAudit(sessionId: string, data: JsonObject): void;
  readRecentHistory(sessionId: string): SessionHistoryEntry[];
  listSessions(): MyTerminalSession[];
  requireSession(id: string): MyTerminalSession;
}

export class AuditLog {
  private cache?: AuditFact[];

  constructor(
    private readonly io: AuditLogIo,
    private readonly now: () => number = Date.now,
    private readonly redact: <T>(value: T) => T = defaultRedact,
  ) {}

  /** Redact, persist and cache one tool audit event. Returns the redacted event. */
  event(sessionId: string, event: ToolAuditEvent): ToolAuditEvent {
    const session = this.io.requireSession(sessionId);
    const redacted = this.redact(event);
    const args = redacted.args;
    const result = redacted.result;
    const error = event.error ? redacted.error : undefined;
    const data = {
      ...event,
      error,
      args,
      result,
      // Compatibility fields keep older history readers and continuation projections useful.
      tool: event.action,
      ok: event.status === 'completed',
      startedAt: event.timestamp,
      errorCode: event.error?.code,
    } as unknown as JsonObject;
    this.io.appendToolAudit(sessionId, data);
    if (this.cache) {
      const next = this.factFromHistory(session, { at: this.iso(), type: 'tool_audit', data });
      const index = this.cache.findIndex((fact) => fact.sessionId === session.id && fact.id === event.id);
      if (index >= 0) this.cache[index] = { ...this.cache[index], ...next, at: this.cache[index].at };
      else this.cache.push(next);
    }
    return {
      ...event,
      args,
      result,
      error: error && typeof error === 'object' ? error as ToolAuditEvent['error'] : undefined,
    };
  }

  /** Most recent `limit` facts across all sessions, oldest first. */
  facts(limit = 500): AuditFact[] {
    return structuredClone(this.all().slice(-Math.max(1, Math.min(MAX_WINDOW, limit))));
  }

  /**
   * Backwards pagination for log views (ADR-0033 #62): page 0 is the newest
   * `limit` facts at or before `until`. Owns the anchor filter and the slice
   * arithmetic the Logs screen used to redo on every frame. `nextOffset` points
   * at the start of the next (older) page, or undefined at the oldest page.
   */
  recentFactsPage(page = 0, limit = 100, until?: string): AuditFactsPage {
    const count = Math.max(1, Math.min(MAX_WINDOW, limit));
    const recent = this.all().slice(-MAX_WINDOW);
    const facts = until ? recent.filter((fact) => fact.at <= until) : recent;
    const total = facts.length;
    const end = Math.max(0, total - Math.max(0, page) * count);
    const start = Math.max(0, end - count);
    return {
      total,
      offset: start,
      nextOffset: start > 0 ? Math.max(0, start - count) : undefined,
      facts: structuredClone(facts.slice(start, end)),
    };
  }

  /** Coherent forward pagination over the same fact stream (shared with #62). */
  factsPage(offset = 0, limit = 100): AuditFactsPage {
    const facts = this.all();
    const count = Math.max(1, Math.min(MAX_WINDOW, limit));
    const total = facts.length;
    const start = Math.max(0, Math.min(total, offset));
    return {
      total,
      offset: start,
      nextOffset: start + count < total ? start + count : undefined,
      facts: structuredClone(facts.slice(start, start + count)),
    };
  }

  /** Drop cached facts belonging to deleted sessions. */
  pruneDeleted(deleted: Set<string>): void {
    if (this.cache) this.cache = this.cache.filter((item) => !deleted.has(item.sessionId));
  }

  private all(): AuditFact[] {
    this.cache ||= this.io.listSessions().flatMap((session) => this.factsForSession(session))
      .sort((a, b) => a.at.localeCompare(b.at));
    return this.cache;
  }

  private factsForSession(session: MyTerminalSession): AuditFact[] {
    const facts = new Map<string, AuditFact>();
    for (const entry of this.io.readRecentHistory(session.id)) {
      if (entry.type !== 'tool_audit') continue;
      const next = this.factFromHistory(session, entry);
      const previous = facts.get(next.id);
      facts.set(next.id, previous ? { ...previous, ...next, at: previous.at, timestamp: previous.timestamp } : next);
    }
    return [...facts.values()];
  }

  private factFromHistory(session: MyTerminalSession, entry: SessionHistoryEntry): AuditFact {
    const data = entry.data as JsonObject;
    const action = String(data.action || data.tool || 'unknown');
    const rawStatus = typeof data.status === 'string' ? data.status : data.ok === true ? 'completed' : 'failed';
    const status: ToolAuditEvent['status'] = rawStatus === 'started' ? 'running' : rawStatus === 'succeeded' ? 'completed'
      : ['running', 'completed', 'failed', 'timeout', 'policy_rejected'].includes(rawStatus) ? rawStatus as ToolAuditEvent['status'] : 'failed';
    const rawErrorCode = typeof data.errorCode === 'string'
      ? data.errorCode
      : data.error && typeof data.error === 'object' && typeof (data.error as JsonObject).code === 'string'
        ? String((data.error as JsonObject).code)
        : undefined;
    const errorCode = rawErrorCode || (status === 'failed' || status === 'timeout' ? 'UNKNOWN_ERROR' : undefined);
    return {
      id: String(data.id || `legacy-${session.id}-${entry.at}-${action}`),
      timestamp: String(data.timestamp || data.startedAt || entry.at),
      completedAt: typeof data.completedAt === 'string' ? data.completedAt : undefined,
      source: ['apps', 'actions', 'tui', 'test', 'mcp'].includes(String(data.source)) ? data.source as ToolAuditEvent['source'] : 'test',
      action,
      status,
      durationMs: Number(data.durationMs || 0),
      error: errorCode ? { code: errorCode } : undefined,
      workspace: String(data.workspace || ''),
      session: String(data.session || session.id),
      args: data.args,
      result: data.result,
      sessionId: session.id,
      sessionName: session.name,
      at: String(data.timestamp || data.startedAt || entry.at),
      tool: action,
      ok: status === 'completed',
      errorCode,
    };
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
}
