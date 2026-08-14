// ADR-0047 T10 (#38)：L3 引擎 — 路由 + 护栏 + Q5 + fail-open
//
// 验收覆盖（对应 #38 Acceptance criteria）：
//   AC1 仅 schema→L3 路由；L1 规则绝不直达 L3（必须经 L2）；未声明 → passthrough
//   AC2 transport 感知超时（actions≤8000ms / 本地/TUI/MCP≤20000ms）+ L3 maxTokens≤2048
//   AC3 会话级配额 50/session（可配置，Map 计数、会话结束删除）；超限 → passthrough + quota
//   AC4 Q5 防幻觉：字段白名单（只留注册已知 key）+ 值存在性校验（标量值须在 raw 文本中存在）
//       + 任一失败整体 fail-open 回 passthrough
//   AC5 审计 reason 枚举完整：l3-unavailable-timeout / over-budget / quota / passthrough
//   AC6 e2e：fake adapter 四路径（成功/超时/不可用/超预算）符合预期；结果无层标记
//
// 测试方式：单测直接驱动 shapeToolResponse（dist/tool-parse.js）+ 注入 fake adapter（registry）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter } from '../dist/l3/registry.js';
import { runL3, clearL3Quota, l3TimeoutMs, l3MaxPerSession, L3_MAX_TOKENS, L3_TIMEOUT_ACTIONS_MS, L3_TIMEOUT_OTHER_MS, L3_MAX_PER_SESSION_DEFAULT } from '../dist/l3/engine.js';

const PROBE = 't38_probe';
const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    count: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

// D17 静默契约：任何层都不插自标识标记
const MARKER_KEYS = ['_shapedBy', '_l1Applied', '_l2Applied', '_l3Applied'];

function assertNoMarkers(value, at = 'root') {
  if (Array.isArray(value)) { for (const item of value) assertNoMarkers(item, `${at}[]`); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assertNoMarkers(item, `${at}.${key}`);
  }
}

/** 注入 fake adapter（成功/超时/不可用 由 object/finishReason/ready 控制），返回 lastReq 读取器。 */
function injectFake({ ready = true, object = { name: 'alice' }, finishReason = 'stop', pending = false } = {}) {
  resetL3Adapter(); // 清旧单例，让本次 factory 在下次懒加载生效（T09 单例常驻语义）
  let lastReq = null;
  const adapter = {
    id: 'fake',
    supportsStructuredOutput: ready,
    isReady: async () => ready,
    complete: async (req) => {
      lastReq = req;
      if (pending) return new Promise(() => {}); // 永不 resolve，用于真超时竞速截断测试
      return { object, finishReason, latencyMs: 1, modelId: 'fake' };
    },
  };
  registerAdapterFactory(() => adapter);
  return { adapter, getLastReq: () => lastReq };
}

function makeCtx(sessionId = 's-38', transport = 'actions') {
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
});

// ───────────────────────────────────────────────────────────
// AC2：transport 感知超时 + maxTokens 常量
// ───────────────────────────────────────────────────────────

test('T10-AC2a: transport 感知超时 — actions=8000ms，其余（apps/tui/mcp/subagent）=20000ms', () => {
  assert.equal(l3TimeoutMs('actions'), 8000);
  assert.equal(l3TimeoutMs('apps'), 20000);
  assert.equal(l3TimeoutMs('tui'), 20000);
  assert.equal(l3TimeoutMs('mcp'), 20000);
  assert.equal(l3TimeoutMs('subagent'), 20000);
  assert.equal(L3_TIMEOUT_ACTIONS_MS, 8000);
  assert.equal(L3_TIMEOUT_OTHER_MS, 20000);
  assert.equal(L3_MAX_TOKENS, 2048);
});

