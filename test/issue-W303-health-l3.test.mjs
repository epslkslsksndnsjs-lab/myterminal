// ADR-0051 W3-03 (#95)：L3 就绪可见性三通道（0051 D-8）——/health l3 字段 + TUI 状态页 + 启动日志三态；对模型静默（D-9）
//
// D-8 验收断言：
//   AC1  /health 含 l3 字段：status ∈ {ready,loading,missing,failed} + modelId + warmLatencyMs（ready 时）；
//        L3 关闭（env=false）→ 无 l3 字段（无状态可报，不冒充 missing）
//   AC2  TUI 状态页展示 L3 状态（presenter 抽取自 Settings 屏，issue-89 同款纯函数模式）
//   AC3  启动日志三态：预热成功（既有）/ 模型缺失提示（指向 fetch 命令）/ 预热失败（既有）
//   AC4  模型侧零泄漏：工具结果无 l3 状态字段（D-9 静默边界——l3 只进 /health/TUI/日志）
//   AC5  运行时探测：fake adapter 注入下 /health 从 loading → ready 迁移正确
//
// 测试方式：真实 MyTerminalRuntime（port 0 standalone，/health 真实 HTTP 探测）+
// startL3Warmup 单测（fake adapter 注入，退避可注入 [5,10,15]ms）。全部从 dist 导入；
// 真模型（~1.3GB GGUF）不进自动化测试。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MyTerminalRuntime } from '../dist/server.js';
import { l3Health, resetL3Health, resetL3Warmup, startL3Warmup } from '../dist/l3/warmup.js';
import { registerAdapterFactory, resetL3Adapter, resetL3AdapterInstance } from '../dist/l3/registry.js';

// 本文件依赖预热默认开（loading→ready 迁移）；防御上游 env 泄漏（bun 共享 worker 下
// 其他文件设的 MYTERMINAL_L3_WARMUP=false 会继承到本文件，导致预热 no-op、AC1/AC5 挂死）。
delete process.env.MYTERMINAL_L3_WARMUP;
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import { l3StatusView } from '../dist/tui/screens/Settings.js';

const PROBE = 't95_l3_silence_probe';
const SCHEMA = { type: 'object', properties: { name: { type: 'string' } } };
/** 双条目 L1 侧：打标 l1:'ran'，证明 L3 路径产物（D-4 兜底）正常回落。 */
const dualReduce = (r) => ({ ...r, l1: 'ran' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SAVED_L3_ENABLED = process.env.MYTERMINAL_L3_ENABLED;
const SAVED_L3_MODEL_PATH = process.env.MYTERMINAL_L3_MODEL_PATH;

/** 可控 deferred（gated fake 用）：resolve 前 isReady 永远挂起（W2-08 同款）。 */
function makeDeferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, release() { resolve(); } };
}

/** 计数/门控 fake adapter（W2-08 同款：真模型不进测试）。 */
function injectFake({ gate, ready = true, id = 'w303-fake' } = {}) {
  resetL3Adapter(); // 清旧单例，让本次 factory 在下次懒加载生效
  const adapter = {
    id, supportsStructuredOutput: true,
    isReady: async () => { if (gate) await gate.promise; return ready; },
    complete: async () => ({ object: { ok: true }, finishReason: 'stop', latencyMs: 1, modelId: id }),
  };
  registerAdapterFactory(() => adapter);
  return { adapter };
}

/** 记录 log 调用的 logger（AC3 断言日志三态）。 */
function makeLogRecorder() {
  const entries = [];
  const log = (message, level = 'info') => entries.push({ message, level });
  return { log, entries };
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
    host: '127.0.0.1', port: 0, connectorKey: 'w303-connector-key-123456', actionsToken: 'w303-actions-token-1234567890123456',
    publicBaseUrl: 'http://127.0.0.1:0', maxOutputChars: 20_000, commandTimeoutSec: 10,
    uiLanguage: 'en', uiTheme: 'dark', passiveLockEnabled: false,
    actionsContinuationMode: 'off', nonBlockingTasksEnabled: false,
    ...overrides,
  };
}

