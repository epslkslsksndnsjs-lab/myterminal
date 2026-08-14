// ADR-0047 T05 (#33)：D13 task_poll 递归整形 + Q7 嵌套预算门 + Q6 递归 fail-open
//                       + Q8 operation 缓存 + Q10 嵌套审计 + D17 静默。
//
// 验收覆盖（对应 #33 / D13 / Q6 / Q7 / Q8 / Q10）：
//   AC1 D13 递归：task_poll 嵌套 execute_cli operation → data.result 走 L1 去噪
//   AC2 保全：递归后 operation.ok / operation.data.tool 原样不动
//   AC3 嵌套 error：operation.error 走 D12 双帽（message 截断）+ continuation 子键保全
//   AC4 Q7 嵌套预算门：嵌套 raw 超 RAW_BUDGET_TOKENS → 该嵌套层 fail-open 回原始 operation，
//       外层 task_poll 结构保留，audit 记 nested-over-budget
//   AC5 Q6 递归 fail-open：递归层任一异常 → 用原始 operation 整体替换，绝不半成品，
//       audit 记 nested-recursion-threw
//   AC6 Q8 缓存：同 taskId+raw 再次 poll 命中缓存，免重整形（resolveTool 不重调嵌套）、同引用
//   AC7 Q10 审计：双层覆盖——递归调用产嵌套 raw/shaped + 外层全量 response 快照
//   AC8 D17 静默：整形后无任何层标记
//   AC9 边界（D11）：非 task_poll / 无 operation / 畸形 operation → passthrough 无副作用
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js）；遵循 issue-31/32 seam。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  shapeToolResponse,
  clearOperationCache,
  RAW_BUDGET_TOKENS,
  ERROR_MESSAGE_MAX_CHARS,
  ERROR_DETAILS_MAX_CHARS,
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

// CommandResult 权威 10 字段（被动去噪后保留 5 个真实数据字段）
const FULL_COMMAND_RESULT = {
  command: 'echo hi', cwd: '/tmp', exitCode: 0, signal: null, timedOut: false,
  stdout: 'hi', stderr: '', truncated: false, durationMs: 12, cancelled: false,
};

// 收集全部审计记录（数组，保留嵌套 + 外层双层）
function makeCtxCollect(toolDefs = {}) {
  const records = [];
  const ctx = {
    transport: 'actions',
    sessionId: 's-33',
    resolveTool: (name) => toolDefs[name],
    audit: (r) => { records.push(r); },
  };
  return { ctx, records };
}

// 构造 task_poll 响应（含完整嵌套 operation）
function makeTaskPoll(nestedOperation, { taskId = 't-33', status = 'completed' } = {}) {
  return {
    ok: true,
    data: {
      tool: 'task_poll',
      result: {
        taskId,
        status,
        startedAt: '2026-08-14T00:00:00Z',
        completedAt: '2026-08-14T00:00:01Z',
        operation: nestedOperation,
      },
    },
  };
}

// 嵌套 execute_cli operation（成功态）
function nestedExecuteCli(result = FULL_COMMAND_RESULT, ok = true) {
  return { ok, data: { tool: 'execute_cli', result: { ...result } } };
}

// ───────────────────────────────────────────────────────────
// AC1：D13 递归去噪
// ───────────────────────────────────────────────────────────

test('T05-AC1: task_poll 嵌套 execute_cli → data.result 走 L1 去噪（D13 递归）', async () => {
  clearOperationCache();
  const { ctx } = makeCtxCollect();
  const nested = nestedExecuteCli({ ...FULL_COMMAND_RESULT, exitCode: 0 });
  const resp = makeTaskPoll(nested);
  const shaped = await shapeToolResponse(resp, ctx);

  const op = shaped.data.result.operation;
  assert.equal(op.data.tool, 'execute_cli', '嵌套 data.tool 保全');
  assert.equal(op.data.result.command, undefined, 'D13 递归内层去噪生效（command 剥除）');
  assert.equal(op.data.result.cwd, undefined, 'cwd 剥除');
  assert.equal(op.data.result.signal, undefined, 'signal 剥除');
  assert.equal(op.data.result.timedOut, undefined, 'timedOut 剥除');
  assert.equal(op.data.result.cancelled, undefined, 'cancelled 剥除');
  assert.equal(op.data.result.stdout, 'hi', '真实数据字段（stdout）保留');
  assert.equal(op.data.result.exitCode, 0, 'exitCode 保留');
});

// ───────────────────────────────────────────────────────────
// AC2：保全 operation.ok / data.tool
// ───────────────────────────────────────────────────────────

