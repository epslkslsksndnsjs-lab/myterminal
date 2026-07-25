import test from 'node:test';
import assert from 'node:assert/strict';
import { mascotMoodFor } from '../dist/tui/model/mascot-mood.js';
import { copyFor, verbFor, verbLabel, greetingFor } from '../dist/tui/copy/index.js';
import { paletteFor } from '../dist/tui/theme/palette.js';

test('mascotMoodFor prioritizes sad > worried > expectant > thinking > happy', () => {
  assert.equal(mascotMoodFor({}), 'happy');
  assert.equal(mascotMoodFor({ busy: true }), 'thinking');
  assert.equal(mascotMoodFor({ pendingUnclaimed: 2 }), 'expectant');
  assert.equal(mascotMoodFor({ pendingUnclaimed: 2, stalePending: 1 }), 'worried');
  assert.equal(mascotMoodFor({ pendingUnclaimed: 2, stalePending: 1, recentError: true }), 'sad');
  assert.equal(mascotMoodFor({ fatalError: true }), 'sad');
  assert.equal(mascotMoodFor({ topologyDegraded: true }), 'sad');
  assert.equal(mascotMoodFor({ busy: true, pendingUnclaimed: 1 }), 'expectant');
});

test('verbFor locks one verb per operation key deterministically', () => {
  const copy = copyFor(true);
  const first = verbFor(copy, 'diff-refresh');
  assert.equal(first, verbFor(copy, 'diff-refresh'));
  assert.ok(copy.statusVerbs.includes(first));
  assert.equal(verbFor(copyFor(false), 'x'), verbFor(copyFor(false), 'x'));
  assert.equal(verbFor(copy, ''), copy.statusVerbs[0]);
});

test('verbLabel renders language-specific shapes', () => {
  const zh = verbLabel(copyFor(true), 'k');
  assert.ok(zh.startsWith('正在') && zh.endsWith('…'), zh);
  const english = verbLabel(copyFor(false), 'k');
  assert.ok(!english.startsWith('正在') && english.endsWith('…'), english);
});

test('greetingFor returns a non-empty string for every hour', () => {
  const copy = copyFor(true);
  for (let hour = 0; hour < 24; hour += 1) {
    const at = new Date(2026, 0, 1, hour);
    assert.equal(typeof greetingFor(copy, at), 'string');
    assert.ok(greetingFor(copy, at).length > 0);
  }
});

test('copy modules expose all six empty states in both languages', () => {
  for (const copy of [copyFor(true), copyFor(false)]) {
    for (const key of ['sessions', 'messages', 'extensions', 'logs', 'diffClean', 'timeline']) {
      assert.ok(copy.emptyStates[key].length > 0, key);
    }
  }
});

test('warm palettes provide all 16 roles as hex colors and differ per theme', () => {
  const dark = paletteFor('dark');
  const light = paletteFor('light');
  const roles = ['background', 'panel', 'panelAlt', 'selected', 'selectedText', 'text', 'muted', 'accent', 'good', 'warn', 'bad', 'border', 'user', 'agent', 'tool', 'system'];
  for (const role of roles) {
    assert.match(dark[role], /^#[0-9A-Fa-f]{6}$/, `dark.${role}`);
    assert.match(light[role], /^#[0-9A-Fa-f]{6}$/, `light.${role}`);
  }
  assert.notEqual(dark.background, light.background);
  assert.notEqual(dark.accent, light.accent);
  assert.equal(paletteFor('dark') !== dark, true, 'paletteFor returns a fresh copy');
});
