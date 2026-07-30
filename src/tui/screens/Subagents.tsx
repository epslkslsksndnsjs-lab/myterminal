/**
 * Subagents —— Subagent 列表页（ADR-0008 决策 4）。
 * 卡片列表 + 选中进详情。实时轮询 subagent 状态。
 */
import type { SubagentRecord } from '../../subagent/store.js';
import type { Theme } from '../state.js';
import type { Copy } from '../copy/index.js';
import { Line } from './shared.js';
import { statusToVisual } from '../status-color.js';

/** 状态→视觉颜色统一走 statusToVisual 单源（src/tui/status-color.ts）。 */

/** status → 显示标签 */
function statusLabel(status: string, zh: boolean): string {
  switch (status) {
    case 'running': return zh ? '运行中' : 'Running';
    case 'completed': return zh ? '已完成' : 'Completed';
    case 'failed': return zh ? '失败' : 'Failed';
    case 'aborted': return zh ? '已中止' : 'Aborted';
    case 'aborting': return zh ? '中止中' : 'Aborting';
    default: return status;
  }
}

export function Subagents({ subagents, selected, theme, zh, copy, onSelect }: {
  subagents: SubagentRecord[];
  selected: number;
  theme: Theme;
  zh: boolean;
  copy: Copy;
  onSelect: (index: number) => void;
}) {
  if (!subagents.length) {
    return <box padding={1}><Line color={theme.muted}>{zh ? '暂无运行中的 Subagent。通过 subagent_start 创建。' : 'No subagents running. Create one with subagent_start.'}</Line></box>;
  }

  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      {subagents.map((record, index) => {
        const active = index === selected;
        const summary = record.tasks[0]?.subject?.slice(0, 40) ?? (zh ? '无任务描述' : 'No task description');
        const completedTasks = record.tasks.filter((t) => t.status === 'completed').length;
        const color = theme[statusToVisual(record.status)];
        return (
          <box
            key={record.id}
            id={`subagent-${record.id}`}
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
                <text fg={active ? theme.selectedText : theme.text} wrapMode="none"><b>{record.id}</b></text>
              </box>
              <text fg={color} wrapMode="none">{statusLabel(record.status, zh)}</text>
            </box>
            <Line color={active ? theme.selectedText : theme.muted}>
              {`├─ ${zh ? '任务' : 'Task'}: ${summary}`}
            </Line>
            <Line color={active ? theme.selectedText : theme.muted}>
              {`├─ ${zh ? '进度' : 'Progress'}: ${completedTasks}/${record.tasks.length} ${zh ? '完成' : 'done'}`}
            </Line>
            <Line color={active ? theme.selectedText : theme.muted}>
              {`├─ ${zh ? '成本' : 'Cost'}: $${record.cost.totalUSD.toFixed(4)} (${record.cost.inputTokens}+${record.cost.outputTokens} tokens)`}
            </Line>
            {record.sessionId ? (
              <Line color={active ? theme.selectedText : theme.muted}>
                {`└─ Session: ${record.sessionId}`}
              </Line>
            ) : null}
            {record.error ? (
              <text fg={theme.bad} wrapMode="word">
                {`   ${zh ? '错误' : 'Error'}: ${record.error.slice(0, 200)}`}
              </text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}

export { Subagents as SubagentList };
