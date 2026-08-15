// ADR-0051 增补-01（#100）：runtime.close() 排空在飞后台任务
//
// 事实底座：#89 审查（91，REJECT）实测全量并行下 W1-08-E1a/E1b 稳定失败——
// ENOENT: history 目录不存在。机理：detach 后台任务的终态（status/completedAt）
// 在审计落盘之前就可被 task_poll 观察到（completeBackgroundTask 先置 status、
// 后 await applyShape → finishAudit → appendHistory）；观察方（测试/调用方）随后
// 删除 state 目录（或 close 后清理），在飞审计写入即 ENOENT。
//
// 本票验收（机械可验证）：
//   1. close 排空：close 返回时所有在飞后台任务已终态、审计已落盘（无 close 后写）
//   2. 全量回归并行跑 W1-08-E1a/E1b 连续 2 次全绿（原 ENOENT 根因消除）
//   3. 超时上限：close 排空等待设上限（如 5s），超限强制收尾不阻塞关闭
//   4. 现有 close 语义回归：所有 close 相关测试保持绿
//
// 测试方式：单测直驱 ExtensionService；慢 L3 fake 放大 completeBackgroundTask 的
// applyShape 窗口，让"终态可观测但审计未落"的竞态可确定性断言。全部从 dist 导入。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExtensionService } from '../dist/extensions.js';
import { MyTerminalStore } from '../dist/store.js';
import { createBuiltinTools } from '../dist/core-tools.js';
import { TOOL_SHAPES } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';

const PROBE = 'issue100_probe';
const SCHEMA = { type: 'object', properties: { name: { type: 'string' } } };
const CONNECTOR_KEY = 'issue100-connector-key-123456';
const ACTIONS_TOKEN = 'issue100-actions-token-1234567890123456';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 慢 L3 fake：complete 睡眠 completeDelayMs，放大 applyShape 窗口（默认 300ms）。 */
function injectSlowFake(completeDelayMs = 300) {
  const adapter = {
    id: 'issue100-slow', supportsStructuredOutput: true,
    isReady: async () => true,
    complete: async () => { await sleep(completeDelayMs); return { object: { name: 'alice' }, finishReason: 'stop', latencyMs: completeDelayMs, modelId: 'issue100-slow' }; },
  };
  registerAdapterFactory(() => adapter);
  return adapter;
}

function tempDirs(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `myterminal-${tag}-`));
  const workspaceDir = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, workspaceDir, stateDir };
}

function baseConfig(dirs, overrides = {}) {
  return {
    workspaceDir: dirs.workspaceDir, stateDir: dirs.stateDir, settingsPath: path.join(dirs.stateDir, 'settings.json'),
    host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN,
    publicBaseUrl: 'http://127.0.0.1:0', maxOutputChars: 20_000, commandTimeoutSec: 10,
    uiLanguage: 'en', uiTheme: 'dark', passiveLockEnabled: false,
    actionsContinuationMode: 'adaptive', nonBlockingTasksEnabled: false,
    ...overrides,
  };
}

/** 造带慢探测工具（invoke 睡眠 invokeDelayMs）+ 审计事件收集的 service。 */
function makeService(dirs, toolOverrides = {}) {
  const config = baseConfig(dirs, toolOverrides.config ?? {});
  const store = new MyTerminalStore(config.stateDir);
  const events = [];
  const probeTool = {
    name: PROBE, title: PROBE, description: 'slow probe tool for issue-100',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    invoke: async () => { await sleep(toolOverrides.invokeDelayMs ?? 0); return { name: 'alice' }; },
  };
  const service = new ExtensionService(config, store, new Map([...createBuiltinTools(config, store), [probeTool.name, probeTool]]), (event) => { events.push(event); });
  return { service, store, events };
}

const auditEventsFor = (events, actionId) => events.filter((event) => event.id === actionId);

async function pollUntilCompleted(service, taskId, identity) {
  for (let i = 0; i < 80; i++) {
    const poll = await service.call({ tool: 'task_poll', input: { taskId }, identity }, { transport: 'actions' });
    if (poll.data.result.status === 'completed') return poll;
    await sleep(50);
  }
  throw new Error('background task did not complete in time');
}

afterEach(() => {
  resetL3Adapter();
  clearL3Quota();
  TOOL_SHAPES.delete(PROBE);
});

// ═════════════════════════════════════════════════════════════
// 验收 1/2：审计先于终态可观测 —— task_poll 观察到终态 ⟹ 审计已落盘
// ═════════════════════════════════════════════════════════════

