import path from 'node:path';
import { useState } from 'react';
import type { MyTerminalRuntime, RuntimeLog } from '../../server.js';
import { readWorkspaceLogs, workspaceId } from '../../instances.js';
import type { ToolAuditEvent } from '../../types.js';
import type { Theme } from '../state.js';
import { Heading } from './shared.js';
import { ToolCallRow } from '../components/ToolCallRow.js';
import { useI18n } from '../copy/context.js';

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
      <text fg={theme.muted} wrapMode="none">{timeOf(entry.at)}</text>
      <text fg={statusColor} wrapMode="none"><b>{entry.level === 'error' ? 'ERR ' : entry.level === 'ok' ? 'OK  ' : 'INFO'}</b></text>
      <text fg={theme.tool} wrapMode="none"><b>{entry.operation.padEnd(10)}</b></text>
      {entry.workspace ? <text fg={theme.muted} wrapMode="none">[{entry.workspace}]</text> : null}
      {entry.subject ? <text fg={theme.accent} wrapMode="none">{entry.subject}</text> : null}
      <text fg={theme.text} wrapMode="word" flexGrow={1}>{entry.detail}</text>
      {entry.duration !== undefined ? <text fg={theme.muted} wrapMode="none">{entry.duration}ms</text> : null}
    </box>
  );
}

const PAGE_SIZE = 100;

function formatContext(chars: number): string {
  if (!chars) return 'N/A';
  if (chars < 1000) return String(chars);
  return `${(chars / 1000).toFixed(1)}K`;
}

export function Logs({ runtime, logs, theme, showAudit, page, anchorAt }: { runtime: MyTerminalRuntime; logs: RuntimeLog[]; theme: Theme; showAudit: boolean; page: number; anchorAt?: string }) {
  const { t } = useI18n();
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
    // 分页与 anchorAt 截断由 store 的 audit seam 负责（#62）——屏内不再全量扫描重排。
    for (const fact of runtime.store.auditRecentFactsPage(page, PAGE_SIZE, anchorAt).facts) entries.push({
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

  // 日志页的 ToolCallRow 展开状态（仅鼠标点击切换，不加键盘选中）
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggleAuditExpand(auditId: string, workspaceLabel?: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      const key = `${auditId}-${workspaceLabel || ''}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <box flexDirection="column" width="100%" padding={1} gap={0}>
      <box flexDirection="row" gap={2} flexWrap="wrap" marginBottom={1}>
        <Heading theme={theme}>{t('Local workspace logs', '本机工作区日志')}</Heading>
        <text fg={showAudit ? theme.good : theme.muted}>{showAudit ? (t('audit: ON', '调用审计：开启')) : (t('audit: OFF', '调用审计：关闭'))}</text>
        <text fg={theme.muted}>{t(`Page ${page + 1} · PgUp/PgDn`, `第 ${page + 1} 页 · PgUp/PgDn 翻页`)}</text>
        <text fg={theme.warn}>{t(`Cumulative ctx: ${formatContext(cumulativeContext)}`, `累积模型上下文: ${formatContext(cumulativeContext)}`)}</text>
      </box>
      {visibleEntries.length ? visibleEntries.map((entry, index) => {
        if (entry.audit) {
          const key = `${entry.audit.id}-${entry.workspace || ''}`;
          return (
            <ToolCallRow
              key={key}
              audit={{
                timestamp: entry.audit.timestamp,
                source: entry.audit.source,
                action: entry.audit.action,
                status: entry.audit.status,
                durationMs: entry.audit.durationMs,
                error: entry.audit.error,
                args: entry.audit.args,
                result: entry.audit.result,
                sessionName: entry.subject,
              }}
              workspace={entry.workspace}
              theme={theme}
              expanded={expanded.has(key)}
              onToggle={() => toggleAuditExpand(entry.audit!.id, entry.workspace)}
            />
          );
        }
        return (
          <RuntimeRow key={`${entry.at}-${entry.kind}-${index}`} entry={entry} theme={theme} />
        );
      })
      : <text fg={theme.muted}>{t('No log entries.', '暂无日志。')}</text>}
    </box>
  );
}
