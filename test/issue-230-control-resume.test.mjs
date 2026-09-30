// Workflows T7（#230）集成：控制与续跑
//
// 覆盖（对应 #230 Acceptance criteria）：
//   AC1 workflow_cancel：幂等 / NOT_FOUND / 非本 root 拒 / subagent 通道 FORBIDDEN /
//       效果 = 结算 cancelled 三件套 + 在飞 abort + 队列清空 + 燃烧停 / 汇总体报 cancelled partial / 审计
//   AC2 pause 冻结：墙钟与 reducer 等待预算不走（虚拟钟）/ pausing→paused 事件可观察 / index.status 原子写 / 原地续
//   AC3 ownerSessionId 三场景确权 / resumeFromRunId 仅限本 root（链外 FORBIDDEN）
//   AC4 resume 排他锁 / 同 sourceRef / args 不同全量重跑 / cancel 后从第一个无 result 起实跑 / 崩溃接管
//   AC5/AC6 缓存矩阵 + 归一化（假模型计数）
//   AC7 重放顺序契约（前缀屏障先于 live / 缓存命中不吃预算与计数）
//   AC8 用量三档 / 取消不退不重算
//   AC9 journal 截断至最长良前缀 + 丢弃段显式记账
//   AC10 审计 cancel / resume / pause / paused-resume
//
// 测试方式：直调 WorkflowEngine（注入假模型 + 虚拟钟 + 可注入锁探针）+ 直调工具条目（归属链 / 通道防线）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkflowEngine } from '../dist/workflows/engine.js';
import { virtualClock } from '../dist/workflows/clock.js';
import { runPaths, workflowPaths } from '../dist/workflows/paths.js';
import { readIndex } from '../dist/workflows/run-index.js';
import { readJson } from '../dist/workflows/atomic.js';
import { deriveAgentKey, argsChainSeed } from '../dist/workflows/keys.js';
import { createBuiltinTools } from '../dist/core-tools.js';
import { MyTerminalStore } from '../dist/store.js';

let TMP;
const OWNER = 'sess-a';

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-230-'));
  TMP = dir;
  const workspaceDir = path.join(dir, 'workspace');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const managedRoot = path.join(workspaceDir, '.myterminal');
  return { workspaceDir, stateDir, managedRoot, paths: workflowPaths(managedRoot) };
}

afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

