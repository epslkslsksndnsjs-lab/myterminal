// Workflows T10（#233）：进程存活期兜底——orphan 看门狗 + 启动收尸接线的引擎级行为锁
//
// orphan-sweep：超 runGate + 宽限仍未结算的活 run，用同一结算函数强制 failed(settle-timeout)，
// 此后任何证据不改终态。巡检节律 = 进程内定时器（以注入钟断言）。
// recoverOnBoot：启动序列把认领/排空/保留清扫/worktree 收场/看门狗一次串起来。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkflowEngine } from '../dist/workflows/engine.js';
import { virtualClock } from '../dist/workflows/clock.js';
import { workflowPaths, runPaths } from '../dist/workflows/paths.js';
import { readIndex } from '../dist/workflows/run-index.js';
import { readSnapshot } from '../dist/workflows/snapshot.js';
import { writeIndex } from '../dist/workflows/run-index.js';
import { readRegistry } from '../dist/workflows/registry.js';
import { SCHEMA_VERSION } from '../dist/workflows/schema.js';

let TMP;

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-233orphan-'));
  TMP = dir;
  const workspaceDir = path.join(dir, 'workspace');
  const managedRoot = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { workspaceDir, managedRoot, paths: workflowPaths(managedRoot) };
}

afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

/** 永不归来的模型：把 run 钉在 in-flight（execute 卡在 race），正是要 orphan 兜的形状。 */
function hangFactory() {
  return () => ({ complete: () => new Promise(() => { /* 永不 resolve */ }) });
}

const ONE_PATH = "await agent('x', { label: 'X' });\nreturn 1;";

// ── sweepOrphans：强制结算 ────────────────────────────────────────

test('sweepOrphans：超 runGate + 宽限的在飞 run → 走同一结算函数定 failed(settle-timeout)', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const runGateMs = 30 * 60 * 1000;
  const reduceSlackMs = 5 * 60 * 1000;
  const engine = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock,
    adapterFactory: hangFactory(),
    gates: { runGateMs, reduceSlackMs, dispatchWindowMs: 10 * 60 * 1000, stallMs: 180_000, reducerBudgetMs: 35 * 60 * 1000, reducerTimeoutMs: 40 * 60 * 1000, concurrencyWindow: 1 },
    concurrencyWindow: 1,
  });
  const started = await engine.start({ script: ONE_PATH, ownerSessionId: 'sess-a' });
  // 不推进时钟 → gate 未响；直接喂一个超期时刻，确定性命中 orphan。
  const overdue = clock.now() + runGateMs + reduceSlackMs + 1;
  const settled = await engine.sweepOrphans(overdue);

  assert.deepEqual(settled, [started.runId], '恰好强制结算这一条');
  const run = runPaths(temp.paths, started.runId);
  const index = await readIndex(run.indexFile);
  assert.equal(index.status, 'failed');
  assert.equal(index.reason, 'settle-timeout');
  const snapshot = await readSnapshot(run.snapshotFile);
  assert.equal(snapshot.reason, 'settle-timeout');
  assert.equal(fs.existsSync(run.terminalFile), true, '终态标记落地');
});

test('sweepOrphans：宽限未到不结算（runGate + slack 之内一律放行）', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const engine = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock,
    adapterFactory: hangFactory(),
    concurrencyWindow: 1,
  });
  await engine.start({ script: ONE_PATH, ownerSessionId: 'sess-a' });
  const notYet = clock.now() + engine.windowLimit * 0 + 1; // 远未到 runGate
  const settled = await engine.sweepOrphans(notYet);
  assert.deepEqual(settled, []);
});

test('sweepOrphans：已结算的 run 不再被改判（此后任何证据不改终态）', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const engine = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock,
    adapterFactory: () => ({ complete: async () => ({ text: 'ok', outputTokens: 2 }) }),
    concurrencyWindow: 1,
  });
  const started = await engine.start({ script: ONE_PATH, ownerSessionId: 'sess-a' });
  const done = await started.completion;
  assert.equal(done.status, 'completed');
  const settled = await engine.sweepOrphans(clock.now() + 10 * 60 * 60 * 1000);
  assert.deepEqual(settled, [], '已终态，orphan 不碰');
  const after = await readIndex(runPaths(temp.paths, started.runId).indexFile);
  assert.equal(after.status, 'completed', '终态没被 settle-timeout 改写');
});

test('sweepOrphans：暂停中的 run 墙钟冻结，绝不因超期被强制结算', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const engine = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock,
    adapterFactory: hangFactory(),
    concurrencyWindow: 1,
  });
  const started = await engine.start({ script: ONE_PATH, ownerSessionId: 'sess-a' });
  await engine.controlAsLocal('pause', started.runId);
  const settled = await engine.sweepOrphans(clock.now() + 24 * 60 * 60 * 1000);
  assert.deepEqual(settled, [], 'paused 刻意不结算（§19 墙钟不走）');
});

