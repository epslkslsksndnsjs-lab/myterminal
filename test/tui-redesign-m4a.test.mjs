import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { viewForHistoryEntry } from '../dist/tui/model/history-entry.js';

// ═══ session_created ═══

describe('tui-redesign-m4a', () => {
test('viewForHistoryEntry session_created zh', () => {
  const entry = { at: '2026-07-25T09:39:38.541Z', type: 'session_created', data: { mode: 'root' } };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.type, 'session_created');
  assert.equal(view.icon, '◆');
  assert.equal(view.tone, 'accent');
  assert.equal(view.title, '创建会话');
  assert.equal(view.detail, '模式: root');
});

test('viewForHistoryEntry session_created en', () => {
  const entry = { at: '2026-07-25T09:39:38.541Z', type: 'session_created', data: { mode: 'child' } };
  const view = viewForHistoryEntry(entry, false);
  assert.equal(view.title, 'Session created');
  assert.equal(view.detail, 'mode: child');
});

test('viewForHistoryEntry session_created no mode', () => {
  const entry = { at: '2026-07-25T09:39:38.541Z', type: 'session_created', data: {} };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.detail, undefined);
});

// ═══ tool_audit ═══

test('viewForHistoryEntry tool_audit completed', () => {
  const entry = { at: '2026-07-25T09:39:38.544Z', type: 'tool_audit', data: { action: 'read_file', tool: 'read_file', status: 'completed', durationMs: 12 } };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.icon, '⚙');
  assert.equal(view.tone, 'good');
  assert.equal(view.title, 'read_file');
  assert.ok(view.detail.includes('completed'));
  assert.ok(view.detail.includes('12ms'));
});

test('viewForHistoryEntry tool_audit running', () => {
  const entry = { at: '2026-07-25T09:39:38.540Z', type: 'tool_audit', data: { action: 'session_register', tool: 'session_register', status: 'running', durationMs: 0 } };
  const view = viewForHistoryEntry(entry, false);
  assert.equal(view.tone, 'accent');
  assert.ok(view.detail.includes('running'));
});

test('viewForHistoryEntry tool_audit failed', () => {
  const entry = { at: '2026-07-25T10:00:00.000Z', type: 'tool_audit', data: { action: 'execute_cli', status: 'failed' } };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.tone, 'bad');
});

test('viewForHistoryEntry tool_audit policy_rejected', () => {
  const entry = { at: '2026-07-25T10:00:00.000Z', type: 'tool_audit', data: { action: 'write_file', status: 'policy_rejected' } };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.tone, 'warn');
});

test('viewForHistoryEntry tool_audit timeout', () => {
  const entry = { at: '2026-07-25T10:00:00.000Z', type: 'tool_audit', data: { action: 'execute_cli', status: 'timeout' } };
  const view = viewForHistoryEntry(entry, false);
  assert.equal(view.tone, 'bad');
});

test('viewForHistoryEntry tool_audit no action fallback', () => {
  const entry = { at: '2026-07-25T10:00:00.000Z', type: 'tool_audit', data: {} };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.title, '工具调用');
});

// ═══ checkpoint ═══

test('viewForHistoryEntry checkpoint with summary', () => {
  const entry = { at: '2026-07-25T09:46:20.933Z', type: 'checkpoint', data: { phase: 'working', summary: 'Building e2e-testing-system project', tags: ['exploration'] } };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.icon, '⏺');
  assert.equal(view.tone, 'accent');
  assert.equal(view.title, 'Building e2e-testing-system project');
  assert.ok(view.detail.includes('working'));
  assert.ok(view.detail.includes('#exploration'));
});

test('viewForHistoryEntry checkpoint no summary fallback', () => {
  const entry = { at: '2026-07-25T09:46:20.933Z', type: 'checkpoint', data: { phase: 'working' } };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.title, '检查点');
});

test('viewForHistoryEntry checkpoint en fallback', () => {
  const entry = { at: '2026-07-25T09:46:20.933Z', type: 'checkpoint', data: {} };
  const view = viewForHistoryEntry(entry, false);
  assert.equal(view.title, 'Checkpoint');
  assert.equal(view.detail, undefined);
});

// ═══ event ═══

test('viewForHistoryEntry event', () => {
  const entry = { at: '2026-07-25T09:41:57.234Z', type: 'event', data: { kind: 'checkpoint_due', sourceSessionId: 'ses_test' } };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.icon, '▸');
  assert.equal(view.tone, 'muted');
  assert.equal(view.title, 'checkpoint_due');
  assert.ok(view.detail.includes('ses_test'));
});

test('viewForHistoryEntry event no kind fallback', () => {
  const entry = { at: '2026-07-25T09:41:57.234Z', type: 'event', data: {} };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.title, '事件');
});

// ═══ message_received / message_sent ═══

test('viewForHistoryEntry message_received zh', () => {
  const entry = { at: '2026-07-25T10:09:39.211Z', type: 'message_received', data: { body: '请创建 README.md', from: 'ses_a', to: 'ses_b' } };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.icon, '✉');
  assert.equal(view.tone, 'accent');
  assert.equal(view.title, '请创建 README.md');
  assert.ok(view.detail.includes('收到'));
});

test('viewForHistoryEntry message_sent en', () => {
  const entry = { at: '2026-07-25T10:09:39.211Z', type: 'message_sent', data: { body: 'Hello', from: 'ses_a', to: 'ses_b' } };
  const view = viewForHistoryEntry(entry, false);
  assert.ok(view.detail.includes('Sent'));
});

test('viewForHistoryEntry message empty body', () => {
  const entry = { at: '2026-07-25T10:09:39.211Z', type: 'message_received', data: {} };
  const view = viewForHistoryEntry(entry, true);
  assert.ok(view.title.includes('空消息'));
});

