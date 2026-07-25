/**
 * diff-groups — Diff 输出按文件分组（ADR-0004 决策 7）。
 * 以 `diff --git a/<old> b/<new>` 行切分，提取文件路径、元信息头、内容行。
 * 纯函数，无副作用，可单测。
 */
export type DiffGroup = {
  /** `b/` 后的文件路径；不属于任何文件的头部行归入 file='' 的组 */
  file: string;
  /** index / --- / +++ 等元信息行 */
  header: string[];
  /** @@ 与 +/- 内容行 */
  lines: string[];
};

const DIFF_GIT_PREFIX = 'diff --git ';

function extractFile(line: string): string {
  // "diff --git a/path/to/file b/path/to/file"
  const bIdx = line.indexOf(' b/');
  if (bIdx === -1) return '';
  return line.slice(bIdx + 3);
}

export function groupDiffLines(lines: string[]): DiffGroup[] {
  if (!lines.length) return [];

  const groups: DiffGroup[] = [];
  let current: DiffGroup | null = null;

  // 不属于任何文件的头部行（如 warning: 类）归入 file='' 的组
  let preamble: string[] = [];

  for (const line of lines) {
    if (line.startsWith(DIFF_GIT_PREFIX)) {
      // 遇到新的 diff --git：把之前的 preamble 刷入一个空文件组
      if (preamble.length) {
        groups.push({ file: '', header: [], lines: preamble });
        preamble = [];
      }
      // 开始新组
      current = { file: extractFile(line), header: [], lines: [] };
      groups.push(current);
    } else if (current) {
      // 在已有的组内：@@ 和 +/- 是内容行，index/---/+++ 是头部元信息
      if (line.startsWith('@@')) {
        current.lines.push(line);
      } else if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
        current.header.push(line);
      } else {
        // +/- 内容行，或其他不属于头部的行
        current.lines.push(line);
      }
    } else {
      // 第一个 diff --git 之前的内容
      preamble.push(line);
    }
  }

  // 末尾剩余的 preamble
  if (preamble.length) {
    groups.push({ file: '', header: [], lines: preamble });
  }

  return groups;
}
