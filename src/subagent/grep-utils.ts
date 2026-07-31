// ADR-0007 决策 33/34：grep 引擎——递归遍历 + ignore + include 过滤 + maxMatches 截断
// 不引 npm 库，手动实现 glob→regex 转换
// #60（批5 第5刀 / ADR-0032）：抽 matchInFiles 纯核心，注入 fs seam，踩 #52 walkFiles 单源

import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { walkFiles } from '../utils/fs.js';

// 决策 34：grep 默认截断上限
const DEFAULT_MAX_MATCHES = 200;

export type GrepMatch = {
  path: string;
  line: number;
  text: string;
};

export type GrepResult = {
  results: GrepMatch[];
  totalMatches: number;
  truncated: boolean;
};

// 简单 glob→regex 转换（决策规定：*→[^/]*、**→.*、?→[^/]）
function includePatternToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        regexStr += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        regexStr += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else if (ch === '.') {
      regexStr += '\\.';
      i++;
    } else if ('\\^$+{}[]()|'.includes(ch)) {
      regexStr += '\\' + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }
  // ADR-0021: 锚定 ^...$ 防止 *.ts 误匹配 .tsx/.ts.bak
  return new RegExp(`^${regexStr}$`);
}

/**
 * 纯核心：在给定文件列表上执行正则匹配 + 聚合。
 * 无 node:fs 依赖——通过注入 read 函数实现 IO 解耦（#60 seam）。
 *
 * @param files - 绝对路径列表（由 walkFiles 或测试 fake 提供）
 * @param read - 注入的文件读取函数 (absPath) => content
 * @param pattern - 正则表达式字符串
 * @param opts.baseDir - 计算相对路径的基准目录
 * @param opts.include - 文件名 glob 过滤（如 "*.ts"）
 * @param opts.maxMatches - 收集匹配上限（默认 200）
 */
export async function matchInFiles(
  files: string[],
  read: (absPath: string) => Promise<string>,
  pattern: string,
  opts?: { baseDir: string; include?: string; maxMatches?: number },
): Promise<GrepResult> {
  const maxMatches = opts?.maxMatches ?? DEFAULT_MAX_MATCHES;
  const baseDir = opts?.baseDir ?? '';
  const includeRegex = opts?.include ? includePatternToRegex(opts.include) : null;
  const regex = new RegExp(pattern);

  const results: GrepMatch[] = [];
  let totalMatches = 0;
  let truncated = false;

  for (const absPath of files) {
    if (truncated) break;

    const relPath = relative(baseDir, absPath).replace(/\\/g, '/');

    // include 过滤
    if (includeRegex && !includeRegex.test(relPath)) continue;

    try {
      const content = await read(absPath);
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxMatches) {
          // 继续统计剩余匹配数（决策 34：标注真实总数）
          totalMatches++;
          truncated = true;
          continue;
        }

        if (regex.test(lines[i])) {
          results.push({ path: relPath, line: i + 1, text: lines[i].slice(0, 500) });
          totalMatches++;
        }
      }
    } catch {
      // 跳过不可读文件
      continue;
    }
  }

  return { results, totalMatches, truncated };
}

/**
 * 在 searchDir 下递归搜索匹配正则 pattern 的行。
 * 薄适配器：walkFiles（#52 单源）遍历 + matchInFiles 纯核心匹配。
 *
 * @param pattern - 正则表达式字符串
 * @param searchDir - 搜索根目录
 * @param opts.include - 文件名 glob 过滤（如 "*.ts"）
 * @param opts.maxMatches - 收集匹配上限（默认 MAX_GREP_MATCHES=200）
 * @returns 匹配结果 + 是否截断
 */
export async function createGrep(
  pattern: string,
  searchDir: string,
  opts?: { include?: string; maxMatches?: number },
): Promise<GrepResult> {
  // 编译正则——非法时抛友好错误（在 walkFiles 之前 fail-fast）
  try {
    new RegExp(pattern);
  } catch {
    throw new Error(`Invalid regular expression: ${pattern}`);
  }

  const allFiles = await walkFiles(searchDir);
  return matchInFiles(allFiles, (p) => readFile(p, 'utf-8'), pattern, {
    baseDir: searchDir,
    include: opts?.include,
    maxMatches: opts?.maxMatches,
  });
}
