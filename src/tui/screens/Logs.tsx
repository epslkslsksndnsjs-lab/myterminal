import path from 'node:path';
import type { MyTerminalRuntime, RuntimeLog } from '../../server.js';
import { readWorkspaceLogs, workspaceId } from '../../instances.js';
import type { ToolAuditEvent } from '../../types.js';
import type { Theme } from '../state.js';
import { Heading } from './shared.js';

type DisplayEntry = {
  at: string;
  kind: 'runtime' | 'audit';
  level: 'info' | 'error' | 'ok';
  operation: string;
  subject?: string;
  workspace?: string;
  detail: string;
  duration?: number;
  audit?: ToolAuditEvent;
};

function timeOf(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleTimeString([], { hour12: false });
}

function runtimeOperation(message: string): string {
  if (/control channel/i.test(message)) return 'CONTROL';
  if (/listening/i.test(message)) return 'SERVER';
  if (/settings|configured|restored/i.test(message)) return 'CONFIG';
  if (/session/i.test(message)) return 'SESSION';
  if (/extension/i.test(message)) return 'EXTENSION';
  if (/clipboard|handoff/i.test(message)) return 'HANDOFF';
  return 'RUNTIME';
}

function RuntimeRow({ entry, theme }: { entry: DisplayEntry; theme: Theme }) {
  const statusColor = entry.level === 'error' ? theme.bad : entry.level === 'ok' ? theme.good : theme.accent;
  return (
    <box flexDirection="row" gap={1} width="100%">
      <text fg={theme.muted}>{timeOf(entry.at)}</text>
      <text fg={statusColor}><b>{entry.level === 'error' ? 'ERR ' : entry.level === 'ok' ? 'OK  ' : 'INFO'}</b></text>
      <text fg={theme.warn}><b>{entry.operation.padEnd(10)}</b></text>
      {entry.workspace ? <text fg={theme.muted}>[{entry.workspace}]</text> : null}
      {entry.subject ? <text fg={theme.accent}>{entry.subject}</text> : null}
      <text fg={theme.text} wrapMode="word" flexGrow={1}>{entry.detail}</text>
      {entry.duration !== undefined ? <text fg={theme.muted}>{entry.duration}ms</text> : null}
    </box>
  );
}

