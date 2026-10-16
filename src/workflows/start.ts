import { isRunId, RUN_ID_PATTERN } from './ids.js';
import { WorkflowStartError, type WorkflowEngine } from './engine.js';
import type { MyTerminalStore } from '../store.js';
import type { JsonObject, ToolAuditEvent, ToolAuditStatus } from '../types.js';
import type { WorkflowAuditEntry } from './engine.js';

/**
 * 启动面：参数互斥与形状闸门。
 *
 * 三种互斥形态：script（内联）｜scriptPath｜scriptPath + resumeFromRunId（唯一合法组合）。
 * 互斥关系刻意不在 schema 里表达——"恰选一"是运行期语义，schema 只管形状。
 */

export type StartArgs = {
  script?: unknown;
  scriptPath?: unknown;
  resumeFromRunId?: unknown;
  args?: unknown;
};

export type StartForm = 'inline' | 'script-path' | 'resume';

export type StartValidation =
  | { ok: true; form: StartForm }
  | { ok: false; code: 'VALIDATION' | 'NOT_FOUND' | 'FORBIDDEN'; reason: string; message: string };

function present(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}

export function validateStartArgs(input: StartArgs): StartValidation {
  const hasScript = present(input.script);
  const hasPath = present(input.scriptPath);
  const hasResume = present(input.resumeFromRunId);

  if (!hasScript && !hasPath && !hasResume) {
    return { ok: false, code: 'VALIDATION', reason: 'source-missing', message: 'workflow_start requires exactly one of script, scriptPath, or scriptPath + resumeFromRunId.' };
  }
  // 互斥先判：两个来源同时出现时，先说"只能选一个"，再说"resume 还缺 scriptPath"。
  if (hasScript && hasPath) {
    return { ok: false, code: 'VALIDATION', reason: 'script-and-script-path', message: 'script and scriptPath are mutually exclusive.' };
  }
  if (hasScript && hasResume) {
    return { ok: false, code: 'VALIDATION', reason: 'script-and-resume', message: 'script and resumeFromRunId are mutually exclusive.' };
  }
  if (hasResume && !hasPath) {
    return { ok: false, code: 'VALIDATION', reason: 'resume-requires-script-path', message: 'resumeFromRunId requires scriptPath: resuming a run must name the script on disk.' };
  }
  if (hasScript && typeof input.script !== 'string') {
    return { ok: false, code: 'VALIDATION', reason: 'script-not-string', message: 'script must be a string.' };
  }
  if (hasPath && typeof input.scriptPath !== 'string') {
    return { ok: false, code: 'VALIDATION', reason: 'script-path-not-string', message: 'scriptPath must be a string.' };
  }
  if (hasResume && !isRunId(input.resumeFromRunId)) {
    return { ok: false, code: 'VALIDATION', reason: 'run-id-shape', message: `resumeFromRunId must match wf_<hex>; received: ${String(input.resumeFromRunId)}.` };
  }
  if (input.args !== undefined && (typeof input.args !== 'object' || input.args === null || Array.isArray(input.args))) {
    return { ok: false, code: 'VALIDATION', reason: 'args-not-object', message: 'args must be an object when provided.' };
  }
  return { ok: true, form: hasResume ? 'resume' : hasScript ? 'inline' : 'script-path' };
}

/**
 * reduce 校验（ADR-0052 §8 I9）：工具层在起 subagent 之前跑完，schema + 归属 + 旋钮三闸。
 *
 * 三条判据：
 *   1. 形状不对 / 带了根本不存在的旋钮 / 想用 timeoutSec 覆盖推导值 = VALIDATION；
 *   2. runId 合形态但盘上没这条 run = NOT_FOUND；
 *   3. run 在、但不是本 root 名下（含延续链）= FORBIDDEN——归属判据是 §3④ 的 ownerSessionId。
 */
export type ReduceCheck =
  | { present: false }
  | { present: true; ok: true; runId: string; paths: { index: string; terminal: string; digest: string } }
  | { present: true; ok: false; code: 'VALIDATION' | 'NOT_FOUND' | 'FORBIDDEN'; reason: string; message: string };

