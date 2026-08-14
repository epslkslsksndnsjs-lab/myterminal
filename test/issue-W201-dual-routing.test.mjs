// ADR-0051 W2-01 (#84)：L3 路由 D-4 — schema 优先、reduce 兜底 + 可达性（0050 B1）
//
// 验收断言：
//   AC1  双条目（reduce+schema）小结果 → 走 L3（fake adapter 断言被调用；kind:'l3'
//        分支可达——B1 销项；L3 成功绝不叠跑 L1）
//   AC2  超预算门（>RAW_BUDGET_TOKENS）→ 回落 L1 reduce，审计 reason=over-budget
//        （回落发生则 applied:true）
//   AC3  L3 配额烧穿 → 回落 L1 reduce，reason=quota
//   AC4  L3 不可用/超时/Q5 拒识 → 回落 L1 reduce（各自 reason 由失败矩阵给出）
//   AC5  纯 schema 条目失败 → passthrough（现状语义不回归）
//   AC6  链式不实施（L1→L3 两段处理路径不存在）：回落 L1 后绝不二次进 L3
//        （complete 调用次数精确证明；D2 双重整形禁忌）
//   AC7  D17 静默：双条目 L3 成功 / 回落 L1 / 纯 schema passthrough 全路径无层标记
//   DEF  L1 兜底自身抛错 → 原样 passthrough（reason=reducer-threw，D11 底线）
//
// 测试方式：单测直接驱动 shapeToolResponse（dist/tool-parse.js）+ 注入 fake adapter
// （dist/l3/registry.js，issue-38 手法）。probe 工具名注册双条目，afterEach 清理。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';

const PROBE = 't84_dual_probe';
const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    count: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};
/** 双条目 L1 侧：打标 l1:'ran'，证明 L1 是否被应用（L3 成功时不得出现）。 */
const dualReduce = (r) => ({ ...r, l1: 'ran' });

const ORIG_MAX_PER_SESSION = process.env.MYTERMINAL_L3_MAX_PER_SESSION;

// D17 静默契约：任何层都不插自标识标记（复用 issue-31 手法）
const MARKER_KEYS = ['_shapedBy', '_l1Applied', '_l2Applied', '_l3Applied'];

function assertNoShapingMarkers(value, at = 'root') {
  if (Array.isArray(value)) { for (const item of value) assertNoShapingMarkers(item, `${at}[]`); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assertNoShapingMarkers(item, `${at}.${key}`);
  }
}

/** 注入 fake adapter（成功/不可用/失败矩阵由 object/finishReason/ready 控制），带调用计数。 */
function injectFake({ ready = true, object = { name: 'alice' }, finishReason = 'stop' } = {}) {
  resetL3Adapter(); // 清旧单例，让本次 factory 在下次懒加载生效（单例常驻语义）
  let calls = 0;
  const adapter = {
    id: 'fake',
    supportsStructuredOutput: ready,
    isReady: async () => ready,
    complete: async () => {
      calls += 1;
      return { object, finishReason, latencyMs: 1, modelId: 'fake' };
    },
  };
  registerAdapterFactory(() => adapter);
  return { adapter, callCount: () => calls };
}

