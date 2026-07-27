import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';

import { TABS, phaseColor, presenceColor } from '../dist/tui/state.js';
import { themeFor } from '../dist/tui/theme/index.js';

describe('TUI state pure functions', () => {
  const dark = themeFor('dark');
  const light = themeFor('light');

  test('TABS contains all 9 pages', () => {
    assert.equal(TABS.length, 9);
    assert.ok(TABS.includes('Overview'));
    assert.ok(TABS.includes('Sessions'));
    assert.ok(TABS.includes('Settings'));
    assert.ok(TABS.includes('Logs'));
    assert.ok(TABS.includes('Subagents'));
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