// ── 进程内定时器（巡检节律，注入钟断言）─────────────────────────────

test('armOrphanWatchdog：挂上进程内定时器，tick 计数递增且自续挂，stop 撤下', () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const engine = new WorkflowEngine({ workspaceDir: temp.workspaceDir, managedRoot: temp.managedRoot, clock, adapterFactory: hangFactory() });
  assert.equal(engine.orphanWatchdogArmed, false);
  engine.armOrphanWatchdog(1000);
  assert.equal(engine.orphanWatchdogArmed, true);

  clock.advance(1000);
  assert.equal(engine.orphanSweepCount, 1, '到点跑了一趟巡检');
  assert.equal(engine.orphanWatchdogArmed, true, 'tick 后自续挂下一档');

  clock.advance(1000);
  assert.equal(engine.orphanSweepCount, 2);

  engine.stopOrphanWatchdog();
  assert.equal(engine.orphanWatchdogArmed, false);
  const before = engine.orphanSweepCount;
  clock.advance(10000);
  assert.equal(engine.orphanSweepCount, before, '撤下后不再巡检');
});

test('armOrphanWatchdog：重复挂不叠加（幂等）', () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const engine = new WorkflowEngine({ workspaceDir: temp.workspaceDir, managedRoot: temp.managedRoot, clock, adapterFactory: hangFactory() });
  engine.armOrphanWatchdog(1000);
  engine.armOrphanWatchdog(1000);
  clock.advance(1000);
  assert.equal(engine.orphanSweepCount, 1, '只有一只表在跑');
});

// ── recoverOnBoot：启动收尸接线 ───────────────────────────────────

test('recoverOnBoot：把盘上遗留的 interrupted 帧认领 + 补投 + 挂看门狗', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const delivered = [];
  const engine = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock,
    adapterFactory: hangFactory(),
    deliverNotice: (n) => { delivered.push(n); return true; },
  });
  // 手摆一条遗留帧：运行中索引、无快照、无标记（模拟上次进程被打断）。
  const runId = 'wf_a1b2';
  const run = runPaths(temp.paths, runId);
  fs.mkdirSync(run.outboxDir, { recursive: true });
  await writeIndex(run.indexFile, {
    schemaVersion: SCHEMA_VERSION, runId, status: 'running', ownerSessionId: 'sess-a', scriptPath: '/x.js',
    sourceRef: { id: 's', revision: 'r' }, argsRecorded: false, startedAt: '2026-09-30T00:00:00.000Z',
    dispatches: [{ id: 'd1', label: 'one', status: 'running', attempts: 1, startedAt: 'x', outputTokens: 1 }],
    failures: [], tokens: { spent: 1 },
  });

  const report = await engine.recoverOnBoot();
  assert.equal(report.claimed.length, 1);
  assert.equal(report.claimed[0].runId, runId);
  assert.equal(report.drained.length, 1, '补写的通知在排空趟被投出');
  assert.equal(delivered.length, 1);
  assert.equal(engine.orphanWatchdogArmed, true, '启动收尸顺带挂上看门狗');
  const snap = await readSnapshot(run.snapshotFile);
  assert.equal(snap.reason, 'interrupted');
});

test('recoverOnBoot：本进程已起的活 run 不被自己认领成 interrupted', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const engine = new WorkflowEngine({ workspaceDir: temp.workspaceDir, managedRoot: temp.managedRoot, clock, adapterFactory: hangFactory(), concurrencyWindow: 1 });
  const started = await engine.start({ script: ONE_PATH, ownerSessionId: 'sess-a' });
  const report = await engine.recoverOnBoot();
  assert.deepEqual(report.claimed, [], '在飞的自己的 run 不认领');
  assert.equal(engine.liveRunIds.includes(started.runId), true);
});

test('recoverOnBoot：认领顺带把注册表推进到终态', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const engine = new WorkflowEngine({ workspaceDir: temp.workspaceDir, managedRoot: temp.managedRoot, clock, adapterFactory: hangFactory() });
  const runId = 'wf_c3d4';
  const run = runPaths(temp.paths, runId);
  fs.mkdirSync(run.outboxDir, { recursive: true });
  await writeIndex(run.indexFile, {
    schemaVersion: SCHEMA_VERSION, runId, status: 'running', ownerSessionId: 'sess-a', scriptPath: '/x.js',
    sourceRef: { id: 's', revision: 'r' }, argsRecorded: false, startedAt: '2026-09-30T00:00:00.000Z',
    dispatches: [], failures: [], tokens: { spent: 0 },
  });
  await engine.recoverOnBoot();
  const registry = await readRegistry(temp.paths.registryFile);
  assert.equal(registry.runs.find((e) => e.runId === runId).status, 'failed');
});
