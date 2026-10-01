// Workflows T10（#233）：启动扫描收尸双趟——recovery.ts 的单元行为锁
//
// 这一层用合成 run 目录精确摆出 kill -9 能留下的每一帧，断 bootSweep 的判据与去向；
// 真引擎 + 故障注入 → 真帧 → bootSweep 的贯通用例在 issue-233-crash-frames 里另钉。
// 认领趟判据 = run 目录在、无终态标记；排空趟判据 = 有标记、outbox 有未投项。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bootSweep } from '../dist/workflows/recovery.js';
import { workflowPaths, runPaths } from '../dist/workflows/paths.js';
import { writeIndex } from '../dist/workflows/run-index.js';
import { writeJsonAtomic, createExclusive, exists } from '../dist/workflows/atomic.js';
import { putNotice, markNoticeDelivered, readOutbox } from '../dist/workflows/notice.js';
import { readSnapshot } from '../dist/workflows/snapshot.js';
import { readRegistry } from '../dist/workflows/registry.js';
import { SCHEMA_VERSION } from '../dist/workflows/schema.js';

let TMP;

function freshPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-233rec-'));
  TMP = dir;
  const managedRoot = path.join(dir, '.myterminal');
  fs.mkdirSync(path.join(managedRoot, 'workflows', 'runs'), { recursive: true });
  return workflowPaths(managedRoot);
}

afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

const CLOCK = { iso: () => '2026-10-01T00:00:00.000Z', now: () => 1_760_000_000_000 };

function baseIndex(runId, status, extra = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    status,
    ownerSessionId: 'sess-root',
    scriptPath: '/x.js',
    sourceRef: { id: 'src', revision: 'r1' },
    argsRecorded: false,
    startedAt: '2026-09-30T00:00:00.000Z',
    dispatches: [],
    failures: [],
    tokens: { spent: 5 },
    ...extra,
  };
}

async function makeRun(paths, runId) {
  const run = runPaths(paths, runId);
  fs.mkdirSync(run.outboxDir, { recursive: true });
  fs.mkdirSync(run.agentsDir, { recursive: true });
  return run;
}

// ── 列表 / 无 runs 根 ────────────────────────────────────────────

test('runs 根不存在 → 空报告，不抛', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-233empty-'));
  TMP = dir;
  const paths = workflowPaths(path.join(dir, '.myterminal')); // 从未建 runs/
  const report = await bootSweep({ paths, clock: CLOCK });
  assert.deepEqual(report.claimed, []);
  assert.deepEqual(report.drained, []);
  assert.deepEqual(report.errors, []);
});

test('非 runId 命名的目录一律忽略（不进扫描）', async () => {
  const paths = freshPaths();
  fs.mkdirSync(path.join(paths.runsRoot, 'not-a-run'), { recursive: true });
  const report = await bootSweep({ paths, clock: CLOCK });
  assert.deepEqual(report.claimed, []);
});

// ── 认领趟：无快照 → failed(interrupted) ──────────────────────────

test('认领：运行中索引、无快照、无标记 → 写 failed(interrupted) 快照 + 补标记 + 补 outbox + 推注册表 + claimed 审计', async () => {
  const paths = freshPaths();
  const runId = 'wf_aaaa';
  const run = await makeRun(paths, runId);
  await writeIndex(run.indexFile, baseIndex(runId, 'running', {
    dispatches: [{ id: 'd1', label: 'one', status: 'running', attempts: 1, startedAt: 'x', outputTokens: 2 }],
  }));
  const audit = [];
  const report = await bootSweep({ paths, clock: CLOCK, audit: (e) => audit.push(e) });

  assert.equal(report.claimed.length, 1, '命中一帧');
  assert.equal(report.claimed[0].hadSnapshot, false);
  assert.equal(report.claimed[0].status, 'failed');
  assert.equal(report.claimed[0].reason, 'interrupted');
  assert.equal(report.claimed[0].markerCreated, true);

  const snap = await readSnapshot(run.snapshotFile);
  assert.equal(snap.status, 'failed');
  assert.equal(snap.reason, 'interrupted');
  assert.ok(snap.endedAt, '补了终态时刻');

  const index = JSON.parse(fs.readFileSync(run.indexFile, 'utf8'));
  assert.equal(index.status, 'failed', '索引也一并定到 interrupted 终态');
  assert.equal(await exists(run.terminalFile), true);

  const outbox = await readOutbox(run);
  assert.equal(outbox.length, 1, '补写了未投 settled-notice');
  assert.equal(outbox[0].kind, 'settled-notice');
  assert.equal(outbox[0].delivered, false);
  assert.match(outbox[0].body, new RegExp(`runId=${runId}`));

  const registry = await readRegistry(paths.registryFile);
  assert.equal(registry.runs.find((e) => e.runId === runId).status, 'failed');

  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'claimed');
  assert.equal(audit[0].runId, runId);
  assert.equal(audit[0].actor, 'sess-root');
  assert.equal(audit[0].status, 'failed');
});

