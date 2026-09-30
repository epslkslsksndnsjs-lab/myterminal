// Workflows T4（#227）：stall 看门狗与重试——零件契约 + 引擎验收
//
// 单元面锁 stall.ts / llm-retry.ts 每个零件自己的行为边界：无进展判定、重试次序、
// 控制器新建、取消优先、dispatch 窗口/轮数、瞬态 backoff 上界。改了就红。
// 引擎级验收（挂死剧本重试计数、prompt/opts 全同、非 stall 零重试、启动校验 fail-closed）
// 在 issue-227-stall-retry.test.mjs。

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  MAX_STALL_ATTEMPTS,
  WORKFLOW_ABORT_REASON_STALLED,
  resolveStallMs,
  runStallResilient,
} from '../dist/workflows/stall.js';
import {
  TRANSIENT_BACKOFF_CEILING_MS,
  DEFAULT_STALL_MS,
  isTransientLlmError,
  computeTransientBackoffMs,
  withTransientRetry,
} from '../dist/workflows/llm-retry.js';
import { virtualClock } from '../dist/workflows/clock.js';
import { agentFailure, isAgentFailure, isRunLevelError } from '../dist/workflows/failures.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 让虚拟钟上排定的微任务（race 拒绝 → 循环续跑 → 下一次 arm）彻底跑一轮。 */
async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

function hangSignal(signal) {
  // 守信号的挂死：signal 一 abort 就 reject（模拟真 adapter 被中止）。
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
    else signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
}

// ═══════════════════════════════════════════════════════════════
// 一、resolveStallMs——每路覆盖 run 默认，0 是显式禁用
// ═══════════════════════════════════════════════════════════════

test('resolveStallMs：per-call 有限正数原样、0 禁用、负/NaN/Inf/缺省落 run 默认', () => {
  assert.equal(resolveStallMs(1_500, 180_000), 1_500);
  assert.equal(resolveStallMs(0, 180_000), 0, '0 = 调用方显式关看门狗');
  assert.equal(resolveStallMs(-1, 180_000), 180_000, '负数是调用方 bug → 落默认');
  assert.equal(resolveStallMs(Number.NaN, 180_000), 180_000);
  assert.equal(resolveStallMs(Number.POSITIVE_INFINITY, 180_000), 180_000);
  assert.equal(resolveStallMs(undefined, 180_000), 180_000, '缺省用 run 闸门默认');
  assert.equal(MAX_STALL_ATTEMPTS, 3, '含首次共 3 次尝试');
  assert.equal(WORKFLOW_ABORT_REASON_STALLED, 'stalled');
});

// ═══════════════════════════════════════════════════════════════
// 二、runStallResilient——无进展才重试，其余直接记账
// ═══════════════════════════════════════════════════════════════

test('弹性器：一次成功 = 单次尝试、attempts=1', async () => {
  const clock = virtualClock();
  let calls = 0;
  const parent = new AbortController();
  const outcome = await runStallResilient(
    { clock, stallMs: 100, dispatchWindowMs: 100_000, dispatchTurns: 100, parentSignal: parent.signal, label: 'ok' },
    async () => { calls += 1; return 'done'; },
  );
  assert.deepEqual(outcome, { value: 'done', attempts: 1 });
  assert.equal(calls, 1);
});

test('弹性器：每次尝试都挂死 → 3 次耗尽判 stalled，且每尝试新 AbortController', async () => {
  const clock = virtualClock();
  const parent = new AbortController();
  const seenSignals = [];
  let calls = 0;
  const driver = runStallResilient(
    { clock, stallMs: 100, dispatchWindowMs: 100_000, dispatchTurns: 100, parentSignal: parent.signal, label: 'slow' },
    async (signal) => { calls += 1; seenSignals.push(signal); return new Promise(() => {}); },
  );
  let caught;
  driver.catch((error) => { caught = error; });

  await settle();
  assert.equal(calls, 1, '第一尝试起跑');
  clock.advance(100); await settle();
  assert.equal(calls, 2, '180s（这里 100）无进展 → 换控制器重试');
  clock.advance(100); await settle();
  assert.equal(calls, 3, '第二次重试');
  clock.advance(100); await settle();

  assert.ok(caught, '第三次仍无进展 → 抛出终态');
  assert.equal(isAgentFailure(caught), true, '是 agent 级失败，不是 run 级');
  assert.equal(caught.kind, 'stalled');
  assert.match(caught.message, /stalled on all 3 attempts/);
  assert.match(caught.message, /"slow"/);
  assert.equal(calls, 3, '总计 ≤3（含首次）');
  assert.equal(new Set(seenSignals).size, 3, '三次尝试的 signal 互不相同');
});

