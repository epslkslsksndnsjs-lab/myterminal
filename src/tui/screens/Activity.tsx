/**
 * Activity — read-only subagent activity UI, in two levels:
 *   list  = every subagent conversation (concurrent runs stay separate),
 *   detail= the selected conversation's self-talk + tool calls.
 *
 * The detail renderer is the algorithm ported 1:1 from min-agent. There is no
 * input or reply control at either level: it mirrors what the subagent is
 * doing for the user and never writes back into subagent state.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SubagentRecord } from '../../subagent/store.js';
import type { Theme } from '../state.js';
import { useI18n } from '../copy/context.js';
import { statusToVisual } from '../status-color.js';
import { AnsiLines } from '../components/AnsiText.js';
import { advanceToolPulse } from '../activity/transcript.js';
import type { SubagentActivity } from '../activity/recordings.js';
import { subagentActivityRecorder } from '../activity/recordings.js';

const STATUS_LABEL: Record<string, [string, string]> = {
  running: ['Running', '运行中'],
  completed: ['Completed', '已完成'],
  failed: ['Failed', '失败'],
  aborted: ['Aborted', '已中止'],
};

function previewOf(activity: SubagentActivity | undefined, record: SubagentRecord): string {
  const blocks = activity?.transcript.getBlocks() ?? [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.kind === 'assistant') {
      const lines = block.text.split('\n').map((line) => line.trim()).filter(Boolean);
      if (lines.length > 0) return lines[lines.length - 1];
    } else if (block.kind === 'tool') {
      return `${block.name} · ${block.status}`;
    }
  }
  const resultLine = record.result?.split('\n').map((line) => line.trim()).find(Boolean);
  return resultLine ?? '';
}

/** Parent list: one row per subagent, including every concurrently running one. */
export function SubagentActivityList({ subagents, selected, theme, onSelect, onOpen }: {
  subagents: SubagentRecord[];
  selected: number;
  theme: Theme;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
}) {
  const { t } = useI18n();
  const [, setTick] = useState(0);
  const idSignature = JSON.stringify(subagents.map((record) => record.id));

  useEffect(() => subagentActivityRecorder.subscribe(() => setTick((value) => value + 1)), []);

  // Activities die with their records; transcript history only exists for
  // conversations the list can still open.
  useEffect(() => {
    subagentActivityRecorder.retain(subagents.map((record) => record.id));
  }, [idSignature]);

  if (!subagents.length) {
    return (
      <box padding={1}>
        <text fg={theme.muted} wrapMode="word">
          {t('No subagent activity. Start one with subagent_start.', '暂无子代理活动。通过 subagent_start 启动一个。')}
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      <text fg={theme.muted} wrapMode="word">
        {t('Subagent conversations (read-only). Enter opens one; concurrent runs stay separate.', '子代理对话（只读）。Enter 打开一个；并发运行各自独立。')}
      </text>
      {subagents.map((record, index) => {
        const active = index === selected;
        const activity = subagentActivityRecorder.get(record.id);
        const status = activity?.status ?? record.status;
        const statusLabel: [string, string] = STATUS_LABEL[status] ?? [status, status];
        const blocks = activity?.transcript.getBlocks() ?? [];
        const toolCount = blocks.filter((block) => block.kind === 'tool').length;
        const preview = previewOf(activity, record);
        return (
          <box
            key={record.id}
            id={`activity-${record.id}`}
            flexDirection="column"
            width="100%"
            border
            borderColor={active ? theme.accent : theme.border}
            backgroundColor={active ? theme.selected : theme.panel}
            padding={1}
            onMouseDown={() => { onSelect(index); onOpen(index); }}
          >
            <box flexDirection="row" justifyContent="space-between" width="100%" flexWrap="wrap">
              <box flexDirection="row" gap={1}>
                <text fg={active ? theme.selectedText : theme.text} wrapMode="none"><b>{record.id}</b></text>
                <text fg={theme[statusToVisual(status)]} wrapMode="none">{t(...statusLabel)}</text>
              </box>
              <text fg={active ? theme.selectedText : theme.muted} wrapMode="none">
                {`${t('turn', '轮')} ${activity?.turns ?? 0} · ${t('tools', '工具')} ${toolCount}`}
              </text>
            </box>
            <text fg={active ? theme.selectedText : theme.muted} wrapMode="word">
              {preview || t('Waiting for the first activity event…', '等待第一条活动事件…')}
            </text>
          </box>
        );
      })}
    </box>
  );
}

/** Detail subpage: the selected conversation's merged self-talk + tool stream. */
export function SubagentActivityScreen({ subagents, selected, width, theme, expandRev }: {
  subagents: SubagentRecord[];
  selected: number;
  width: number;
  theme: Theme;
  /** Incremented by the ctrl+o binding; toggles every tool block on this subpage. */
  expandRev: number;
}) {
  const { t } = useI18n();
  const [tick, setTick] = useState(0);
  // Expand state lives on the shared Transcript (reference behavior); App
  // resets the rev on open so a mount cannot replay a stale toggle. A rev
  // increment that arrives before the first event is applied when it lands.
  const lastExpandRev = useRef(0);
  const record = selected >= 0 && selected < subagents.length ? subagents[selected] : undefined;
  const activity = record ? subagentActivityRecorder.get(record.id) : undefined;
  // App's scrollbox keeps a one-column vertical scrollbar beside the viewport;
  // render the transcript to that inner width so padded tool panels do not
  // collide with the bar.
  const contentWidth = Math.max(1, width - 1);

  // Live updates: the recorder batches AG-UI events at 16 ms.
  useEffect(() => subagentActivityRecorder.subscribe(() => setTick((value) => value + 1)), []);

  // Seed activity that predates this page (or this TUI) from the authoritative
  // record. Seeding is idempotent: it only appends a final report when no text
  // was ever observed, so a re-render cannot duplicate it.
  useEffect(() => {
    if (!record) return;
    subagentActivityRecorder.ensure(record);
    setTick((value) => value + 1);
  }, [record?.id, record?.status, record?.result, record?.error]);

  // Animate the running-tool diamond exactly like the reference render ticker.
  const running = (activity?.transcript.hasRunning() ?? false) && (activity?.status ?? 'running') === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      advanceToolPulse();
      setTick((value) => value + 1);
    }, 250);
    return () => clearInterval(timer);
  }, [running, activity]);

  // Expand-all toggle (ctrl+o), matching the reference transcript's flip.
  useEffect(() => {
    if (expandRev === lastExpandRev.current) return;
    if (expandRev === 0) {
      lastExpandRev.current = 0;
      return;
    }
    // Wait for the first event before applying the expand-all intent; if the
    // user pressed ctrl+o first, this effect runs again when activity arrives.
    if (!activity) return;
    lastExpandRev.current = expandRev;
    activity.transcript.toggleToolsExpanded();
    setTick((value) => value + 1);
  }, [expandRev, activity]);

  const { lines, toolHeaderLines } = useMemo(() => {
    if (!activity) return { lines: [] as string[], toolHeaderLines: new Map<number, number>() };
    const rendered = activity.transcript.render(contentWidth);
    const headers = new Map<number, number>();
    for (let index = 0; index < rendered.length; index++) {
      const block = activity.transcript.getToolBlockIndexAtLine(index);
      if (block !== null) headers.set(index, block);
    }
    return { lines: rendered, toolHeaderLines: headers };
  }, [activity, contentWidth, expandRev, running, tick]);

  if (!subagents.length) {
    return (
      <box padding={1}>
        <text fg={theme.muted} wrapMode="word">
          {t('No subagent activity. Start one with subagent_start.', '暂无子代理活动。通过 subagent_start 启动一个。')}
        </text>
      </box>
    );
  }

  if (!record) {
    return (
      <box padding={1}>
        <text fg={theme.muted} wrapMode="word">
          {t('This conversation is no longer available. Esc returns to the list.', '这个对话已不可用。按 Esc 返回列表。')}
        </text>
      </box>
    );
  }

  const status = activity?.status ?? record.status;
  const statusLabel: [string, string] = STATUS_LABEL[status] ?? [status, status];
  const blockCount = activity ? activity.transcript.getBlocks().length : 0;
  const position = selected + 1;

  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={theme.panelAlt}>
        <box flexDirection="row" width="100%" justifyContent="space-between" flexWrap="wrap">
          <box flexDirection="row" gap={1}>
            <text fg={theme.agent} wrapMode="none"><b>{record.id}</b></text>
            <text fg={theme[statusToVisual(status)]} wrapMode="none">{t(...statusLabel)}</text>
            <text fg={theme.muted} wrapMode="none">
              {`${t('turn', '轮')} ${activity?.turns ?? 0} · ${t('blocks', '条目')} ${blockCount}`}
            </text>
          </box>
          <text fg={theme.muted} wrapMode="none">
            {subagents.length > 1
              ? `${position}/${subagents.length} · ${t('↑↓ switch conversation', '↑↓ 切换对话')}`
              : t('read-only', '只读')}
          </text>
        </box>
        <text fg={theme.muted} wrapMode="word">
          {t('Subagent self-talk and tool calls. ctrl+o expands tools; click a tool header to toggle. Esc returns to the conversation list.', '子代理自述与工具调用。ctrl+o 展开全部工具，点击工具标题可单独折叠/展开。Esc 返回对话列表。')}
        </text>
        {activity?.error && status !== 'running' ? (
          <text fg={theme.bad} wrapMode="word">{`${t('Error', '错误')}: ${activity.error}`}</text>
        ) : null}
      </box>

      {activity && lines.length > 0 ? (
        <AnsiLines
          lines={lines}
          defaultColor={theme.text}
          toolHeaderLines={toolHeaderLines}
          onToggleTool={(blockIndex) => {
            activity.transcript.toggleToolExpanded(blockIndex);
            setTick((value) => value + 1);
          }}
        />
      ) : (
        <box padding={1}>
          <text fg={theme.muted} wrapMode="word">
            {t('Waiting for the first activity event…', '等待第一条活动事件…')}
          </text>
        </box>
      )}
    </box>
  );
}
