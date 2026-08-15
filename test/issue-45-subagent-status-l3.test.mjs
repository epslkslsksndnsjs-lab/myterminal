// ADR-0047 T11 (#45)：subagent_status.result L3-if-small 路由（ADR-48 硬依赖）
//
// 验收覆盖（对应 #45 Acceptance criteria）：
//   AC1 subagent_status.result 仅当 status==='completed' + 自由文本 string + ≤24K tokens 时走 L3
//   AC2 其余 subagent 内部上下文（tasks/cost/auditLogs 等）不整形（避免双重整形）
//   AC3 超预算门（>24K）→ fail-open passthrough，审计 reason=over-budget
//   AC4 非 completed 状态 → 不整形
//   AC5 测试覆盖：completed 自由文本小结果走 L3 / 超 24K fail-open / 非 completed 不整形
//   （D17 静默：任何层不插自标识标记）
//
// W2-07（#90）适配：D-13 旁挂式——L3 抽取挂 data.result.extracted（D-11 真 schema：
// deliverables/files/blockers/conclusion），result 原文原样不动（0048 D11「result 必留」）。
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js）+ 注入 fake adapter
// （registry）。subagent_status 是控制工具、不在 TOOL_SHAPES，路由由 tool-parse 的特化
// 分支（同 task_poll 先例）实现。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { shapeToolResponse } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter, resetL3AdapterInstance } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';

const MARKER_KEYS = ['_shapedBy', '_l1Applied', '_l2Applied', '_l3Applied'];

function assertNoMarkers(value, at = 'root') {
  if (Array.isArray(value)) { for (const item of value) assertNoMarkers(item, `${at}[]`); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assertNoMarkers(item, `${at}.${key}`);
  }
}

/** 注入 fake adapter；返回 lastReq 读取器。 */
function injectFake({ ready = true, object = null, finishReason = 'stop' } = {}) {
  resetL3Adapter();
  let lastReq = null;
  const adapter = {
    id: 'fake',
    supportsStructuredOutput: ready,
    isReady: async () => ready,
    complete: async (req) => {
      lastReq = req;
      return { object, finishReason, latencyMs: 1, modelId: 'fake' };
    },
  };
  registerAdapterFactory(() => adapter);
  return { getLastReq: () => lastReq };
}

