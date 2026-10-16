import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createExclusive, exists, readJson, writeJsonAtomic } from './atomic.js';
import { readIndex } from './run-index.js';
import { runPaths, type WorkflowPaths } from './paths.js';
import { assertRunId, isRunId } from './ids.js';
import { readMachineRecord, SCHEMA_VERSION, type WorkflowStatus } from './schema.js';
import { MAX_NOTICE_CODE_UNITS, buildKvFirstLine, sha256FileIfPresent } from './notice.js';
import type { WorkflowGates } from './gates.js';

/**
 * 汇总体（Reducer）契约——把 run 的结果送回 GPT 的那一条链路（ADR-0052 §8 / §10 / §14 / §15）。
 *
 * 四条纪律：
 *   1. 预算不在模型面上：等待预算恒取 reducerBudget，timeoutSec 由这里推导——
 *      "不得自调"的落地形态是"根本没有可传的旋钮"；
 *   2. 等待位 = run 目录里的独占登记：同一 run 至多一个等待中的汇总体，占用 / 释放都留盘痕，
 *      进程死留下的位由启动扫描清理；
 *   3. 配额满 = notice-only 降级，不是失败：run 照跑、结果照落盘，稍后可同 runId 补起；
 *   4. 收场判定只认盘面证据：终态标记与 digest 齐备才算交付，
 *      否则如实 failed(wait-timeout / no-digest)——"假完整"是红线。
 */

/** 摘要消息里模型可写的正文预算：200 码元帽减去首行 KV（digest 口径）后的余量。 */
export function reducerSummaryBudget(runId: string): number {
  const kv = buildKvFirstLine({ kind: 'digest', runId, sha256: '0'.repeat(64) });
  return Math.max(0, MAX_NOTICE_CODE_UNITS - kv.length - 1);
}

export type ReducerWaiter = {
  schemaVersion: number;
  runId: string;
  agentId: string;
  ownerSessionId: string;
  at: string;
};

export type ReducerClaim = { ok: true; waiter: ReducerWaiter } | { ok: false; reason: 'reducer-waiter-exists'; waiter: ReducerWaiter };

async function readWaiter(paths: WorkflowPaths, runId: string): Promise<ReducerWaiter | undefined> {
  const raw = await readJson(runPaths(paths, runId).waiterFile);
  if (raw === undefined) return undefined;
  const record = readMachineRecord<ReducerWaiter>(raw, SCHEMA_VERSION, 'reducer waiter');
  const value = record as unknown as Record<string, unknown>;
  return {
    schemaVersion: record.schemaVersion,
    runId: typeof value.runId === 'string' ? value.runId : '',
    agentId: typeof value.agentId === 'string' ? value.agentId : '',
    ownerSessionId: typeof value.ownerSessionId === 'string' ? value.ownerSessionId : '',
    at: typeof value.at === 'string' ? value.at : '',
  };
}

/** 占用：独占创建——已有等待者即拒，并把"是谁占着"原样回给调用方。 */
export async function claimReducerWaiter(
  paths: WorkflowPaths,
  input: { runId: string; agentId: string; ownerSessionId: string; at: string },
): Promise<ReducerClaim> {
  const waiter: ReducerWaiter = {
    schemaVersion: SCHEMA_VERSION,
    runId: assertRunId(input.runId),
    agentId: input.agentId,
    ownerSessionId: input.ownerSessionId,
    at: input.at,
  };
  const created = await createExclusive(runPaths(paths, waiter.runId).waiterFile, `${JSON.stringify(waiter, null, 2)}\n`);
  if (created) return { ok: true, waiter };
  const holder = await readWaiter(paths, waiter.runId);
  return { ok: false, reason: 'reducer-waiter-exists', waiter: holder ?? waiter };
}

export async function readReducerWaiter(paths: WorkflowPaths, runId: string): Promise<ReducerWaiter | undefined> {
  return await readWaiter(paths, runId);
}

