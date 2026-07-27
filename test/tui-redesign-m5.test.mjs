import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { groupDiffLines } from '../dist/tui/model/diff-groups.js';

// ─── groupDiffLines 基本切分 ───

describe('tui-redesign-m5', () => {
test('groupDiffLines splits multi-file diff', () => {
  const lines = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 123..456',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' unchanged',
    '+added',
    'diff --git a/src/b.ts b/src/b.ts',
    'index 789..abc',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -5,2 +5,3 @@',
    '-removed',
    ' unchanged',
  ];
  const groups = groupDiffLines(lines);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].file, 'src/a.ts');
  assert.deepEqual(groups[0].header, ['index 123..456', '--- a/src/a.ts', '+++ b/src/a.ts']);
  assert.deepEqual(groups[0].lines, ['@@ -1,3 +1,4 @@', ' unchanged', '+added']);
  assert.equal(groups[1].file, 'src/b.ts');
  assert.deepEqual(groups[1].header, ['index 789..abc', '--- a/src/b.ts', '+++ b/src/b.ts']);
  assert.deepEqual(groups[1].lines, ['@@ -5,2 +5,3 @@', '-removed', ' unchanged']);
});

test('groupDiffLines handles preamble before first diff --git', () => {
  const lines = [
    'warning: some issue',
    'diff --git a/file.ts b/file.ts',
    'index 111..222',
    '@@ -1 +1 @@',
    '+hello',
  ];
  const groups = groupDiffLines(lines);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].file, '');
  assert.deepEqual(groups[0].lines, ['warning: some issue']);
  assert.equal(groups[1].file, 'file.ts');
});

test('groupDiffLines handles empty input', () => {
  const groups = groupDiffLines([]);
  assert.deepEqual(groups, []);
});

test('groupDiffLines handles single file without preamble', () => {
  const lines = [
    'diff --git a/only.ts b/only.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ];
  const groups = groupDiffLines(lines);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].file, 'only.ts');
  assert.deepEqual(groups[0].header, []);
  assert.deepEqual(groups[0].lines, ['@@ -1 +1 @@', '-old', '+new']);
});

test('groupDiffLines handles diff --git with no b/ path', () => {
  const lines = [
    'diff --git a/file.ts',
    '@@ -1 +1 @@',
    '+line',
  ];
  const groups = groupDiffLines(lines);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].file, '');
});

test('groupDiffLines handles trailing preamble after last file', () => {
  const lines = [
    'diff --git a/file.ts b/file.ts',
    '@@ -1 +1 @@',
    '+ok',
    'some trailing note',
  ];
  const groups = groupDiffLines(lines);
  // trailing note is inside the last group as a line (not a preamble)
  assert.equal(groups.length, 1);
  assert.equal(groups[0].file, 'file.ts');
  assert.ok(groups[0].lines.includes('some trailing note'));
});
});
