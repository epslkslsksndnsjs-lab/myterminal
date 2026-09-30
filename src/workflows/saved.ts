import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isInsideSavedRoot, type WorkflowPaths } from './paths.js';

/**
 * 脚本持久化与复用。
 *
 * saved 根是 scriptPath 的唯一受信任域：越出即拒，绝不按裸字符串去读盘。
 * 命名 = `<name>.js`——内联脚本取脚本内 meta 的 name，取不到就用 runId；
 * 同名已存在且内容不同时退回 runId 命名，绝不覆盖已有脚本（不丢工作）。
 */

export const SCRIPT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;

export type SavedScript = {
  name: string;
  path: string;
  content: string;
  /** 脚本引用：路径即身份，内容编辑不改引用。 */
  sourceRef: { id: string; revision: string };
};

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 读脚本里 `export const meta = { ... }` 的 name——纯字面量扫描，不执行脚本。
 * 取不到或不是合法命名就返回 undefined，由调用方退回 runId。
 */
export function scriptMetaName(source: string): string | undefined {
  const head = source.slice(0, 2000);
  const match = /^\s*export\s+const\s+meta\s*=\s*\{/.exec(head);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const block = head.slice(start, start + 1000);
  const name = /['"]?\s*name\s*['"]?\s*:\s*['"]([A-Za-z0-9._-]{1,64})['"]/.exec(block);
  const candidate = name?.[1];
  if (!candidate) return undefined;
  return SCRIPT_NAME_PATTERN.test(candidate) ? candidate : undefined;
}

function uniqueName(savedRoot: string, base: string, taken: Set<string>): string {
  if (!taken.has(`${base}.js`)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(`${candidate}.js`)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 持久化一份脚本。返回落盘绝对路径与脚本引用（id = 相对 saved 根的路径，
 * revision = 内容哈希前 16 位——内容变了引用就变，续跑据此判同源）。
 */
export async function persistScript(paths: WorkflowPaths, source: string, fallbackName: string): Promise<SavedScript> {
  await mkdir(paths.savedRoot, { recursive: true });
  const base = scriptMetaName(source) ?? fallbackName;
  const file = path.join(paths.savedRoot, `${base}.js`);
  const revision = sha256(source).slice(0, 16);
  let target = file;
  let name = base;
  try {
    const existing = await readFile(file, 'utf8');
    if (existing === source) {
      return { name: base, path: file, content: source, sourceRef: { id: `${base}.js`, revision } };
    }
    // 同名但内容不同：退回唯一名，已有脚本一动不动。
    const { readdir } = await import('node:fs/promises');
    const taken = new Set(await readdir(paths.savedRoot));
    name = uniqueName(paths.savedRoot, fallbackName, taken);
    target = path.join(paths.savedRoot, `${name}.js`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(target, source, { mode: 0o600 });
  return { name, path: target, content: source, sourceRef: { id: `${name}.js`, revision } };
}

export type LoadResult =
  | { ok: true; content: string; path: string; sourceRef: { id: string; revision: string } }
  | { ok: false; reason: 'outside-root' | 'not-found' | 'unreadable' };

/** 按 scriptPath 读脚本：先过白名单，再读盘。越界一律拒，不降级成 not-found。 */
export async function loadScript(paths: WorkflowPaths, scriptPath: string): Promise<LoadResult> {
  if (typeof scriptPath !== 'string' || !scriptPath.trim()) return { ok: false, reason: 'outside-root' };
  if (!isInsideSavedRoot(paths, scriptPath)) return { ok: false, reason: 'outside-root' };
  const resolved = path.resolve(scriptPath);
  let content: string;
  try {
    content = await readFile(resolved, 'utf8');
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'unreadable' };
  }
  const id = path.relative(paths.savedRoot, resolved);
  return { ok: true, content, path: resolved, sourceRef: { id, revision: sha256(content).slice(0, 16) } };
}