async function pollUntil(fn, what, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function pollUntilAsync(fn, what, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** 真实 HTTP /health（standalone active 恒 200）。 */
async function fetchHealth(runtime) {
  const res = await fetch(`http://127.0.0.1:${runtime.port}/health`);
  assert.equal(res.status, 200, 'standalone active 的 /health 应为 200');
  return res.json();
}

afterEach(() => {
  resetL3Warmup();
  resetL3Health();
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）
  TOOL_SHAPES.delete(PROBE);
  if (SAVED_L3_ENABLED === undefined) delete process.env.MYTERMINAL_L3_ENABLED;
  else process.env.MYTERMINAL_L3_ENABLED = SAVED_L3_ENABLED;
  if (SAVED_L3_MODEL_PATH === undefined) delete process.env.MYTERMINAL_L3_MODEL_PATH;
  else process.env.MYTERMINAL_L3_MODEL_PATH = SAVED_L3_MODEL_PATH;
});

// ───────────────────────────────────────────────────────────
// AC1 + AC5：/health l3 字段形状 + loading → ready 运行时迁移（fake adapter）
// ───────────────────────────────────────────────────────────

test('W3-03-AC1+AC5: /health l3 从 loading → ready（fake adapter + gated isReady 端到端）', async () => {
  const gate = makeDeferred();
  injectFake({ gate, id: 'w303-fake' });
  const dirs = tempDirs('w303-ac1');
  const runtime = new MyTerminalRuntime(baseConfig(dirs));
  try {
    await runtime.start();
    // 预热挂起在 gate 上 → 状态必须同步进入 loading（start 不等待，W2-08 语义）
    const loading = await fetchHealth(runtime);
    assert.equal(loading.l3.status, 'loading', '预热未完成 → loading');
    assert.equal(loading.l3.modelId, 'w303-fake', 'modelId 来自 adapter');
    assert.equal('warmLatencyMs' in loading.l3, false, '非 ready 不带 warmLatencyMs');
    assert.ok(!runtime.logs.some((l) => l.message.includes('L3 warmup ready')), '预热未完成 → 无成功日志');

    gate.release();
    await pollUntilAsync(async () => (await fetchHealth(runtime)).l3.status === 'ready', 'l3 ready');
    const ready = await fetchHealth(runtime);
    assert.equal(ready.l3.status, 'ready', '迁移：loading → ready');
    assert.equal(ready.l3.modelId, 'w303-fake');
    assert.equal(typeof ready.l3.warmLatencyMs, 'number', 'ready 带 warmLatencyMs');
    assert.ok(ready.l3.warmLatencyMs >= 0);
    assert.ok(runtime.logs.some((l) => l.message.includes('L3 warmup ready')), '启动日志：预热成功（通道3 三态之一）');
  } finally {
    await runtime.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('W3-03-AC1: 模型缺失（真 adapter 路径 + 文件不存在）→ /health l3=missing + 启动日志指向 fetch', async () => {
  const dirs = tempDirs('w303-missing');
  process.env.MYTERMINAL_L3_MODEL_PATH = path.join(dirs.root, 'no-such-model.gguf');
  const runtime = new MyTerminalRuntime(baseConfig(dirs));
  try {
    await runtime.start();
    await pollUntilAsync(() => Promise.resolve(runtime.logs.some((l) => l.message.includes('myterminal l3-model fetch'))), 'fetch 提示日志');
    const h = await fetchHealth(runtime);
    assert.equal(h.l3.status, 'missing', '模型文件不存在 → missing');
    assert.equal(h.l3.modelId, 'qwen3.5-2b', '真 adapter 的 id');
    assert.equal('warmLatencyMs' in h.l3, false, 'missing 不带 warmLatencyMs');
    assert.ok(!runtime.logs.some((l) => l.message.includes('L3 warmup ready')), '缺失 → 不预热（不空转退避）');
  } finally {
    await runtime.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('W3-03-AC1: 预热全失败（fake isReady=false）→ l3=loading→failed + 失败日志', async () => {
  const { log, entries } = makeLogRecorder();
  injectFake({ ready: false, id: 'w303-fail' });
  startL3Warmup(log, [5, 10, 15]);
  assert.equal(l3Health()?.status, 'loading', '预热开始时同步进入 loading');
  await pollUntil(() => l3Health()?.status === 'failed', 'l3 failed');
  assert.equal(l3Health()?.modelId, 'w303-fail');
  assert.ok(entries.some((e) => e.message.includes('L3 warmup failed')), '启动日志：预热失败（通道3 三态之三）');
});

test('W3-03-AC1: L3 关闭（env=false）→ /health 无 l3 字段（无状态可报，不冒充 missing）', async () => {
  process.env.MYTERMINAL_L3_ENABLED = 'false';
  const dirs = tempDirs('w303-off');
  const runtime = new MyTerminalRuntime(baseConfig(dirs));
  try {
    await runtime.start();
    const h = await fetchHealth(runtime);
    assert.equal('l3' in h, false, 'L3 关闭 → 不暴露 l3 字段');
  } finally {
    await runtime.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────
// AC2：TUI 状态页展示 L3 状态（presenter 纯函数，issue-89 同款模式）
// ───────────────────────────────────────────────────────────

test('W3-03-AC2: TUI 状态页 presenter 各状态展示（ready/loading/missing/failed/未启用）', () => {
  const t = (en, zh) => zh; // 回退中文文案
  // 未启用（L3 关闭）
  assert.deepEqual(l3StatusView(undefined, t), [{ text: 'L3 模型：未启用', tone: 'muted' }], '未启用 → 单行 muted');
  // ready：状态 + 模型 + 预热耗时
  const ready = l3StatusView({ status: 'ready', modelId: 'w303-fake', warmLatencyMs: 123 }, t);
  assert.deepEqual(ready, [
    { text: '状态: 就绪', tone: 'good' },
    { text: '模型: w303-fake', tone: 'text' },
    { text: '预热: 123ms', tone: 'text' },
  ], 'ready → 三行（状态/模型/预热耗时）');
  // loading
  const loading = l3StatusView({ status: 'loading', modelId: 'w303-fake' }, t);
  assert.ok(loading.some((l) => l.text === '状态: 预热中'), 'loading → 预热中');
  assert.equal(loading.some((l) => l.text.includes('warmLatencyMs')), false, 'loading 不显示预热耗时');
  // missing → 指向 fetch 命令（D-7）
  const missing = l3StatusView({ status: 'missing', modelId: 'qwen3.5-2b' }, t);
  assert.ok(missing.some((l) => l.text.includes('myterminal l3-model fetch') && l.tone === 'warn'), 'missing → warn 提示指向 fetch');
  // failed
  const failed = l3StatusView({ status: 'failed', modelId: 'w303-fail' }, t);
  assert.ok(failed.some((l) => l.text === '状态: 预热失败' && l.tone === 'bad'), 'failed → bad 状态行');
});

// ───────────────────────────────────────────────────────────
// AC4：模型侧零泄漏（D-9 静默边界）——l3 状态字段只进 /health/TUI/日志
// ───────────────────────────────────────────────────────────

test('W3-03-AC4: 工具结果零泄漏 — 形状化产物无 l3/warmLatencyMs/modelId 字段（D-9）', async () => {
  injectFake({ ready: false, id: 'w303-fail' }); // L3 失败路径快速 fail-open（真模型不进测试）
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  const ctx = { transport: 'actions', sessionId: 's-w303', resolveTool: () => undefined, audit: () => undefined };
  const shaped = await shapeToolResponse({ ok: true, data: { tool: PROBE, result: { name: 'alice' } } }, ctx);
  assert.doesNotMatch(JSON.stringify(shaped), /"l3"|"warmLatencyMs"|"modelId"/, '工具结果（模型可见上下文）不得含 l3 状态字段');
  assert.deepEqual(shaped.data.result, { name: 'alice', l1: 'ran' }, '既有双条目兜底语义不变（D-4）');
});
