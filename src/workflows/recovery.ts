import { readdir } from 'node:fs/promises';
import { createExclusive, ensureDir, exists } from './atomic.js';
import { isRunId } from './ids.js';
import {
  buildSettledNotice,
  markNoticeDelivered,
  putNotice,
  readOutbox,
  sha256File,
  type NoticeKind,
  type OutboxItem,
} from './notice.js';
import { runPaths, type RunPaths, type WorkflowPaths } from './paths.js';
import { upsertRegistry } from './registry.js';
import { readIndex, writeIndex } from './run-index.js';
import { readSnapshot, writeSnapshot } from './snapshot.js';
import {
  SCHEMA_VERSION,
  isTerminal,
  type RegistryEntry,
  type RunIndex,
  type TerminalReason,
  type WorkflowStatus,
} from './schema.js';

/**
 * 启动扫描的收尸双趟（ADR-0052 §15②/§12/§24）。
 *
 * 两趟各一把判据，合起来覆盖 kill -9 能留下的每一帧：
 *   · 认领趟——run 目录在、终态标记不在。命中后内部分类：
 *       有终态快照 → 只补标记、绝不覆写快照（防把已 settle 的历史打成假死判）；
 *       无快照 → 一律写 failed(interrupted) 快照。两支都补 outbox 未投项（缺则补写）。
 *   · 排空趟——终态标记在、outbox 有未 delivered 项。只补投通知，不碰终态。
 * 认领趟补写、排空趟投递，故"两趟都排空"在单次启动扫描内闭合，不留半截。
 *
 * 结算的唯一线性化点仍是终态标记的独占创建：认领趟用同一把 createExclusive，
 * 与并发续跑 / 二次启动同刻到达时后到者读到已有标记即静默退让，不重复补写。
 */

export type ClaimedRun = {
  runId: string;
  /** true = 认领时盘上已有终态快照，只补了标记；false = 补写了 failed(interrupted) 快照。 */
  hadSnapshot: boolean;
  status: WorkflowStatus;
  reason: TerminalReason;
  /** 独占创建是否由本趟赢得（false = 并发对手先到，标记已在，本趟退让）。 */
  markerCreated: boolean;
};

export type DrainedNotice = {
  runId: string;
  kind: NoticeKind;
  sha256: string;
  delivered: boolean;
};

export type RecoveryError = {
  runId: string;
  stage: 'claim' | 'drain';
  message: string;
};

export type BootSweepReport = {
  claimed: ClaimedRun[];
  drained: DrainedNotice[];
  /** 逐 run 的 IO / 解析故障：单条坏帧不能让整轮启动扫描抛出去。 */
  errors: RecoveryError[];
};

export type ClaimAuditEntry = {
  runId: string;
  action: 'claimed';
  actor: string;
  status: WorkflowStatus;
  reason: TerminalReason;
  at: string;
};

/** 隔离区收场钩子（worktree 相关断言以 T8 机制为准）：只清干净件，检查抛错按保留。 */
export type WorktreeReconciler = { reconcileAbandoned(): Promise<unknown> };

export type BootSweepDeps = {
  paths: WorkflowPaths;
  /** 时钟取自注入件：iso 落盘、now 供清扫与测试推进。 */
  clock: { iso(): string; now(): number };
  /** 排空趟的投递手；缺省（模块独立单测）则只统计未投项、不投。 */
  deliverNotice?: (notice: { runId: string; ownerSessionId: string; body: string; sha256: string }) => Promise<boolean> | boolean;
  audit?: (entry: ClaimAuditEntry) => void;
  /** 本进程已在跑的 run：认领趟一律跳过，免得把一个还活着的 in-flight run 打成 interrupted。 */
  liveRunIds?: ReadonlySet<string>;
  worktrees?: WorktreeReconciler;
};