test('弹性器：第 2 次恢复 → settled 那次为准、attempts=2、挂死那次不带结果回来', async () => {
  const clock = virtualClock();
  const parent = new AbortController();
  let calls = 0;
  const driver = runStallResilient(
    { clock, stallMs: 100, dispatchWindowMs: 100_000, dispatchTurns: 100, parentSignal: parent.signal, label: 'flaky' },
    async () => { calls += 1; if (calls === 1) return new Promise(() => {}); return 'recovered'; },
  );
  await settle();
  clock.advance(100);
  const outcome = await driver;
  assert.equal(outcome.value, 'recovered', '第二次产物即该路结果');
  assert.equal(outcome.attempts, 2, '计数进终态记账');
  assert.equal(calls, 2, '第二次成功后不再重试第三次');
});

test('弹性器：非 stall 失败（尝试自抛错）零重试直接记账', async () => {
  const clock = virtualClock();
  const parent = new AbortController();
  let calls = 0;
  await assert.rejects(
    () => runStallResilient(
      { clock, stallMs: 100, dispatchWindowMs: 100_000, dispatchTurns: 100, parentSignal: parent.signal, label: 'sick' },
      async () => { calls += 1; throw new Error('model exploded'); },
    ),
    (error) => {
      assert.equal(error.message, 'model exploded');
      return true;
    },
  );
  assert.equal(calls, 1, '确定性错误不重试');
});

test('弹性器：agent 级已归类错误（max_turns 由尝试抛出）也不被重试', async () => {
  const clock = virtualClock();
  const parent = new AbortController();
  let calls = 0;
  await assert.rejects(
    () => runStallResilient(
      { clock, stallMs: 100, dispatchWindowMs: 100_000, dispatchTurns: 100, parentSignal: parent.signal, label: 'cap' },
      async () => { calls += 1; throw agentFailure('no_structured_output', 'no json'); },
    ),
    (error) => { assert.equal(error.kind, 'no_structured_output'); return true; },
  );
  assert.equal(calls, 1);
});

test('弹性器：父取消优先于一切、永不重试（守信号的挂死随信号拒）', async () => {
  const clock = virtualClock();
  const parent = new AbortController();
  let calls = 0;
  const driver = runStallResilient(
    { clock, stallMs: 10_000, dispatchWindowMs: 100_000, dispatchTurns: 100, parentSignal: parent.signal, label: 'x' },
    async (signal) => { calls += 1; return hangSignal(signal); },
  );
  let caught;
  driver.catch((error) => { caught = error; });
  await settle();
  assert.equal(calls, 1);
  parent.abort();
  await settle();
  assert.equal(calls, 1, '取消绝不重试');
  assert.equal(isRunLevelError(caught), true, '取消是 run 级终结，不是该路失败');
});

test('弹性器：dispatch 窗口到期 → timeout、不重试（无进展计时还没到）', async () => {
  const clock = virtualClock();
  const parent = new AbortController();
  let calls = 0;
  const driver = runStallResilient(
    { clock, stallMs: 10_000, dispatchWindowMs: 100, dispatchTurns: 100, parentSignal: parent.signal, label: 'wall' },
    async () => { calls += 1; return new Promise(() => {}); },
  );
  let caught;
  driver.catch((error) => { caught = error; });
  await settle();
  clock.advance(100);
  await settle();
  assert.equal(calls, 1, '窗口到期是确定性终态，不触发 stall 重试');
  assert.equal(caught.kind, 'timeout');
  assert.equal(isAgentFailure(caught), true);
});

test('弹性器：轮数越界 → max_turns、不重试', async () => {
  const clock = virtualClock();
  const parent = new AbortController();
  let calls = 0;
  const driver = runStallResilient(
    { clock, stallMs: 100_000, dispatchWindowMs: 100_000, dispatchTurns: 2, parentSignal: parent.signal, label: 'turny' },
    async (_signal, progress) => {
      calls += 1;
      progress.round();
      progress.round();
      progress.round(); // 第 3 轮 > 预算 2 → 触顶
      return new Promise(() => {});
    },
  );
  let caught;
  driver.catch((error) => { caught = error; });
  await settle();
  assert.equal(calls, 1);
  assert.equal(caught.kind, 'max_turns');
  assert.equal(isAgentFailure(caught), true);
});

test('弹性器：工具在飞时挂起无进展计时（慢工具不是 stall）', async () => {
  const clock = virtualClock();
  const parent = new AbortController();
  let calls = 0;
  let progress;
  const driver = runStallResilient(
    { clock, stallMs: 100, dispatchWindowMs: 100_000, dispatchTurns: 100, parentSignal: parent.signal, label: 'tooling' },
    async (_signal, p) => { calls += 1; progress = p; p.toolStart(); return new Promise(() => {}); },
  );
  driver.catch(() => { /* 收尾断言里再看 */ });
  await settle();
  // 在飞期间推进 2× stall：不应判 stall、不应重试
  clock.advance(200); await settle();
  assert.equal(calls, 1, '工具在飞时计时挂起——挂 200ms（>100）也不算无进展');
  // 工具落地后重新挂表，再推 100ms 才 stall → 进入重试
  progress.toolEnd();
  clock.advance(100); await settle();
  assert.equal(calls, 2, 'toolEnd 之后重新计时，越窗才判 stall 并重试');
});

