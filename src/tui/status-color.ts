/**
 * status-color — 状态→视觉（语义色 token）映射单源（ADR-0031 #54）。
 *
 * 收敛 TUI 各处手写的状态→颜色映射：
 *   - history-entry.ts 的 tool_audit tone（默认 muted）
 *   - ToolCallRow.tsx 的 statusColor（默认 bad）
 *   - Subagent.tsx 详情页 statusColor（默认 warn）
 *   - Home.tsx 审计条目 statusColor（默认 bad，同域第 4 处，随单源收敛）
 *
 * 消除默认态分歧：未知/未预期状态一律归 muted（中性），
 * 不得被误染成错误红（bad）或告警黄（warn）。
 */

export type StatusTone = 'accent' | 'good' | 'warn' | 'bad' | 'muted';

const STATUS_TONE: Record<string, StatusTone> = {
  running: 'accent',
  completed: 'good',
  failed: 'bad',
  timeout: 'bad',
  policy_rejected: 'warn',
  aborted: 'warn',
  aborting: 'warn',
};

export const DEFAULT_STATUS_TONE: StatusTone = 'muted';

/** 状态 → 语义色 token（单源）。未知状态返回 DEFAULT_STATUS_TONE（muted）。 */
export function statusToVisual(status: string): StatusTone {
  return STATUS_TONE[status] ?? DEFAULT_STATUS_TONE;
}
