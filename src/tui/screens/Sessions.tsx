/**
 * Sessions — 会话页（ADR-0004 决策 7）。
 * 卡片树 + 事件流详情（无 JSON 裸输出）。M4a 重做。
 */
import { useEffect, useState } from 'react';
import type { MyTerminalRuntime } from '../../server.js';
import { logicalSessionGroups } from '../../tui-model.js';
import type { StoredState } from '../../types.js';
import type { Theme } from '../state.js';
import type { Copy } from '../copy/index.js';
import { Heading, Line, SessionStatus } from './shared.js';
import { viewForHistoryEntry } from '../model/history-entry.js';
import type { HistoryEntryView } from '../model/history-entry.js';

/** tone → theme 颜色映射 */
function toneColor(theme: Theme, tone: HistoryEntryView['tone']): string {
  return theme[tone];
}

/** 会话活跃时黑白闪烁的圆点；非活跃保持原 accent 色 */
function BlinkingDot({ phase, presence, theme }: { phase: string; presence: string; theme: Theme }) {
  const working = phase === 'working' && presence === 'claimed';
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setOn((v) => !v), 500);
    return () => clearInterval(timer);
  }, [working]);
  const fg = !working ? theme.accent : on ? theme.text : theme.background;
  return <text fg={fg} wrapMode="none">●</text>;
}

export function Sessions({ state, selected, theme, zh, copy, onSelect }: {
  state: StoredState;
  selected: number;
  theme: Theme;
  zh: boolean;
  copy: Copy;
  onSelect: (index: number) => void;
}) {
  const groups = logicalSessionGroups(state.sessions);
  if (!groups.length) {
    return <box padding={1}><Line color={theme.muted}>{copy.emptyStates.sessions}</Line></box>;
  }

  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      {groups.map((group, index) => {
        const current = group.current;
        const active = index === selected;
        const summary = current.latestCheckpoint?.summary || current.finalSummary || (zh ? '暂无 checkpoint 摘要' : 'No checkpoint summary');
        return (
          <box
            key={group.id}
            id={`session-${group.id}`}
            flexDirection="column"
            width="100%"
            border
            borderColor={active ? theme.accent : theme.border}
            backgroundColor={active ? theme.selected : theme.panel}
            padding={1}
            onMouseDown={() => onSelect(index)}
          >
            <box flexDirection="row" justifyContent="space-between" flexWrap="wrap" width="100%">
              <box flexDirection="row" gap={1} alignItems="center">
                <BlinkingDot phase={current.phase} presence={current.presence} theme={theme} />
                <text fg={active ? theme.selectedText : theme.text} wrapMode="word"><b>{group.title}</b></text>
              </box>
              <SessionStatus session={current} theme={theme} />
            </box>
            <Line color={active ? theme.selectedText : theme.muted}>
              {`├─ ${zh ? '工作记录' : 'records'}: ${group.sessions.length}`}
            </Line>
            {group.sessions.map((session, recordIndex) => (
              <box key={session.id} flexDirection="row" paddingLeft={2} gap={1} flexWrap="wrap">
                <text fg={active ? theme.selectedText : theme.muted} wrapMode="none">
                  {recordIndex === group.sessions.length - 1 ? '└─' : '├─'}
                </text>
                <text fg={active ? theme.selectedText : theme.text}>{session.name}</text>
                <SessionStatus session={session} theme={theme} />
              </box>
            ))}
            <Line color={active ? theme.selectedText : theme.muted}>
              {`├─ ${zh ? '子会话' : 'children'}: ${group.children.length}`}
            </Line>
            {group.children.map((child, childIndex) => (
              <box key={child.id} flexDirection="column" paddingLeft={2}>
                <box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                  <text fg={active ? theme.selectedText : theme.muted} wrapMode="none">
                    {childIndex === group.children.length - 1 ? '└─' : '├─'}
                  </text>
                  <text fg={active ? theme.selectedText : theme.text}>📁 {child.name}</text>
                  <SessionStatus session={child} theme={theme} />
                </box>
                {child.latestCheckpoint?.summary || child.task?.objective ? (
                  <Line color={active ? theme.selectedText : theme.muted}>
                    {`   ${child.latestCheckpoint?.summary || child.task?.objective}`}
                  </Line>
                ) : null}
              </box>
            ))}
            <Line color={active ? theme.selectedText : theme.muted}>
              {`├─ ${zh ? '操作' : 'action'}: ${zh ? '按 u 后选择具体根/续作/子 session' : 'press u, then choose the exact root/continuation/child session'}`}
            </Line>
            <Line color={active ? theme.selectedText : theme.muted}>
              {`└─ ${zh ? '摘要' : 'summary'}: ${summary}`}
            </Line>
          </box>
        );
      })}
    </box>
  );
}

