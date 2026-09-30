import fs from 'node:fs';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { resolveToolPath } from './tool-boundary.js';
import { toolFailure, toolOk, boundText, MAX_TOOL_RESULT_CHARS } from './tool-output.js';
import type { ToolPayload } from './tool-output.js';
import type { AgentTool } from './tool-face.js';

/**
 * 只读文件工具集——读 / 读段 / 列目录 / 找文件 / 搜文本。
 *
 * 五条纪律：
 *   1. 一个动词、一个目标：读整份与读段是两个工具，不把 offset/limit 做成读整份的隐藏形态；
 *   2. 一切入站路径过双检闸（词法 + realpath），越界与 symlink 逃逸即拒；
 *   3. 有界 + 显式截断：文本字段带 chars / shown / truncated 三个读数；
 *   4. 失败具名：不存在、是目录、像二进制、正则非法各有 reason，绝不返回空结果冒充成功；
 *   5. 遍历一律跳开 IGNORED_DIRECTORIES：版本库对象、依赖目录、构建产物与模块自己的账本
 *      都不进搜索结果——几十路并发各自扫全仓时，这些目录只会烧钱并产出噪声。
 */

/** 结果列表的条数上限（找文件 / 搜文本 / 列目录共用一把尺）。 */
export const MAX_LIST_ENTRIES = 200;
/** 单条搜索命中的文本上限：命中行再长也只给这么多个字符。 */
export const MAX_MATCH_LINE_CHARS = 500;
/** 读段默认行数。 */
export const DEFAULT_READ_LINE_COUNT = 2_000;
/** 搜索跳过的单文件字节上限：整份读入的成本由调用方按行段自己决定，被跳过的条数进结果。 */
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

export const IGNORED_DIRECTORIES: readonly string[] = ['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '__pycache__', '.venv', 'venv', '.myterminal'];

const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg', '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp3', '.mp4', '.avi', '.mov', '.webm', '.wav', '.flac',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.class', '.jar', '.wasm', '.pyc', '.sqlite', '.db',
];

function looksBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/**
 * 把入站路径归一到界内绝对路径。resolveToolPath 只抛 ToolBoundaryError 一种错误，
 * 所以这里一条出口：拒因照实回，不分类、不静默降级。
 */
function targetOf(input: Record<string, unknown>, cwd: string, field = 'path'): string | ToolPayload {
  try {
    return resolveToolPath(input[field] ?? '.', cwd, field);
  } catch (error) {
    return toolFailure((error as Error).message, 'outside-boundary');
  }
}

/** glob 形状转正则：`**` 跨目录、`*` 不跨、`?` 单字符，其余按字面。 */
export function globToRegex(pattern: string): RegExp {
  let out = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index++;
        if (pattern[index + 1] === '/') {
          index++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    if ('.^$+{}()|[]\\'.includes(char)) out += `\\${char}`;
    else out += char;
  }
  return new RegExp(`${out}$`);
}

/** 深度遍历文件（相对 root 的正斜杠路径），跳开被忽略的目录与符号链接目录。 */
export function walkFiles(root: string, limit = MAX_LIST_ENTRIES * 20): string[] {
  const found: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.includes(entry.name) || entry.isSymbolicLink()) continue;
        stack.push(full);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      found.push(path.relative(root, full).split(path.sep).join('/'));
      if (found.length >= limit) return found;
    }
  }
  return found.sort();
}

/** 读整份文本（有界）。分段读是另一个工具，不靠这里的隐藏参数。 */
const readFileTool: AgentTool = {
  name: 'read_file',
  target: 'file',
  write: false,
  description: 'Read a whole text file inside this path\'s working directory. Returns bounded text; large files come back truncated with explicit counts, so read a line range instead. Fails on directories and on files that look binary.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File to read, absolute or relative to the working directory.' } },
    required: ['path'],
    additionalProperties: false,
  },
  async run(input, context) {
    const target = targetOf(input, context.cwd);
    if (isPayload(target)) return target;
    if (looksBinary(target)) return toolFailure(`"${input.path}" looks like a binary file; this tool returns text only.`, 'binary-file');
    let content: string;
    try {
      const info = await stat(target);
      if (info.isDirectory()) return toolFailure(`"${input.path}" is a directory. Use list_dir instead.`, 'is-directory');
      content = await readFile(target, 'utf8');
    } catch (error) {
      return describeReadError(input.path, error);
    }
    const bounded = boundText(content);
    return toolOk({ ...bounded, totalLines: countLines(content) });
  },
};

