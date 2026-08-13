// ADR-0047 T04 (#32)：D12 失败双帽（error.message / details 长度帽 + continuation 子键保全）
//
// 验收覆盖（对应 #32 / D12 / Q4）：
//   AC1 小错误（message<2000、无 details）→ 逐字段不变（回归安全，保全 T03-AC2b）
//   AC2 error.message > 2000 → 截断到 2000；code / retryable 不动
//   AC3 error.details 为 string 且 > 6000 → 截断到 6000（Q4 双分支一）
//   AC4 error.details 为 object → 逐顶层 string 值截断到 6000；非 string 值保留；
//       continuation 子键整体原样保全（D12/Q4/D13 控制流）；键顺序保全
//   AC5 D7 双版本审计：raw 保留未截断完整 error；shaped 为截断版（诊断保全）
//   AC6 全通道通用：passthrough / L1 路径均套用帽（subagent 由 applyShape 早退不整形，D2）
//   AC7 D17 静默：截断后结果 / error 无任何层标记
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js）；遵循 issue-31 seam。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  capError,
  ERROR_MESSAGE_MAX_CHARS,
  ERROR_DETAILS_MAX_CHARS,
  shapeToolResponse,
  TOOL_SHAPES,
} from '../dist/tool-parse.js';

// D17 静默契约：任何层都不插自标识标记
const MARKER_KEYS = ['_shapedBy', '_l1Applied', '_l2Applied', '_l3Applied', '_capError'];

function assertNoShapingMarkers(value, at = 'root') {
  if (Array.isArray(value)) { for (const item of value) assertNoShapingMarkers(item, `${at}[]`); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assertNoShapingMarkers(item, `${at}.${key}`);
  }
}

