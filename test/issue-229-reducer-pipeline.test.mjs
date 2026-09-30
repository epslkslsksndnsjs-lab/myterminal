// Workflows T6（#229）· 汇总体回传管线——引擎级验收
//
// 全部跑在假模型 + 虚拟钟上：run 的一路与汇总体（现有 subagent）各走各自的循环，
// wait_for_path 真在工具内阻塞（等待期零模型调用），终态三件套真落盘、真进收件箱，
// 摘要走的是既有 runner 结算管线（checkpoint + message_send，签名一字未改）。
//
// 票面覆盖：
//   AC3 reduce 工具层校验（不存在=NOT_FOUND / 非本 root=FORBIDDEN / 零预算旋钮 / timeoutSec 传入即拒）
//       + 两道既有防线在汇总体场景成立（subagent 通道调 workflow_start、起 sub-subagent）
//   AC4 e2e：起 run → 起汇总体 → 阻塞等待（等待期模型调用计数 0）→ 结算 → ≤1 个轮询周期醒
//       → 摘要交付（KV 首行 + 一句话 + 绝对路径 + 索引提醒）→ 收件箱与轮询视图一致
//   AC5 终态消息 ≤200 码元、首行 KV、durable outbox、投递标 delivered
//   AC7 wait-timeout = failed(reason=wait-timeout) 三段报告，禁止 completed 掩盖；同 runId 补起 / 重跑
//   AC8 等待位准入（同一 run 至多一个等待者）、配额默认 3 与 notice-only 降级、maxParallel 上限 10

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { virtualClock } from '../dist/workflows/clock.js';
import { workflowPaths, runPaths } from '../dist/workflows/paths.js';
import { newRunId } from '../dist/workflows/ids.js';
import { writeIndex } from '../dist/workflows/run-index.js';
import { SCHEMA_VERSION } from '../dist/workflows/schema.js';
import { persistScript } from '../dist/workflows/saved.js';
import { defaultWorkflowGates } from '../dist/workflows/gates.js';
import { WorkflowEvents } from '../dist/workflows/events.js';
import { initWorkflowEngine, resetWorkflowEngine } from '../dist/workflows/runtime.js';
import { readReducerWaiter, countReducerWaiters, concludeReducer } from '../dist/workflows/reducer.js';
import { readOutbox } from '../dist/workflows/notice.js';
import { createBuiltinTools } from '../dist/core-tools.js';
import { MyTerminalStore } from '../dist/store.js';
import { runSubagent } from '../dist/subagent/executor.js';
import { setRunnerDepsForTesting, resetSubagentRunner, getSubagentRunner } from '../dist/subagent/runner.js';
import { clearAllSubagents, getSubagent } from '../dist/subagent/store.js';
import { applySubagentDefaults } from '../dist/config.js';
import { setWaitForPathTimingForTesting, resetWaitForPathTimingForTesting, WAIT_FOR_PATH_POLL_MS } from '../dist/subagent/tools.js';

const TMP = [];
const INLINE_SCRIPT = "await agent('work', { label: 'p1' });\nreturn 1;";
const realLstat = (file) => fs.promises.lstat(file).then((info) => ({
  isFile: () => info.isFile(),
  isSymbolicLink: () => info.isSymbolicLink(),
  size: info.size,
}));