test('T05-AC2: 递归后 operation.ok 与 data.tool 原样不动（长任务成败信号 / 工具身份）', async () => {
  clearOperationCache();
  const { ctx } = makeCtxCollect();
  const nested = nestedExecuteCli({ ...FULL_COMMAND_RESULT, exitCode: 3 }, false);
  const resp = makeTaskPoll(nested);
  const shaped = await shapeToolResponse(resp, ctx);

  const op = shaped.data.result.operation;
  assert.equal(op.ok, false, 'operation.ok 原样（失败态）');
  assert.equal(op.data.tool, 'execute_cli', 'operation.data.tool 原样');
  // 外层 task_poll 包装字段保全
  assert.equal(shaped.data.tool, 'task_poll');
  assert.equal(shaped.data.result.taskId, 't-33');
  assert.equal(shaped.data.result.status, 'completed');
});

// ───────────────────────────────────────────────────────────
// AC3：嵌套 error 走 D12 双帽 + continuation 保全
// ───────────────────────────────────────────────────────────

test('T05-AC3: 嵌套 operation.error 走 D12 帽（message 截断）+ continuation 子键保全', async () => {
  clearOperationCache();
  const { ctx } = makeCtxCollect();
  const continuation = {
    status: 'working', mustContinue: true, taskComplete: false, continuationMode: 'adaptive',
    nextCall: { tool: 'x', input: { a: 1 }, purpose: 'p' },
  };
  const nested = {
    ok: false,
    data: { tool: 'execute_cli', result: { ...FULL_COMMAND_RESULT, exitCode: 3 } },
    error: {
      code: 'NON_ZERO_EXIT', message: 'm'.repeat(5000), retryable: false,
      details: { text: 't'.repeat(9000), continuation },
    },
  };
  const resp = makeTaskPoll(nested);
  const shaped = await shapeToolResponse(resp, ctx);

  const err = shaped.data.result.operation.error;
  assert.equal(err.message.length, ERROR_MESSAGE_MAX_CHARS, '嵌套 error.message 截断');
  assert.equal(err.code, 'NON_ZERO_EXIT', 'code 不动');
  assert.equal(err.retryable, false, 'retryable 不动');
  assert.equal(err.details.text.length, ERROR_DETAILS_MAX_CHARS, '嵌套 details.text 截断');
  assert.strictEqual(err.details.continuation, continuation, '嵌套 continuation 子键整体原样保全（D13 控制流）');
});

// ───────────────────────────────────────────────────────────
// AC4：Q7 嵌套预算门 fail-open
// ───────────────────────────────────────────────────────────

test('T05-AC4: 嵌套 raw 超 RAW_BUDGET_TOKENS → 该嵌套层 fail-open 回原始 operation，外层保留，记 nested-over-budget', async () => {
  clearOperationCache();
  const { ctx, records } = makeCtxCollect();
  // 超大嵌套结果：~100K latin chars → estimateTokens ≈ 25K > 24K
  const bigResult = { big: 'x'.repeat(100000) };
  const nested = nestedExecuteCli(bigResult, true);
  const resp = makeTaskPoll(nested);
  const shaped = await shapeToolResponse(resp, ctx);

  // 嵌套 operation 原样回退（同引用，未整形）
  assert.strictEqual(shaped.data.result.operation, nested, 'Q7：超大嵌套回退原始 operation（同引用）');
  // 外层 task_poll 结构保留
  assert.equal(shaped.data.tool, 'task_poll');
  assert.equal(shaped.data.result.taskId, 't-33');
  assert.equal(shaped.data.result.operation.data.result.big.length, 100000, '嵌套大结果未动');

  const outer = records[records.length - 1];
  assert.equal(outer.shaping.reason, 'nested-over-budget', 'Q7 原因记外层审计');
  assert.equal(outer.shaping.applied, false);
});

// ───────────────────────────────────────────────────────────
// AC5：Q6 递归 fail-open
// ───────────────────────────────────────────────────────────

test('T05-AC5: 递归层异常 → 整层回退原始 operation（绝不半成品），记 nested-recursion-threw', async () => {
  clearOperationCache();
  // 仅当审计嵌套 operation（data.tool !== 'task_poll'）时抛错，模拟递归层异常；
  // 外层 task_poll 审计放行，避免外层也抛。
  const records = [];
  const ctx = {
    transport: 'actions',
    sessionId: 's-33',
    resolveTool: () => undefined,
    audit: (r) => {
      if (r.rawResult?.data?.tool !== 'task_poll') throw new Error('模拟递归层 audit 异常');
      records.push(r);
    },
  };
  const nested = nestedExecuteCli({ ...FULL_COMMAND_RESULT, exitCode: 0 }, true);
  const resp = makeTaskPoll(nested);
  let threw = false;
  let shaped;
  try { shaped = await shapeToolResponse(resp, ctx); } catch { threw = true; }
  assert.equal(threw, false, 'Q6：异常被外层 try/catch 吞掉，绝不阻断模型');
  // 嵌套 operation 整层回退原始（同引用，未去噪、未半成品）
  assert.strictEqual(shaped.data.result.operation, nested, 'Q6：回退原始 operation（同引用）');
  assert.equal(shaped.data.result.operation.data.result.command, 'echo hi', 'Q6：回退后原始字段完整（非半成品）');
  const outer = records[records.length - 1];
  assert.equal(outer.shaping.reason, 'nested-recursion-threw', 'Q6 原因记外层审计');
});

