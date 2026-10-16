// Workflows T3（#226）：自限闸门与设置节——票面验收
//
// 验收覆盖（对应 #226 Acceptance criteria）：
//   AC1 四闸齐备且默认即上限；越硬顶压回；"不限制"= 设置显式开关（默认关、模型面不可触）；
//       不设全局并发顶——多 run 各自在闸内持窗口
//   AC2 softGate 两级检查（入口拒 + 取槽拒）各有用例；超限整 run 判败并记账
//   AC3 workflows 设置节：config / env 两个调参入口 + 既有 TUI Settings 屏注册可编辑字段；
//       设置节不含端点字段（断言）；口径覆盖闸门 / 并发窗口 / worktree 配额 / 保留数 / 汇总体配额
//   AC4 时钟嵌套不变量启动校验：违例 fail-closed 拒启动（FORBIDDEN、零副作用）；
//       两种顺序都收敛（内层先响 → 记账、外层继续；外层先到 → 结算、内层随中止）
//   AC5 墙钟到期 → 结算 failed(reason=run-gate) + 三件套照发
//
// 测试方式：引擎构造器注入假模型 + 虚拟钟 + 整栈一致的时钟集（#226 之后，缩墙钟
// 必须整栈一起缩，单层调参会被嵌套校验拒启动）；设置面直调 dist/config 与
// dist/tui/controller-logic；全程不碰真端点、不真实等待。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkflowEngine, WorkflowStartError } from '../dist/workflows/engine.js';
import { DEFAULT_GATES, WORKFLOW_SETTING_KEYS, resolveWorkflowGates } from '../dist/workflows/gates.js';
import { virtualClock } from '../dist/workflows/clock.js';
import { initWorkflowEngine, resetWorkflowEngine } from '../dist/workflows/runtime.js';
import { runPaths, workflowPaths } from '../dist/workflows/paths.js';
import { readIndex } from '../dist/workflows/run-index.js';
import { createBuiltinTools } from '../dist/core-tools.js';
import { MyTerminalStore } from '../dist/store.js';

function toolConfig(workspaceDir, stateDir) {
  return {
    settingsPath: path.join(stateDir, 'settings.json'),
    workspaceDir,
    stateDir,
    host: '127.0.0.1',
    port: 8787,
    connectorKey: 'k'.repeat(32),
    actionsToken: 't'.repeat(32),
    publicBaseUrl: 'http://127.0.0.1:8787',
    maxOutputChars: 4000,
    commandTimeoutSec: 120,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };
}
import { validateSettings } from '../dist/config.js';
import { WORKFLOW_SETTING_FIELDS, buildSettingsQuestions, resolveSettingsAnswers } from '../dist/tui/controller-logic.js';
import { runtimeSettingsSnapshot } from '../dist/runtime-settings.js';

let TMP;

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-226-'));
  TMP = dir;
  const workspaceDir = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const managedRoot = path.join(workspaceDir, '.myterminal');
  return { workspaceDir, managedRoot, paths: workflowPaths(managedRoot) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * 虚拟钟下把整条钟栈一起缩到同一个量级：#226 的嵌套不变量要求内层 ≤ 外层 − 余量，
 * 只改墙钟就是"调参击穿嵌套"，会被启动校验拒掉。
 */
function clockStack(runGateMs) {
  const slack = Math.max(1, Math.floor(runGateMs / 10));
  return {
    runGateMs,
    dispatchWindowMs: Math.max(1, Math.floor(runGateMs * 0.3)),
    stallMs: Math.max(1, Math.floor(runGateMs * 0.1)),
    reducerBudgetMs: runGateMs * 2,
    reducerTimeoutMs: runGateMs * 3,
    reduceSlackMs: slack,
  };
}

/**
 * 假模型：每次调用都新建一个 adapter 实例（可计数），按剧本兑现或挂起，
 * 并记录看到的中止信号——"外层先到 → 内层随中止"就看这个。
 */
function fakeModel(script) {
  const state = { prompts: [], signals: [], calls: 0, inFlight: 0, maxInFlight: 0 };
  const factory = () => ({
    complete: async (request) => {
      state.calls += 1;
      state.prompts.push(request.prompt);
      state.signals.push(request.signal);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        return await script(request);
      } finally {
        state.inFlight -= 1;
      }
    },
  });
  return { factory, state };
}

