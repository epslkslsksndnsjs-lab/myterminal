import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mergeActivity, memoizedMergeActivity } from '../dist/tui/model/timeline-merge.js';
import { relativeTime } from '../dist/tui/model/relative-time.js';
import { copyFor } from '../dist/tui/copy/index.js';

// ─── timeline-merge ───

describe('tui-redesign-m3', () => {
test('mergeActivity merges messages and audits in descending time order', () => {
  const messages = [
    { id: 'm1', from: 's1', to: 's2', body: 'hello', createdAt: '2026-07-26T10:00:00.000Z' },
    { id: 'm2', from: 's2', to: 's1', body: 'hi', createdAt: '2026-07-26T11:00:00.000Z' },
  ];
  const audits = [
    { at: '2026-07-26T10:30:00.000Z', action: 'read_file', source: 'actions', status: 'completed', durationMs: 12 },
  ];
  const result = mergeActivity(messages, audits, 10);
  // newest first: m2(11:00) > audit(10:30) > m1(10:00)
  assert.equal(result.length, 3);
  assert.equal(result[0].kind, 'message');
  assert.equal(result[0].body, 'hi');
  assert.equal(result[1].kind, 'audit');
  assert.equal(result[1].action, 'read_file');
  assert.equal(result[2].kind, 'message');
  assert.equal(result[2].body, 'hello');
});

test('mergeActivity respects limit', () => {
  const messages = [
    { id: 'a', from: 'x', to: 'y', body: '.', createdAt: '2026-07-26T10:00:00.000Z' },
    { id: 'b', from: 'x', to: 'y', body: '.', createdAt: '2026-07-26T11:00:00.000Z' },
    { id: 'c', from: 'x', to: 'y', body: '.', createdAt: '2026-07-26T12:00:00.000Z' },
  ];
  const audits = [];
  const result = mergeActivity(messages, audits, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].at, '2026-07-26T12:00:00.000Z');
  assert.equal(result[1].at, '2026-07-26T11:00:00.000Z');
});

test('mergeActivity handles empty inputs', () => {
  assert.equal(mergeActivity([], [], 10).length, 0);
});

test('mergeActivity audit entry has correct kind and fields', () => {
  const audits = [
    { at: '2026-07-26T12:00:00.000Z', action: 'execute_cli', source: 'apps', status: 'running', sessionName: 'dev', errorCode: 'E001' },
  ];
  const result = mergeActivity([], audits, 5);
  assert.equal(result.length, 1);
  const entry = result[0];
  assert.equal(entry.kind, 'audit');
  assert.equal(entry.action, 'execute_cli');
  assert.equal(entry.source, 'apps');
  assert.equal(entry.status, 'running');
  assert.equal(entry.sessionName, 'dev');
  assert.equal(entry.errorCode, 'E001');
});

test('memoizedMergeActivity returns same reference for same revision', () => {
  const msgs = [{ id: 'm', from: 'a', to: 'b', body: 'x', createdAt: '2026-07-26T10:00:00.000Z' }];
  const audits = [{ at: '2026-07-26T10:30:00.000Z', action: 'read', source: 'actions', status: 'completed' }];
  const r1 = memoizedMergeActivity('rev1', msgs, audits, 10);
  const r2 = memoizedMergeActivity('rev1', msgs, audits, 10);
  assert.strictEqual(r1, r2, 'same revision should return the exact same array reference');
});

test('memoizedMergeActivity recomputes for different revision', () => {
  const msgs = [{ id: 'm', from: 'a', to: 'b', body: 'x', createdAt: '2026-07-26T10:00:00.000Z' }];
  const audits = [];
  const r1 = memoizedMergeActivity('rev1', msgs, audits, 10);
  const r2 = memoizedMergeActivity('rev2', msgs, audits, 10);
  // different revisions should NOT share the same reference
  assert.notStrictEqual(r1, r2, 'different revisions should recompute');
});

// 回归：终审发现单槽缓存 key 不含 limit 时，Home(limit=7) 与 Timeline(limit=0)
// 同 revision 交替渲染会互相污染（Timeline 只显示 7 条 / Home 渲染全量）。
test('memoizedMergeActivity does not share cache across different limits at same revision', () => {
  const msgs = Array.from({ length: 12 }, (_, i) => ({
    id: `m${i}`, from: 'a', to: 'b', body: 'x', createdAt: `2026-07-26T10:${String(i).padStart(2, '0')}:00.000Z`,
  }));
  const audits = [];
  const full = memoizedMergeActivity('rev-same', msgs, audits, 0);
  assert.equal(full.length, 12, 'limit=0 should return all entries');
  const top7 = memoizedMergeActivity('rev-same', msgs, audits, 7);
  assert.equal(top7.length, 7, 'same revision with limit=7 must NOT return the cached full result');
  assert.notStrictEqual(full, top7, 'different limits must not share the cached reference');
  // 切回 limit=0：缓存被 limit=7 覆盖后 miss 重算，结果仍然完整正确
  const fullAgain = memoizedMergeActivity('rev-same', msgs, audits, 0);
  assert.equal(fullAgain.length, 12, 'switching back to limit=0 recomputes the full result');
  // 同 (revision, limit) 连续调用仍命中缓存（同引用）
  const top7Again = memoizedMergeActivity('rev-same', msgs, audits, 7);
  const top7Cached = memoizedMergeActivity('rev-same', msgs, audits, 7);
  assert.strictEqual(top7Again, top7Cached, 'same revision+limit still hits the cache');
});

test('mergeActivity audit running status is preserved', () => {
  const audits = [{ at: '2026-07-26T12:00:00.000Z', action: 'x', source: 'actions', status: 'running' }];
  const result = mergeActivity([], audits, 5);
  assert.equal(result[0].status, 'running');
});

test('mergeActivity does not mutate input arrays', () => {
  const messages = [{ id: 'm', from: 'a', to: 'b', body: 'x', createdAt: '2026-07-26T10:00:00.000Z' }];
  const audits = [{ at: '2026-07-26T10:00:00.000Z', action: 'x', source: 'actions', status: 'completed' }];
  const msgCopy = [...messages];
  const auditCopy = [...audits];
  mergeActivity(messages, audits, 10);
  assert.deepEqual(messages, msgCopy, 'messages array should not be mutated');
  assert.deepEqual(audits, auditCopy, 'audits array should not be mutated');
});

test('mergeActivity handles limit=0 as no truncation', () => {
  const messages = [
    { id: 'a', from: 'x', to: 'y', body: '.', createdAt: '2026-07-26T10:00:00.000Z' },
    { id: 'b', from: 'x', to: 'y', body: '.', createdAt: '2026-07-26T11:00:00.000Z' },
  ];
  const result = mergeActivity(messages, [], 0);
  assert.equal(result.length, 2);
});

// ─── relative-time ───

test('relativeTime returns just now for <60s', () => {
  const now = new Date('2026-07-26T12:00:30.000Z');
  const at = '2026-07-26T12:00:00.000Z';
  assert.equal(relativeTime(at, now, true), '刚刚');
  assert.equal(relativeTime(at, now, false), 'just now');
});

test('relativeTime returns minutes ago for <60m', () => {
  const now = new Date('2026-07-26T12:30:00.000Z');
  const at = '2026-07-26T12:00:00.000Z';
  assert.equal(relativeTime(at, now, true), '30 分钟前');
  assert.equal(relativeTime(at, now, false), '30m ago');
});

test('relativeTime returns hours ago for <24h', () => {
  const now = new Date('2026-07-26T18:00:00.000Z');
  const at = '2026-07-26T12:00:00.000Z';
  assert.equal(relativeTime(at, now, true), '6 小时前');
  assert.equal(relativeTime(at, now, false), '6h ago');
});

test('relativeTime returns date string for >=24h', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  const at = '2026-07-26T12:00:00.000Z';
  assert.equal(relativeTime(at, now, true), '2026-07-26');
  assert.equal(relativeTime(at, now, false), '2026-07-26');
});

