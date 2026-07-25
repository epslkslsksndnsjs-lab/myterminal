/**
 * Home — 主屏概览页（ADR-0004 决策 2/7）。
 * 吉祥物问候 + 会话摘要 + 动态时间线精选。M3 交付。
 */
import type { MyTerminalRuntime } from '../../server.js';
import type { MyTerminalSession, StoredState } from '../../types.js';
import type { TuiSnapshot, Theme } from '../state.js';
import { phaseColor, presenceColor } from '../state.js';
import { logicalSessionGroups } from '../../tui-model.js';
import type { Copy } from '../copy/index.js';
import { greetingFor } from '../copy/index.js';
import { Mascot } from '../components/Mascot.js';
import { BlinkingDot } from '../components/BlinkingDot.js';
import { useMascotMood } from '../hooks/useMascotMood.js';
import { useTimelineModel } from '../hooks/useTimelineModel.js';
import type { ActivityEntry } from '../model/timeline-merge.js';
import { relativeTime } from '../model/relative-time.js';

function timeOf(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleTimeString([], { hour12: false });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

export function Home({ runtime, state, snapshot, theme, zh, copy }: {
  runtime: MyTerminalRuntime;
  state: StoredState;
  snapshot: TuiSnapshot;
  theme: Theme;
  zh: boolean;
  copy: Copy;
}) {
  const mood = useMascotMood(snapshot);
  const sessions = state.sessions;
  const active = sessions.filter((s) => !['completed', 'cancelled'].includes(s.phase) && s.presence === 'claimed').length;
  const pending = sessions.filter((s) => !['completed', 'cancelled'].includes(s.phase) && s.presence !== 'claimed').length;
  const groups = logicalSessionGroups(sessions);
  const entries = useTimelineModel(snapshot, 7);

  // 用于消息条目中 session id → 名称映射
  const sessionNames = new Map<string, string>();
  for (const s of sessions) sessionNames.set(s.id, s.name);
  const fromToName = (id: string): string => {
    if (id === 'user') return zh ? '你' : 'You';
    return sessionNames.get(id) || id;
  };

  return (
    <box flexDirection="column" width="100%" padding={1} gap={0}>
      {/* 问候区 */}
      <box flexDirection="row" gap={2} alignItems="center" marginBottom={1}>
        <Mascot mood={mood} theme={theme} />
        <box flexDirection="column">
          <text fg={theme.text}><b>{greetingFor(copy)}</b></text>
          <text fg={theme.muted}>{copy.homeSummary(active, pending)}</text>
        </box>
      </box>

      <text> </text>

      {/* 会话区 */}
      <box flexDirection="row" gap={2} marginBottom={1}>
        <text fg={theme.accent}><b>{zh ? '会话' : 'Sessions'}</b></text>
        <text fg={theme.muted}>{zh ? `${active} active · 按 2 看全部` : `${active} active · press 2 for all`}</text>
      </box>
      {groups.length === 0 ? (
        <text fg={theme.muted}>{copy.emptyStates.sessions}</text>
      ) : (
        groups.slice(0, 3).map((group) => (
          <SessionGroupRow key={group.id} group={group} theme={theme} zh={zh} now={new Date()} copy={copy} />
        ))
      )}

      <text> </text>

      {/* 动态区 */}
      <box flexDirection="row" gap={2} marginBottom={1}>
        <text fg={theme.accent}><b>{zh ? '动态' : 'Activity'}</b></text>
        <text fg={theme.muted}>{zh ? '按 4 看时间线 · 按 8 看日志' : 'press 4 for timeline · press 8 for logs'}</text>
      </box>
      {entries.length === 0 ? (
        <text fg={theme.muted}>{copy.emptyStates.timeline}</text>
      ) : (
        entries.map((entry, idx) => (
          <ActivityRow key={`${entry.kind}-${entry.at}-${idx}`} entry={entry} theme={theme} zh={zh} fromToName={fromToName} />
        ))
      )}

      <text> </text>
      <text fg={theme.muted}>{zh ? 'i 输入消息或 / 命令' : 'i to type a message or / command'}</text>
    </box>
  );
}

/** 单个逻辑会话组行（含 children 树形缩进） */
function SessionGroupRow({ group, theme, zh, now, copy }: {
  group: ReturnType<typeof logicalSessionGroups>[number];
  theme: Theme;
  zh: boolean;
  now: Date;
  copy: Copy;
}) {
  const current = group.current;
  const summary = current.latestCheckpoint?.summary || current.finalSummary || (zh ? '暂无 checkpoint 摘要' : 'No checkpoint summary');
  const children = group.children;
  const groupName = group.title;

  return (
    <box flexDirection="column" marginBottom={1}>
      <box flexDirection="row" gap={1} width="100%">
        <BlinkingDot active={current.presence === 'claimed'} theme={theme} />
        <text fg={theme.text}><b>{groupName} · {current.role}</b></text>
        <box flexGrow={1} />
        <text fg={phaseColor(theme, current.phase)} wrapMode="none">● {current.phase}</text>
      </box>
      <box flexDirection="row" gap={1} paddingLeft={2} width="100%">
        <text fg={theme.muted} wrapMode="none">⎿</text>
        <text fg={theme.muted} flexGrow={1} wrapMode="word">{truncate(summary, 80)}</text>
        <text fg={theme.muted} wrapMode="none">{relativeTime(current.updatedAt, now, zh)}</text>
      </box>
      {children.map((child, idx) => {
        const isLast = idx === children.length - 1;
        const prefix = isLast ? '└─' : '├─';
        return (
          <box key={child.id} flexDirection="row" gap={1} paddingLeft={3} width="100%">
            <text fg={theme.muted} wrapMode="none">{prefix}</text>
            <text fg={theme.text}>{child.name}</text>
            <box flexGrow={1} />
            <text fg={phaseColor(theme, child.phase)} wrapMode="none">●</text>
            <text fg={presenceColor(theme, child)} wrapMode="none">○</text>
          </box>
        );
      })}
    </box>
  );
}

/** 动态区单条条目（audit 或 message） */
function ActivityRow({ entry, theme, zh, fromToName }: {
  entry: ActivityEntry;
  theme: Theme;
  zh: boolean;
  fromToName: (id: string) => string;
}) {
  if (entry.kind === 'audit') {
    const markerColor = theme.tool;
    const source = entry.source.toUpperCase();
    let statusText: string;
    let statusColor: string;
    if (entry.status === 'running') {
      statusText = '● running';
      statusColor = theme.accent;
    } else if (entry.status === 'completed') {
      statusText = `✓ ${entry.durationMs ?? ''}ms`;
      statusColor = theme.good;
    } else if (entry.status === 'policy_rejected') {
      statusText = '⊙ policy';
      statusColor = theme.warn;
    } else {
      statusText = `✗${entry.errorCode ? ` ${entry.errorCode}` : ''}`;
      statusColor = theme.bad;
    }
    return (
      <box flexDirection="row" gap={1} width="100%">
        <text fg={markerColor} wrapMode="none">⏺</text>
        <text fg={theme.muted} wrapMode="none">{timeOf(entry.at)}</text>
        <text fg={theme.text} flexGrow={1} wrapMode="word">{source}/{entry.action}{entry.sessionName ? ` · ${entry.sessionName}` : ''}</text>
        <text fg={statusColor} wrapMode="none">{statusText}</text>
      </box>
    );
  }

  // message entry
  const fromName = fromToName(entry.fromId);
  const toName = fromToName(entry.toId);
  const body = truncate(entry.body, 60);
  return (
    <box flexDirection="row" gap={1} width="100%">
      <text fg={theme.user} wrapMode="none">⏺</text>
      <text fg={theme.muted} wrapMode="none">{timeOf(entry.at)}</text>
      <text fg={theme.text} flexGrow={1} wrapMode="word">{fromName} → {toName}：{body}</text>
      <text fg={theme.muted} wrapMode="none">{zh ? '消息' : 'message'}</text>
    </box>
  );
}
