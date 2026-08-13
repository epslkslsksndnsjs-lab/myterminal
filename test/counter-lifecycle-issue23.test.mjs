// Issue #23（ADR-0046 D2.2）— 计数器生命周期（完成消失 / 失败红冻）行为测试。
// 覆盖 Home 子会话行 ↑N 计数器对 SubagentRecord.status 的响应：
//   completed → 消失；failed/aborted → 显示且错误态（红）；running → 显示正常色；无 record → 不显示。
// 以及 formatTokenCounter 的缩写格式。
import test from 'node:test';
import assert from 'node:assert/strict';
import { counterLifecycle, formatTokenCounter } from '../dist/tui/screens/Home.js';

// 最小 SubagentRecord：counterLifecycle 只读取 status 字段。
function rec(status) {
  return { status, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
}

test('counterLifecycle: completed → hidden (消失)', () => {
  assert.deepEqual(counterLifecycle(rec('completed')), { visible: false, isError: false });
});

test('counterLifecycle: failed → visible + error (红冻)', () => {
  assert.deepEqual(counterLifecycle(rec('failed')), { visible: true, isError: true });
});

test('counterLifecycle: aborted → visible + error (红冻)', () => {
  assert.deepEqual(counterLifecycle(rec('aborted')), { visible: true, isError: true });
});

test('counterLifecycle: running → visible, normal color', () => {
  assert.deepEqual(counterLifecycle(rec('running')), { visible: true, isError: false });
});

test('counterLifecycle: no record (non-subagent child) → hidden', () => {
  assert.deepEqual(counterLifecycle(undefined), { visible: false, isError: false });
});

test('formatTokenCounter: <1000 → raw ↑N', () => {
  assert.equal(formatTokenCounter(840), '↑840');
  assert.equal(formatTokenCounter(999), '↑999');
});

test('formatTokenCounter: ≥1000 → ↑N.Nk (trim trailing .0)', () => {
  assert.equal(formatTokenCounter(1000), '↑1k');
  assert.equal(formatTokenCounter(1250), '↑1.3k');
  assert.equal(formatTokenCounter(12500), '↑12.5k');
});