test('认领：整目录皆缺（连索引都没写出来）→ 仍按 interrupted 兜，owner 空则通知静置不投', async () => {
  const paths = freshPaths();
  const runId = 'wf_bbbb';
  const run = await makeRun(paths, runId); // 只有空目录，无 index/snapshot/marker
  const delivered = [];
  const report = await bootSweep({ paths, clock: CLOCK, deliverNotice: (n) => { delivered.push(n); return true; } });
  assert.equal(report.claimed.length, 1);
  assert.equal(report.claimed[0].hadSnapshot, false);
  const snap = await readSnapshot(run.snapshotFile);
  assert.equal(snap.status, 'failed');
  assert.equal(snap.ownerSessionId, '', '无索引可读时归属记空');
  assert.equal(delivered.length, 0, 'owner 为空 → 排空趟也不投（投给谁都不诚实）');
});

// ── 认领趟：放大帧（有终态快照、无标记）只补标记、不覆写快照 ─────

test('认领：已有 completed 快照、无标记 → 只补标记，快照字节一字不动，补 outbox', async () => {
  const paths = freshPaths();
  const runId = 'wf_cccc';
  const run = await makeRun(paths, runId);
  const snapshotPayload = { ...baseIndex(runId, 'completed', { reason: 'completed', endedAt: '2026-09-30T01:00:00.000Z', dispatches: [{ id: 'd1', label: 'one', status: 'completed', attempts: 1, startedAt: 'x', outputTokens: 2 }] }), schemaVersion: SCHEMA_VERSION };
  await writeJsonAtomic(run.snapshotFile, snapshotPayload);
  const before = fs.readFileSync(run.snapshotFile);
  const report = await bootSweep({ paths, clock: CLOCK });

  assert.equal(report.claimed[0].hadSnapshot, true, '识别为放大帧');
  assert.equal(report.claimed[0].status, 'completed');
  assert.equal(report.claimed[0].reason, 'completed', '沿用快照里已有的具名，不改判 interrupted');
  assert.equal(Buffer.compare(before, fs.readFileSync(run.snapshotFile)), 0, '绝不覆写已 settle 的快照');
  assert.equal(await exists(run.terminalFile), true, '补了标记');
  const outbox = await readOutbox(run);
  assert.equal(outbox.length, 1, '放大帧也保证有未投项');
});

test('认领：有标记的 run 一律跳过（交排空趟），不补标记、不改终态', async () => {
  const paths = freshPaths();
  const runId = 'wf_dddd';
  const run = await makeRun(paths, runId);
  await writeJsonAtomic(run.snapshotFile, baseIndex(runId, 'completed', { reason: 'completed', endedAt: 'x' }));
  await createExclusive(run.terminalFile, JSON.stringify({ schemaVersion: SCHEMA_VERSION, runId, status: 'completed', reason: 'completed', endedAt: 'x' }) + '\n');
  const report = await bootSweep({ paths, clock: CLOCK });
  assert.equal(report.claimed.length, 0, '有标记 → 不认领');
  assert.equal(report.drained.length, 0, 'outbox 无未投项 → 不排空');
});

