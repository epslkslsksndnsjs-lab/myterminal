// Workflows T10（#233）：崩溃点矩阵贯穿锁——真引擎停在三帧 → 重启扫描复原
//
// 三点（快照后 / 标记后 / 通知投递前）各停一次，靠 T1 的故障注入缝确定性命中；
// "重启"= 同一 managed 根上新建引擎跑 recoverOnBoot。断：无假死判（终态不被覆写）、
// outbox 排空（notice 补发）、结果可读、无 .tmp 残留；并钉结算序、单一结算函数恰好一次、
// 取消幂等不重复发通知、pause 中途崩溃按 interrupted 收（fail-closed）、双会话同 runId 双 resume 第二拒。

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
import { readRegistry } from '../dist/workflows/registry.js';
import { readOutbox } from '../dist/workflows/notice.js';

let TMP;

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-233frames-'));
  TMP = dir;
  const workspaceDir = path.join(dir, 'workspace');
  const managedRoot = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { workspaceDir, managedRoot, paths: workflowPaths(managedRoot) };
}

afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

const COMPLETING = () => ({ complete: async () => ({ text: 'ok', outputTokens: 2 }) });
const HANGING = () => ({ complete: () => new Promise(() => {}) });
const SCRIPT = "await agent('x', { label: 'X' });\nreturn 1;";

function newEngine(temp, extra = {}) {
  return new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock: extra.clock ?? virtualClock(),
    adapterFactory: extra.adapterFactory ?? COMPLETING,
    concurrencyWindow: 1,
    ...extra,
  });
}

/** 跑到某个 crash 帧停下（钩子抛出 = 进程在此终止），把半截形状留在盘上。 */
async function crashAt(temp, point) {
  const engine = newEngine(temp, {
    adapterFactory: COMPLETING,
    crash: (p) => { if (p === point) throw new Error(`hard stop at ${point}`); },
  });
  const started = await engine.start({ script: SCRIPT, ownerSessionId: 'sess-a' });
  let rejected = null;
  try {
    await started.completion;
  } catch (error) {
    rejected = (error && error.message) || String(error);
  }
  return { runId: started.runId, rejected, run: runPaths(temp.paths, started.runId) };
}

/** 重启：新引擎 + deliverNotice 接线，跑启动扫描；返回投递记录与报告。 */
async function rebootAndRecover(temp) {
  const delivered = [];
  const clock = virtualClock();
  const engine = newEngine(temp, { clock, adapterFactory: COMPLETING, deliverNotice: (n) => { delivered.push(n); return true; } });
  const report = await engine.recoverOnBoot();
  return { report, delivered, engine };
}

function tmpLeftovers(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tmp')) found.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found;
}

// ═══════════════════════════════════════════════════════════════
// kill -9 三点矩阵：各停一次 → 重启复原
// ═══════════════════════════════════════════════════════════════

test('快照后停 → 重启：补标记不覆写快照、outbox 补投、结果可读、无 .tmp', async () => {
  const temp = tempWorkspace();
  const { runId, run } = await crashAt(temp, 'after-snapshot');
  assert.equal(fs.existsSync(run.snapshotFile), true, '停时快照已落');
  assert.equal(fs.existsSync(run.terminalFile), false, '停时标记未落');
  const snapshotBefore = fs.readFileSync(run.snapshotFile);

  const { report, delivered } = await rebootAndRecover(temp);
  const claimed = report.claimed.find((c) => c.runId === runId);
  assert.ok(claimed, '放大帧被认领');
  assert.equal(claimed.hadSnapshot, true, '有快照 → 只补标记');
  assert.equal(Buffer.compare(snapshotBefore, fs.readFileSync(run.snapshotFile)), 0, '终态不被覆写（无假死判）');
  assert.equal(fs.existsSync(run.terminalFile), true, '补了标记');
  assert.equal(delivered.length, 1, '补写的通知被排空趟投出');
  const outbox = await readOutbox(run);
  assert.equal(outbox[0].delivered, true, 'outbox 排空');
  const index = await readIndex(run.indexFile);
  assert.equal(index.status, 'completed', '结果可读、终态是 completed');
  assert.deepEqual(tmpLeftovers(temp.paths.workflowsRoot), [], '无 .tmp 残留');
});