test('issue-100-01a: 后台任务终态可观测时审计已落盘 — 观察后无任何后续审计写入', async () => {
  const dirs = tempDirs('issue100-01a');
  try {
    const { service, store, events } = makeService(dirs, { invokeDelayMs: 350, config: { nonBlockingTasksEnabled: true } });
    injectSlowFake(300);
    TOOL_SHAPES.set(PROBE, { schema: SCHEMA }); // 完成路径 applyShape 走慢 L3，放大"终态已置、审计未落"窗口
    const created = store.registerRoot({ name: 'issue100-01a-root' });

    const detach = await service.call({ tool: PROBE, input: {}, identity: created.identity }, { transport: 'actions' });
    assert.equal(detach.data.result.status, 'running', '慢调用应分离为后台任务');
    const taskId = detach.data.result.taskId;

    const completed = await pollUntilCompleted(service, taskId, created.identity);
    assert.equal(completed.data.result.status, 'completed');

    // 第一次观察到终态时：该 action 的审计链必须已经是 running + completed 两条（落盘完成）
    const terminalEvents = auditEventsFor(events, taskId);
    assert.equal(terminalEvents.length, 2, `观察到终态时审计应已落盘，实际事件: ${JSON.stringify(terminalEvents.map((e) => e.status))}`);
    assert.equal(terminalEvents.at(-1).status, 'completed', '终态可观测时最后一条审计应为 completed');

    // 观察后再等 400ms（覆盖慢 applyShape 窗口）：不得出现任何后置审计写入
    await sleep(400);
    assert.equal(auditEventsFor(events, taskId).length, 2, '终态可观测后不得再有审计写入');
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════
// 验收 1/3：close 排空 —— shutdown 返回前在飞任务自然终态、审计落盘
// ═════════════════════════════════════════════════════════════

test('issue-100-01b: close 排空 — shutdown 返回时在飞后台任务已自然终态且审计落盘（无 close 后写）', async () => {
  const dirs = tempDirs('issue100-01b');
  try {
    const { service, store, events } = makeService(dirs, { invokeDelayMs: 350, config: { nonBlockingTasksEnabled: true } });
    injectSlowFake(300);
    TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
    const created = store.registerRoot({ name: 'issue100-01b-root' });

    const detach = await service.call({ tool: PROBE, input: {}, identity: created.identity }, { transport: 'actions' });
    const taskId = detach.data.result.taskId;

    // 不 poll，直接在任务仍 'running'（operation 350ms + L3 300ms 均在途）时 close
    await service.shutdown(1_000);

    // shutdown 返回时：审计链应为 running + completed（自然终态，而非超限强制 failed）
    const terminalEvents = auditEventsFor(events, taskId);
    assert.equal(terminalEvents.length, 2, `close 返回时审计应已落盘，实际事件: ${JSON.stringify(terminalEvents.map((e) => e.status))}`);
    assert.equal(terminalEvents.at(-1).status, 'completed', 'close 排空应等到自然终态 completed，而非强制 failed');

    // close 后不得再有写入（close 后写 = ENOENT 竞态面）
    await sleep(400);
    assert.equal(auditEventsFor(events, taskId).length, 2, 'close 返回后不得再有审计写入');
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════
// 验收 3：超限强制收尾 —— 挂死任务不阻塞 close（上限护栏，回归性）
// ═════════════════════════════════════════════════════════════

test('issue-100-01c: 排空超限强制收尾 — 永不落定的后台任务不阻塞 close（5s 上限护栏）', async () => {
  const dirs = tempDirs('issue100-01c');
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  try {
    const config = baseConfig(dirs, { nonBlockingTasksEnabled: true });
    const store = new MyTerminalStore(config.stateDir);
    const events = [];
    const probeTool = {
      name: PROBE, title: PROBE, description: 'hung probe tool for issue-100',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      invoke: async () => { await gate; return { name: 'alice' }; },
    };
    const service = new ExtensionService(config, store, new Map([...createBuiltinTools(config, store), [probeTool.name, probeTool]]), (event) => { events.push(event); });
    const created = store.registerRoot({ name: 'issue100-01c-root' });

    const detach = await service.call({ tool: PROBE, input: {}, identity: created.identity }, { transport: 'actions' });
    const taskId = detach.data.result.taskId;

    // 任务挂死在 gate 上（operation 永不落定、settler 永不启动）→ close 不得被阻塞
    const started = performance.now();
    await service.shutdown(100);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2_000, `close 不应被挂死任务阻塞（实际 ${Math.round(elapsed)}ms）`);

    // 超限强制收尾：该 action 以 failed 终态审计落盘
    const terminalEvents = auditEventsFor(events, taskId);
    assert.equal(terminalEvents.at(-1).status, 'failed', '超限后应强制收尾（failed 审计落盘）');
  } finally {
    releaseGate();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});