function makeConfig(workspaceDir, stateDir) {
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

/** 短闸整栈：仍然满足嵌套不变量（每层留 ≥ reduceSlack），但虚拟钟走得到尽头。 */
function tightGates(over = {}) {
  return {
    runGateMs: 10_000,
    dispatchWindowMs: 5_000,
    dispatchTurns: 12,
    stallMs: 5_000,
    waitChunkMs: 2_000,
    reducerBudgetMs: 12_000,
    reducerTimeoutMs: 14_000,
    reduceSlackMs: 2_000,
    ...over,
  };
}

function subSettings(over = {}) {
  return {
    enabled: true,
    provider: 'anthropic',
    model: 'claude-mock',
    maxTurns: 20,
    timeoutSec: 600,
    maxParallel: 10,
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'test-mock-key',
    compactThreshold: 1_000_000,
    maxOutput: 32_000,
    ...over,
  };
}

/** 引擎侧假模型：可挂起（holdRun）、可计数——"等待期零调用"的读数之一。 */
function runModel(hold) {
  const state = { calls: 0, release: undefined, next: () => ({ text: 'agent answer', outputTokens: 3 }) };
  if (hold) {
    state.next = () => new Promise((resolve) => { state.release = () => resolve({ text: 'agent answer', outputTokens: 3 }); });
  }
  const factory = () => ({
    complete: async () => {
      state.calls += 1;
      return await state.next();
    },
  });
  return { factory, state };
}

/** 汇总体侧假模型（现有 subagent 的 LlmAdapter 面）：按回合派发剧本，记下每次看到的 tool_result。 */
function reducerModel(script) {
  const seen = { calls: 0, toolResults: [] };
  const adapter = () => {
    let turn = 0;
    return {
      provider: 'test-reducer',
      async *stream(params) {
        turn += 1;
        seen.calls += 1;
        for (const message of params.messages ?? []) {
          for (const block of message.content ?? []) {
            if (block.type !== 'tool_result') continue;
            const text = typeof block.content === 'string'
              ? block.content
              : (block.content ?? []).map((part) => part.text ?? '').join('');
            seen.toolResults.push({ turn, name: block.tool_use_id, text });
          }
        }
        const step = script(turn, seen) ?? { text: 'done' };
        if (step.text !== undefined) {
          yield { type: 'text_delta', text: step.text };
          yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 2 } };
          return;
        }
        const json = JSON.stringify(step.input);
        yield { type: 'tool_call_start', index: 0, id: `tc${turn}`, name: step.name };
        for (let i = 0; i < json.length; i += 32) {
          yield { type: 'tool_call_delta', index: 0, jsonFragment: json.slice(i, i + 32) };
        }
        yield { type: 'tool_call_end', index: 0, id: `tc${turn}` };
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 2 } };
      },
      async create() {
        return { message: { role: 'assistant', content: [{ type: 'text', text: 'summary' }] }, usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
  };
  return { adapter, seen };
}

const IDLE = () => ({ text: 'idle' });

/**
 * 一整套接线：真 store（收件箱）+ 真引擎（虚拟钟）+ 真 runner 链（假模型）。
 * notify 直取 store.sendMessage——生产的 message_send 认证面已由 subagent-m8 / issue-142 钉住，
 * 本票要断的是"摘要经这条管线交付"，不是重跑一遍认证层。
 */
