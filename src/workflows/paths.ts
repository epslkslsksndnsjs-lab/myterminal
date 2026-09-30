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

/** 一路的 worktree 本体路径。id 已过形态闸（runId + 槽位），不在此处再拼模型可控串。 */
export function worktreePathFor(managedRoot: string, id: string): string {
  assertWorktreeId(id);
  return path.join(worktreesRootFor(managedRoot), id);
}

const WORKTREE_ID_PATTERN = /^wf_[0-9a-f]+-d\d{4}$/;

/** worktree id 形态闸：与 runId 同族规矩——它是拼进路径的字符串，不合形态即拒。 */
export function assertWorktreeId(value: unknown): string {
  if (typeof value !== 'string' || !WORKTREE_ID_PATTERN.test(value)) {
    throw new Error(`worktree id must match ${WORKTREE_ID_PATTERN.source}; received: ${String(value)}`);
  }
  return value;
}

/** 候选路径是否落在隔离区内（含区根本身）：分隔符对齐判定，同 managed 根下的同名前缀不算。 */
export function isInsideWorktreesRoot(managedRoot: string, candidate: string): boolean {
  return isWithinBoundary(path.resolve(candidate), worktreesRootFor(path.resolve(managedRoot)));
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
