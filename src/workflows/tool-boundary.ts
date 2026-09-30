import path from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * 工具路径的边界闸——词法段与 realpath 段各自成立，两段都在本模块里。
 *
 * 为什么两段都要：
 *   词法段（拼路径 + 相对化判越界）挡得住 `../` 与绝对路径直书；
 *   但界内的 symlink 可以指向界外，词法看完全干净、真身已经在外面——所以 realpath 段
 *   必须把两端都求次实路径再相对化比一次。
 * 目标尚不存在时 realpath 无从求起（新文件是正当写入目标），此时退回词法判定；
 * 词法已经过关才允许这么退，绝不反过来放越界。
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
  let realTarget: string;
  let realCwd: string;
  try {
    realTarget = realpathSync(resolved);
    realCwd = realpathSync(cwd);
  } catch {
    // 至少一端还没有真身（新建文件是正当的写入目标，realpath 无从求起）：
    // 此时词法段就是唯一可做的判定，放过它——不是静默，是没有第二段可比。
    return resolved;
  }
  if (escapes(realCwd, realTarget)) {
    throw new ToolBoundaryError(`${field} "${value}" reaches outside the working directory through a symlink (real path "${realTarget}").`);
  }
  return resolved;
}
