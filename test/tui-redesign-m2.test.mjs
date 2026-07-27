import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { routeCommand, commandCompletions } from '../dist/tui/model/command-router.js';

// ─── navigate ───
describe('tui-redesign-m2', () => {
test('routeCommand navigates to pages by command name', () => {
  assert.deepEqual(routeCommand('/home'), { kind: 'navigate', tab: 0 });
  assert.deepEqual(routeCommand('/overview'), { kind: 'navigate', tab: 0 });
  assert.deepEqual(routeCommand('/sessions'), { kind: 'navigate', tab: 1 });
  assert.deepEqual(routeCommand('/messages'), { kind: 'navigate', tab: 2 });
  assert.deepEqual(routeCommand('/timeline'), { kind: 'navigate', tab: 3 });
  assert.deepEqual(routeCommand('/diff'), { kind: 'navigate', tab: 4 });
  assert.deepEqual(routeCommand('/extensions'), { kind: 'navigate', tab: 5 });
  assert.deepEqual(routeCommand('/settings'), { kind: 'navigate', tab: 6 });
  assert.deepEqual(routeCommand('/logs'), { kind: 'navigate', tab: 7 });
});

test('routeCommand navigates with Chinese aliases', () => {
  assert.deepEqual(routeCommand('/概览'), { kind: 'navigate', tab: 0 });
  assert.deepEqual(routeCommand('/会话'), { kind: 'navigate', tab: 1 });
  assert.deepEqual(routeCommand('/消息'), { kind: 'navigate', tab: 2 });
  assert.deepEqual(routeCommand('/时间线'), { kind: 'navigate', tab: 3 });
  assert.deepEqual(routeCommand('/扩展'), { kind: 'navigate', tab: 5 });
  assert.deepEqual(routeCommand('/设置'), { kind: 'navigate', tab: 6 });
  assert.deepEqual(routeCommand('/日志'), { kind: 'navigate', tab: 7 });
});

// ─── pageAction ───
test('routeCommand dispatches page actions', () => {
  assert.deepEqual(routeCommand('/new'), { kind: 'pageAction', action: 'createSession' });
  assert.deepEqual(routeCommand('/send'), { kind: 'pageAction', action: 'sendMessage' });
  assert.deepEqual(routeCommand('/refresh'), { kind: 'pageAction', action: 'refreshDiff' });
});

// ─── help ───
test('routeCommand returns help action', () => {
  assert.deepEqual(routeCommand('/help'), { kind: 'help' });
  assert.deepEqual(routeCommand('/帮助'), { kind: 'help' });
});

// ─── message (non-/ prefix) ───
test('routeCommand treats plain text as message', () => {
  assert.deepEqual(routeCommand('hello world'), { kind: 'message', body: 'hello world' });
  assert.deepEqual(routeCommand('  hi  '), { kind: 'message', body: 'hi' });
  assert.deepEqual(routeCommand(''), { kind: 'message', body: '' });
});

// ─── unknown + suggestion ───
test('routeCommand gives suggestion for unknown / command with prefix match', () => {
  const result = routeCommand('/log');
  assert.equal(result.kind, 'unknown');
  assert.equal(result.suggestion, '/logs');

  const result2 = routeCommand('/set');
  assert.equal(result2.kind, 'unknown');
  assert.equal(result2.suggestion, '/settings');
});

test('routeCommand returns unknown without suggestion for no prefix match', () => {
  const result = routeCommand('/xyzzy');
  assert.equal(result.kind, 'unknown');
  assert.equal(result.suggestion, undefined);
});

// ─── completions ───
test('commandCompletions returns all commands for /', () => {
  const results = commandCompletions('/');
  assert.ok(results.length > 10);
  assert.ok(results.includes('/home'));
  assert.ok(results.includes('/help'));
  assert.ok(results.includes('/日志'));
});

test('commandCompletions filters by prefix', () => {
  const results = commandCompletions('/se');
  assert.ok(results.length >= 2);
  assert.ok(results.includes('/sessions'));
  assert.ok(results.includes('/send'));
  assert.ok(results.includes('/settings'));
  // should not include unrelated commands
  assert.ok(!results.includes('/home'));
  assert.ok(!results.includes('/logs'));
});

test('commandCompletions works with Chinese prefix', () => {
  const results = commandCompletions('/日');
  assert.equal(results.length, 1);
  assert.equal(results[0], '/日志');
});
});
