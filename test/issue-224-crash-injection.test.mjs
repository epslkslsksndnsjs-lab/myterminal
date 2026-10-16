// Workflows T1（#224）补口：结算阶段的故障注入点
//
// 票面 AC6 要求"故障注入点（结算阶段停机钩子 / env，供 T10 的 kill -9 帧确定性命中）"。
// 崩溃帧由 ADR §22ⓕ 钉死为三个：快照后 / 终态标记后 / 通知投递前。
// 本文件钉的是"钩子落在哪、每帧盘上留什么形状"——不是崩溃恢复本身（属 T10 #233）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkflowEngine } from '../dist/workflows/engine.js';
import { virtualClock } from '../dist/workflows/clock.js';
import { workflowPaths, runPaths } from '../dist/workflows/paths.js';
import { readRegistry } from '../dist/workflows/registry.js';
import { CRASH_POINTS, CRASH_AT_ENV, resolveCrashPlan } from '../dist/workflows/crash.js';

let TMP;

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-224crash-'));
  TMP = dir;
  const workspaceDir = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const managedRoot = path.join(workspaceDir, '.myterminal');
  return { workspaceDir, managedRoot, paths: workflowPaths(managedRoot) };
}

async function settleInto(temp, options) {
  const engine = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock: virtualClock(),
    audit: () => { /* 本票不重述审计契约 */ },
    adapterFactory: () => ({ complete: async () => ({ text: 'ok', outputTokens: 2 }) }),
    ...options,
  });
  return await engine.start({ script: "await agent('x', { label: 'X' });\nreturn 1;", ownerSessionId: 'sess-a' });
}