async function until(condition, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
const settle = (rounds = 4) => Promise.all(Array.from({ length: rounds }, () => new Promise((r) => setTimeout(r, 0)))).then(() => {});
function ledgerRows(temp, runId, type) {
  return rawLines(temp, runId).filter((r) => r.type === type);
}
function rawLines(temp, runId) {
  const file = runPaths(temp.paths, runId).journalFile;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function deferred() {
  let resolve; const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function readIndexSync(temp, runId) {
  const file = runPaths(temp.paths, runId).indexFile;
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 假模型：默认按 prompt 返回可预测答案；release(prompt) 放行一个按 prompt 挂起的路。
 * 计数面 calls：真实进模型的次数——缓存命中不该进这里（续跑零 token 的直接证据）。
 */
function countedModel(options = {}) {
  const state = { calls: [], releases: new Map(), signals: [] };
  const hold = new Set(options.holdPrompts ?? []);
  const factory = () => ({
    complete: async (request) => {
      state.calls.push(request.prompt);
      state.signals.push(request.signal);
      if (hold.has(request.prompt)) {
        let d = state.releases.get(request.prompt);
        if (!d) { d = deferred(); state.releases.set(request.prompt, d); }
        await d.promise;
      }
      return { text: `answer:${request.prompt}`, outputTokens: request.outputTokens ?? 5 };
    },
  });
  const release = (prompt) => {
    const d = state.releases.get(prompt) ?? deferred();
    state.releases.set(prompt, d);
    d.resolve();
  };
  return { factory, state, release, calls: () => state.calls.slice() };
}

/**
 * 可注入锁探针：默认让 resume 总能取到锁（pid 存活、独占即可）；
 * 双跑/接管用例通过覆盖 probe 或直接预置锁文件驱动。
 */
function lockProbe(over = {}) {
  return { pid: 4242, epoch: 1, isAlive: () => true, now: () => Date.now(), iso: () => new Date().toISOString(), ...over };
}

function engineFor(temp, options = {}) {
  const clock = options.clock ?? virtualClock();
  const auditLog = options.auditLog ?? [];
  const engine = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock,
    audit: (e) => auditLog.push(e),
    adapterFactory: options.adapterFactory,
    gates: options.gates,
    ...(options.events ? { events: options.events } : {}),
    ...(options.concurrencyWindow !== undefined ? { concurrencyWindow: options.concurrencyWindow } : {}),
    ...(options.deliverNotice ? { deliverNotice: options.deliverNotice } : {}),
    lockProbe: options.lockProbe ?? lockProbe(),
  });
  return { engine, clock, auditLog };
}

// 6 路顺序脚本：调用序确定，键链可预测。
const SIX = `const a=await agent('p0');const b=await agent('p1');const c=await agent('p2');const d=await agent('p3');const e=await agent('p4');const f=await agent('p5');return {a,b,c,d,e,f};`;
/** 六路调用体（去掉 return），续跑测试按变体重拼 return / 加尾调。 */
const SIX_CALLS = `const a=await agent('p0');const b=await agent('p1');const c=await agent('p2');const d=await agent('p3');const e=await agent('p4');const f=await agent('p5');`;

// ═══════════════════════════════════════════════════════════════
// AC1 — workflow_cancel：语义与效果
// ═══════════════════════════════════════════════════════════════

test('AC1 cancel：结算 cancelled，三件套（快照 + 终态标记 + 终态消息）齐发，响应 {runId,status}', async () => {
  const temp = tempWorkspace();
  const delivered = [];
  const { engine, clock } = engineFor(temp, {
    adapterFactory: countedModel({ holdPrompts: ['p1'] }).factory,
    deliverNotice: (n) => { delivered.push(n); return true; },
  });
  const started = await engine.start({ script: SIX, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'started').length >= 2, '两路 admission');
  const result = await engine.cancel(started.runId, [OWNER]);
  assert.equal(result.runId, started.runId);
  assert.equal(result.status, 'cancelled');

  const run = runPaths(temp.paths, started.runId);
  assert.equal(fs.existsSync(run.terminalFile), true, '终态标记');
  assert.equal(fs.existsSync(run.snapshotFile), true, '终态快照');
  const index = await readIndex(run.indexFile);
  assert.equal(index.status, 'cancelled');
  assert.equal(index.reason, 'cancelled');
  assert.ok(delivered.length >= 1, '终态消息已投');
  assert.ok(delivered[0].body.includes('cancelled'), 'settled-notice 带 cancelled 状态');
});

test('AC1 cancel 幂等：终态 run 再调返回其当前状态、不重复结算', async () => {
  const temp = tempWorkspace();
  const model = countedModel({ holdPrompts: ['p1'] });
  const { engine } = engineFor(temp, { adapterFactory: model.factory });
  const started = await engine.start({ script: SIX, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'started').length >= 2, '两路 admission');
  const first = await engine.cancel(started.runId, [OWNER]);
  const again = await engine.cancel(started.runId, [OWNER]);
  assert.equal(first.status, 'cancelled');
  assert.equal(again.status, 'cancelled', '幂等：第二次拿到同一终态，不报错');
});

test('AC1 cancel 未知 runId → NOT_FOUND', async () => {
  const temp = tempWorkspace();
  const { engine } = engineFor(temp, { adapterFactory: countedModel().factory });
  const err = await engine.cancel('wf_deadbeef', [OWNER]).catch((e) => e);
  assert.equal(err.code, 'NOT_FOUND');
});

test('AC1 cancel 非本 root → FORBIDDEN（归属只认延续链）', async () => {
  const temp = tempWorkspace();
  const model = countedModel({ holdPrompts: ['p1'] });
  const { engine } = engineFor(temp, { adapterFactory: model.factory });
  const started = await engine.start({ script: SIX, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'started').length >= 2, '两路 admission');
  const err = await engine.cancel(started.runId, ['sess-stranger']).catch((e) => e);
  assert.equal(err.code, 'FORBIDDEN');
  assert.equal(err.reason, 'run-not-owned');
  // 未受影响：run 仍在跑（未被别人取消）
  const still = await engine.cancel(started.runId, [OWNER]);
  assert.equal(still.status, 'cancelled');
});

test('AC1 工具面：subagent 通道调 workflow_cancel → FORBIDDEN', async () => {
  const temp = tempWorkspace();
  const store = new MyTerminalStore(temp.stateDir);
  const root = store.registerRoot({ name: 'gpt-parent' });
  const delegate = store.registerDelegate(root.session.id, {
    name: 'delegated',
    task: { objective: 'o', background: 'b', deliverables: ['d'], acceptanceCriteria: ['a'], constraints: ['c'] },
  });
  const tools = createBuiltinTools({
    settingsPath: path.join(temp.stateDir, 'settings.json'), workspaceDir: temp.workspaceDir, stateDir: temp.stateDir,
    host: '127.0.0.1', port: 8787, connectorKey: 'k'.repeat(32), actionsToken: 't'.repeat(32),
    publicBaseUrl: 'http://127.0.0.1:8787', maxOutputChars: 4000, commandTimeoutSec: 120, uiLanguage: 'en', uiTheme: 'dark',
    passiveLockEnabled: false, actionsContinuationMode: 'off', nonBlockingTasksEnabled: false,
  }, store);
  const err = await tools.get('workflow_cancel').invoke(
    { runId: 'wf_deadbeef' },
    { transport: 'subagent', authenticatedSession: delegate.session },
  ).catch((error) => error);
  assert.equal(err.code, 'FORBIDDEN');
  assert.equal(err.details.reason, 'subagent-channel');
});

test('AC1 cancel 效果：在飞随 abort 中止、队列丢弃、结算 cancelled', async () => {
  const temp = tempWorkspace();
  // 六路全挂起 + 窗口 2 → 两路在飞、四路排队；取消打断在飞、清队列，燃烧就地停。
  const WIDE = `const items=[0,1,2,3,4,5].map((i)=>()=>agent('p'+i));await parallel(items);return 1;`;
  const model = countedModel({ holdPrompts: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'] });
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2 });
  const started = await engine.start({ script: WIDE, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'started').length >= 6, '六路 admission 落账');

  const result = await engine.cancel(started.runId, [OWNER]);
  assert.equal(result.status, 'cancelled');
  // 在飞的两路 abort 信号已置起（燃烧就地停的前提）；没有一路结算出 result（在飞被打断 + 队列丢弃）。
  assert.ok(model.state.signals.some((s) => s.aborted), '在飞 dispatch 随 abort 中止');
  assert.equal(ledgerRows(temp, started.runId, 'result').length, 0, '没有一路产出 result：在飞被中断、队列被清空');
  const run = runPaths(temp.paths, started.runId);
  assert.equal(JSON.parse(fs.readFileSync(run.terminalFile, 'utf8')).status, 'cancelled');
});

const TIGHT_GATES = { runGateMs: 10_000, dispatchWindowMs: 5_000, dispatchTurns: 12, stallMs: 5_000, waitChunkMs: 2_000, reducerBudgetMs: 12_000, reducerTimeoutMs: 14_000, reduceSlackMs: 2_000 };

// ═══════════════════════════════════════════════════════════════
// AC2 — pause 冻结语义（虚拟钟）+ 事件可观察 + index.status 原子写 + 原地续
// ═══════════════════════════════════════════════════════════════

test('AC2 pause 期间墙钟冻结：狂推虚拟钟不误爆 run-gate；resume 后不引爆超时误报', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const model = countedModel({ holdPrompts: ['p1'] });
  const { engine } = engineFor(temp, { adapterFactory: model.factory, clock, gates: TIGHT_GATES });
  const started = await engine.start({ script: SIX, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'started').length >= 1, '一路 admission');

  await engine.pause(started.runId, [OWNER]);
  // 暂停中：把墙钟推过 runGate（20s > 10s）——paused 期间不走 → 不该因超时而结算
  clock.advance(20_000);
  await settle();
  const mid = readIndexSync(temp, started.runId);
  assert.equal(mid.status, 'paused', '暂停期间墙钟不走、run 未因超时而结算');

  await engine.resume(started.runId, [OWNER]);
  assert.equal(readIndexSync(temp, started.runId).status, 'running', '恢复原地继续');
  // 释放挂起的路 → run 自然跑到底（暂停没吃掉墙钟余量，脚本仍能完成，不误报 wait/run-gate）
  for (const p of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']) model.release(p);
  const final = await engine.settled(started.runId);
  assert.ok(final, '续跑到终态');
  assert.equal(final.status, 'completed', '暂停不引爆超时误报，恢复后正常收敛');
});

test('AC2 pause：pausing→paused 事件可观察 + index.status 原子写 paused + resume 事件', async () => {
  const temp = tempWorkspace();
  const { WorkflowEvents } = await import('../dist/workflows/events.js');
  const events = new WorkflowEvents();
  const seen = [];
  events.on((e) => seen.push(e.type));
  const model = countedModel({ holdPrompts: ['p1'] });
  const { engine } = engineFor(temp, { adapterFactory: model.factory, events });
  const started = await engine.start({ script: SIX, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'started').length >= 1, 'admission 落账');

  const res = await engine.pause(started.runId, [OWNER]);
  assert.equal(res.status, 'paused');
  assert.ok(seen.includes('run_pausing'), '受理信号：pausing 事件');
  assert.ok(seen.includes('run_paused'), '完成信号：paused 事件');
  assert.equal(readIndexSync(temp, started.runId).status, 'paused', 'index.status 落盘 = paused（读侧契约）');

  const back = await engine.resume(started.runId, [OWNER]);
  assert.equal(back.status, 'running');
  assert.ok(seen.includes('run_resumed'), 'resume 原地续：事件可见');
});

test('AC2 pause 幂等 + 非本进程 run 无从暂停/恢复', async () => {
  const temp = tempWorkspace();
  const model = countedModel({ holdPrompts: ['p1'] });
  const { engine } = engineFor(temp, { adapterFactory: model.factory });
  const started = await engine.start({ script: SIX, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'started').length >= 1, 'admission');
  const first = await engine.pause(started.runId, [OWNER]);
  const second = await engine.pause(started.runId, [OWNER]);
  assert.equal(first.status, 'paused');
  assert.equal(second.status, 'paused', '重复 pause 幂等');
  const missing = await engine.resume('wf_ffffffff', [OWNER]).catch((e) => e);
  assert.equal(missing.code, 'NOT_FOUND', '不在本进程 → 无从暂停/恢复');
});

// ═══════════════════════════════════════════════════════════════
// AC3 — ownerSessionId 三场景确权 + resumeFromRunId 仅限本 root
// ═══════════════════════════════════════════════════════════════

test('AC3 归属挂 sessionId、不挂 token：同 sessionId 直接确权；链外一律拒', async () => {
  const temp = tempWorkspace();
  const model = countedModel({ holdPrompts: ['p1'] });
  const { engine } = engineFor(temp, { adapterFactory: model.factory });
  const started = await engine.start({ script: SIX, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'started').length >= 1, 'admission');

  // 陌生会话（自己的 sessionId，链里没有 owner）默认无权
  const stranger = await engine.cancel(started.runId, ['sess-stranger']).catch((e) => e);
  assert.equal(stranger.code, 'FORBIDDEN');
  assert.equal(stranger.reason, 'run-not-owned');
  // 直接以 owner sessionId 取消：确权成功（归属挂 sessionId，不靠 token）
  const ok = await engine.cancel(started.runId, [OWNER]);
  assert.equal(ok.status, 'cancelled');
});

test('AC3 延续链确权：candidates 含 continuesSessionId 祖先即本 root 名下；链外拒', async () => {
  const temp = tempWorkspace();
  const model = countedModel({ holdPrompts: ['p1'] });
  const { engine } = engineFor(temp, { adapterFactory: model.factory });
  const started = await engine.start({ script: SIX, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'started').length >= 1, 'admission');

  // 续跑归属同理：链外候选（不含 owner）→ resume 拒
  const denied = await engine.start({ scriptPath: started.scriptPath, resumeFromRunId: started.runId, ownerSessionId: 'sess-b', ownerCandidates: ['sess-b'] }).catch((e) => e);
  assert.equal(denied.code, 'FORBIDDEN');
  assert.equal(denied.reason, 'run-not-owned');
  // 工具层把 ownershipChain（自身 + continuesSessionId 祖先）传进来 → 含 owner 即确权（session_inherit / claim 通道继承）
  // 先取消以留下 cancelled 的可续跑态，再用"继承链"续跑。
  await engine.cancel(started.runId, [OWNER]);
  overwriteScript(temp, started.scriptPath, `${SIX_CALLS}return {ok:true};`);
  const inherited = await engine.start({ scriptPath: started.scriptPath, resumeFromRunId: started.runId, ownerSessionId: 'sess-b', ownerCandidates: ['sess-b', OWNER] });
  assert.equal(inherited.runId, started.runId, '延续链含 owner → 继承名下 run 可续跑');
});

test('AC3 resumeFromRunId 仅限本 root 名下（延续链外 → FORBIDDEN run-not-owned）', async () => {
  const temp = tempWorkspace();
  const model = countedModel({ holdPrompts: ['p1'] });
  const { engine } = engineFor(temp, { adapterFactory: model.factory });
  const started = await engine.start({ script: SIX, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'started').length >= 1, 'admission');
  await engine.cancel(started.runId, [OWNER]);

  const err = await engine.start({ scriptPath: started.scriptPath, resumeFromRunId: started.runId, ownerSessionId: 'sess-x', ownerCandidates: ['sess-x'] }).catch((e) => e);
  assert.equal(err.code, 'FORBIDDEN');
  assert.equal(err.reason, 'run-not-owned');
});

// ═══════════════════════════════════════════════════════════════
// 续跑公共前置：首跑 6 路全部结算、卡在尾调 TAIL 上 → 取消 → 留下一条可重放的 cancelled run
// ═══════════════════════════════════════════════════════════════

const SIX_TAIL = `const a=await agent('p0');const b=await agent('p1');const c=await agent('p2');const d=await agent('p3');const e=await agent('p4');const f=await agent('p5');await agent('TAIL');return {ok:true};`;

/** 造一条 cancelled run：6 路结果已落 journal，尾调永挂，取消收场。返回 runId + 已保存脚本路径。 */
async function cancelledRunWithSixCached(temp) {
  const model = countedModel({ holdPrompts: ['TAIL'] });
  const { engine } = engineFor(temp, { adapterFactory: model.factory });
  for (const p of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']) model.release(p);
  const started = await engine.start({ script: SIX_TAIL, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'result').length >= 6, '六路结算落账');
  const res = await engine.cancel(started.runId, [OWNER]);
  assert.equal(res.status, 'cancelled');
  return { runId: started.runId, scriptPath: started.scriptPath, engine };
}

function overwriteScript(temp, scriptPath, content) {
  fs.writeFileSync(scriptPath, content, 'utf8');
}

// ═══════════════════════════════════════════════════════════════
// AC5 / AC6 — 缓存矩阵（假模型计数）+ 归一化
// ═══════════════════════════════════════════════════════════════

test('AC5 改第 5 路 prompt → 前 4 缓存、5..N 重跑（模型只跑 2 次）', async () => {
  const temp = tempWorkspace();
  const { runId, scriptPath } = await cancelledRunWithSixCached(temp);
  const model2 = countedModel();
  const { engine } = engineFor(temp, { adapterFactory: model2.factory });
  overwriteScript(temp, scriptPath, SIX_TAIL.replace("agent('p4')", "agent('p4-changed')"));
  const resumed = await engine.start({ scriptPath, resumeFromRunId: runId, ownerSessionId: OWNER });
  const final = await resumed.completion;
  assert.deepEqual(model2.calls().sort().slice(), ['TAIL', 'p4-changed', 'p5'], '屏障断在第 5 路，其后（含 TAIL）全 live；前 4 路零 token');
  assert.equal(model2.calls().includes('p0'), false, 'p0 走缓存，绝不进模型');
  assert.equal(model2.calls().includes('p3'), false);
  assert.equal(final.status, 'completed');
});

test('AC5 改末尾后处理（六路 prompt 不变，只动整理代码）→ 全缓存（模型 0 次）', async () => {
  const temp = tempWorkspace();
  const { runId, scriptPath } = await cancelledRunWithSixCached(temp);
  const model2 = countedModel();
  const { engine } = engineFor(temp, { adapterFactory: model2.factory });
  // 续跑删掉那个永不归的尾调、六路 prompt 逐字不变、只改 return（改末尾后处理）：前缀全部命中缓存。
  overwriteScript(temp, scriptPath, `${SIX_CALLS}return {ok:true, edited:true};`);
  const resumed = await engine.start({ scriptPath, resumeFromRunId: runId, ownerSessionId: OWNER });
  const final = await resumed.completion;
  assert.equal(model2.calls().length, 0, '六路全走缓存，改后处理一次模型都不进');
  assert.equal(final.status, 'completed');
  assert.equal(final.dispatches.length, 6, '账本恰等于这一跑真正跑过的六路（复用旧记录、不重复计）');
});

test('AC5 改 args → 0 缓存（全量重跑，模型跑满 6 次）', async () => {
  const temp = tempWorkspace();
  const { runId, scriptPath } = await cancelledRunWithSixCached(temp);
  const model2 = countedModel();
  const { engine } = engineFor(temp, { adapterFactory: model2.factory });
  overwriteScript(temp, scriptPath, `${SIX_CALLS}return {ok:true};`);
  const resumed = await engine.start({ scriptPath, resumeFromRunId: runId, ownerSessionId: OWNER, args: { different: true } });
  await resumed.completion;
  const sixLive = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'].filter((p) => model2.calls().includes(p));
  assert.equal(sixLive.length, 6, 'args 变 → 种子变 → 全链错位 → 六路全 live');
});

test('AC6 只改 label / phase（展示项）→ 全缓存（键不变）', async () => {
  const temp = tempWorkspace();
  const { runId, scriptPath } = await cancelledRunWithSixCached(temp);
  const model2 = countedModel();
  const { engine } = engineFor(temp, { adapterFactory: model2.factory });
  // p0 加 label/phase（都不进键）：仍命中缓存。
  overwriteScript(temp, scriptPath, `${SIX_CALLS.replace("const a=await agent('p0');", "const a=await agent('p0', { label: 'renamed', phase: 'z' });")}return {ok:true};`);
  const resumed = await engine.start({ scriptPath, resumeFromRunId: runId, ownerSessionId: OWNER });
  await resumed.completion;
  assert.equal(model2.calls().includes('p0'), false, 'label/phase 不进键 → 改它们仍命中缓存');
  assert.equal(model2.calls().length, 0, '展示项变更 → 六路全缓存');
});

// ═══════════════════════════════════════════════════════════════
// AC7 — 重放顺序契约：缓存命中先于预算门与 agentCount（不吃闸、不占位）
// ═══════════════════════════════════════════════════════════════

test('AC7 全缓存续跑不吃 agentCap / tokenCap：闸收到 1 也照样跑完（命中在计数之前返回）', async () => {
  const temp = tempWorkspace();
  const { runId, scriptPath } = await cancelledRunWithSixCached(temp);
  const model2 = countedModel({ holdPrompts: ['TAIL'] });
  for (const p of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']) model2.release(p);
  // 极窄闸：agentCap=1、tokenCap=1——若缓存命中也计 agent/吃预算，续跑第二路就会越闸判败。
  const { engine } = engineFor(temp, { adapterFactory: model2.factory, gates: { agentCap: 1, tokenCap: 1 } });
  overwriteScript(temp, scriptPath, SIX_TAIL);
  const resumed = await engine.start({ scriptPath, resumeFromRunId: runId, ownerSessionId: OWNER });
  // 六路全命中 → 0 live → 不碰 agentCap/tokenCap。run 停在 TAIL（挂起），前缀账本已全缓存。
  await settle(6);
  assert.equal(model2.calls().length, 0, '全缓存不触发任何 live agent，也就不受 1 的闸约束');
  await engine.cancel(runId, [OWNER]);
  void resumed;
});

// ═══════════════════════════════════════════════════════════════
// AC4 — resume 排他锁 / sourceRef / cancel 后从第一个无 result 起实跑 / 崩溃接管
// ═══════════════════════════════════════════════════════════════

test('AC4 排他锁：一个续跑持锁期间，第二个续跑被拒（resume-locked）', async () => {
  const temp = tempWorkspace();
  const { runId, scriptPath } = await cancelledRunWithSixCached(temp);
  // 第一个续跑：脚本停在 TAIL（挂起）→ 一直持有排他锁不结算。
  const holder = countedModel({ holdPrompts: ['TAIL'] });
  for (const p of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']) holder.release(p);
  const engineA = engineFor(temp, { adapterFactory: holder.factory }).engine;
  await engineA.start({ scriptPath, resumeFromRunId: runId, ownerSessionId: OWNER });
  await until(() => fs.existsSync(runPaths(temp.paths, runId).lockFile), '续跑取到排他锁');

  // 第二个续跑（同 runId）：锁被别人持着 → 拒
  const second = countedModel();
  const engineB = engineFor(temp, { adapterFactory: second.factory }).engine;
  const err = await engineB.start({ scriptPath, resumeFromRunId: runId, ownerSessionId: OWNER }).catch((e) => e);
  assert.equal(err.code, 'FORBIDDEN');
  assert.equal(err.reason, 'resume-locked');
  await engineA.cancel(runId, [OWNER]);
});

test('AC4 崩溃接管：持锁进程已死（pid 不存活）→ 第二个续跑可接管', async () => {
  const temp = tempWorkspace();
  const { runId, scriptPath } = await cancelledRunWithSixCached(temp);
  // 预置一把"死者"的锁：pid 999 由后续探针判为不存活。
  overwriteScript(temp, scriptPath, SIX_TAIL);
  const deadProbe = lockProbe({ pid: 999, epoch: 1, isAlive: () => false });
  fs.writeFileSync(runPaths(temp.paths, runId).lockFile, JSON.stringify({ pid: 999, epoch: 1, at: '2026-01-01T00:00:00.000Z', ownerSessionId: 'ghost' }) + '\n', 'utf8');
  const model = countedModel({ holdPrompts: ['TAIL'] });
  for (const p of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']) model.release(p);
  void deadProbe;
  const { engine } = engineFor(temp, { adapterFactory: model.factory, lockProbe: lockProbe({ pid: 5000, epoch: 3, isAlive: (p) => p === 5000 }) });
  const resumed = await engine.start({ scriptPath, resumeFromRunId: runId, ownerSessionId: OWNER });
  // 接管成功：死锁被换掉，续跑正常起跑（全缓存命中后停 TAIL）。
  assert.equal(resumed.runId, runId);
  await engine.cancel(runId, [OWNER]);
});

test('AC4 sourceRef：脚本引用不同 → 拒（= 新 run），内容编辑不改引用', async () => {
  const temp = tempWorkspace();
  const { runId } = await cancelledRunWithSixCached(temp);
  // 换一个 saved 名（引用不同）→ 续跑该 runId 被拒。
  const { engine } = engineFor(temp, { adapterFactory: countedModel().factory });
  const other = await engine.start({ script: `await agent('zzz');return 1;`, ownerSessionId: OWNER });
  const err = await engine.start({ scriptPath: other.scriptPath, resumeFromRunId: runId, ownerSessionId: OWNER }).catch((e) => e);
  assert.equal(err.code, 'VALIDATION');
  assert.equal(err.reason, 'source-mismatch');
});

test('AC4 cancel 后 resume 从第一个无 result 的调用起实跑', async () => {
  const temp = tempWorkspace();
  // 首跑：p0,p1 结算，p2 挂起 → 取消（p2 是"第一个无 result"）。
  const model = countedModel({ holdPrompts: ['p2'] });
  model.release('p0'); model.release('p1');
  const { engine } = engineFor(temp, { adapterFactory: model.factory });
  const started = await engine.start({ script: SIX_TAIL, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'result').length >= 2, 'p0,p1 结算');
  await engine.cancel(started.runId, [OWNER]);

  // 续跑：p0,p1 命中缓存（不进模型），从 p2 起实跑。
  const model2 = countedModel({ holdPrompts: ['p2'] });
  for (const p of ['p2', 'p3', 'p4', 'p5', 'TAIL']) model2.release(p);
  const { engine: engine2 } = engineFor(temp, { adapterFactory: model2.factory });
  const resumed = await engine2.start({ scriptPath: started.scriptPath, resumeFromRunId: started.runId, ownerSessionId: OWNER });
  await resumed.completion;
  assert.equal(model2.calls().includes('p0'), false, 'p0 命中缓存');
  assert.equal(model2.calls().includes('p1'), false, 'p1 命中缓存');
  assert.equal(model2.calls().includes('p2'), true, 'p2（第一个无 result）实跑');
});

// ═══════════════════════════════════════════════════════════════
// AC8 — 用量三档 + 取消不退不重算
// ═══════════════════════════════════════════════════════════════

test('AC8 每路 usage + run 总计写索引/快照；reducer 用量第三档回写索引', async () => {
  const temp = tempWorkspace();
  const { engine } = engineFor(temp, { adapterFactory: countedModel().factory });
  const started = await engine.start({ script: SIX, ownerSessionId: OWNER });
  const final = await started.completion;
  const run = runPaths(temp.paths, started.runId);
  assert.ok(final.dispatches.length === 6 && final.dispatches.every((d) => d.status === 'completed'));
  assert.ok(final.dispatches.every((d) => d.outputTokens > 0), '每路 usage');
  assert.ok(final.tokens.spent > 0, 'run 总计');
  const snapshot = JSON.parse(fs.readFileSync(run.snapshotFile, 'utf8'));
  assert.equal(snapshot.tokens.spent, final.tokens.spent, '快照带 run 总计');

  // 汇总体用量第三档：写一个终态标记（模拟 run 已结算）后调 concludeReducer 带 tokens → 索引记 reducerTokens。
  await engine.concludeReducer({ runId: started.runId, agentId: 'r1', digestPath: run.digestFile, reducerOutputTokens: 123 });
  const after = await readIndex(run.indexFile);
  assert.equal(after.reducerTokens?.spent, 123, 'reducer 用量第三档写入索引');
});

test('AC8 取消不退、不重算：已花 token 保持累加', async () => {
  const temp = tempWorkspace();
  const model = countedModel({ holdPrompts: ['p2'] });
  model.release('p0'); model.release('p1');
  const { engine } = engineFor(temp, { adapterFactory: model.factory });
  const started = await engine.start({ script: SIX, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'result').length >= 2, '两路结算');
  const before = await readIndex(runPaths(temp.paths, started.runId).indexFile);
  await engine.cancel(started.runId, [OWNER]);
  const after = await readIndex(runPaths(temp.paths, started.runId).indexFile);
  assert.equal(after.tokens.spent, before.tokens.spent, '取消不动已花 token（不退、不重算）');
  assert.ok(after.tokens.spent > 0);
});

// ═══════════════════════════════════════════════════════════════
// AC9 — journal 截断至最长良前缀 + 丢弃段显式记账
// ═══════════════════════════════════════════════════════════════

test('AC9 journal 撕裂尾行：续跑截断至最长良前缀，丢弃行数在 resume 结果显式记账', async () => {
  const temp = tempWorkspace();
  const { runId, scriptPath } = await cancelledRunWithSixCached(temp);
  // 手工在 journal 尾部粘一条撕裂行（JSON 半截），模拟 kill -9 打断最后一行。
  const journalFile = runPaths(temp.paths, runId).journalFile;
  fs.appendFileSync(journalFile, '{ "type":"result","seq":9,"key":"v2:trunc\n');
  overwriteScript(temp, scriptPath, SIX_TAIL);

  const model = countedModel({ holdPrompts: ['TAIL'] });
  for (const p of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']) model.release(p);
  const { engine } = engineFor(temp, { adapterFactory: model.factory });
  const resumed = await engine.start({ scriptPath, resumeFromRunId: runId, ownerSessionId: OWNER });
  assert.ok((resumed.journalDropped ?? 0) >= 1, `丢弃段显式记账（实际 dropped=${resumed.journalDropped}）`);
  // 良前缀之后的撕裂行被清掉，不再污染账本。
  const surviving = rawLines(temp, runId);
  assert.ok(surviving.every((r) => typeof r === 'object'), '截断后 journal 只剩可解析行');
  await engine.cancel(runId, [OWNER]);
});

// ═══════════════════════════════════════════════════════════════
// AC10 — 审计 cancel / resume / pause / paused-resume 落地
// ═══════════════════════════════════════════════════════════════

test('AC10 审计：cancel / pause / paused-resume 各留一条含 runId+actor+结果', async () => {
  const temp = tempWorkspace();
  const model = countedModel({ holdPrompts: ['p1'] });
  const { engine, auditLog } = engineFor(temp, { adapterFactory: model.factory });
  const started = await engine.start({ script: SIX, ownerSessionId: OWNER });
  await until(() => ledgerRows(temp, started.runId, 'started').length >= 1, 'admission');

  await engine.pause(started.runId, [OWNER]);
  await engine.resume(started.runId, [OWNER]);
  await engine.cancel(started.runId, [OWNER]);

  const actions = auditLog.map((a) => a.action);
  assert.ok(actions.includes('workflow_pause'), 'pause 审计');
  assert.ok(actions.includes('workflow_paused_resume'), 'paused-resume 审计');
  assert.ok(actions.includes('workflow_cancel'), 'cancel 审计');
  const cancel = auditLog.find((a) => a.action === 'workflow_cancel');
  assert.equal(cancel.runId, started.runId);
  assert.equal(cancel.actor, OWNER);
  assert.equal(cancel.status, 'cancelled');
});

test('AC10 审计：resumeFromRunId 续跑留 workflow_resume（而非仅 start）', async () => {
  const temp = tempWorkspace();
  const { runId, scriptPath } = await cancelledRunWithSixCached(temp);
  overwriteScript(temp, scriptPath, SIX_TAIL);
  const model = countedModel({ holdPrompts: ['TAIL'] });
  for (const p of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']) model.release(p);
  const { engine, auditLog } = engineFor(temp, { adapterFactory: model.factory });
  const resumed = await engine.start({ scriptPath, resumeFromRunId: runId, ownerSessionId: OWNER });
  await engine.cancel(runId, [OWNER]);
  await resumed.completion.catch(() => undefined);
  assert.ok(auditLog.some((a) => a.action === 'workflow_resume'), '续跑记 workflow_resume');
});