function engineFor(temp, options = {}) {
  const notices = [];
  const clock = options.clock ?? virtualClock();
  // 墙钟一换整栈跟着换：#226 之后单层调参就是击穿嵌套，会被启动校验拒掉。
  const gates = { ...clockStack(options.runGateMs ?? 1000), ...(options.gates ?? {}) };
  const engine = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock,
    audit: () => { /* 审计契约属 T1 */ },
    adapterFactory: options.adapterFactory,
    ...(options.concurrencyWindow !== undefined ? { concurrencyWindow: options.concurrencyWindow } : {}),
    gates,
    deliverNotice: (notice) => { notices.push(notice); return true; },
  });
  return { engine, clock, notices };
}

afterEach(() => {
  resetWorkflowEngine();
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

// ═══════════════════════════════════════════════════════════════
// AC1 四闸默认即上限 / 硬顶 / 不限制开关 / 无全局并发顶
// ═══════════════════════════════════════════════════════════════

test('AC1 引擎生效的并发窗口与 agent 数越硬顶时被压回硬顶', () => {
  const temp = tempWorkspace();
  const over = engineFor(temp, { gates: { concurrencyWindow: 5000, agentCap: 999_999 }, adapterFactory: fakeModel(() => ({ text: 'ok', outputTokens: 1 })).factory });
  assert.equal(over.engine.windowLimit, 64, '并发窗口硬顶 64：来源是闸门注入也一样压');
  assert.equal(over.engine.agentLimit, 10_000, 'agentCap 硬顶 10,000');
  assert.ok(over.engine.windowLimit <= 64 && over.engine.agentLimit <= 10_000, '用例钉最终值 ≤ 硬顶');
});

test('AC1 脚本看到的预算面只有读数、没有旋钮；不限制开关开启后无顶', async () => {
  const temp = tempWorkspace();
  const capped = fakeModel(() => ({ text: 'ok', outputTokens: 10 }));
  const first = engineFor(temp, { adapterFactory: capped.factory, gates: { tokenCap: 8_000_000 } });
  await first.engine.start({ script: `await agent('total=' + String(budget.total) + ' remaining=' + String(budget.remaining())); return 1;`, ownerSessionId: 'sess-a' }).then((s) => s.completion);
  assert.equal(capped.state.prompts[0], 'total=8000000 remaining=8000000', '默认档即上限：tokenCap 8,000,000');

  const open = fakeModel(() => ({ text: 'ok', outputTokens: 50_000_000 }));
  const second = engineFor(temp, { adapterFactory: open.factory, gates: { tokenCap: null } });
  const started = await second.engine.start({ script: `await agent('total=' + String(budget.total) + ' remaining=' + String(budget.remaining())); await agent('again'); return 1;`, ownerSessionId: 'sess-a' });
  const index = await started.completion;
  // 无顶要读成"无顶"：把 remaining 报成 0 会让脚本自己收手，等于偷偷把闸又关上了。
  assert.equal(open.state.prompts[0], 'total=null remaining=Infinity', '开=无顶哨兵 null（不写 0、不写假大数）');
  assert.equal(index.status, 'completed', '五千万 output token 也不判败——顶被显式解掉了');
  assert.equal(index.tokens.spent, 100_000_000, '解顶不等于不记账');
});

test('AC1 模型面零闸门旋钮：登记的键名一个都出不了工具 schema 与 agent() 选项表', () => {
  const temp = tempWorkspace();
  const stateDir = path.join(temp.workspaceDir, '..', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const store = new MyTerminalStore(stateDir);
  const tools = createBuiltinTools(toolConfig(temp.workspaceDir, stateDir), store);
  const properties = Object.keys(tools.get('workflow_start').inputSchema.properties);
  for (const key of WORKFLOW_SETTING_KEYS) {
    for (const name of [key.name, key.env, key.field]) {
      assert.equal(properties.includes(name), false, `${name} 不得出现在 workflow_start 参数面`);
    }
  }
  assert.deepEqual(properties.sort(), ['args', 'resumeFromRunId', 'script', 'scriptPath'], '默认档即 GPT 的上限：它没有松闸的把手');

  // 脚本侧同样只有读数：budget 没有 setter，预算也不能当选项传进 agent()。
  const model = fakeModel(() => ({ text: 'ok', outputTokens: 1 }));
  const engine = engineFor(temp, { adapterFactory: model.factory }).engine;
  return engine.start({ script: `await agent('shape=' + Object.keys(budget).sort().join(',') + ' setter=' + String(typeof budget.recordSpent)); return 1;`, ownerSessionId: 'sess-a' })
    .then((started) => started.completion)
    .then(() => {
      assert.equal(model.state.prompts[0], 'shape=remaining,spent,total setter=undefined', '脚本只见 total/spent/remaining，没有写入件');
    });
});

test('AC1 不设全局并发顶：两个 run 各自在自己的窗口里持位', async () => {
  const temp = tempWorkspace();
  const gatesA = deferred();
  const gatesB = deferred();
  const model = fakeModel((request) => (request.prompt === 'a' ? gatesA.promise : gatesB.promise));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2 });

  const runA = await engine.start({ script: `await parallel([() => agent('a'), () => agent('a2')]); return 1;`, ownerSessionId: 'sess-a' });
  const runB = await engine.start({ script: `await parallel([() => agent('b'), () => agent('b2')]); return 1;`, ownerSessionId: 'sess-a' });
  await settle();

  // 每条 run 各自持一个 2 路窗口、且没有全局顶：合计 4 路在飞；有全局顶就只会是 2。
  assert.equal(model.state.maxInFlight, 4, '多 run 各自在闸内持窗口，不设全局并发顶');
  gatesA.resolve({ text: 'ok', outputTokens: 1 });
  gatesB.resolve({ text: 'ok', outputTokens: 2 });
  const [indexA, indexB] = await Promise.all([runA.completion, runB.completion]);
  assert.equal(model.state.calls, 4, '两条 run 各烧两路，彼此不借槽');
  assert.equal(indexA.status, 'completed');
  assert.equal(indexB.status, 'completed');
});

// ═══════════════════════════════════════════════════════════════
// AC2 softGate 两级检查（入口 + 取槽）
// ═══════════════════════════════════════════════════════════════

test('AC2 第一级（入口拒）：超限时下一次 admission 直接拒，不给它建槽位', async () => {
  const temp = tempWorkspace();
  const model = fakeModel(() => ({ text: 'ok', outputTokens: 100 }));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: { tokenCap: 100 } });
  const started = await engine.start({ script: `await agent('one'); await agent('two'); return 1;`, ownerSessionId: 'sess-a' });
  const index = await started.completion;

  assert.equal(index.status, 'failed');
  assert.equal(index.reason, 'token-budget', '超限整 run 判败');
  assert.equal(index.tokens.spent, 100, '燃烧照记');
  assert.equal(index.dispatches.length, 1, '第二路在 admission 段就被拒，没占槽位');
  assert.equal(model.state.calls, 1, '被拒的一路从不烧 token');
});

