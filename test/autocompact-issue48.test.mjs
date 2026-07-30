// #48（批4 第 7 刀，坏行为项，G9）：autoCompact 在 provider 挂死时无限挂起
// 决策块（issue #48 评论回填）：collectStream 可靠性(watchdog+fallback) 提升为 LlmAdapter 装饰器，
// autoCompact 走装饰后适配器，挂死 → 超时降级（行为允许改变）。
//
// 本测试是 G9 红灯：注入【裸】provider（create 永远挂起，监听 signal abort），
// 验证 autoCompact 自身会给 create 套上 watchdog——短超时后中断挂死的 create 并降级。
// 注入裸适配器是关键：若 autoCompact 仍裸调 adapter.create（未接装饰器），300ms 无效 → 挂死 → RED。
// 修复后：autoCompact 内部用 withReliability 包裹，300ms watchdog 中断 → 抛 connection → GREEN。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { autoCompact } from '../dist/subagent/executor.js';
import { LlmError } from '../dist/subagent/llm-adapter.js';

/**
 * 裸 provider：create 永远挂起（监听 signal abort → reject AbortError），
 * 模拟真实 fetch 被 watchdog abort 的场景。
 */
function hangCreateAdapter() {
  return {
    provider: 'test',
    createWasAborted: false,
    createCallCount: 0,
    async *stream(params, signal) {
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } };
    },
    async create(params, signal) {
      this.createCallCount++;
      await new Promise((_resolve, reject) => {
        if (signal.aborted) {
          this.createWasAborted = true;
          reject(new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          this.createWasAborted = true;
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      });
    },
  };
}

test('#48 G9：provider 挂死时 autoCompact 不得无限挂起（自身 watchdog 超时降级）', async () => {
  const inner = hangCreateAdapter();
  const HANG_TIMEOUT_MS = 3000;

  let outcome = 'unknown';
  let err = null;
  try {
    outcome = await Promise.race([
      autoCompact(
        [{ role: 'user', content: [{ type: 'text', text: 'history' }] }],
        inner,
        'deepseek-chat',
        () => {},
        300, // 注入短超时，验证 autoCompact 自身的 watchdog（生产默认 60s）
      ).then(
        () => 'resolved',
        (e) => { err = e; return 'threw'; },
      ),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('AUTOCOMPACT_HUNG: autoCompact 阻塞主循环（provider 挂死且无 watchdog）')),
          HANG_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (e) {
    // race 被挂死计时器拒绝 → 红灯
    err = e;
    outcome = 'timeout';
  }

  // 红灯判定：未修复时 outcome === 'timeout'（autoCompact 无限挂起）
  assert.notEqual(outcome, 'timeout', 'autoCompact 不得无限挂起（provider 卡死）→ 红灯');

  // 修复后：watchdog 在 300ms 中断挂死的 create
  assert.ok(inner.createWasAborted, 'watchdog 应当中断挂死的 compaction create（createWasAborted 应为 true）');
  assert.ok(inner.createCallCount >= 1, 'autoCompact 应当至少调用一次 adapter.create');

  // 修复后：autoCompact 应抛 connection 超时错误（而非挂死）
  assert.equal(outcome, 'threw', 'autoCompact 应在 watchdog 超时后抛出 connection 错误');
  assert.ok(
    err && err instanceof LlmError && err.kind === 'connection',
    '超时错误应为 LlmError kind=connection，实际：' + (err && err.constructor && err.constructor.name) + ' / ' + (err && err.message),
  );
});
