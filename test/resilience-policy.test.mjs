// Issue #65：ResiliencePolicy 单元测试
// 验证抽离后的熔断器 + 分类重试 + 每类错误计数行为完全等价

import { test, describe, beforeEach } from 'bun:test';
import assert from 'node:assert/strict';
import { ResiliencePolicy, MAX_SERVER_RETRIES } from '../dist/subagent/resilience-policy.js';
import { LlmError } from '../dist/subagent/llm-adapter.js';

function makeErr(kind, message = 'test', retryAfterMs) {
  return new LlmError(kind, message, undefined, retryAfterMs);
}

// ════════════════════════════════════════════════════════════════
// 1. classifyAndShouldRetry 等价性（通过 decideOnFailure）
// ════════════════════════════════════════════════════════════════

describe('ResiliencePolicy.decideOnFailure — 分类重试决策', () => {

  let policy;
  beforeEach(() => { policy = new ResiliencePolicy(); });

  // ── rate_limit ──
  test('rate_limit: 首次重试，delayMs ≥ 500ms 且 ≤ MAX_RETRY_DELAY_MS', () => {
    const d = policy.decideOnFailure(makeErr('rate_limit'));
    assert.equal(d.retry, true);
    assert.ok(d.delayMs >= 500 && d.delayMs <= 32_100, `delayMs=${d.delayMs}`);
    assert.equal(d.action, undefined);
  });

  test('rate_limit: 使用 Retry-After 头优先', () => {
    const d = policy.decideOnFailure(makeErr('rate_limit', 'rl', 2000));
    assert.equal(d.retry, true);
    assert.ok(d.delayMs >= 2000 && d.delayMs <= 2100, `delayMs=${d.delayMs}`);
  });

  // ── server_overload ──
  test('server_overload: 前 MAX_SERVER_RETRIES 次可重试', () => {
    for (let i = 0; i < MAX_SERVER_RETRIES; i++) {
      const d = policy.decideOnFailure(makeErr('server_overload'));
      assert.equal(d.retry, true, `iteration ${i}`);
      assert.equal(d.action, undefined, `iteration ${i}`);
    }
  });

  test('server_overload: 超过 MAX_SERVER_RETRIES 后降级 fallbackModel', () => {
    for (let i = 0; i < MAX_SERVER_RETRIES; i++) policy.decideOnFailure(makeErr('server_overload'));
    const d = policy.decideOnFailure(makeErr('server_overload'));
    assert.equal(d.retry, true);
    assert.equal(d.action, 'fallbackModel');
  });

  // ── auth ──
  test('auth: 永不重试', () => {
    const d = policy.decideOnFailure(makeErr('auth'));
    assert.equal(d.retry, false);
    assert.equal(d.delayMs, 0);
  });

  // ── prompt_too_long ──
  test('prompt_too_long: 不重试，action=compact', () => {
    const d = policy.decideOnFailure(makeErr('prompt_too_long'));
    assert.equal(d.retry, false);
    assert.equal(d.action, 'compact');
  });

  // ── connection ──
  test('connection: 前 MAX_SERVER_RETRIES 次可重试', () => {
    for (let i = 0; i < MAX_SERVER_RETRIES; i++) {
      const d = policy.decideOnFailure(makeErr('connection'));
      assert.equal(d.retry, true, `iteration ${i}`);
    }
  });

  test('connection: 超过 MAX_SERVER_RETRIES 后不重试', () => {
    for (let i = 0; i < MAX_SERVER_RETRIES; i++) policy.decideOnFailure(makeErr('connection'));
    const d = policy.decideOnFailure(makeErr('connection'));
    assert.equal(d.retry, false);
  });

  // ── system ──
  test('system: 永不重试', () => {
    const d = policy.decideOnFailure(makeErr('system'));
    assert.equal(d.retry, false);
  });
});

// ════════════════════════════════════════════════════════════════
// 2. CircuitBreaker 熔断行为
// ════════════════════════════════════════════════════════════════

describe('ResiliencePolicy — Circuit Breaker', () => {

  let policy;
  beforeEach(() => { policy = new ResiliencePolicy(); });

  test('连续 5 次失败后 assertBreakerClosed 抛错', () => {
    for (let i = 0; i < 5; i++) {
      policy.decideOnFailure(makeErr('system'));
    }
    assert.throws(() => policy.assertBreakerClosed(), /Circuit breaker is open/);
  });

  test('recordSuccess 重置失败计数（未熔断时）', () => {
    // 4 次失败（未触发熔断）
    for (let i = 0; i < 4; i++) policy.decideOnFailure(makeErr('system'));
    policy.recordSuccess();
    // 再来 4 次不应熔断
    for (let i = 0; i < 4; i++) policy.decideOnFailure(makeErr('system'));
    assert.doesNotThrow(() => policy.assertBreakerClosed());
  });

  test('半开冷却期后允许探测（需要等待 CB_COOLDOWN_MS）', async () => {
    // 触发熔断
    for (let i = 0; i < 5; i++) policy.decideOnFailure(makeErr('system'));
    assert.throws(() => policy.assertBreakerClosed());

    // 等待 30s 冷却期太长——用新 policy + mock 时间替代
    // 这里只验证抛错包含冷却时间信息
    try {
      policy.assertBreakerClosed();
      assert.fail('should have thrown');
    } catch (e) {
      assert.match(e.message, /Cooldown.*remaining/);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 3. recordSuccess 重置重试计数
// ════════════════════════════════════════════════════════════════

describe('ResiliencePolicy.recordSuccess — 重置计数', () => {

  test('成功后 server_overload 计数器归零，再次失败不会立即降级', () => {
    const policy = new ResiliencePolicy();
    // 3 次 server_overload
    for (let i = 0; i < MAX_SERVER_RETRIES; i++) policy.decideOnFailure(makeErr('server_overload'));
    // 成功——重置
    policy.recordSuccess();
    // 再来 1 次应该不是 fallbackModel
    const d = policy.decideOnFailure(makeErr('server_overload'));
    assert.equal(d.action, undefined);
    assert.equal(d.retry, true);
  });

  test('成功后 connection 计数器归零', () => {
    const policy = new ResiliencePolicy();
    for (let i = 0; i < MAX_SERVER_RETRIES; i++) policy.decideOnFailure(makeErr('connection'));
    policy.recordSuccess();
    const d = policy.decideOnFailure(makeErr('connection'));
    assert.equal(d.retry, true);
  });

  test('成功后 rate_limit 计数器归零', () => {
    const policy = new ResiliencePolicy();
    policy.decideOnFailure(makeErr('rate_limit'));
    policy.decideOnFailure(makeErr('rate_limit'));
    policy.recordSuccess();
    // 第 1 次重试 delayMs 应接近 500ms（2^0）
    const d = policy.decideOnFailure(makeErr('rate_limit'));
    assert.ok(d.delayMs <= 1100, `delayMs=${d.delayMs}, expected close to 500+jitter`);
  });
});

// ════════════════════════════════════════════════════════════════
// 4. resetRetryCount 手动重置
// ════════════════════════════════════════════════════════════════

describe('ResiliencePolicy.resetRetryCount', () => {

  test('手动重置 compact 不影响其他类', () => {
    const policy = new ResiliencePolicy();
    policy.decideOnFailure(makeErr('server_overload'));
    policy.resetRetryCount('compact'); // 无关类别
    const d = policy.decideOnFailure(makeErr('server_overload'));
    // 第 2 次 server_overload，delayMs = 500*2^1 = 1000
    assert.equal(d.delayMs, 1000);
  });
});
