// ADR-0051 P2-02 (#98)：D12 双帽 env 旋钮（0050 H1 / D15 可配置落地）
//
// 验收覆盖（对应 #98 / D12 / D15）：
//   AC1 env 注入 3000/9000 → message / details 帽生效（两旋钮独立，经 capError 纯函数
//       与 shapeToolResponse 全通道双入口）
//   AC2 非法值（非数字 / 负）→ 回落默认 2000/6000
//   AC3 未设置 → 默认 2000/6000（与 issue-32 T04-const 既有锁定一致）
//   AC4 continuation 子键保全不因帽值变化破坏（env 生效时仍整体原样）
//   AC5 单旋钮独立：只设 message 旋钮不动 details 帽（反之亦然）
//   AC6 D17 静默：env 生效截断后结果 / error 无层标记
//
// 测试方式：单测直接驱动 capError / shapeToolResponse（../dist/tool-parse.js），
// 遵循 issue-32 seam。帽值为惰性解析（每次调用读 env），同一文件内逐用例注入/
// 删除 env 互不干扰（D6 配额 l3MaxPerSession 同构手法）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import {
  capError,
  ERROR_MESSAGE_MAX_CHARS,
  ERROR_DETAILS_MAX_CHARS,
  shapeToolResponse,
} from '../dist/tool-parse.js';

const ENV_MESSAGE = 'MYTERMINAL_ERROR_MESSAGE_MAX_CHARS';
const ENV_DETAILS = 'MYTERMINAL_ERROR_DETAILS_MAX_CHARS';

afterEach(() => {
  delete process.env[ENV_MESSAGE];
  delete process.env[ENV_DETAILS];
});

// D17 静默契约：任何层都不插自标识标记（issue-32 同款）
const MARKER_KEYS = ['_shapedBy', '_l1Applied', '_l2Applied', '_l3Applied', '_capError'];

function assertNoShapingMarkers(value, at = 'root') {
  if (Array.isArray(value)) { for (const item of value) assertNoShapingMarkers(item, `${at}[]`); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assertNoShapingMarkers(item, `${at}.${key}`);
  }
}