test('T10-AC2b: L3 maxTokens≤2048 + temperature=0 确定性', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  const { getLastReq } = injectFake({ object: { name: 'alice', count: 7, tags: ['red'] } });
  const { ctx } = makeCtx();
  await shapeRaw({ name: 'alice', count: 7, tags: ['red', 'blue'] }, ctx);
  const req = getLastReq();
  assert.ok(req, 'fake adapter complete 被调用');
  assert.equal(req.maxTokens, 2048, 'maxTokens ≤2048（D6 护栏1）');
  assert.equal(req.temperature, 0, 'temperature=0 确定性');
  assert.equal(req.schema, SCHEMA, 'schema 原样传入');
});

test('T10-AC2c: 真超时竞速截断（timeoutMs 注入 + 永不 resolve 的 complete）→ l3-unavailable-timeout', async () => {
  injectFake({ pending: true }); // complete 永不 resolve，逼真触发 withTimeout 竞速截断
  const outcome = await runL3({ name: 'alice' }, SCHEMA, 'actions', 's-38', 10);
  assert.equal(outcome.shaped, null);
  assert.equal(outcome.reason, 'l3-unavailable-timeout');
});

// ───────────────────────────────────────────────────────────
// AC1 + AC6：路由（schema→L3 成功 / L1 绝不直达 L3 / 未声明 passthrough）
// ───────────────────────────────────────────────────────────

test('T10-AC6a: schema→L3 成功路径 — Q5 后结果替换 data.result + applied:true + 无层标记', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  injectFake({ object: { name: 'alice', count: 7, tags: ['red', 'blue'], ghost: 'x' } });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRaw({ name: 'alice', count: 7, tags: ['red', 'blue'] }, ctx);
  assert.deepEqual(shaped.data.result, { name: 'alice', count: 7, tags: ['red', 'blue'] }, 'Q5 后结果（白名单外 ghost 被丢）');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined, '成功无 reason');
  assertNoMarkers(shaped);
});

test('T10-AC1a: L1 规则绝不直达 L3（reduce 工具不调模型）', async () => {
  TOOL_SHAPES.set(PROBE, { reduce: (r) => ({ ...r, reduced: true }) });
  const { getLastReq } = injectFake({ object: { name: 'alice' } });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRaw({ name: 'alice' }, ctx);
  assert.equal(shaped.data.result.reduced, true, 'L1 reduce 生效');
  assert.equal(getLastReq(), null, 'L1 路径绝不调用 L3 模型');
  assert.equal(getRecord().shaping.applied, true);
});

test('T10-AC1b: 未声明工具 → passthrough（不调 L3）', async () => {
  const { getLastReq } = injectFake({ object: { name: 'alice' } });
  const { ctx, getRecord } = makeCtx();
  const resp = { ok: true, data: { tool: 'workspace_info', result: { path: '/tmp' } } };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.strictEqual(shaped, resp, '未声明工具原样返回');
  assert.equal(getLastReq(), null, '未声明工具不调 L3');
  assert.equal(getRecord().shaping.reason, 'passthrough');
});

// ───────────────────────────────────────────────────────────
// AC6：fake 四路径（超时 / 不可用 / 超预算）
// ───────────────────────────────────────────────────────────

test('T10-AC6b: 超时路径 — fake finishReason=timeout → passthrough + l3-unavailable-timeout', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  injectFake({ object: null, finishReason: 'timeout' });
  const { ctx, getRecord } = makeCtx();
  const raw = { name: 'alice' };
  const shaped = await shapeRaw(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '超时 fail-open 原样');
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable-timeout');
  assertNoMarkers(shaped);
});

test('T10-AC6c: 不可用路径 — supportsStructuredOutput=false → passthrough + l3-unavailable', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  injectFake({ ready: false });
  const { ctx, getRecord } = makeCtx();
  const raw = { name: 'alice' };
  const shaped = await shapeRaw(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '不可用 fail-open 原样');
  assert.equal(getRecord().shaping.reason, 'l3-unavailable');
});