/** 按行读一段（1 基行号，带行号前缀输出）。 */
const readFileRangeTool: AgentTool = {
  name: 'read_file_range',
  target: 'file',
  write: false,
  description: 'Read a line range of a text file, returning lines prefixed with their 1-based numbers. Use this instead of read_file for large files, and move firstLine to page forward.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to read.' },
      firstLine: { type: 'integer', description: 'First line to return, 1-based. Defaults to 1.' },
      lineCount: { type: 'integer', description: `How many lines to return. Defaults to ${DEFAULT_READ_LINE_COUNT}.` },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async run(input, context) {
    const target = targetOf(input, context.cwd);
    if (isPayload(target)) return target;
    if (typeof input.firstLine !== 'undefined' && (typeof input.firstLine !== 'number' || !Number.isInteger(input.firstLine) || input.firstLine < 1)) {
      return toolFailure('firstLine must be an integer of 1 or more.', 'bad-line-range');
    }
    if (typeof input.lineCount !== 'undefined' && (typeof input.lineCount !== 'number' || !Number.isInteger(input.lineCount) || input.lineCount < 1)) {
      return toolFailure('lineCount must be an integer of 1 or more.', 'bad-line-range');
    }
    let content: string;
    try {
      const info = await stat(target);
      if (info.isDirectory()) return toolFailure(`"${input.path}" is a directory. Use list_dir instead.`, 'is-directory');
      content = await readFile(target, 'utf8');
    } catch (error) {
      return describeReadError(input.path, error);
    }
    const lines = content.split('\n');
    const from = Math.max(0, Math.floor((input.firstLine as number | undefined) ?? 1) - 1);
    const count = Math.floor((input.lineCount as number | undefined) ?? DEFAULT_READ_LINE_COUNT);
    const taken = lines.slice(from, from + count);
    const numbered = taken.map((line, index) => `${from + index + 1}\t${line}`).join('\n');
    const bounded = boundText(numbered);
    return toolOk({
      ...bounded,
      totalLines: lines.length,
      firstLine: from + 1,
      lastLine: from + taken.length,
      hasMore: from + taken.length < lines.length,
    });
  },
};

/** 列一个目录。 */
const listDirTool: AgentTool = {
  name: 'list_dir',
  target: 'directory',
  write: false,
  description: 'List one directory: files and subdirectories, each with its size, sorted by name. Lists exactly one level — recurse with find_files instead.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory to list. Defaults to the working directory.' } },
    additionalProperties: false,
  },
  async run(input, context) {
    const target = targetOf(input, context.cwd);
    if (isPayload(target)) return target;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return toolFailure(`Directory not found: "${input.path ?? '.'}".`, 'not-found');
      if (code === 'ENOTDIR') return toolFailure(`"${input.path}" is not a directory. Use read_file for a file.`, 'not-a-directory');
      return toolFailure(`Could not list "${input.path ?? '.'}": ${(error as Error).message}`, 'list-failed');
    }
    const rows = entries
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => rowFor(target, entry));
    const shown = rows.slice(0, MAX_LIST_ENTRIES);
    return toolOk({ entries: shown.join('\n'), entryCount: rows.length, truncated: rows.length > shown.length, limit: MAX_LIST_ENTRIES });
  },
};

function rowFor(directory: string, entry: fs.Dirent): string {
  if (entry.isSymbolicLink()) return `${entry.name} -> (link)`;
  if (entry.isDirectory()) return `${entry.name}/`;
  try {
    return `${entry.name} (${fs.statSync(path.join(directory, entry.name)).size} bytes)`;
  } catch {
    return entry.name;
  }
}