function makeCtx(sessionId = 's-w201', transport = 'actions') {
  let record;
  const ctx = {
    transport,
    sessionId,
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

function shapeRaw(result, ctx) {
  return shapeToolResponse({ ok: true, data: { tool: PROBE, result } }, ctx);
}

afterEach(() => {
  resetL3Adapter();
  clearL3Quota();
  TOOL_SHAPES.delete(PROBE);
  if (ORIG_MAX_PER_SESSION === undefined) delete process.env.MYTERMINAL_L3_MAX_PER_SESSION;
  else process.env.MYTERMINAL_L3_MAX_PER_SESSION = ORIG_MAX_PER_SESSION;
});

// ───────────────────────────────────────────────────────────
// AC1：双条目小结果 → L3（可达性，B1 销项）
// ───────────────────────────────────────────────────────────

test('W2-01-AC1: 双条目（reduce+schema）小结果走 L3 — fake 被调用 + L3 成功不叠跑 L1', async () => {
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  const { callCount } = injectFake({ object: { name: 'alice', count: 7, tags: ['red'] } });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeRaw({ name: 'alice', count: 7, tags: ['red', 'blue'] }, ctx);
  assert.equal(callCount(), 1, 'L3 被调用（schema 优先，kind:l3 分支可达——B1 销项）');
  assert.deepEqual(shaped.data.result, { name: 'alice', count: 7, tags: ['red'] }, 'Q5 后结果（白名单外字段丢）');
  assert.equal(shaped.data.result.l1, undefined, 'L3 成功绝不叠跑 L1（D2 链式禁忌）');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined, 'L3 成功无 reason');
});

// ───────────────────────────────────────────────────────────
// AC2：超预算门 → 回落 L1
// ───────────────────────────────────────────────────────────

test('W2-01-AC2: 超预算门（>RAW_BUDGET_TOKENS）→ 回落 L1 reduce，reason=over-budget + applied:true', async () => {
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  const { callCount } = injectFake({ object: { name: 'alice' } });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeRaw({ big: 'x'.repeat(200000) }, ctx); // 200000 拉丁 ≈50000 tokens > 24000
  assert.equal(callCount(), 0, '超门不调 L3 模型');
  assert.equal(shaped.data.result.l1, 'ran', '回落 L1 reduce 生效');
  assert.equal(getRecord().shaping.applied, true, '回落发生则 applied:true');
  assert.equal(getRecord().shaping.reason, 'over-budget', '审计 reason=over-budget');
  assertNoShapingMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC3：配额烧穿 → 回落 L1
// ───────────────────────────────────────────────────────────

test('W2-01-AC3: L3 配额烧穿 → 回落 L1 reduce，reason=quota（不再调模型）', async () => {
  process.env.MYTERMINAL_L3_MAX_PER_SESSION = '1'; // 会话配额上限 1，一次后烧穿
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  const { callCount } = injectFake({ object: { name: 'alice' } });
  const { ctx } = makeCtx('s-quota');

  await shapeRaw({ name: 'alice' }, ctx); // 第 1 次：L3 成功，配额烧穿
  const { ctx: ctx2, getRecord: getRecord2 } = makeCtx('s-quota');
  const shaped2 = await shapeRaw({ name: 'alice' }, ctx2); // 第 2 次：quota → 回落 L1
  assert.equal(callCount(), 1, '第 2 次不调模型（配额拦截）');
  assert.equal(shaped2.data.result.l1, 'ran', '回落 L1 reduce 生效');
  assert.equal(getRecord2().shaping.applied, true);
  assert.equal(getRecord2().shaping.reason, 'quota', '审计 reason=quota');
  assertNoShapingMarkers(shaped2);
});

// ───────────────────────────────────────────────────────────
// AC4：失败矩阵各 reason → 回落 L1
// ───────────────────────────────────────────────────────────

test('W2-01-AC4a: L3 不可用（supportsStructuredOutput=false）→ 回落 L1，reason=l3-unavailable', async () => {
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  const { callCount } = injectFake({ ready: false });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeRaw({ name: 'alice' }, ctx);
  assert.equal(callCount(), 0, '不可用不调模型');
  assert.equal(shaped.data.result.l1, 'ran', '回落 L1 reduce 生效');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable', '审计 reason=l3-unavailable');
});

test('W2-01-AC4b: L3 超时（finishReason=timeout）→ 回落 L1，reason=l3-unavailable-timeout', async () => {
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  const { callCount } = injectFake({ object: null, finishReason: 'timeout' });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeRaw({ name: 'alice' }, ctx);
  assert.equal(callCount(), 1, 'L3 仅尝试 1 次');
  assert.equal(shaped.data.result.l1, 'ran', '回落 L1 reduce 生效');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable-timeout', '审计 reason=l3-unavailable-timeout');
});

test('W2-01-AC4c: L3 解析错误（finishReason=error，重试 1 次后仍败）→ 回落 L1，reason=l3-parse-error', async () => {
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  const { callCount } = injectFake({ object: null, finishReason: 'error' });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeRaw({ name: 'alice' }, ctx);
  assert.equal(callCount(), 2, 'GBNF 失效防御性重试 1 次');
  assert.equal(shaped.data.result.l1, 'ran', '回落 L1 reduce 生效');
  assert.equal(getRecord().shaping.reason, 'l3-parse-error', '审计 reason=l3-parse-error');
});

test('W2-01-AC4d: Q5 拒识（全字段皆丢）→ 回落 L1，reason=q5-rejected', async () => {
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  const { callCount } = injectFake({ object: { ghost: 'x' } }); // 白名单外 → 全丢 → q5-rejected
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeRaw({ name: 'alice' }, ctx);
  assert.equal(callCount(), 1);
  assert.equal(shaped.data.result.l1, 'ran', '回落 L1 reduce 生效');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, 'q5-rejected', '审计 reason=q5-rejected');
});

// ───────────────────────────────────────────────────────────
// AC5：纯 schema 条目失败 → passthrough（现状不回归）
// ───────────────────────────────────────────────────────────

test('W2-01-AC5a: 纯 schema 条目（无 reduce）失败 → passthrough 原样，不回落（现状保留）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA }); // 纯 schema
  const { callCount } = injectFake({ ready: false });
  const { ctx, getRecord } = makeCtx();

  const raw = { name: 'alice' };
  const shaped = await shapeRaw(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '原样引用（passthrough）');
  assert.equal(callCount(), 0);
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable');
  assertNoShapingMarkers(shaped);
});

test('W2-01-AC5b: 纯 schema 条目成功 → L3 applied（现状不回归）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  const { callCount } = injectFake({ object: { name: 'alice', count: 7 } });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeRaw({ name: 'alice', count: 7 }, ctx);
  assert.equal(callCount(), 1);
  assert.deepEqual(shaped.data.result, { name: 'alice', count: 7 }, 'L3 Q5 后结果');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined);
});