function makeCtx() {
  let record;
  const ctx = {
    transport: 'actions',
    sessionId: 's-98',
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

// ───────────────────────────────────────────────────────────
// AC1：env 注入 3000/9000 → 帽生效（独立旋钮）
// ───────────────────────────────────────────────────────────

test('AC1a: capError 纯函数 — env 3000/9000 → message 5000→3000、details string 12000→9000', async () => {
  process.env[ENV_MESSAGE] = '3000';
  process.env[ENV_DETAILS] = '9000';
  const capped = capError({ code: 'X', message: 'm'.repeat(5000), retryable: false, details: 'd'.repeat(12000) });
  assert.equal(capped.message.length, 3000, 'message 按 env 帽截断');
  assert.equal(capped.details.length, 9000, 'details string 按 env 帽截断');
  assert.equal(capped.code, 'X', 'code 原样');
  assert.equal(capped.retryable, false, 'retryable 原样');
});

test('AC1b: shapeToolResponse 全通道 — env 生效后 error 被新帽截断（D7 审计 raw 仍保全）', async () => {
  process.env[ENV_MESSAGE] = '3000';
  const { ctx, getRecord } = makeCtx();
  const resp = { ok: false, data: { tool: 'workspace_info', result: {} }, error: { code: 'X', message: 'm'.repeat(5000), retryable: false } };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.equal(shaped.error.message.length, 3000, '全通道套 env 帽');
  assert.equal(getRecord().rawResult.error.message.length, 5000, 'raw 保留完整 error（诊断保全）');
});

// ───────────────────────────────────────────────────────────
// AC2：非法值 → 回落默认 2000/6000
// ───────────────────────────────────────────────────────────

test('AC2a: 非数字 env → 回落默认 2000/6000', async () => {
  process.env[ENV_MESSAGE] = 'abc';
  process.env[ENV_DETAILS] = '12x3';
  const capped = capError({ code: 'X', message: 'm'.repeat(5000), retryable: false, details: 'd'.repeat(12000) });
  assert.equal(capped.message.length, ERROR_MESSAGE_MAX_CHARS, '非数字回落默认 message 帽');
  assert.equal(capped.details.length, ERROR_DETAILS_MAX_CHARS, '非数字回落默认 details 帽');
});

test('AC2b: 负值 env → 回落默认 2000/6000', async () => {
  process.env[ENV_MESSAGE] = '-5';
  process.env[ENV_DETAILS] = '-100';
  const capped = capError({ code: 'X', message: 'm'.repeat(5000), retryable: false, details: 'd'.repeat(12000) });
  assert.equal(capped.message.length, ERROR_MESSAGE_MAX_CHARS, '负值回落默认 message 帽');
  assert.equal(capped.details.length, ERROR_DETAILS_MAX_CHARS, '负值回落默认 details 帽');
});

test('AC2c: 空串 / 纯空白 env → 回落默认（D6 配额同构）', async () => {
  process.env[ENV_MESSAGE] = '';
  process.env[ENV_DETAILS] = '   ';
  const capped = capError({ code: 'X', message: 'm'.repeat(5000), retryable: false, details: 'd'.repeat(12000) });
  assert.equal(capped.message.length, ERROR_MESSAGE_MAX_CHARS);
  assert.equal(capped.details.length, ERROR_DETAILS_MAX_CHARS);
});

// ───────────────────────────────────────────────────────────
// AC3：未设置 → 默认 2000/6000（issue-32 锁定不回归）
// ───────────────────────────────────────────────────────────

test('AC3: env 未设置 → 默认 2000/6000', async () => {
  const capped = capError({ code: 'X', message: 'm'.repeat(5000), retryable: false, details: 'd'.repeat(12000) });
  assert.equal(capped.message.length, 2000, '默认 message 帽');
  assert.equal(capped.details.length, 6000, '默认 details 帽');
  assert.equal(capped.message.length, ERROR_MESSAGE_MAX_CHARS);
  assert.equal(capped.details.length, ERROR_DETAILS_MAX_CHARS);
});

// ───────────────────────────────────────────────────────────
// AC4：continuation 子键保全不因帽值变化破坏
// ───────────────────────────────────────────────────────────

test('AC4: env 帽生效时 continuation 子键仍整体原样保全 + 键顺序保全', async () => {
  process.env[ENV_MESSAGE] = '3000';
  process.env[ENV_DETAILS] = '9000';
  const continuation = {
    status: 'working', mustContinue: true, taskComplete: false, continuationMode: 'adaptive',
    nextCall: { tool: 'x', input: { a: 1 }, purpose: 'p' },
  };
  const error = {
    code: 'PLANNED_CALL_FAILED', message: 'm'.repeat(5000), retryable: false,
    details: {
      text: 't'.repeat(12000),
      stack: 's'.repeat(12000),
      code: 42,
      continuation,
    },
  };
  const capped = capError(error);
  const d = capped.details;
  assert.equal(d.text.length, 9000, 'text 按 env 帽截断');
  assert.equal(d.stack.length, 9000, 'stack 按 env 帽截断');
  assert.equal(d.code, 42, '非 string 值保留');
  assert.strictEqual(d.continuation, continuation, 'continuation 子键整体原样保全（D12/Q4/D13 控制流）');
  assert.deepEqual(Object.keys(d), ['text', 'stack', 'code', 'continuation'], '键顺序保全');
  assert.equal(capped.message.length, 3000, 'message 按 env 帽截断');
});

// ───────────────────────────────────────────────────────────
// AC5：单旋钮独立（只设一个不动另一个）
// ───────────────────────────────────────────────────────────

test('AC5a: 只设 message 旋钮 → details 仍走默认 6000', async () => {
  process.env[ENV_MESSAGE] = '3000';
  const capped = capError({ code: 'X', message: 'm'.repeat(5000), retryable: false, details: 'd'.repeat(12000) });
  assert.equal(capped.message.length, 3000, 'message 按 env 帽');
  assert.equal(capped.details.length, 6000, 'details 未设置 → 默认帽');
});

test('AC5b: 只设 details 旋钮 → message 仍走默认 2000', async () => {
  process.env[ENV_DETAILS] = '9000';
  const capped = capError({ code: 'X', message: 'm'.repeat(5000), retryable: false, details: 'd'.repeat(12000) });
  assert.equal(capped.message.length, 2000, 'message 未设置 → 默认帽');
  assert.equal(capped.details.length, 9000, 'details 按 env 帽');
});

// ───────────────────────────────────────────────────────────
// AC6：D17 静默（env 生效截断后无层标记）
// ───────────────────────────────────────────────────────────

test('AC6: env 生效截断后结果 / error 无层标记（D17 静默）', async () => {
  process.env[ENV_MESSAGE] = '3000';
  process.env[ENV_DETAILS] = '9000';
  const { ctx } = makeCtx();
  const error = { code: 'X', message: 'm'.repeat(5000), retryable: false, details: { text: 't'.repeat(12000) } };
  const resp = { ok: false, data: { tool: 'workspace_info', result: {} }, error };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.equal(shaped.error.message.length, 3000);
  assert.equal(shaped.error.details.text.length, 9000);
  assertNoShapingMarkers(shaped);
});