/** 按 glob 找文件。 */
const findFilesTool: AgentTool = {
  name: 'find_files',
  target: 'directory',
  write: false,
  description: 'Find files by a glob pattern under a directory, returning paths relative to that directory. Returns at most a bounded number of hits — narrow the pattern rather than paging.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob such as "src/**/*.ts" or "*.md". "**" crosses directories, "*" does not.' },
      path: { type: 'string', description: 'Directory to search. Defaults to the working directory.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async run(input, context) {
    const target = targetOf(input, context.cwd);
    if (isPayload(target)) return target;
    if (typeof input.pattern !== 'string' || !input.pattern.trim()) return toolFailure('pattern must be a non-empty glob.', 'bad-pattern');
    // globToRegex 对任何输入都能出形（特殊字符逐个转义），这里不设兜底分支。
    const regex = globToRegex(input.pattern.split(path.sep).join('/'));
    const matches = walkFiles(target).filter((file) => regex.test(file));
    const shown = matches.slice(0, MAX_LIST_ENTRIES);
    return toolOk({ files: shown.join('\n'), matchCount: matches.length, truncated: matches.length > shown.length, limit: MAX_LIST_ENTRIES });
  },
};

/** 按正则搜文本。 */
const searchTextTool: AgentTool = {
  name: 'search_text',
  target: 'directory',
  write: false,
  description: 'Search text under a directory with a regular expression, returning "file:line:text" rows. Each row is capped and the match list is capped, so a truncated result means the pattern is too wide.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression, matched per line.' },
      path: { type: 'string', description: 'Directory to search. Defaults to the working directory.' },
      glob: { type: 'string', description: 'Optional file-name glob to restrict the search, e.g. "src/**/*.ts".' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async run(input, context) {
    const target = targetOf(input, context.cwd);
    if (isPayload(target)) return target;
    if (typeof input.pattern !== 'string' || !input.pattern) return toolFailure('pattern must be a non-empty regular expression.', 'bad-regex');
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (error) {
      return toolFailure(`Invalid regular expression ${JSON.stringify(input.pattern)}: ${(error as Error).message}`, 'bad-regex');
    }
    let fileFilter: RegExp | undefined;
    if (input.glob !== undefined) {
      if (typeof input.glob !== 'string' || !input.glob.trim()) return toolFailure('glob must be a non-empty pattern when given.', 'bad-pattern');
      fileFilter = globToRegex(input.glob.split(path.sep).join('/'));
    }
    const info = await stat(target).catch(() => undefined);
    if (!info) return toolFailure(`Path not found: "${input.path ?? '.'}".`, 'not-found');
    const files = info.isDirectory() ? walkFiles(target) : [path.basename(target)];
    const root = info.isDirectory() ? target : path.dirname(target);
    const rows: string[] = [];
    let skipped = 0;
    for (const file of files) {
      if (fileFilter && !fileFilter.test(file)) continue;
      const absolute = path.join(root, file);
      let content: string;
      try {
        if (looksBinary(absolute)) {
          skipped++;
          continue;
        }
        if (fs.statSync(absolute).size > MAX_SEARCH_FILE_BYTES) {
          // 超大文件不进搜索：读它的成本由调用方按行段自己决定，但少了哪些要报出来。
          skipped++;
          continue;
        }
        content = fs.readFileSync(absolute, 'utf8');
      } catch {
        skipped++;
        continue;
      }
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index++) {
        if (!regex.test(lines[index])) continue;
        rows.push(`${file}:${index + 1}:${lines[index].slice(0, MAX_MATCH_LINE_CHARS)}`);
        if (rows.length >= MAX_LIST_ENTRIES) break;
      }
      if (rows.length >= MAX_LIST_ENTRIES) break;
    }
    const bounded = boundText(rows.join('\n'));
    return toolOk({
      ...bounded,
      matchCount: rows.length,
      truncated: rows.length >= MAX_LIST_ENTRIES || bounded.truncated,
      limit: MAX_LIST_ENTRIES,
      skippedFiles: skipped,
    });
  },
};

function describeReadError(path: unknown, error: unknown): ToolPayload {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return toolFailure(`File not found: "${String(path)}".`, 'not-found');
  if (code === 'EACCES' || code === 'EPERM') return toolFailure(`"${String(path)}" cannot be read: permission denied.`, 'permission-denied');
  return toolFailure(`Could not read "${String(path)}": ${(error as Error).message}`, 'read-failed');
}

function countLines(content: string): number {
  return content.split('\n').length;
}

function isPayload(value: string | ToolPayload): value is ToolPayload {
  return typeof value !== 'string';
}

/** 只读面的工具表（写类工具随隔离票交付）。 */
export const READ_ONLY_TOOLS: readonly AgentTool[] = [readFileTool, readFileRangeTool, listDirTool, findFilesTool, searchTextTool];
