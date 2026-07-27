import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mergeActivity, memoizedMergeActivity } from '../dist/tui/model/timeline-merge.js';

// ─── mergeActivity args/result pass-through (M4b enhancement) ───

describe('tui-redesign-m4b', () => {
test('mergeActivity audit entry passes through args field', () => {
  const audits = [
    { at: '2026-07-26T12:00:00.000Z', action: 'session_register', source: 'apps', status: 'completed', args: { mode: 'root' } },
  ];
  const result = mergeActivity([], audits, 5);
  assert.equal(result.length, 1);
  const entry = result[0];
  assert.equal(entry.kind, 'audit');
  assert.deepEqual(entry.args, { mode: 'root' });
});

test('mergeActivity audit entry passes through result field', () => {
  const audits = [
    { at: '2026-07-26T12:00:00.000Z', action: 'read_file', source: 'actions', status: 'completed', result: { path: '/tmp/readme', content: 'hello' } },
  ];
  const result = mergeActivity([], audits, 5);
  assert.equal(result.length, 1);
  const entry = result[0];
  assert.deepEqual(entry.result, { path: '/tmp/readme', content: 'hello' });
});

test('mergeActivity audit entry with args/result preserves all existing fields', () => {
  const audits = [
    { at: '2026-07-26T12:00:00.000Z', action: 'execute_cli', source: 'apps', status: 'failed', durationMs: 500, sessionName: 'dev', errorCode: 'E001', args: { cmd: 'ls' }, result: { stderr: 'not found' } },
  ];
  const result = mergeActivity([], audits, 5);
  const entry = result[0];
  assert.equal(entry.action, 'execute_cli');
  assert.equal(entry.source, 'apps');
  assert.equal(entry.status, 'failed');
  assert.equal(entry.durationMs, 500);
  assert.equal(entry.sessionName, 'dev');
  assert.equal(entry.errorCode, 'E001');
  assert.deepEqual(entry.args, { cmd: 'ls' });
  assert.deepEqual(entry.result, { stderr: 'not found' });
});

test('mergeActivity args/result are undefined when not provided', () => {
  const audits = [
    { at: '2026-07-26T12:00:00.000Z', action: 'x', source: 'actions', status: 'completed' },
  ];
  const result = mergeActivity([], audits, 5);
  const entry = result[0];
  assert.equal(entry.args, undefined);
  assert.equal(entry.result, undefined);
});

test('mergeActivity audit with nested args/result in descending order', () => {
  const audits = [
    { at: '2026-07-26T10:00:00.000Z', action: 'a', source: 'apps', status: 'completed', args: { step: 1 } },
    { at: '2026-07-26T11:00:00.000Z', action: 'b', source: 'apps', status: 'completed', result: { ok: true } },
  ];
  const result = mergeActivity([], audits, 5);
  // newest first
  assert.equal(result[0].action, 'b');
  assert.deepEqual(result[0].result, { ok: true });
  assert.equal(result[1].action, 'a');
  assert.deepEqual(result[1].args, { step: 1 });
});

test('mergeActivity audit policy_rejected with args', () => {
  const audits = [
    { at: '2026-07-26T12:00:00.000Z', action: 'write_file', source: 'apps', status: 'policy_rejected', errorCode: 'POLICY_DENIED', args: { path: '/etc/hosts' } },
  ];
  const result = mergeActivity([], audits, 5);
  const entry = result[0];
  assert.equal(entry.status, 'policy_rejected');
  assert.equal(entry.errorCode, 'POLICY_DENIED');
  assert.deepEqual(entry.args, { path: '/etc/hosts' });
  assert.equal(entry.result, undefined);
});

test('mergeActivity handles large args safely', () => {
  const largeArgs = { content: 'A'.repeat(10000) };
  const audits = [
    { at: '2026-07-26T12:00:00.000Z', action: 'write_file', source: 'apps', status: 'completed', args: largeArgs },
  ];
  const result = mergeActivity([], audits, 5);
  assert.equal(result[0].args.content.length, 10000);
});

test('mergeActivity handles null args and result', () => {
  const audits = [
    { at: '2026-07-26T12:00:00.000Z', action: 'x', source: 'actions', status: 'completed', args: null, result: null },
  ];
  const result = mergeActivity([], audits, 5);
  assert.equal(result[0].args, null);
  assert.equal(result[0].result, null);
});

test('memoizedMergeActivity args/result included in memoization', () => {
  const audits1 = [{ at: '2026-07-26T12:00:00.000Z', action: 'a', source: 'apps', status: 'completed', args: { v: 1 } }];
  const audits2 = [{ at: '2026-07-26T12:00:00.000Z', action: 'a', source: 'apps', status: 'completed', args: { v: 2 } }];
  const r1 = memoizedMergeActivity('r1', [], audits1, 10);
  const r2 = memoizedMergeActivity('r1', [], audits2, 10); // same revision, different audits — but memo uses revision only
  // same revision returns same cached reference regardless of new args
  assert.strictEqual(r1, r2);
});
});
