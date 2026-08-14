import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type {
  AppSessionBinding, CustomExtensionSpec, JsonObject, McpSessionBinding, MyTerminalMessage, MyTerminalSession, SessionCheckpoint,
  SessionEvent, SessionEventKind, SessionIdentity, SessionPhase, StoredState, TaskPackage,
  SessionHistoryEntry, ToolAuditEvent, PlannedToolCall,
} from './types.js';
import { AuditLog } from './audit-log.js';
import type { AuditFact, AuditFactsPage } from './audit-log.js';
import { projectContext } from './context-projector.js';

const EMPTY_STATE: StoredState = {
  schemaVersion: 2, revision: 0, sessions: [], messages: [], events: [], subscriptions: [], appBindings: [], extensions: [],
};
const TERMINAL_PHASES = new Set<SessionPhase>(['completed', 'cancelled']);
const CHECKPOINT_REMINDER_MS = 2 * 60_000;
const CHECKPOINT_BLOCK_MS = 5 * 60_000;
const STALE_MS = 15 * 60_000;
const FACADE_OPERATIONS = new Set(['extension_discover', 'extension_register', 'extension_call']);

type LegacySession = {
  id: string; name: string; role: string; status: 'active' | 'idle' | 'blocked' | 'completed';
  note?: string; createdAt: string; updatedAt: string;
};
type LegacyState = { schemaVersion: 1; revision: number; sessions: LegacySession[]; messages: MyTerminalMessage[]; extensions: CustomExtensionSpec[] };
type StoreJournalInput =
  | { kind: 'session_touch'; sessionId: string; updatedAt: string; lastActivityAt?: string; checkpointStartedAt?: string }
  | { kind: 'message'; message: MyTerminalMessage; event: SessionEvent };
type StoreJournalEntry = StoreJournalInput & { revision: number };

export class MyTerminalError extends Error {
  constructor(readonly code: string, message: string, readonly details?: JsonObject, readonly retryable = false) {
    super(message);
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function equalHash(value: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const actual = Buffer.from(hash(value));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function nonEmpty(value: unknown, label: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim()) throw new MyTerminalError('INVALID_INPUT', `${label} is required.`);
  if (value.trim().length > max) throw new MyTerminalError('INVALID_INPUT', `${label} must contain at most ${max} characters.`);
  return value.trim();
}

function stringArray(value: unknown, label: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new MyTerminalError('INVALID_INPUT', `${label} must be ${required ? 'a non-empty' : 'an'} array of strings.`);
  }
  return value.map((item) => String(item).trim()).slice(0, 100);
}

function cleanTask(task: TaskPackage): TaskPackage {
  return {
    objective: nonEmpty(task?.objective, 'objective'),
    background: nonEmpty(task?.background, 'background'),
    deliverables: stringArray(task?.deliverables, 'deliverables', true),
    acceptanceCriteria: stringArray(task?.acceptanceCriteria, 'acceptanceCriteria', true),
    constraints: stringArray(task?.constraints, 'constraints', true),
  };
}

function plannedToolCalls(value: unknown): PlannedToolCall[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new MyTerminalError('INVALID_INPUT', 'nextCalls must contain 1-3 planned tool calls.');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new MyTerminalError('INVALID_INPUT', `nextCalls[${index}] must be an object.`);
    const call = item as JsonObject;
    if (typeof call.tool !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(call.tool)) throw new MyTerminalError('INVALID_INPUT', `nextCalls[${index}].tool is invalid.`);
    if (FACADE_OPERATIONS.has(call.tool)) throw new MyTerminalError('INVALID_INPUT', `nextCalls[${index}] must name a concrete tool invoked through extension_call, not facade operation ${call.tool}. Call facade operations before checkpointing.`);
    if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) throw new MyTerminalError('INVALID_INPUT', `nextCalls[${index}].input must be an object.`);
    if (call.purpose !== undefined && (typeof call.purpose !== 'string' || !call.purpose.trim() || call.purpose.length > 500)) throw new MyTerminalError('INVALID_INPUT', `nextCalls[${index}].purpose must contain 1-500 characters.`);
    return { tool: call.tool, input: structuredClone(call.input as JsonObject), ...(typeof call.purpose === 'string' ? { purpose: call.purpose.trim() } : {}) };
  });
}

export function publicSession(session: MyTerminalSession): JsonObject {
  const { controller, claimCodeHash: _claimCodeHash, ...visible } = session;
  return {
    ...visible,
    ...(controller ? { controller: { id: controller.id, claimedAt: controller.claimedAt, lastActivityAt: controller.lastActivityAt } } : {}),
  };
}

type HistoryIndex = { size: number; mtimeMs: number; total: number; offsets: number[] };
const HISTORY_INDEX_STRIDE = 256;
const HISTORY_TAIL_LIMIT = 5_000;

