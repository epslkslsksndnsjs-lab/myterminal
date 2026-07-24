import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type UpdateRestoreResult = {
  restored: string[];
  skipped: string[];
  failed: Array<{ file: string; error: string }>;
  credentialsPreserved: boolean;
};

export type UpdateAuditRecord = {
  id: string;
  timestamp: string;
  event: 'start' | 'stage' | 'complete';
  status: 'started' | 'succeeded' | 'failed';
  stage: 'start' | 'snapshot' | 'install' | 'migration' | 'restart' | 'rollback' | 'recovery' | 'complete';
  oldVersion: string;
  newVersion: string;
  pid: number;
  restartReason: string;
  migrationResult: string;
  rollbackResult: string;
  recoveryResult: string;
  error?: { code: string; message: string };
};

export type UpdateTransactionOptions<TSnapshot> = {
  historyRoot: string;
  oldVersion: string;
  newVersion: string;
  pid?: number;
  restartReason?: string;
  snapshot: () => TSnapshot;
  install: () => Promise<void>;
  migrate?: () => Promise<void>;
  restart?: () => Promise<void>;
  restore: (snapshot: TSnapshot, force: boolean) => UpdateRestoreResult;
  runtimeLog?: (message: string, level?: 'info' | 'error') => void;
};

export class UpdateTransactionError extends Error {
  constructor(message: string, readonly audit: UpdateAuditRecord, readonly cause?: unknown) {
    super(message);
    this.name = 'UpdateTransactionError';
  }
}

const HISTORY_FILE = 'update-history.jsonl';

export function appendUpdateHistory(root: string, record: UpdateAuditRecord): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  appendFileSync(path.join(root, HISTORY_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function readUpdateHistory(root: string, limit = 200): UpdateAuditRecord[] {
  const file = path.join(root, HISTORY_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as UpdateAuditRecord]; } catch { return []; }
  }).slice(-Math.max(1, Math.min(5000, limit)));
}

function stageCode(stage: UpdateAuditRecord['stage'], error: unknown): string {
  const detail = error as NodeJS.ErrnoException;
  return `UPDATE_${stage.toUpperCase()}_${detail?.code || 'FAILED'}`;
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?(?:token|authorization|credential|claimCode|connectorKey|secret|password|api[_-]?key)["']?\s*[:=]\s*)(["']?)[^\s,}\]]+/gi, '$1$2[REDACTED]')
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 1000);
}

export async function executeUpdateTransaction<TSnapshot>(options: UpdateTransactionOptions<TSnapshot>): Promise<UpdateAuditRecord> {
  const id = `upd_${randomUUID()}`;
  const pid = options.pid ?? process.pid;
  const restartReason = options.restartReason || 'user_requested_update';
  let migrationResult = options.migrate ? 'pending' : 'not_required';
  let rollbackResult = 'not_needed';
  let recoveryResult = 'pending';
  let snapshot: TSnapshot | undefined;
  let stage: UpdateAuditRecord['stage'] = 'snapshot';

  const makeRecord = (
    event: UpdateAuditRecord['event'],
    status: UpdateAuditRecord['status'],
    currentStage: UpdateAuditRecord['stage'],
    error?: UpdateAuditRecord['error'],
  ): UpdateAuditRecord => ({
    id,
    timestamp: new Date().toISOString(),
    event,
    status,
    stage: currentStage,
    oldVersion: options.oldVersion,
    newVersion: options.newVersion,
    pid,
    restartReason,
    migrationResult,
    rollbackResult,
    recoveryResult,
    error,
  });

  const emit = (record: UpdateAuditRecord): void => {
    appendUpdateHistory(options.historyRoot, record);
    const failure = record.error ? ` · ${record.error.code}: ${record.error.message}` : '';
    options.runtimeLog?.(
      `Update ${record.stage} ${record.status}: ${record.oldVersion} -> ${record.newVersion} · pid ${record.pid}${failure}`,
      record.status === 'failed' ? 'error' : 'info',
    );
  };

  emit(makeRecord('start', 'started', 'start'));
  try {
    snapshot = options.snapshot();
    emit(makeRecord('stage', 'succeeded', 'snapshot'));

    stage = 'install';
    await options.install();
    emit(makeRecord('stage', 'succeeded', 'install'));

    if (options.migrate) {
      stage = 'migration';
      await options.migrate();
      migrationResult = 'succeeded';
      emit(makeRecord('stage', 'succeeded', 'migration'));
    }

    if (options.restart) {
      stage = 'restart';
      await options.restart();
      emit(makeRecord('stage', 'succeeded', 'restart'));
    }

    stage = 'recovery';
    const recovery = options.restore(snapshot, false);
    recoveryResult = recovery.failed.length
      ? 'partial_failure'
      : recovery.credentialsPreserved ? 'succeeded' : 'credential_validation_failed';
    if (recovery.failed.length || !recovery.credentialsPreserved) {
      throw new Error(`Recovery validation failed for ${recovery.failed.length} file(s).`);
    }
    emit(makeRecord('stage', 'succeeded', 'recovery'));

    const complete = makeRecord('complete', 'succeeded', 'complete');
    emit(complete);
    return complete;
  } catch (error) {
    const failure = { code: stageCode(stage, error), message: safeErrorMessage(error) };
    emit(makeRecord('stage', 'failed', stage, failure));

    if (snapshot !== undefined) {
      try {
        const rollback = options.restore(snapshot, true);
        rollbackResult = rollback.failed.length ? 'partial_failure' : 'succeeded';
        recoveryResult = rollback.failed.length
          ? 'failed'
          : rollback.credentialsPreserved ? 'succeeded' : 'credential_validation_failed';
        const rollbackError = rollback.failed.length || !rollback.credentialsPreserved
          ? { code: 'UPDATE_ROLLBACK_PARTIAL', message: `${rollback.failed.length} file(s) failed rollback; credentialsPreserved=${rollback.credentialsPreserved}.` }
          : undefined;
        emit(makeRecord('stage', rollbackError ? 'failed' : 'succeeded', 'rollback', rollbackError));
      } catch (rollbackError) {
        rollbackResult = 'failed';
        recoveryResult = 'failed';
        emit(makeRecord('stage', 'failed', 'rollback', {
          code: 'UPDATE_ROLLBACK_FAILED',
          message: safeErrorMessage(rollbackError),
        }));
      }
    } else {
      rollbackResult = 'unavailable';
      recoveryResult = 'unavailable';
    }

    const complete = makeRecord('complete', 'failed', 'complete', failure);
    emit(complete);
    throw new UpdateTransactionError(`Update failed during ${stage}: ${failure.message}`, complete, error);
  }
}
