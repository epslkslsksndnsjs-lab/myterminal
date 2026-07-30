// #52 单源：walkFiles + IGNORE_DIRECTORIES 收敛（ADR-0031 G9 / 批5 #60 的地基）
//
// 历史：walkFiles 曾在 src/core-tools.ts、src/subagent/tools.ts、src/subagent/grep-utils.ts
// 各有一份，IGNORE_DIRECTORIES 也各维护一份且已漂移（core-tools 7 项、subagent 两处 9 项，
// 缺 build/.cache），导致不同工具对同一目录遍历结果不一致。本模块为唯一真相源。
//
// 约定：walkFiles 返回【绝对路径】；调用方如需相对路径自行 relative()。unreadable 目录跳过不抛。

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// 统一忽略目录（唯一真相源）。超集 9 项：core-tools 原 7 项 + subagent 两处补的 build/.cache。
// 改忽略规则只改这一处。
export const IGNORE_DIRECTORIES = new Set([
  '.git', '.myterminal', 'node_modules', 'dist', 'coverage', '.next', '.turbo',
  'build', '.cache',
]);

// 递归遍历 root 下所有文件，跳过 IGNORE_DIRECTORIES 与不可读目录。
// 返回绝对路径；opts.limit 限制返回条数（默认不限制）。
export async function walkFiles(root: string, opts: { limit?: number } = {}): Promise<string[]> {
  const limit = opts.limit ?? Infinity;
  const files: string[] = [];
  const queue = [resolve(root)];

  while (queue.length > 0 && files.length < limit) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue; // 跳过不可读目录
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRECTORIES.has(entry.name)) continue;
        queue.push(join(current, entry.name));
      } else if (entry.isFile()) {
        files.push(join(current, entry.name));
      }
      if (files.length >= limit) break;
    }
  }

  return files;
}
