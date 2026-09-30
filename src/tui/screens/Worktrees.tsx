/**
 * Worktrees —— 写必隔离的保留项面板（#231 / ADR-0052 §11④d、§12）。
 *
 * 这块屏幕只做两件人才能做的事：
 *   看 —— 每条保留项给 runId / 路径 / 分支 / 大小 / 时间；
 *   减 —— 选一条，按 x 显式丢弃（合并是 git 的活，人在命令行做）。
 *
 * 两条不能含糊的话写在同一屏上：有改动的件永不自动删（磁盘到上限也只拒新建），
 * 以及配额到软阈值时告警必须看得见——看见告警的人同时要知道下一步是处置，不是等它自己消。
 */
import type { Theme } from '../state.js';
import type { WorktreePanelRow, WorktreeQuotaSummary } from '../controller-logic.js';
import { describeQuotaWarning, isWorktreeQuotaWarning } from '../controller-logic.js';
import { useI18n } from '../copy/context.js';
import { Line } from './shared.js';

export function Worktrees({ rows, quota, selected, theme, onSelect }: {
  rows: WorktreePanelRow[];
  quota: WorktreeQuotaSummary | null;
  selected: number;
  theme: Theme;
  onSelect: (index: number) => void;
}) {
  const { t } = useI18n();
  const warning = quota && isWorktreeQuotaWarning(quota.level) ? describeQuotaWarning(quota, t) : undefined;
  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      {warning ? (
        <box border borderColor={quota?.level === 'blocked' ? theme.bad : theme.warn} padding={1}>
          <text fg={quota?.level === 'blocked' ? theme.bad : theme.warn} wrapMode="word">{warning}</text>
        </box>
      ) : null}
      {rows.length === 0 ? (
        <Line color={theme.muted}>{t('No kept worktrees. Clean paths are deleted automatically; anything with changes waits for you here.', '没有待处置的 worktree。干净的一路会自动删；有改动的都在这儿等你。')}</Line>
      ) : null}
      {rows.map((row, index) => {
        const active = index === selected;
        return (
          <box
            key={row.id}
            id={`worktree-${row.id}`}
            flexDirection="column"
            width="100%"
            border
            borderColor={active ? theme.accent : theme.border}
            backgroundColor={active ? theme.selected : theme.panel}
            padding={1}
            onMouseDown={() => onSelect(index)}
          >
            <box flexDirection="row" justifyContent="space-between" flexWrap="wrap" width="100%">
              <text fg={active ? theme.selectedText : theme.text} wrapMode="none"><b>{row.branch}</b></text>
              <text fg={active ? theme.selectedText : theme.muted} wrapMode="none">{row.size}</text>
            </box>
            <Line color={active ? theme.selectedText : theme.muted}>{`├─ Run: ${row.runId}`}</Line>
            <Line color={active ? theme.selectedText : theme.muted}>{`├─ ${t('Path', '路径')}: ${row.path}`}</Line>
            <Line color={active ? theme.selectedText : theme.muted}>{`└─ ${t('Kept since', '保留于')}: ${row.at}`}</Line>
          </box>
        );
      })}
      {rows.length > 0 ? (
        <Line color={theme.muted}>{t('x discards the selected worktree (audited). Kept worktrees are never deleted automatically.', 'x 丢弃所选 worktree（留审计痕）。有改动的 worktree 永不自动删。')}</Line>
      ) : null}
    </box>
  );
}
