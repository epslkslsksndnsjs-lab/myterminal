/**
 * Workflows —— 本地可观测与可控面（#232 / ADR-0052 §7④、§12、§21#5）。
 *
 * 列表给"现在有几条 run、到哪了、烧了多少"，详情给"每一路各自怎么样"。
 * 三个控制键都在这块屏上：c 取消、p 暂停、r 恢复——GPT 面没有 pause，pause 只在这里。
 * 这块屏刻意不与子 agent 对话、也不发提醒（v1 负向）：它只读账、只按闸。
 */
import type { Theme } from '../state.js';
import type { RunBoardRow, RunBoardUnreadable, RunDetailRow, WorkflowScreenAction } from '../workflow-runs.js';
import { WORKFLOW_SCREEN_ACTIONS, renderRunDetailRows, resumeCallText, runElapsed, runStatusTone, stripControlChars } from '../workflow-runs.js';
import { useI18n } from '../copy/context.js';
import type { Translate } from '../copy/i18n.js';
import { Line } from './shared.js';

function statusLabel(status: string, t: Translate): string {
  switch (status) {
    case 'running': return t('running', '在跑');
    case 'pausing': return t('pausing', '暂停中');
    case 'paused': return t('paused', '已暂停');
    case 'completed': return t('completed', '已完成');
    case 'failed': return t('failed', '失败');
    case 'cancelled': return t('cancelled', '已取消');
    default: return status;
  }
}

/** 列表行上的进度段：一路都没派出去时不写 0/0（那读起来像坏了）。 */
function progressText(row: RunBoardRow, t: Translate): string {
  if (row.total === 0) return t('no paths yet', '还没派出路');
  const failed = row.failedPaths > 0 ? ` · ${row.failedPaths} ${t('failed', '失败')}` : '';
  return `${row.finished}/${row.total} · ${t('agents', '路')}${failed}`;
}

/** 提示行由这块屏能做的事生成：多一个动作就多一个键位，负向（不聊天、不发提醒）也就无处藏。 */
const SCREEN_KEYS: Record<WorkflowScreenAction, [string, string]> = {
  open: ['Enter detail', 'Enter 详情'],
  cancel: ['c cancel', 'c 取消'],
  pause: ['p pause', 'p 暂停'],
  resume: ['r resume', 'r 恢复'],
  copyResume: ['y copy resume call', 'y 复制 resume 调用'],
};

function screenHint(t: Translate): string {
  return `${WORKFLOW_SCREEN_ACTIONS.map((action) => t(SCREEN_KEYS[action][0], SCREEN_KEYS[action][1])).join('   ')}   ${t('q quit', 'q 退出')}`;
}

export function Workflows({ rows, unreadable, sourceError, selected, now, theme, onSelect }: {
  rows: RunBoardRow[];
  unreadable: RunBoardUnreadable[];
  sourceError?: string;
  selected: number;
  now: number;
  theme: Theme;
  onSelect: (index: number) => void;
}) {
  const { t } = useI18n();
  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      {sourceError ? (
        <box border borderColor={theme.bad} padding={1}>
          <text fg={theme.bad} wrapMode="word">{`${t('Cannot read the run directory', '读不了 run 目录')}: ${stripControlChars(sourceError)}`}</text>
        </box>
      ) : null}
      {rows.length === 0 && unreadable.length === 0 && !sourceError ? (
        <Line color={theme.muted}>{t('No workflow runs. Ask ChatGPT to start one; a run keeps going locally after that conversation ends.', '还没有工作流 run。让 ChatGPT 起一条；run 起后会在这台机器上继续跑，对话结束也不停。')}</Line>
      ) : null}
      {rows.map((row, index) => {
        const active = index === selected;
        const tone = theme[runStatusTone(row.status)];
        return (
          <box
            key={row.runId}
            id={`workflow-${row.runId}`}
            flexDirection="column"
            width="100%"
            border
            borderColor={active ? theme.accent : theme.border}
            backgroundColor={active ? theme.selected : theme.panel}
            padding={1}
            onMouseDown={() => onSelect(index)}
          >
            <box flexDirection="row" justifyContent="space-between" flexWrap="wrap" width="100%">
              <text fg={active ? theme.selectedText : theme.text} wrapMode="none"><b>{stripControlChars(row.runId)}</b></text>
              <text fg={tone} wrapMode="none">● {statusLabel(row.status, t)}{row.live ? (t(' · here', ' · 在本进程')) : ''}{row.hasMarker ? (t(' · settled on disk', ' · 已落终态')) : ''}</text>
            </box>
            <Line color={active ? theme.selectedText : theme.muted}>{`${progressText(row, t)} · ${row.tokens} tok${row.reducerTokens ? ` (+${row.reducerTokens} reducer)` : ''} · ${runElapsed(row.startedAt, row.endedAt, now)}`}</Line>
            {row.reason ? <Line color={theme.muted}>{`${t('Reason', '原因')}: ${stripControlChars(row.reason)}`}</Line> : null}
          </box>
        );
      })}
      {unreadable.map((item) => (
        <box key={item.runId} border borderColor={theme.warn} padding={1} width="100%">
          <Line color={theme.warn}>{`${t('Unreadable run', '读不动的 run')}: ${stripControlChars(item.runId)} — ${stripControlChars(item.message)}`}</Line>
        </box>
      ))}
      {rows.length > 0 ? (
        <Line color={theme.muted}>{screenHint(t)}</Line>
      ) : null}
    </box>
  );
}

