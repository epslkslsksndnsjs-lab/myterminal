// Issue #24（ADR-0046 D2.2）— 计数器行为回归测试。
// 锁定 Home 子会话行 ↑N 的三维契约：
//   1) 语义：N = 累计 input + output（不含 cacheRead）
//   2) 格式：↑12.5k（≥1000 缩写）/ ↑840（<1000 原值）
//   3) 生命周期：completed→消失；failed/aborted→红冻；running→正常；无 record→不显示
// 与 issue23（生命周期/格式初版）互补：本文件聚焦"↑N 究竟等于多少"的语义回归闸门。
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenTotalFor, formatTokenCounter, counterLifecycle } from '../dist/tui/screens/Home.js';

// 最小 SubagentRecord：counterLifecycle / tokenTotalFor 只读取 status 与 usage 字段。
function rec(status, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0) {
  return { status, usage: { inputTokens, outputTokens, cacheReadTokens } };
}

// ── 1) 语义：↑N = input + output ──
test('tokenTotalFor: input + output 累计', () => {
  assert.equal(tokenTotalFor(rec('running', 100, 50)), 150);
});

test('tokenTotalFor: cacheRead 不计入（即便很大）', () => {
  assert.equal(tokenTotalFor(rec('running', 1000, 250, 99999)), 1250);
});

test('tokenTotalFor: 零基 → 0', () => {
  assert.equal(tokenTotalFor(rec('running', 0, 0, 0)), 0);
});

test('tokenTotalFor: 无 record → 0', () => {
  assert.equal(tokenTotalFor(undefined), 0);
});

// ── 2) 格式：↑12.5k / ↑840 边界 ──
test('formatTokenCounter: <1000 → 原值 ↑N', () => {
  assert.equal(formatTokenCounter(840), '↑840');
  assert.equal(formatTokenCounter(999), '↑999');
});

test('formatTokenCounter: ≥1000 → ↑N.Nk（去尾随 .0）', () => {
  assert.equal(formatTokenCounter(1000), '↑1k');
  assert.equal(formatTokenCounter(1250), '↑1.3k');
  assert.equal(formatTokenCounter(12500), '↑12.5k');
});

// ── 语义 × 格式：端到端 —— 累计值经 formatTokenCounter 呈现正确缩写 ──
test('回归：累计 12500（12000+500）→ ↑12.5k', () => {
  assert.equal(formatTokenCounter(tokenTotalFor(rec('running', 12000, 500))), '↑12.5k');
});

test('回归：累计 840（800+40）→ ↑840', () => {
  assert.equal(formatTokenCounter(tokenTotalFor(rec('running', 800, 40))), '↑840');
});

// ── 3) 生命周期：消失 / 红冻 ──
test('counterLifecycle: completed → 消失', () => {
  assert.deepEqual(counterLifecycle(rec('completed')), { visible: false, isError: false });
});

test('counterLifecycle: failed → 红冻', () => {
  assert.deepEqual(counterLifecycle(rec('failed')), { visible: true, isError: true });
});

test('counterLifecycle: aborted → 红冻', () => {
  assert.deepEqual(counterLifecycle(rec('aborted')), { visible: true, isError: true });
});

test('counterLifecycle: running → 正常显示', () => {
  assert.deepEqual(counterLifecycle(rec('running')), { visible: true, isError: false });
});

test('counterLifecycle: 无 record → 不显示', () => {
  assert.deepEqual(counterLifecycle(undefined), { visible: false, isError: false });
});
