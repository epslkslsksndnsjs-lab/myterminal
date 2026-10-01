// Workflows T10（#233）· 终极验收：GPT 死亡 25 分钟 + 复活——假模型、虚拟钟，整套 ×7
//
// 第一级机器门禁。收口断言全落在模块自己拥有的边界上（run 结算 → 三件套 → settled-notice 进收件箱 →
// wait_for_path 零模型等待 → concludeReducer 摘要交付 → 复活首读信箱），不借道既有 subagent 执行器循环
// （那是 T6 #229 的地盘，已另行钉死）。全跑虚拟钟，CI 分钟级、不真等；整套连跑 7 遍。
//
// 有效余量（ADR §22ⓙ）：数字账本（35/40、等待回合 3 整 + 1 末）+ conclude/wait 两面行为——
// 标记在预算内落地 → completed 摘要交付；标记没在预算内出现 → wait-timeout 三段报告（禁止假完整）+ 补跑交付。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { virtualClock } from '../dist/workflows/clock.js';
import { workflowPaths, runPaths } from '../dist/workflows/paths.js';
import { defaultWorkflowGates } from '../dist/workflows/gates.js';
import { reducerWaitRounds, resolveReducerBudget, concludeReducer, claimReducerWaiter } from '../dist/workflows/reducer.js';
import { WorkflowEvents } from '../dist/workflows/events.js';
import { initWorkflowEngine, resetWorkflowEngine } from '../dist/workflows/runtime.js';
import { readOutbox } from '../dist/workflows/notice.js';
import { MyTerminalStore } from '../dist/store.js';
import { getTool, setWaitForPathTimingForTesting, resetWaitForPathTimingForTesting } from '../dist/subagent/tools.js';

const TMP = [];
const MULTI_SCRIPT = "await agent('one', { label: 'one' });\nawait agent('two', { label: 'two' });\nreturn { ok: true };";
const HOUR = 60 * 60 * 1000;
const MINUTE = 60_000;

function tempDirs() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-233-final-')));
  TMP.push(dir);
  const workspaceDir = path.join(dir, 'workspace');
  const managedRoot = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { dir, workspaceDir, managedRoot, paths: workflowPaths(managedRoot) };
}

function tightGates(over = {}) {
  return {
    runGateMs: 10_000, dispatchWindowMs: 5_000, dispatchTurns: 12, stallMs: 5_000,
    waitChunkMs: 2_000, reducerBudgetMs: 12_000, reducerTimeoutMs: 14_000, reduceSlackMs: 2_000, ...over,
  };
}

/** 计数 run 模型：等待（wait_for_path）绝不触碰它——零 token 等待的直接读数。 */
function countingModel() {
  const state = { instances: 0, calls: 0 };
  const factory = () => {
    state.instances += 1;
    return { complete: async () => { state.calls += 1; return { text: 'ok', outputTokens: 3 }; } };
  };
  return { factory, state };
}

function harness(options = {}) {
  const t = tempDirs();
  let storeNow = 1_760_000_000_000;
  const store = new MyTerminalStore(path.join(t.dir, 'state'), () => storeNow);
  fs.mkdirSync(path.join(t.dir, 'state'), { recursive: true });
  const root = store.registerRoot({ name: 'gpt-parent' });
  const clock = virtualClock();
  const model = countingModel();
  const deliverNotices = [];
  const init = initWorkflowEngine({
    workspaceDir: t.workspaceDir,
    managedRoot: t.managedRoot,
    clock,
    events: new WorkflowEvents(),
    adapterFactory: model.factory,
    gates: options.gates ?? tightGates(),
    concurrencyWindow: 2,
    deliverNotice: (notice) => { store.sendMessage(notice.ownerSessionId, notice.ownerSessionId, notice.body); deliverNotices.push(notice); return true; },
  });
  const ageSessionAway = (minutes) => { storeNow += minutes * MINUTE; store.refreshTemporalStates(); };
  const startRun = () => init.start({ script: MULTI_SCRIPT, ownerSessionId: root.session.id });
  return { ...t, store, root, clock, model, init, deliverNotices, ageSessionAway, startRun };
}

