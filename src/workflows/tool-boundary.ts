import path from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * 工具路径的边界闸——词法段与 realpath 段各自成立，两段都在本模块里。
 *
 * 为什么两段都要：
 *   词法段（拼路径 + 相对化判越界）挡得住 `../` 与绝对路径直书；
 *   但界内的 symlink 可以指向界外，词法看完全干净、真身已经在外面——所以 realpath 段
 *   必须把两端都求次实路径再相对化比一次。
 * 目标尚不存在（写新文件是正当动作）时不代表没得查：realpath 段查的是它**最深的那个已存在祖先**，
 * 祖先在界外即拒。只有整条链都不存在（含边界本身未落盘）才退回词法判定——那不是放行，是第二段无从可比。
 *
 * 归属边界 = 这一跑的 cwd（只读面是工作区，隔离面是那一跑的 worktree），不是宿主进程目录。
 */

export class ToolBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolBoundaryError';
  }
}

/** 分隔符对齐的界内判定：字符串包含会把 `<root>-evil` 算成界内。 */
export function isWithinBoundary(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function escapes(root: string, candidate: string): boolean {
  return !isWithinBoundary(candidate, root);
}

/**
 * 把模型给的路径归一到界内绝对路径；任何一段不过即拒。
 * field 进错误文案，让模型知道改哪个入参；不给"要不要试试别的路径"这类暗示。
 */
export function resolveToolPath(value: unknown, cwd: string, field = 'path'): string {
  if (typeof value !== 'string' || !value.trim() || /[\n\r\u0000-\u001f]/.test(value)) {
    throw new ToolBoundaryError(`${field} must be a non-empty string without control characters.`);
  }
  const resolved = path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd, value));
  if (escapes(cwd, resolved)) {
    throw new ToolBoundaryError(`${field} "${value}" is outside the working directory "${cwd}".`);
  }
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    // 连边界自己都没有真身（尚未落盘的目录）：第二段无从可比，词法段就是全部判定。
    return resolved;
  }
  // 求次实的对象是"最深的那个已存在环节"：写新文件时目标本身还不存在，但它的父目录在不在界外
  // 是可以问磁盘的。只问目标存不存在就会放过"界内 symlink 目录 / 界外真身 / 新文件"这条逃逸路。
  const deepest = deepestExisting(resolved);
  if (deepest === undefined) return resolved;
  const realTarget = realpathSync(deepest);
  if (escapes(realCwd, realTarget)) {
    const via = deepest === resolved ? 'a symlink' : `a symlink or mount point at "${deepest}"`;
    throw new ToolBoundaryError(`${field} "${value}" reaches outside the working directory through ${via} (real path "${realTarget}").`);
  }
  return resolved;
}

/** 从目标往上找到第一个真实存在的环节；整条链都不存在时返回 undefined。 */
function deepestExisting(target: string): string | undefined {
  let probe = target;
  for (;;) {
    try {
      realpathSync(probe);
      return probe;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return undefined;
      probe = parent;
    }
  }
}
