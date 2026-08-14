// ADR-0047 T14 (#44)：L3 模型提示词与失败矩阵（D8.4）
//
// 验收覆盖（对应 #44 Acceptance criteria）：
//   AC1 `StructuredRequest.instruction` 由 D8.4 prompt 模板生成（含 raw 结果文本 + 目标 schema）；
//       模板与 adapter 实现分离（prompt.ts 独立模块，可随评测迭代）
//   AC2 non-thinking 由参数层强制（chat 模板 enable_thinking=false 语义）——真模型不进自动化测试，
//       由 T12 llama-adapter 的 QwenChatWrapper(thoughts:"discourage") 落地，此处不重复验证
//   AC3 失败矩阵全路径 + 审计 reason：l3-unavailable / l3-unavailable-timeout / l3-parse-error /
//       q5-rejected / over-budget / quota / engine-error
//   AC4 默认零重试；仅 GBNF 失效（l3-parse-error）防御性重试 1 次
//   AC5 Q5 衔接：白名单外字段丢、标量值不在 raw 中丢字段、全部字段皆丢 → 整体 fail-open passthrough
//   AC6 "不会"兜底：模型输出空/幻觉 → 系统回到未整形状态，主模型无损（与 D11 fail-open 一致）
//   AC7 与 T10 引擎集成：prompt 生成 → 引擎调用 → 失败矩阵生效；e2e 覆盖
//
// 测试方式：单测直接驱动 shapeToolResponse（dist/tool-parse.js）+ 注入 fake adapter（registry）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter } from '../dist/l3/registry.js';
import { runL3, clearL3Quota } from '../dist/l3/engine.js';
import { buildInstruction, L3_SYSTEM_PROMPT } from '../dist/l3/prompt.js';

const PROBE = 't44_probe';
const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    count: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * 注入 fake adapter。`responses` 按调用次序消费：第 i 次 complete 返回 responses[min(i, len-1)]
 * （耗尽后复用最后一个），可精确模拟「第一次 error 重试后成功」等序列。
 * 不传 responses → 默认成功返回 { name: 'alice' }。
 */
function injectFake({ ready = true, responses = [], throwOnComplete = false } = {}) {
  resetL3Adapter();
  let lastReq = null;
  let completeCalls = 0;
  const adapter = {
    id: 'fake',
    supportsStructuredOutput: ready,
    isReady: async () => ready,
    complete: async (req) => {
      lastReq = req;
      completeCalls++;
      if (throwOnComplete) throw new Error('engine boom');
      const r = responses.length
        ? responses[Math.min(completeCalls - 1, responses.length - 1)]
        : { object: { name: 'alice' }, finishReason: 'stop' };
      return { latencyMs: 1, modelId: 'fake', ...r };
    },
  };
  registerAdapterFactory(() => adapter);
  return { adapter, getLastReq: () => lastReq, getCompleteCalls: () => completeCalls };
}

function makeCtx(sessionId = 's-44', transport = 'actions') {
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
// AC1：prompt 模板（instruction 含 raw + schema；模板与 adapter 分离）
// ───────────────────────────────────────────────────────────

test('T14-AC1a: buildInstruction 含 raw 结果文本 + 目标 schema（JSON 序列化）', () => {
  const raw = { name: 'alice', count: 7 };
  const instruction = buildInstruction(raw, SCHEMA);
  assert.ok(instruction.includes(JSON.stringify(raw)), 'instruction 含 raw 结果文本');
  assert.ok(instruction.includes(JSON.stringify(SCHEMA)), 'instruction 含目标 schema');
  assert.ok(instruction.includes('请输出结构化结果'), 'instruction 含输出指令');
});

test('T14-AC1b: L3_SYSTEM_PROMPT 含 D8.4 四条规则（模板与 adapter 分离）', () => {
  assert.ok(L3_SYSTEM_PROMPT.includes('只输出 schema 中声明的字段'), '规则1');
  assert.ok(L3_SYSTEM_PROMPT.includes('原样保留'), '规则2');
  assert.ok(L3_SYSTEM_PROMPT.includes('标量 → 省略该字段'), '规则3');
  assert.ok(L3_SYSTEM_PROMPT.includes('只输出 JSON 本体'), '规则4');
});

test('T14-AC1c: engine 调用 adapter 时 instruction 来自模板（含 raw + schema）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  const { getLastReq } = injectFake({ responses: [{ object: { name: 'alice', count: 7 }, finishReason: 'stop' }] });
  const { ctx } = makeCtx();
  await shapeRaw({ name: 'alice', count: 7 }, ctx);
  const req = getLastReq();
  assert.ok(req, 'complete 被调用');
  assert.ok(req.instruction.includes('"alice"'), 'instruction 含 raw 文本内容');
  assert.ok(req.instruction.includes('"name"'), 'instruction 含 schema 字段名');
  assert.ok(req.instruction !== 'Parse the raw tool output', '不再使用 T10 最小英文模板');
});