test('AC2 第二级（取槽拒）：已过 admission 的路拿到槽位后再被软门拒，账上留 started 无 result', async () => {
  const temp = tempWorkspace();
  const model = fakeModel(() => ({ text: 'ok', outputTokens: 100 }));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 1, gates: { tokenCap: 100 } });
  const started = await engine.start({ script: `await parallel([() => agent('first'), () => agent('second')]); return 1;`, ownerSessionId: 'sess-a' });
  const index = await started.completion;

  assert.equal(index.status, 'failed');
  assert.equal(index.reason, 'token-budget');
  assert.equal(index.dispatches.length, 2, '两路都已 admission（键链计位），第二路才有槽位可取');
  assert.deepEqual(index.dispatches.map((d) => d.status), ['completed', 'running'], '取槽被拒的一路停在在飞形状：不伪造它的终态');
  assert.equal(model.state.calls, 1, '取槽级拒绝同样不烧 token');

  const journal = fs.readFileSync(runPaths(temp.paths, started.runId).journalFile, 'utf8').trim().split('\n');
  assert.equal(journal.filter((line) => line.includes('"type":"started"')).length, 2);
  assert.equal(journal.filter((line) => line.includes('"type":"result"')).length, 1);
});

// ═══════════════════════════════════════════════════════════════
// AC4 嵌套不变量启动校验（fail-closed）与两种收敛顺序
// ═══════════════════════════════════════════════════════════════

