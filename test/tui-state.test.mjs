import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';

import { TABS, phaseColor, presenceColor } from '../dist/tui/state.js';
import { themeFor } from '../dist/tui/theme/index.js';

describe('TUI state pure functions', () => {
  const dark = themeFor('dark');
  const light = themeFor('light');

  // #231 显式漂移更新：Worktrees 面板随 T8 交付，页签从 9 张变 10 张（数字键绑定跟着 TABS.length 走）。
  test('TABS contains all 10 pages', () => {
    assert.equal(TABS.length, 10);
    assert.ok(TABS.includes('Overview'));
    assert.ok(TABS.includes('Sessions'));
    assert.ok(TABS.includes('Settings'));
    assert.ok(TABS.includes('Logs'));
    assert.ok(TABS.includes('Subagents'));
    assert.ok(TABS.includes('Worktrees'));
  });

  test('phaseColor: completed → good', () => {
    assert.equal(phaseColor(dark, 'completed'), dark.good);
  });

  test('phaseColor: working → accent', () => {
    assert.equal(phaseColor(dark, 'working'), dark.accent);
  });

  test('phaseColor: blocked → bad', () => {
    assert.equal(phaseColor(dark, 'blocked'), dark.bad);
  });

  test('phaseColor: cancelled → bad', () => {
    assert.equal(phaseColor(dark, 'cancelled'), dark.bad);
  });

  test('phaseColor: pending/waiting → warn', () => {
    assert.equal(phaseColor(dark, 'pending'), dark.warn);
    assert.equal(phaseColor(dark, 'waiting'), dark.warn);
  });

  test('presenceColor: claimed → good', () => {
    assert.equal(presenceColor(dark, { presence: 'claimed' }), dark.good);
  });

  test('presenceColor: stale → bad', () => {
    assert.equal(presenceColor(dark, { presence: 'stale' }), dark.bad);
  });

  test('presenceColor: unclaimed → warn', () => {
    assert.equal(presenceColor(dark, { presence: 'unclaimed' }), dark.warn);
  });

  test('light theme also works', () => {
    assert.equal(phaseColor(light, 'completed'), light.good);
    assert.equal(typeof presenceColor(light, { presence: 'stale' }), 'string');
  });
});