// ───────────────────────────────────────────────────────────
// AC6：链式不实施（L1→L3 两段处理不存在）
// ───────────────────────────────────────────────────────────

test('W2-01-AC6: 链式不实施 — 回落 L1 后绝不二次进 L3（complete 次数精确证明）', async () => {
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  // 超时路径：L3 尝试 1 次 → 回落 L1。若链式（L1→L3 两段）存在，complete 会被再调一次。
  const { callCount } = injectFake({ object: null, finishReason: 'timeout' });
  const { ctx } = makeCtx();

  const shaped = await shapeRaw({ name: 'alice' }, ctx);
  assert.equal(callCount(), 1, 'L3 恰好 1 次，回落 L1 后无二次 L3 调用（D2 双重整形禁忌）');
  assert.equal(shaped.data.result.l1, 'ran', '终态为 L1 结果（单段处理）');
});

// ───────────────────────────────────────────────────────────
// AC7：D17 静默 — 全路径无层标记
// ───────────────────────────────────────────────────────────

test('W2-01-AC7: D17 静默 — 双条目 L3 成功 / 回落 L1 / 纯 schema passthrough 三路径递归扫描', async () => {
  // 路径一：双条目 L3 成功
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  const { callCount } = injectFake({ object: { name: 'alice' } });
  const { ctx } = makeCtx();
  const l3ok = await shapeRaw({ name: 'alice' }, ctx);
  assertNoShapingMarkers(l3ok);

  // 路径二：双条目回落 L1（配额烧穿）
  resetL3Adapter();
  const { ctx: ctx2 } = makeCtx('s-silent');
  const fallback = await shapeRaw({ name: 'alice' }, ctx2);
  assertNoShapingMarkers(fallback);

  // 路径三：纯 schema passthrough
  TOOL_SHAPES.delete(PROBE);
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  const { ctx: ctx3 } = makeCtx('s-silent3');
  const pure = await shapeRaw({ name: 'alice' }, ctx3);
  assertNoShapingMarkers(pure);
});

// ───────────────────────────────────────────────────────────
// DEF：L1 兜底自身抛错 → 原样 passthrough（D11 底线）
// ───────────────────────────────────────────────────────────

test('W2-01-DEF: 双条目兜底 reducer 抛错 → 原样 passthrough + reason=reducer-threw（D11）', async () => {
  TOOL_SHAPES.set(PROBE, { reduce: () => { throw new Error('boom'); }, schema: SCHEMA });
  const { callCount } = injectFake({ ready: false }); // 不可用 → 触发回落
  const { ctx, getRecord } = makeCtx();

  const raw = { name: 'alice' };
  const shaped = await shapeRaw(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '兜底失败原样 passthrough');
  assert.equal(callCount(), 0);
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'reducer-threw');
  assertNoShapingMarkers(shaped);
});
