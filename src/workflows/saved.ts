import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  isInsideSavedRoot,
  resolveInsideSavedRoot,
  type WorkflowPaths,
} from './paths.js';

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

/**
 * 候选名序列：meta 名优先，撞车后退回 runId 命名，再退到 `<runId>-2`、`-3`…
 * 这里只定顺序、不探盘——名字是否真空闲，交给独占创建当场裁决。
 */
function* candidateNames(base: string, fallbackName: string): Generator<string> {
  yield base;
  if (fallbackName !== base) yield fallbackName;
  for (let n = 2; n < 1_000; n += 1) yield `${fallbackName}-${n}`;
}

/**
 * 写目标先归一：真身必须仍在真根之内，否则绝不落盘。
 *
 * 词法路径（`savedRoot/<name>.js`）仍是对外身份与返回值，真身才是真正读写的对象——
 * 界内的 symlink 目录、指向根外的同名链接、悬空链接都会在这一步被拦下。
 */
async function confirmedInside(paths: WorkflowPaths, candidate: string): Promise<string> {
  const canonical = await resolveInsideSavedRoot(paths, candidate);
  if (canonical === undefined) {
    throw new Error(`saved script path is not inside the saved root: ${candidate}`);
  }
  return canonical;
}

/**
 * 独占创建并写入：O_CREAT|O_EXCL 让"判定这个名字还空着"与"占住这个名字"成为同一个原子动作，
 * 并发同名时只有一个写者能拿到名字，后来者得到 EEXIST 而不是盖掉别人刚写下的内容。
 * 权限位在创建时一次给定，不与随后写入分家。
 */
async function writeExclusive(file: string, source: string): Promise<'created' | 'taken'> {
  // 先在同目录把完整内容写进唯一临时文件，再用 hard link 原子占用最终名字。
  // 不能直接 open(file, 'wx') 后慢慢写：EEXIST 竞争者可能读到空文件/半截内容，
  // 把同内容误判为不同内容并创建多份副本。
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(source, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      // 临时文件与目标在同一目录/文件系统；link 只在目标不存在时成功。
      // 目标名从可见的第一刻起就是完整内容，竞争者不会观察到半写状态。
      await link(temporary, file);
      return 'created';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'taken';
      throw error;
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/**
 * 持久化一份脚本。返回落盘绝对路径与脚本引用（id = 相对 saved 根的路径，
 * revision = 内容哈希前 16 位——内容变了引用就变，续跑据此判同源）。
 *
 * 撞名处理：候选名一个个试独占创建，抢到即落盘；名字已被别人占住时，同内容就算复用
 * （引用照样指向那个文件），不同内容换下一个候选名重试——任何已存在的脚本都不会被覆盖。
 */
export async function persistScript(paths: WorkflowPaths, source: string, fallbackName: string): Promise<SavedScript> {
  const base = scriptMetaName(source) ?? fallbackName;
  const revision = sha256(source).slice(0, 16);
  // 先核真身、后建目录：拒绝越界路径不能留下根外目录副作用。
  await confirmedInside(paths, path.join(paths.savedRoot, `${base}.js`));
  await mkdir(paths.savedRoot, { recursive: true });

  for (const name of candidateNames(base, fallbackName)) {
    const target = path.join(paths.savedRoot, `${name}.js`);
    // 每个候选名落盘前都重核真身：撞名的原因可能就是根内挂了个指向根外的同名链接。
    const settled = await confirmedInside(paths, target);
    const saved: SavedScript = { name, path: target, content: source, sourceRef: { id: `${name}.js`, revision } };

    if ((await writeExclusive(settled, source)) === 'created') return saved;

    let existing: string;
    try {
      existing = await readFile(settled, 'utf8');
    } catch (error) {
      // 判定与创建之间文件被删掉：名字又空了出来，换下一个候选名继续，绝不回头覆盖别人。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (existing === source) return saved;
  }
  throw new Error(`could not persist script after repeated filename conflicts: ${base}`);
}

export type LoadResult =
  | { ok: true; content: string; path: string; sourceRef: { id: string; revision: string } }
  | { ok: false; reason: 'outside-root' | 'not-found' | 'unreadable' };

/** 按 scriptPath 读脚本：先过词法白名单，再核真身，最后读盘。越界一律拒，不降级成 not-found。 */
export async function loadScript(paths: WorkflowPaths, scriptPath: string): Promise<LoadResult> {
  if (typeof scriptPath !== 'string' || !scriptPath.trim()) return { ok: false, reason: 'outside-root' };
  if (!isInsideSavedRoot(paths, scriptPath)) return { ok: false, reason: 'outside-root' };
  // 词法干净不等于根内：saved/x.js 可以是指向根外的链接。读的那个真身必须仍在真根之内。
  const canonical = await resolveInsideSavedRoot(paths, scriptPath);
  if (canonical === undefined) return { ok: false, reason: 'outside-root' };
  const resolved = path.resolve(scriptPath);
  let content: string;
  try {
    content = await readFile(canonical, 'utf8');
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'unreadable' };
  }
  // id 仍取词法相对路径：脚本引用是持久身份，换成真身会让 /var 与 /private/var 这类前缀分裂成两个脚本。
  const id = path.relative(paths.savedRoot, resolved);
  return { ok: true, content, path: resolved, sourceRef: { id, revision: sha256(content).slice(0, 16) } };
}