/** 等一个可观测条件成立，而不是睡固定毫秒：后台那趟要过真 fs，负载一高固定值就不够。 */
async function until(condition, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function settleAndCapture(temp, point) {
  const notices = [];
  const started = await settleInto(temp, {
    deliverNotice: () => { notices.push('notice'); return true; },
    ...(point === undefined ? {} : { crash: (p) => { if (p === point) throw new Error(`simulated death at ${p}`); } }),
  });
  let rejected = null;
  try {
    await started.completion;
  } catch (error) {
    rejected = (error && error.message) || String(error);
  }
  const run = runPaths(temp.paths, started.runId);
  const registry = await readRegistry(temp.paths.registryFile);
  return {
    run,
    notices,
    rejected,
    snapshot: fs.existsSync(run.snapshotFile),
    marker: fs.existsSync(run.terminalFile),
    registryStatus: registry.runs.find((entry) => entry.runId === started.runId).status,
    indexStatus: JSON.parse(fs.readFileSync(run.indexFile, 'utf8')).status,
  };
}

afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

// ═══════════════════════════════════════════════════════════════

test('崩溃帧 = 票面钉死的三帧，一帧不多一帧不少', () => {
  assert.deepEqual([...CRASH_POINTS], ['after-snapshot', 'after-terminal', 'before-notice'], '§22ⓕ 的三点矩阵');
  assert.equal(CRASH_AT_ENV, 'MYTERMINAL_WORKFLOWS_CRASH_AT', 'env 名走仓库既有前缀');
});

test('快照后终止：有快照、无终态标记、注册表仍活跃、通知未投递', async () => {
  const temp = tempWorkspace();
  const seen = await settleAndCapture(temp, 'after-snapshot');
  assert.equal(seen.snapshot, true, '快照已落');
  assert.equal(seen.marker, false, '标记还没写——这一帧正是"放大帧"：有快照、无 started-无-result 之外的一切');
  assert.equal(seen.registryStatus, 'running', '注册表未被推进为终态');
  assert.equal(seen.notices.length, 0, '通知未投递');
  assert.match(seen.rejected, /simulated death at after-snapshot/, '注入即终止，不许被当成普通失败重新判一次终态');
});

test('终态标记后终止：标记已在、注册表尚未推进、通知未投递', async () => {
  const temp = tempWorkspace();
  const seen = await settleAndCapture(temp, 'after-terminal');
  assert.equal(seen.snapshot, true);
  assert.equal(seen.marker, true, '标记是结算的唯一线性化点，这一帧它刚落地');
  assert.equal(seen.registryStatus, 'running', '注册表推进发生在标记之后，所以这一帧还没推进');
  assert.equal(seen.notices.length, 0);
});

test('通知投递前终止：三件盘面齐、注册表已终态、通知仍未投递', async () => {
  const temp = tempWorkspace();
  const seen = await settleAndCapture(temp, 'before-notice');
  assert.equal(seen.marker, true);
  assert.equal(seen.snapshot, true);
  assert.equal(seen.registryStatus, 'completed', '与"标记后"那一帧可区分，靠的就是注册表');
  assert.equal(seen.notices.length, 0, '差一步就投递——outbox 排空趟要能补上（判据属 T10）');
});

test('不注入时：三件套齐且通知恰一次（钩子缺省必须是纯旁观）', async () => {
  const temp = tempWorkspace();
  const seen = await settleAndCapture(temp, undefined);
  assert.equal(seen.rejected, null, '没有注入就不该有任何异常');
  assert.equal(seen.marker, true);
  assert.equal(seen.snapshot, true);
  assert.equal(seen.registryStatus, 'completed');
  assert.equal(seen.indexStatus, 'completed');
  assert.deepEqual(seen.notices, ['notice'], '通知恰一次，不多不少');
});

test('三帧各杀一次都命中：帧序不可调换（顺序即票面）', async () => {
  const calls = [];
  const temp = tempWorkspace();
  const started = await settleInto(temp, { crash: (point) => { calls.push(point); } });
  await started.completion;
  assert.deepEqual(calls, ['after-snapshot', 'after-terminal', 'before-notice'], '结算里的落点顺序 = 快照 → 标记 → 通知');
});

test('钩子不抛不杀就等于没注入：终态与产物照常', async () => {
  const temp = tempWorkspace();
  const notices = [];
  const started = await settleInto(temp, {
    crash: () => { /* 观察型钩子：记一下就走 */ },
    deliverNotice: () => { notices.push('notice'); return true; },
  });
  const index = await started.completion;
  assert.equal(index.status, 'completed', '钩子不能顺手把 run 判坏');
  assert.deepEqual(notices, ['notice'], '投递照旧恰好一次');
});

// ── env 路线（真 kill -9 用；测试里只验形状，不杀自己） ──────────

test('env 路线：只有命中的那一帧动手，其余帧一律不动', () => {
  const hits = [];
  const plan = resolveCrashPlan({
    env: { [CRASH_AT_ENV]: '  after-terminal  ' },
    kill: (_pid, signal) => hits.push(signal),
  });
  for (const point of CRASH_POINTS) plan(point);
  assert.deepEqual(hits, ['SIGKILL'], '命中一次即终止');
});

test('env 未设 / 空 / 拼错 / 非三帧之一：一律不动作（默认即不注入）', () => {
  for (const raw of [undefined, '', '   ', 'after_snapshot', 'nowhere', 'ALL', '0']) {
    const hits = [];
    const plan = resolveCrashPlan({ env: raw === undefined ? {} : { [CRASH_AT_ENV]: raw }, kill: () => hits.push(1) });
    for (const point of CRASH_POINTS) plan(point);
    assert.deepEqual(hits, [], `不该动手：${String(raw)}`);
  }
});

test('env 路线的缺省动作是 SIGKILL 打到本进程，不是优雅退出（要的就是半截状态）', () => {
  const attempted = [];
  const plan = resolveCrashPlan({ env: { [CRASH_AT_ENV]: 'after-snapshot' }, pid: 4242, kill: (pid, signal) => attempted.push([pid, signal]) });
  plan('after-snapshot');
  assert.deepEqual(attempted, [[4242, 'SIGKILL']]);
  const defaults = [];
  resolveCrashPlan({ env: { [CRASH_AT_ENV]: 'before-notice' }, pid: 9999, kill: (pid, signal) => defaults.push([pid, signal]) })('before-notice');
  assert.deepEqual(defaults, [[9999, 'SIGKILL']]);
});

test('引擎走 env 路线：命中帧动手、其余帧不动，且显式钩子压过 env', async () => {
  const hits = [];
  const temp = tempWorkspace();
  const started = await settleInto(temp, {
    crashEnv: { [CRASH_AT_ENV]: 'after-terminal' },
    crashKill: () => { hits.push('kill'); },
  });
  await started.completion;
  assert.deepEqual(hits, ['kill'], '三帧里只命中一帧');

  const both = [];
  const second = await settleInto(temp, {
    crashEnv: { [CRASH_AT_ENV]: 'after-terminal' },
    crashKill: () => both.push('env'),
    crash: (point) => both.push(`hook:${point}`),
  });
  await second.completion;
  assert.deepEqual(both, ['hook:after-snapshot', 'hook:after-terminal', 'hook:before-notice'], '注入缝优先，env 让位');
});

test('没人接的后台 run 终止：不升级成进程级异常，但留一条 settle-failed 审计', async () => {
  const temp = tempWorkspace();
  const auditLog = [];
  const started = await settleInto(temp, {
    audit: (entry) => auditLog.push(entry),
    crash: (point) => { if (point === 'after-snapshot') throw new Error('background death'); },
  });
  // 故意先不 await completion——工具面就是这个形状：拿到 runId 就走，没人接这个 promise。
  // 所以这里不能"睡固定毫秒"：后台那一趟要过真 fs，机器一忙 20ms 不够，就会假红。
  // 改成等它自己到——审计条目是在拒绝往外冒之前写下的，等它不等于接 promise。
  await until(() => auditLog.some((entry) => entry.reason === 'settle-failed'), '后台终止留下 settle-failed 审计');
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  const failures = auditLog.filter((entry) => entry.reason === 'settle-failed');
  assert.equal(failures.length, 1, '终止必须留账，兜法不是吞');
  assert.equal(failures[0].action, 'workflow_settle');
  assert.equal(failures[0].runId, started.runId);
  assert.match(failures[0].detail, /background death/, '死在哪一步要写得出');
  assert.equal(auditLog.filter((entry) => entry.action === 'workflow_settle' && entry.reason !== 'settle-failed').length, 0, '不许再宣告一次终态');
  // 直接 await 的一方仍拿得到原样的拒绝
  await assert.rejects(() => started.completion, /background death/);
});

// ── 审计汇的两条纪律（id 撞车会毁掉终态证据） ────────────────────

test('同一 run 的 settle 与 settle-failed 必须在审计链里各自存活', async () => {
  const { workflowAuditSink } = await import('../dist/workflows/start.js');
  const { MyTerminalStore } = await import('../dist/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-224audit-'));
  try {
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const store = new MyTerminalStore(stateDir);
    const { session } = store.registerRoot({ name: 'root' });
    const sink = workflowAuditSink(store, dir);
    const at = new Date().toISOString();
    sink({ runId: 'wf_1', action: 'workflow_settle', actor: session.id, status: 'completed', reason: 'completed', at });
    sink({ runId: 'wf_1', action: 'workflow_settle', actor: session.id, status: 'failed', reason: 'settle-failed', detail: 'background death', at });
    const facts = store.auditFacts(50).filter((f) => f.tool.startsWith('workflow_'));
    assert.equal(facts.length, 2, '两条都在——按 id 合并会把终态证据盖掉');
    const failed = facts.find((f) => JSON.stringify(f).includes('settle-failed'));
    assert.ok(failed, '结算期终止那条必须留得下来');
    assert.match(JSON.stringify(failed), /background death/, 'detail 要真落到审计链，不能只活在内存条目里');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('审计 status 照条目本身映射，settle 不再一律记成 completed', async () => {
  const { workflowAuditSink } = await import('../dist/workflows/start.js');
  const { MyTerminalStore } = await import('../dist/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-224audit2-'));
  try {
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const store = new MyTerminalStore(stateDir);
    const { session } = store.registerRoot({ name: 'root' });
    const sink = workflowAuditSink(store, dir);
    const at = new Date().toISOString();
    sink({ runId: 'wf_2', action: 'workflow_settle', actor: session.id, status: 'failed', reason: 'run-gate', at });
    const fact = store.auditFacts(50).find((f) => JSON.stringify(f).includes('run-gate'));
    assert.ok(fact, '失败结算那条要在');
    assert.equal(JSON.stringify(fact).includes('"completed"'), false, '失败的结算不许被记成 completed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
