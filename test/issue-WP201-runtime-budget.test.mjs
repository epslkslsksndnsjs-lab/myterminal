// ADR-0051 P2-01 (#97)：RAW_BUDGET_TOKENS 运行时化 — 预算门按 L3 适配器 ctx 动态计算
// 0050 H2：`min(24000, L3_ctx − 2048)` 公式运行时落地；当前模型（256K / 32K 运行时）仍得
// 24000 —— 零行为变化；小 ctx 模型自动降门槛。
//
// 验收断言：
//   AC1  阈值公式三档：ctx 8192 → 6144；ctx 32768 → 24000；ctx 262144 → 24000
//   AC1d trainContextSize 兜底 + contextSize 优先（adapter 暴露 trainContextSize/contextSize）
//   AC1e 无 adapter ctx 信息（默认）→ 维持 24000（当前模型零行为变化）
//   AC2  降门槛档位（ctx 8192 → 6144）下路由行为正确：
//        - 超门（~7.5K tokens，低于默认 24K）→ L3 不启动（双条目回落 L1 / 纯 schema passthrough）
//        - 未超门（~2.5K tokens）→ L3 启动
//   AC3  嵌套门（Q7）降门槛：嵌套 opJson > 6144 → fail-open 回原始 operation（默认 24K 下不会触发）
//   AC4  subagent_status 门（D2 L3-if-small）降门槛：result 子字段 > 6144 → passthrough over-budget
//
// 测试方式：单测直接驱动 l3BudgetTokens（dist/tool-parse.js）+ 注入 fake adapter
// （dist/l3/registry.js，issue-38 手法；fake 带 contextSize/trainContextSize 字段）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import {
  shapeToolResponse,
  TOOL_SHAPES,
  l3BudgetTokens,
  RAW_BUDGET_TOKENS,
  clearOperationCache,
} from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter, resetL3AdapterInstance } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';

const PROBE = 't97_runtime_budget_probe';
const SCHEMA = { type: 'object', properties: { name: { type: 'string' } } };
/** 双条目 L1 侧：打标 l1:'ran'，证明 L1 是否被应用（L3 成功时不得出现）。 */
const dualReduce = (r) => ({ ...r, l1: 'ran' });

// 降门槛档位下「超门但不超默认 24K」的结果：~30K 拉丁 → ~7.5K tokens（> 6144 且 < 24000）
const BIG_BUT_NOT_DEFAULT_OVER = { name: 'alice', big: 'x'.repeat(30000) };
// 未超门（降门槛）结果：~10K 拉丁 → ~2.5K tokens（< 6144）
const SMALL_UNDER_LOWERED = { name: 'alice', big: 'x'.repeat(10000) };

/** 注入 fake adapter（可带 contextSize / trainContextSize；注入前先清单例，W201 手法）。 */
function injectFake({ object = { name: 'alice' }, finishReason = 'stop', contextSize, trainContextSize } = {}) {
  resetL3Adapter(); // 清旧单例，让本次 factory 在下次懒加载生效（单例常驻语义）
  let calls = 0;
  let lastReq = null;
  const adapter = {
    id: 'fake',
    supportsStructuredOutput: true,
    ...(contextSize !== undefined ? { contextSize } : {}),
    ...(trainContextSize !== undefined ? { trainContextSize } : {}),
    isReady: async () => true,
    complete: async (req) => {
      calls += 1;
      lastReq = req;
      return { object, finishReason, latencyMs: 1, modelId: 'fake' };
    },
  };
  registerAdapterFactory(() => adapter);
  return { adapter, callCount: () => calls, getLastReq: () => lastReq };
}