export class MyTerminalStore {
  private state: StoredState;
  private readonly statePath: string;
  /** ADR-0029: ephemeral MCP session → identity binding cache. In-memory only; never persisted (see crash-recovery decision). */
  private readonly mcpBindings = new Map<string, McpSessionBinding>();
  private readonly historyDir: string;
  private readonly journalPath: string;
  private readonly transientClaimCodes = new Map<string, string>();
  private readonly historyIndexes = new Map<string, HistoryIndex>();
  /** ADR-0032 #63 S2: parsed tail cache keyed by (session, size, mtime) — mirrors historyIndexes invalidation. Skips re-read/re-parse when the history file is unchanged. */
  private readonly historyTailCache = new Map<string, { size: number; mtimeMs: number; entries: SessionHistoryEntry[] }>();
  /** ADR-0032 #64: audit write/read seam. Store stays the state holder + IO adapter. */
  private readonly audit: AuditLog;
  private journalEntries = 0;
  private journalBytes = 0;

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.statePath = path.join(stateDir, 'state.json');
    this.historyDir = path.join(stateDir, 'history');
    this.journalPath = path.join(stateDir, 'state.journal.jsonl');
    mkdirSync(this.historyDir, { recursive: true, mode: 0o700 });
    this.state = this.load();
    this.audit = new AuditLog({
      appendToolAudit: (sessionId, data) => this.appendHistory(sessionId, 'tool_audit', data),
      readRecentHistory: (sessionId) => this.readRecentHistory(sessionId),
      listSessions: () => this.state.sessions,
      requireSession: (id) => this.requireSession(id),
    }, this.now);
  }

  snapshot(): StoredState { return structuredClone(this.state); }
  snapshotForTui(messageLimit = 500, eventLimit = 200): StoredState {
    return structuredClone({
      ...this.state,
      messages: this.state.messages.slice(-Math.max(1, messageLimit)),
      events: this.state.events.slice(-Math.max(1, eventLimit)),
    });
  }
  revision(): number { return this.state.revision; }
  listExtensions(): CustomExtensionSpec[] { return structuredClone(this.state.extensions); }
  hasAppBinding(clientSessionKey: string): boolean { return this.state.appBindings.some((item) => item.clientSessionKey === clientSessionKey); }
  activateHarnessContract(contract: NonNullable<StoredState['harnessContract']>): boolean {
    const previous = this.state.harnessContract;
    if (previous && previous.mode === contract.mode && previous.revision === contract.revision) return false;
    this.state.harnessContract = structuredClone(contract);
    const affected = this.state.sessions.filter((session) => !TERMINAL_PHASES.has(session.phase));
    for (const session of affected) {
      this.emitEvent(session.id, session.id, 'requirements_changed', {
        previousMode: previous?.mode ?? 'unknown',
        mode: contract.mode,
        revision: contract.revision,
        instruction: 'The Actions harness requirements changed. Call extension_discover and reread its tool requirements before continuing.',
      });
    }
    this.save();
    return affected.length > 0;
  }

  acknowledgeHarnessRequirements(sessionId: string): number {
    const at = this.iso();
    let count = 0;
    for (const event of this.state.events) {
      if (event.recipientSessionId === sessionId && event.kind === 'requirements_changed' && !event.acknowledgedAt) {
        event.acknowledgedAt = at;
        count += 1;
      }
    }
    if (count) { this.appendHistory(sessionId, 'requirements_reread', { count, contract: this.state.harnessContract as unknown as JsonObject }); this.save(); }
    return count;
  }

  listSessions(): MyTerminalSession[] { this.refreshTemporalStates(); return structuredClone(this.state.sessions); }
  session(id: string): MyTerminalSession {
    const found = this.findSession(id);
    if (!found) throw new MyTerminalError('NOT_FOUND', `Session not found: ${id}`);
    return structuredClone(found);
  }

  expectedContinuationCall(sessionId: string): PlannedToolCall | undefined {
    return structuredClone(this.requireSession(sessionId).continuationPlan?.remainingCalls[0]);
  }

  assertContinuationCall(sessionId: string, tool: string, input: JsonObject): void {
    const expected = this.requireSession(sessionId).continuationPlan?.remainingCalls[0];
    if (!expected || (expected.tool === tool && isDeepStrictEqual(expected.input, input))) return;
    throw new MyTerminalError('NEXT_CALL_REQUIRED', `The active continuation plan requires ${expected.tool} next. Execute it now or checkpoint with replanReason if the plan is no longer valid.`, {
      mustContinue: true,
      userFacingFinalProhibited: true,
      nextCall: structuredClone(expected) as unknown as JsonObject,
    });
  }

  completeContinuationCall(sessionId: string, tool: string, input: JsonObject): void {
    const session = this.requireSession(sessionId);
    const plan = session.continuationPlan;
    const expected = plan?.remainingCalls[0];
    if (!plan || !expected || expected.tool !== tool || !isDeepStrictEqual(expected.input, input)) return;
    plan.completedCalls.push(plan.remainingCalls.shift()!);
    session.updatedAt = this.iso();
    if (session.controller) session.controller.lastActivityAt = session.updatedAt;
    this.appendHistory(session.id, 'continuation_call_completed', { tool, remainingCalls: plan.remainingCalls.length });
    this.save();
  }

  registerRoot(args: { name: string; role?: string; continuesSessionId?: string }): { session: MyTerminalSession; identity: SessionIdentity } {
    const predecessor = args.continuesSessionId ? this.requireSession(args.continuesSessionId) : undefined;
    if (predecessor && predecessor.parentSessionId) throw new MyTerminalError('INVALID_INPUT', 'A root continuation must continue a root session.');
    if (predecessor && !TERMINAL_PHASES.has(predecessor.phase)) throw new MyTerminalError('INVALID_STATE', 'Only a completed or cancelled session can be continued.');
    const session = this.makeSession({
      name: args.name, role: args.role, phase: 'working', presence: 'claimed', continuesSessionId: predecessor?.id,
      task: predecessor?.task,
    });
    const identity = this.claimFresh(session);
    if (predecessor) session.latestCheckpoint = predecessor.latestCheckpoint;
    this.state.sessions.push(session);
    this.appendHistory(session.id, 'session_created', { mode: predecessor ? 'continuation' : 'root', continuesSessionId: predecessor?.id });
    this.save();
    return { session: structuredClone(session), identity };
  }

  createTuiRoot(args: { name: string; role?: string; continuesSessionId?: string }): { session: MyTerminalSession; claimCode: string; handoffPrompt: string } {
    const predecessor = args.continuesSessionId ? this.requireSession(args.continuesSessionId) : undefined;
    if (predecessor && (predecessor.parentSessionId || !TERMINAL_PHASES.has(predecessor.phase))) throw new MyTerminalError('INVALID_INPUT', 'A root continuation must continue a terminal root session.');
    const session = this.makeSession({ name: args.name, role: args.role, phase: 'pending', presence: 'unclaimed', continuesSessionId: predecessor?.id, task: predecessor?.task });
    if (predecessor) session.latestCheckpoint = predecessor.latestCheckpoint;
    const claimCode = this.issueClaimCode(session);
    this.state.sessions.push(session);
    this.appendHistory(session.id, 'session_created', { mode: predecessor ? 'tui_continuation' : 'tui_root', continuesSessionId: predecessor?.id });
    this.save();
    return { session: structuredClone(session), claimCode, handoffPrompt: this.handoffPrompt(session, claimCode) };
  }

  registerDelegate(actorId: string, args: { name: string; role?: string; task: TaskPackage; continuesSessionId?: string }): { session: MyTerminalSession; claimCode: string; handoffPrompt: string } {
    const actor = this.requireSession(actorId);
    if (actor.parentSessionId) throw new MyTerminalError('MAX_SESSION_DEPTH', 'Child sessions cannot delegate another session.');
    if (TERMINAL_PHASES.has(actor.phase)) throw new MyTerminalError('INVALID_STATE', 'A terminal session cannot delegate work.');
    const predecessor = args.continuesSessionId ? this.requireSession(args.continuesSessionId) : undefined;
    if (predecessor && (predecessor.parentSessionId !== actor.id || !TERMINAL_PHASES.has(predecessor.phase))) {
      throw new MyTerminalError('INVALID_INPUT', 'A delegated continuation must continue a terminal direct child of the current root.');
    }
    return this.createDelegate(actor, args, predecessor);
  }

  createTuiDelegate(rootId: string, args: { name: string; role?: string; task: TaskPackage; continuesSessionId?: string }): { session: MyTerminalSession; claimCode: string; handoffPrompt: string } {
    const root = this.requireSession(rootId);
    if (root.parentSessionId) throw new MyTerminalError('MAX_SESSION_DEPTH', 'Select a root session for TUI delegation.');
    if (TERMINAL_PHASES.has(root.phase)) throw new MyTerminalError('INVALID_STATE', 'A terminal root cannot receive a new child; create a continuation first.');
    const predecessor = args.continuesSessionId ? this.requireSession(args.continuesSessionId) : undefined;
    if (predecessor && (predecessor.parentSessionId !== root.id || !TERMINAL_PHASES.has(predecessor.phase))) throw new MyTerminalError('INVALID_INPUT', 'Invalid child continuation.');
    return this.createDelegate(root, args, predecessor);
  }

  inherit(sessionId: string, credentials: { claimCode?: string; sessionToken?: string }): { session: MyTerminalSession; identity: SessionIdentity; context: JsonObject } {
    this.refreshTemporalStates();
    const session = this.requireSession(sessionId);
    if (TERMINAL_PHASES.has(session.phase)) throw new MyTerminalError('SESSION_TERMINAL', 'Terminal sessions are immutable; create a continuation session.');
    if (session.presence === 'claimed') throw new MyTerminalError('SESSION_ALREADY_CLAIMED', 'This session has a fresh active controller.');
    const validClaim = credentials.claimCode ? equalHash(credentials.claimCode, session.claimCodeHash) : false;
    const validStaleToken = session.presence === 'stale' && credentials.sessionToken && session.controller
      ? equalHash(credentials.sessionToken, session.controller.tokenHash)
      : false;
    if (!validClaim && !validStaleToken) {
      throw new MyTerminalError('INVALID_RECOVERY_CREDENTIAL', 'Use the one-time claimCode for handoff/revoked/released work, or the previous sessionToken to reclaim the same stale session.');
    }
    const identity = this.claimFresh(session);
    delete session.claimCodeHash;
    delete session.claimCodeIssuedAt;
    if (session.phase === 'pending') session.phase = 'working';
    this.emitEvent(session.id, session.id, 'claimed', { presence: 'claimed' });
    if (session.parentSessionId) this.emitEvent(session.parentSessionId, session.id, 'claimed', { session: publicSession(session) });
    this.appendHistory(session.id, 'claimed', { controllerId: session.controller?.id });
    this.save();
    return { session: structuredClone(session), identity, context: this.context(session.id) };
  }

  authenticate(identity: SessionIdentity): MyTerminalSession {
    this.refreshTemporalStates();
    const session = this.requireSession(identity.sessionId);
    if (session.presence !== 'claimed' || !session.controller || !equalHash(identity.sessionToken, session.controller.tokenHash)) {
      throw new MyTerminalError('INVALID_IDENTITY', 'The session identity is no longer active. If this same ChatGPT conversation was interrupted and the session became stale, call session_inherit without identity using input {sessionId, sessionToken:<previous token>} to reclaim the original unfinished session. For release/revoke/handoff, use a fresh one-time claimCode from the TUI. Never create a new root for the same unfinished task.');
    }
    return structuredClone(session);
  }

  bindApp(clientSessionKey: string, sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (!session.controller || session.presence !== 'claimed') throw new MyTerminalError('INVALID_IDENTITY', 'A claimed session is required before Apps binding.');
    const binding: AppSessionBinding = { clientSessionKey, sessionId: session.id, controllerId: session.controller.id, boundAt: this.iso() };
    this.state.appBindings = this.state.appBindings.filter((item) => item.clientSessionKey !== clientSessionKey);
    this.state.appBindings.push(binding);
    this.save();
  }

  resolveAppBinding(clientSessionKey: string): MyTerminalSession | undefined {
    this.refreshTemporalStates();
    const binding = this.state.appBindings.find((item) => item.clientSessionKey === clientSessionKey);
    if (!binding) return undefined;
    const session = this.findSession(binding.sessionId);
    if (!session?.controller || session.presence !== 'claimed' || session.controller.id !== binding.controllerId) return undefined;
    return structuredClone(session);
  }

  // ── ADR-0029: MCP session identity binding (ephemeral, in-memory) ──
  bindMcp(mcpSessionId: string, sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (!session.controller || session.presence !== 'claimed') throw new MyTerminalError('INVALID_IDENTITY', 'A claimed session is required before MCP binding.');
    const binding: McpSessionBinding = { mcpSessionId, sessionId: session.id, controllerId: session.controller.id, boundAt: this.iso() };
    this.mcpBindings.delete(mcpSessionId);
    this.mcpBindings.set(mcpSessionId, binding);
  }

  resolveMcpBinding(mcpSessionId: string): MyTerminalSession | undefined {
    this.refreshTemporalStates();
    const binding = this.mcpBindings.get(mcpSessionId);
    if (!binding) return undefined;
    const session = this.findSession(binding.sessionId);
    if (!session?.controller || session.presence !== 'claimed' || session.controller.id !== binding.controllerId) return undefined;
    return structuredClone(session);
  }

  unbindMcp(mcpSessionId: string): void {
    this.mcpBindings.delete(mcpSessionId);
  }

  hasMcpBinding(mcpSessionId: string): boolean {
    return this.mcpBindings.has(mcpSessionId);
  }

  /** ADR-0029: drop every MCP binding tied to a session that is being released or reclaimed, so a later connection cannot inherit a stale identity. */
  unbindMcpForSession(sessionId: string): void {
    for (const [key, binding] of this.mcpBindings) {
      if (binding.sessionId === sessionId) this.mcpBindings.delete(key);
    }
  }

  beforeOrdinaryCall(sessionId: string): void {
    this.refreshTemporalStates();
    const session = this.requireSession(sessionId);
    if (!session.controller || session.presence !== 'claimed') throw new MyTerminalError('INVALID_IDENTITY', 'Session controller is not active.');
    const now = this.now();
    if (session.checkpointStartedAt && now - Date.parse(session.checkpointStartedAt) >= CHECKPOINT_BLOCK_MS) {
      throw new MyTerminalError('CHECKPOINT_REQUIRED', 'Checkpoint overdue. Submit session_checkpoint before further work.', {
        checkpointStartedAt: session.checkpointStartedAt, overdueMs: now - Date.parse(session.checkpointStartedAt),
      });
    }
    session.checkpointStartedAt ||= this.iso();
    session.controller.lastActivityAt = this.iso();
    session.updatedAt = this.iso();
    this.appendJournal({
      kind: 'session_touch', sessionId: session.id, updatedAt: session.updatedAt,
      lastActivityAt: session.controller.lastActivityAt, checkpointStartedAt: session.checkpointStartedAt,
    });
  }

  touchControl(sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (session.controller && session.presence === 'claimed') session.controller.lastActivityAt = this.iso();
    session.updatedAt = this.iso();
    this.appendJournal({
      kind: 'session_touch', sessionId: session.id, updatedAt: session.updatedAt,
      lastActivityAt: session.controller?.lastActivityAt, checkpointStartedAt: session.checkpointStartedAt,
    });
  }

  checkpoint(sessionId: string, input: JsonObject): MyTerminalSession {
    const session = this.requireSession(sessionId);
    const phase = input.phase as SessionPhase;
    if (!['pending', 'working', 'waiting', 'blocked', 'completed', 'cancelled'].includes(phase)) throw new MyTerminalError('INVALID_INPUT', 'phase is invalid.');
    const summary = nonEmpty(input.summary, 'summary', 4000);
    const nextCalls = input.nextCalls === undefined ? undefined : plannedToolCalls(input.nextCalls);
    const replanReason = typeof input.replanReason === 'string' && input.replanReason.trim() ? input.replanReason.trim().slice(0, 1000) : undefined;
    if (TERMINAL_PHASES.has(session.phase)) throw new MyTerminalError('SESSION_TERMINAL', 'Terminal sessions are immutable.');
    if (phase === 'completed' && !session.parentSessionId) {
      const now = this.iso();
      const directChildren = this.state.sessions.filter((item) => item.parentSessionId === session.id);
      const reviews = directChildren.map((child) => {
        const unreadMessages = this.state.messages.filter((message) => message.from === child.id && message.to === session.id && !message.readAt);
        const pendingEvents = this.state.events.filter((event) => event.recipientSessionId === session.id && event.sourceSessionId === child.id && !event.acknowledgedAt);
        const since = child.latestCheckpoint?.at || child.createdAt;
        const recentOperations = this.readRecentHistory(child.id)
          .filter((entry) => entry.type === 'tool_audit' && Date.parse(entry.at) >= Date.parse(since))
          .slice(-20)
          .map((entry) => ({ at: entry.at, tool: entry.data.tool, ok: entry.data.ok, durationMs: entry.data.durationMs, errorCode: entry.data.errorCode }));
        return {
          session: publicSession(child),
          latestCheckpoint: child.latestCheckpoint,
          unreadMessages,
          messageObservations: this.observeMessages(unreadMessages),
          pendingEvents,
          recentOperations,
          lastActivityAt: child.controller?.lastActivityAt || child.updatedAt,
          inactivityMs: Math.max(0, Date.parse(now) - Date.parse(child.controller?.lastActivityAt || child.updatedAt)),
          requiresReview: !TERMINAL_PHASES.has(child.phase) || unreadMessages.length > 0 || pendingEvents.length > 0,
        };
      });
      const blocking = reviews.filter((item) => item.requiresReview);
      if (blocking.length) {
        const reviewCheckpoint: SessionCheckpoint = {
          at: now,
          phase: 'working',
          summary: `Completion blocked: ${blocking.length} direct child session(s) still require work or explicit review. Continue orchestration; do not send a final user-facing summary.`,
          nextSteps: ['Inspect the child status and recentOperations returned in this error.', 'Read and respond to unread child messages.', 'Acknowledge pending child events.', 'Help with non-conflicting work directly or send concrete guidance.', 'Complete or cancel each child only after its acceptance criteria are resolved.', 'Retry root completion only after every direct child is terminal and reviewed.'],
          blockers: [], artifacts: [], tags: ['child-review-required'],
        };
        session.phase = 'working';
        session.latestCheckpoint = reviewCheckpoint;
        delete session.continuationPlan;
        session.updatedAt = now;
        delete session.checkpointStartedAt;
        delete session.checkpointReminderEmittedAt;
        this.appendHistory(session.id, 'checkpoint', reviewCheckpoint as unknown as JsonObject);
        this.appendHistory(session.id, 'completion_blocked', { at: now, children: blocking.map((item) => ({ sessionId: (item.session as JsonObject).id, requiresReview: item.requiresReview })) });
        if (session.controller) session.controller.lastActivityAt = now;
        this.save();
        throw new MyTerminalError('CHILD_REVIEW_REQUIRED', 'Root completion is blocked. Continue working and supervising; a user-facing completion summary is prohibited until every direct child is terminal and all child messages/events are reviewed.', {
          currentTime: now,
          rootSession: publicSession(session),
          children: reviews,
          mustContinue: true,
          userFacingFinalProhibited: true,
          guidance: [
            'Do not end the turn with a completion-style user report.',
            'Use message_send for coordination and session_checkpoint for durable progress updates.',
            'Supervision is collaborative: when safe and non-conflicting, directly complete useful work and hand the result to the responsible child.',
            'Delegate by domain and parallel workload; do not offload an entire large objective to one child.',
          ],
        });
      }
    }
    const previousPhase = session.phase;
    const checkpoint: SessionCheckpoint = {
      at: this.iso(), phase, summary,
      nextSteps: stringArray(input.nextSteps, 'nextSteps'), blockers: stringArray(input.blockers, 'blockers'),
      artifacts: stringArray(input.artifacts, 'artifacts'),
      milestone: typeof input.milestone === 'string' && input.milestone.trim() ? input.milestone.trim().slice(0, 1000) : undefined,
      tags: stringArray(input.tags, 'tags'),
      nextCalls,
      replanReason,
    };
    session.phase = phase;
    session.latestCheckpoint = checkpoint;
    session.continuationPlan = phase === 'working' && nextCalls ? {
      createdAt: checkpoint.at,
      completedCalls: [],
      remainingCalls: structuredClone(nextCalls),
    } : undefined;
    session.tags = [...new Set([...session.tags, ...(checkpoint.tags ?? [])])].slice(0, 100);
    session.updatedAt = checkpoint.at;
    delete session.checkpointStartedAt;
    delete session.checkpointReminderEmittedAt;
    if (phase === 'completed') session.finalSummary = summary;
    this.appendHistory(session.id, 'checkpoint', checkpoint as unknown as JsonObject);
    if (phase !== previousPhase) this.notifyProgress(session, phase === 'blocked' ? 'blocked' : phase === 'completed' ? 'completed' : 'phase_changed', { previousPhase, phase, summary });
    if (checkpoint.milestone) this.notifyProgress(session, 'milestone', { milestone: checkpoint.milestone, summary });
    if (TERMINAL_PHASES.has(phase)) this.releaseController(session, phase === 'cancelled' ? 'cancelled' : 'released', false);
    else if (session.controller) session.controller.lastActivityAt = checkpoint.at;
    this.save();
    return structuredClone(session);
  }

  release(sessionId: string): { session: MyTerminalSession; claimCode: string; handoffPrompt: string } {
    const session = this.requireSession(sessionId);
    if (TERMINAL_PHASES.has(session.phase)) throw new MyTerminalError('SESSION_TERMINAL', 'Terminal sessions are already released.');
    const claimCode = this.releaseController(session, 'released', true)!;
    this.save();
    return { session: structuredClone(session), claimCode, handoffPrompt: this.handoffPrompt(session, claimCode) };
  }

  revokeFromTui(sessionId: string): { session: MyTerminalSession; claimCode: string; handoffPrompt: string } {
    const session = this.requireSession(sessionId);
    if (TERMINAL_PHASES.has(session.phase)) throw new MyTerminalError('SESSION_TERMINAL', 'Terminal sessions cannot be revoked.');
    const claimCode = this.releaseController(session, 'revoked', true)!;
    this.save();
    return { session: structuredClone(session), claimCode, handoffPrompt: this.handoffPrompt(session, claimCode) };
  }

  cancelFromTui(sessionId: string): MyTerminalSession {
    const session = this.requireSession(sessionId);
    if (TERMINAL_PHASES.has(session.phase)) throw new MyTerminalError('SESSION_TERMINAL', 'This session is already terminal.');
    session.phase = 'cancelled';
    this.releaseController(session, 'cancelled', false);
    this.notifyProgress(session, 'cancelled', { phase: 'cancelled' });
    this.appendHistory(session.id, 'cancelled', {});
    this.save();
    return structuredClone(session);
  }

  tag(sessionId: string, tags: string[]): MyTerminalSession {
    const session = this.requireSession(sessionId);
    session.tags = [...new Set([...session.tags, ...tags.map((tag) => tag.trim()).filter(Boolean)])].slice(0, 100);
    session.updatedAt = this.iso();
    this.appendHistory(session.id, 'tags_updated', { tags: session.tags });
    this.save();
    return structuredClone(session);
  }

  subscribe(subscriberId: string, targetId: string): void {
    const subscriber = this.requireSession(subscriberId);
    const target = this.requireSession(targetId);
    if (subscriber.id === target.id) throw new MyTerminalError('INVALID_INPUT', 'A session cannot subscribe to itself.');
    if (!this.state.subscriptions.some((item) => item.subscriberSessionId === subscriber.id && item.targetSessionId === target.id)) {
      this.state.subscriptions.push({ subscriberSessionId: subscriber.id, targetSessionId: target.id, createdAt: this.iso() });
      this.appendHistory(subscriber.id, 'subscribed', { targetSessionId: target.id });
      this.save();
    }
  }

  acknowledgeEvents(sessionId: string, eventIds: string[]): number {
    const wanted = new Set(eventIds);
    let count = 0;
    for (const event of this.state.events) {
      if (event.recipientSessionId === sessionId && wanted.has(event.id) && !event.acknowledgedAt) {
        event.acknowledgedAt = this.iso(); count += 1;
      }
    }
    if (count) { this.appendHistory(sessionId, 'events_acknowledged', { eventIds: [...wanted] }); this.save(); }
    return count;
  }

  pendingEvents(sessionId: string, limit = 5): SessionEvent[] {
    this.refreshTemporalStates();
    return structuredClone(this.state.events.filter((event) => event.recipientSessionId === sessionId && !event.acknowledgedAt).slice(0, Math.min(5, Math.max(1, limit))));
  }

  sendMessage(fromId: string, toId: string, body: string): MyTerminalMessage {
    const sender = this.requireSession(fromId);
    const recipient = this.requireSession(toId);
    if (TERMINAL_PHASES.has(sender.phase)) throw new MyTerminalError('SESSION_TERMINAL', 'A terminal session cannot send new messages.');
    if (TERMINAL_PHASES.has(recipient.phase)) throw new MyTerminalError('INVALID_STATE', 'The recipient session is terminal; continue it before sending more work.');
    const message: MyTerminalMessage = { id: `msg_${randomUUID()}`, from: sender.id, to: recipient.id, source: 'session', body: nonEmpty(body, 'body', 20_000), createdAt: this.iso() };
    this.state.messages.push(message);
    this.appendHistory(sender.id, 'message_sent', message as unknown as JsonObject);
    this.appendHistory(recipient.id, 'message_received', message as unknown as JsonObject);
    const event = this.emitEvent(recipient.id, sender.id, 'message', { message });
    this.appendJournal({ kind: 'message', message, event });
    return structuredClone(message);
  }

  sendUserMessage(toId: string, body: string): MyTerminalMessage {
    const recipient = this.requireSession(toId);
    if (TERMINAL_PHASES.has(recipient.phase)) throw new MyTerminalError('INVALID_STATE', 'The recipient session is terminal; continue it before sending more work.');
    const message: MyTerminalMessage = { id: `msg_${randomUUID()}`, from: 'user', to: recipient.id, source: 'user', body: nonEmpty(body, 'body', 20_000), createdAt: this.iso() };
    this.state.messages.push(message);
    this.appendHistory(recipient.id, 'user_message_received', message as unknown as JsonObject);
    const event = this.emitEvent(recipient.id, 'user', 'message', { message, source: 'user' });
    this.appendJournal({ kind: 'message', message, event });
    return structuredClone(message);
  }

  observeMessages(messages: MyTerminalMessage[]): JsonObject[] {
    const observedAt = this.iso();
    const observedMs = Date.parse(observedAt);
    const involvedSessions = new Set(messages.flatMap((message) => [message.from, message.to]).filter((id) => id !== 'user'));
    const auditedBySession = new Map([...involvedSessions].map((id) => [id, this.readRecentHistory(id)
      .filter((entry) => entry.type === 'tool_audit' && Date.parse(entry.at) <= observedMs)]));
    return messages.map((message) => {
      const sentMs = Date.parse(message.createdAt);
      const involved = new Set([message.from, message.to].filter((id) => id !== 'user'));
      const operations = [...involved].flatMap((id) => (auditedBySession.get(id) ?? [])
        .filter((entry) => Date.parse(entry.at) >= sentMs)
        .map((entry) => ({ sessionId: id, at: entry.at, tool: entry.data.tool, ok: entry.data.ok, durationMs: entry.data.durationMs })));
      return {
        message,
        sentAt: message.createdAt,
        observedAt,
        ageMs: Math.max(0, observedMs - sentMs),
        operationsSinceSend: operations.sort((a, b) => a.at.localeCompare(b.at)),
        latencyNotice: operations.length ? 'The recipient may have progressed after this message; review operationsSinceSend before acting.' : 'No audited tool activity was recorded after this message.',
      };
    });
  }

  inbox(sessionId: string, markRead = false, offset?: number, limit = 50): MyTerminalMessage[] {
    return this.inboxPage(sessionId, markRead, offset, limit).messages;
  }

  inboxPage(sessionId: string, markRead = false, offset?: number, limit = 50): { total: number; offset: number; nextOffset?: number; messages: MyTerminalMessage[] } {
    const session = this.requireSession(sessionId);
    const messages = this.state.messages.filter((message) => message.to === session.id);
    const count = Math.max(1, Math.min(200, limit));
    const start = offset === undefined ? Math.max(0, messages.length - count) : Math.max(0, Math.min(messages.length, offset));
    const page = messages.slice(start, start + count);
    if (markRead) {
      let changed = false;
      for (const message of page) {
        if (!message.readAt) { message.readAt = this.iso(); changed = true; }
      }
      if (changed) this.save();
    }
    return { total: messages.length, offset: start, nextOffset: start + count < messages.length ? start + count : undefined, messages: structuredClone(page) };
  }

  listMessages(limit = 100): MyTerminalMessage[] { return structuredClone(this.state.messages.slice(-Math.max(1, Math.min(1000, limit)))); }

  messagesForSession(sessionId: string, limit = 100): MyTerminalMessage[] {
    const session = this.requireSession(sessionId);
    return structuredClone(this.state.messages.filter((message) => message.from === session.id || message.to === session.id).slice(-Math.max(1, Math.min(1000, limit))));
  }

  /** W1-04 (#77)：message_list 分页版（0050 A4）。与 inboxPage 同构：切片 + 上报 total/offset/nextOffset，
   *  供 L1 reducer 派生 count/totalCount/truncated 与分页 continuation；offset 缺省 = 最新一页（与
   *  messagesForSession 末段语义一致）。 */
  messagesForSessionPage(sessionId: string, offset?: number, limit = 100): { total: number; offset: number; nextOffset?: number; messages: MyTerminalMessage[] } {
    const session = this.requireSession(sessionId);
    const messages = this.state.messages.filter((message) => message.from === session.id || message.to === session.id);
    const count = Math.max(1, Math.min(1000, limit));
    const start = offset === undefined ? Math.max(0, messages.length - count) : Math.max(0, Math.min(messages.length, offset));
    const page = messages.slice(start, start + count);
    return { total: messages.length, offset: start, nextOffset: start + count < messages.length ? start + count : undefined, messages: structuredClone(page) };
  }

  /** W1-04 (#77)：conversation 分页化（0050 A4）。offset 缺省 = 最新一页（与旧 slice(-N) 末段语义一致）；
   *  新增 total/offset/nextOffset 上报，供 L1 reducer 派生 count/totalCount/truncated 与分页 continuation。 */
  conversation(sessionId: string, otherSessionId: string, offset?: number, limit = 1000): { sessions: JsonObject[]; messages: MyTerminalMessage[]; total: number; offset: number; nextOffset?: number } {
    const session = this.requireSession(sessionId);
    const other = this.requireSession(otherSessionId);
    const messages = this.state.messages.filter((message) =>
      (message.from === session.id && message.to === other.id) || (message.from === other.id && message.to === session.id));
    const count = Math.max(1, Math.min(5000, limit));
    const start = offset === undefined ? Math.max(0, messages.length - count) : Math.max(0, Math.min(messages.length, offset));
    const page = messages.slice(start, start + count);
    return { sessions: [publicSession(session), publicSession(other)], messages: structuredClone(page), total: messages.length, offset: start, nextOffset: start + count < messages.length ? start + count : undefined };
  }

  historyPage(sessionId: string, offset = 0, limit = 100, includeAncestors = true): { total: number; offset: number; nextOffset?: number; entries: JsonObject[] } {
    const current = this.requireSession(sessionId);
    const sessions: MyTerminalSession[] = [];
    const seen = new Set<string>();
    let cursor: MyTerminalSession | undefined = current;
    while (cursor && !seen.has(cursor.id)) {
      sessions.unshift(cursor); seen.add(cursor.id);
      cursor = includeAncestors && cursor.continuesSessionId ? this.findSession(cursor.continuesSessionId) : undefined;
    }
    const count = Math.max(1, Math.min(500, limit));
    const totals = sessions.map((session) => this.historyCount(session.id));
    const total = totals.reduce((sum, value) => sum + value, 0);
    const start = Math.max(0, Math.min(total, offset));
    if (sessions.length === 1) {
      const session = sessions[0];
      const entries = this.readHistoryRange(session.id, start, count).map((entry) => ({ sessionId: session.id, sessionName: session.name, ...entry }));
      return { total, offset: start, nextOffset: start + count < total ? start + count : undefined, entries: structuredClone(entries) };
    }
    // Continuation chains are normally short. Read only the prefix needed for
    // this page from each file, then merge by timestamp without caching files.
    const entries = sessions.flatMap((session) => this.readHistoryRange(session.id, 0, Math.min(totals[sessions.indexOf(session)], start + count))
      .map((entry) => ({ sessionId: session.id, sessionName: session.name, ...entry })))
      .sort((a, b) => a.at.localeCompare(b.at));
    return { total, offset: start, nextOffset: start + count < total ? start + count : undefined, entries: structuredClone(entries.slice(start, start + count)) };
  }

  historiesForTui(sessionIds: string[], limit = 200): Array<{ sessionId: string; sessionName: string; entry: SessionHistoryEntry }> {
    const count = Math.max(1, Math.min(1_000, limit));
    return sessionIds.flatMap((id) => {
      const session = this.requireSession(id);
      return this.readHistoryTail(session.id, count).map((entry) => ({ sessionId: session.id, sessionName: session.name, entry }));
    }).sort((a, b) => a.entry.at.localeCompare(b.entry.at)).slice(-count);
  }

  historyCount(sessionId: string): number { return this.historyIndex(sessionId).total; }

  auditFacts(limit = 500): AuditFact[] { return this.audit.facts(limit); }

  /** Coherent pagination over the audit stream (ADR-0032 #64 seam, consumed by #62). */
  auditFactsPage(offset = 0, limit = 100): AuditFactsPage { return this.audit.factsPage(offset, limit); }

  /** Backwards-paginated audit view for log screens (ADR-0033 #62). */
  auditRecentFactsPage(page = 0, limit = 100, until?: string): AuditFactsPage { return this.audit.recentFactsPage(page, limit, until); }

  cumulativeContextChars(sessionId?: string): number {
    const facts = this.auditFacts(5000).filter((f) => !sessionId || f.sessionId === sessionId);
    return facts.reduce((sum, f) => sum + JSON.stringify(f.args || {}).length + JSON.stringify(f.result || {}).length, 0);
  }

  auditEvent(sessionId: string, event: ToolAuditEvent): ToolAuditEvent { return this.audit.event(sessionId, event); }

  /** ADR-0032 #63: store reads each involved session's tail exactly once; assembly + budget fitting live in the pure projector seam. */
  context(sessionId: string): JsonObject {
    const session = this.requireSession(sessionId);
    const parent = session.parentSessionId ? this.requireSession(session.parentSessionId) : undefined;
    const predecessor = session.continuesSessionId ? this.requireSession(session.continuesSessionId) : undefined;
    return projectContext({
      session,
      history: this.readRecentHistory(session.id),
      messages: this.state.messages,
      parent,
      parentHistory: parent ? this.readRecentHistory(parent.id) : undefined,
      predecessor,
      predecessorHistory: predecessor ? this.readRecentHistory(predecessor.id) : undefined,
      toPublic: publicSession,
    });
  }

  refreshTemporalStates(): void {
    const now = this.now();
    let changed = false;
    for (const session of this.state.sessions) {
      if (session.presence === 'claimed' && session.controller && now - Date.parse(session.controller.lastActivityAt) >= STALE_MS) {
        session.presence = 'stale';
        session.claimCodeHash = undefined;
        const code = this.issueClaimCode(session);
        const stalePayload = { staleAt: this.iso(), reclaimRequired: true, claimCodeRotated: Boolean(code) };
        this.emitEvent(session.id, session.id, 'stale', stalePayload);
        this.notifyProgress(session, 'stale', stalePayload);
        this.appendHistory(session.id, 'stale', {});
        changed = true;
      }
      if (session.checkpointStartedAt && !session.checkpointReminderEmittedAt && now - Date.parse(session.checkpointStartedAt) >= CHECKPOINT_REMINDER_MS) {
        session.checkpointReminderEmittedAt = this.iso();
        this.emitEvent(session.id, session.id, 'checkpoint_due', { checkpointStartedAt: session.checkpointStartedAt, blockAfterMinutes: 5 });
        changed = true;
      }
    }
    if (changed) this.save();
  }

  pendingUnclaimed(): MyTerminalSession[] {
    return this.listSessions().filter((session) => !TERMINAL_PHASES.has(session.phase) && session.presence !== 'claimed');
  }

  handoffForTui(sessionId: string): string | undefined {
    const session = this.requireSession(sessionId);
    const code = this.transientClaimCodes.get(session.id);
    return code ? this.handoffPrompt(session, code) : undefined;
  }

  deleteFromTui(sessionId: string, confirmation?: string): { deleted: string[] } {
    const session = this.requireSession(sessionId);
    const descendants = this.state.sessions.filter((item) => item.parentSessionId === session.id);
    if ((descendants.length || this.historyCount(session.id)) && confirmation !== `DELETE ${session.id}`) {
      throw new MyTerminalError('DELETE_CONFIRMATION_REQUIRED', `Type DELETE ${session.id} to remove this session, its descendants, and their histories.`, { descendants: descendants.map((item) => item.id) });
    }
    const deleted = new Set([session.id, ...descendants.map((item) => item.id)]);
    this.state.sessions = this.state.sessions.filter((item) => !deleted.has(item.id));
    this.state.messages = this.state.messages.filter((item) => !deleted.has(item.from) && !deleted.has(item.to));
    this.state.events = this.state.events.filter((item) => !deleted.has(item.recipientSessionId) && !deleted.has(item.sourceSessionId));
    this.state.subscriptions = this.state.subscriptions.filter((item) => !deleted.has(item.subscriberSessionId) && !deleted.has(item.targetSessionId));
    this.state.appBindings = this.state.appBindings.filter((item) => !deleted.has(item.sessionId));
    for (const item of this.state.sessions) if (item.continuesSessionId && deleted.has(item.continuesSessionId)) item.predecessorDeleted = true;
    for (const id of deleted) { rmSync(this.historyPath(id), { force: true }); this.transientClaimCodes.delete(id); this.historyIndexes.delete(id); this.historyTailCache.delete(id); }
    this.audit.pruneDeleted(deleted);
    this.save();
    return { deleted: [...deleted] };
  }

  upsertExtension(spec: CustomExtensionSpec): CustomExtensionSpec {
    const index = this.state.extensions.findIndex((item) => item.name === spec.name);
    if (index >= 0) this.state.extensions[index] = structuredClone(spec); else this.state.extensions.push(structuredClone(spec));
    this.save(); return structuredClone(spec);
  }
  removeExtension(name: string): void {
    const before = this.state.extensions.length;
    this.state.extensions = this.state.extensions.filter((item) => item.name !== name);
    if (before === this.state.extensions.length) throw new MyTerminalError('NOT_FOUND', `Custom extension not found: ${name}`);
    this.save();
  }

  private createDelegate(root: MyTerminalSession, args: { name: string; role?: string; task: TaskPackage; continuesSessionId?: string }, predecessor?: MyTerminalSession) {
    const session = this.makeSession({
      name: args.name, role: args.role, phase: 'pending', presence: 'unclaimed', parentSessionId: root.id,
      continuesSessionId: predecessor?.id, task: cleanTask(args.task),
    });
    const claimCode = this.issueClaimCode(session);
    this.state.sessions.push(session);
    this.state.subscriptions.push({ subscriberSessionId: root.id, targetSessionId: session.id, createdAt: this.iso() });
    this.appendHistory(session.id, 'task_package', session.task as unknown as JsonObject);
    this.emitEvent(root.id, session.id, 'child_created', { session: publicSession(session), task: session.task });
    this.save();
    return { session: structuredClone(session), claimCode, handoffPrompt: this.handoffPrompt(session, claimCode) };
  }

  private makeSession(args: Partial<MyTerminalSession> & { name: string; phase: SessionPhase; presence: MyTerminalSession['presence'] }): MyTerminalSession {
    const name = nonEmpty(args.name, 'name', 80);
    if (this.state.sessions.some((session) => session.name === name && !TERMINAL_PHASES.has(session.phase))) throw new MyTerminalError('DUPLICATE_SESSION', `A non-terminal session named ${name} already exists.`);
    const now = this.iso();
    return {
      id: `ses_${randomUUID()}`, name, role: (args.role || 'developer').slice(0, 80), phase: args.phase, presence: args.presence,
      parentSessionId: args.parentSessionId, continuesSessionId: args.continuesSessionId, task: args.task, tags: [], createdAt: now, updatedAt: now,
    };
  }

  private claimFresh(session: MyTerminalSession): SessionIdentity {
    const sessionToken = randomBytes(32).toString('hex');
    const now = this.iso();
    session.controller = { id: `ctl_${randomUUID()}`, tokenHash: hash(sessionToken), claimedAt: now, lastActivityAt: now };
    session.presence = 'claimed'; session.updatedAt = now;
    this.transientClaimCodes.delete(session.id);
    this.state.appBindings = this.state.appBindings.filter((item) => item.sessionId !== session.id);
    this.unbindMcpForSession(session.id);
    return { sessionId: session.id, sessionToken };
  }

  private releaseController(session: MyTerminalSession, kind: SessionEventKind, issueCode: boolean): string | undefined {
    delete session.controller; delete session.checkpointStartedAt; delete session.checkpointReminderEmittedAt;
    session.presence = 'unclaimed';
    session.updatedAt = this.iso();
    this.state.appBindings = this.state.appBindings.filter((item) => item.sessionId !== session.id);
    this.unbindMcpForSession(session.id);
    const code = issueCode ? this.issueClaimCode(session) : undefined;
    this.emitEvent(session.id, session.id, kind, { phase: session.phase, presence: session.presence });
    this.appendHistory(session.id, kind, { phase: session.phase, presence: session.presence });
    return code;
  }

  private issueClaimCode(session: MyTerminalSession): string {
    const code = randomBytes(18).toString('hex');
    session.claimCodeHash = hash(code); session.claimCodeIssuedAt = this.iso();
    this.transientClaimCodes.set(session.id, code);
    return code;
  }

  private handoffPrompt(session: MyTerminalSession, claimCode: string): string {
    const task = session.task;
    const format = (items?: string[]) => items?.length ? items.map((item) => `- ${item}`).join('\n') : '- 未指定';
    return `你来接手 MyTerminal session “${session.name}”。\n\n身份与领取：\n在调用任何工作工具前，先调用 extensionCall：tool=session_inherit，input={"sessionId":"${session.id}","claimCode":"${claimCode}"}。接管后使用返回的 sessionId + sessionToken 作为后续所有调用的 identity。\n\n角色：${session.role}\n目标：${task?.objective || '继续此 session 的工作'}\n背景：${task?.background || '无额外背景'}\n交付物：\n${format(task?.deliverables)}\n验收标准：\n${format(task?.acceptanceCriteria)}\n约束：\n${format(task?.constraints)}\n\n协作与状态要求：\n- 子 session 的目标是并行高效和专业分工，不是被动等待或只做单向监督。\n- 在不产生冲突且符合范围时，主动完成可帮助其他 session 的工作，并通过 message_send 交接可直接纳入的成果。\n- 持续工作直到自己的交付物和验收标准完成、明确阻塞，或必须等待外部输入；不要在一次消息往返后无故停下。\n- 未完成全部工作时，禁止向用户输出完成式或总结式最终回复；阶段性进展通过 message_send、事件确认和 session_checkpoint 记录。\n- session 状态更新优先级最高。session_checkpoint 用于持久化准确 phase，但 working checkpoint 不是停止点；若响应要求继续，必须在同一轮立即执行返回的 nextCall。只有 waiting/blocked/completed/cancelled 可以结束工作轮次。\n- 只有完成并验证所有交付物后才能使用 completed。`;
  }

  private notifyProgress(session: MyTerminalSession, kind: SessionEventKind, payload: JsonObject): void {
    const recipients = new Set(this.state.subscriptions.filter((item) => item.targetSessionId === session.id).map((item) => item.subscriberSessionId));
    if (session.parentSessionId) recipients.add(session.parentSessionId);
    for (const recipient of recipients) this.emitEvent(recipient, session.id, kind, payload);
  }

  private emitEvent(recipientSessionId: string, sourceSessionId: string, kind: SessionEventKind, payload: JsonObject): SessionEvent {
    const event: SessionEvent = { id: `evt_${randomUUID()}`, recipientSessionId, sourceSessionId, kind, payload: structuredClone(payload), createdAt: this.iso() };
    this.state.events.push(event);
    this.appendHistory(recipientSessionId, 'event', event as unknown as JsonObject);
    return event;
  }

  private findSession(id: string): MyTerminalSession | undefined { return this.state.sessions.find((item) => item.id === id || item.name === id); }
  private requireSession(id: string): MyTerminalSession { const session = this.findSession(id); if (!session) throw new MyTerminalError('NOT_FOUND', `Session not found: ${id}`); return session; }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private historyPath(sessionId: string): string { return path.join(this.historyDir, `${sessionId}.jsonl`); }
  private appendHistory(sessionId: string, type: string, data: JsonObject): void {
    const entry: SessionHistoryEntry = { at: this.iso(), type, data };
    appendFileSync(this.historyPath(sessionId), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.historyIndexes.delete(sessionId);
    this.historyTailCache.delete(sessionId);
  }
  private readRecentHistory(sessionId: string): SessionHistoryEntry[] {
    const file = this.historyPath(sessionId);
    if (!existsSync(file)) return [];
    const stat = statSync(file);
    const cached = this.historyTailCache.get(sessionId);
    // 返回拷贝而非缓存数组本身：调用方原地 push/splice 不得污染缓存（#70 门禁收尾，别名风险）。
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.entries.slice();
    const entries = this.readHistoryTail(sessionId, HISTORY_TAIL_LIMIT);
    this.historyTailCache.set(sessionId, { size: stat.size, mtimeMs: stat.mtimeMs, entries });
    return entries.slice();
  }

  private readHistoryTail(sessionId: string, limit: number): SessionHistoryEntry[] {
    const total = this.historyCount(sessionId);
    return this.readHistoryRange(sessionId, Math.max(0, total - limit), limit);
  }

  private historyIndex(sessionId: string): HistoryIndex {
    const file = this.historyPath(sessionId);
    if (!existsSync(file)) return { size: 0, mtimeMs: 0, total: 0, offsets: [0] };
    const stat = statSync(file);
    const cached = this.historyIndexes.get(sessionId);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
    const offsets = [0];
    let total = 0;
    let position = 0;
    let lineStart = 0;
    const fd = openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      while (position < stat.size) {
        const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (!bytes) break;
        for (let index = 0; index < bytes; index += 1) {
          if (buffer[index] !== 10) continue;
          const lineEnd = position + index;
          if (lineEnd > lineStart) {
            total += 1;
            if (total % HISTORY_INDEX_STRIDE === 0 && lineEnd + 1 < stat.size) offsets.push(lineEnd + 1);
          }
          lineStart = lineEnd + 1;
        }
        position += bytes;
      }
      if (lineStart < stat.size) total += 1;
    } finally { closeSync(fd); }
    const built = { size: stat.size, mtimeMs: stat.mtimeMs, total, offsets };
    this.historyIndexes.set(sessionId, built);
    return built;
  }

  private readHistoryRange(sessionId: string, offset: number, limit: number): SessionHistoryEntry[] {
    const index = this.historyIndex(sessionId);
    if (!index.total || offset >= index.total || limit <= 0) return [];
    const start = Math.max(0, offset);
    const checkpoint = Math.floor(start / HISTORY_INDEX_STRIDE);
    let lineNumber = checkpoint * HISTORY_INDEX_STRIDE;
    let position = index.offsets[checkpoint] ?? 0;
    let carry = Buffer.alloc(0);
    const entries: SessionHistoryEntry[] = [];
    const fd = openSync(this.historyPath(sessionId), 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const consume = (line: Buffer) => {
      if (!line.length) return;
      if (lineNumber >= start && entries.length < limit) {
        try { entries.push(JSON.parse(line.toString('utf8')) as SessionHistoryEntry); }
        catch { /* tolerate a corrupt history line without losing later entries */ }
      }
      lineNumber += 1;
    };
    try {
      while (position < index.size && entries.length < limit) {
        const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, index.size - position), position);
        if (!bytes) break;
        const chunk = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytes)]) : buffer.subarray(0, bytes);
        let startAt = 0;
        for (let cursor = 0; cursor < chunk.length; cursor += 1) {
          if (chunk[cursor] !== 10) continue;
          consume(chunk.subarray(startAt, cursor));
          startAt = cursor + 1;
          if (entries.length >= limit) break;
        }
        carry = startAt < chunk.length ? Buffer.from(chunk.subarray(startAt)) : Buffer.alloc(0);
        position += bytes;
      }
      if (entries.length < limit && carry.length) consume(carry);
    } finally { closeSync(fd); }
    return entries;
  }

  private load(): StoredState {
    if (!existsSync(this.statePath)) return structuredClone(EMPTY_STATE);
    const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as StoredState | LegacyState;
    if (parsed.schemaVersion === 2) {
      if (!Array.isArray(parsed.sessions) || !Array.isArray(parsed.messages) || !Array.isArray(parsed.events) || !Array.isArray(parsed.subscriptions) || !Array.isArray(parsed.appBindings) || !Array.isArray(parsed.extensions)) throw new Error(`Invalid MyTerminal state: ${this.statePath}`);
      return this.replayJournal(parsed);
    }
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.messages) || !Array.isArray(parsed.extensions)) throw new Error(`Invalid MyTerminal state: ${this.statePath}`);
    const phaseMap: Record<LegacySession['status'], SessionPhase> = { active: 'working', idle: 'waiting', blocked: 'blocked', completed: 'completed' };
    const migrated: StoredState = {
      ...structuredClone(EMPTY_STATE), revision: parsed.revision,
      sessions: parsed.sessions.map((item) => ({
        id: item.id, name: item.name, role: item.role, phase: phaseMap[item.status], presence: 'stale',
        latestCheckpoint: item.note ? { at: item.updatedAt, phase: phaseMap[item.status], summary: item.note } : undefined,
        finalSummary: item.status === 'completed' ? item.note || 'Migrated completed session.' : undefined,
        tags: [], createdAt: item.createdAt, updatedAt: item.updatedAt,
      })),
      messages: parsed.messages, extensions: parsed.extensions,
    };
    this.state = migrated;
    for (const session of migrated.sessions) this.appendHistory(session.id, 'migration_v1', { legacyStatus: parsed.sessions.find((item) => item.id === session.id)?.status });
    for (const message of migrated.messages) {
      this.appendHistory(message.from, 'message_sent', message as unknown as JsonObject);
      this.appendHistory(message.to, 'message_received', message as unknown as JsonObject);
    }
    this.save();
    return migrated;
  }

  private save(): void {
    this.state.revision += 1;
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.statePath);
    try { rmSync(this.journalPath, { force: true }); } catch { /* the atomic snapshot is already durable */ }
    this.journalEntries = 0;
    this.journalBytes = 0;
  }

  private appendJournal(entry: StoreJournalInput): void {
    this.state.revision += 1;
    const encoded = `${JSON.stringify({ ...entry, revision: this.state.revision })}\n`;
    appendFileSync(this.journalPath, encoded, { mode: 0o600 });
    this.journalEntries += 1;
    this.journalBytes += Buffer.byteLength(encoded);
    if (this.journalEntries >= 1000 || this.journalBytes >= 4 * 1024 * 1024) this.save();
  }

  private replayJournal(state: StoredState): StoredState {
    if (!existsSync(this.journalPath)) return state;
    const messageIds = new Set(state.messages.map((message) => message.id));
    const eventIds = new Set(state.events.map((event) => event.id));
    const lines = readFileSync(this.journalPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let entry: StoreJournalEntry;
      try { entry = JSON.parse(line) as StoreJournalEntry; } catch { continue; }
      state.revision = Math.max(state.revision, Number(entry.revision) || 0);
      if (entry.kind === 'message') {
        if (!messageIds.has(entry.message.id)) { state.messages.push(entry.message); messageIds.add(entry.message.id); }
        if (!eventIds.has(entry.event.id)) { state.events.push(entry.event); eventIds.add(entry.event.id); }
        continue;
      }
      const session = state.sessions.find((item) => item.id === entry.sessionId);
      if (!session) continue;
      session.updatedAt = entry.updatedAt;
      if (entry.checkpointStartedAt) session.checkpointStartedAt = entry.checkpointStartedAt;
      if (session.controller && entry.lastActivityAt) session.controller.lastActivityAt = entry.lastActivityAt;
    }
    this.journalEntries = lines.length;
    this.journalBytes = Buffer.byteLength(lines.join('\n'));
    return state;
  }
}

export const SESSION_TIMING = { CHECKPOINT_REMINDER_MS, CHECKPOINT_BLOCK_MS, STALE_MS };