/** 与 engine.settle 同形：终态标记的信息体（读者只判存在，内容由认领与排空各自重读快照/索引）。 */
function terminalMarkerContent(runId: string, status: WorkflowStatus, reason: TerminalReason, endedAt: string): string {
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, runId, status, reason, endedAt })}\n`;
}

async function listRunDirs(paths: WorkflowPaths): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(paths.runsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.filter(isRunId).sort();
}

/**
 * 把一个 run 的在飞索引折成 interrupted 终态索引：status/reason/endedAt 落终态，
 * 其余字段（每路账、归属、脚本引用）原样保留——收尸不臆造，也不丢已记的账。
 * 索引整体缺失（目录建了、首写 index 前就死）时退到最小可结算形状，owner 记空串，
 * 通知因此投不出去而静置 outbox：没有归属会话，投给谁都不诚实。
 */
function interruptedIndex(runId: string, previous: RunIndex | undefined, startedAtFallback: string): RunIndex {
  const base = previous ?? {
    schemaVersion: SCHEMA_VERSION,
    runId,
    status: 'running' as WorkflowStatus,
    ownerSessionId: '',
    scriptPath: '',
    sourceRef: { id: '', revision: '' },
    argsRecorded: false,
    startedAt: startedAtFallback,
    dispatches: [],
    failures: [],
    tokens: { spent: 0 },
  };
  return { ...base, runId, status: 'failed', reason: 'interrupted', startedAt: base.startedAt || startedAtFallback };
}

function countsFrom(index: RunIndex): { succeeded: number; total: number } {
  return {
    succeeded: index.dispatches.filter((record) => record.status === 'completed').length,
    total: index.dispatches.length,
  };
}

/** 认领命中帧的通知兜底：以快照字节哈希为去重键补一条未投 settled-notice，缺则写、在则留。 */
async function ensureClaimedNotice(run: RunPaths, index: RunIndex, at: string): Promise<OutboxItem | undefined> {
  let sha256: string;
  try {
    sha256 = await sha256File(run.snapshotFile);
  } catch {
    return undefined;
  }
  const counts = countsFrom(index);
  const notice = buildSettledNotice({
    runId: index.runId,
    status: index.status,
    sha256,
    indexPath: run.indexFile,
    succeeded: counts.succeeded,
    total: counts.total,
  });
  if (!notice.ok) return undefined;
  return (await putNotice(run, {
    kind: 'settled-notice',
    runId: index.runId,
    sha256,
    status: index.status,
    index: run.indexFile,
    body: notice.body,
    at,
  })).item;
}

/**
 * 认领趟单帧：无标记的 run → 定终态（补标记 / 补 interrupted 快照）→ 补 outbox 未投项 → 推注册表。
 * 已有终态快照只补标记、不覆写；返回 undefined = 这一帧其实不该认领（本进程在跑 / 标记已在）。
 */
async function claimOne(
  paths: WorkflowPaths,
  deps: BootSweepDeps,
  runId: string,
): Promise<ClaimedRun | undefined> {
  if (deps.liveRunIds?.has(runId)) return undefined;
  const run = runPaths(paths, runId);
  if (await exists(run.terminalFile)) return undefined;

  const at = deps.clock.iso();
  const existing = await readSnapshot(run.snapshotFile).catch(() => undefined);
  let hadSnapshot = false;
  let index: RunIndex;

  if (existing !== undefined && isTerminal(existing.status)) {
    hadSnapshot = true;
    // 放大帧：快照已 settle、标记崩在半路——补标记即可，绝不再写一遍快照（防假死判覆写）。
    index = existing;
  } else {
    // 无快照（或索引仍在飞）→ 一律判 interrupted：journal 有 started 无 result 是它的典型形态，其余残帧同此兜底。
    const live = (await readIndex(run.indexFile)) ?? existing;
    index = interruptedIndex(runId, live, at);
    index = { ...index, endedAt: at, tokens: { spent: index.tokens?.spent ?? 0 } };
    await ensureDir(run.dir);
    await writeSnapshot(run.snapshotFile, index);
    await writeIndexSafe(run, index);
  }

  // 结算序（与 engine.settle 同一纪律）：outbox 通知先原子写、终态标记最后独占创建。
  // 通知先于标记，是为了让"标记后的任何帧"都可被排空趟补投；反序会造出"有标记、无 outbox 项"的帧，
  // 两趟判据都够不着，认领这一路的 settled-notice 就真丢了。
  await ensureClaimedNotice(run, index, at);
  const markerCreated = await createExclusive(
    run.terminalFile,
    terminalMarkerContent(runId, index.status, index.reason ?? 'interrupted', index.endedAt ?? at),
  );

  const entry: RegistryEntry = {
    runId,
    status: index.status,
    ownerSessionId: index.ownerSessionId,
    startedAt: index.startedAt,
    endedAt: index.endedAt ?? at,
  };
  await upsertRegistry(paths.registryFile, entry);

  deps.audit?.({ runId, action: 'claimed', actor: index.ownerSessionId || runId, status: index.status, reason: index.reason ?? 'interrupted', at });
  return { runId, hadSnapshot, status: index.status, reason: index.reason ?? 'interrupted', markerCreated };
}

/** interrupted 快照写完后把索引也定到同一终态：认领后的 run 目录对"读索引"的一方同样收敛，不再露出 running。 */
async function writeIndexSafe(run: RunPaths, index: RunIndex): Promise<void> {
  await writeIndex(run.indexFile, index);
}

/** 排空趟单帧：有标记且 outbox 有未投项 → 逐条补投；投到才标 delivered（至少一次投递）。 */
async function drainOne(paths: WorkflowPaths, deps: BootSweepDeps, runId: string): Promise<DrainedNotice[]> {
  const run = runPaths(paths, runId);
  if (!(await exists(run.terminalFile))) return [];
  const pending = (await readOutbox(run)).filter((item) => !item.delivered);
  if (pending.length === 0) return [];
  const owner = await resolveOwner(run, runId);
  const drained: DrainedNotice[] = [];
  for (const item of pending) {
    let delivered = false;
    if (deps.deliverNotice && owner) {
      delivered = await Promise.resolve(
        deps.deliverNotice({ runId, ownerSessionId: owner, body: item.body, sha256: item.sha256 }),
      ).catch(() => false);
      if (delivered) await markNoticeDelivered(run, item, deps.clock.iso()).catch(() => undefined);
    }
    drained.push({ runId, kind: item.kind, sha256: item.sha256, delivered });
  }
  return drained;
}

async function resolveOwner(run: RunPaths, runId: string): Promise<string> {
  const index = await readIndex(run.indexFile).catch(() => undefined);
  if (index?.ownerSessionId) return index.ownerSessionId;
  const snapshot = await readSnapshot(run.snapshotFile).catch(() => undefined);
  return snapshot?.ownerSessionId ?? '';
}

export async function bootSweep(deps: BootSweepDeps): Promise<BootSweepReport> {
  const report: BootSweepReport = { claimed: [], drained: [], errors: [] };
  const runs = await listRunDirs(deps.paths);

  for (const runId of runs) {
    try {
      const claimed = await claimOne(deps.paths, deps, runId);
      if (claimed) report.claimed.push(claimed);
    } catch (error) {
      report.errors.push({ runId, stage: 'claim', message: errorMessage(error) });
    }
  }

  for (const runId of runs) {
    try {
      report.drained.push(...(await drainOne(deps.paths, deps, runId)));
    } catch (error) {
      report.errors.push({ runId, stage: 'drain', message: errorMessage(error) });
    }
  }

  // boot-sweep 顺带只清干净 worktree（有改动留待人处置，判不准按保留）；收场走 T8 那一套谓词，本票不重述其语义。
  if (deps.worktrees) await deps.worktrees.reconcileAbandoned().catch(() => undefined);

  return report;
}

function errorMessage(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as Error).message === 'string'
    ? (error as Error).message
    : String(error);
}
