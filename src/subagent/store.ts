// ADR-0007 决策 6：完全独立的内存 Map，不碰主 store / ExtensionService
// ADR-0007 决策 7：结果保留到父 AI 拿走 + 1 小时超时兜底
// ADR-0007 决策 39：审计日志结构

import type { UsageSummary } from './cost-tracker.js';

// ── 类型（决策 6 + 39）──

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'aborted';

export type SubagentTask = {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
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
  abortController: AbortController;
  cost: UsageSummary;
  auditLogs: ToolAuditLog[];
  createdAt: number;
  completedAt?: number;
}

// ── 存储 ──

const subagents = new Map<string, SubagentRecord>();

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
  fields: { subject: string; description?: string },
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
    abortController: new AbortController(),
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalUSD: 0 },
    auditLogs: [],
    createdAt: Date.now(),
  };
  subagents.set(id, record);
  return record;
}

export function getSubagent(id: string): SubagentRecord | undefined {
  return subagents.get(id);
}

export function updateSubagentStatus(
  id: string,
  status: SubagentStatus,
  extra?: { result?: string; error?: string },
): SubagentRecord | undefined {
  const record = subagents.get(id);
  if (!record) return undefined;

  record.status = status;
  if (extra?.result !== undefined) record.result = extra.result;
  if (extra?.error !== undefined) record.error = extra.error;

  // 终态时写 completedAt 并启动清理定时器
  if (status === 'completed' || status === 'failed' || status === 'aborted') {
    record.completedAt = Date.now();

    // 1 小时兜底清理（决策 7），timer 必须 unref()
    setTimeout(() => {
      subagents.delete(id);
    }, cleanupDelayMs).unref();
  }

  return record;
}

export function collectSubagentResult(id: string): SubagentRecord | undefined {
  const record = subagents.get(id);
  if (!record) return undefined;
  subagents.delete(id);
  return record;
}

export function getSubagentResult(id: string): SubagentRecord | undefined {
  return subagents.get(id);
}

export function syncTasks(id: string, tasks: SubagentTask[]): void {
  const record = subagents.get(id);
  if (!record) return;
  record.tasks = tasks;
}

export function addAuditLog(id: string, log: ToolAuditLog): void {
  const record = subagents.get(id);
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

export function updateCost(id: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; totalUSD: number }): void {
  const record = subagents.get(id);
  if (!record) return;
  record.cost = { ...usage };
}

export function countRunning(): number {
  let count = 0;
  for (const record of subagents.values()) {
    if (record.status === 'running') count++;
  }
  return count;
}

/** 查询时返回最近 20 条 auditLogs（决策 39） */
export function getRecentAuditLogs(id: string): ToolAuditLog[] {
  const record = subagents.get(id);
  if (!record) return [];
  return record.auditLogs.slice(-20);
}

/** 仅供测试——清空全部状态 */
export function clearAllSubagents(): void {
  subagents.clear();
}

// ── 计费状态更新 ──
// 外部（CostTracker）每轮累积后通过此函数写入 store

export function updateSubagentCost(id: string, usage: UsageSummary): void {
  const record = subagents.get(id);
  if (!record) return;
  record.cost = usage;
}