test('AC4 违例 fail-closed：只缩墙钟（单层调参击穿嵌套）→ 拒启动，零副作用', async () => {
  const temp = tempWorkspace();
  const model = fakeModel(() => ({ text: 'ok', outputTokens: 1 }));
  const broken = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    adapterFactory: model.factory,
    // 故意只给一项：默认逐路窗（10 分钟）立刻顶穿 1 秒墙钟。
    gates: { runGateMs: 1000 },
  });

  let error;
  try {
    await broken.start({ script: `await agent('x'); return 1;`, ownerSessionId: 'sess-a' });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof WorkflowStartError, '启动校验违例必须抛');
  assert.equal(error.code, 'FORBIDDEN', '错误码照 ADR §8：启动校验违例 = FORBIDDEN');
  assert.equal(error.reason, 'clock-nesting');
  assert.match(error.message, /dispatchWindow \(600000ms\) must stay at least 300000ms below runGate \(1000ms\)/);
  assert.equal(model.state.calls, 0, '拒在烧 token 前');
  assert.equal(fs.existsSync(temp.paths.runsRoot), false, '违例启动不留任何 run 目录与索引');

  // 对照：整栈一起缩就放行（同一份假模型，只差钟的配平）。
  const ok = engineFor(temp, { adapterFactory: model.factory, runGateMs: 1000 });
  const started = await ok.engine.start({ script: `await agent('x'); return 1;`, ownerSessionId: 'sess-a' });
  assert.equal((await started.completion).status, 'completed');
});

test('AC4 工具面同样拒：workflow_start 把嵌套违例归到 FORBIDDEN + reason', async () => {
  const temp = tempWorkspace();
  const stateDir = path.join(temp.workspaceDir, '..', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  initWorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    adapterFactory: fakeModel(() => ({ text: 'ok', outputTokens: 1 })).factory,
    gates: { runGateMs: 1000 },
  });
  const store = new MyTerminalStore(stateDir);
  const tools = createBuiltinTools(toolConfig(temp.workspaceDir, stateDir), store);
  const { session } = store.registerRoot({ name: 'root' });
  const failed = await tools.get('workflow_start')
    .invoke({ script: `await agent('x'); return 1;` }, { transport: 'actions', authenticatedSession: session })
    .catch((error) => error);
  assert.equal(failed.code, 'FORBIDDEN', '违例码照 ADR §8');
  assert.equal(failed.details.reason, 'clock-nesting');
});

test('AC4 两种顺序都收敛：内层先响 → 该路记账、run 继续到正常终态', async () => {
  const temp = tempWorkspace();
  const model = fakeModel(async (request) => {
    if (request.prompt === 'slow-fail') throw new Error('upstream refused');
    return { text: 'ok', outputTokens: 5 };
  });
  const { engine, clock } = engineFor(temp, { adapterFactory: model.factory });
  const started = await engine.start({ script: `await parallel([() => agent('slow-fail'), () => agent('fine')]); return 1;`, ownerSessionId: 'sess-a' });
  const index = await started.completion;

  assert.equal(index.status, 'completed', '一路自己到界不影响 run：部分失败仍带警告交付');
  assert.equal(index.dispatches.length, 2);
  assert.equal(index.failures.length, 1, '内层先响的那路逐条具名记账');
  assert.equal(index.reason, 'completed');
  clock.advance(1000);
  assert.equal((await readIndex(runPaths(temp.paths, started.runId).indexFile)).status, 'completed', '外层不再改判已终结的 run');
});

