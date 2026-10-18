import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertRunId } from './ids.js';
import { isWithinBoundary } from './tool-boundary.js';

/**
 * 路径布局——模块单方定义的唯一新协议，随 schemaVersion 版本化。
 *
 * <managedRoot>/workflows/
 *   runs/<runId>/
 *     index.json       机器件：运行态索引（原子写）
 *     journal.jsonl    机器件：按行追加的调用账（单写者）
 *     snapshot.json    机器件：仅终态写
 *     terminal         终态标记（独占创建，最后写）
 *     agents/<id>.json 每路一个文件（原子写）
 *     bg/<id>.output   这一跑起出去的后台命令输出
 *     outbox/          待投递项
 *     digest           汇总产物
 *     reducer-waiter.json  等待位登记（同一 run 至多一个等待中的汇总体）
 *   saved/<name>.js    脚本持久化
 *   registry.json      run 注册表
 * <managedRoot>/worktrees/     写必隔离的隔离区（ADR-0052 §11，与 workflows/ 并列）
 *   registry.json      worktree 登记簿（创建即登记，机器件、版本化）
 *   <worktreeId>/      一路一个 worktree 本体（gitignored、不进 git 视野）
 *   .trash/            fence 中转位（删除先原子重命名到这里，只在删除期间存在）
 *   archive/           归档 bundle（可选自动归档开启时才有）
 *
 * managedRoot 默认落在工作区内的库内目录（三方可达：root / 汇总体 / 模块），
 * 且可整体重定向——测试把整棵树搬进临时目录。
 */

export type WorkflowPaths = {
  managedRoot: string;
  workflowsRoot: string;
  runsRoot: string;
  savedRoot: string;
  registryFile: string;
  /** 写必隔离的隔离区根（与 workflows/ 并列，同受 managedRoot 重定向）。 */
  worktreesRoot: string;
};

export type RunPaths = {
  dir: string;
  indexFile: string;
  journalFile: string;
  snapshotFile: string;
  terminalFile: string;
  outboxDir: string;
  agentsDir: string;
  digestFile: string;
  /** 等待位登记：独占创建，同一 run 至多一个等待中的汇总体。 */
  waiterFile: string;
  /** resume 排他锁（owner pid + epoch）：第二路续跑含另一会话一律拒（ADR-0052 §17）。 */
  lockFile: string;
  /** 这一跑起出去的后台命令，输出落在这里（独占创建、按字节帽截断）。 */
  bgDir: string;
};

/** 库内 managed 根：工作区目录下的隐藏目录。 */
export function managedRootFor(workspaceDir: string): string {
  return path.join(workspaceDir, '.myterminal');
}

export function workflowPaths(managedRoot: string): WorkflowPaths {
  const workflowsRoot = path.join(managedRoot, 'workflows');
  return {
    managedRoot,
    workflowsRoot,
    runsRoot: path.join(workflowsRoot, 'runs'),
    savedRoot: path.join(workflowsRoot, 'saved'),
    registryFile: path.join(workflowsRoot, 'registry.json'),
    worktreesRoot: worktreesRootFor(managedRoot),
  };
}

/**
 * 隔离区根：库内 managed 根下的 worktrees/（ADR-0052 §11）。
 * gitignored、不进 git 视野、root 与汇总体都读得到保留项。
 */
export function worktreesRootFor(managedRoot: string): string {
  return path.join(managedRoot, 'worktrees');
}

/** 一路的 worktree 本体路径。id 先过形态闸——它是拼进路径的字符串，与 runId 同族规矩。 */
export function worktreePathFor(worktreesRoot: string, id: string): string {
  assertWorktreeId(id);
  return path.join(worktreesRoot, id);
}

/** 候选路径是否落在隔离区内（含区根本身）：分隔符对齐判定，同名前缀的兄弟目录不算。 */
export function isInsideWorktreesRoot(managedRoot: string, candidate: string): boolean {
  return isWithinBoundary(path.resolve(candidate), worktreesRootFor(path.resolve(managedRoot)));
}

const WORKTREE_ID_PATTERN = /^wf_[0-9a-f]+-d\d{4}$/;

/** worktree id 形态闸：与 runId 同族规矩——它是拼进路径的字符串，不合形态即拒。 */
export function assertWorktreeId(value: unknown): string {
  if (typeof value !== 'string' || !WORKTREE_ID_PATTERN.test(value)) {
    throw new Error(`worktree id must match ${WORKTREE_ID_PATTERN.source}; received: ${String(value)}`);
  }
  return value;
}