test('认领：liveRunIds 命中的活 run 绝不认领（不把在飞的打成 interrupted）', async () => {
  const paths = freshPaths();
  const runId = 'wf_eeee';
  const run = await makeRun(paths, runId);
  await writeIndex(run.indexFile, baseIndex(runId, 'running'));
  const report = await bootSweep({ paths, clock: CLOCK, liveRunIds: new Set([runId]) });
  assert.equal(report.claimed.length, 0);
  assert.equal(await exists(run.terminalFile), false, '没被补标记');
});

// ── 排空趟：有标记 + 未投 → 补投；投到才标 delivered ──────────────

test('排空：有标记、outbox 有未投项 → 补投并标 delivered', async () => {
  const paths = freshPaths();
  const runId = 'wf_ffff';
  const run = await makeRun(paths, runId);
  await writeIndex(run.indexFile, baseIndex(runId, 'completed', { reason: 'completed', endedAt: 'x' }));
  await createExclusive(run.terminalFile, '{}');
  await putNotice(run, { kind: 'settled-notice', runId, sha256: 'a'.repeat(64), status: 'completed', index: run.indexFile, body: `[workflow] kind=settled-notice runId=${runId}\ncompleted 1/1`, at: 'x' });
  const delivered = [];
  const report = await bootSweep({ paths, clock: CLOCK, deliverNotice: (n) => { delivered.push(n); return true; } });
  assert.equal(report.drained.length, 1);
  assert.equal(report.drained[0].delivered, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].ownerSessionId, 'sess-root');
  const outbox = await readOutbox(run);
  assert.equal(outbox[0].delivered, true, '投到才落 delivered');
});

test('排空：投递返回 false → 保持未投（至少一次投递，不假装送达）', async () => {
  const paths = freshPaths();
  const runId = 'wf_1111';
  const run = await makeRun(paths, runId);
  await writeIndex(run.indexFile, baseIndex(runId, 'failed', { reason: 'interrupted', endedAt: 'x' }));
  await createExclusive(run.terminalFile, '{}');
  await putNotice(run, { kind: 'settled-notice', runId, sha256: 'b'.repeat(64), status: 'failed', index: run.indexFile, body: 'x', at: 'x' });
  const report = await bootSweep({ paths, clock: CLOCK, deliverNotice: () => false });
  assert.equal(report.drained[0].delivered, false);
  assert.equal((await readOutbox(run))[0].delivered, false);
});

test('排空：已 delivered 的项不重投', async () => {
  const paths = freshPaths();
  const runId = 'wf_2222';
  const run = await makeRun(paths, runId);
  await writeIndex(run.indexFile, baseIndex(runId, 'completed', { reason: 'completed', endedAt: 'x' }));
  await createExclusive(run.terminalFile, '{}');
  const put = await putNotice(run, { kind: 'settled-notice', runId, sha256: 'c'.repeat(64), status: 'completed', index: run.indexFile, body: 'x', at: 'x' });
  await markNoticeDelivered(run, put.item, 'y');
  const delivered = [];
  const report = await bootSweep({ paths, clock: CLOCK, deliverNotice: (n) => { delivered.push(n); return true; } });
  assert.equal(report.drained.length, 0);
  assert.equal(delivered.length, 0);
});

test('排空：无 deliverNotice 接线时只统计未投、不投递', async () => {
  const paths = freshPaths();
  const runId = 'wf_3333';
  const run = await makeRun(paths, runId);
  await writeJsonAtomic(run.snapshotFile, baseIndex(runId, 'cancelled', { reason: 'cancelled', endedAt: 'x' }));
  await createExclusive(run.terminalFile, '{}');
  await putNotice(run, { kind: 'settled-notice', runId, sha256: 'd'.repeat(64), status: 'cancelled', index: run.indexFile, body: 'x', at: 'x' });
  const report = await bootSweep({ paths, clock: CLOCK });
  assert.equal(report.drained.length, 1);
  assert.equal(report.drained[0].delivered, false, '没有投递手 → 保持未投');
});