function makeCtx(sessionId = 's-97', transport = 'actions') {
  let record;
  const ctx = {
    transport,
    sessionId,
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

// task_poll 嵌套结构（issue-33 手法，最小集）
function makeTaskPoll(nestedOperation) {
  return {
    ok: true,
    data: {
      tool: 'task_poll',
      result: {
        taskId: 't-97',
        status: 'completed',
        startedAt: '2026-08-15T00:00:00Z',
        completedAt: '2026-08-15T00:00:01Z',
        operation: nestedOperation,
      },
    },
  };
}

// subagent_status 完整结构（issue-45 手法，最小集）
function makeStatusResult({ result = 'final report: all tests passed' } = {}) {
  return {
    status: 'completed',
    sessionId: 'child-1',
    tasks: [{ id: 't1', status: 'completed', description: 'do the thing' }],
    usage: { inputTokens: 100, outputTokens: 50 },
    result,
    origin: { type: 'skill', skillName: 'demo' },
    auditLogs: [{ type: 'tool_audit', tool: 'execute_cli' }],
  };
}

function shapeRaw(result, ctx) {
  return shapeToolResponse({ ok: true, data: { tool: PROBE, result } }, ctx);
}

afterEach(() => {
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）
  clearL3Quota();
  TOOL_SHAPES.delete(PROBE);
});

// ───────────────────────────────────────────────────────────
// AC1：阈值公式三档 + 兜底/优先 + 默认零行为变化
// ───────────────────────────────────────────────────────────

test('WP201-AC1a: ctx 8192 → 门槛 6144（min(24000, 8192−2048)）', () => {
  assert.equal(l3BudgetTokens({ contextSize: 8192 }), 6144);
});

test('WP201-AC1b: ctx 32768 → 门槛 24000（min(24000, 32768−2048)）', () => {
  assert.equal(l3BudgetTokens({ contextSize: 32768 }), RAW_BUDGET_TOKENS);
});

test('WP201-AC1c: ctx 262144（256K）→ 门槛 24000（当前模型零行为变化）', () => {
  assert.equal(l3BudgetTokens({ contextSize: 262144 }), RAW_BUDGET_TOKENS);
});

test('WP201-AC1d: trainContextSize 兜底（contextSize 未知时用模型 max ctx）；contextSize 优先', () => {
  assert.equal(l3BudgetTokens({ trainContextSize: 8192 }), 6144, '仅 trainContextSize → 兜底');
  assert.equal(l3BudgetTokens({ contextSize: 32768, trainContextSize: 8192 }), RAW_BUDGET_TOKENS, 'contextSize 优先于 trainContextSize');
});

test('WP201-AC1e: 无 adapter ctx 信息（默认 256K）→ 维持 24000；registry 空参读取注入 adapter', () => {
  injectFake(); // fake 不带 ctx 字段 → 走默认
  assert.equal(l3BudgetTokens(), RAW_BUDGET_TOKENS);
});

// ───────────────────────────────────────────────────────────
// AC2：降门槛档位（ctx 8192 → 6144）下超门/未超门路由正确
// ───────────────────────────────────────────────────────────

test('WP201-AC2a: 降门槛超门（~7.5K tokens，默认 24K 下不算超）→ L3 不启动，双条目回落 L1，reason=over-budget', async () => {
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  const { callCount } = injectFake({ contextSize: 8192 });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeRaw(BIG_BUT_NOT_DEFAULT_OVER, ctx);
  assert.equal(callCount(), 0, '超门不调 L3 模型（降门槛生效：默认 24K 下此结果会进 L3）');
  assert.equal(shaped.data.result.l1, 'ran', '回落 L1 reduce 生效');
  assert.equal(getRecord().shaping.applied, true, '回落发生则 applied:true');
  assert.equal(getRecord().shaping.reason, 'over-budget', '审计 reason=over-budget');
});

test('WP201-AC2b: 降门槛未超门（~2.5K tokens < 6144）→ L3 启动', async () => {
  TOOL_SHAPES.set(PROBE, { reduce: dualReduce, schema: SCHEMA });
  const { callCount } = injectFake({ contextSize: 8192 });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeRaw(SMALL_UNDER_LOWERED, ctx);
  assert.equal(callCount(), 1, '未超门调 L3 模型');
  assert.deepEqual(shaped.data.result, { name: 'alice' }, 'Q5 后结果（big 白名单外字段丢）');
  assert.equal(shaped.data.result.l1, undefined, 'L3 成功绝不叠跑 L1（D2 链式禁忌）');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined, 'L3 成功无 reason');
});

test('WP201-AC2c: 降门槛超门 + 纯 schema 条目 → passthrough 原样（reason=over-budget）', async () => {
  TOOL_SHAPES.set(PROBE, { schema: SCHEMA });
  const { callCount } = injectFake({ contextSize: 8192 });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeRaw(BIG_BUT_NOT_DEFAULT_OVER, ctx);
  assert.strictEqual(shaped.data.result, BIG_BUT_NOT_DEFAULT_OVER, '超预算原样引用（不调模型）');
  assert.equal(callCount(), 0);
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'over-budget');
});

// ───────────────────────────────────────────────────────────
// AC3：Q7 嵌套预算门降门槛（爆炸半径：嵌套消费点）
// ───────────────────────────────────────────────────────────

test('WP201-AC3: 降门槛嵌套超门（opJson ~7.5K tokens > 6144）→ fail-open 回原始 operation，外层记 nested-over-budget', async () => {
  clearOperationCache();
  injectFake({ contextSize: 8192 }); // 注入降门槛 adapter（嵌套门走 registry）
  const records = [];
  const ctx = {
    transport: 'actions',
    sessionId: 's-97-nested',
    resolveTool: () => undefined,
    audit: (r) => { records.push(r); },
  };
  // 嵌套 operation：~30K 拉丁 → ~7.5K tokens（> 6144；默认 24K 下不触发 —— 证明运行时阈值生效）
  const nested = { ok: true, data: { tool: 'execute_cli', result: { big: 'x'.repeat(30000) } } };
  const resp = makeTaskPoll(nested);
  const shaped = await shapeToolResponse(resp, ctx);

  assert.strictEqual(shaped.data.result.operation, nested, 'Q7：超大嵌套回退原始 operation（同引用）');
  assert.equal(shaped.data.tool, 'task_poll', '外层 task_poll 结构保留');
  const outer = records[records.length - 1];
  assert.equal(outer.shaping.reason, 'nested-over-budget', 'Q7 原因记外层审计');
  assert.equal(outer.shaping.applied, false);
});

// ───────────────────────────────────────────────────────────
// AC4：subagent_status 门（D2 L3-if-small）降门槛（爆炸半径：subagent 消费点）
// ───────────────────────────────────────────────────────────

test('WP201-AC4: subagent_status result 子字段超降门槛（~7.5K tokens > 6144）→ passthrough over-budget，不调模型', async () => {
  const { getLastReq } = injectFake({ contextSize: 8192 });
  const { ctx, getRecord } = makeCtx('s-97-subagent');
  const raw = makeStatusResult({ result: 'x'.repeat(30000) }); // ~7.5K tokens > 6144（默认 24K 下不触发）
  const shaped = await shapeToolResponse({ ok: true, data: { tool: 'subagent_status', result: raw } }, ctx);

  assert.strictEqual(shaped.data.result, raw, '超预算 fail-open 原样（result 原文不伪造）');
  assert.equal(getLastReq(), null, '超预算不调 L3 模型');
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'over-budget');
});