export async function validateReduce(
  engine: WorkflowEngine,
  input: { reduce?: unknown; timeoutSec?: unknown },
  ownerCandidates: readonly string[],
): Promise<ReduceCheck> {
  if (input.reduce === undefined) return { present: false };
  const reduce = input.reduce;
  if (!reduce || typeof reduce !== 'object' || Array.isArray(reduce)) {
    return { present: true, ok: false, code: 'VALIDATION', reason: 'reduce-shape', message: 'reduce must be an object shaped { runId }.' };
  }
  const record = reduce as Record<string, unknown>;
  const knobs = Object.keys(record).filter((key) => key !== 'runId');
  if (knobs.length > 0) {
    return { present: true, ok: false, code: 'VALIDATION', reason: 'reduce-knobs', message: `reduce carries knobs that do not exist (${knobs.join(', ')}): the waiting budget comes from local settings, not from the model面.` };
  }
  if (!isRunId(record.runId)) {
    return { present: true, ok: false, code: 'VALIDATION', reason: 'run-id-shape', message: `reduce.runId must match ${RUN_ID_PATTERN.source}; received: ${String(record.runId)}.` };
  }
  if (input.timeoutSec !== undefined) {
    return { present: true, ok: false, code: 'VALIDATION', reason: 'reduce-timeout-not-settable', message: 'A reducer derives its own timeoutSec from the waiting budget; pass no timeoutSec together with reduce.' };
  }
  const runId = record.runId;
  const run = await engine.lookupRun(runId);
  if (!run) return { present: true, ok: false, code: 'NOT_FOUND', reason: 'run-not-found', message: `Workflow run not found: ${runId}.` };
  if (!ownerCandidates.includes(run.ownerSessionId)) {
    return { present: true, ok: false, code: 'FORBIDDEN', reason: 'run-not-owned', message: `Workflow run ${runId} belongs to another session.` };
  }
  return { present: true, ok: true, runId, paths: { index: run.indexPath, terminal: run.terminalPath, digest: run.digestPath } };
}

/**
 * 审计缝：模块侧只吐结构化条目，落盘走既有审计通道（签名一字不改）。
 *
 * 两条纪律：
 *   1. 幂等键必须带原因——审计链按 id 合并，同一 run 的"正常结算"与"结算期终止"
 *      若共用一个 id，后写的那条会把前一条的终态证据直接盖掉；
 *   2. status 照条目本身映射，不许把 settle 一律写成 completed（失败与终止都得看得出来）。
 */
const AUDIT_STATUS: Record<string, ToolAuditStatus> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
};

export function workflowAuditSink(store: MyTerminalStore, workspaceDir: string): (entry: WorkflowAuditEntry) => void {
  return (entry) => {
    const event: ToolAuditEvent = {
      id: entry.reason ? `workflow-${entry.runId}-${entry.action}-${entry.reason}` : `workflow-${entry.runId}-${entry.action}`,
      timestamp: entry.at,
      source: 'test',
      action: entry.action,
      status: AUDIT_STATUS[entry.status] ?? 'failed',
      // 失败与终止都带上具名错误码（审计链的 errorCode 取自这里），
      // 否则整条链只会剩下一个 UNKNOWN_ERROR，认不出是哪一闸收的场。
      ...(AUDIT_STATUS[entry.status] === 'completed' || entry.status === 'running'
        ? {}
        : { error: { code: entry.reason ?? 'settle-failed', ...(entry.detail ? { message: entry.detail } : {}) } }),
      durationMs: 0,
      workspace: workspaceDir,
      session: entry.actor,
      args: { runId: entry.runId } as JsonObject,
      result: {
        status: entry.status,
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
      } as JsonObject,
    };
    try {
      store.auditEvent(entry.actor, event);
    } catch {
      // 审计失败绝不阻断 run：盘面与终态标记已经落定。
    }
  };
}

/** 启动错误 → 既有错误码（仓库无 VALIDATION，按票面用 EXTENSION_ERROR 承载并附 reason）。 */
export function mapStartError(error: unknown): { code: string; message: string; details?: JsonObject } | undefined {
  if (!(error instanceof WorkflowStartError)) return undefined;
  return {
    code: error.code === 'VALIDATION' ? 'EXTENSION_ERROR' : error.code,
    message: error.message,
    details: { reason: error.reason } as JsonObject,
  };
}
