// ADR-0007 决策 6：完全独立的内存 Map，不碰主 store / ExtensionService
// ADR-0007 决策 7：结果保留到父 AI 拿走 + 1 小时超时兜底
// ADR-0007 决策 39：审计日志结构
// ADR-0032 #34：状态收敛到 SubagentContext，函数追加可选末参 ctx（缺省 defaultContext）

import type { UsageSummary } from './cost-tracker.js';
import { defaultContext } from './context.js';
import type { SubagentContext } from './context.js';
import type { SubagentOrigin } from './runner.js';

// ── 类型（决策 6 + 39）──

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'aborted';

export type SubagentTask = {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  /** D12（ADR-0048 #135）：blocked 时必填的原因（≤1000 字符）——父轮询 tasks 字段可见 */
  blockedReason?: string;
};

export interface ToolAuditLog {
  toolName: string;
  toolUseId: string;
  input: string;          // JSON 序列化后截断到 1000 字符
  startTime: number;
  endTime: number;
  durationMs: number;
  success: boolean;
  errorType?: 'schema_validation' | 'permission_denied' | 'execution_error' | 'timeout';
  errorMessage?: string;  // 截断到 500 字符
  resultSizeChars: number;
}

export interface SubagentRecord {
  id: string;
  sessionId?: string;         // M8 接入 delegate session 后回填
  status: SubagentStatus;
  tasks: SubagentTask[];
  result?: string;            // completed 时的最终摘要
  error?: string;             // failed/aborted 时的原因
  /** ADR-0042 #78（选项 A）：subagent 来源——skill fork 时记录派生 skill，direct start 为 undefined。
   *  仅可选字段，不影响既有序列化（#62 持久化格式纪律）。 */
  origin?: SubagentOrigin;
  /** ADR-0048 D5（#136）：「已验收」标记——父首次调 subagent_status 取终态 result 时置位；
   *  未验收定义 = 子进终态后父从未取到结果（完成闸门据此拦收工）。仅可选字段，不影响既有序列化。 */
  resultFetched?: boolean;
  abortController: AbortController;
  usage: UsageSummary;
  auditLogs: ToolAuditLog[];
  /** ADR-0048 D8（第四轮修订）：转后台命令元数据——句柄在 shell-tracker backgroundTasks 索引，此处只存 backgroundId→pid 供审计/可见性 */
  backgroundTasks?: Array<{ backgroundId: string; pid: number }>;
}

// ── 存储（ADR-0032 #34：状态移入 SubagentContext）──

// 可注入的清理延迟（供测试用）
let cleanupDelayMs = 60 * 60 * 1000; // 1 小时，决策 7

/** 仅测试用——注入清理间隔 */
export function setCleanupDelayMs(ms: number): void {
  cleanupDelayMs = ms;
}

export function getCleanupDelayMs(): number {
  return cleanupDelayMs;
}

// ── CRUD ──

export function createSubagent(
  id: string,
  fields: { subject: string; description?: string; origin?: SubagentOrigin },
  ctx: SubagentContext = defaultContext,
): SubagentRecord {
  const record: SubagentRecord = {
    id,
    status: 'running',
    tasks: [{
      id: `task_${Date.now().toString(36)}`,
      subject: fields.subject,
      description: fields.description ?? '',
      status: 'pending',
    }],
    origin: fields.origin,
    abortController: new AbortController(),
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    auditLogs: [],
  };
  ctx.subagents.set(id, record);
  return record;
}

export function getSubagent(id: string, ctx: SubagentContext = defaultContext): SubagentRecord | undefined {
  return ctx.subagents.get(id);
}

/** D2（ADR-0046 #22）：按 child sessionId 反查 SubagentRecord。
 *  runner.ts:169 已存 `record.sessionId = child.id`，故 child.id → SubagentRecord → usage 单向对应。 */
export function getSubagentBySessionId(sessionId: string, ctx: SubagentContext = defaultContext): SubagentRecord | undefined {
  for (const record of ctx.subagents.values()) {
    if (record.sessionId === sessionId) return record;
  }
  return undefined;
}

export function updateSubagentStatus(
  id: string,
  status: SubagentStatus,
  extra?: { result?: string; error?: string },
  ctx: SubagentContext = defaultContext,
): SubagentRecord | undefined {
  const record = ctx.subagents.get(id);
  if (!record) return undefined;

  record.status = status;
  if (extra?.result !== undefined) record.result = extra.result;
  if (extra?.error !== undefined) record.error = extra.error;

  // 终态时启动清理定时器
  if (status === 'completed' || status === 'failed' || status === 'aborted') {
    // 1 小时兜底清理（决策 7），timer 必须 unref()
    setTimeout(() => {
      ctx.subagents.delete(id);
    }, cleanupDelayMs).unref();
  }

  return record;
}

/** ADR-0048 D5（#136）：置「已验收」标记——父首次取终态 result 时调用（幂等，重复置位无副作用）。
 *  仅内存标记，不参与 1 小时兜底清理与结果保留语义（ADR-0007 决策 7）。 */
export function markResultFetched(id: string, ctx: SubagentContext = defaultContext): void {
  const record = ctx.subagents.get(id);
  if (!record) return;
  record.resultFetched = true;
}

export function addAuditLog(id: string, log: ToolAuditLog, ctx: SubagentContext = defaultContext): void {
  const record = ctx.subagents.get(id);
  if (!record) return;

  // 截断输入到 1000 字符
  if (log.input.length > 1000) {
    log.input = log.input.slice(0, 1000);
  }
  // 截断错误消息到 500 字符
  if (log.errorMessage && log.errorMessage.length > 500) {
    log.errorMessage = log.errorMessage.slice(0, 500);
  }

  record.auditLogs.push(log);

  // 只保留最近 50 条（决策 39）
  if (record.auditLogs.length > 50) {
    record.auditLogs = record.auditLogs.slice(-50);
  }
}

export function countRunning(ctx: SubagentContext = defaultContext): number {
  let count = 0;
  for (const record of ctx.subagents.values()) {
    if (record.status === 'running') count++;
  }
  return count;
}

/** 查询时返回最近 20 条 auditLogs（决策 39） */
export function getRecentAuditLogs(id: string, ctx: SubagentContext = defaultContext): ToolAuditLog[] {
  const record = ctx.subagents.get(id);
  if (!record) return [];
  return record.auditLogs.slice(-20);
}

/** M8：列出所有 subagent（TUI 列表页数据源） */
export function listAllSubagents(ctx: SubagentContext = defaultContext): SubagentRecord[] {
  return [...ctx.subagents.values()];
}

/** 仅供测试——清空 defaultContext 全部状态 */
export function clearAllSubagents(): void {
  defaultContext.subagents.clear();
}

// ── 计费状态更新 ──
// 外部（CostTracker）每轮累积后通过此函数写入 store

export function updateSubagentCost(id: string, usage: UsageSummary, ctx: SubagentContext = defaultContext): void {
  const record = ctx.subagents.get(id);
  if (!record) return;
  record.usage = usage;
}
