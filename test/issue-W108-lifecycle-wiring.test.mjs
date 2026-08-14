// ADR-0051 W1-08 (#81)：生命周期接线 — clearOperationCache / clearL3Quota / resetL3Adapter
//
// 0050 缺口 E1/E2/E3（#13/#14/#15）：三个清理原语已暴露但生产零调用（trace_path 确认唯一
// 调用方是测试）。本票接线：
//   E1 clearOperationCache → task 完成（completeBackgroundTask / failBackgroundTask）+
//      任务删除（trimBackgroundTasks 两处删除点）清理对应 taskId 缓存条目（Q8）
//   E2 clearL3Quota → session_release / session_unregister 成功 → 清该会话 L3 配额（D6 护栏3）
//   E3 resetL3Adapter → 运行时关闭（server.close → closeOnce）释放适配器单例（D8.2）
//
// 验收：
//   E1 grep src 生产调用方 ≥1；行为测试：task 完成后同 operation 再整形不命中旧缓存
//   E2 grep src 生产调用方 ≥1；行为测试：会话结束后该会话配额重置（L3 可再次调用）
//   E3 grep src 生产调用方 ≥1（server 关闭路径）；行为测试：close 后适配器单例被释放
//
// 测试方式：单测直驱 ExtensionService（E1/E2 行为）+ 真实 MyTerminalRuntime（E3 关闭路径）；
// L3 走 registry 注入 fake adapter（真模型不进自动化测试）。全部从 dist 导入。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExtensionService } from '../dist/extensions.js';
import { MyTerminalStore } from '../dist/store.js';
import { createBuiltinTools } from '../dist/core-tools.js';
import { MyTerminalRuntime } from '../dist/server.js';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter, getL3Adapter } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';

// PROBE：慢后台工具（不注册 TOOL_SHAPES → passthrough，保 fast-return/task_poll 响应原样）。
// PROBE_L3：只出现在测试直接构造的嵌套 operation 里（注册 schema → L3 可观测）。
const PROBE = 'w108_probe';
const PROBE_L3 = 'w108_probe_l3';
const SCHEMA = { type: 'object', properties: { name: { type: 'string' }, count: { type: 'number' } } };
const CONNECTOR_KEY = 'w108-connector-key-123456';
const ACTIONS_TOKEN = 'w108-actions-token-1234567890123456';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 计数 fake adapter：complete 每调一次 L3 计数 +1。 */
function injectFake() {
  let calls = 0;
  const adapter = {
    id: 'w108-fake', supportsStructuredOutput: true,
    isReady: async () => true,
    complete: async () => { calls += 1; return { object: { name: 'alice', count: 1 }, finishReason: 'stop', latencyMs: 1, modelId: 'w108-fake' }; },
  };
  registerAdapterFactory(() => adapter);
  return { adapter, getCalls: () => calls };
}