test('T10-AC6d: 超预算路径 — 预算门拦截，不调模型 + over-budget', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  const { getLastReq } = injectFake({ object: { name: 'alice' } });
  const { ctx, getRecord } = makeCtx();
  const raw = { big: 'x'.repeat(200000) }; // 200000 拉丁 ≈50000 tokens > 24000
  const shaped = await shapeRaw(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '超预算 fail-open 原样');
  assert.equal(getLastReq(), null, '超预算不调 L3 模型');
  assert.equal(getRecord().shaping.reason, 'over-budget');
});

// ───────────────────────────────────────────────────────────
// AC3：会话级配额 50/session + 可配置 + 清理
// ───────────────────────────────────────────────────────────

test('T10-AC3a: 配额默认 50/session + env 可配置', () => {
  assert.equal(L3_MAX_PER_SESSION_DEFAULT, 50);
  assert.equal(l3MaxPerSession({}), 50);
  assert.equal(l3MaxPerSession({ MYTERMINAL_L3_MAX_PER_SESSION: '3' }), 3);
  assert.equal(l3MaxPerSession({ MYTERMINAL_L3_MAX_PER_SESSION: '  10 ' }), 10);
  assert.equal(l3MaxPerSession({ MYTERMINAL_L3_MAX_PER_SESSION: 'garbage' }), 50, '非法值回退默认');
});

test('T10-AC3b: 同一 session 第 51 次超限 → passthrough + quota；不同 session 独立计数', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  injectFake({ object: { name: 'alice' } });
  const raw = { name: 'alice' };
  // 前 50 次成功整形
  const { ctx } = makeCtx('s-38');
  for (let i = 0; i < 50; i++) {
    const shaped = await shapeRaw(raw, ctx);
    assert.equal(shaped.data.result.name, 'alice', `第 ${i + 1} 次成功整形`);
  }
  // 第 51 次超限 → quota passthrough
  const { ctx: ctx51, getRecord: getRecord51 } = makeCtx('s-38');
  const shaped51 = await shapeRaw(raw, ctx51);
  assert.strictEqual(shaped51.data.result, raw, '配额超限 fail-open 原样');
  assert.equal(getRecord51().shaping.applied, false);
  assert.equal(getRecord51().shaping.reason, 'quota');

  // 不同 session 独立计数（新 session 不受影响）
  const { ctx: ctx3, getRecord: getRecord3 } = makeCtx('s-other');
  const shaped3 = await shapeRaw(raw, ctx3);
  assert.equal(shaped3.data.result.name, 'alice', '其他 session 独立计数，正常整形');
  assert.equal(getRecord3().shaping.applied, true);
});

test('T10-AC3c: clearL3Quota(sessionId) 会话结束删除 — 清理后重新计数', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  injectFake({ object: { name: 'alice' } });
  const raw = { name: 'alice' };
  const { ctx } = makeCtx('s-clear');
  await shapeRaw(raw, ctx); // 计数 +1
  clearL3Quota('s-clear');
  const { ctx: ctx2, getRecord: getRecord2 } = makeCtx('s-clear');
  const shaped2 = await shapeRaw(raw, ctx2);
  assert.equal(shaped2.data.result.name, 'alice', '清理后重新计数，正常整形');
  assert.equal(getRecord2().shaping.applied, true);
});

// ───────────────────────────────────────────────────────────
// AC4：Q5 字段白名单 + 值存在性校验 + 全丢 fail-open
// ───────────────────────────────────────────────────────────

test('T10-AC4a: 字段白名单 — 白名单外字段（ghost）被丢，白名单内保留', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  injectFake({ object: { name: 'alice', count: 7, tags: ['red'], ghost: 'x', invented: 123 } });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRaw({ name: 'alice', count: 7, tags: ['red', 'blue'] }, ctx);
  assert.deepEqual(shaped.data.result, { name: 'alice', count: 7, tags: ['red'] }, '白名单外字段被丢');
  assert.equal(getRecord().shaping.applied, true);
});

