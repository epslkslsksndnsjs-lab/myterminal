// ADR-0051 增补-07 (#106)：task_poll 完成态首次 poll 双跑修复（Q8 缓存预填）。
//
// 根因（A2 审计 F1 + e3 复核 R3）：completeBackgroundTask 完成时已对内层响应 applyShape
// （烧 1 次 L3 配额）并存 task.response；首次 poll 时 D13 递归对「已整形内容」再跑 runL3
// （烧第 2 次配额）——且二次模型输出非确定，poll 返回与完成态落审计版本可能不一致
// （模型所见 ≠ 历史所记）。Q8 缓存只防再次 poll 不防首次（完成时反而 clearOperationCache）。
// 修法：completeBackgroundTask 存 task.response 后按 poll 同款 key（taskId + 内容哈希）
// 预填 operationCache（seedOperationCache，复用 512 驱逐），首次 poll 即命中不再重跑。
//
// 验收覆盖：
//   AC1 完成态任务首次 poll：runL3 调用 0 增量（配额不双烧），有计数锁定；未预填对照 = 1 次
//   AC2 poll 返回与完成态落审计版本同引用/同形状（严格相等断言）
//   AC3 预填 key 与 poll 递归路径同款：异 taskId / 异内容 / clearOperationCache → 不命中重整形
//   AC3b 无 taskId（bootstrap 缺省）预填/轮询同款纯哈希 key 命中
//   AC4 512 驱逐语义不破坏：预填与递归写入同一驱逐通道（互相驱逐、顺序正确）
//
// 测试方式：单测直驱 shapeToolResponse（../dist/tool-parse.js）+ 计数 fake adapter
// （../dist/l3/registry.js 注入，issue-W208 同款），completeCalls 计数即 runL3 调用数。