function makeCtx(sessionId = 's-45', transport = 'actions') {
  let record;
  const ctx = {
    transport,
    sessionId,
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

/** 构造 subagent_status 的完整 SubagentStatusResult（含全部内部上下文字段）。 */
function makeStatusResult({ status = 'completed', result = 'final report: all tests passed' } = {}) {
  return {
    status,
    sessionId: 'child-1',
    tasks: [{ id: 't1', status: 'completed', description: 'do the thing' }],
    usage: { inputTokens: 100, outputTokens: 50 },
    ...(status === 'completed' && result !== undefined ? { result } : {}),
    origin: { type: 'skill', skillName: 'demo' },
    auditLogs: [{ type: 'tool_audit', tool: 'execute_cli' }],
  };
}

function shapeStatus(result, ctx) {
  return shapeToolResponse({ ok: true, data: { tool: 'subagent_status', result } }, ctx);
}

afterEach(() => {
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）
  clearL3Quota();
});

// ───────────────────────────────────────────────────────────
// AC1 + AC2：completed + 自由文本小结果走 L3，其余上下文不动
// ───────────────────────────────────────────────────────────

test('T11-AC1: completed 自由文本小结果走 L3 — D-13 旁挂 extracted，result 原文不动，其余上下文原样', async () => {
  const text = 'final report: all tests passed';
  // 整段文本即唯一行值：conclusion 抽取整段 → Q5 逐字命中（D-11 真 schema；占位 {summary} 已消除）
  injectFake({ object: { conclusion: text } });
  const { ctx, getRecord } = makeCtx();
  const raw = makeStatusResult({ status: 'completed', result: text });
  const shaped = await shapeStatus(raw, ctx);

  // D-13 旁挂式：extracted 挂上（Q5 后），result 原文原样不动（0048 D11「result 必留」）
  assert.equal(shaped.data.result.result, text, 'result 原文原样不动（不被替换）');
  assert.deepEqual(shaped.data.result.extracted, { conclusion: text }, 'L3 抽取挂 extracted');
  // 其余内部上下文原样（避免双重整形，AC2）
  assert.equal(shaped.data.result.status, 'completed');
  assert.equal(shaped.data.result.sessionId, 'child-1');
  assert.deepEqual(shaped.data.result.tasks, raw.tasks, 'tasks 不整形');
  assert.deepEqual(shaped.data.result.usage, raw.usage, 'usage 不整形');
  assert.deepEqual(shaped.data.result.origin, raw.origin, 'origin 不整形');
  assert.deepEqual(shaped.data.result.auditLogs, raw.auditLogs, 'auditLogs 不整形');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined, '成功无 reason');
  assertNoMarkers(shaped);
});

test('T11-AC1b: 走 L3 时确实调用模型（路由达到 L3，非 passthrough）', async () => {
  const text = 'final report: all tests passed';
  const { getLastReq } = injectFake({ object: { conclusion: text } });
  const { ctx } = makeCtx();
  await shapeStatus(makeStatusResult({ status: 'completed', result: text }), ctx);
  const req = getLastReq();
  assert.ok(req, 'fake adapter complete 被调用');
  assert.equal(req.schema.type, 'object', 'schema 传入（D-11 真 schema）');
});

// ───────────────────────────────────────────────────────────
// AC3：超预算门（>24K）→ fail-open passthrough，reason=over-budget
// ───────────────────────────────────────────────────────────

test('T11-AC3: 超预算门（result 子字段 >24K tokens）→ fail-open over-budget，不调模型', async () => {
  const { getLastReq } = injectFake({ object: { summary: 'x' } });
  const { ctx, getRecord } = makeCtx();
  const big = 'x'.repeat(120000); // 120000 拉丁 ≈30000 tokens > 24000
  const raw = makeStatusResult({ status: 'completed', result: big });
  const shaped = await shapeStatus(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '超预算 fail-open 原样');
  assert.equal(getLastReq(), null, '超预算不调 L3 模型');
  assert.equal(getRecord().shaping.reason, 'over-budget');
});

// ───────────────────────────────────────────────────────────
// AC4：非 completed 状态 → 不整形
// ───────────────────────────────────────────────────────────

test('T11-AC4: 非 completed（running）→ 不整形，passthrough', async () => {
  const { getLastReq } = injectFake({ object: { summary: 'x' } });
  const { ctx, getRecord } = makeCtx();
  const raw = makeStatusResult({ status: 'running' });
  const shaped = await shapeStatus(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '非 completed 原样');
  assert.equal(getLastReq(), null, '非 completed 不调 L3');
  assert.equal(getRecord().shaping.applied, true, '票B 入表后 subagent_status 恒走 L1（原样同引用返回，applied:true 取代旧 passthrough reason）');
});

// ───────────────────────────────────────────────────────────
// 边界：completed 但 result 非 string / 缺失 → 不整形
// ───────────────────────────────────────────────────────────

test('T11-边界: completed 但 result 非 string（对象）→ 不整形', async () => {
  const { getLastReq } = injectFake({ object: { summary: 'x' } });
  const { ctx, getRecord } = makeCtx();
  const raw = { status: 'completed', result: { structured: true } };
  const shaped = await shapeStatus(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, 'result 非 string 原样');
  assert.equal(getLastReq(), null, 'result 非 string 不调 L3');
  assert.equal(getRecord().shaping.applied, true, '票B 入表后 subagent_status 恒走 L1（原样同引用返回，applied:true 取代旧 passthrough reason）');
});

test('T11-边界: completed 但 result 缺失 → 不整形', async () => {
  const { getLastReq } = injectFake({ object: { summary: 'x' } });
  const { ctx, getRecord } = makeCtx();
  const raw = { status: 'completed', sessionId: 'child-1' };
  const shaped = await shapeStatus(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '无 result 原样');
  assert.equal(getLastReq(), null, '无 result 不调 L3');
  assert.equal(getRecord().shaping.applied, true, '票B 入表后 subagent_status 恒走 L1（原样同引用返回，applied:true 取代旧 passthrough reason）');
});

// ───────────────────────────────────────────────────────────
// L3 fail-open：Q5 全丢 / 模型不可用 → 原样 passthrough
// ───────────────────────────────────────────────────────────

test('T11-fail-open: Q5 全字段皆丢（模型幻觉）→ 整体 fail-open passthrough', async () => {
  const text = 'final report: all tests passed';
  // 模型返回的值不在 raw 文本中 → Q5 值存在性校验丢字段 → 全丢 → fail-open（不伪造）
  injectFake({ object: { conclusion: 'totally different hallucination' } });
  const { ctx, getRecord } = makeCtx();
  const raw = makeStatusResult({ status: 'completed', result: text });
  const shaped = await shapeStatus(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, 'Q5 全丢 fail-open 原样');
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'q5-rejected');
});

test('T11-fail-open: 模型不可用 → passthrough + l3-unavailable', async () => {
  injectFake({ ready: false });
  const { ctx, getRecord } = makeCtx();
  const raw = makeStatusResult({ status: 'completed', result: 'hello' });
  const shaped = await shapeStatus(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '模型不可用 fail-open 原样');
  assert.equal(getRecord().shaping.reason, 'l3-unavailable');
});