test('viewForHistoryEntry message body truncation', () => {
  const long = 'A'.repeat(200);
  const entry = { at: '2026-07-25T10:09:39.211Z', type: 'message_received', data: { body: long } };
  const view = viewForHistoryEntry(entry, true);
  assert.ok(view.title.length <= 103); // 100 + '…'
  assert.ok(view.title.endsWith('…'));
});

// ═══ claimed ═══

test('viewForHistoryEntry claimed', () => {
  const entry = { at: '2026-07-25T10:21:25.849Z', type: 'claimed', data: { controllerId: 'ctl_abc' } };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.icon, '◆');
  assert.equal(view.tone, 'good');
  assert.equal(view.title, '已接管');
  assert.ok(view.detail.includes('ctl_abc'));
});

test('viewForHistoryEntry claimed en', () => {
  const entry = { at: '2026-07-25T10:21:25.849Z', type: 'claimed', data: {} };
  const view = viewForHistoryEntry(entry, false);
  assert.equal(view.title, 'Claimed');
  assert.equal(view.detail, undefined);
});

// ═══ released ═══

test('viewForHistoryEntry released', () => {
  const entry = { at: '2026-07-25T10:00:00.897Z', type: 'released', data: { phase: 'completed', presence: 'unclaimed' } };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.icon, '◆');
  assert.equal(view.tone, 'muted');
  assert.equal(view.title, '已释放');
  assert.ok(view.detail.includes('completed'));
});

// ═══ stale ═══

test('viewForHistoryEntry stale', () => {
  const entry = { at: '2026-07-25T07:55:56.617Z', type: 'stale', data: {} };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.icon, '◆');
  assert.equal(view.tone, 'warn');
  assert.equal(view.title, '已过期');
  assert.equal(view.detail, undefined);
});

test('viewForHistoryEntry stale en', () => {
  const entry = { at: '2026-07-25T07:55:56.617Z', type: 'stale', data: {} };
  const view = viewForHistoryEntry(entry, false);
  assert.equal(view.title, 'Stale');
});

// ═══ tags_updated ═══

test('viewForHistoryEntry tags_updated with tags', () => {
  const entry = { at: '2026-07-25T10:06:35.376Z', type: 'tags_updated', data: { tags: ['exploration', 'demo'] } };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.icon, '◆');
  assert.equal(view.tone, 'muted');
  assert.equal(view.title, 'exploration, demo');
  assert.equal(view.detail, '标签已更新');
});

test('viewForHistoryEntry tags_updated empty tags', () => {
  const entry = { at: '2026-07-25T10:06:35.376Z', type: 'tags_updated', data: { tags: [] } };
  const view = viewForHistoryEntry(entry, true);
  assert.ok(view.title.includes('无标签'));
});

// ═══ task_package ═══

test('viewForHistoryEntry task_package with details', () => {
  const entry = { at: '2026-07-25T08:35:54.968Z', type: 'task_package', data: { objective: 'Build project', background: 'Setup', deliverables: ['a', 'b'], constraints: ['c'] } };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.icon, '◆');
  assert.equal(view.tone, 'accent');
  assert.equal(view.title, 'Build project');
  assert.ok(view.detail.includes('交付'));
});

test('viewForHistoryEntry task_package zh no objective', () => {
  const entry = { at: '2026-07-25T08:35:54.968Z', type: 'task_package', data: {} };
  const view = viewForHistoryEntry(entry, true);
  assert.ok(view.title.includes('无目标'));
});

// ═══ unknown type fallback ═══

test('viewForHistoryEntry unknown type fallback', () => {
  const entry = { at: '2026-07-25T10:00:00.000Z', type: 'custom_future_type', data: { key: 'value' } };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.icon, '▸');
  assert.equal(view.tone, 'muted');
  assert.equal(view.title, 'custom_future_type');
  // JSON.stringify detail
  assert.ok(view.detail.includes('key'));
});

test('viewForHistoryEntry unknown type detail truncation', () => {
  const longKey = 'x'.repeat(200);
  const entry = { at: '2026-07-25T10:00:00.000Z', type: 'unknown_type', data: { [longKey]: 'value' } };
  const view = viewForHistoryEntry(entry, false);
  assert.ok(view.detail.length <= 123); // 120 + '…'
  assert.ok(view.detail.endsWith('…'));
});

// ═══ defensive: null/primitive data ═══

test('viewForHistoryEntry handles null data gracefully', () => {
  const entry = { at: '2026-07-25T10:00:00.000Z', type: 'session_created', data: null };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.title, '创建会话');
  assert.equal(view.detail, undefined);
});

test('viewForHistoryEntry handles primitive data gracefully', () => {
  const entry = { at: '2026-07-25T10:00:00.000Z', type: 'stale', data: 'string_value' };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.title, '已过期');
});

test('viewForHistoryEntry handles array data gracefully (falls to unknown)', () => {
  const entry = { at: '2026-07-25T10:00:00.000Z', type: 'some_array_type', data: [1, 2, 3] };
  const view = viewForHistoryEntry(entry, true);
  assert.equal(view.tone, 'muted');
  assert.ok(view.detail.includes('1'));
});

// ═══ tool_audit detail truncation ═══

test('viewForHistoryEntry tool_audit detail not truncated for short status', () => {
  const entry = { at: '2026-07-25T09:39:38.544Z', type: 'tool_audit', data: { action: 'read', status: 'ok_custom_long_status_name_but_still_short' } };
  const view = viewForHistoryEntry(entry, false);
  assert.ok(view.detail.length <= 120);
});
});