test('AC4 两种顺序都收敛：外层先到 → 结算，内层随中止信号止损', async () => {
  const temp = tempWorkspace();
  const gate = deferred();
  const model = fakeModel(() => gate.promise);
  const { engine, clock } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2 });
  const started = await engine.start({ script: `await parallel([() => agent('a'), () => agent('b')]); return 1;`, ownerSessionId: 'sess-a' });
  await settle();

  clock.advance(999);
  assert.equal((await readIndex(runPaths(temp.paths, started.runId).indexFile)).status, 'running', '墙钟差 1ms 还不算到期');
  clock.advance(1);

  const index = await started.completion;
  assert.equal(index.status, 'failed');
  assert.equal(index.reason, 'run-gate');
  assert.ok(model.state.signals.every((signal) => signal.aborted), '在飞的路随外层中止');
  gate.resolve({ text: 'too late', outputTokens: 9 });
  await settle(6);
  assert.equal((await readIndex(runPaths(temp.paths, started.runId).indexFile)).reason, 'run-gate', '此后任何证据不再改动终态');
});

// ═══════════════════════════════════════════════════════════════
// AC5 墙钟到期 → failed(run-gate) + 三件套照发
// ═══════════════════════════════════════════════════════════════

test('AC5 墙钟到期结算三件套齐发：快照 + 终态标记 + 终态通知指针', async () => {
  const temp = tempWorkspace();
  const hang = new Promise(() => { /* 永不兑现 */ });
  const model = fakeModel(() => hang);
  const { engine, clock, notices } = engineFor(temp, { adapterFactory: model.factory, runGateMs: 2000 });
  const started = await engine.start({ script: `await agent('never'); return 1;`, ownerSessionId: 'sess-a' });
  clock.advance(2000);
  const index = await started.completion;

  assert.equal(index.status, 'failed');
  assert.equal(index.reason, 'run-gate', '墙钟到期的具名终态原因');
  const run = runPaths(temp.paths, started.runId);
  const snapshot = JSON.parse(fs.readFileSync(run.snapshotFile, 'utf8'));
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.reason, 'run-gate');
  const marker = JSON.parse(fs.readFileSync(run.terminalFile, 'utf8'));
  assert.equal(marker.status, 'failed');
  assert.equal(marker.reason, 'run-gate');
  assert.equal(notices.length, 1, '终态三件套的第三件（≤200 码元 settled-notice）随结算发出');
  assert.equal(notices[0].runId, started.runId);
  assert.equal(notices[0].ownerSessionId, 'sess-a', '投递去向 = 发起会话');
  assert.ok(notices[0].body.startsWith(`[workflow] kind=settled-notice runId=${started.runId} sha256=`), '首行 KV 照 §15 口径');
  assert.ok(notices[0].body.includes('failed'), '通知体带终态');
  assert.equal(notices[0].sha256.length, 64, 'sha256 = 快照文件字节哈希');
  assert.ok(notices[0].body.length <= 200, '≤200 码元');
});

// ═══════════════════════════════════════════════════════════════
// AC3 设置面：调参入口 / TUI 可编字段 / 不含端点字段
// ═══════════════════════════════════════════════════════════════

