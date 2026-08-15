// ADR-0051 W2-08 (#91)：L3 异步预热 + smoke probe（0050 G1 翻转必修 + 0051 D-6）
//
// D-6 验收断言：
//   AC1  server.start 不等待预热：启动耗时不受 L3 影响——start 完成时预热尚未完成
//        （gated fake：isReady 挂起 → start 返回 → 断言 probe 未跑、isReady 已触发）
//   AC2  smoke probe：dummy complete 断言可解析；失败 → 有限退避重试（WARMUP_MAX_RETRIES=3，
//        总尝试 = 1+3 = 4）；全失败仅记日志（不抛错不阻断）；退避后重试成功路径
//   AC3  standalone 预热开（server.start 触发）；cluster 参与者默认关；env MYTERMINAL_L3_ENABLED
//        优先（false 关 / true 开，均高于模式默认）
//   AC4  热路径零新闸门：预热全失败后首个真实 L3 调用仍走既有 isReady/失败矩阵 fail-open
//        （回落 L1，reason=l3-unavailable，无新增 reason/阻塞；isReady 恰好只多跑矩阵自身 1 次）
//   AC5  预热成功路径：完成后 isReady()===true（fake 断言）+ 单例复用——registry 单例即预热
//        所用实例，后续真实调用继续复用它（complete 计数连续、不重建）
//
// 测试方式：单测直驱 startL3Warmup（dist/l3/warmup.js，fake adapter 注入，退避可注入
// [5,10,15]ms 避免真实等待）+ 真实 MyTerminalRuntime（AC1/AC3c 端到端，port 0 standalone）。
// 全部从 dist 导入；真模型（~1.3GB GGUF）不进自动化测试。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MyTerminalRuntime } from '../dist/server.js';
import { startL3Warmup, resetL3Warmup, WARMUP_MAX_RETRIES, l3Health } from '../dist/l3/warmup.js';
import {
  registerAdapterFactory, resetL3Adapter, resetL3AdapterInstance, getL3Adapter,
  setL3ClusterMode, resetL3ClusterMode,
} from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';

// #101：防御上游 env 泄漏——bun 共享 worker 下其他文件设置的 MYTERMINAL_L3_WARMUP=false
// 会继承到本文件，导致预热 no-op、本文件全部 timeout（全量必现）。本文件依赖预热默认开。
delete process.env.MYTERMINAL_L3_WARMUP;
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';

const PROBE = 't91_dual_probe';
const SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, count: { type: 'number' } },
};
/** 双条目 L1 侧：打标 l1:'ran'，证明 L3 失败后回落 L1（D-4 兜底）。 */
const dualReduce = (r) => ({ ...r, l1: 'ran' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SAVED_L3_ENABLED = process.env.MYTERMINAL_L3_ENABLED;

/** 可控 deferred（gated fake 用）：resolve 前 isReady 永远挂起。 */
function makeDeferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, released: false, release() { this.released = true; resolve(); } };
}

/**
 * 计数 fake adapter：isReady / complete 精确计数（AC 断言全靠这两个计数）。
 *  - gate：isReady 挂起在 deferred 上（AC1/AC3c 用；undefined 则立即返回 ready）
 *  - ready=false：isReady → false（AC4：冷加载失败语义 → 失败矩阵 l3-unavailable）
 *  - object=null / finishReason='error'：probe 失败（AC2a：退避重试）
 *  - failThenSucceed：complete 首次失败、此后成功（AC2b：退避后重试成功）
 */
function injectFake({ gate, ready = true, object = { ok: true }, finishReason = 'stop', failThenSucceed = false } = {}) {
  resetL3Adapter(); // 清旧单例，让本次 factory 在下次懒加载生效（单例常驻语义）
  let completeCalls = 0;
  let isReadyCalls = 0;
  const adapter = {
    id: 'w208-fake', supportsStructuredOutput: true,
    isReady: async () => {
      isReadyCalls += 1;
      if (gate) await gate.promise;
      return ready;
    },
    complete: async () => {
      completeCalls += 1;
      if (failThenSucceed && completeCalls === 1) {
        return { object: null, finishReason: 'error', latencyMs: 1, modelId: 'w208-fake' };
      }
      return { object, finishReason, latencyMs: 1, modelId: 'w208-fake' };
    },
  };
  registerAdapterFactory(() => adapter);
  return { adapter, completeCalls: () => completeCalls, isReadyCalls: () => isReadyCalls };
}