// ───────────────────────────────────────────────────────────
// AC3：失败矩阵 reason 全路径
// ───────────────────────────────────────────────────────────

test('T14-AC3a: 模型不可用（supportsStructuredOutput=false）→ l3-unavailable', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  injectFake({ ready: false });
  const { ctx, getRecord } = makeCtx();
  const raw = { name: 'alice' };
  const shaped = await shapeRaw(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '不可用 fail-open 原样');
  assert.equal(getRecord().shaping.reason, 'l3-unavailable');
});

test('T14-AC3b: 超时（finishReason=timeout）→ l3-unavailable-timeout（不重试）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  const { getCompleteCalls } = injectFake({ responses: [{ object: null, finishReason: 'timeout' }] });
  const { ctx, getRecord } = makeCtx();
  await shapeRaw({ name: 'alice' }, ctx);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable-timeout');
  assert.equal(getCompleteCalls(), 1, '超时路径不重试（默认零重试）');
});

test('T14-AC3c: 引擎自身异常（complete throw）→ engine-error', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  injectFake({ throwOnComplete: true });
  const { ctx, getRecord } = makeCtx();
  const raw = { name: 'alice' };
  const shaped = await shapeRaw(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '引擎异常 fail-open 原样');
  assert.equal(getRecord().shaping.reason, 'engine-error');
});

test('T14-AC3d: quota → quota（会话配额超限）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  injectFake({ responses: [{ object: { name: 'alice' }, finishReason: 'stop' }] });
  const raw = { name: 'alice' };
  const { ctx } = makeCtx('s-44-quota');
  for (let i = 0; i < 50; i++) await shapeRaw(raw, ctx);
  const { ctx: ctx51, getRecord } = makeCtx('s-44-quota');
  await shapeRaw(raw, ctx51);
  assert.equal(getRecord().shaping.reason, 'quota');
});

// ───────────────────────────────────────────────────────────
// AC4：默认零重试 + 仅 l3-parse-error 防御性重试 1 次
// ───────────────────────────────────────────────────────────

test('T14-AC4a: GBNF 失效（finishReason=error）→ 重试 1 次，仍败 → l3-parse-error', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  const { getCompleteCalls } = injectFake({ responses: [{ object: null, finishReason: 'error' }] });
  const { ctx, getRecord } = makeCtx();
  const raw = { name: 'alice' };
  const shaped = await shapeRaw(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, 'parse-error fail-open 原样');
  assert.equal(getRecord().shaping.reason, 'l3-parse-error');
  assert.equal(getCompleteCalls(), 2, 'GBNF 失效防御性重试 1 次（共 2 次调用）');
});

test('T14-AC4b: GBNF 失效重试后成功 → 正常整形（applied:true）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  // 第一次 error（object null），第二次成功
  const { getCompleteCalls } = injectFake({
    responses: [
      { object: null, finishReason: 'error' },
      { object: { name: 'alice', count: 7 }, finishReason: 'stop' },
    ],
  });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRaw({ name: 'alice', count: 7 }, ctx);
  assert.deepEqual(shaped.data.result, { name: 'alice', count: 7 }, '重试后成功整形');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getCompleteCalls(), 2, '第一次失败后重试一次成功');
});