test('AC3 既有 TUI Settings 屏把每个登记键都做成可编字段（question + apply 成对）', () => {
  assert.deepEqual(WORKFLOW_SETTING_FIELDS, WORKFLOW_SETTING_KEYS.map((key) => key.field));
  const current = settingsWith({});
  const built = buildSettingsQuestions(WORKFLOW_SETTING_FIELDS, { current, passiveFallback: 'off', text: (en) => en });
  assert.equal(built.ok, true);
  assert.equal(built.questions.length, WORKFLOW_SETTING_KEYS.length, '一个键都不能漏（漏了就查无此文）');

  const unlimited = built.questions.find((q) => q.label.startsWith('Workflow unlimited tokens'));
  assert.deepEqual(unlimited.options, ['off', 'on'], '不限制开关：默认关');
  assert.equal(unlimited.fallback, 'off');

  const tokenCap = built.questions.find((q) => q.label.startsWith('Workflow token cap'));
  assert.equal(tokenCap.fallback, '8000000', '回显的就是登记表里的默认（默认即上限）');
  assert.equal(tokenCap.validate('1'), undefined);
  assert.equal(tokenCap.validate('abc'), 'Use an integer of at least 1.');

  const agentCap = built.questions.find((q) => q.label.startsWith('Workflow agent cap'));
  assert.equal(agentCap.validate('10000'), undefined, '恰等硬顶放行');
  assert.match(agentCap.validate('10001'), /1 to 10000|at least/);
  const concurrency = built.questions.find((q) => q.label.startsWith('Workflow concurrency window'));
  assert.equal(concurrency.validate('65'), 'Use an integer from 2 to 64.', 'TUI 里说的上限就是闸门钉的那个');
  assert.equal(concurrency.validate('1'), 'Use an integer from 2 to 64.', '并发窗口下不到 1');
  // 核数公式那一项不在纯函数层问机器：留空 = 自动，写值 = 手动定死。
  assert.match(concurrency.label, /blank = follow core count/);
  assert.equal(concurrency.fallback, '', '未设置时回显空 = 走公式，而不是替用户猜一个核数');
  assert.equal(concurrency.validate(''), undefined, '空值放行（回到自动）');
  assert.match(tokenCap.validate(''), /at least 1/, '非自动项空值不放行');

  const cleared = resolveSettingsAnswers(['wf-concurrency-window', 'wf-token-cap'], ['', '9000'], current, { items: [] });
  assert.equal(Object.hasOwn(cleared.next.workflows, 'concurrencyWindow'), false, '清空 = 交还给核数公式');
  assert.equal(cleared.next.workflows.tokenCap, 9000);

  const applied = resolveSettingsAnswers(WORKFLOW_SETTING_FIELDS, answersFor({ tokenCap: '1500', unlimited: 'on', concurrencyWindow: '4', autoArchive: 'on' }), current, { items: [] });
  assert.equal(applied.next.workflows.tokenCap, 1500);
  assert.equal(applied.next.workflows.unlimited, true);
  assert.equal(applied.next.workflows.concurrencyWindow, 4);
  assert.equal(applied.next.workflows.autoArchive, true);
  assert.equal(applied.next.workflows.agentCap, 1000, '未作答的键保持默认，不被清空');
});

test('AC3 TUI 一次编辑不抹段：没答的 workflows 键与 subagent 段一起带过去', () => {
  // 运行时快照没有这两段（config 里根本不存），只从盘面取；漏一条就是"改端口顺手删端点"。
  const persisted = settingsWith({
    subagent: { enabled: true, model: 'claude', baseUrl: 'https://gw.example', apiKey: 'secret-key-value', maxTurns: 700, timeoutSec: 7200, maxParallel: 2 },
    workflows: { tokenCap: 5000, agentCap: 42, unlimited: true },
  });
  const snapshot = runtimeSettingsSnapshot({
    port: 3210,
    config: {
      schemaVersion: 1, workspaceDir: '/tmp/ws', stateDir: '', settingsPath: '', host: '127.0.0.1', port: 0,
      connectorKey: 'k'.repeat(32), actionsToken: 't'.repeat(32), publicBaseUrl: '', maxOutputChars: 120_000,
      commandTimeoutSec: 60, uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false,
      actionsContinuationMode: 'off', nonBlockingTasksEnabled: false,
    },
  }, persisted);
  assert.deepEqual(snapshot.workflows, { tokenCap: 5000, agentCap: 42, unlimited: true });
  assert.equal(snapshot.subagent.baseUrl, 'https://gw.example', '端点三元组同样不能掉');

  const applied = resolveSettingsAnswers(['wf-run-gate'], ['45'], snapshot, { items: [] });
  assert.equal(applied.next.workflows.runGateMinutes, 45, '答了的那项写回');
  assert.equal(applied.next.workflows.tokenCap, 5000, '没答的键保持原值，不被清空');
  assert.equal(applied.next.workflows.unlimited, true);
  assert.equal(applied.next.subagent.baseUrl, 'https://gw.example');
  assert.deepEqual(validateSettings(applied.next), []);
});

