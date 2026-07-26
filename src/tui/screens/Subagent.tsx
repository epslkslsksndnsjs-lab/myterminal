/**
 * Subagent —— Subagent 详情页（ADR-0008 决策 3）。
 * 实时 AG-UI 事件流：TEXT_MESSAGE_CONTENT / TOOL_CALL_* / STATE_* / STEP_* / RUN_*。
 * 16ms 批量 flush 防高频重渲染。组件卸载时清理监听器。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubagentRecord } from '../../subagent/store.js';
import { getSubagent } from '../../subagent/store.js';
import { subagentEvents } from '../../subagent/tui-bridge.js';
import type { AgUiEvent } from '../../subagent/tui-bridge.js';
import type { Theme } from '../state.js';
import type { Copy } from '../copy/index.js';
import { Heading, Line } from './shared.js';

/** 事件渲染条目 */
type EventEntry = {
  id: number;
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
};

/** 聚合状态 */
type LiveState = {
  text: string;            // 流式文本累积
  tools: Array<{          // 工具调用记录
    id: string;
    name: string;
    args?: string;
    result?: string;
    isError?: boolean;
  }>;
  tasks: Array<{ id: string; subject: string; status: string }>;
  turns: number;
  status: string;          // RUN_STARTED / RUN_FINISHED / RUN_ERROR
  error?: string;
  result?: string;
};

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max)}...` : str;
}

export function SubagentDetail({ subagentId, theme, zh, copy }: {
  subagentId: string;
  theme: Theme;
  zh: boolean;
  copy: Copy;
}) {
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [live, setLive] = useState<LiveState>({
    text: '',
    tools: [],
    tasks: [],
    turns: 0,
    status: 'running',
  });
  const nextEventId = useRef(0);
  const bufferRef = useRef<AgUiEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 16ms 批量 flush
  const flush = useCallback(() => {
    const batch = bufferRef.current;
    bufferRef.current = [];
    if (!batch.length) return;

    setEvents((prev) => {
      const newEvents: EventEntry[] = batch.map((e) => ({
        id: nextEventId.current++,
        type: e.type,
        data: e.data ?? {},
        timestamp: e.timestamp,
      }));
      // 只保留最近 200 条
      const merged = [...prev, ...newEvents].slice(-200);
      return merged;
    });

    setLive((prev) => {
      const next = { ...prev };
      for (const event of batch) {
        switch (event.type) {
          case 'TEXT_MESSAGE_CONTENT':
            next.text += (event.data?.delta as string) ?? '';
            break;
          case 'TOOL_CALL_START': {
            const toolId = (event.data?.tool_call_id as string) ?? event.timestamp.toString();
            next.tools = [...next.tools, { id: toolId, name: (event.data?.name as string) ?? 'unknown' }];
            break;
          }
          case 'TOOL_CALL_ARGS':
            if (next.tools.length > 0) {
              const last = { ...next.tools[next.tools.length - 1] };
              last.args = (last.args ?? '') + ((event.data?.delta as string) ?? '');
              next.tools = [...next.tools.slice(0, -1), last];
            }
            break;
          case 'TOOL_CALL_END':
            // args 完成——无需额外处理
            break;
          case 'TOOL_CALL_RESULT':
            if (next.tools.length > 0) {
              const last = { ...next.tools[next.tools.length - 1] };
              last.result = truncate((event.data?.content as string) ?? (event.data?.result as string) ?? '', 500);
              last.isError = event.data?.is_error === true;
              next.tools = [...next.tools.slice(0, -1), last];
            }
            break;
          case 'STATE_SNAPSHOT':
            next.tasks = (event.data?.tasks as LiveState['tasks']) ?? next.tasks;
            break;
          case 'STATE_DELTA':
            if (Array.isArray(event.data?.tasks)) {
              next.tasks = event.data.tasks as LiveState['tasks'];
            }
            break;
          case 'STEP_STARTED':
            next.turns = (event.data?.turn as number) ?? next.turns;
            break;
          case 'STEP_FINISHED':
            // 轮次结束——无需额外处理
            break;
          case 'RUN_STARTED':
            next.status = 'running';
            next.text = '';
            break;
          case 'RUN_FINISHED':
            next.status = 'completed';
            next.result = (event.data?.result as string) ?? '';
            break;
          case 'RUN_ERROR':
            next.status = 'failed';
            next.error = (event.data?.error as string) ?? 'Unknown error';
            break;
        }
      }
      return next;
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flush();
    }, 16);
  }, [flush]);

  const handleEvent = useCallback((event: AgUiEvent) => {
    if (event.subagentId !== subagentId) return;
    bufferRef.current.push(event);
    scheduleFlush();
  }, [subagentId, scheduleFlush]);

  // 订阅 AG-UI 事件
  useEffect(() => {
    subagentEvents.on('ag-ui', handleEvent);

    // 初始状态——从 store 读取已在运行中的 subagent
    const record = getSubagent(subagentId);
    if (record) {
      setLive({
        text: record.result ?? '',
        tools: [],
        tasks: record.tasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status })),
        turns: 0,
        status: record.status,
        error: record.error,
        result: record.result,
      });
    }

    return () => {
      subagentEvents.off('ag-ui', handleEvent);
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [subagentId, handleEvent]);

  const statusText = live.status === 'running' ? (zh ? '运行中' : 'Running')
    : live.status === 'completed' ? (zh ? '已完成' : 'Completed')
    : live.status === 'failed' ? (zh ? '失败' : 'Failed')
    : (zh ? '已中止' : 'Aborted');

  const statusColor = live.status === 'running' ? theme.accent
    : live.status === 'completed' ? theme.good
    : live.status === 'failed' ? theme.bad
    : theme.warn;

  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      {/* 顶栏：subagentId + 状态 */}
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <Heading theme={theme}>{subagentId}</Heading>
        <text fg={statusColor} wrapMode="none">{statusText}</text>
      </box>
      <Line color={theme.muted}>{`${zh ? '轮次' : 'Turns'}: ${live.turns}`}</Line>

      {/* 任务进度 */}
      {live.tasks.length > 0 ? (
        <box flexDirection="column" border borderColor={theme.border} padding={1} backgroundColor={theme.panel}>
          <text fg={theme.text}><b>{zh ? '任务进度' : 'Task Progress'}</b></text>
          {live.tasks.map((task) => (
            <Line key={task.id} color={task.status === 'completed' ? theme.good : task.status === 'in_progress' ? theme.accent : theme.muted}>
              {`  ${task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '○' : '·'} ${task.subject}`}
            </Line>
          ))}
        </box>
      ) : null}

      {/* 流式文本 */}
      {live.text ? (
        <box flexDirection="column" border borderColor={theme.border} padding={1} backgroundColor={theme.panel}>
          <text fg={theme.text}><b>{zh ? '输出' : 'Output'}</b></text>
          <text fg={theme.muted} wrapMode="word">{live.text.slice(-5000)}</text>
        </box>
      ) : null}

      {/* 工具调用记录 */}
      {live.tools.length > 0 ? (
        <box flexDirection="column" border borderColor={theme.border} padding={1} backgroundColor={theme.panel}>
          <text fg={theme.text}><b>{zh ? '工具调用' : 'Tool Calls'} ({live.tools.length})</b></text>
          {live.tools.map((tool, i) => (
            <box key={`${tool.id}-${i}`} flexDirection="column" paddingLeft={1} marginTop={i > 0 ? 1 : 0}>
              <text fg={theme.accent} wrapMode="none">{`▸ ${tool.name}`}</text>
              {tool.args ? <text fg={theme.muted} wrapMode="none">{`  args: ${truncate(tool.args, 200)}`}</text> : null}
              {tool.result ? (
                <text fg={tool.isError ? theme.bad : theme.muted} wrapMode="word">
                  {`  result: ${tool.result}`}
                </text>
              ) : null}
            </box>
          ))}
        </box>
      ) : null}

      {/* 错误 */}
      {live.error ? (
        <box flexDirection="column" border borderColor={theme.bad} padding={1}>
          <text fg={theme.bad}>{`${zh ? '错误' : 'Error'}: ${live.error}`}</text>
        </box>
      ) : null}

      {/* 结果 */}
      {live.result && live.status === 'completed' ? (
        <box flexDirection="column" border borderColor={theme.good} padding={1}>
          <text fg={theme.good}><b>{zh ? '完成' : 'Completed'}</b></text>
          <text fg={theme.muted} wrapMode="word">{live.result.slice(0, 1000)}</text>
        </box>
      ) : null}

      {/* 事件流（最近 50 条） */}
      {events.length > 0 ? (
        <box flexDirection="column" border={['left']} borderColor={theme.border} paddingLeft={1}>
          <text fg={theme.muted}><b>{zh ? '事件流' : 'Event Stream'} ({events.length})</b></text>
          {events.slice(-50).map((entry) => (
            <text key={entry.id} fg={theme.muted} wrapMode="none">
              {`${entry.type}: ${JSON.stringify(entry.data).slice(0, 100)}`}
            </text>
          ))}
        </box>
      ) : null}
    </box>
  );
}