/** 释放按 agentId 对齐：拿别人的位释放是结构性错误，不放（否则两个等待者互相踩）。 */
export async function releaseReducerWaiter(paths: WorkflowPaths, input: { runId: string; agentId: string }): Promise<{ released: boolean }> {
  const run = runPaths(paths, input.runId);
  const holder = await readWaiter(paths, input.runId);
  if (!holder || holder.agentId !== input.agentId) return { released: false };
  await rm(run.waiterFile, { force: true });
  return { released: true };
}

/**
 * 计数按"run 目录里有等待位登记"算，不按可解析性算——解析不动的登记仍占位。
 * 少起一个汇总体只会走 notice-only 降级（无害），多起一个就是把池槽位重复发出去。
 */
export async function countReducerWaiters(paths: WorkflowPaths): Promise<number> {
  let names: string[];
  try {
    names = await readdir(paths.runsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let count = 0;
  for (const name of names) {
    if (!isRunId(name)) continue;
    if (await exists(path.join(paths.runsRoot, name, 'reducer-waiter.json'))) count += 1;
  }
  return count;
}

export type ReducerRefusal = {
  ok: false;
  reason: 'reducer-waiter-exists' | 'reducer-quota';
  /** true = notice-only 降级：不占位、不阻塞 run，结果经终态消息 + 落盘可达。 */
  noticeOnly: boolean;
  runBlocked: false;
  indexPath: string;
  message: string;
  waiter?: ReducerWaiter;
};

export type ReducerAdmission =
  | { ok: true; noticeOnly: false; runBlocked: false; waiter: ReducerWaiter }
  | ReducerRefusal;

/** 准入 + 本次等待约束（引擎在受理时把 reducerBudget 折成两个数交给接线方）。 */
export type ReducerAdmit =
  | { ok: true; noticeOnly: false; runBlocked: false; waiter: ReducerWaiter; timeoutSec: number; budgetEndsAt: number }
  | ReducerRefusal;

/**
 * 准入判定（工具层在起 subagent 之前跑完）：
 *   ① 同一 run 已有等待者 → 拒本次补起（这不是降级：那一个等待者就是这件事的）；
 *   ② 配额已满 → notice-only 降级：不占位、不阻塞 run，结果经终态消息 + 落盘可达；
 *   ③ 通过 → 当场占用等待位。
 */
export async function decideReducerAdmission(
  paths: WorkflowPaths,
  input: { runId: string; agentId: string; ownerSessionId: string; at: string; gates: WorkflowGates },
): Promise<ReducerAdmission> {
  const indexPath = runPaths(paths, input.runId).indexFile;
  const refuseExisting = (waiter: ReducerWaiter): ReducerRefusal => ({
    ok: false,
    reason: 'reducer-waiter-exists',
    noticeOnly: false,
    runBlocked: false,
    indexPath,
    waiter,
    message: `Run ${input.runId} already has a waiting reducer (${waiter.agentId}). Wait for it, or start a new one with the same runId after it settles.`,
  });
  // 已有等待者先判：这不是配额的 notice-only 降级——那一位就是这件事的。
  const holder = await readWaiter(paths, input.runId);
  if (holder) return refuseExisting(holder);
  const waiting = await countReducerWaiters(paths);
  if (waiting >= input.gates.reducerQuota) {
    return {
      ok: false,
      reason: 'reducer-quota',
      noticeOnly: true,
      runBlocked: false,
      indexPath,
      message: `Reducer quota is full (${waiting}/${input.gates.reducerQuota} waiting reducers). The run keeps going: its settled-notice and the files on disk carry the result, and a reducer can start later with the same runId.`,
    };
  }
  // 独占创建才是"同一 run 至多一个等待者"的线性化点；并发补起时输的那一个在这里被挡下。
  const claim = await claimReducerWaiter(paths, input);
  if (!claim.ok) return refuseExisting(claim.waiter);
  return { ok: true, noticeOnly: false, runBlocked: false, waiter: claim.waiter };
}

export type ReducerBudget = {
  /** 起时 + reducerBudget：等待的绝对末端。 */
  budgetEndsAt: number;
  /** executor 硬兜底 = reducerBudget + reduceSlack（默认 40 分钟）；模型面无可传旋钮。 */
  timeoutSec: number;
  waitChunkSec: number;
  /** 第 n 回合（0 起）实际可等秒数：整回合 = waitChunk，末回合由预算末端裁剪。 */
  roundTimeoutSec(round: number): number;
};

/** 等待回合数 = floor(reducerBudget / waitChunk) 个整回合 + 1 个末回合（余数为 0 时不白送空回合）。 */
export function reducerWaitRounds(gates: WorkflowGates): { fullRounds: number; finalRound: 0 | 1; calls: number; waitChunkSec: number } {
  const fullRounds = Math.floor(gates.reducerBudgetMs / gates.waitChunkMs);
  const finalRound: 0 | 1 = gates.reducerBudgetMs - fullRounds * gates.waitChunkMs > 0 ? 1 : 0;
  return { fullRounds, finalRound, calls: fullRounds + finalRound, waitChunkSec: Math.round(gates.waitChunkMs / 1000) };
}

export function resolveReducerBudget(gates: WorkflowGates, input: { startedAt: number; now: () => number }): ReducerBudget {
  const budgetEndsAt = input.startedAt + gates.reducerBudgetMs;
  return {
    budgetEndsAt,
    timeoutSec: Math.round(gates.reducerTimeoutMs / 1000),
    waitChunkSec: Math.round(gates.waitChunkMs / 1000),
    roundTimeoutSec: (round: number) => {
      const planned = Math.max(input.now(), input.startedAt + round * gates.waitChunkMs);
      return Math.max(0, Math.floor(Math.min(gates.waitChunkMs, budgetEndsAt - planned) / 1000));
    },
  };
}

/**
 * 汇总体 objective 模板——本票定义并锁定，T11 原样发布（技能③块的正文来源）。
 * 行数与措辞即契约：发布件按行核对，改一个字即红。
 */
export function REDUCER_OBJECTIVE_TEMPLATE(input: {
  runId: string;
  terminalPath: string;
  indexPath: string;
  digestPath: string;
  rounds: number;
  waitChunkSec: number;
}): string {
  const summaryBudget = reducerSummaryBudget(input.runId);
  return [
    `You are the reducer (汇总体) for workflow run ${input.runId}: wait for it to settle, then send back a pointer, never the full result.`,
    `Terminal marker: ${input.terminalPath}`,
    `Run index: ${input.indexPath}`,
    `Digest document: ${input.digestPath}`,
    `Wait loop: call wait_for_path({ path: "${input.terminalPath}", timeoutSec: ${input.waitChunkSec} }) and do not poll more than once per turn; when it returns timeout, make the next call in the next turn.`,
    `When it returns ready: read the index first, then open only the per-path files you need for the failure account.`,
    `Write the digest document in exactly three sections: 结论 (X/Y succeeded), 失败清单 (one line per failed path: label / error / 相关性), 产物与索引 (absolute paths plus the index reminder).`,
    `Report honestly: partial appears as partial — never report a run you did not settle, never drop a failure, never soften a count.`,
    `If the budget expires before the marker appears: write no digest and exit with the same three sections, stating the run did not settle, that there is no digest, and where the index is.`,
    `Final message: one sentence with X/Y, the digest path, and the index reminder — ${summaryBudget} code units is all you get, so render paths in the canonical tail form when they do not fit.`,
    `This budget allows ${input.rounds} wait calls of up to ${input.waitChunkSec}s each. The waiting budget comes from local settings; the model-facing surface has no knob for it.`,
    `Delivery is your normal completion: your final text is checkpointed and sent to the requesting session, so do not call any messaging tool.`,
  ].join('\n');
}

/**
 * digest 形态——模板级形状，明确不作机器契约（§20②）：程序化解析一律回索引。
 * 本对象随技能发布，供 Reducer 参照、供测试锚定。
 */
export const DIGEST_TEMPLATE = {
  file: 'digest',
  machineContract: false,
  sections: [
    { title: '结论', fields: ['status', 'X/Y', 'reason'] },
    { title: '失败清单', fields: ['label', 'error', '相关性'] },
    { title: '产物与索引', fields: ['digestPath', 'indexPath'] },
  ],
} as const;

export type ReducerVerdict =
  | { status: 'completed'; firstLine: string; digestSha: string; released: boolean }
  | { status: 'failed'; reason: 'wait-timeout' | 'no-digest'; report: string; released: boolean };

/**
 * 累加汇总体用量（ADR-0052 §19 第三档）——读索引、把本次汇总体输出加进 reducerTokens.spent、
 * 原子回写。汇总体在 run 结算之后才收场，所以这一档回写索引、不改终态快照。
 * 取消不退、不重算：这里只累加，永不减。索引不在（未接线的补起）即静默跳过，收场判定不因此变。
 */
export async function bumpReducerTokens(paths: WorkflowPaths, runId: string, outputTokens: number): Promise<void> {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return;
  const run = runPaths(paths, runId);
  const index = await readIndex(run.indexFile);
  if (!index) return;
  const next = { ...index, reducerTokens: { spent: (index.reducerTokens?.spent ?? 0) + Math.floor(outputTokens) } };
  await writeJsonAtomic(run.indexFile, next);
}

/**
 * 收场判定：只认盘面证据，不认模型自述。
 *   · 终态标记在场 + digest 在场 → completed，摘要消息首行 KV 带 digest 字节哈希；
 *   · 终态标记不在场 → failed(wait-timeout)：模型说什么都没用，未结算就是未结算（禁止 completed 掩盖）；
 *   · 已结算但 digest 没写出 → failed(no-digest)：半成品不算交付。
 * 三种收场都释放等待位（死亡后可同 runId 补起）。
 * 传了 reducerOutputTokens 就顺带回写用量第三档（累加，不改判定）。
 */
export async function concludeReducer(
  paths: WorkflowPaths,
  input: { runId: string; agentId: string; digestPath: string; reducerOutputTokens?: number },
): Promise<ReducerVerdict> {
  const run = runPaths(paths, input.runId);
  // 释放先于读盘：收场是本汇总体最后的义务，读摘要失败不该把等待位钉死到下次启动扫描。
  const released = (await releaseReducerWaiter(paths, { runId: input.runId, agentId: input.agentId })).released;
  if (input.reducerOutputTokens !== undefined) await bumpReducerTokens(paths, input.runId, input.reducerOutputTokens).catch(() => undefined);
  const settled = await exists(run.terminalFile);
  const digestSha = await sha256FileIfPresent(input.digestPath);
  const counts = await settledCounts(run.indexFile);
  if (!settled) {
    return {
      status: 'failed',
      reason: 'wait-timeout',
      released,
      report: [
        `结论：run ${input.runId} 未结算（wait-timeout：等待预算内未见终态标记）· 已完成 ${counts.succeeded}/${counts.total}`,
        `失败清单：逐条见索引 ${run.indexFile}`,
        `产物与索引：无摘要 · 索引 ${run.indexFile}`,
      ].join('\n'),
    };
  }
  if (digestSha === undefined) {
    return {
      status: 'failed',
      reason: 'no-digest',
      released,
      report: [
        `结论：run ${input.runId} 已结算为 ${counts.status}（no-digest：digest 未写出）· 已完成 ${counts.succeeded}/${counts.total}`,
        '失败清单：逐条见索引',
        `产物与索引：无摘要（digest 未写出）· 索引 ${run.indexFile}`,
      ].join('\n'),
    };
  }
  return {
    status: 'completed',
    released,
    digestSha,
    firstLine: buildKvFirstLine({ kind: 'digest', runId: input.runId, sha256: digestSha }),
  };
}

async function settledCounts(indexFile: string): Promise<{ status: WorkflowStatus | 'unknown'; succeeded: number; total: number }> {
  const index = await readIndex(indexFile).catch(() => undefined);
  if (!index) return { status: 'unknown', succeeded: 0, total: 0 };
  return {
    status: index.status,
    succeeded: index.dispatches.filter((record) => record.status === 'completed').length,
    total: index.dispatches.length,
  };
}