test('标记后停 → 重启：不认领（不覆写终态）、outbox 补投', async () => {
  const temp = tempWorkspace();
  const { runId, run } = await crashAt(temp, 'after-terminal');
  assert.equal(fs.existsSync(run.terminalFile), true, '停时标记已落');
  const snapshotBefore = fs.readFileSync(run.snapshotFile);

  const { report, delivered } = await rebootAndRecover(temp);
  assert.equal(report.claimed.find((c) => c.runId === runId), undefined, '有标记 → 认领趟跳过，绝不改判');
  assert.equal(Buffer.compare(snapshotBefore, fs.readFileSync(run.snapshotFile)), 0, '快照一字不动');
  assert.equal(delivered.length, 1, '停时通知未投 → 排空趟补投');
  assert.equal((await readOutbox(run))[0].delivered, true);
});

test('通知投递前停 → 重启：不认领、通知补投恰一次', async () => {
  const temp = tempWorkspace();
  const { runId, run } = await crashAt(temp, 'before-notice');
  assert.equal(fs.existsSync(run.terminalFile), true);
  const registry = await readRegistry(temp.paths.registryFile);
  assert.equal(registry.runs.find((e) => e.runId === runId).status, 'completed', '注册表已推进（在标记之后）');

  const { report, delivered } = await rebootAndRecover(temp);
  assert.equal(report.claimed.find((c) => c.runId === runId), undefined);
  assert.equal(delivered.length, 1, '差一步投递的那条被补投');
  assert.equal(delivered[0].runId, runId);
  assert.equal((await readSnapshot(run.snapshotFile)).status, 'completed', '无更新版误判：仍是同一终态');
});

test('三点各停一次：三帧的落盘形状互不相同（结算序可辨）', async () => {
  const t1 = tempWorkspace();
  const a = await crashAt(t1, 'after-snapshot');
  const snapshot = fs.existsSync(a.run.snapshotFile);
  const marker = fs.existsSync(a.run.terminalFile);
  const outbox = (await readOutbox(a.run)).length;

  const t2 = tempWorkspace();
  const b = await crashAt(t2, 'after-terminal');
  const marker2 = fs.existsSync(b.run.terminalFile);
  const outbox2 = (await readOutbox(b.run)).length;

  assert.deepEqual([snapshot, marker, outbox], [true, false, 0], 'after-snapshot：只有快照');
  assert.deepEqual([marker2, outbox2], [true, 1], 'after-terminal：标记在、outbox 在（通知先落盘再落标记）');
});

// ═══════════════════════════════════════════════════════════════
// 单一结算函数：模块侧恰好一次
// ═══════════════════════════════════════════════════════════════

test('健康完成：settled-notice 恰一条、结算审计恰一条、三件套齐全', async () => {
  const temp = tempWorkspace();
  const delivered = [];
  const audit = [];
  const engine = newEngine(temp, { adapterFactory: COMPLETING, deliverNotice: (n) => { delivered.push(n); return true; }, audit: (e) => audit.push(e) });
  const { runId } = await engine.start({ script: SCRIPT, ownerSessionId: 'sess-a' });
  await engine.settled(runId);
  assert.equal(delivered.filter((n) => n.runId === runId).length, 1, '模块侧结算函数恰好一次投递');
  assert.equal(audit.filter((e) => e.action === 'workflow_settle').length, 1, '一条终态结算审计');
  const run = runPaths(temp.paths, runId);
  assert.equal(fs.existsSync(run.snapshotFile), true);
  assert.equal(fs.existsSync(run.terminalFile), true);
  assert.equal((await readOutbox(run))[0].delivered, true);
});

test('重复扫描一个已 settle 的 completed run：不认领、不重投、不改判', async () => {
  const temp = tempWorkspace();
  const engine = newEngine(temp, { adapterFactory: COMPLETING, deliverNotice: () => true });
  const { runId } = await engine.start({ script: SCRIPT, ownerSessionId: 'sess-a' });
  await engine.settled(runId);
  const snapshot = fs.readFileSync(runPaths(temp.paths, runId).snapshotFile);
  const { report, delivered } = await rebootAndRecover(temp);
  assert.equal(report.claimed.find((c) => c.runId === runId), undefined);
  assert.equal(delivered.length, 0, '已投递 → 不重投');
  assert.equal(Buffer.compare(snapshot, fs.readFileSync(runPaths(temp.paths, runId).snapshotFile)), 0);
});

// ═══════════════════════════════════════════════════════════════
// 取消 × 结算：幂等，恰一个通知
// ═══════════════════════════════════════════════════════════════

