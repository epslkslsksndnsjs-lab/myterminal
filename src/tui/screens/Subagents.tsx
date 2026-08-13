/**
 * Subagents —— Subagent 列表页（ADR-0008 决策 4）。
 * 卡片列表 + 选中进详情。实时轮询 subagent 状态。
 */
import type { SubagentRecord } from '../../subagent/store.js';
import type { Theme } from '../state.js';
import { useI18n } from '../copy/context.js';
import type { Translate } from '../copy/i18n.js';
import { Line } from './shared.js';
import { statusToVisual } from '../status-color.js';

/** 状态→视觉颜色统一走 statusToVisual 单源（src/tui/status-color.ts）。 */

/** status → 显示标签 */
function statusLabel(status: string, t: Translate): string {
  switch (status) {
    case 'running': return t('Running', '运行中');
    case 'completed': return t('Completed', '已完成');
    case 'failed': return t('Failed', '失败');
    case 'aborted': return t('Aborted', '已中止');
    case 'aborting': return t('Aborting', '中止中');
    default: return status;
  }
}

export function Subagents({ subagents, selected, theme, onSelect }: {
  subagents: SubagentRecord[];
  selected: number;
  theme: Theme;
  onSelect: (index: number) => void;
}) {
  const { t } = useI18n();
  if (!subagents.length) {
    return <box padding={1}><Line color={theme.muted}>{t('No subagents running. Create one with subagent_start.', '暂无运行中的 Subagent。通过 subagent_start 创建。')}</Line></box>;
  }

  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      {subagents.map((record, index) => {
        const active = index === selected;
        const summary = record.tasks[0]?.subject?.slice(0, 40) ?? (t('No task description', '无任务描述'));
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
              <text fg={color} wrapMode="none">{statusLabel(record.status, t)}</text>
            </box>
            <Line color={active ? theme.selectedText : theme.muted}>
              {`├─ ${t('Task', '任务')}: ${summary}`}
            </Line>
            <Line color={active ? theme.selectedText : theme.muted}>
              {`├─ ${t('Progress', '进度')}: ${completedTasks}/${record.tasks.length} ${t('done', '完成')}`}
            </Line>
            <Line color={active ? theme.selectedText : theme.muted}>
              {`├─ ${t('Cost', '成本')}: ${record.cost.inputTokens}+${record.cost.outputTokens} tokens`}
            </Line>
            {record.sessionId ? (
              <Line color={active ? theme.selectedText : theme.muted}>
                {`└─ Session: ${record.sessionId}`}
              </Line>
            ) : null}
            {record.error ? (
              <text fg={theme.bad} wrapMode="word">
                {`   ${t('Error', '错误')}: ${record.error.slice(0, 200)}`}
              </text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}

export { Subagents as SubagentList };