// ───────────────────────────────────────────────────────────
// AC6：Q8 operation 缓存
// ───────────────────────────────────────────────────────────

test('T05-AC6: 同 taskId+raw 再次 poll 命中缓存 — 免重整形（resolveTool 不重调嵌套）+ 同引用', async () => {
  clearOperationCache();
  let nestedResolveCount = 0;
  const ctx = {
    transport: 'actions',
    sessionId: 's-33',
    resolveTool: (name) => { if (name === 'execute_cli') nestedResolveCount++; return undefined; },
    audit: () => {},
  };
  const nested = nestedExecuteCli({ ...FULL_COMMAND_RESULT, exitCode: 0 }, true);
  const resp = makeTaskPoll(nested, { taskId: 't-cache' });

  const shaped1 = await shapeToolResponse(resp, ctx);
  const firstShapedOp = shaped1.data.result.operation;
  assert.equal(nestedResolveCount, 1, '首次 poll：嵌套 resolveTool 调 1 次');

  // 同 taskId + 同 raw operation 再次 poll
  const shaped2 = await shapeToolResponse(resp, ctx);
  const secondShapedOp = shaped2.data.result.operation;
  assert.strictEqual(secondShapedOp, firstShapedOp, 'Q8：缓存命中返回同一整形结果引用');
  assert.equal(nestedResolveCount, 1, 'Q8：再次 poll 命中缓存，嵌套 resolveTool 不再重调（免重整形 / 免重复 L3 配额）');

  // 不同 taskId（同 raw）→ 不命中，重整形
  const respOther = makeTaskPoll(nested, { taskId: 't-cache-other' });
  await shapeToolResponse(respOther, ctx);
  assert.equal(nestedResolveCount, 2, '不同 taskId：不命中缓存，嵌套 resolveTool 再调 1 次');
});

test('T05-AC6b: clearOperationCache(taskId) 只清该 task 缓存，其他 task 仍命中', async () => {
  clearOperationCache();
  let nestedResolveCount = 0;
  const ctx = {
    transport: 'actions',
    sessionId: 's-33',
    resolveTool: (name) => { if (name === 'execute_cli') nestedResolveCount++; return undefined; },
    audit: () => {},
  };
  const nested = nestedExecuteCli({ ...FULL_COMMAND_RESULT, exitCode: 0 }, true);
  await shapeToolResponse(makeTaskPoll(nested, { taskId: 'ta' }), ctx);
  await shapeToolResponse(makeTaskPoll(nested, { taskId: 'tb' }), ctx);
  assert.equal(nestedResolveCount, 2, '两 task 各整形 1 次');

  clearOperationCache('ta');
  await shapeToolResponse(makeTaskPoll(nested, { taskId: 'ta' }), ctx); // ta 已清 → 重整形
  await shapeToolResponse(makeTaskPoll(nested, { taskId: 'tb' }), ctx); // tb 仍命中 → 不重
  assert.equal(nestedResolveCount, 3, 'clearOperationCache(ta) 后仅 ta 重整形，tb 命中缓存');
});

test('T05-AC6c: 瞬时递归异常（Q6）不被缓存冻结 — 恢复后下次 poll 成功整形', async () => {
  clearOperationCache();
  let nestedAuditCalls = 0;
  const ctx = {
    transport: 'actions',
    sessionId: 's-33',
    resolveTool: () => undefined,
    audit: (r) => {
      // 仅首次嵌套审计抛错（模拟瞬时故障：L3 冷加载超时 / audit 通道抖动），此后放行
      if (r.rawResult?.data?.tool !== 'task_poll' && nestedAuditCalls++ === 0) {
        throw new Error('瞬时 audit 异常');
      }
    },
  };
  const nested = nestedExecuteCli({ ...FULL_COMMAND_RESULT, exitCode: 0 }, true);
  const resp = makeTaskPoll(nested, { taskId: 't-transient' });

  // 首次：嵌套递归抛错（Q6）→ 回退原始 operation，且不缓存（验证未被冻结）
  const first = await shapeToolResponse(resp, ctx);
  assert.strictEqual(first.data.result.operation, nested, '首次：Q6 回退原始 operation');
  assert.equal(first.data.result.operation.data.result.command, 'echo hi', '首次：原始噪声未动');

  // 恢复后再次 poll（同 taskId+raw）：不应命中被冻结的 fail-open 缓存 → 成功整形
  const second = await shapeToolResponse(resp, ctx);
  assert.equal(second.data.result.operation.data.result.command, undefined, '恢复后：成功整形（command 已去噪），未被 Q6 冻结');
  assert.equal(second.data.result.operation.data.tool, 'execute_cli', '恢复后：data.tool 保全');
});