test('弹性器：stallMs=0 关看门狗 → 挂死也不走 stall 重试（只剩窗口/轮数那两把钟）', async () => {
  const clock = virtualClock();
  const parent = new AbortController();
  let calls = 0;
  const driver = runStallResilient(
    { clock, stallMs: 0, dispatchWindowMs: 100_000, dispatchTurns: 100, parentSignal: parent.signal, label: 'off' },
    async () => { calls += 1; return new Promise(() => {}); },
  );
  driver.catch(() => { /* 不 await：靠水位与不重试判定 */ });
  await settle();
  clock.advance(50_000); await settle();
  assert.equal(calls, 1, 'stall=0 时不因无进展而重试');
});

// ═══════════════════════════════════════════════════════════════
// 三、llm-retry——模块自持瞬态重试（AC5：backoff 上界 < stall 窗）
// ═══════════════════════════════════════════════════════════════

test('AC5 瞬态 backoff 上界 < stall 窗（180s）——否则会被看门狗误判为无进展', () => {
  assert.equal(DEFAULT_STALL_MS, 180_000);
  assert.ok(TRANSIENT_BACKOFF_CEILING_MS < DEFAULT_STALL_MS, `上界 ${TRANSIENT_BACKOFF_CEILING_MS} 必须 < ${DEFAULT_STALL_MS}`);
  // 上界 = 阶梯之和，非负、有限、单调可见
  assert.ok(Number.isFinite(TRANSIENT_BACKOFF_CEILING_MS) && TRANSIENT_BACKOFF_CEILING_MS > 0);
});

test('瞬态归类：限流 / 过载 / 连接算瞬态；鉴权 / 上下文超长 / 普通错不算', () => {
  for (const kind of ['rate_limit', 'server_overload', 'connection']) {
    assert.equal(isTransientLlmError(llmError(kind)), true, `${kind} 应判瞬态`);
  }
  for (const kind of ['auth', 'prompt_too_long', 'system']) {
    assert.equal(isTransientLlmError(llmError(kind)), false, `${kind} 不该被重试`);
  }
  assert.equal(isTransientLlmError(new Error('plain')), false);
  assert.equal(isTransientLlmError({ status: 429 }), true, '裸 429 也认（鸭子读状态码）');
  assert.equal(isTransientLlmError({ status: 503 }), true, '5xx 是过载/瞬态');
  assert.equal(isTransientLlmError({ status: 401 }), false, '4xx 鉴权不重试');
});

test('computeTransientBackoffMs：阶梯有界、越界返回 null（耗尽即放手）', () => {
  let sum = 0;
  let n = 0;
  for (;;) {
    const delay = computeTransientBackoffMs(n);
    if (delay === null) break;
    assert.ok(delay >= 0 && Number.isFinite(delay));
    sum += delay;
    n += 1;
    assert.ok(n < 100, '阶梯必须有限收敛，绝不无限');
  }
  assert.ok(n >= 1, '至少有一次瞬态重试');
  assert.equal(sum, TRANSIENT_BACKOFF_CEILING_MS, '导出上界 = 阶梯之和（一处定义）');
});

test('withTransientRetry：限流后按 backoff 重试并成功；非瞬态即时抛', async () => {
  const clock = virtualClock();
  const delays = [];
  let calls = 0;
  const inner = {
    complete: async () => {
      calls += 1;
      if (calls === 1) throw llmError('rate_limit');
      if (calls === 2) throw llmError('server_overload');
      return { text: 'ok', outputTokens: 5 };
    },
  };
  const decorated = withTransientRetry(inner, {
    clock,
    onBackoff: (ms) => delays.push(ms),
  });
  const driver = decorated.complete({ system: 's', prompt: 'p', maxTokens: 10, signal: new AbortController().signal });
  // 用虚拟钟把两次 backoff 走完：每抛一次瞬态，装饰器排一个 clock.setTimeout，推进即续跑。
  for (let i = 0; i < 5; i++) {
    await settle();
    clock.advance(TRANSIENT_BACKOFF_CEILING_MS);
  }
  const result = await driver;
  assert.equal(result.text, 'ok');
  assert.equal(calls, 3, '两次瞬态失败 + 一次成功');
  assert.equal(delays.length, 2, '每次重试前记一次 backoff');
  assert.ok(delays.every((d) => d >= 0));

  // 非瞬态：一次即抛，不重试、不排 backoff
  let fatalCalls = 0;
  const fatalInner = { complete: async () => { fatalCalls += 1; throw llmError('auth'); } };
  const fatal = withTransientRetry(fatalInner, { clock: virtualClock(), onBackoff: () => { throw new Error('should not backoff on auth'); } });
  await assert.rejects(() => fatal.complete({ system: 's', prompt: 'p', maxTokens: 10, signal: new AbortController().signal }), (e) => e.kind === 'auth');
  assert.equal(fatalCalls, 1, '鉴权错误不重试');
});

// 造一个 LlmError 形状的传输错误（鸭子：name/kind/status，绝不 instanceof）
function llmError(kind) {
  const error = new Error(`llm ${kind}`);
  error.name = 'LlmError';
  error.kind = kind;
  return error;
}
