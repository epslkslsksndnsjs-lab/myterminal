import { isRunId } from './ids.js';
import { WorkflowStartError } from './engine.js';
import type { MyTerminalStore } from '../store.js';
import type { JsonObject, ToolAuditEvent } from '../types.js';
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
 * 审计缝：模块侧只吐结构化条目，落盘走既有审计通道（签名一字不改）。
 */
export function workflowAuditSink(store: MyTerminalStore, workspaceDir: string): (entry: WorkflowAuditEntry) => void {
  return (entry) => {
    const event: ToolAuditEvent = {
      id: `workflow-${entry.runId}-${entry.action}`,
      timestamp: entry.at,
      source: 'test',
      action: entry.action,
      status: entry.action === 'workflow_settle' ? 'completed' : 'running',
      durationMs: 0,
      workspace: workspaceDir,
      session: entry.actor,
      args: { runId: entry.runId } as JsonObject,
      result: { status: entry.status, ...(entry.reason ? { reason: entry.reason } : {}) } as JsonObject,
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
