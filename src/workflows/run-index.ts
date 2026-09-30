import { readJson, writeJsonAtomic } from './atomic.js';
import {
  readMachineRecord,
  type DispatchRecord,
  type FailureEntry,
  type RunIndex,
  type WorkflowStatus,
  SCHEMA_VERSION,
} from './schema.js';

/**
 * run 索引——"盘上有账"的主件：运行态 status 在这里，谁都能读。
 * 一律原子写；读出走版本闸，缺字段按缺省补齐（additive 兼容）。
 */

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asDispatch(value: unknown): DispatchRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const status = raw.status;
  return {
    id: asString(raw.id, ''),
    ...(typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? { seq: raw.seq } : {}),
    ...(typeof raw.key === 'string' ? { key: raw.key } : {}),
    label: asString(raw.label, 'workflow-agent'),
    status: status === 'completed' || status === 'failed' ? status : 'running',
    attempts: typeof raw.attempts === 'number' && Number.isFinite(raw.attempts) ? raw.attempts : 1,
    startedAt: asString(raw.startedAt, ''),
    ...(typeof raw.endedAt === 'string' ? { endedAt: raw.endedAt } : {}),
    outputTokens: typeof raw.outputTokens === 'number' && Number.isFinite(raw.outputTokens) ? raw.outputTokens : 0,
    ...(raw.error && typeof raw.error === 'object' ? { error: raw.error as DispatchRecord['error'] } : {}),
    ...('result' in raw ? { result: raw.result } : {}),
    ...(typeof raw.isolation === 'string' ? { isolation: raw.isolation } : {}),
    ...(typeof raw.phase === 'string' ? { phase: raw.phase } : {}),
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
    ...(typeof raw.effort === 'string' ? { effort: raw.effort } : {}),
    ...(typeof raw.schema === 'boolean' ? { schema: raw.schema } : {}),
  };
}

function asFailure(value: unknown): FailureEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  // 失败清单是给人和汇总体读的报告：空串当没写，退回具名缺省，绝不留一条说不出为什么的账。
  const report = (field: unknown, fallback: string): string =>
    typeof field === 'string' && field.trim() ? field : fallback;
  return {
    ...(typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? { seq: raw.seq } : {}),
    label: report(raw.label, 'workflow-agent'),
    kind: report(raw.kind, 'error'),
    message: report(raw.message, 'dispatch failed'),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

/** additive 兼容：老产物缺的字段在这里补齐，绝不因缺字段拒读。 */
export function normalizeIndex(raw: unknown, readerVersion: number = SCHEMA_VERSION): RunIndex {
  const record = readMachineRecord<RunIndex>(raw, readerVersion, 'index.json');
  const value = record as unknown as Record<string, unknown>;
  const dispatches = Array.isArray(value.dispatches) ? value.dispatches.map(asDispatch).filter((d): d is DispatchRecord => Boolean(d)) : [];
  const failures = Array.isArray(value.failures) ? value.failures.map(asFailure).filter((f): f is FailureEntry => Boolean(f)) : [];
  const tokens = value.tokens && typeof value.tokens === 'object' ? (value.tokens as { spent?: unknown }) : {};
  const sourceRef = value.sourceRef && typeof value.sourceRef === 'object' ? (value.sourceRef as { id?: unknown; revision?: unknown }) : {};
  const status = value.status as WorkflowStatus;
  const scriptError = value.scriptError && typeof value.scriptError === 'object' ? (value.scriptError as { kind?: unknown; message?: unknown }) : undefined;
  return {
    schemaVersion: record.schemaVersion,
    runId: asString(value.runId, ''),
    status: status ?? 'running',
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ownerSessionId: asString(value.ownerSessionId, ''),
    scriptPath: asString(value.scriptPath, ''),
    sourceRef: { id: asString(sourceRef.id, ''), revision: asString(sourceRef.revision, '') },
    argsRecorded: value.argsRecorded === true,
    ...('args' in value ? { args: value.args } : {}),
    startedAt: asString(value.startedAt, ''),
    ...(typeof value.endedAt === 'string' ? { endedAt: value.endedAt } : {}),
    dispatches,
    failures,
    tokens: { spent: typeof tokens.spent === 'number' && Number.isFinite(tokens.spent) ? tokens.spent : 0 },
    ...(scriptError ? { scriptError: { kind: asString(scriptError.kind, 'script-failed'), message: asString(scriptError.message, '') } } : {}),
  };
}

export async function writeIndex(file: string, index: RunIndex): Promise<void> {
  await writeJsonAtomic(file, index);
}

export async function readIndex(file: string, readerVersion: number = SCHEMA_VERSION): Promise<RunIndex | undefined> {
  const raw = await readJson(file);
  if (raw === undefined) return undefined;
  return normalizeIndex(raw, readerVersion);
}