import { test, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import {
  shapeToolResponse,
  clearOperationCache,
  seedOperationCache,
} from '../dist/tool-parse.js';
import {
  registerAdapterFactory,
  resetL3Adapter,
  resetL3AdapterInstance,
} from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** 完成态已整形 execute_cli 响应（schema 白名单形状，无 command/cwd 噪声键）——
 * 即 completeBackgroundTask 存 task.response 的形态。 */
function shapedExecuteCli() {
  return {
    ok: true,
    data: {
      tool: 'execute_cli',
      result: { exitCode: 0, stdout: 'hi', stderr: '', truncated: false, durationMs: 12 },
    },
  };
}

/** 构造 task_poll 响应（嵌套 operation = 完成态 task.response，pollBackgroundTask 同形）。 */
function makeTaskPoll(operation, { taskId = 't-106' } = {}) {
  return {
    ok: true,
    data: {
      tool: 'task_poll',
      result: {
        taskId,
        status: 'completed',
        startedAt: '2026-08-15T00:00:00Z',
        completedAt: '2026-08-15T00:00:01Z',
        operation,
      },
    },
  };
}

// ── 计数 fake adapter（issue-W208 同款：isReady=true，complete 计数）────────

let completeCalls = 0;
function injectCountingAdapter() {
  completeCalls = 0;
  resetL3Adapter(); // 先全清（单例+工厂）再注入
  registerAdapterFactory(() => ({
    id: 't106-fake',
    supportsStructuredOutput: true,
    isReady: async () => true,
    complete: async () => {
      completeCalls++;
      // 返回与 raw 白名单字段一致的对象（Q5 值存在性校验通过）
      return {
        object: { exitCode: 0, stdout: 'hi', stderr: '', truncated: false, durationMs: 12 },
        finishReason: 'stop',
        latencyMs: 1,
        modelId: 't106-fake',
      };
    },
  }));
}

function makeCtx() {
  return {
    transport: 'actions',
    sessionId: 's-106',
    resolveTool: () => undefined,
    audit: () => {},
  };
}

beforeEach(() => {
  clearOperationCache();
  clearL3Quota('s-106');
});

// #101 增补-02 教训：afterEach 只清本文件产生的单例缓存，不动其他文件注入的 factory
afterEach(() => {
  resetL3AdapterInstance();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1：预填后完成态首次 poll 零 L3 增量（配额不双烧）
// ─────────────────────────────────────────────────────────────────────────────

test('W106-AC1: 预填后完成态首次 poll 零 runL3 增量（配额不双烧）；未预填对照 = 1 次', async () => {
  injectCountingAdapter();
  const op = shapedExecuteCli();
  seedOperationCache('t-106', op);

  const shaped = await shapeToolResponse(makeTaskPoll(op, { taskId: 't-106' }), makeCtx());
  assert.equal(completeCalls, 0, '预填命中：首次 poll 不再触发 runL3（配额不双烧）');
  assert.strictEqual(shaped.data.result.operation, op, '命中返回预填同引用（poll 所见 = 完成态所存）');

  // 对照：未预填（异 taskId）→ 首次 poll 触发 1 次 runL3（修复前行为，检测双跑有效）
  await shapeToolResponse(makeTaskPoll(op, { taskId: 't-106-other' }), makeCtx());
  assert.equal(completeCalls, 1, '对照：未预填首次 poll 触发 1 次 runL3（双跑可测）');
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2：poll 返回与完成态落审计版本同引用/同形状
// ─────────────────────────────────────────────────────────────────────────────

test('W106-AC2: poll 返回与预填版本严格相等（同引用 + 同形状）', async () => {
  injectCountingAdapter();
  const op = shapedExecuteCli();
  seedOperationCache('t-106', op);

  const shaped = await shapeToolResponse(makeTaskPoll(op, { taskId: 't-106' }), makeCtx());
  assert.strictEqual(shaped.data.result.operation, op, '同引用（模型所见 = 完成态落审计版本）');
  assert.deepEqual(shaped.data.result.operation, op, '同形状');
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3：预填 key 与 poll 递归路径同款
// ─────────────────────────────────────────────────────────────────────────────

test('W106-AC3: 异 taskId / 异内容 / clearOperationCache(taskId) 皆不命中重整形', async () => {
  injectCountingAdapter();
  const op = shapedExecuteCli();
  seedOperationCache('ta', op);
  const ctx = makeCtx();

  await shapeToolResponse(makeTaskPoll(op, { taskId: 'ta' }), ctx);
  assert.equal(completeCalls, 0, '同 taskId + 同内容 → 命中');

  await shapeToolResponse(makeTaskPoll(op, { taskId: 'tb' }), ctx);
  assert.equal(completeCalls, 1, '异 taskId（同内容）→ 不命中重整形');

  const opOther = shapedExecuteCli();
  opOther.data.result.stdout = 'different';
  await shapeToolResponse(makeTaskPoll(opOther, { taskId: 'ta' }), ctx);
  assert.equal(completeCalls, 2, '同 taskId + 异内容 → 不命中重整形');

  clearOperationCache('ta');
  await shapeToolResponse(makeTaskPoll(op, { taskId: 'ta' }), ctx);
  assert.equal(completeCalls, 3, 'clearOperationCache(taskId) 后 → 不命中重整形');
});

test('W106-AC3b: 无 taskId（bootstrap 缺省）预填/轮询同款纯哈希 key 命中', async () => {
  injectCountingAdapter();
  const op = shapedExecuteCli();
  seedOperationCache(undefined, op);

  const resp = makeTaskPoll(op, { taskId: 't-106' });
  delete resp.data.result.taskId; // poll 侧无 taskId
  const shaped = await shapeToolResponse(resp, makeCtx());
  assert.equal(completeCalls, 0, '无 taskId 预填命中');
  assert.strictEqual(shaped.data.result.operation, op, '同引用');
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4：512 驱逐语义不破坏（预填与递归写入同一驱逐通道）
// ─────────────────────────────────────────────────────────────────────────────

test('W106-AC4: 512 驱逐 — 预填与递归写入互相驱逐、顺序正确', async () => {
  injectCountingAdapter();
  const ctx = makeCtx();
  const op = shapedExecuteCli();

  // 预填 512 条（evict-0..evict-511）→ 缓存满
  for (let i = 0; i <= 511; i++) seedOperationCache(`evict-${i}`, op);

  // 递归写入（未预填 taskId 的 poll miss → D13 递归成功写缓存）驱逐最老的预填条目 evict-0
  await shapeToolResponse(makeTaskPoll(op, { taskId: 'rec-x' }), ctx);
  assert.equal(completeCalls, 1, 'rec-x 未预填 → 递归触发 1 次 runL3');

  await shapeToolResponse(makeTaskPoll(op, { taskId: 'evict-0' }), ctx);
  assert.equal(completeCalls, 2, '最老预填条目已被递归写入驱逐 → 不命中重整形（同一驱逐通道）');

  await shapeToolResponse(makeTaskPoll(op, { taskId: 'rec-x' }), ctx);
  assert.equal(completeCalls, 2, '递归写入的 rec-x 仍在 → 命中（驱逐顺序正确）');

  await shapeToolResponse(makeTaskPoll(op, { taskId: 'evict-511' }), ctx);
  assert.equal(completeCalls, 2, '最新预填条目仍在 → 命中（512 驱逐语义不破坏）');
});
