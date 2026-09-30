import { readJson, writeJsonAtomic } from './atomic.js';
import {
  readMachineRecord,
  type DispatchRecord,
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
    label: asString(raw.label, 'workflow-agent'),
    status: status === 'completed' || status === 'failed' ? status : 'running',
    attempts: typeof raw.attempts === 'number' && Number.isFinite(raw.attempts) ? raw.attempts : 1,
    startedAt: asString(raw.startedAt, ''),
    ...(typeof raw.endedAt === 'string' ? { endedAt: raw.endedAt } : {}),
    outputTokens: typeof raw.outputTokens === 'number' && Number.isFinite(raw.outputTokens) ? raw.outputTokens : 0,
    ...(raw.error && typeof raw.error === 'object' ? { error: raw.error as DispatchRecord['error'] } : {}),
    ...('result' in raw ? { result: raw.result } : {}),
  };
}

/** additive 兼容：老产物缺的字段在这里补齐，绝不因缺字段拒读。 */
export function normalizeIndex(raw: unknown, readerVersion: number = SCHEMA_VERSION): RunIndex {
  const record = readMachineRecord<RunIndex>(raw, readerVersion, 'index.json');
  const value = record as unknown as Record<string, unknown>;
  const dispatches = Array.isArray(value.dispatches) ? value.dispatches.map(asDispatch).filter((d): d is DispatchRecord => Boolean(d)) : [];
  const tokens = value.tokens && typeof value.tokens === 'object' ? (value.tokens as { spent?: unknown }) : {};
  const sourceRef = value.sourceRef && typeof value.sourceRef === 'object' ? (value.sourceRef as { id?: unknown; revision?: unknown }) : {};
  const status = value.status as WorkflowStatus;
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
    tokens: { spent: typeof tokens.spent === 'number' && Number.isFinite(tokens.spent) ? tokens.spent : 0 },
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
