// Workflows T9（#232）：Workflows 屏的接线面
//
// 锁的是"两个源真的接上了"这一件事：
//   冷 = 引擎真跑过一条 run 之后，装配层从盘上把它读回来（路径出自模块布局）；
//   热 = 进度事件有生产侧订阅者了（#224–#228 缺口清单里的缺陷 2），且事件到投影即刻生效、
//        并进 renderRevision（下一渲染帧可见）；
//   控制 = 本地人面的 cancel / pause / resume 走引擎既有的那一道归属闸，审计 actor = 'tui'；
//   引擎未接线（端点没配）时三处都 inert：空屏、空列表、具名拒因，不抛。
// 纯函数契约在 issue-232-workflows-screen-units.test.mjs。

import { test, afterEach, describe } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act, createElement } from 'react';
import { testRender } from '@opentui/react/test-utils';

import { WorkflowEngine } from '../dist/workflows/engine.js';
import { MyTerminalRuntime } from '../dist/server.js';
import { virtualClock } from '../dist/workflows/clock.js';
import { WorkflowEvents } from '../dist/workflows/events.js';
import { initWorkflowEngine, getWorkflowEngine, resetWorkflowEngine } from '../dist/workflows/runtime.js';
import { runPaths, workflowPaths } from '../dist/workflows/paths.js';
import { readIndex, writeIndex } from '../dist/workflows/run-index.js';
import { SCHEMA_VERSION } from '../dist/workflows/schema.js';
import { TABS, TuiController, themeFor } from '../dist/tui/state.js';
import { routeCommand } from '../dist/tui/model/command-router.js';
import { I18nProvider } from '../dist/tui/copy/context.js';
import { i18nFor } from '../dist/tui/copy/i18n.js';
import { RunDetail, Workflows } from '../dist/tui/screens/Workflows.js';
import { buildRunBoard, diskRunBoardSource, applyWorkflowEvent, EMPTY_RUN_BOARD } from '../dist/tui/workflow-runs.js';

const SCRIPT = "const a = await agent('one', { label: 'first' });\nconst b = await agent('two', { label: 'second' });\nreturn { a, b };";

/** 一条最小的盘上记录：形态与字段照 T1 契约，够装配层读就行。 */
function indexRecord(runId, overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION, runId, status: 'running', ownerSessionId: 'ses_owner',
    scriptPath: '/ws/.myterminal/workflows/saved/research.js', sourceRef: { id: 'x', revision: 'r' },
    argsRecorded: false, startedAt: '2026-10-01T09:50:00.000Z', dispatches: [], failures: [],
    tokens: { spent: 0 }, ...overrides,
  };
}

let TMP;

function tempWorkspace(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `wf-232-${tag}-`));
  TMP = root;
  const workspaceDir = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { workspaceDir, stateDir, managedRoot: path.join(workspaceDir, '.myterminal') };
}

function fakeAdapter(options = {}) {
  const seen = { calls: 0 };
  return {
    seen,
    factory: () => ({ complete: async () => { seen.calls += 1; if (options.hang) return await options.hang; return { text: 'ok', outputTokens: options.tokens ?? 12 }; } }),
  };
}

/** 屏所依赖的那一小块引擎观测面（#232 新增），生产与测试同一形状。 */
function boardSourceFor(engine) {
  return diskRunBoardSource({
    paths: engine.layout,
    liveIndex: (runId) => engine.liveRunIndex(runId),
    liveRunIds: () => engine.liveRunIds,
  });
}

/** 冷启动读侧：另起一个引擎只为拿布局与"本进程没在跑任何东西"——等价于重启后的那个进程。 */
function coldSource(workspaceDir, managedRoot) {
  return boardSourceFor(new WorkflowEngine({ workspaceDir, managedRoot, clock: virtualClock() }));
}

/** 控制器用例只要布局，不要真引擎。 */
function tempLayout(tag) {
  return workflowPaths(tempWorkspace(tag).managedRoot);
}