export function SessionDetail({ runtime, groupId, theme, zh, copy }: {
  runtime: MyTerminalRuntime;
  groupId: string;
  theme: Theme;
  zh: boolean;
  copy: Copy;
}) {
  const group = logicalSessionGroups(runtime.store.listSessions()).find((item) => item.id === groupId);
  if (!group) {
    return <box padding={1}><Line color={theme.bad}>{zh ? 'Session 已不存在，按 Esc 返回。' : 'Session no longer exists. Press Esc.'}</Line></box>;
  }
  const ids = [...group.sessions, ...group.children].map((session) => session.id);
  const history = runtime.store.historiesForTui(ids);
  const historyTotal = ids.reduce((sum, id) => sum + runtime.store.historyCount(id), 0);

  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      {/* 顶部信息区 */}
      <Heading theme={theme}>{group.title}</Heading>
      <Line color={theme.muted}>{group.id}</Line>
      <Line color={theme.text}>
        {`${zh ? '继承/续作记录' : 'Continuation records'}: ${group.sessions.length} · ${zh ? '子 Sessions' : 'Child sessions'}: ${group.children.length}`}
      </Line>

      {/* 会话卡片（精简） */}
      {group.sessions.map((session) => (
        <box key={session.id} flexDirection="column" border borderColor={theme.border} padding={1} backgroundColor={theme.panel}>
          <box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
            <text fg={theme.accent}><b>◆ {session.name}</b></text>
            <SessionStatus session={session} theme={theme} />
          </box>
          <Line color={theme.muted}>{session.id}</Line>
          <Line color={theme.muted}>
            {`${zh ? '创建' : 'Created'}: ${session.createdAt} · ${zh ? '更新' : 'Updated'}: ${session.updatedAt}`}
          </Line>
          {session.task?.objective ? <Line color={theme.text}>{`Objective: ${session.task.objective}`}</Line> : null}
          {session.latestCheckpoint?.summary ? <Line color={theme.text}>{`Checkpoint: ${session.latestCheckpoint.summary}`}</Line> : null}
        </box>
      ))}

      {/* 子会话卡片（精简） */}
      {group.children.length > 0 ? <Heading theme={theme}>{zh ? '协作子会话' : 'Collaborating children'}</Heading> : null}
      {group.children.map((child) => (
        <box key={child.id} flexDirection="row" gap={1} flexWrap="wrap" paddingLeft={1} alignItems="center">
          <text fg={theme.text}>└─ 📁 {child.name}</text>
          <SessionStatus session={child} theme={theme} />
          <text fg={theme.muted} wrapMode="none">{child.id}</text>
        </box>
      ))}

      {/* 事件流历史区 */}
      <Heading theme={theme}>{zh ? '永久结构化历史' : 'Permanent structured history'}</Heading>
      <Line color={theme.muted}>
        {historyTotal > history.length
          ? (zh ? `显示最近 ${history.length} / ${historyTotal} 条；完整记录可通过 session_history 分页读取。` : `Showing latest ${history.length} of ${historyTotal}; use paginated session_history for the complete record.`)
          : `${history.length} ${zh ? '条记录' : 'entries'}`}
      </Line>

      {history.map((item, index) => {
        const view = viewForHistoryEntry(item.entry, zh);
        const color = toneColor(theme, view.tone);
        return (
          <box key={`${item.sessionId}-${item.entry.at}-${index}`} flexDirection="column" border={['left']} borderColor={theme.border} paddingLeft={1}>
            <box flexDirection="row" gap={1} flexWrap="wrap" width="100%" alignItems="center">
              <text fg={color} wrapMode="none">{view.icon}</text>
              <text fg={theme.muted} wrapMode="none">{item.entry.at}</text>
              <text fg={theme.accent} wrapMode="none"><b>{item.entry.type}</b></text>
              <text fg={theme.text} flexGrow={1} wrapMode="word">{view.title}</text>
            </box>
            {view.detail ? (
              <text fg={theme.muted} wrapMode="word" paddingLeft={2}>{view.detail}</text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}
