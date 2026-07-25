/**
 * Diff — 工作区差异页（ADR-0004 决策 7）。
 * 按文件分组显示，暖色 +/-，L1 俏皮空状态。
 */
import type { DiffSnapshot } from '../../diff.js';
import type { Theme } from '../state.js';
import { groupDiffLines } from '../model/diff-groups.js';
import type { Copy } from '../copy/index.js';
import { verbLabel } from '../copy/index.js';
import { Heading, Line } from './shared.js';

function colorFor(line: string, theme: Theme): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return theme.good;
  if (line.startsWith('-') && !line.startsWith('---')) return theme.bad;
  if (line.startsWith('@@')) return theme.accent;
  if (line.startsWith('diff --git')) return theme.warn;
  return theme.text;
}

export function DiffScreen({ snapshot, theme, zh, copy }: { snapshot: DiffSnapshot; theme: Theme; zh: boolean; copy: Copy }) {
  const groups = groupDiffLines(snapshot.lines);
  const hasContent = groups.length > 0;

  return (
    <box flexDirection="column" width="100%" padding={1}>
      <Heading theme={theme}>{zh ? '工作区未提交 Diff' : 'Uncommitted workspace diff'}</Heading>
      <Line color={theme.muted}>{`${snapshot.updatedAt || ''}${snapshot.loading ? ` · ${verbLabel(copy, 'diff-refresh')}` : ''}`}</Line>
      {snapshot.error ? <Line color={theme.bad}>{snapshot.error}</Line> : null}
      {snapshot.unavailableReason === 'not-git-repository' ? <Line color={theme.muted}>{zh ? '当前工作区不是 Git 仓库；Diff 视图已安全禁用。' : 'This workspace is not a Git repository; the Diff view is safely disabled.'}</Line> : null}
      {snapshot.unavailableReason === 'git-unavailable' ? <Line color={theme.warn}>{zh ? '系统未安装或无法执行 Git；Diff 视图已安全禁用。' : 'Git is unavailable; the Diff view is safely disabled.'}</Line> : null}
      {!snapshot.error && !snapshot.unavailableReason && !hasContent ? <Line color={theme.muted}>{copy.emptyStates.diffClean}</Line> : null}

      {groups.map((group, gIdx) => (
        <box key={`group-${gIdx}-${group.file}`} flexDirection="column" marginTop={gIdx > 0 ? 1 : 0}>
          {/* 文件头行 */}
          {group.file ? (
            <box backgroundColor={theme.panelAlt} paddingLeft={1} paddingRight={1} flexShrink={0}>
              <text fg={theme.warn} wrapMode="word"><b>{`▸ ${group.file}`}</b></text>
            </box>
          ) : null}
          {/* preamble 行（file=''）直接渲染 */}
          {!group.file ? group.lines.map((line, li) => (
            <Line key={`p-${gIdx}-${li}`} color={colorFor(line, theme)}>{line || ' '}</Line>
          )) : null}
          {/* header 元信息行 */}
          {group.header.map((line, hi) => (
            <Line key={`h-${gIdx}-${hi}`} color={colorFor(line, theme)}>{line}</Line>
          ))}
          {/* 内容行 */}
          {group.lines.map((line, li) => (
            <Line key={`c-${gIdx}-${li}`} color={colorFor(line, theme)} bold={line.startsWith('diff --git')}>{line || ' '}</Line>
          ))}
        </box>
      ))}

      {snapshot.truncated ? <Line color={theme.warn}>{zh ? 'Diff 已在源进程、文件采样或渲染预算处停止；Git 子进程已终止，不会继续在后台遍历。' : 'Diff stopped at a source, sampling, or render budget; the Git subprocess was terminated instead of continuing in the background.'}</Line> : null}
      {snapshot.truncationReasons?.map((reason) => <Line key={reason} color={theme.warn}>{`- ${reason}`}</Line>)}
    </box>
  );
}