/** 等模型调用真的挂上去（admission 是异步的，start 返回时那一笔还没发出去）。 */
async function until(predicate) {
  for (let tick = 0; tick < 200 && !predicate(); tick += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.equal(predicate(), true, '等的东西没来——测试前提不成立，不能让断言假绿');
}

afterEach(() => {
  resetWorkflowEngine();
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

describe('冷启动：从盘上把 run 读回来', () => {
  test('引擎真跑完一条 run 后，装配层不用任何事件也能重建它', async () => {
    const { workspaceDir, managedRoot } = tempWorkspace('cold');
    const engine = new WorkflowEngine({ workspaceDir, managedRoot, clock: virtualClock(), adapterFactory: fakeAdapter().factory, events: new WorkflowEvents() });
    const started = await engine.start({ script: SCRIPT, ownerSessionId: 'ses_owner' });
    await started.completion;

    const board = await buildRunBoard(coldSource(workspaceDir, managedRoot));
    assert.equal(board.rows.length, 1, `期望一条 run，实际 ${board.rows.length}（unreadable: ${JSON.stringify(board.unreadable)}）`);
    const [row] = board.rows;
    assert.equal(row.status, 'completed');
    assert.equal(row.total, 2);
    assert.equal(row.finished, 2);
    assert.equal(row.tokens, 24);
    assert.equal(row.hasMarker, true);
    assert.equal(row.indexPath, runPaths(engine.layout, row.runId).indexFile);
    assert.equal(fs.existsSync(row.indexPath), true, '屏上指的路就是盘上那份');
    assert.equal(row.live, false, '结算完的不再算本进程在跑');
  });

  test('runs/ 还不存在（一条都没跑过）= 空列表，不是故障', async () => {
    const { workspaceDir, managedRoot } = tempWorkspace('empty');
    const engine = new WorkflowEngine({ workspaceDir, managedRoot, clock: virtualClock(), adapterFactory: fakeAdapter().factory });
    const board = await buildRunBoard(boardSourceFor(engine));
    assert.deepEqual(board, EMPTY_RUN_BOARD);
  });

  test('盘面读不动的那一条（版本超前）留名并给原因，屏不跟着红', async () => {
    const { workspaceDir, managedRoot } = tempWorkspace('drift');
    const engine = new WorkflowEngine({ workspaceDir, managedRoot, clock: virtualClock(), adapterFactory: fakeAdapter().factory });
    const started = await engine.start({ script: SCRIPT, ownerSessionId: 'ses_owner' });
    await started.completion;
    const future = runPaths(engine.layout, started.runId);
    const raw = JSON.parse(fs.readFileSync(future.indexFile, 'utf8'));
    fs.writeFileSync(future.indexFile, JSON.stringify({ ...raw, schemaVersion: raw.schemaVersion + 7 }));

    const board = await buildRunBoard(coldSource(workspaceDir, managedRoot));
    assert.equal(board.rows.length, 0);
    assert.equal(board.unreadable.length, 1);
    assert.match(board.unreadable[0].message, /schema version mismatch/);
    assert.match(board.unreadable[0].message, /refusing to read/, '屏上要说清是拒读，不是没这条 run');
  });

  test('runs/ 已存在时，本进程在跑但目录还没落的那一条也在列（不漏在跑的）', async () => {
    const paths = tempLayout('merge');
    await writeIndex(runPaths(paths, 'wf_cafe').indexFile, indexRecord('wf_cafe', { status: 'completed', endedAt: '2026-10-01T09:55:00.000Z' }));
    const board = await buildRunBoard(diskRunBoardSource({
      paths,
      liveIndex: (runId) => (runId === 'wf_beef' ? indexRecord('wf_beef') : undefined),
      liveRunIds: () => ['wf_beef'],
    }));
    assert.deepEqual(board.rows.map((row) => row.runId), ['wf_beef', 'wf_cafe']);
    assert.equal(board.rows[0].live, true, '盘上还没有它的目录，不代表它不在跑');
    assert.equal(board.rows[1].live, false);
    assert.deepEqual(board.unreadable, [], '没有目录的活 run 不算"读不动"');
  });

  test.skipIf(process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0))('runs/ 存在但读不动（目录级权限故障）：屏得到 sourceError，不是空列表', async () => {
    const paths = tempLayout('eacces');
    fs.mkdirSync(paths.runsRoot, { recursive: true });
    fs.chmodSync(paths.runsRoot, 0o000);
    try {
      const board = await buildRunBoard(diskRunBoardSource({ paths, liveIndex: () => undefined, liveRunIds: () => [] }));
      assert.equal(board.rows.length, 0);
      assert.match(board.sourceError ?? '', /EACCES|permission/i, '读不动必须说成读不动');
    } finally {
      fs.chmodSync(paths.runsRoot, 0o755);
    }
  });
});

describe('热路径：引擎事件有订阅者了', () => {
  test('起一条 run，三类事件按序到订阅者；退订之后一条都不再来', async () => {
    const { workspaceDir, managedRoot } = tempWorkspace('hot');
    const engine = new WorkflowEngine({ workspaceDir, managedRoot, clock: virtualClock(), adapterFactory: fakeAdapter().factory });
    const got = [];
    const off = engine.onWorkflowEvent((event) => { got.push(event.type); });
    const started = await engine.start({ script: SCRIPT, ownerSessionId: 'ses_owner' });
    await started.completion;
    const seenAfterFirst = got.length;
    off();
    const second = await engine.start({ script: SCRIPT, ownerSessionId: 'ses_owner' });
    await second.completion;
    assert.equal(got.length, seenAfterFirst, '退订了还在收 = 订阅泄漏');

    assert.equal(got.filter((type) => type === 'run_started').length, 1);
    assert.equal(got.filter((type) => type === 'dispatch_settled').length, 2, '每一路收场都要有一条');
    assert.equal(got[got.length - 1], 'run_settled', '终态那一条排最后');
    assert.ok(got.indexOf('run_started') < got.indexOf('run_settled'));
  });

  test('在跑的那条算 live，结算完的从 live 里让位', async () => {
    const { workspaceDir, managedRoot } = tempWorkspace('live');
    const hang = {};
    const engine = new WorkflowEngine({
      workspaceDir, managedRoot, clock: virtualClock(),
      adapterFactory: () => ({ complete: () => new Promise((resolve) => { hang.resolve = resolve; }) }),
    });
    const started = await engine.start({ script: "await agent('one', { label: 'x' });\nreturn 1;", ownerSessionId: 'ses_owner' });
    assert.deepEqual(engine.liveRunIds, [started.runId]);
    assert.equal(engine.liveRunIndex(started.runId)?.status, 'running', '活索引就是本进程那份最新账');
    assert.equal(engine.liveRunIndex('wf_missing'), undefined);

    await until(() => Boolean(hang.resolve));
    hang.resolve({ text: 'ok', outputTokens: 3 });
    await started.completion;
    assert.deepEqual(engine.liveRunIds, [], '终态了就不该再被当在跑（屏上"本进程在跑"要说真话）');
  });

  test('事件到达即在投影上落地：状态与在跑位不用等扫盘；计数等扫盘补齐', async () => {
    const { workspaceDir, managedRoot } = tempWorkspace('patch');
    const engine = new WorkflowEngine({ workspaceDir, managedRoot, clock: virtualClock(), adapterFactory: fakeAdapter().factory });
    let board = await buildRunBoard(boardSourceFor(engine));
    const patch = { liveIndex: (id) => engine.liveRunIndex(id), indexPath: (id) => runPaths(engine.layout, id).indexFile };
    engine.onWorkflowEvent((event) => { board = applyWorkflowEvent(board, event, patch); });

    const started = await engine.start({ script: SCRIPT, ownerSessionId: 'ses_owner' });
    assert.equal(board.rows.length, 1, 'run_started 那一条就该把行带出来');
    assert.equal(board.rows[0].runId, started.runId);
    assert.equal(board.rows[0].live, true);
    assert.equal(board.rows[0].indexPath, runPaths(engine.layout, started.runId).indexFile);

    await started.completion;
    assert.equal(board.rows[0].status, 'completed', '终态不等扫盘');
    assert.equal(board.rows[0].live, false);
    assert.equal(board.rows[0].hasMarker, true);

    const rescanned = await buildRunBoard(boardSourceFor(engine));
    assert.equal(rescanned.rows[0].finished, 2, 'X/Y 这类逐路账由扫盘补齐，投影不装得全');
  });
});

describe('本地人面的控制（AC3 / §19：pause 与 resume 只在这块屏上）', () => {
  /** 真引擎 + 挂起的模型：控制动作只在 run 活着的时候有意义。 */
  async function running(tag) {
    const ws = tempWorkspace(tag);
    const audit = [];
    const hang = {};
    const engine = new WorkflowEngine({
      workspaceDir: ws.workspaceDir,
      managedRoot: ws.managedRoot,
      clock: virtualClock(),
      audit: (entry) => audit.push(entry),
      adapterFactory: () => ({ complete: () => new Promise((resolve) => { hang.resolve = resolve; }) }),
    });
    const started = await engine.start({ script: "await agent('one', { label: 'x' });\nreturn 1;", ownerSessionId: 'ses_owner' });
    await until(() => Boolean(hang.resolve));
    return { ...ws, engine, audit, hang, runId: started.runId };
  }

  test('pause → paused，墙钟冻结在账上，审计 actor 是按下键的人', async () => {
    const ctx = await running('pause');
    const result = await ctx.engine.controlAsLocal('pause', ctx.runId);
    assert.equal(result.status, 'paused');
    assert.equal((await readIndex(runPaths(ctx.engine.layout, ctx.runId).indexFile))?.status, 'paused', '运行态要落进 index.json（冷启动读得到同一份）');
    const paused = ctx.audit.filter((entry) => entry.action === 'workflow_pause');
    assert.equal(paused.length, 1);
    assert.equal(paused[0].actor, 'tui', '§12：审计的 actor 要分得清是 root / GPT / TUI 人');
    assert.equal(paused[0].runId, ctx.runId);
  });

  test('resume 只把暂停过的放行回 running，也是具名审计', async () => {
    const ctx = await running('resume');
    await ctx.engine.controlAsLocal('pause', ctx.runId);
    const result = await ctx.engine.controlAsLocal('resume', ctx.runId);
    assert.equal(result.status, 'running');
    assert.equal(ctx.audit.filter((entry) => entry.action === 'workflow_paused_resume').length, 1);
    assert.equal(ctx.audit.at(-1).actor, 'tui');
  });

  test('没暂停过就 resume = 原地不动，也不落一条假账', async () => {
    const ctx = await running('resume-idle');
    const result = await ctx.engine.controlAsLocal('resume', ctx.runId);
    assert.equal(result.status, 'running');
    assert.equal(ctx.audit.filter((entry) => entry.action === 'workflow_paused_resume').length, 0);
  });

  test('cancel 结整个 run，终态三件套照发，审计记下是谁按的', async () => {
    const ctx = await running('cancel');
    const result = await ctx.engine.controlAsLocal('cancel', ctx.runId);
    assert.equal(result.status, 'cancelled');
    const paths = runPaths(ctx.engine.layout, ctx.runId);
    assert.equal((await readIndex(paths.indexFile))?.status, 'cancelled');
    assert.equal(fs.existsSync(paths.terminalFile), true, '取消也走同一把结算：终态标记必须落地');
    assert.equal(ctx.audit.filter((entry) => entry.action === 'workflow_cancel' && entry.actor === 'tui').length, 1);
  });

  test('认不出这条 run = 具名 NOT_FOUND，不给一个哑巴错', async () => {
    const ws = tempWorkspace('unknown');
    const engine = new WorkflowEngine({ workspaceDir: ws.workspaceDir, managedRoot: ws.managedRoot, clock: virtualClock() });
    for (const op of ['cancel', 'pause', 'resume']) {
      const error = await engine.controlAsLocal(op, 'wf_deadbeef').catch((cause) => cause);
      assert.equal(error?.code, 'NOT_FOUND', `${op} 的拒因不对`);
      assert.equal(error?.reason, 'run-not-found');
    }
    const junk = await engine.controlAsLocal('cancel', '../../etc/passwd').catch((cause) => cause);
    assert.equal(junk?.code, 'NOT_FOUND', '不合形态的 runId 也只能是找不到，不能去拼路径');
  });

  test('别人的 run 走模型通道仍是 FORBIDDEN，本地面不动这道闸的语义', async () => {
    const ctx = await running('owned');
    const denied = await ctx.engine.pause(ctx.runId, ['ses_other']).catch((cause) => cause);
    assert.equal(denied?.code, 'FORBIDDEN');
    assert.equal(denied?.reason, 'run-not-owned');
    assert.equal(ctx.audit.filter((entry) => entry.action === 'workflow_pause').length, 0, '被拒的那一次不许留下已暂停的账');
  });
});

describe('TuiController 的 Workflows 面（接线与动作）', () => {
  /** duck-typed 最小 runtime：只给 renderRevision 与 Workflows 观测面所需的成员。 */
  function fakeRuntime(workflow = {}) {
    const runtime = {
      config: {},
      store: { revision: () => 'r1', snapshotForTui: () => ({}) },
      runtimeLogRevision: () => runtime.logs.length,
      runtimeHealth: () => ({ phase: 'active' }),
      l3Health: () => null,
      logs: [],
      log(message, level) { runtime.logs.push({ at: '2026-10-01T10:00:00.000Z', level: level ?? 'info', message }); },
      close: async () => {},
      workflowLayout: () => workflow.paths,
      liveWorkflowRunIds: () => workflow.liveIds ?? [],
      liveWorkflowRun: (runId) => workflow.live?.[runId],
      onWorkflowEvent(listener) { runtime.handlers.push(listener); return () => { runtime.handlers = runtime.handlers.filter((item) => item !== listener); }; },
      controlWorkflowRun: async (op, runId) => { runtime.controls.push({ op, runId }); return workflow.control?.(op, runId) ?? { ok: true, runId, status: 'paused' }; },
      handlers: [],
      controls: [],
    };
    return runtime;
  }

  function controllerFor(workflow) {
    const runtime = fakeRuntime(workflow);
    const controller = new TuiController(runtime, async () => { throw new Error('not used'); });
    return { runtime, controller };
  }

  test('引擎没接线（端点未配）：runtime 面全是惰性值，控制动作给具名拒因', async () => {
    const ws = tempWorkspace('wired');
    const runtime = new MyTerminalRuntime({
      workspaceDir: ws.workspaceDir,
      stateDir: ws.stateDir,
      settingsPath: path.join(ws.stateDir, 'settings.json'),
      host: '127.0.0.1',
      port: 0,
      connectorKey: 'k'.repeat(32),
      actionsToken: 't'.repeat(32),
      publicBaseUrl: '',
      maxOutputChars: 4000,
      commandTimeoutSec: 10,
      uiLanguage: 'en',
      uiTheme: 'dark',
      passiveLockEnabled: false,
      actionsContinuationMode: 'off',
      nonBlockingTasksEnabled: false,
    });
    assert.equal(runtime.workflowLayout(), undefined);
    assert.deepEqual(runtime.liveWorkflowRunIds(), []);
    assert.equal(runtime.liveWorkflowRun('wf_a'), undefined);
    const off = runtime.onWorkflowEvent(() => { throw new Error('不该有事件'); });
    assert.equal(typeof off, 'function', '没有引擎也要给一条能退的订');
    off();
    const refused = await runtime.controlWorkflowRun('pause', 'wf_a');
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'workflow-not-wired');
    assert.match(refused.message, /not wired/);
  });

  test('控制器在没有布局可扫时也是空屏、无提示、不抛', async () => {
    const { controller } = controllerFor({});
    controller.start();
    assert.deepEqual(await controller.refreshWorkflowBoard(), EMPTY_RUN_BOARD);
    assert.equal(controller.workflowInterruptedNotice((en) => en), undefined);
    await controller.shutdown();
  });

  test('事件一到：投影、renderRevision 与订阅者三者同时跟上（下一渲染帧可见的前提）', async () => {
    const live = { wf_beef: indexRecord('wf_beef') };
    const { runtime, controller } = controllerFor({ paths: tempLayout('ctl'), liveIds: ['wf_beef'], live });
    controller.start();
    const before = controller.renderRevision();
    let notified = 0;
    const off = controller.onWorkflowBoardChange(() => { notified += 1; });
    runtime.handlers[0]({ runId: 'wf_beef', type: 'run_started', at: '2026-10-01T10:00:00.000Z' });

    assert.equal(controller.workflowBoard().rows.length, 1);
    assert.equal(controller.renderRevision() !== before, true, '不进修订号 = 双速 tick 看不见这次变化');
    assert.equal(notified, 1);
    off();
    assert.equal(controller.workflowBoard().rows[0].runId, 'wf_beef');
  });

  test('start 订阅、shutdown 退订：一次开关不漏订阅者', async () => {
    const { runtime, controller } = controllerFor({ paths: tempLayout('ctl') });
    controller.start();
    assert.equal(runtime.handlers.length, 1);
    await controller.shutdown();
    assert.equal(runtime.handlers.length, 0, '漏退订 = 关掉屏还在被事件推着跑');
  });

  test('cancel 要确认，pause / resume 直接受理（可逆的别拦人）', async () => {
    const { runtime, controller } = controllerFor({ paths: tempLayout('ctl') });
    const answers = [];
    await controller.cancelWorkflowRun('wf_a', async () => { answers.push('no'); return ['no']; });
    assert.equal(runtime.controls.length, 0, '答 no 就不该动');
    await controller.cancelWorkflowRun('wf_a', async () => ['yes']);
    assert.deepEqual(runtime.controls, [{ op: 'cancel', runId: 'wf_a' }]);
    await controller.pauseWorkflowRun('wf_a');
    await controller.resumeWorkflowRun('wf_a');
    assert.deepEqual(runtime.controls.map((item) => item.op), ['cancel', 'pause', 'resume']);
  });

  test('取消一条不在本进程跑的 run：如实说"什么都没停"，不许报成受理成功', async () => {
    const { runtime, controller } = controllerFor({
      paths: tempLayout('nocancel'),
      control: () => ({ ok: true, runId: 'wf_a', status: 'running' }),
    });
    await controller.cancelWorkflowRun('wf_a', async () => ['yes']);
    const last = runtime.logs.at(-1);
    assert.equal(last.level, 'error');
    assert.match(last.message, /not running in this process/);
    assert.match(last.message, /nothing was cancelled/);
    assert.doesNotMatch(last.message, /^工作流|^Workflow wf_a → running$/, '盘面状态不许被当成"取消已受理"播报');
  });

  test('控制失败的具名拒因上屏（FORBIDDEN / NOT_FOUND 都要看得见），并留一条日志', async () => {
    const { runtime, controller } = controllerFor({
      paths: tempLayout('ctl'),
      control: () => ({ ok: false, reason: 'run-not-owned', message: 'Workflow run wf_a belongs to another session.' }),
    });
    await controller.pauseWorkflowRun('wf_a');
    assert.equal(runtime.logs.at(-1).level, 'error');
    assert.match(runtime.logs.at(-1).message, /belongs to another session/);
  });

  test('resume 调用文本可取可复制，取不到就不谎报已复制', async () => {
    const live = { wf_beef: indexRecord('wf_beef') };
    const { controller } = controllerFor({ paths: tempLayout('ctl'), liveIds: ['wf_beef'], live });
    controller.start();
    assert.equal(controller.workflowResumeCall('wf_beef'), undefined, '还没扫过盘就没有这一条');
    await controller.refreshWorkflowBoard();
    assert.match(controller.workflowResumeCall('wf_beef'), /"resumeFromRunId":"wf_beef"/);
    assert.equal(controller.workflowResumeCall('wf_nope'), undefined);
  });

  test('被打断的 run：冷启动扫到挂在活跃态的那一条，启动提示带上它', async () => {
    const paths = tempLayout('int');
    await writeIndex(runPaths(paths, 'wf_beef').indexFile, indexRecord('wf_beef'));
    const { controller } = controllerFor({ paths });
    await controller.refreshWorkflowBoard();
    const notice = controller.workflowInterruptedNotice((en) => en);
    assert.ok(notice);
    assert.match(notice.lines[0], /wf_beef/);
    assert.match(notice.resume('wf_beef'), /resumeFromRunId/);
    // 提示的每一条要自带可粘贴的调用：屏上只给名字，人就粘不出东西（Home 直接渲染 items）。
    assert.equal(notice.items.length, 1);
    assert.equal(notice.items[0].runId, 'wf_beef');
    assert.match(notice.items[0].call, /^workflow_start \{"scriptPath":"/);
    const home = fs.readFileSync(new URL('../src/tui/screens/Home.tsx', import.meta.url), 'utf8');
    assert.match(home, /interrupted\.head/, '首行没上屏 = 提示少了主语');
    assert.match(home, /interrupted\.items\.map/, '提示要逐条渲染，不是只报一个数');
    assert.match(home, /item\.call/, '逐条的 resume 调用文本要出现在启动屏上');
  });
});

describe('屏上真有字（渲染面，非快照）', () => {
  async function frame(node, width = 100, height = 24) {
    let setup;
    await act(async () => {
      setup = await testRender(createElement(I18nProvider, { value: i18nFor('en') }, node), { width, height });
      await setup.flush();
    });
    try {
      return setup.captureCharFrame();
    } finally {
      await act(async () => { setup.renderer?.destroy?.(); });
    }
  }

  async function boardRows(...records) {
    const indexes = Object.fromEntries(records.map((record) => [record.runId ?? 'wf_beef', indexRecord(record.runId ?? 'wf_beef', record)]));
    return (await buildRunBoard({
      listRunIds: async () => Object.keys(indexes),
      readRun: async (runId) => indexes[runId],
      hasMarker: async () => false,
      isLive: () => false,
      indexPath: (runId) => `/runs/${runId}/index.json`,
    })).rows;
  }

  test('列表页：runId、状态、X/Y 与失败数都在帧里', async () => {
    const rows = await boardRows(
      {},
      { runId: 'wf_cafe', status: 'completed', dispatches: [{ id: 'd0001', label: 'solo', status: 'failed', attempts: 3, startedAt: '2026-10-01T09:50:00.000Z', outputTokens: 9, error: { kind: 'stalled', message: 'no progress' } }], failures: [{ label: 'solo', kind: 'stalled', message: 'no progress' }], tokens: { spent: 4321 } },
    );
    const seen = await frame(createElement(Workflows, { rows, unreadable: [], selected: 0, now: 1759312800000, theme: themeFor('dark'), onSelect: () => {} }));
    assert.match(seen, /wf_beef/);
    assert.match(seen, /wf_cafe/);
    assert.match(seen, /running/);
    assert.match(seen, /completed/);
    assert.match(seen, /1 failed/, '失败的那一路要在列表行里就说清楚');
    assert.match(seen, /4321/);
    // 提示行由这块屏能做的事生成（负向那半由 WORKFLOW_SCREEN_ACTIONS 的名单守住）。
    assert.match(seen, /Enter detail   c cancel   p pause   r resume   y copy resume call   q quit/);
  });

  test('列表页空态：一条 run 都没有时给出这句话，而不是空白', async () => {
    const seen = await frame(createElement(Workflows, { rows: [], unreadable: [], selected: 0, now: 1759312800000, theme: themeFor('dark'), onSelect: () => {} }));
    assert.match(seen, /No workflow runs/);
  });

  test('读不动的那一条在屏上留名（不能被空态吞掉）', async () => {
    const seen = await frame(createElement(Workflows, { rows: [], unreadable: [{ runId: 'wf_bad', message: 'schema version mismatch' }], selected: 0, now: 1759312800000, theme: themeFor('dark'), onSelect: () => {} }));
    assert.match(seen, /wf_bad/);
    assert.match(seen, /schema version mismatch/);
  });

  test('目录级读不动上屏成一句"读不了 run 目录"，而不是空态那句"还没有 run"', async () => {
    const seen = await frame(createElement(Workflows, { rows: [], unreadable: [], sourceError: 'EACCES: permission denied, scandir', selected: 0, now: 1759312800000, theme: themeFor('dark'), onSelect: () => {} }));
    assert.match(seen, /Cannot read the run directory/);
    assert.match(seen, /EACCES/);
    assert.doesNotMatch(seen, /No workflow runs/);
  });

  test('详情页：逐路 label / 状态 / 尝试次数 / 用量 / 失败原因 / 待处置的 worktree', async () => {
    const record = indexRecord('wf_beef', {
      status: 'completed',
      dispatches: [
        { id: 'd0001', seq: 1, label: 'survey', status: 'completed', attempts: 1, startedAt: '2026-10-01T09:50:00.000Z', endedAt: '2026-10-01T09:51:00.000Z', outputTokens: 1200, phase: 'research' },
        { id: 'd0002', seq: 2, label: 'audit', status: 'failed', attempts: 3, startedAt: '2026-10-01T09:51:00.000Z', endedAt: '2026-10-01T09:57:00.000Z', outputTokens: 80, error: { kind: 'stalled', message: 'no progress for 180s' }, worktree: { path: '/ws/.myterminal/worktrees/wf_beef-d0002', branch: 'wf/wf_beef-d0002', preserved: true } },
      ],
      failures: [{ seq: 2, label: 'audit', kind: 'stalled', message: 'no progress for 180s' }],
      tokens: { spent: 1280 }, reducerTokens: { spent: 66 },
    });
    const row = {
      runId: 'wf_beef', index: record, status: 'completed', finished: 1, total: 2, running: 0, failedPaths: 1,
      failures: 1, tokens: 1280, reducerTokens: 66, live: false, hasMarker: true, ownerSessionId: 'ses_owner',
      scriptPath: '/s.js', startedAt: record.startedAt, indexPath: '/runs/wf_beef/index.json',
    };
    const seen = await frame(createElement(RunDetail, { row, now: 1759312800000, theme: themeFor('dark') }), 110, 30);
    assert.match(seen, /survey/);
    assert.match(seen, /audit/);
    assert.match(seen, /stalled/);
    assert.match(seen, /3x/, '重试次数要看得见');
    assert.match(seen, /wf_beef-d0002/);
    assert.match(seen, /1280/);
    assert.match(seen, /66/);
    assert.match(seen, /index\.json/, '详情页要提醒索引在哪');
  });

  test('非 TTY / --headless 下这块屏根本不进进程：TUI 是按需 import，扫盘也只活在 TUI 那边', () => {
    const cli = fs.readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    assert.match(cli, /if \(!headless\) \{\s*const \{ MyTerminalTui \} = await import\('\.\/tui\/index\.js'\)/,
      'TUI 必须仍在 !headless 分支里按需 import——静态 import 会把屏拖进 headless 进程');
    const server = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(server, /workflow-runs|screens\/Workflows/, 'runtime 侧不许扫 run 目录：屏不启动时也不该有人去读盘');
  });

  test('/workflows 是页内导航（第十一页没有可用的数字直达键）', () => {
    assert.deepEqual(routeCommand('/workflows'), { kind: 'navigate', tab: TABS.indexOf('Workflows') });
    assert.deepEqual(routeCommand('/工作流'), { kind: 'navigate', tab: TABS.indexOf('Workflows') });
    assert.equal(TABS[10], 'Workflows');
  });

  test('页签标签两语都得齐（少一个 zh 标签 = 那页在中文界面上没有名字）', async () => {
    const { LABELS_EN, LABELS_ZH } = await import('../dist/tui/components/chrome/BottomNav.js');
    assert.deepEqual(LABELS_EN, [...TABS], 'en 标签就是 TABS 本身，两处必须同源');
    assert.equal(LABELS_ZH.length, TABS.length, 'zh 标签少一个就整排错位一格');
    assert.equal(LABELS_ZH[10], '工作流');
  });

  test('贯通：引擎真跑出的 run，冷启动扫回来后可见地渲染成一屏（AC1+AC2 同一条链）', async () => {
    const { workspaceDir, managedRoot } = tempWorkspace('render-cold');
    const runner = new WorkflowEngine({ workspaceDir, managedRoot, clock: virtualClock(), adapterFactory: fakeAdapter({ tokens: 777 }).factory });
    const started = await runner.start({ script: SCRIPT, ownerSessionId: 'ses_owner' });
    await started.completion;

    const board = await buildRunBoard(coldSource(workspaceDir, managedRoot));
    assert.equal(board.rows.length, 1);
    const seen = await frame(createElement(Workflows, {
      rows: board.rows,
      unreadable: board.unreadable,
      sourceError: board.sourceError,
      selected: 0,
      now: Date.parse('2026-10-01T10:00:00.000Z'),
      theme: themeFor('dark'),
      onSelect: () => {},
    }));
    assert.match(seen, new RegExp(started.runId), '屏上那行就是盘上那条 run');
    assert.match(seen, /2\/2/);
    assert.match(seen, /1554/, '两路各 777 output tokens 合计上屏');
    const detail = await frame(createElement(RunDetail, { row: board.rows[0], now: Date.parse('2026-10-01T10:00:00.000Z'), theme: themeFor('dark') }), 110, 30);
    assert.match(detail, /first/);
    assert.match(detail, /second/);
    assert.match(detail, /index\.json/);
  });
});