function makeCtx(toolDefs = {}) {
  let record;
  const ctx = {
    transport: 'actions',
    sessionId: 's-32',
    resolveTool: (name) => toolDefs[name],
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

// CommandResult 权威 10 字段（被动去噪后保留 5 个真实数据字段）
const FULL_COMMAND_RESULT = {
  command: 'echo hi', cwd: '/tmp', exitCode: 0, signal: null, timedOut: false,
  stdout: 'hi', stderr: '', truncated: false, durationMs: 12, cancelled: false,
};

// ───────────────────────────────────────────────────────────
// 常量
// ───────────────────────────────────────────────────────────

test('T04-const: ERROR_MESSAGE_MAX_CHARS=2000 / ERROR_DETAILS_MAX_CHARS=6000', () => {
  assert.equal(ERROR_MESSAGE_MAX_CHARS, 2000);
  assert.equal(ERROR_DETAILS_MAX_CHARS, 6000);
});

// ───────────────────────────────────────────────────────────
// AC1：小错误不变（回归安全）
// ───────────────────────────────────────────────────────────

test('T04-AC1: 小错误（message<2000、无 details）逐字段不变，返回同一 error 引用', () => {
  const { ctx } = makeCtx();
  const error = { code: 'NON_ZERO_EXIT', message: 'boom', retryable: false };
  const resp = { ok: false, data: { tool: 'execute_cli', result: {} }, error };
  const shaped = shapeToolResponse(resp, ctx);
  assert.deepEqual(shaped.error, error, '小错误三要素原样（D9/D12 不误伤）');
  assert.strictEqual(shaped.error, error, '无截断时返回同一 error 引用（无副作用）');
});

// ───────────────────────────────────────────────────────────
// AC2：error.message 截断
// ───────────────────────────────────────────────────────────

test('T04-AC2: error.message > 2000 截断到 2000，code/retryable 不动', () => {
  const { ctx } = makeCtx();
  const error = { code: 'X', message: 'm'.repeat(5000), retryable: true };
  const resp = { ok: false, data: { tool: 'workspace_info', result: { path: '/tmp' } }, error };
  const shaped = shapeToolResponse(resp, ctx);
  assert.equal(shaped.error.message.length, 2000);
  assert.equal(shaped.error.code, 'X');
  assert.equal(shaped.error.retryable, true);
  // workspace_info 未声明 → result passthrough；但 error 仍走 D12 通用帽
  assert.equal(shaped.error.message.length, ERROR_MESSAGE_MAX_CHARS);
});

test('T04-unit: capError 纯函数 — message 截断且不改 code/retryable', () => {
  const capped = capError({ code: 'X', message: 'a'.repeat(5000), retryable: false });
  assert.equal(capped.message.length, 2000);
  assert.equal(capped.code, 'X');
  assert.equal(capped.retryable, false);
});

// ───────────────────────────────────────────────────────────
// AC3：error.details 为 string → 截断（Q4 双分支一）
// ───────────────────────────────────────────────────────────

test('T04-AC3: error.details string > 6000 截断到 6000（Q4 双分支一）', () => {
  const { ctx } = makeCtx();
  const error = { code: 'X', message: 'm', retryable: false, details: 'd'.repeat(9000) };
  const resp = { ok: false, data: { tool: 'workspace_info', result: {} }, error };
  const shaped = shapeToolResponse(resp, ctx);
  assert.equal(typeof shaped.error.details, 'string');
  assert.equal(shaped.error.details.length, 6000);
});

// ───────────────────────────────────────────────────────────
// AC4：error.details object — 逐顶层 string 值截断 + continuation 保全 + 顺序保全
// ───────────────────────────────────────────────────────────

test('T04-AC4: error.details object — 逐 string 值截断 + continuation 子键保全 + 顺序保全', () => {
  const { ctx } = makeCtx();
  const continuation = {
    status: 'working', mustContinue: true, taskComplete: false, continuationMode: 'adaptive',
    nextCall: { tool: 'x', input: { a: 1 }, purpose: 'p' },
  };
  const error = {
    code: 'PLANNED_CALL_FAILED', message: 'm', retryable: false,
    details: {
      text: 't'.repeat(9000),
      stack: 's'.repeat(9000),
      code: 42,                                  // 非 string 值保留
      nested: { inner: 'n'.repeat(9000) },       // 嵌套对象：本票只截顶层 string 值，保留原样
      continuation,
    },
  };
  const resp = { ok: false, data: { tool: 'workspace_info', result: {} }, error };
  const shaped = shapeToolResponse(resp, ctx);
  const d = shaped.error.details;
  assert.equal(d.text.length, 6000, 'text 截断');
  assert.equal(d.stack.length, 6000, 'stack 截断');
  assert.equal(d.code, 42, '非 string 值（number）保留');
  assert.deepEqual(d.nested, { inner: 'n'.repeat(9000) }, '嵌套对象原样（本票不递归截断）');
  assert.strictEqual(d.continuation, continuation, 'continuation 子键整体原样保全（D12/Q4/D13 控制流）');
  assert.deepEqual(Object.keys(d), ['text', 'stack', 'code', 'nested', 'continuation'], '键顺序保全');
});

// ───────────────────────────────────────────────────────────
// AC5：D7 双版本审计（raw 完整 / shaped 截断）
// ───────────────────────────────────────────────────────────

test('T04-AC5: D7 双版本审计 — raw 保留未截断完整 error，shaped 为截断版', () => {
  const { ctx, getRecord } = makeCtx();
  const error = { code: 'X', message: 'm'.repeat(5000), retryable: false, details: 'd'.repeat(9000) };
  const resp = { ok: false, data: { tool: 'workspace_info', result: {} }, error };
  shapeToolResponse(resp, ctx);
  const rec = getRecord();
  assert.equal(rec.rawResult.error.message.length, 5000, 'raw 保留完整 message');
  assert.equal(rec.rawResult.error.details.length, 9000, 'raw 保留完整 details');
  assert.equal(rec.shapedResult.error.message.length, 2000, 'shaped message 截断');
  assert.equal(rec.shapedResult.error.details.length, 6000, 'shaped details 截断');
});

// ───────────────────────────────────────────────────────────
// AC6：全通道通用（passthrough / L1 均套帽）
// ───────────────────────────────────────────────────────────

test('T04-AC6a: passthrough 工具（workspace_info）仍套 D12 帽', () => {
  const { ctx, getRecord } = makeCtx();
  const error = { code: 'X', message: 'm'.repeat(5000), retryable: false };
  const resp = { ok: false, data: { tool: 'workspace_info', result: { path: '/tmp' } }, error };
  const shaped = shapeToolResponse(resp, ctx);
  assert.equal(shaped.error.message.length, 2000);
  assert.equal(getRecord().shaping.applied, false, 'result 仍是 passthrough，但 error 已帽');
});

test('T04-AC6b: L1 路径（execute_cli 去噪）同时帽 error', () => {
  const { ctx, getRecord } = makeCtx();
  const error = { code: 'NON_ZERO_EXIT', message: 'm'.repeat(5000), retryable: false };
  const resp = { ok: false, data: { tool: 'execute_cli', result: { ...FULL_COMMAND_RESULT, exitCode: 3 } }, error };
  const shaped = shapeToolResponse(resp, ctx);
  assert.equal(shaped.data.result.command, undefined, 'L1 去噪仍生效');
  assert.equal(shaped.data.result.exitCode, 3);
  assert.equal(shaped.error.message.length, 2000, 'L1 路径 error 同时被帽');
  assert.equal(getRecord().shaping.applied, true);
});

// ───────────────────────────────────────────────────────────
// AC7：D17 静默（无层标记）
// ───────────────────────────────────────────────────────────

test('T04-AC7: D17 静默 — 截断后结果 / error 无层标记', () => {
  const { ctx } = makeCtx();
  const error = { code: 'X', message: 'm'.repeat(5000), retryable: false, details: { text: 't'.repeat(9000) } };
  const resp = { ok: false, data: { tool: 'workspace_info', result: {} }, error };
  const shaped = shapeToolResponse(resp, ctx);
  assertNoShapingMarkers(shaped);
});