// ── 两趟协作：认领补写 + 排空投递，单次扫描内闭合 ──────────────────

test('两趟协作：放大帧认领补 outbox 未投项 → 同一趟排空补投，一次启动内闭合', async () => {
  const paths = freshPaths();
  const runId = 'wf_4444';
  const run = await makeRun(paths, runId);
  await writeJsonAtomic(run.snapshotFile, baseIndex(runId, 'completed', { reason: 'completed', endedAt: 'x' }));
  const delivered = [];
  const report = await bootSweep({ paths, clock: CLOCK, deliverNotice: (n) => { delivered.push(n); return true; } });
  assert.equal(report.claimed.length, 1, '先认领（补标记 + 补 outbox）');
  assert.equal(report.drained.length, 1, '后排空（投刚补的那条）');
  assert.equal(delivered.length, 1);
  assert.equal((await readOutbox(run))[0].delivered, true);
});

// ── 排他性：并发/重复认领不重复宣告终态 ────────────────────────────

test('二次扫描：首轮认领后的 run 再扫既不认领也不误投', async () => {
  const paths = freshPaths();
  const runId = 'wf_5555';
  const run = await makeRun(paths, runId);
  await writeIndex(run.indexFile, baseIndex(runId, 'running'));
  const audit = [];
  await bootSweep({ paths, clock: CLOCK, audit: (e) => audit.push(e) });
  // 首轮已把 interrupted 的 outbox 投递（无 deliverNotice 故未投）；第二轮仍不认领（有标记）
  await bootSweep({ paths, clock: CLOCK, audit: (e) => audit.push(e) });
  assert.equal(audit.filter((e) => e.action === 'claimed').length, 1, '只有首轮认领一条 claimed');
});

// ── 逐帧容错：坏帧只记错、不炸整轮 ────────────────────────────────

test('认领容错：索引 schema 版本超前（拒读）→ 记 errors[claim]，其余帧照常', async () => {
  const paths = freshPaths();
  const runPathsFor = (id) => runPaths(paths, id);
  const badRun = await makeRun(paths, 'wf_6666');
  await writeJsonAtomic(badRun.indexFile, { ...baseIndex('wf_6666', 'running'), schemaVersion: 999 });
  const goodRun = await makeRun(paths, 'wf_7777');
  await writeIndex(goodRun.indexFile, baseIndex('wf_7777', 'running'));
  const report = await bootSweep({ paths, clock: CLOCK });
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].stage, 'claim');
  assert.equal(report.errors[0].runId, 'wf_6666');
  assert.equal(report.claimed.length, 1, '好帧照常被认领');
  assert.equal(report.claimed[0].runId, 'wf_7777');
  void runPathsFor;
});

test('排空容错：outbox 里有坏 JSON → 记 errors[drain]', async () => {
  const paths = freshPaths();
  const run = await makeRun(paths, 'wf_8888');
  await createExclusive(run.terminalFile, '{}');
  await writeIndex(run.indexFile, baseIndex('wf_8888', 'completed', { reason: 'completed', endedAt: 'x' }));
  fs.writeFileSync(path.join(run.outboxDir, 'settled-notice-x.json'), '{ not json');
  const report = await bootSweep({ paths, clock: CLOCK });
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].stage, 'drain');
});

// ── worktree reconcile 钩子 ───────────────────────────────────────

test('boot-sweep 顺带调 worktree reconcile（收干净件走 T8 机制）', async () => {
  const paths = freshPaths();
  let called = 0;
  await bootSweep({ paths, clock: CLOCK, worktrees: { reconcileAbandoned: async () => { called += 1; } } });
  assert.equal(called, 1);
});

test('worktree reconcile 抛错不毁掉启动扫描', async () => {
  const paths = freshPaths();
  const report = await bootSweep({ paths, clock: CLOCK, worktrees: { reconcileAbandoned: async () => { throw new Error('git exploded'); } } });
  assert.deepEqual(report.claimed, []);
  assert.deepEqual(report.errors, [], 'reconcile 的抛错被吞，不进逐帧 errors');
});