/** 记录 log 调用的 logger（AC2/AC3 断言"仅记日志"）。 */
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
    host: '127.0.0.1', port: 0, connectorKey: 'w208-connector-key-123456', actionsToken: 'w208-actions-token-1234567890123456',
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

function makeCtx(sessionId = 's-w208', transport = 'actions') {
  let record;
  const ctx = {
    transport,
    sessionId,
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

afterEach(() => {
  resetL3Warmup();
  resetL3ClusterMode();
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）
  clearL3Quota();
  TOOL_SHAPES.delete(PROBE);
  if (SAVED_L3_ENABLED === undefined) delete process.env.MYTERMINAL_L3_ENABLED;
  else process.env.MYTERMINAL_L3_ENABLED = SAVED_L3_ENABLED;
});

// ───────────────────────────────────────────────────────────
// AC1：server.start 不等待预热（standalone 异步触发，不 await）
// ───────────────────────────────────────────────────────────

test('W2-08-AC1: server.start 不等待预热 — start 返回时预热仍挂起，释放后完成（真实 runtime 端到端）', async () => {
  const gate = makeDeferred();
  const { isReadyCalls } = injectFake({ gate });
  const dirs = tempDirs('w208-ac1');
  const runtime = new MyTerminalRuntime(baseConfig(dirs));
  try {
    await runtime.start(); // 若 start 等待预热 → 挂死在 gated isReady 上（bun test 超时暴露）
    assert.equal(isReadyCalls(), 1, 'start 已返回：预热已异步触发（isReady 进入挂起）');
    assert.equal(gate.released, false, 'start 返回时预热未完成（不等待）');
    assert.ok(!runtime.logs.some((l) => l.message.includes('L3 warmup ready')), '预热未完成 → 无成功日志');

    // 释放 gated isReady → 预热继续 → probe 通过 → 成功日志落 runtime.logs
    gate.release();
    await pollUntil(() => runtime.logs.some((l) => l.message.includes('L3 warmup ready')), 'warmup success log');
  } finally {
    await runtime.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────
// AC2：smoke probe — 失败有限退避 3 次、全失败仅记日志、退避后重试成功
// ───────────────────────────────────────────────────────────

test('W2-08-AC2a: smoke probe 全失败 → 有限退避（1+3 次尝试）→ 仅记日志不抛错', async () => {
  assert.equal(WARMUP_MAX_RETRIES, 3, 'D-6「失败有限退避 3 次」常量');
  const { log, entries } = makeLogRecorder();
  const { adapter, completeCalls, isReadyCalls } = injectFake({ object: null, finishReason: 'error' }); // probe 恒败

  assert.doesNotThrow(() => startL3Warmup(log, [5, 10, 15]));
  await pollUntil(() => completeCalls() === WARMUP_MAX_RETRIES + 1, '4 次 probe 尝试（1 初始 + 3 退避重试）');
  await sleep(30); // 给循环收尾（记日志）一点余量

  assert.equal(completeCalls(), WARMUP_MAX_RETRIES + 1, '全失败恰好 1+3 次，不无限重试');
  assert.equal(isReadyCalls(), WARMUP_MAX_RETRIES + 1, '每轮先 isReady 再 probe（isReady 同 4 次）');
  const failures = entries.filter((e) => e.level === 'error' && e.message.includes('L3 warmup failed'));
  assert.equal(failures.length, 1, '全失败仅记一条日志（不抛错不阻断）');
  assert.ok(entries.every((e) => !e.message.includes('L3 warmup ready')), '无成功日志');
  assert.strictEqual(adapter.id, 'w208-fake', '预热所用实例为注入 fake（真模型不进测试）');
});

test('W2-08-AC2b: probe 首次失败 → 退避重试 → 成功（有限退避后正常完成）', async () => {
  const { log, entries } = makeLogRecorder();
  const { completeCalls } = injectFake({ failThenSucceed: true, object: { ok: true } });

  startL3Warmup(log, [5, 10, 15]);
  await pollUntil(() => entries.some((e) => e.message.includes('L3 warmup ready')), '重试后成功日志');

  assert.equal(completeCalls(), 2, '首败 1 次 + 退避重试成功 1 次，不浪费到第 3 次重试');
  assert.ok(entries.some((e) => e.level === 'info' && e.message.includes('L3 warmup ready')), '成功路径记 info 日志');
  assert.ok(entries.every((e) => !e.message.includes('L3 warmup failed')), '重试成功 → 无失败日志');
});

// ───────────────────────────────────────────────────────────
// AC3：standalone 预热开；cluster 参与者默认关；env 优先
// ───────────────────────────────────────────────────────────

test('W2-08-AC3a: cluster 参与者默认关（env 未设置）→ 预热完全不触发（isReady 0 次）', async () => {
  setL3ClusterMode(true); // 参与者层面 gate（D18.2）：clusterDefault=false
  const { log } = makeLogRecorder();
  const { isReadyCalls } = injectFake({ ready: false });

  startL3Warmup(log);
  await sleep(50);
  assert.equal(isReadyCalls(), 0, 'cluster 参与者默认关：预热 no-op，绝不碰 adapter');
});

test('W2-08-AC3b: env MYTERMINAL_L3_ENABLED 优先 — false 关（standalone 下） / true 开（cluster 下）', async () => {
  // env=false 压过 standalone 默认开 → 不预热
  process.env.MYTERMINAL_L3_ENABLED = 'false';
  const { log, entries } = makeLogRecorder();
  const { isReadyCalls } = injectFake({ ready: false });
  startL3Warmup(log, [5, 10, 15]);
  await sleep(50);
  assert.equal(isReadyCalls(), 0, 'env=false → 预热 no-op（standalone 默认开也被压过）');

  // env=true 压过 cluster 默认关 → 预热跑（isReady 4 次退避循环为证）
  process.env.MYTERMINAL_L3_ENABLED = 'true';
  setL3ClusterMode(true);
  const log2 = makeLogRecorder();
  const { completeCalls } = injectFake({ object: null, finishReason: 'error' });
  startL3Warmup(log2.log, [5, 10, 15]);
  await pollUntil(() => completeCalls() === WARMUP_MAX_RETRIES + 1, 'env=true 时 cluster 下预热仍执行（4 次尝试）');
});

test('W2-08-AC3c: standalone runtime.start 触发预热（真实 runtime 端到端）', async () => {
  const gate = makeDeferred();
  const { isReadyCalls } = injectFake({ gate });
  const dirs = tempDirs('w208-ac3c');
  const runtime = new MyTerminalRuntime(baseConfig(dirs));
  try {
    await runtime.start();
    assert.equal(isReadyCalls(), 1, 'standalone start 已异步触发预热（isReady 挂起在 gate 上）');
    gate.release();
    await pollUntil(() => runtime.logs.some((l) => l.message.includes('L3 warmup ready')), 'standalone 预热成功日志');
  } finally {
    await runtime.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────
// AC4：热路径零新闸门 — 预热全失败后首个真实 L3 调用照旧走失败矩阵 fail-open
// ───────────────────────────────────────────────────────────

test('W2-08-AC4: 预热全失败 → 真实 L3 调用零新闸门：照旧 isReady 矩阵 → 回落 L1（reason=l3-unavailable）', async () => {
  const { log, entries } = makeLogRecorder();
  const { completeCalls, isReadyCalls } = injectFake({ ready: false }); // isReady → false（冷加载失败语义）
  startL3Warmup(log, [5, 10, 15]);
  await pollUntil(() => isReadyCalls() === WARMUP_MAX_RETRIES + 1, '预热循环 4 次尝试收尾');
  assert.equal(entries.filter((e) => e.message.includes('L3 warmup failed')).length, 1, '预热全失败已记日志');

  // 热路径：双条目 → schema 优先走 L3 → 既有 isReady 矩阵（无任何新闸门）→ 回落 L1
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  const { ctx, getRecord } = makeCtx('s-w208-ac4');
  const shaped = await shapeToolResponse({ ok: true, data: { tool: PROBE, result: { name: 'alice' } } }, ctx);

  assert.equal(shaped.data.result.l1, 'ran', '预热失败后回落 L1 兜底（热路径不被新闸门阻塞）');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable', '既有失败矩阵 reason 原样（无新增 reason）');
  assert.equal(isReadyCalls(), WARMUP_MAX_RETRIES + 2, '热路径只多跑矩阵自身 1 次 isReady（零新闸门）');
  assert.equal(completeCalls(), 0, 'isReady=false → 不调模型（矩阵既有行为）');
});

// ───────────────────────────────────────────────────────────
// AC5：预热成功 → isReady()===true + 单例复用（懒加载语义不破坏）
// ───────────────────────────────────────────────────────────

test('W2-08-AC5: 预热成功 → registry 单例即预热实例，后续真实调用复用（isReady true + 计数连续）', async () => {
  const { log, entries } = makeLogRecorder();
  const { adapter, completeCalls } = injectFake({ object: { name: 'alice', count: 7 } });
  startL3Warmup(log, [5, 10, 15]);
  await pollUntil(() => entries.some((e) => e.message.includes('L3 warmup ready')), '预热成功日志');
  assert.equal(completeCalls(), 1, '预热 probe 恰好 1 次（一次成功，无重试）');

  // 预热后 isReady()===true（D-6 验收：完成后 isReady()===true）
  assert.equal(await adapter.isReady(), true, '预热完成后 isReady()===true');
  // 单例复用：registry 单例即预热所用实例（不重建）
  assert.strictEqual(getL3Adapter(), adapter, '预热创建的实例即 registry 单例（懒加载语义不破坏）');

  // 后续真实 L3 调用复用它：同实例 complete 计数继续（不新建、不重载）
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  const { ctx, getRecord } = makeCtx('s-w208-ac5');
  const shaped = await shapeToolResponse({ ok: true, data: { tool: PROBE, result: { name: 'alice', count: 7 } } }, ctx);
  assert.equal(completeCalls(), 2, '真实调用复用预热实例（计数连续）');
  assert.deepEqual(shaped.data.result, { name: 'alice', count: 7 }, 'Q5 后结果原样');
  assert.equal(getRecord().shaping.applied, true);
});

// ───────────────────────────────────────────────────────────
// AC6（增补-10 #109 R10）：代际计数 — close→start 后旧预热 IIFE 不回写 stale 状态
// ───────────────────────────────────────────────────────────

test('W2-08-AC6: close→start 后旧 IIFE 代际失效 — stale ready 不回写覆盖新状态（R10）', async () => {
  const gate = makeDeferred(); // isReady 公共闸门（两个 IIFE 都挂在这里）
  const staleGate = makeDeferred(); // 旧 IIFE 的 complete 慢闸门（call #1）
  const oldRecorder = makeLogRecorder();
  const newRecorder = makeLogRecorder();
  injectFake({ gate });
  // complete 行为按调用次序：call #1（旧 IIFE，先注册先恢复）→ 挂 staleGate 后成功（stale ready 源）；
  // call ≥2（新 IIFE）→ 立即失败（新代写入 failed）
  const adapter = getL3Adapter();
  let calls = 0;
  adapter.complete = async () => {
    calls += 1;
    if (calls === 1) { await staleGate.promise; return { object: { ok: true }, finishReason: 'stop', latencyMs: 1, modelId: 'w208-fake' }; }
    return { object: null, finishReason: 'error', latencyMs: 1, modelId: 'w208-fake' };
  };

  // 旧代：start（isReady 挂起在 gate 上，IIFE 在飞）
  startL3Warmup(oldRecorder.log, [5, 10, 15]);
  assert.equal(gate.released, false, '旧预热在飞（isReady 未放行）');
  // close 语义：resetL3Warmup 递增代际 → 旧 IIFE 失效
  resetL3Warmup();
  // 新代：start（同 adapter 单例，isReady 仍挂起）
  startL3Warmup(newRecorder.log, [5, 10, 15]);

  // 放行 isReady：旧 IIFE 进 complete#1 挂 staleGate；新 IIFE complete#2 快失败 → 写 failed
  gate.release();
  await pollUntil(() => l3Health()?.status === 'failed', '新代预热失败 → 状态 failed');
  // 放行旧 IIFE：若无代际失效，此处 stale ready 将覆盖 failed
  staleGate.release();
  await sleep(100);

  assert.equal(l3Health()?.status, 'failed', '旧 IIFE 的 stale ready 不回写（代际失效）');
  assert.ok(!oldRecorder.entries.some((e) => e.message.includes('L3 warmup ready')), '旧 IIFE 不产生 ready 日志');
});