function harness(options = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-229-e2e-')));
  TMP.push(dir);
  const workspaceDir = path.join(dir, 'workspace');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const managedRoot = path.join(workspaceDir, '.myterminal');
  const paths = workflowPaths(managedRoot);
  const store = new MyTerminalStore(stateDir);
  const root = store.registerRoot({ name: 'gpt-parent' });
  const clock = virtualClock();
  const gates = options.gates ?? tightGates();
  const model = runModel(Boolean(options.holdRun));
  const events = new WorkflowEvents();
  const deliverNotices = [];
  const audit = [];

  const engine = initWorkflowEngine({
    workspaceDir,
    managedRoot,
    clock,
    events,
    audit: (entry) => audit.push(entry),
    adapterFactory: options.adapterFactory ?? model.factory,
    gates,
    concurrencyWindow: 2,
    ...(options.crash ? { crash: options.crash } : {}),
    deliverNotice: (notice) => {
      if (options.deliverFails) return false;
      // 与 server.ts 同形：发起会话既是收件人也是发件人，身份写在首行 KV 上。
      store.sendMessage(notice.ownerSessionId, notice.ownerSessionId, notice.body);
      deliverNotices.push(notice);
      return true;
    },
  });

  const reducer = options.reducer ?? reducerModel(IDLE);
  const checkpoints = [];
  const notified = [];
  const reducerAdmits = [];
  const executorStarts = [];
  setRunnerDepsForTesting({
    runSubagentImpl: (opts) => {
      executorStarts.push(opts);
      return runSubagent({ ...opts, adapter: reducer.adapter() });
    },
    settings: options.settings ?? subSettings(),
    workspaceDir,
    notify: async (childId, childIdentity, parentId, body) => {
      notified.push({ childId, parentId, body });
      store.sendMessage(childIdentity.sessionId, parentId, body);
    },
    checkpoint: async (childId, childIdentity, phase, summary) => { checkpoints.push({ childId, phase, summary }); },
    registerAndClaimChild: (parentId, args) => {
      const { session, claimCode } = store.registerDelegate(parentId, { name: args.name, task: args.task });
      const claimed = store.inherit(session.id, { claimCode });
      return { session: claimed.session, identity: claimed.identity };
    },
    reducer: {
      admit: async (info) => { reducerAdmits.push(info); return await engine.admitReducer(info); },
      conclude: async (info) => {
        const verdict = await engine.concludeReducer(info);
        return verdict.status === 'completed'
          ? { status: 'completed', firstLine: verdict.firstLine }
          : { status: 'failed', reason: verdict.reason, report: verdict.report };
      },
    },
  });

  const tools = createBuiltinTools(makeConfig(workspaceDir, stateDir), store);
  const toolContext = (session = root.session) => ({ transport: 'actions', authenticatedSession: session });

  /** 等待驱动器：sleep 即推进虚拟钟；到 releaseAfterMs（相对装机时刻）放跑 run 的那一路并等它真结算完。 */
  function driveWait(releaseAfterMs, options = {}) {
    const installedAt = clock.now();
    const ticks = [];
    let settledAt;
    let releasedAt;
    events.on((event) => { if (event.type === 'run_settled') settledAt = clock.now(); });
    setWaitForPathTimingForTesting({
      now: () => clock.now(),
      pollIntervalMs: WAIT_FOR_PATH_POLL_MS,
      sleep: async (ms) => {
        clock.advance(ms);
        ticks.push({ at: clock.now(), waitedMs: clock.now() - installedAt, reducerCalls: reducer.seen.calls, runCalls: model.state.calls, released: Boolean(releasedAt) });
        if (releaseAfterMs !== undefined && !releasedAt && clock.now() - installedAt >= releaseAfterMs) {
          releasedAt = clock.now();
          model.state.release?.();
          // 结算是真 IO：等终态标记真落地（有界），虚拟钟不因此前进——否则高负载下会假红。
          if (options.terminalFile) {
            for (let i = 0; i < 400 && !fs.existsSync(options.terminalFile); i += 1) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          }
        }
      },
      lstat: realLstat,
    });
    return {
      ticks,
      settledAt: () => settledAt,
      releasedAt: () => releasedAt,
      releasedWaitedMs: () => (releasedAt === undefined ? undefined : releasedAt - installedAt),
      releaseNow: () => { releasedAt = clock.now(); model.state.release?.(); },
    };
  }

  /** 永不兑现的等待面：让汇总体卡在 wait_for_path 里，从而占住等待位。 */
  function holdWait() {
    setWaitForPathTimingForTesting({
      now: () => clock.now(),
      pollIntervalMs: WAIT_FOR_PATH_POLL_MS,
      sleep: () => new Promise(() => {}),
      lstat: realLstat,
    });
  }

  /** 不推进钟的立即型等待面：断"标记已在 = 一次都不等"。 */
  function instantWait() {
    let sleeps = 0;
    setWaitForPathTimingForTesting({
      now: () => clock.now(),
      pollIntervalMs: WAIT_FOR_PATH_POLL_MS,
      sleep: () => { sleeps += 1; return Promise.resolve(); },
      lstat: realLstat,
    });
    return { sleeps: () => sleeps };
  }

  const startRun = async (session = root.session) => await tools.get('workflow_start').invoke({ script: INLINE_SCRIPT }, toolContext(session));
  const startReducer = async (runId, session = root.session, extra = {}) =>
    await tools.get('subagent_start').invoke({ objective: 'reduce the run', reduce: { runId }, ...extra }, toolContext(session));

  return {
    store, root, clock, engine, paths, model, events, audit,
    checkpoints, notified, reducerAdmits, deliverNotices, executorStarts, reducer,
    tools, toolContext, driveWait, instantWait, holdWait, startRun, startReducer, workspaceDir, managedRoot, gates,
  };
}