function json(value: unknown): string {
  if (value === undefined) return '—';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function AuditRow({ entry, theme, zh }: { entry: DisplayEntry; theme: Theme; zh: boolean }) {
  const audit = entry.audit!;
  const statusColor = audit.status === 'completed' ? theme.good : audit.status === 'running' ? theme.accent : audit.status === 'policy_rejected' ? theme.warn : theme.bad;
  return (
    <box flexDirection="column" width="100%" marginBottom={1}>
      <box flexDirection="row" gap={1} width="100%" flexWrap="wrap">
        <text fg={theme.muted}>{timeOf(audit.timestamp)}</text>
        <text fg={statusColor}><b>{(audit.status === 'policy_rejected' ? 'POLICY' : audit.status.toUpperCase()).padEnd(9)}</b></text>
        <text fg={theme.warn}><b>{audit.source.toUpperCase()}</b></text>
        {entry.workspace ? <text fg={theme.muted}>[{entry.workspace}]</text> : null}
        <text fg={theme.text}><b>{audit.action}</b></text>
        {entry.subject ? <text fg={theme.accent}>{entry.subject}</text> : null}
        {audit.status !== 'running' ? <text fg={theme.muted}>{audit.durationMs}ms</text> : null}
        {audit.error?.code ? <text fg={theme.bad}>{audit.error.code}</text> : null}
      </box>
      <box flexDirection="row" gap={1} paddingLeft={2} width="100%">
        <text fg={theme.muted}>{zh ? '参数' : 'ARGS'}</text>
        <text fg={theme.text} wrapMode="word" flexGrow={1}>{json(audit.args)}</text>
      </box>
      <box flexDirection="row" gap={1} paddingLeft={2} width="100%">
        <text fg={theme.muted}>{zh ? '返回' : 'RESULT'}</text>
        <text fg={audit.status === 'failed' || audit.status === 'timeout' ? theme.bad : audit.status === 'policy_rejected' ? theme.warn : theme.text} wrapMode="word" flexGrow={1}>{json(audit.result)}</text>
      </box>
    </box>
  );
}

const PAGE_SIZE = 100;

function formatContext(chars: number): string {
  if (!chars) return 'N/A';
  if (chars < 1000) return String(chars);
  return `${(chars / 1000).toFixed(1)}K`;
}

export function Logs({ runtime, logs, theme, zh, showAudit, page, anchorAt }: { runtime: MyTerminalRuntime; logs: RuntimeLog[]; theme: Theme; zh: boolean; showAudit: boolean; page: number; anchorAt?: string }) {
  const activeSession = runtime.store.listSessions().find((s) => s.presence === 'claimed' && !['completed', 'cancelled'].includes(s.phase));
  const cumulativeContext = runtime.store.cumulativeContextChars(activeSession?.id);
  const anchoredLogs = anchorAt ? logs.filter((entry) => entry.at <= anchorAt) : logs;
  const localEnd = Math.max(0, anchoredLogs.length - page * PAGE_SIZE);
  const localStart = Math.max(0, localEnd - PAGE_SIZE);
  const entries: DisplayEntry[] = anchoredLogs.slice(localStart, localEnd).filter((entry) => !entry.audit).map((entry) => ({
    at: entry.at,
    kind: 'runtime',
    level: entry.level,
    operation: runtimeOperation(entry.message),
    detail: entry.message,
  }));
  const currentWorkspaceId = workspaceId(runtime.config.workspaceDir);
  const remoteAudits = new Map<string, { audit: ToolAuditEvent; workspace: string }>();
  try {
    for (const group of readWorkspaceLogs(path.dirname(runtime.config.settingsPath), PAGE_SIZE, page * PAGE_SIZE, anchorAt)) {
      if (group.workspace.id === currentWorkspaceId) continue;
      if (group.workspace.lastHost !== runtime.config.host || group.workspace.lastPort !== runtime.config.port) continue;
      const label = group.workspace.label || path.basename(group.workspace.workspaceDir) || group.workspace.id;
      for (const raw of group.entries) {
        const entry = raw as RuntimeLog;
        if (!entry?.at || !entry?.message) continue;
        if (entry.audit?.id) {
          remoteAudits.set(`${group.workspace.id}:${entry.audit.id}`, { audit: entry.audit, workspace: label });
          continue;
        }
        entries.push({ at: entry.at, kind: 'runtime', level: entry.level || 'info', operation: runtimeOperation(entry.message), workspace: label, detail: entry.message });
      }
    }
  } catch { /* cross-workspace logs are best effort */ }
  if (showAudit) {
    const audit = runtime.store.auditFacts(5000).filter((fact) => !anchorAt || fact.at <= anchorAt);
    const auditEnd = Math.max(0, audit.length - page * PAGE_SIZE);
    const auditStart = Math.max(0, auditEnd - PAGE_SIZE);
    for (const fact of audit.slice(auditStart, auditEnd)) entries.push({
      at: fact.at,
      kind: 'audit',
      level: fact.status === 'running' ? 'info' : fact.status === 'completed' ? 'ok' : 'error',
      operation: fact.action,
      subject: fact.sessionName,
      workspace: fact.workspace ? path.basename(fact.workspace) : undefined,
      detail: '',
      duration: fact.status === 'running' ? undefined : fact.durationMs,
      audit: fact,
    });
    for (const { audit: remote, workspace } of remoteAudits.values()) entries.push({
      at: remote.timestamp,
      kind: 'audit',
      level: remote.status === 'running' ? 'info' : remote.status === 'completed' ? 'ok' : 'error',
      operation: remote.action,
      subject: remote.session,
      workspace,
      detail: '',
      duration: remote.status === 'running' ? undefined : remote.durationMs,
      audit: remote,
    });
  }
  entries.sort((a, b) => b.at.localeCompare(a.at));
  const visibleEntries = entries.slice(0, PAGE_SIZE);
  return (
    <box flexDirection="column" width="100%" padding={1} gap={0}>
      <box flexDirection="row" gap={2} flexWrap="wrap" marginBottom={1}>
        <Heading theme={theme}>{zh ? '本机工作区日志' : 'Local workspace logs'}</Heading>
        <text fg={showAudit ? theme.good : theme.muted}>{showAudit ? (zh ? '调用审计：开启' : 'audit: ON') : (zh ? '调用审计：关闭' : 'audit: OFF')}</text>
        <text fg={theme.muted}>{zh ? `第 ${page + 1} 页 · PgUp/PgDn 翻页` : `Page ${page + 1} · PgUp/PgDn`}</text>
        <text fg={theme.warn}>{zh ? `累积模型上下文: ${formatContext(cumulativeContext)}` : `Cumulative ctx: ${formatContext(cumulativeContext)}`}</text>
      </box>
      <box flexDirection="row" gap={1} marginBottom={1}>
        <text fg={theme.muted}>{zh ? '时间' : 'TIME'}</text>
        <text fg={theme.muted}>{zh ? '状态' : 'STAT'}</text>
        <text fg={theme.muted}>{zh ? '操作 / 会话 / 内容' : 'OPERATION / SESSION / DETAIL'}</text>
      </box>
      {visibleEntries.length ? visibleEntries.map((entry, index) => entry.audit
        ? <AuditRow key={`${entry.audit.id}-${entry.workspace || ''}`} entry={entry} theme={theme} zh={zh} />
        : <RuntimeRow key={`${entry.at}-${entry.kind}-${index}`} entry={entry} theme={theme} />)
        : <text fg={theme.muted}>{zh ? '暂无日志。' : 'No log entries.'}</text>}
    </box>
  );
}