// ───────────────────────────────────────────────────────────
// AC7：Q10 审计双层覆盖
// ───────────────────────────────────────────────────────────

test('T05-AC7: Q10 审计双层 — 递归产嵌套 raw/shaped + 外层全量 response 快照', async () => {
  clearOperationCache();
  const { ctx, records } = makeCtxCollect();
  const nested = nestedExecuteCli({ ...FULL_COMMAND_RESULT, exitCode: 0 }, true);
  const resp = makeTaskPoll(nested);
  await shapeToolResponse(resp, ctx);

  // 应至少两条：嵌套（data.tool=execute_cli）+ 外层（data.tool=task_poll）
  const nestedRec = records.find((r) => r.rawResult?.data?.tool === 'execute_cli');
  const outerRec = records.find((r) => r.rawResult?.data?.tool === 'task_poll');
  assert.ok(nestedRec, 'Q10：存在嵌套 operation 审计记录');
  assert.ok(outerRec, 'Q10：存在外层 task_poll 审计记录');

  // 嵌套记录：raw 为原始嵌套 op（含 command 噪声），shaped 为去噪后 op（command 已剥）
  assert.strictEqual(nestedRec.rawResult, nested, '嵌套 raw = 原始 operation');
  assert.equal(nestedRec.rawResult.data.result.command, 'echo hi', '嵌套 raw 含原始噪声');
  assert.equal(nestedRec.shapedResult.data.result.command, undefined, '嵌套 shaped 已去噪');

  // 外层快照：raw 含原始嵌套 op，shaped 含去噪后嵌套 op（天然覆盖嵌套前后）
  assert.strictEqual(outerRec.rawResult, resp, '外层 raw = 原始 task_poll response');
  assert.strictEqual(outerRec.shapedResult.data.result.operation, nestedRec.shapedResult, '外层 shaped 嵌套 = 嵌套 shaped（一致）');
});

// ───────────────────────────────────────────────────────────
// AC8：D17 静默
// ───────────────────────────────────────────────────────────

test('T05-AC8: D17 静默 — 递归整形后无任何层标记', async () => {
  clearOperationCache();
  const { ctx } = makeCtxCollect();
  const nested = nestedExecuteCli({ ...FULL_COMMAND_RESULT, exitCode: 0 }, true);
  const resp = makeTaskPoll(nested);
  const shaped = await shapeToolResponse(resp, ctx);
  assertNoShapingMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC9：边界（D11 fail-open，无副作用）
// ───────────────────────────────────────────────────────────

test('T05-AC9a: 非 task_poll 工具不触发 D13 递归（execute_cli 直接走 L1，无嵌套）', async () => {
  clearOperationCache();
  const { ctx } = makeCtxCollect();
  const resp = { ok: true, data: { tool: 'execute_cli', result: { ...FULL_COMMAND_RESULT, exitCode: 0 } } };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.equal(shaped.data.result.command, undefined, '普通 L1 去噪不受影响');
  assert.equal(shaped.data.tool, 'execute_cli');
});

test('T05-AC9b: task_poll 无 operation 字段（轮询中）→ 原样 passthrough', async () => {
  clearOperationCache();
  const { ctx } = makeCtxCollect();
  const resp = {
    ok: true,
    data: { tool: 'task_poll', result: { taskId: 't-33', status: 'running', startedAt: 'x' } },
  };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.deepEqual(shaped, resp, '无 operation → 整条 passthrough（D11 无副作用）');
});

test('T05-AC9c: 畸形 operation（缺 data）→ 不递归、passthrough 保全（D11 fail-open）', async () => {
  clearOperationCache();
  const { ctx, records } = makeCtxCollect();
  // operation 不是合法 ToolResponse（无 data），isNestedOperation 判否 → 不递归
  const broken = { ok: true, tool: 'execute_cli' };
  const resp = makeTaskPoll(broken);
  const shaped = await shapeToolResponse(resp, ctx);
  assert.strictEqual(shaped.data.result.operation, broken, '畸形 operation 原样保全（不整形、不抛）');
  const outer = records[records.length - 1];
  assert.equal(outer.shaping.reason, 'passthrough', '畸形 operation 走 passthrough');
});