test('T10-AC4b: 值存在性校验 — 标量值不在 raw 文本中被丢（防幻觉）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  injectFake({ object: { name: 'alice', count: 999 } });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRaw({ name: 'alice', count: 7 }, ctx);
  assert.deepEqual(shaped.data.result, { name: 'alice' }, 'count=999 不在 raw（7）中被丢');
  assert.equal(getRecord().shaping.applied, true, '仍有 name 字段，整形成功');
});

test('T10-AC4d: 值存在性 — string 精确匹配（子串不误命中：red 不命中 reddish）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  // raw tags 含 'red'，model 幻觉输出 'reddish'（raw 里无完整 "reddish" 字符串值）→ 丢
  injectFake({ object: { name: 'alice', tags: ['reddish'] } });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRaw({ name: 'alice', tags: ['red', 'blue'] }, ctx);
  assert.deepEqual(shaped.data.result, { name: 'alice' }, 'reddish 不是完整字符串值 → 丢（tags 全丢）');
  assert.equal(getRecord().shaping.applied, true, '仍有 name 字段');
});

test('T10-AC4c: 全字段皆丢 → 整体 fail-open passthrough（q5-rejected）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  injectFake({ object: { name: 'nonexistent', count: 999 } });
  const { ctx, getRecord } = makeCtx();
  const raw = { name: 'alice', count: 7 };
  const shaped = await shapeRaw(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '全丢 → 整体 fail-open 原样');
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'q5-rejected');
});

// ───────────────────────────────────────────────────────────
// AC5 + env 旋钮：reason 枚举 + MYTERMINAL_L3_ENABLED 一键关
// ───────────────────────────────────────────────────────────

test('T10-AC5: 审计 reason 枚举完整（l3-unavailable-timeout / over-budget / quota / q5-rejected）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });

  // l3-unavailable-timeout
  injectFake({ object: null, finishReason: 'timeout' });
  let { ctx, getRecord } = makeCtx('s-r1');
  await shapeRaw({ name: 'alice' }, ctx);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable-timeout');

  // over-budget（预算门在 L2 层）
  injectFake({ object: { name: 'alice' } });
  ({ ctx, getRecord } = makeCtx('s-r2'));
  await shapeRaw({ big: 'x'.repeat(200000) }, ctx);
  assert.equal(getRecord().shaping.reason, 'over-budget');

  // quota（配额超限）
  injectFake({ object: { name: 'alice' } });
  ({ ctx, getRecord } = makeCtx('s-r3'));
  const raw = { name: 'alice' };
  for (let i = 0; i < 50; i++) await shapeRaw(raw, ctx);
  const { ctx: qctx, getRecord: qrec } = makeCtx('s-r3');
  await shapeRaw(raw, qctx);
  assert.equal(qrec().shaping.reason, 'quota');

  // q5-rejected（Q5 全丢）
  injectFake({ object: { name: 'nonexistent' } });
  ({ ctx, getRecord } = makeCtx('s-r4'));
  await shapeRaw(raw, ctx);
  assert.equal(getRecord().shaping.reason, 'q5-rejected');
});

test('T10-env: MYTERMINAL_L3_ENABLED=false 一键关 L3 → passthrough（不调模型、不耗配额）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  const { getLastReq } = injectFake({ object: { name: 'alice' } });
  const saved = process.env.MYTERMINAL_L3_ENABLED;
  process.env.MYTERMINAL_L3_ENABLED = 'false';
  try {
    const { ctx, getRecord } = makeCtx();
    const raw = { name: 'alice' };
    const shaped = await shapeRaw(raw, ctx);
    assert.strictEqual(shaped.data.result, raw, '关 L3 → 原样 passthrough');
    assert.equal(getLastReq(), null, '关 L3 不调模型');
    assert.equal(getRecord().shaping.reason, 'passthrough');
  } finally {
    if (saved === undefined) delete process.env.MYTERMINAL_L3_ENABLED;
    else process.env.MYTERMINAL_L3_ENABLED = saved;
  }
});
