import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isRunId } from './ids.js';
import { runPaths, type WorkflowPaths } from './paths.js';
import { exists as fileExists } from './atomic.js';

/**
 * 账目保留与清扫（ADR-0052 §12）。三条独立预算，各自分列命名，绝不混用：
 *   · 快照保留 ≤ 30 份：只裁终态 run 目录，按 settle 时刻升序删最旧，保护集跳过；
 *   · 终态 run 注册表 ≤ 10：由 registry.ts 的 writeRegistry 在每次推进时裁，本文件不重复；
 *   · temp 宽限 1h：崩溃留下的 `.tmp` 无条件按龄清扫，与保护集无关（>1h 的 .tmp 必是孤儿）。
 *
 * 消息永不删（已读位只是标记）、死 Reducer 记录走 subagent 侧 1h TTL —— 两者都在既有实现里，
 * 本模块只保证自己绝不用 tempSweepGrace 去解释那两件事。
 */

const HOUR_MS = 60 * 60 * 1000;

/** 结果可读窗：subagent 结算结果在盘上可读的时长（既有 subagent 语义，这里只是本模块的称呼）。 */
export const RESULT_READABLE_WINDOW_MS = HOUR_MS;
/** 死 Reducer 记录 TTL：subagent 记录库的清理窗（既有 subagent 语义，本模块不据此删任何东西）。 */
export const SUBAGENT_RECORD_TTL_MS = HOUR_MS;
/** temp 清扫宽限：本模块唯一使用的 1h 窗，只管孤儿 `.tmp`。 */
export const TEMP_SWEEP_GRACE_MS = HOUR_MS;

/** 快照保留份数缺省——与 schema.MAX_RETAINED_SNAPSHOTS 同值，设置面可覆写、这里给兜底。 */
export const DEFAULT_SNAPSHOT_RETAIN = 30;

export type RetentionReport = {
  /** 被清扫的孤儿临时文件（相对 paths.workflowsRoot 的路径）。 */
  tempRemoved: string[];
  /** 因超出快照保留数而被整目录删除的终态 run。 */
  snapshotsRemoved: string[];
  /** 超限但落在保护集内、因而留下的 run。 */
  snapshotsProtected: string[];
};

export type RetentionDeps = {
  paths: WorkflowPaths;
  /** 判定"过期 / 最旧"的当下毫秒；测试注入虚拟钟。 */
  nowMs: number;
  snapshotRetain?: number;
  tempGraceMs?: number;
  /** 保护集：active ∪ starting ∪ persistence-active —— 永不整目录删。 */
  protect?: ReadonlySet<string>;
};

const TEMP_FILE_PATTERN = /\.tmp$/;

/** 递归收集某根下所有孤儿临时文件；目录读不动即跳过（扫描不该因一处坏目录整体失败）。 */
async function collectTempFiles(root: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectTempFiles(full)));
    } else if (entry.isFile() && TEMP_FILE_PATTERN.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** 无条件清扫超宽限的 `.tmp`：按 mtime 判龄，读不到时间的不动（判不准不删）。 */
async function sweepStaleTemp(paths: WorkflowPaths, deps: RetentionDeps): Promise<string[]> {
  const graceMs = deps.tempGraceMs ?? TEMP_SWEEP_GRACE_MS;
  const removed: string[] = [];
  for (const file of await collectTempFiles(paths.workflowsRoot)) {
    let ageMs: number;
    try {
      const info = await stat(file);
      ageMs = deps.nowMs - info.mtimeMs;
    } catch {
      continue;
    }
    if (ageMs <= graceMs) continue;
    await rm(file, { force: true }).catch(() => undefined);
    removed.push(path.relative(paths.workflowsRoot, file));
  }
  return removed;
}

type TerminalRun = { runId: string; atMs: number };

/** 终态 run 的定龄时刻 = 终态标记的 mtime（结算封口那一瞬）；读不到按 0 排到最旧端。 */
async function terminalAgeAnchor(dir: string): Promise<number> {
  try {
    return (await stat(path.join(dir, 'terminal'))).mtimeMs;
  } catch {
    return 0;
  }
}

/** 列出有终态标记的 run（只有真终态的才计入快照预算；在飞的永不裁）。 */
async function listTerminalRuns(paths: WorkflowPaths): Promise<TerminalRun[]> {
  let names: string[];
  try {
    names = await readdir(paths.runsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const runs: TerminalRun[] = [];
  for (const name of names.filter(isRunId)) {
    const dir = runPaths(paths, name).dir;
    if (!(await fileExists(path.join(dir, 'terminal')))) continue;
    runs.push({ runId: name, atMs: await terminalAgeAnchor(dir) });
  }
  return runs;
}

async function pruneSnapshots(paths: WorkflowPaths, deps: RetentionDeps): Promise<{ removed: string[]; protectedIds: string[] }> {
  const retain = deps.snapshotRetain ?? DEFAULT_SNAPSHOT_RETAIN;
  const protect = deps.protect ?? new Set<string>();
  const runs = await listTerminalRuns(paths);
  // 最新的排在前面；超限的那截里，非保护集才整目录删。
  const ordered = [...runs].sort((a, b) => b.atMs - a.atMs);
  const removed: string[] = [];
  const protectedIds: string[] = [];
  for (const run of ordered.slice(retain)) {
    if (protect.has(run.runId)) {
      protectedIds.push(run.runId);
      continue;
    }
    await rm(runPaths(paths, run.runId).dir, { recursive: true, force: true }).catch(() => undefined);
    removed.push(run.runId);
  }
  return { removed, protectedIds };
}

export async function runRetentionSweep(deps: RetentionDeps): Promise<RetentionReport> {
  const tempRemoved = await sweepStaleTemp(deps.paths, deps);
  const pruned = await pruneSnapshots(deps.paths, deps);
  return { tempRemoved, snapshotsRemoved: pruned.removed, snapshotsProtected: pruned.protectedIds };
}
