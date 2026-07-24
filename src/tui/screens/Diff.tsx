import type { DiffSnapshot } from '../../diff.js';
import type { Theme } from '../state.js';
import { Heading, Line } from './shared.js';

function colorFor(line: string, theme: Theme): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return theme.good;
  if (line.startsWith('-') && !line.startsWith('---')) return theme.bad;
  if (line.startsWith('@@')) return theme.accent;
  if (line.startsWith('diff --git')) return theme.warn;
  return theme.text;
}

export function DiffScreen({ snapshot, theme, zh }: { snapshot: DiffSnapshot; theme: Theme; zh: boolean }) {
  return (
    <box flexDirection="column" width="100%" padding={1}>
      <Heading theme={theme}>{zh ? '工作区未提交 Diff' : 'Uncommitted workspace diff'}</Heading>
      <Line color={theme.muted}>{`${snapshot.updatedAt || ''}${snapshot.loading ? ` · ${zh ? '刷新中' : 'refreshing'}` : ''}`}</Line>
      {snapshot.error ? <Line color={theme.bad}>{snapshot.error}</Line> : null}
      {snapshot.unavailableReason === 'not-git-repository' ? <Line color={theme.muted}>{zh ? '当前工作区不是 Git 仓库；Diff 视图已安全禁用。' : 'This workspace is not a Git repository; the Diff view is safely disabled.'}</Line> : null}
      {snapshot.unavailableReason === 'git-unavailable' ? <Line color={theme.warn}>{zh ? '系统未安装或无法执行 Git；Diff 视图已安全禁用。' : 'Git is unavailable; the Diff view is safely disabled.'}</Line> : null}
      {!snapshot.error && !snapshot.unavailableReason && !snapshot.lines.length ? <Line color={theme.muted}>{zh ? '工作区没有未提交更改。' : 'Working tree is clean.'}</Line> : null}
      {snapshot.lines.map((line, index) => <Line key={`${index}-${line.slice(0, 30)}`} color={colorFor(line, theme)} bold={line.startsWith('diff --git')}>{line || ' '}</Line>)}
      {snapshot.truncated ? <Line color={theme.warn}>{zh ? 'Diff 已在源进程、文件采样或渲染预算处停止；Git 子进程已终止，不会继续在后台遍历。' : 'Diff stopped at a source, sampling, or render budget; the Git subprocess was terminated instead of continuing in the background.'}</Line> : null}
      {snapshot.truncationReasons?.map((reason) => <Line key={reason} color={theme.warn}>{`- ${reason}`}</Line>)}
    </box>
  );
}
