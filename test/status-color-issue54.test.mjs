// #54（批4 / ADR-0031 / G9）状态→视觉映射单源收敛回归
//
// 证明 TUI 状态→视觉映射已收敛为单一函数 statusToVisual(status)，消除 3 处默认态分歧：
//   - history-entry.ts:75-79 用 tone，默认 muted
//   - ToolCallRow.tsx:40-43 用 statusColor，默认 bad
//   - Subagent.tsx:188-191 用 statusColor，默认 warn
// 三者默认态已分歧（同一未知状态在不同面板颜色不同）。单源化后统一归 muted。
//
// 单源提供：
//   - statusToVisual(status) → 语义色 token（accent/good/warn/bad/muted）
//   - 未知/未预期状态一律返回 DEFAULT_STATUS_TONE = 'muted'（中性，避免误染 bad/warn）
//
// 本测试是 G9 红灯：模块落地前 import '../dist/tui/status-color.js' 失败 → 红；
// 落地并收敛 4 个同域调用点（含 Home.tsx:158 审计状态，避免留下新分歧）后转绿。

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { statusToVisual, DEFAULT_STATUS_TONE } from '../dist/tui/status-color.js';

describe('#54 状态→视觉映射单源收敛', () => {
  test('单源提供默认态，且默认归 muted（消除 bad/warn 分歧）', () => {
    assert.equal(DEFAULT_STATUS_TONE, 'muted', '默认态必须是 muted（中性）');
    assert.equal(statusToVisual(''), 'muted', '空状态不得被误染');
    assert.equal(statusToVisual('totally_unknown_status'), 'muted', '未知状态必须归 muted');
  });

  test('已知状态映射一致（同状态全面板同色）', () => {
    assert.equal(statusToVisual('running'), 'accent');
    assert.equal(statusToVisual('completed'), 'good');
    assert.equal(statusToVisual('failed'), 'bad');
    assert.equal(statusToVisual('timeout'), 'bad');
    assert.equal(statusToVisual('policy_rejected'), 'warn');
    assert.equal(statusToVisual('aborted'), 'warn');
    assert.equal(statusToVisual('aborting'), 'warn');
  });

  test('关键失败态明确为 bad（不得因单源化被降级为 muted）', () => {
    assert.equal(statusToVisual('failed'), 'bad');
    assert.equal(statusToVisual('timeout'), 'bad');
  });

  test('policy_rejected 明确为 warn（不得因单源化被降级）', () => {
    assert.equal(statusToVisual('policy_rejected'), 'warn');
  });
});
