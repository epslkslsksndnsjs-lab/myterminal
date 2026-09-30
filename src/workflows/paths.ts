import path from 'node:path';
import { assertRunId } from './ids.js';

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
  };
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