test('T14-AC4c: Q5 全丢零重试（模型已成功返回，仅字段被 Q5 丢光）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  const q5 = injectFake({ responses: [{ object: { name: 'nonexistent', count: 999 }, finishReason: 'stop' }] });
  const { ctx: c1, getRecord: r1 } = makeCtx('s-q5');
  await shapeRaw({ name: 'alice', count: 7 }, c1);
  assert.equal(r1().shaping.reason, 'q5-rejected');
  assert.equal(q5.getCompleteCalls(), 1, 'Q5 全丢不重试（零重试）');
});

// ───────────────────────────────────────────────────────────
// AC5 + AC6：Q5 衔接 + "不会"兜底
// ───────────────────────────────────────────────────────────

test('T14-AC5a: 白名单外字段丢 + 标量值不在 raw 丢字段（Q5）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  // ghost（白名单外）+ count=999（不在 raw）→ 丢；name 保留
  injectFake({ responses: [{ object: { name: 'alice', count: 999, ghost: 'x' }, finishReason: 'stop' }] });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRaw({ name: 'alice', count: 7 }, ctx);
  assert.deepEqual(shaped.data.result, { name: 'alice' }, 'ghost + count=999 被丢，name 保留');
  assert.equal(getRecord().shaping.applied, true);
});

test('T14-AC6a: "不会"兜底——模型输出幻觉 → 全丢 → 整体 fail-open 原样，主模型无损', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  // 模型幻觉：输出完全不在 raw 中的值
  injectFake({ responses: [{ object: { name: 'hallucinated', count: 12345, tags: ['madeup'] }, finishReason: 'stop' }] });
  const { ctx, getRecord } = makeCtx();
  const raw = { name: 'alice', count: 7, tags: ['red'] };
  const shaped = await shapeRaw(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '幻觉全丢 → 整体 fail-open 原样（系统回到未整形状态）');
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'q5-rejected');
});

test('T14-AC6b: 模型输出空对象 → 全丢 → fail-open，不污染主模型（无层标记）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  injectFake({ responses: [{ object: {}, finishReason: 'stop' }] });
  const { ctx } = makeCtx();
  const raw = { name: 'alice' };
  const shaped = await shapeRaw(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '空对象 → fail-open 原样');
  assert.deepEqual(shaped.data, { tool: PROBE, result: raw }, '无层标记、无额外字段');
});

// ───────────────────────────────────────────────────────────
// AC7：与 T10 引擎集成 e2e（runL3 直驱 + shapeToolResponse 全链路）
// ───────────────────────────────────────────────────────────

test('T14-AC7a: runL3 直驱——成功路径 reason=undefined，失败矩阵 reason 正确', async () => {
  // 成功
  injectFake({ responses: [{ object: { name: 'alice', count: 7 }, finishReason: 'stop' }] });
  const ok = await runL3({ name: 'alice', count: 7 }, SCHEMA, 'actions', 's-e2e');
  assert.deepEqual(ok.shaped, { name: 'alice', count: 7 });
  assert.equal(ok.reason, undefined, '成功无 reason');

  // isReady=false → l3-unavailable
  injectFake({ ready: false });
  const unavailable = await runL3({ name: 'alice' }, SCHEMA, 'actions', 's-e2e-2');
  assert.equal(unavailable.shaped, null);
  assert.equal(unavailable.reason, 'l3-unavailable');
});

test('T14-AC7b: env 一键关 L3 → passthrough（不调模型）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  const { getCompleteCalls } = injectFake({ responses: [{ object: { name: 'alice' }, finishReason: 'stop' }] });
  const saved = process.env.MYTERMINAL_L3_ENABLED;
  process.env.MYTERMINAL_L3_ENABLED = 'false';
  try {
    const { ctx, getRecord } = makeCtx();
    const raw = { name: 'alice' };
    const shaped = await shapeRaw(raw, ctx);
    assert.strictEqual(shaped.data.result, raw, '关 L3 → 原样 passthrough');
    assert.equal(getRecord().shaping.reason, 'passthrough');
    assert.equal(getCompleteCalls(), 0, '关 L3 不调模型');
  } finally {
    if (saved === undefined) delete process.env.MYTERMINAL_L3_ENABLED;
    else process.env.MYTERMINAL_L3_ENABLED = saved;
  }
});