test('relativeTime returns original string for invalid dates', () => {
  const now = new Date();
  assert.equal(relativeTime('not-a-date', now, true), 'not-a-date');
  assert.equal(relativeTime('', now, false), '');
});

test('relativeTime handles future dates gracefully', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  const at = '2026-07-26T13:00:00.000Z';
  assert.equal(relativeTime(at, now, true), '刚刚');
});

// ─── Copy homeSummary ───

test('homeSummary zh: active>0 pending=0', () => {
  const copy = copyFor(true);
  assert.equal(copy.homeSummary(3, 0), '3 个 session 正在干活，一切正常。');
});

test('homeSummary zh: pending>0', () => {
  const copy = copyFor(true);
  assert.equal(copy.homeSummary(0, 2), '2 个 session 等你安排 controller，按 2 去看看。');
});

test('homeSummary zh: both zero', () => {
  const copy = copyFor(true);
  assert.equal(copy.homeSummary(0, 0), '现在很闲。按 n 派个活儿，或输入 /new。');
});

test('homeSummary en: active>0 pending=0', () => {
  const copy = copyFor(false);
  assert.equal(copy.homeSummary(5, 0), '5 session(s) on the job. All good.');
});

test('homeSummary en: pending>0', () => {
  const copy = copyFor(false);
  assert.equal(copy.homeSummary(0, 1), '1 session(s) waiting for a controller — press 2.');
});

test('homeSummary en: both zero', () => {
  const copy = copyFor(false);
  assert.equal(copy.homeSummary(0, 0), 'All quiet. Press n to delegate, or type /new.');
});
});