async function until(condition, what, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) assert.fail(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const toolResultOf = (reducer, turn) => reducer.seen.toolResults.find((entry) => entry.turn === turn)?.text;
const jsonOf = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

afterEach(() => {
  resetSubagentRunner();
  clearAllSubagents();
  resetWorkflowEngine();
  resetWaitForPathTimingForTesting();
  while (TMP.length) {
    const dir = TMP.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
  }
});

// ═══════════════════════════════════════════════════════════════
// 一、reduce 的工具层校验（拒在起 subagent 之前）
// ═══════════════════════════════════════════════════════════════

test('reduce-1: runId 不存在 = NOT_FOUND，且不留记录、不占等待位', async () => {
  const h = harness();
  const refused = await h.startReducer(newRunId()).catch((error) => error);
  assert.equal(refused.code, 'NOT_FOUND');
  assert.equal(refused.details.reason, 'run-not-found');
  assert.equal(h.reducerAdmits.length, 0, '归属未过就不该走到准入');
  assert.equal(await countReducerWaiters(h.paths), 0);
});

test('reduce-2: 非本 root 名下 = FORBIDDEN（判据 = run 记录里的 ownerSessionId）', async () => {
  const h = harness();
  const foreignRunId = newRunId();
  const run = runPaths(h.paths, foreignRunId);
  fs.mkdirSync(run.dir, { recursive: true });
  const saved = await persistScript(h.paths, INLINE_SCRIPT, foreignRunId);
  await writeIndex(run.indexFile, {
    schemaVersion: SCHEMA_VERSION, runId: foreignRunId, status: 'running', ownerSessionId: 'someone-else',
    scriptPath: saved.path, sourceRef: saved.sourceRef, argsRecorded: false, startedAt: '2026-10-01T00:00:00.000Z',
    dispatches: [], failures: [], tokens: { spent: 0 },
  });
  const refused = await h.startReducer(foreignRunId).catch((error) => error);
  assert.equal(refused.code, 'FORBIDDEN');
  assert.equal(refused.details.reason, 'run-not-owned');
  assert.equal(await countReducerWaiters(h.paths), 0, '被拒的补起不许占位');
});

test('reduce-3: 模型面零预算旋钮——reduce 里多一个键即拒（不存在可传的旋钮）', async () => {
  const h = harness({ holdRun: true });
  const started = await h.startRun();
  for (const knob of [{ loopMinutes: 1 }, { budgetMinutes: 5 }, { waitChunkSec: 30 }]) {
    const refused = await h.tools.get('subagent_start').invoke(
      { objective: 'reduce', reduce: { runId: started.runId, ...knob } },
      h.toolContext(),
    ).catch((error) => error);
    assert.equal(refused.code, 'EXTENSION_ERROR', `${JSON.stringify(knob)} 应被拒`);
    assert.equal(refused.details.reason, 'reduce-knobs');
  }
  assert.equal(await countReducerWaiters(h.paths), 0, '被拒的旋钮不该占位');
});

test('reduce-4: timeoutSec 由执行器推导——模型传入即拒（覆盖即拒）', async () => {
  const h = harness({ holdRun: true });
  const started = await h.startRun();
  const refused = await h.startReducer(started.runId, h.root.session, { timeoutSec: 60 }).catch((error) => error);
  assert.equal(refused.code, 'EXTENSION_ERROR');
  assert.equal(refused.details.reason, 'reduce-timeout-not-settable');
});

test('reduce-5: runId 形状闸先于任何路径拼接（.. 形态一律拒，不碰盘）', async () => {
  const h = harness();
  const refused = await h.startReducer('../../etc/passwd').catch((error) => error);
  assert.equal(refused.code, 'EXTENSION_ERROR');
  assert.equal(refused.details.reason, 'run-id-shape');
});

test('reduce-4b: runId 缺失即形状闸（汇总体场景 reduce 必填）', async () => {
  const h = harness();
  const refused = await h.tools.get('subagent_start').invoke(
    { objective: 'reduce', reduce: {} },
    h.toolContext(),
  ).catch((error) => error);
  assert.equal(refused.code, 'EXTENSION_ERROR');
  assert.equal(refused.details.reason, 'run-id-shape');
  assert.equal(await countReducerWaiters(h.paths), 0);
});

test('reduce-5b: 延续链认亲——换 sessionId 的接任会话仍在"本 root"名下（§3④）', async () => {
  const h = harness({ holdRun: true });
  const started = await h.startRun(h.root.session);
  // 会话结束（终态）后才能被接任——这正是"GPT 死亡后复活"的本地形态
  h.store.checkpoint(h.root.session.id, { phase: 'completed', summary: 'handoff to successor' });
  const successor = h.store.registerRoot({ name: 'gpt-successor', continuesSessionId: h.root.session.id });
  assert.equal(successor.session.continuesSessionId, h.root.session.id);
  const admitted = await h.startReducer(started.runId, successor.session);
  assert.equal(admitted.status, 'running', '接任会话补得起原会话名下的 run');

  // 无亲缘的另一个 root 仍被拒（归属闸在前，连等待位都不让它碰）
  const stranger = h.store.registerRoot({ name: 'stranger' });
  const refused = await h.startReducer(started.runId, stranger.session).catch((error) => error);
  assert.equal(refused.code, 'FORBIDDEN');
  assert.equal(refused.details.reason, 'run-not-owned');
});

test('reduce-6: 汇总体场景两道既有防线——subagent 通道调 workflow_start 与 subagent_start 都 FORBIDDEN', async () => {
  const h = harness();
  const child = h.store.registerDelegate(h.root.session.id, {
    name: 'delegated',
    task: { objective: 'o', background: 'b', deliverables: ['d'], acceptanceCriteria: ['a'], constraints: ['c'] },
  });
  const context = { transport: 'subagent', authenticatedSession: child.session };
  const fanOut = await h.tools.get('workflow_start').invoke({ script: INLINE_SCRIPT }, context).catch((error) => error);
  assert.equal(fanOut.code, 'FORBIDDEN');
  assert.equal(fanOut.details.reason, 'subagent-channel');
  const subSub = await h.tools.get('subagent_start').invoke({ objective: 'sub-sub' }, context).catch((error) => error);
  assert.equal(subSub.code, 'FORBIDDEN');
});

test('reduce-7: 记录期打标记——runId 落在汇总体记录上，非汇总体启动不受影响', async () => {
  const h = harness({ holdRun: true });
  const started = await h.startRun();
  const reducer = await h.startReducer(started.runId);
  const run = runPaths(h.paths, started.runId);
  assert.deepEqual(getSubagent(reducer.taskId).reduce, { runId: started.runId, digestPath: run.digestFile });
  const plain = await h.tools.get('subagent_start').invoke({ objective: 'ordinary' }, h.toolContext());
  assert.equal(getSubagent(plain.taskId).reduce, undefined);
  assert.equal(h.reducerAdmits.length, 1, '没有 reduce 就不走准入');
});

// ═══════════════════════════════════════════════════════════════
// 二、准入：同一 run 至多一个等待者；配额默认 3；超出 notice-only 降级
// ═══════════════════════════════════════════════════════════════

test('admit-1: 同一 run 已有等待者 → 拒补起；收场释放后同 runId 补得起来', async () => {
  const script = reducerModel((turn, seen) => (turn === 1 ? { name: 'wait_for_path', input: { path: seen.terminalPath, timeoutSec: 600 } } : { text: 'done' }));
  const h = harness({ holdRun: true, reducer: script });
  h.holdWait();
  const started = await h.startRun();
  const run = runPaths(h.paths, started.runId);
  script.seen.terminalPath = run.terminalFile;

  const first = await h.startReducer(started.runId);
  assert.equal(first.status, 'running');
  const holder = await readReducerWaiter(h.paths, started.runId);
  assert.equal(holder.agentId, first.taskId);
  assert.equal(holder.runId, started.runId);

  const second = await h.startReducer(started.runId).catch((error) => error);
  assert.equal(second.code, 'FORBIDDEN');
  assert.equal(second.details.reason, 'reducer-waiter-exists');

  // 第一个汇总体收场即释放：死亡不接管，同 runId 重跑从这里来
  await concludeReducer(h.paths, { runId: started.runId, agentId: first.taskId, digestPath: run.digestFile });
  assert.equal(await readReducerWaiter(h.paths, started.runId), undefined);
  const third = await h.startReducer(started.runId);
  assert.equal(third.status, 'running');
  assert.equal((await readReducerWaiter(h.paths, started.runId)).agentId, third.taskId);
});

test('admit-2: 配额默认 3——第 4 个走 notice-only 降级，不占位、不阻塞 run', async () => {
  const script = reducerModel((turn, seen) => (turn === 1 ? { name: 'wait_for_path', input: { path: seen.terminalPath, timeoutSec: 600 } } : { text: 'done' }));
  const h = harness({ gates: tightGates({ reducerQuota: 3 }), holdRun: true, reducer: script });
  h.holdWait();
  assert.equal(defaultWorkflowGates(8).reducerQuota, 3, '默认即 3，且经本机设置面可调');
  for (let i = 0; i < 3; i += 1) {
    const started = await h.startRun();
    script.seen.terminalPath = runPaths(h.paths, started.runId).terminalFile;
    const reducer = await h.startReducer(started.runId);
    assert.equal(reducer.status, 'running');
  }
  assert.equal(await countReducerWaiters(h.paths), 3);

  const extra = await h.startRun();
  const degraded = await h.startReducer(extra.runId);
  assert.equal(degraded.status, 'notice-only');
  assert.equal(degraded.reduce.reason, 'reducer-quota');
  assert.equal(degraded.taskId, null, '降级不起 subagent，也就没有 taskId');
  assert.equal(await countReducerWaiters(h.paths), 3, '被拒的补起不占第 4 槽');
  assert.ok(degraded.reduce.message.includes('run keeps going'), '降级告知要说清 run 不受影响');
  assert.equal(getSubagent(degraded.taskId), undefined, 'notice-only 不留半条记录');
});

test('admit-3: maxParallel 上限 4→10 生效（汇总体在池里的槽位余量）', () => {
  assert.equal(applySubagentDefaults({ maxParallel: 10 }).maxParallel, 10, '10 是新的合法上界');
  assert.equal(applySubagentDefaults({ maxParallel: 99 }).maxParallel, 10, '越顶压回 10');
});

test('admit-4: timeoutSec 与 budgetEndsAt 由汇总体预算推导，不经模型面', async () => {
  const h = harness({ holdRun: true });
  const started = await h.startRun();
  const before = h.clock.now();
  await h.startReducer(started.runId);
  const opts = h.executorStarts.at(-1);
  assert.equal(opts.settings.timeoutSec, Math.round(h.gates.reducerTimeoutMs / 1000), '硬兜底 = budget + slack');
  assert.equal(opts.budgetEndsAt, before + h.gates.reducerBudgetMs, '绝对末端 = 起时 + reducerBudget');
  assert.notEqual(opts.settings.timeoutSec, subSettings().timeoutSec, '不能用 subagent 默认超时顶替');
});

// ═══════════════════════════════════════════════════════════════
// 三、e2e 主链路
// ═══════════════════════════════════════════════════════════════

test('e2e-1: 等待零模型调用 → 结算 → ≤1 个轮询周期醒 → 摘要经既有管线交付 → 两视图一致', async () => {
  const script = reducerModel((turn, seen) => {
    if (turn === 1) return { name: 'wait_for_path', input: { path: seen.terminalPath, timeoutSec: 600 } };
    if (turn === 2) return { name: 'write_file', input: { path: seen.digestPath, content: '# digest\n结论 1/1 成功\n' } };
    return { text: `1/1 succeeded · ${seen.digestPath} · read the index` };
  });
  const h = harness({ holdRun: true, reducer: script });
  const started = await h.startRun();
  const run = runPaths(h.paths, started.runId);
  script.seen.terminalPath = run.terminalFile;
  script.seen.digestPath = run.digestFile;

  const driver = h.driveWait(6_000, { terminalFile: run.terminalFile });   // 第 3 个轮询周期放跑 run 的那一路
  const reducer = await h.startReducer(started.runId);
  await until(() => h.notified.length > 0, '摘要交付发生');
  const record = getSubagent(reducer.taskId);

  // 等待期零调用：标记出现前，汇总体只发过一次模型请求，run 那一路也只有一次
  const beforeRelease = driver.ticks.filter((tick) => !tick.released);
  assert.ok(beforeRelease.length >= 2, '至少有两次真实阻塞的轮询');
  for (const tick of beforeRelease) {
    assert.equal(tick.reducerCalls, 1, `等待期起了新回合：${JSON.stringify(tick)}`);
    assert.equal(tick.runCalls, 1, '等待期 run 那一路没有被重新派发');
  }
  assert.equal(script.seen.calls, 3, '回合数 = wait / write / 收文，等待期一次都不加');

  // 醒来不超过一个轮询周期：等待记账只比"结算发生时的等待量"多 ≤ 一个 poll
  const settledAt = driver.settledAt();
  const waitResult = jsonOf(toolResultOf(script, 2));
  assert.ok(settledAt !== undefined, '引擎没发 run_settled 事件');
  assert.equal(waitResult.state, 'ready', JSON.stringify(waitResult));
  assert.ok(
    waitResult.waitedSec * 1000 - driver.releasedWaitedMs() <= WAIT_FOR_PATH_POLL_MS,
    `醒得慢了：结算在等待 ${driver.releasedWaitedMs()}ms，ready 在 ${waitResult.waitedSec * 1000}ms`,
  );

  // 摘要交付：首行 KV = digest 文件字节哈希，正文 = 一句话 + 绝对路径 + 索引提醒
  const digestSha = crypto.createHash('sha256').update(fs.readFileSync(run.digestFile)).digest('hex');
  assert.equal(record.status, 'completed');
  assert.ok(record.result.startsWith(`[workflow] kind=digest runId=${started.runId} sha256=${digestSha}`), record.result);
  assert.ok(record.result.includes('1/1 succeeded'), '一句话（X/Y）在交付文本里');
  assert.ok(record.result.includes(run.digestFile), '绝对路径在交付文本里');
  assert.equal(h.checkpoints.at(-1).phase, 'completed', 'checkpoint 先落（既有管线第一步）');
  const delivered = h.notified.at(-1);
  assert.equal(delivered.parentId, h.root.session.id, '交付回发起会话');
  assert.ok(delivered.body.includes('subagent completed'), delivered.body);
  assert.ok(delivered.body.includes(`kind=digest runId=${started.runId} sha256=${digestSha}`), delivered.body);

  // 两视图一致：轮询读到的 result 就是收件箱那条消息的正文来源
  const polled = getSubagentRunner().status(reducer.taskId);
  assert.equal(polled.result, record.result);
  const polledAgain = getSubagentRunner().status(reducer.taskId);
  assert.deepEqual(polledAgain, polled, '轮询天然幂等：重复调用返回同结果');
  const inbox = h.store.inbox(h.root.session.id);
  assert.ok(inbox.some((message) => message.body.includes(`kind=digest runId=${started.runId} sha256=${digestSha}`)), '摘要在收件箱');
  assert.ok(inbox.some((message) => message.body.startsWith(`[workflow] kind=settled-notice runId=${started.runId}`)), '终态消息在收件箱');

  // 终态消息：≤200 码元、outbox 标 delivered、sha = 快照文件字节哈希
  const notice = h.deliverNotices[0];
  assert.ok(notice.body.length <= 200, `通知体 ${notice.body.length} 码元 > 200`);
  assert.equal(notice.sha256, crypto.createHash('sha256').update(fs.readFileSync(run.snapshotFile)).digest('hex'));
  const [item] = await readOutbox(run);
  assert.equal(item.delivered, true, '投递成功必须标 delivered');
  assert.equal(item.attempts, 1);
  assert.equal(item.body, notice.body);
});

test('e2e-2: 标记已在 → 立即醒（一次都不等），但交付仍需一个活着的回合', async () => {
  const script = reducerModel((turn, seen) => {
    if (turn === 1) return { name: 'wait_for_path', input: { path: seen.terminalPath, timeoutSec: 600 } };
    return { text: 'already settled, delivering' };
  });
  const h = harness({ reducer: script });
  const started = await h.startRun();
  const run = runPaths(h.paths, started.runId);
  await h.engine.settled(started.runId);
  fs.writeFileSync(run.digestFile, '摘要\n', 'utf8');
  script.seen.terminalPath = run.terminalFile;

  const sleeper = h.instantWait();
  const reducer = await h.startReducer(started.runId);
  await until(() => h.notified.length > 0, '交付发生');
  assert.equal(sleeper.sleeps(), 0, '标记已在 = 首探测即 ready，一次都不该等');
  assert.equal(script.seen.calls, 2, '"无等待" ≠ "即时交付"：交付仍要一个活着的回合');
  assert.equal(getSubagent(reducer.taskId).status, 'completed');
});

test('e2e-3: run 永不结算 → failed(wait-timeout) 三段报告，禁止 completed 掩盖', async () => {
  const script = reducerModel((turn, seen) => {
    if (turn === 1) return { name: 'wait_for_path', input: { path: seen.terminalPath, timeoutSec: 60 } };
    return { text: '我认为已经跑完了，收工' };   // 模型自称完成——盘面没标记就不是完成
  });
  const h = harness({ holdRun: true, reducer: script });
  const started = await h.startRun();
  const run = runPaths(h.paths, started.runId);
  script.seen.terminalPath = run.terminalFile;
  h.driveWait(undefined);   // 永不放跑那一路

  const reducer = await h.startReducer(started.runId);
  await until(() => h.notified.length > 0, '超时报告投递发生');
  const record = getSubagent(reducer.taskId);
  assert.equal(record.status, 'failed', '假完整红线：未结算不许记 completed');
  const lines = record.error.split('\n');
  assert.equal(lines.length, 3, `三段报告 = 结论 / 失败清单 / 路径 + 索引，实为 ${lines.length} 段`);
  assert.ok(lines[0].includes('未结算'), lines[0]);
  assert.ok(lines[2].includes('无摘要'), lines[2]);
  assert.ok(lines[1].includes(run.indexFile) || lines[2].includes(run.indexFile), '三段报告须给出索引去处');
  assert.ok(h.notified.at(-1).body.includes('subagent failed'), '超时报告同走 runner 自动投递（消息通道）');
  assert.ok(h.notified.at(-1).body.includes('未结算'), '消息与状态双通道都给同一份报告');
  assert.equal(await readReducerWaiter(h.paths, started.runId), undefined, '收场即释放等待位');
});

test('e2e-4: 重跑同 runId = 故意的重复来源——内容不同即不同 sha，终态消息仍只一条', async () => {
  const h = harness();
  const started = await h.startRun();
  const run = runPaths(h.paths, started.runId);
  await h.engine.settled(started.runId);

  fs.writeFileSync(run.digestFile, '第一版摘要\n', 'utf8');
  const first = await concludeReducer(h.paths, { runId: started.runId, agentId: 'sa_first', digestPath: run.digestFile });
  fs.writeFileSync(run.digestFile, '第二版摘要（重跑产出）\n', 'utf8');
  const second = await concludeReducer(h.paths, { runId: started.runId, agentId: 'sa_second', digestPath: run.digestFile });
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.notEqual(first.digestSha, second.digestSha, '内容变了 sha 必须变（去重键才有意义）');
  assert.equal(first.digestSha, crypto.createHash('sha256').update('第一版摘要\n', 'utf8').digest('hex'));

  // 终态消息一条且已投递：同 (runId, sha) 重投落同一文件，已投递的位不被抹回未投递
  const items = await readOutbox(run);
  assert.equal(items.length, 1);
  assert.equal(items[0].delivered, true);
  assert.equal(items[0].attempts, 1);
});

test('e2e-5: 结算三件套齐发——快照字节哈希即 settled-notice 的去重键', async () => {
  const h = harness();
  const started = await h.startRun();
  const run = runPaths(h.paths, started.runId);
  const index = await h.engine.settled(started.runId);
  assert.equal(index.status, 'completed');
  assert.equal(fs.existsSync(run.snapshotFile), true);
  assert.equal(fs.existsSync(run.terminalFile), true);
  assert.equal(h.deliverNotices.length, 1, '终态消息恰好一次');
  const body = h.deliverNotices[0].body;
  const lines = body.split('\n');
  assert.match(lines[0], /^\[workflow\] kind=settled-notice runId=wf_[0-9a-f]{16} sha256=[0-9a-f]{64}$/);
  assert.ok(lines[1].includes('completed'), '通知体必含 status');
  assert.ok(lines[1].includes('1/1'), '一句话读数（X/Y）');
  assert.equal(lines.length, 2, '通知体只是指针：首行 KV + 一行读数，失败清单不穿通知体');
  assert.ok(!/error=|label=/.test(body), '失败清单字段不许挤进通知体');
  assert.deepEqual(fs.readdirSync(run.outboxDir).filter((name) => name.endsWith('.tmp')), [], 'outbox 不留临时文件');
});

test('e2e-7: 先落盘再投递——崩在投递前一帧，outbox 留有未投递项（排空趟有活可干）', async () => {
  const h = harness({
    crash: (point) => { if (point === 'before-notice') throw new Error('simulated death at before-notice'); },
  });
  const started = await h.startRun();
  const run = runPaths(h.paths, started.runId);
  const rejected = await h.engine.settled(started.runId).catch((error) => error);
  assert.match(String(rejected), /simulated death at before-notice/);
  const items = await readOutbox(run);
  assert.equal(items.length, 1, '通知项必须先原子落盘——这一帧要能被排空趟补上');
  assert.equal(items[0].delivered, false);
  assert.equal(fs.existsSync(run.terminalFile), true, '终态标记已落：判据两半齐备');
  assert.equal(h.deliverNotices.length, 0, '崩在投出之前，一次都没投');
});

test('e2e-6: 投不出去时终态不动——项留在 outbox 未投递（排空趟的工作集）', async () => {
  const h = harness({ deliverFails: true });
  const started = await h.startRun();
  const run = runPaths(h.paths, started.runId);
  const index = await h.engine.settled(started.runId);
  assert.equal(index.status, 'completed', '投不出通知不许改判终态');
  assert.equal(h.deliverNotices.length, 0, '没投成功就不算投到');
  const items = await readOutbox(run);
  assert.equal(items.length, 1);
  assert.equal(items[0].delivered, false, '"有终态标记 + outbox 有未投递项"正是排空趟的判据');
  assert.equal(items[0].attempts, 0);
  assert.equal(fs.existsSync(run.terminalFile), true, '终态标记已在——另一半判据齐备');
});
