/**
 * ToolCallRow — Claude Code 风格工具调用行（ADR-0004 A.2）。
 * 状态行常显 + args/result 默认折叠一行预览，Enter/点击展开。
 * expanded 由父级托管，组件不持有内部 state。
 */
import type { Theme } from '../theme/index.js';
import type { ToolAuditEvent } from '../../types.js';
import { statusToVisual } from '../status-color.js';

function timeOf(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleTimeString([], { hour12: false });
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return '—';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

export function ToolCallRow({
  audit,
  workspace,
  theme,
  zh,
  expanded,
  onToggle,
  selected = false,
}: {
  audit: Pick<ToolAuditEvent, 'timestamp' | 'source' | 'action' | 'status' | 'durationMs' | 'error' | 'args' | 'result'> & { sessionName?: string };
  workspace?: string;
  theme: Theme;
  zh: boolean;
  expanded: boolean;
  onToggle: () => void;
  selected?: boolean;
}) {
  const statusColor = theme[statusToVisual(audit.status)];

  let statusText: string;
  if (audit.status === 'running') statusText = '● running';
  else if (audit.status === 'completed') statusText = `✓ ${audit.durationMs ?? ''}ms`;
  else if (audit.status === 'policy_rejected') statusText = '⊙ policy';
  else if (audit.status === 'timeout') statusText = '✗ timeout';
  else statusText = `✗${audit.error?.code ? ` ${audit.error.code}` : ''}`;

  const sourceAction = `${audit.source.toUpperCase()}/${audit.action}`;
  const expandIndicator = expanded ? '▾' : '▸';
  const bg = selected ? theme.selected : undefined;

  return (
    <box flexDirection="column" width="100%" backgroundColor={bg} onMouseDown={onToggle}>
      {/* 状态行 — 常显一行，wrapMode="none" 防布局跳动 */}
      <box flexDirection="row" gap={1} width="100%">
        <text fg={theme.tool} wrapMode="none">⏺</text>
        <text fg={theme.muted} wrapMode="none">{timeOf(audit.timestamp)}</text>
        <text fg={statusColor} wrapMode="none"><b>{statusText}</b></text>
        <text fg={theme.text} flexGrow={1} wrapMode="none"><b>{sourceAction}</b></text>
        {audit.sessionName ? <text fg={theme.agent} wrapMode="none">{audit.sessionName}</text> : null}
        {workspace ? <text fg={theme.muted} wrapMode="none">[{workspace}]</text> : null}
        <box flexGrow={1} />
        {audit.status === 'failed' && audit.error?.code ? <text fg={theme.bad} wrapMode="none">{audit.error.code}</text> : null}
        <text fg={theme.muted} wrapMode="none">{expandIndicator}</text>
      </box>
      {/* 折叠区 — expanded 时才渲染（惰性 stringify） */}
      {expanded ? (
        <box flexDirection="column" paddingLeft={3} width="100%">
          <box flexDirection="row" gap={1} width="100%">
            <text fg={theme.muted} wrapMode="none">{zh ? '参数' : 'ARGS'}</text>
            <text fg={theme.text} wrapMode="word" flexGrow={1}>{clip(safeJson(audit.args), 200)}</text>
          </box>
          <box flexDirection="row" gap={1} width="100%">
            <text fg={theme.muted} wrapMode="none">{zh ? '返回' : 'RESULT'}</text>
            <text
              fg={audit.status === 'failed' || audit.status === 'timeout' ? theme.bad : audit.status === 'policy_rejected' ? theme.warn : theme.text}
              wrapMode="word"
              flexGrow={1}
            >{clip(safeJson(audit.result), 200)}</text>
          </box>
        </box>
      ) : null}
    </box>
  );
}