/** 直接驱动 shapeToolResponse 的上下文（与 issue-38 同构）。 */
function makeCtx(sessionId, transport = 'actions') {
  return { transport, sessionId, resolveTool: () => undefined, audit: () => {} };
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

/** 造带完整 builtins（含 session_release / session_unregister）+ 慢探测工具的 service。 */
function makeService(dirs, toolOverrides = {}) {
  const config = baseConfig(dirs, toolOverrides.config ?? {});
  const store = new MyTerminalStore(config.stateDir);
  const probeTool = {
    name: PROBE, title: PROBE, description: 'probe tool for W1-08',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    invoke: async () => { await sleep(toolOverrides.invokeDelayMs ?? 0); return { name: 'alice', count: 1 }; },
  };
  let lastAudit;
  const service = new ExtensionService(config, store, new Map([...createBuiltinTools(config, store), [probeTool.name, probeTool]]), (event) => { lastAudit = event; });
  return { service, store, lastAudit: () => lastAudit };
}

/** task_poll 响应（直接喂 shapeToolResponse）：result 带嵌套 operation（D13 递归入口）。 */
function pollRaw(taskId, status, operation) {
  return { ok: true, data: { tool: 'task_poll', result: { taskId, status, operation } } };
}

async function pollUntilCompleted(service, taskId, identity) {
  for (let i = 0; i < 40; i++) {
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
  TOOL_SHAPES.delete(PROBE_L3);
  delete process.env.MYTERMINAL_L3_MAX_PER_SESSION;
});

// ═════════════════════════════════════════════════════════════
// E1：clearOperationCache 接 task 完成 —— task 完成后同 operation 再整形不命中旧缓存
// ═════════════════════════════════════════════════════════════

test('W1-08-E1a: task 完成（completeBackgroundTask）→ 该 taskId 缓存条目被清理 — 完成后同 operation 再整形重跑 L3', async () => {
  const dirs = tempDirs('w108-e1a');
  try {
    const { service, store } = makeService(dirs, { invokeDelayMs: 350, config: { nonBlockingTasksEnabled: true } });
    const { getCalls } = injectFake();
    TOOL_SHAPES.set(PROBE_L3, { schema: SCHEMA });
    const created = store.registerRoot({ name: 'w108-e1a-root' });
    const sessionId = created.session.id;

    // 慢工具 → 200ms fast-return 分离成后台任务，返回 taskId
    const detach = await service.call({ tool: PROBE, input: {}, identity: created.identity }, { transport: 'actions' });
    assert.equal(detach.data.result.status, 'running', '慢调用应分离为后台任务');
    const taskId = detach.data.result.taskId;
    assert.ok(typeof taskId === 'string' && taskId.length > 0);

    // 预置该 taskId 的 Q8 缓存条目（L3 嵌套 operation 首次整形 → 写入缓存）
    const raw = pollRaw(taskId, 'running', { ok: true, data: { tool: PROBE_L3, result: { name: 'alice' } } });
    const ctx = makeCtx(sessionId);
    await shapeToolResponse(raw, ctx);
    assert.equal(getCalls(), 1, '首次整形走 L3（缓存写入）');
    await shapeToolResponse(raw, ctx);
    assert.equal(getCalls(), 1, 'Q8 缓存生效：同 operation 二次整形命中缓存、不重跑 L3');

    // 等任务完成 → completeBackgroundTask → clearOperationCache(taskId)
    await pollUntilCompleted(service, taskId, created.identity);

    // 完成后同 operation 再整形 → 不命中旧缓存（条目已被完成路径清理）→ 重跑 L3
    await shapeToolResponse(raw, ctx);
    assert.equal(getCalls(), 2, 'task 完成后旧缓存条目被清理：同 operation 再整形重跑 L3');
    // 接线后缓存仍正常：重跑后重新入缓存，再次整形命中
    await shapeToolResponse(raw, ctx);
    assert.equal(getCalls(), 2, '清理后重新入缓存：再次整形命中、不重跑 L3');
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('W1-08-E1b: 接线后真实轮询路径不受影响 — 同 task 连续 poll 结果一致', async () => {
  const dirs = tempDirs('w108-e1b');
  try {
    const { service, store } = makeService(dirs, { invokeDelayMs: 350, config: { nonBlockingTasksEnabled: true } });
    const created = store.registerRoot({ name: 'w108-e1b-root' });

    const detach = await service.call({ tool: PROBE, input: {}, identity: created.identity }, { transport: 'actions' });
    const taskId = detach.data.result.taskId;
    const completed = await pollUntilCompleted(service, taskId, created.identity);
    assert.equal(completed.data.result.status, 'completed');

    const again = await service.call({ tool: 'task_poll', input: { taskId }, identity: created.identity }, { transport: 'actions' });
    assert.equal(again.data.result.status, 'completed', '同 task 连续 poll 均 completed');
    assert.deepEqual(again.data.result.operation, completed.data.result.operation, '同 task 连续 poll 的嵌套 operation 内容一致');
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════
// E2：clearL3Quota 接会话结束 —— session_release / session_unregister 后配额重置
// ═════════════════════════════════════════════════════════════

test('W1-08-E2a: session_release 会话结束 → clearL3Quota — 配额 1/1 耗尽后 release→inherit，L3 可再次调用', async () => {
  process.env.MYTERMINAL_L3_MAX_PER_SESSION = '1'; // 配额压到 1 次，放大"重置"可观测性
  const dirs = tempDirs('w108-e2a');
  try {
    const { service, store, lastAudit } = makeService(dirs);
    const { getCalls } = injectFake();
    TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
    const created = store.registerRoot({ name: 'w108-e2a-root' });
    const sessionId = created.session.id;

    const first = await service.call({ tool: PROBE, input: {}, identity: created.identity }, { transport: 'actions' });
    assert.equal(first.ok, true);
    assert.equal(getCalls(), 1, '首次调用走 L3（配额 0→1）');
    assert.equal(lastAudit().shaping.applied, true);

    const second = await service.call({ tool: PROBE, input: {}, identity: created.identity }, { transport: 'actions' });
    assert.equal(second.ok, true, '配额超限 fail-open 不失败');
    assert.equal(getCalls(), 1, '配额 1/1 超限 → quota passthrough：不再调 L3');
    assert.equal(lastAudit().shaping.reason, 'quota');

    // 会话结束：session_release → 应清该会话 L3 配额
    const released = await service.call({ tool: 'session_release', input: {}, identity: created.identity }, { transport: 'actions' });
    assert.equal(released.ok, true);
    assert.ok(released.data.result.claimCode, 'release 签发一次性 claimCode');

    // 同会话交接（inherit 保持同一 session id，新控制器）→ 配额已重置 → L3 可再次调用
    const inherited = await service.call({ tool: 'session_inherit', input: { sessionId, claimCode: released.data.result.claimCode } }, { transport: 'actions' });
    assert.equal(inherited.ok, true);

    const third = await service.call({ tool: PROBE, input: {}, identity: inherited.data.result.identity }, { transport: 'actions' });
    assert.equal(third.ok, true);
    assert.equal(getCalls(), 2, '会话结束配额已重置：release 后同一会话 L3 可再次调用');
    assert.equal(lastAudit().shaping.applied, true);
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('W1-08-E2b: session_unregister 别名同样接线 — 会话结束后配额重置', async () => {
  process.env.MYTERMINAL_L3_MAX_PER_SESSION = '1';
  const dirs = tempDirs('w108-e2b');
  try {
    const { service, store } = makeService(dirs);
    const { getCalls } = injectFake();
    TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
    const created = store.registerRoot({ name: 'w108-e2b-root' });
    const sessionId = created.session.id;

    await service.call({ tool: PROBE, input: {}, identity: created.identity }, { transport: 'actions' });
    await service.call({ tool: PROBE, input: {}, identity: created.identity }, { transport: 'actions' });
    assert.equal(getCalls(), 1, '配额 1/1 耗尽：第二次调用已 passthrough');

    const unregistered = await service.call({ tool: 'session_unregister', input: {}, identity: created.identity }, { transport: 'actions' });
    assert.equal(unregistered.ok, true);
    assert.ok(unregistered.data.result.claimCode);

    const inherited = await service.call({ tool: 'session_inherit', input: { sessionId, claimCode: unregistered.data.result.claimCode } }, { transport: 'actions' });
    assert.equal(inherited.ok, true);
    await service.call({ tool: PROBE, input: {}, identity: inherited.data.result.identity }, { transport: 'actions' });
    assert.equal(getCalls(), 2, 'session_unregister 后配额重置：L3 可再次调用');
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════
// E3：resetL3Adapter 接运行时关闭 —— server.close 后适配器单例被释放
// ═════════════════════════════════════════════════════════════

test('W1-08-E3: 运行时关闭 → resetL3Adapter — close 后单例释放、新注入工厂在下一次懒加载生效', async () => {
  const dirs = tempDirs('w108-e3');
  try {
    let built = 0;
    const runtime = new MyTerminalRuntime(baseConfig(dirs, { actionsContinuationMode: 'off' }));
    const fake = (id) => ({ id, supportsStructuredOutput: true, isReady: async () => true, complete: async () => ({ object: null, finishReason: 'error', latencyMs: 0, modelId: id }) });
    registerAdapterFactory(() => { built += 1; return fake('w108-a'); });
    const first = getL3Adapter();
    assert.equal(built, 1, 'getL3Adapter 懒加载出首个实例');

    await runtime.start();
    await runtime.close();

    // 关闭后重新注入新工厂：若 resetL3Adapter 已释放单例，新工厂下一次懒加载即生效
    registerAdapterFactory(() => { built += 1; return fake('w108-b'); });
    const second = getL3Adapter();
    assert.notStrictEqual(second, first, 'server close 后适配器单例被释放：重新懒加载出新实例');
    assert.equal(built, 2, '释放后新工厂生效（D8.2 进程退出/会话结束释放）');
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});