test('AC3 调参入口 = config / env：解析后的闸进引擎，非法与越顶都留痕', async () => {
  const temp = tempWorkspace();
  const fromSettings = resolveWorkflowGates({ agentCap: 20, runGateMinutes: 45 }, {}, 8);
  assert.equal(fromSettings.gates.agentCap, 20);
  assert.equal(fromSettings.gates.runGateMs, 45 * 60 * 1000);

  const fromEnv = resolveWorkflowGates({ agentCap: 20 }, { MYTERMINAL_WORKFLOW_AGENT_CAP: '50000' }, 8);
  assert.equal(fromEnv.gates.agentCap, 10_000, 'env 压过文件，但仍越不过硬顶');
  assert.equal(fromEnv.warnings.length, 1);

  const model = fakeModel(() => ({ text: 'ok', outputTokens: 1 }));
  const engine = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock: virtualClock(),
    adapterFactory: model.factory,
    gates: { ...fromSettings.gates, dispatchWindowMs: 60_000, stallMs: 10_000, reducerBudgetMs: 50 * 60 * 1000, reducerTimeoutMs: 55 * 60 * 1000 },
  });
  assert.equal(engine.agentLimit, 20, '本机设置面的值就是引擎生效的值');
});

test('AC3 设置节不含端点字段：混进 baseUrl / apiKey / model 一律拒（端点与 subagent 同键单源）', () => {
  const clean = validateSettings(settingsWith({ workflows: { tokenCap: 1000 } }));
  assert.deepEqual(clean, []);

  const withEndpoint = validateSettings(settingsWith({ workflows: { baseUrl: 'https://x', apiKey: 'k', model: 'm' } }));
  assert.ok(withEndpoint.some((e) => /endpoint field "baseUrl"/.test(e)));
  assert.ok(withEndpoint.some((e) => /endpoint field "apiKey"/.test(e)));
  assert.ok(withEndpoint.some((e) => /endpoint field "model"/.test(e)));

  const withTypo = validateSettings(settingsWith({ workflows: { tokenCaps: 1000 } }));
  assert.ok(withTypo.some((e) => /Unknown workflows setting "tokenCaps"/.test(e)), 'typo 静默失效 = 用户以为调了其实没调');

  const clamped = settingsWith({ workflows: { agentCap: 100_000, concurrencyWindow: 1 } });
  assert.deepEqual(validateSettings(clamped), []);
  assert.equal(clamped.workflows.agentCap, 10_000, '校验即压回硬顶');
  assert.equal(clamped.workflows.concurrencyWindow, 2);

  // 保存边界也要拦（照 myterminal.test 对 state.ts 的源码级锁惯例）：击穿嵌套的调参
  // 不该等到 run 启动才炸出来——那时用户只剩一条 FORBIDDEN。
  const state = fs.readFileSync(path.join(process.cwd(), 'src/tui/state.ts'), 'utf8');
  assert.match(state, /validateClockNesting\(resolveWorkflowGates\(next\.workflows, process\.env\)\.gates\)/);

  const endpointsStillSingleSource = settingsWith({ subagent: { enabled: true, model: 'm', baseUrl: 'https://x', apiKey: 'k' } });
  assert.deepEqual(validateSettings(endpointsStillSingleSource), [], '端点三元组照旧只在 subagent 段校验，签名与校验都没改');
});

// ── helpers ────────────────────────────────────────────────────

function settingsWith(workflows) {
  return {
    schemaVersion: 1,
    workspaceDir: '/tmp/ws',
    host: '127.0.0.1',
    port: 3210,
    connectorKey: 'k'.repeat(32),
    actionsToken: 't'.repeat(32),
    publicBaseUrl: '',
    maxOutputChars: 120_000,
    commandTimeoutSec: 60,
    uiLanguage: 'zh-CN',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
    ...workflows,
  };
}

/** 只为被点名的字段给答案，其余填空串（apply 走"解析失败保当前值"分支）。 */
function answersFor(values) {
  return WORKFLOW_SETTING_KEYS.map((key) => values[key.name] ?? (key.unit === 'switch' ? 'off' : ''));
}
