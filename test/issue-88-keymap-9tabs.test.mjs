// Issue #88 — keymap 仅生成 8 个数字键，但 TABS 有 9 个（Subagents=index 8 无直达键）
// CP1（先证后修）：buildNumberTabBindings 生成数量必须 === TABS.length，
// 且第 9 个键 key='9' 映射到 switchTab(8)。
// 修复前无此纯函数 / 魔数 8 → RED。修复后 GREEN。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { buildNumberTabBindings } from '../dist/tui/keymap.js';
import { TABS } from '../dist/tui/state.js';

test('CP1: 数字键数量 === TABS.length，第 9 键直达 Subagents (#88)', () => {
  let called = -1;
  const bindings = buildNumberTabBindings((i) => { called = i; });
  assert.equal(bindings.length, TABS.length, `数字键应覆盖全部 ${TABS.length} 个页签（#88 修复点）`);
  const ninth = bindings[8];
  assert.ok(ninth, '应有第 9 个数字键（Subagents tab=8）');
  assert.equal(ninth.key, '9');
  ninth.cmd();
  assert.equal(called, 8, '第 9 键应 switchTab(8) = Subagents');
});
