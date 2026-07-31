// Issue #83（ADR-0036）— cluster-router 的 callInput 漏 inputJson，与 facade 入参口径分歧
//
// CP1（先证后修）：callInput 必须按 facade callArguments 同口径合并三源
// （arguments / inputJson / input，input 优先）。修复前仅取 input ?? arguments，
// inputJson 被静默丢弃 → 本测 merged.c 断言失败（RED）。修复后三源皆纳入 → GREEN。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { callInput } from '../dist/cluster-router.js';

test('CP1: cluster-router callInput 合并 input/arguments/inputJson，与 facade 口径一致', () => {
  const input = {
    input: { a: 1, shared: 'fromInput' },
    arguments: { b: 2, shared: 'fromArgs' },
    inputJson: JSON.stringify({ c: 3, shared: 'fromJson' }),
  };
  const merged = callInput(input);

  // 三源都应被纳入
  assert.equal(merged.a, 1, 'input.a 应保留');
  assert.equal(merged.b, 2, 'arguments.b 应保留');
  assert.equal(merged.c, 3, 'inputJson.c 应被纳入（#83 修复点：此前被静默丢弃）');

  // 冲突时 input 优先（对齐 facade：...legacy, ...fallback, ...preferred）
  assert.equal(merged.shared, 'fromInput', '三源冲突时 input 应优先');
});

test('CP1: 仅传 inputJson（无 input/arguments）也应被解析为对象', () => {
  const merged = callInput({ inputJson: JSON.stringify({ only: 'json' }) });
  assert.deepEqual(merged, { only: 'json' }, 'inputJson 单源应被解析');
});