/** run 目录与其下全部固定件。runId 先过形态闸，防路径穿越。 */
export function runPaths(paths: WorkflowPaths, runId: string): RunPaths {
  assertRunId(runId);
  const dir = path.join(paths.runsRoot, runId);
  return {
    dir,
    indexFile: path.join(dir, 'index.json'),
    journalFile: path.join(dir, 'journal.jsonl'),
    snapshotFile: path.join(dir, 'snapshot.json'),
    terminalFile: path.join(dir, 'terminal'),
    outboxDir: path.join(dir, 'outbox'),
    agentsDir: path.join(dir, 'agents'),
    digestFile: path.join(dir, 'digest'),
    waiterFile: path.join(dir, 'reducer-waiter.json'),
    lockFile: path.join(dir, 'resume.lock'),
    bgDir: path.join(dir, 'bg'),
  };
}

/** 每路文件路径。槽位名同样出自形态闸受控的编号。 */
export function agentFile(run: RunPaths, slot: string): string {
  if (!/^d\d{4}$/.test(slot)) throw new Error(`dispatch slot must be d####; received: ${slot}`);
  return path.join(run.agentsDir, `${slot}.json`);
}

/** scriptPath 白名单：只允许 saved 根内（含根自身），越出一律拒。 */
export function isInsideSavedRoot(paths: WorkflowPaths, candidate: string): boolean {
  const root = path.resolve(paths.savedRoot);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** 尾段上那个 ENOENT 的环节是不是悬空链接：lstat 得到、realpath 解不出，写新文件会顺着它落盘。 */
async function danglingLink(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 求一次真身：最深的那个已存在环节 realpath 解链，尚不存在的尾部件按字面接回去。
 *
 * 词法段挡得住 `../`，挡不住「界内的 symlink 指向界外」——saved/x.js -> /etc/passwd
 * 词法看干干净净，真身已经在根外。所以比对必须两端都求真身：根求真身、候选也求真身，
 * 只对其中一端求会得到 /var 与 /private/var 这类不可比的两种形态。
 * 尾段里的悬空链接同样不算「尚未存在」：写新文件会顺着链接落到链接目标那边去。
 * 解不出真身（链接成环、中间不是目录、尾段有悬空链接、到根都解不出）时返回 undefined：判不了就不放行。
 */
async function canonicalForm(target: string): Promise<string | undefined> {
  const absolute = path.resolve(target);
  let probe = absolute;
  const tail: string[] = [];
  const stuck: string[] = [];
  for (;;) {
    try {
      const real = await realpath(probe);
      for (const missing of stuck) {
        if (await danglingLink(missing)) return undefined;
      }
      return path.join(real, ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      const parent = path.dirname(probe);
      if (parent === probe) return undefined;
      stuck.unshift(probe);
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * saved 根的真身，同时验证它仍位于真实 workflowsRoot / managedRoot 边界内。
 * managedRoot 本身若是 symlink 则拒绝，避免把「受管理目录」整体指向外部；
 * 父 workspace 以 symlink 表示仍可用，因为 lstat 检查的是 managedRoot 本身。
 * savedRoot 自身的真身必须严格落在 workflowsRoot 真身之下：指向界外的链接（整根换成
 * symlink）与指向 workflowsRoot 自身的链接都不算 saved 根，一律 fail-closed。
 */
export async function canonicalSavedRoot(paths: WorkflowPaths): Promise<string | undefined> {
  try {
    if ((await lstat(paths.managedRoot)).isSymbolicLink()) return undefined;
  } catch (error) {
    // managedRoot 尚不存在时可以按字面尾段推导；其余错误按 fail-closed 处理。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
  }

  const managed = await canonicalForm(paths.managedRoot);
  const workflows = await canonicalForm(paths.workflowsRoot);
  const saved = await canonicalForm(paths.savedRoot);
  if (managed === undefined || workflows === undefined || saved === undefined) return undefined;
  if (!isWithinBoundary(workflows, managed)) return undefined;
  // saved 根必须严格深于 workflowsRoot 真身：`isWithinBoundary` 含根自身，
  // 若 savedRoot 自身被换成指向 workflowsRoot 的链接，两端真身相等仍判「界内」，
  // saved 域就塌成整个 workflows 域（registry.json / runs/** 都能当脚本读，脚本也能写进 workflows 根）。
  if (saved === workflows) return undefined;
  if (!isWithinBoundary(saved, workflows)) return undefined;
  return saved;
}

/**
 * 把候选路径归一到真身并判定是否仍在真根之内：界内返回真身绝对路径，界外返回 undefined。
 *
 * 读脚本用它取代「只判词法」：链接指向根外的 saved 脚本不算根内脚本。
 * 写脚本用它定真正落盘的对象：界内 symlink 目录 / 界外真身 / 新文件这条逃逸路由此堵上。
 */
export async function resolveInsideSavedRoot(
  paths: WorkflowPaths,
  candidate: string,
): Promise<string | undefined> {
  const root = await canonicalSavedRoot(paths);
  if (root === undefined) return undefined;
  const resolved = await canonicalForm(candidate);
  if (resolved === undefined) return undefined;
  return isWithinBoundary(resolved, root) ? resolved : undefined;
}
