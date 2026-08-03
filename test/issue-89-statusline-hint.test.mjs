// Issue #89 — StatusLine.hints() 在 tab=8(Subagents) 落入默认分支，显示 Logs 的 "a 调用详情"
// CP1（先证后修）：hints(8, ...) 不得含 Logs 专属的 "a 调用详情"，且应含 Subagents 专属提示。
// 修复前 tab=8 走默认分支返回 Logs 文案 → RED。修复后 GREEN。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { hints } from '../dist/tui/components/chrome/StatusLine.js';

// 假 translate：回退中文文案
const t = (key, fallback) => fallback;

test('CP1: hints(8) 不显示 Logs 的 "a 调用详情" 且含 Subagents 专属提示 (#89)', () => {
  const out = hints(8, undefined, t, true, false);
  assert.doesNotMatch(out, /a 调用详情/, 'tab=8(Subagents) 不应显示 Logs 的 "a 调用详情"（#89 修复点）');
  assert.match(out, /翻页|退出/, 'tab=8 应显示 Subagents 专属提示');
});

test('CP2: hints(7) 仍是 Logs 的 "a 调用详情"（行为保持）', () => {
  const out = hints(7, undefined, t, true, false);
  assert.match(out, /a 调用详情/, 'tab=7(Logs) 应保持原提示');
});