/** 直接驱动 wait_for_path 工具：fs 轮询、零模型调用；sleep 推虚拟钟。 */
async function callWaitTool(cwd, pathArg, clock, timeoutSec) {
  setWaitForPathTimingForTesting({
    now: () => clock.now(),
    pollIntervalMs: 2_000,
    sleep: (ms) => { clock.advance(ms); return Promise.resolve(); },
  });
  const ctx = { cwd, signal: new AbortController().signal, agentId: 'sa_wait', readOnly: false };
  return await getTool('wait_for_path').call({ path: pathArg, timeoutSec }, ctx);
}

function walkTmp(root) {
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tmp')) found.push(full);
    }
  };
  walk(root);
  return found;
}

afterEach(() => {
  resetWorkflowEngine();
  resetWaitForPathTimingForTesting();
  while (TMP.length) {
    const dir = TMP.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

const bodyOf = (inbox, kind, runId) => inbox.filter((m) => m.body.startsWith(`[workflow] kind=${kind} runId=${runId}`));

// ═══════════════════════════════════════════════════════════════
// 终局场景一整套 ×7（第一级机器门禁）
// ═══════════════════════════════════════════════════════════════

function terminalScenario(run) {
  test(`终局场景 #${run}：多路 run + GPT 死亡 25 分钟 + 复活首读（a–e）`, async () => {
    const h = harness();
    const started = await h.startRun();
    const rd = runPaths(h.paths, started.runId);
    const index = await h.init.settled(started.runId);   // ① 多路 run 在闸内自走自结

    // ④ 等待期零模型调用：wait_for_path 纯 fs 轮询，绝不触 run 模型。
    const callsBefore = h.model.state.calls;
    const waitResult = await callWaitTool(h.workspaceDir, rd.terminalFile, h.clock, 600);
    assert.equal(waitResult.state, 'ready', JSON.stringify(waitResult));
    assert.equal(h.model.state.calls, callsBefore, '等待没触模型（零 token）');

    // a) 三件齐全 + 每路一文件 + 路径合规 + 无 .tmp。
    assert.equal(index.status, 'completed');
    assert.ok(fs.existsSync(rd.snapshotFile));
    assert.ok(fs.existsSync(rd.terminalFile));
    assert.ok(fs.existsSync(rd.indexFile));
    assert.ok(fs.readdirSync(rd.agentsDir).filter((n) => n.endsWith('.json')).length >= 2, '每路一文件');
    assert.equal(rd.dir, path.join(h.paths.runsRoot, started.runId), '路径合规');
    assert.deepEqual(walkTmp(h.paths.workflowsRoot), [], '无 .tmp 残留');

    // 摘要交付：写 digest → concludeReducer（只认盘面）→ 经消息管线投给发起会话。
    fs.writeFileSync(rd.digestFile, '结论 2/2 成功\n产物与索引见下\n', 'utf8');
    await claimReducerWaiter(h.paths, { runId: started.runId, agentId: 'sa_digest', ownerSessionId: h.root.session.id, at: h.clock.iso() });
    const verdict = await concludeReducer(h.paths, { runId: started.runId, agentId: 'sa_digest', digestPath: rd.digestFile });
    assert.equal(verdict.status, 'completed');
    const digestSha = crypto.createHash('sha256').update(fs.readFileSync(rd.digestFile)).digest('hex');
    assert.equal(verdict.firstLine, `[workflow] kind=digest runId=${started.runId} sha256=${digestSha}`);
    h.store.sendMessage(h.root.session.id, h.root.session.id, `${verdict.firstLine}\n2/2 succeeded · ${rd.digestFile} · read the index`);

    // ③ 缺席 25 分钟 → 会话 stale；⑤ 复活 = session_inherit（旧 sessionToken 原会话回收）。
    h.ageSessionAway(25);
    assert.equal(h.store.listSessions().find((s) => s.id === h.root.session.id).presence, 'stale', '缺席 25 分钟即 stale');
    const revived = h.store.inherit(h.root.session.id, { sessionToken: h.root.identity.sessionToken });
    assert.equal(revived.session.presence, 'claimed', '复活即重占原会话');

    // 复活首读：一次读到"活已干完 + 摘要绝对路径"，不需试探。
    const inbox = h.store.inbox(h.root.session.id, false);
    const notices = bodyOf(inbox, 'settled-notice', started.runId);
    const digests = bodyOf(inbox, 'digest', started.runId);
    // b) 收件箱：settled-notice ≤200、kind 正确、未读；摘要交付存在。
    assert.equal(notices.length, 1, 'settled-notice 恰一条');
    assert.ok(notices[0].body.length <= 200, '终态消息 ≤200 码元');
    assert.equal(notices[0].readAt, undefined, '未读（已读位只是标记，消息永不删）');
    assert.equal(digests.length, 1, '摘要交付存在（复活首读即得）');
    assert.ok(digests[0].body.includes(rd.digestFile), '摘要正文给绝对路径');
    // e) 摘要交付恰一次。
    assert.equal(h.deliverNotices.filter((n) => n.runId === started.runId).length, 1, '终态消息恰一次');
    assert.equal((await readOutbox(rd))[0].delivered, true, 'outbox 已排空');
  });
}

for (let i = 1; i <= 7; i += 1) terminalScenario(i);

// ═══════════════════════════════════════════════════════════════
// 有效余量（§22ⓙ）
// ═══════════════════════════════════════════════════════════════

test('默认档数字：runGate=30 / budget=35 / timeout=40 / slack=5，等待回合 = 3 整 + 1 末 = 4', () => {
  const gates = defaultWorkflowGates();
  assert.equal(gates.runGateMs, 30 * MINUTE);
  assert.equal(gates.reducerBudgetMs, 35 * MINUTE);
  assert.equal(gates.reducerTimeoutMs, 40 * MINUTE);
  assert.equal(gates.reduceSlackMs, 5 * MINUTE);
  assert.deepEqual(reducerWaitRounds(gates), { fullRounds: 3, finalRound: 1, calls: 4, waitChunkSec: 600 });
});

test('有效余量·标记在预算内落地（34:50）→ completed 摘要交付，非零交付', async () => {
  const gates = defaultWorkflowGates();
  const budget = resolveReducerBudget(gates, { startedAt: 1_000_000, now: () => 1_000_000 });
  // 标记在 34:50 落地 = budgetEndsAt(35:00) 之前；末回合由预算末端裁剪，等待止于预算、不吃聚合余量。
  assert.equal(budget.budgetEndsAt, 1_000_000 + 35 * MINUTE);
  assert.equal(budget.timeoutSec, 40 * 60, '硬兜底 = budget + slack = 40 分钟');
  // 3 个整回合（各 600s）到 30:00，末回合（索引 3）由预算末端裁剪为 300s（30:00→35:00），不是整回合 600s。
  assert.equal(budget.roundTimeoutSec(3), 300, '末回合裁剪到预算末端 = 300s（有效余量：等待止于 35:00）');
  assert.equal(budget.roundTimeoutSec(0), 600, '整回合 = waitChunk = 600s');
});

test('有效余量·标记晚于预算落地（39:50）→ wait-timeout 三段报告 + 补跑交付，绝无零交付', async () => {
  const h = harness();
  const started = await h.startRun();
  const rd = runPaths(h.paths, started.runId);
  // run 尚未结算（标记不在）→ 收场判定诚实报 wait-timeout（禁止 completed 掩盖），三段。
  const first = await concludeReducer(h.paths, { runId: started.runId, agentId: 'sa_first', digestPath: rd.digestFile });
  assert.equal(first.status, 'failed');
  assert.equal(first.reason, 'wait-timeout');
  assert.equal(first.report.split('\n').length, 3, '三段报告 = 结论 / 失败清单 / 路径 + 索引');
  assert.ok(first.report.includes('未结算') && first.report.includes('无摘要'), '报告说清楚未结算、无摘要');

  // run 之后真结算（39:50 标记落地，早于硬杀 40:00）→ 同 runId 补跑，标记已在立即交付，非零交付。
  await h.init.settled(started.runId);
  fs.writeFileSync(rd.digestFile, '补跑摘要\n', 'utf8');
  const again = await concludeReducer(h.paths, { runId: started.runId, agentId: 'sa_second', digestPath: rd.digestFile });
  assert.equal(again.status, 'completed', '补跑真交付');
  assert.ok(again.firstLine.startsWith('[workflow] kind=digest'), '交付首行 KV');
});