test('取消一个已完成 run：幂等返回当前终态、不再补发第二条通知', async () => {
  const temp = tempWorkspace();
  const delivered = [];
  const engine = newEngine(temp, { adapterFactory: COMPLETING, deliverNotice: (n) => { delivered.push(n); return true; } });
  const { runId } = await engine.start({ script: SCRIPT, ownerSessionId: 'sess-a' });
  await engine.settled(runId);
  const second = await engine.controlAsLocal('cancel', runId);
  assert.equal(second.status, 'completed', '终态幂等');
  assert.equal(delivered.filter((n) => n.runId === runId).length, 1, '仍只有一条 settled-notice');
});

test('取消在飞 run：结算 cancelled、恰一条通知；再取消幂等', async () => {
  const temp = tempWorkspace();
  const delivered = [];
  const engine = newEngine(temp, { adapterFactory: HANGING, deliverNotice: (n) => { delivered.push(n); return true; } });
  const { runId } = await engine.start({ script: SCRIPT, ownerSessionId: 'sess-a' });
  const first = await engine.controlAsLocal('cancel', runId);
  assert.equal(first.status, 'cancelled');
  await engine.controlAsLocal('cancel', runId);
  assert.equal(delivered.filter((n) => n.runId === runId).length, 1, '对打两次仍恰一通知');
  assert.equal((await readIndex(runPaths(temp.paths, runId).indexFile)).status, 'cancelled');
});

// ═══════════════════════════════════════════════════════════════
// pause 中途崩溃 → 重启按 interrupted 收（fail-closed）
// ═══════════════════════════════════════════════════════════════

test('pause 后进程死：重启认领为 failed(interrupted)，不复活的在飞态', async () => {
  const temp = tempWorkspace();
  const engine = newEngine(temp, { adapterFactory: HANGING });
  const { runId } = await engine.start({ script: SCRIPT, ownerSessionId: 'sess-a' });
  await engine.controlAsLocal('pause', runId);
  assert.equal((await readIndex(runPaths(temp.paths, runId).indexFile)).status, 'paused');

  const { report } = await rebootAndRecover(temp);
  const claimed = report.claimed.find((c) => c.runId === runId);
  assert.ok(claimed, '无标记 → 认领趟命中');
  assert.equal(claimed.status, 'failed');
  assert.equal(claimed.reason, 'interrupted');
  assert.equal((await readIndex(runPaths(temp.paths, runId).indexFile)).status, 'failed', 'fail-closed：不复活成 running/paused');
});

// ═══════════════════════════════════════════════════════════════
// 双会话同 runId 双 resume → 第二拒（排他锁）
// ═══════════════════════════════════════════════════════════════

test('第二个会话对同一 runId 续跑 → resume-locked 拒（同一把排他锁）', async () => {
  const temp = tempWorkspace();
  // 先起一条并取消，得到一个 cancelled run（带 journal + 持久脚本），可续跑。
  const boot = newEngine(temp, { adapterFactory: HANGING });
  const { runId, scriptPath } = await boot.start({ script: SCRIPT, ownerSessionId: 'sess-owner' });
  await boot.controlAsLocal('cancel', runId);

  const hang2 = { adapterFactory: HANGING };
  const clock = virtualClock();
  // 两个都声称有权（延续链含归属会话）的续跑者，先后对同一 runId 下手——排他锁裁决第二路。
  const engineA = newEngine(temp, { clock, ...hang2 });
  const resumedA = await engineA.start({ scriptPath, resumeFromRunId: runId, ownerSessionId: 'sess-a', ownerCandidates: ['sess-a', 'sess-owner'] });
  assert.equal(resumedA.status, 'running', 'A 续跑成功并持锁');

  // 会话 B：归属闸放行（候选链含 owner），但锁被 A（存活 pid、同一冻结 epoch）持着 → 拒。
  const engineB = newEngine(temp, { clock, ...hang2 });
  let code = null;
  let reason = null;
  try {
    await engineB.start({ scriptPath, resumeFromRunId: runId, ownerSessionId: 'sess-b', ownerCandidates: ['sess-b', 'sess-owner'] });
  } catch (error) {
    code = error.code;
    reason = error.reason;
  }
  assert.equal(code, 'FORBIDDEN', '第二路被拒');
  assert.equal(reason, 'resume-locked');
});
