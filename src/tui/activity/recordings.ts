// Read-only projection of the subagent AG-UI event stream into the ported
// min-agent transcript. Nothing here writes to subagent state: it subscribes
// to the existing in-process bus and only records what the TUI displays.
import { subagentEvents } from '../../subagent/tui-bridge.js';
import type { AgUiEvent } from '../../subagent/tui-bridge.js';
import { Transcript } from './transcript.js';

export type ActivityStatus = 'running' | 'completed' | 'failed' | 'aborted';

/** Structural subset of AgUiEvent so the recorder can be unit-tested without the bus. */
export type ActivityEvent = {
  subagentId: string;
  type: string;
  data?: Record<string, unknown>;
  timestamp?: number;
};

/** Minimal record surface needed to seed activity that predates the recorder. */
export type ActivitySeedRecord = {
  id: string;
  status: string;
  result?: string;
  error?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Normalize the two TOOL_CALL_RESULT shapes (execution tool-result or error). */
function normalizeToolResult(data: Record<string, unknown>): { text: string; isError: boolean } {
  const error = asString(data.error);
  if (error !== undefined) return { text: `error: ${error}`, isError: true };

  const raw = data.result ?? data.content;
  if (typeof raw === 'string') {
    return { text: raw, isError: raw.startsWith('error:') };
  }
  if (raw !== null && typeof raw === 'object') {
    const value = raw as Record<string, unknown>;
    const text = asString(value.content) ?? stringifyValue(value);
    return { text, isError: value.is_error === true || text.startsWith('error:') };
  }
  if (raw === undefined) return { text: '', isError: false };
  return { text: String(raw), isError: false };
}

/**
 * One subagent's activity page model. Assistant deltas stream into a single
 * markdown block; every tool call becomes a collapsible status panel. The
 * event-to-block mapping is chronological, which is exactly the merged
 * "self-talk + tool calls" page the reference project renders.
 */
export class SubagentActivity {
  readonly transcript = new Transcript();
  status: ActivityStatus = 'running';
  turns = 0;
  error?: string;
  result?: string;
  startedAt = Date.now();
  finishedAt?: number;

  private readonly idToBlock = new Map<string, number>();
  private lastToolIndex: number | null = null;

  apply(event: ActivityEvent): void {
    const data = event.data ?? {};
    switch (event.type) {
      case 'RUN_STARTED':
        this.status = 'running';
        this.transcript.endTurn();
        break;

      case 'TEXT_MESSAGE_START':
        this.transcript.endTurn();
        break;

      case 'TEXT_MESSAGE_CONTENT': {
        const delta = asString(data.delta) ?? '';
        if (delta) this.transcript.appendAssistant(delta);
        break;
      }

      case 'TEXT_MESSAGE_END':
        this.transcript.endTurn();
        break;

      case 'TOOL_CALL_START': {
        const name = asString(data.name) ?? 'unknown';
        const id = asString(data.id);
        // The executor announces a call twice: once while streaming (name
        // only) and once at execution time (name + id). Reconcile the id into
        // the existing block instead of appending a duplicate.
        if (id !== undefined) {
          const existing = this.transcript.findToolIndexById(id);
          if (existing !== null) {
            this.lastToolIndex = existing;
            break;
          }
          const open = this.transcript.findUnboundToolIndex(name);
          if (open !== null) {
            this.transcript.setToolId(open, id);
            this.idToBlock.set(id, open);
            this.lastToolIndex = open;
            break;
          }
        }
        this.transcript.addTool(name, undefined, id);
        const index = this.transcript.getBlocks().length - 1;
        if (id !== undefined) this.idToBlock.set(id, index);
        this.lastToolIndex = index;
        break;
      }

      case 'TOOL_CALL_ARGS': {
        const id = asString(data.id);
        const index = id !== undefined ? this.idToBlock.get(id) ?? null : this.lastToolIndex;
        if (index === null) break;
        const delta = asString(data.delta);
        if (delta !== undefined) {
          this.transcript.appendToolArgs(index, delta);
        } else if (data.input !== undefined) {
          this.transcript.setToolArgs(index, data.input);
        }
        break;
      }

      case 'TOOL_CALL_END':
        break;

      case 'TOOL_CALL_RESULT': {
        const id = asString(data.id);
        const { text, isError } = normalizeToolResult(data);
        let index = id !== undefined ? this.transcript.findToolIndexById(id) : null;
        if (index === null) index = this.transcript.findRunningToolIndex();
        if (index !== null) this.transcript.setToolResultByIndex(index, text, isError);
        break;
      }

      case 'STEP_STARTED': {
        const turn = data.turn;
        if (typeof turn === 'number') this.turns = turn;
        break;
      }

      case 'STEP_FINISHED':
        this.settleUnreportedTools();
        this.transcript.endTurn();
        break;

      case 'RUN_FINISHED': {
        const result = asString(data.result);
        if (result !== undefined) this.result = result;
        this.status = 'completed';
        this.finishedAt = event.timestamp ?? Date.now();
        this.settleUnreportedTools();
        this.transcript.endTurn();
        break;
      }

      case 'RUN_ERROR': {
        const reason = asString(data.reason);
        this.status = reason === 'user_abort' ? 'aborted' : 'failed';
        this.error = asString(data.error) ?? 'Unknown error';
        this.finishedAt = event.timestamp ?? Date.now();
        this.settleUnreportedTools();
        this.transcript.endTurn();
        break;
      }

      // STATE_SNAPSHOT / STATE_DELTA / STEP_* carry task bookkeeping; the
      // activity transcript intentionally mirrors min-agent (no task dump).
      default:
        break;
    }
  }

  /**
   * The executor returns early for rejected/skipped tool calls (unknown tool,
   * readOnly denial, schema failure, permission deny, pre-hook block, serial
   * skip) without emitting TOOL_CALL_RESULT. Settle those at step/run end so
   * the activity page shows an error instead of a forever-running tool.
   */
  private settleUnreportedTools(): void {
    this.transcript.settleRunningTools('error: tool call was rejected or skipped');
  }

  /** Seed from the authoritative record when events predate this recorder. */
  seed(record: ActivitySeedRecord): void {
    if (record.status !== 'running' && this.status === 'running') {
      if (record.status === 'completed' || record.status === 'failed' || record.status === 'aborted') {
        this.status = record.status;
      }
    }
    if (record.error !== undefined) this.error = record.error;
    if (record.result !== undefined) this.result = record.result;
    // A resumed/finished subagent may have no replayed stream; show its final
    // report as the assistant message, exactly where streamed text would go.
    if (record.result && !this.transcript.hasAssistantText() && record.status !== 'running') {
      this.transcript.appendAssistant(record.result);
      this.transcript.endTurn();
    }
  }
}

const NOTIFY_INTERVAL_MS = 16;

/**
 * In-process recorder for every subagent event. Batching notifications at the
 * same 16 ms cadence as the existing Subagent detail screen keeps React from
 * re-rendering once per streamed token.
 */
export class SubagentActivityRecorder {
  private readonly activities = new Map<string, SubagentActivity>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  private readonly onAgUi = (event: AgUiEvent): void => {
    this.ingest(event);
  };

  start(): void {
    if (this.started) return;
    subagentEvents.on('ag-ui', this.onAgUi);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    subagentEvents.off('ag-ui', this.onAgUi);
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  ingest(event: ActivityEvent): void {
    if (!event || typeof event.subagentId !== 'string') return;
    const activity = this.getOrCreate(event.subagentId);
    activity.apply(event);
    this.schedule();
  }

  get(id: string): SubagentActivity | undefined {
    return this.activities.get(id);
  }

  getOrCreate(id: string): SubagentActivity {
    let activity = this.activities.get(id);
    if (!activity) {
      activity = new SubagentActivity();
      this.activities.set(id, activity);
    }
    return activity;
  }

  /** Ensure an activity exists for a record and seed any missed history. */
  ensure(record: ActivitySeedRecord): SubagentActivity {
    const activity = this.getOrCreate(record.id);
    activity.seed(record);
    return activity;
  }

  ids(): string[] {
    return [...this.activities.keys()];
  }

  /** Drop activities whose subagent record no longer exists (the store evicts completed records). */
  retain(ids: Iterable<string>): void {
    const keep = new Set(ids);
    for (const id of this.activities.keys()) {
      if (!keep.has(id)) this.activities.delete(id);
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Test seam: deliver the pending notification immediately. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const listener of this.listeners) listener();
  }

  /** Test seam: drop all activity and detach from the bus. */
  reset(): void {
    this.stop();
    this.activities.clear();
    this.listeners.clear();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const listener of this.listeners) listener();
    }, NOTIFY_INTERVAL_MS);
    this.timer.unref?.();
  }
}

/** Global recorder; the TUI loads this module only when the interactive UI starts. */
export const subagentActivityRecorder = new SubagentActivityRecorder();
subagentActivityRecorder.start();