export function RunDetail({ row, now, theme }: { row: RunBoardRow; now: number; theme: Theme }) {
  const { t } = useI18n();
  const paths = renderRunDetailRows(row.index);
  const call = resumeCallText(row, { annotate: true });
  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" flexWrap="wrap" width="100%">
        <text fg={theme.text} wrapMode="none"><b>{stripControlChars(row.runId)}</b></text>
        <text fg={theme[runStatusTone(row.status)]} wrapMode="none">● {statusLabel(row.status, t)}{row.reason ? ` (${stripControlChars(row.reason)})` : ''}</text>
      </box>
      <Line color={theme.muted}>{`${row.finished}/${row.total} ${t('agents finished', '路已完成')} · ${t('run tokens', '本 run 用量')} ${row.tokens} · ${t('reducer tokens', '汇总体用量')} ${row.reducerTokens} · ${runElapsed(row.startedAt, row.endedAt, now)}`}</Line>
      {row.index.scriptError ? <Line color={theme.bad}>{`${t('Script failed', '脚本失败')}: ${stripControlChars(row.index.scriptError.message)}`}</Line> : null}
      {paths.length === 0 && !row.index.scriptError ? <Line color={theme.muted}>{t('No paths dispatched yet.', '还没有派出任何一路。')}</Line> : null}
      {paths.map((path) => <PathRow key={path.id} path={path} theme={theme} />)}
      <Line color={theme.muted}>{`${t('Index', '索引')}: ${stripControlChars(row.indexPath)}`}</Line>
      {call ? <Line color={theme.muted}>{call}</Line> : null}
    </box>
  );
}

function PathRow({ path, theme }: { path: RunDetailRow; theme: Theme }) {
  const { t } = useI18n();
  const tone = theme[path.status === 'completed' ? 'good' : path.status === 'failed' ? 'bad' : 'accent'];
  const tags = [path.phase, path.model, path.isolation].filter(Boolean).join(' · ');
  return (
    <box flexDirection="column" width="100%" border borderColor={theme.border} padding={1}>
      <box flexDirection="row" justifyContent="space-between" flexWrap="wrap" width="100%">
        <text fg={theme.text} wrapMode="none">{`#${path.seq ?? path.id} ${stripControlChars(path.label)}`}</text>
        <text fg={tone} wrapMode="none">{`● ${statusLabel(path.status, t)} · ${path.attempts}x · ${path.tokens} tok`}</text>
      </box>
      {tags ? <Line color={theme.muted}>{tags}</Line> : null}
      {path.errorKind ? <Line color={theme.bad}>{`${stripControlChars(path.errorKind)}: ${stripControlChars(path.errorMessage ?? '')}`}</Line> : null}
      {path.preserved ? <Line color={theme.warn}>{`${t('Kept for you', '留给你处置')}: ${stripControlChars(path.worktreePath ?? '')} ${t('on branch', '在分支')} ${stripControlChars(path.worktreeBranch ?? '')}`}</Line> : null}
    </box>
  );
}
