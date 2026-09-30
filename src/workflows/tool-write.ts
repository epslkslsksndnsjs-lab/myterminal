import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

import { resolveToolPath } from './tool-boundary.js';
import { toolFailure, toolOk } from './tool-output.js';
import type { AgentTool, ToolContext } from './tool-face.js';

/**
 * 写类工具——只随隔离面出现，且自己就是第二道闸。
 *
 * 四条纪律：
 *   1. 写必隔离是工具面硬执行，不靠提示词：即使有人把写工具错放到了只读面上，
 *      工具自己按 context.mode 拒（reason=isolation-required），且一个字节都不落；
 *   2. 粒度与只读面同尺子：单动词、单目标、原子——write_file 写一个文件，
 *      apply_patch 改一处，都没有"顺手再改一个"的复合形态；
 *   3. 一切入站路径过双检闸（词法 + realpath）：越界、绝对路径指向界外、
 *      经界内 symlink 逃逸一律拒，主 checkout 与主 .git 因此摸不到；
 *   4. 返回结构化 JSON：写了多少字节、内容哈希、是新建还是覆盖，失败必有具名 reason。
 *
 * 覆盖写不做 expectedSha256 那一档乐观并发：worktree 是一路独占的边界，
 * 同一边界里没有第二个写者，加了只是把并发问题藏进参数面。
 */

/** 单次写入的字符上限：越界即拒，不给"一口气写进几百 MB"留口子。 */
export const MAX_WRITE_CONTENT_CHARS = 1_000_000;

/** 第二道闸：写工具只在 worktree 边界里落字节。 */
function refuseUnlessIsolated(context: ToolContext): ReturnType<typeof toolFailure> | undefined {
  if (context.mode === 'worktree') return undefined;
  return toolFailure(
    'Writes are only allowed on a path running inside its own git worktree (isolation: "worktree"). Nothing was written.',
    'isolation-required',
  );
}

/** 入站路径归一到界内绝对路径；越界带具名拒因回来。 */
function targetOf(input: Record<string, unknown>, context: ToolContext, field = 'path'): string | ReturnType<typeof toolFailure> {
  try {
    return resolveToolPath(input[field] ?? '.', context.cwd, field);
  } catch (error) {
    return toolFailure((error as Error).message, 'outside-boundary');
  }
}

function writtenOf(target: string, context: ToolContext, content: string): Record<string, unknown> {
  const bytes = Buffer.byteLength(content);
  return {
    path: path.relative(context.cwd, target).split(path.sep).join('/'),
    bytes,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

const writeFileTool: AgentTool = {
  name: 'write_file',
  write: true,
  description: 'Create or replace one UTF-8 file inside this path\'s worktree. Writes exactly one file per call and returns its byte count and content hash. Refused when the target resolves outside the worktree, and refused outright on a path that is not running isolated.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to write, absolute or relative to this path\'s worktree.' },
      content: { type: 'string', description: `Whole file content as UTF-8 text (at most ${MAX_WRITE_CONTENT_CHARS} characters).`, minLength: 1 },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async run(input, context) {
    const refusal = refuseUnlessIsolated(context);
    if (refusal) return refusal;
    const target = targetOf(input, context);
    if (typeof target !== 'string') return target;
    const content = input.content as string;
    if (content.length > MAX_WRITE_CONTENT_CHARS) {
      return toolFailure(`content is ${content.length} characters, over the ${MAX_WRITE_CONTENT_CHARS}-character write cap. Split it across files.`, 'content-too-large');
    }
    try {
      const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (info?.isDirectory()) return toolFailure(`"${input.path}" is a directory; write_file replaces files, not directories.`, 'is-a-directory');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      return toolOk({ ...writtenOf(target, context, content), created: info === undefined, overwritten: info !== undefined });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return toolFailure(`"${input.path}" cannot be written: permission denied.`, 'permission-denied');
      if (code === 'EISDIR') return toolFailure(`"${input.path}" is a directory; write_file replaces files, not directories.`, 'is-a-directory');
      return toolFailure(`Could not write "${String(input.path)}": ${(error as Error).message}`, 'write-failed');
    }
  },
};

const applyPatchTool: AgentTool = {
  name: 'apply_patch',
  write: true,
  description: 'Replace one exact string in one file inside this path\'s worktree. The old text must appear exactly once: no match and several matches are both refused and leave the file untouched. One edit per call — issue separate calls for separate edits.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit, absolute or relative to this path\'s worktree.' },
      oldText: { type: 'string', description: 'Exact text to replace. Must appear once and only once.', minLength: 1 },
      newText: { type: 'string', description: 'Replacement text (an empty string deletes the match).' },
    },
    required: ['path', 'oldText', 'newText'],
    additionalProperties: false,
  },
  async run(input, context) {
    const refusal = refuseUnlessIsolated(context);
    if (refusal) return refusal;
    const target = targetOf(input, context);
    if (typeof target !== 'string') return target;
    const oldText = input.oldText as string;
    const newText = input.newText as string;
    let current: string;
    try {
      current = await readFile(target, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return toolFailure(`File not found: "${String(input.path)}". Write it first with write_file.`, 'not-found');
      return toolFailure(`Could not read "${String(input.path)}": ${(error as Error).message}`, 'read-failed');
    }
    // 计数用 indexOf 循环，不用正则——模型给的文本里任何正则元字符都只是字面量。
    let matches = 0;
    for (let cursor = current.indexOf(oldText); cursor !== -1; cursor = current.indexOf(oldText, cursor + oldText.length)) {
      matches++;
      if (matches > 1) break;
    }
    if (matches === 0) return toolFailure(`oldText was not found in "${String(input.path)}". Read the file and copy the exact text.`, 'patch-no-match');
    if (matches > 1) {
      return toolFailure(`oldText appears more than once in "${String(input.path)}"; the edit is ambiguous. Widen it with surrounding lines.`, 'patch-ambiguous');
    }
    const updated = current.replace(oldText, () => newText);
    try {
      await writeFile(target, updated, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return toolFailure(`"${input.path}" cannot be written: permission denied.`, 'permission-denied');
      return toolFailure(`Could not write "${String(input.path)}": ${(error as Error).message}`, 'write-failed');
    }
    return toolOk({ ...writtenOf(target, context, updated), replacements: 1 });
  },
};

export const WRITE_TOOLS: readonly AgentTool[] = [writeFileTool, applyPatchTool];
