import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// ── Import 构建产物 ──
import { CostTracker } from '../dist/subagent/cost-tracker.js';
import {
  recordFileRead,
  validateEdit,
  applyEdit,
  clearFileState,
  clearAllFileStates,
} from '../dist/subagent/file-state.js';
import {
  trackShellTask,
  cleanupAgentShellTasks,
  clearAllShellTasks,
  getTrackedCount,
} from '../dist/subagent/shell-tracker.js';
import {
  createSubagent,
  getSubagent,
  updateSubagentStatus,
  collectSubagentResult,
  getSubagentResult,
  syncTasks,
  addAuditLog,
  updateCost,
  updateSubagentCost,
  countRunning,
  getRecentAuditLogs,
  setCleanupDelayMs,
  getCleanupDelayMs,
  clearAllSubagents,
} from '../dist/subagent/store.js';

// ──────────────────────────────────────────────
// cost-tracker 测试
// ──────────────────────────────────────────────

// 用例 1：单次 addUsage + getTotalCost 计算正确
test('CostTracker single addUsage accumulates correctly', () => {
  const tracker = new CostTracker('gpt-4o');
  // gpt-4o: input 2.5, output 10 per 1M
  tracker.addUsage({ input_tokens: 1_000_000, output_tokens: 500_000 });

  const expected = 2.5 + 5.0; // 1M * 2.5/1M + 0.5M * 10/1M
  assert.ok(Math.abs(tracker.getTotalCost() - expected) < 0.001, `expected ~${expected}, got ${tracker.getTotalCost()}`);
});

// 用例 2：多次 addUsage + cacheRead 累积正确
test('CostTracker multiple addUsage with cacheRead', () => {
  const tracker = new CostTracker('gpt-4o');
  tracker.addUsage({ input_tokens: 800_000, output_tokens: 300_000, cache_read_input_tokens: 200_000 });
  // 800K input * 2.5/1M + 300K output * 10/1M + 200K cache * 1.25/1M
  // = 2.0 + 3.0 + 0.25 = 5.25
  tracker.addUsage({ input_tokens: 200_000, output_tokens: 100_000 });
  // 200K input * 2.5/1M + 100K output * 10/1M = 0.5 + 1.0 = 1.5
  // total = 6.75

  const usage = tracker.getUsage();
  assert.equal(usage.inputTokens, 1_000_000);
  assert.equal(usage.outputTokens, 400_000);
  assert.equal(usage.cacheReadTokens, 200_000);
  assert.ok(Math.abs(usage.totalUSD - 6.75) < 0.001, `expected ~6.75, got ${usage.totalUSD}`);
});

// 用例 3：前缀匹配——gpt-4o-2024-08-06 按 gpt-4o 定价
test('CostTracker matches model by prefix', () => {
  const tracker = new CostTracker('gpt-4o-2024-08-06');
  tracker.addUsage({ input_tokens: 1_000_000, output_tokens: 0 });
  assert.ok(Math.abs(tracker.getTotalCost() - 2.5) < 0.001, 'should use gpt-4o pricing');
});

// 用例 4：未知模型不抛错，按 provider 保守估算
test('CostTracker falls back for unknown model without throwing', () => {
  // deepseek-v4-unknown → deepseek-chat pricing
  const tracker1 = new CostTracker('deepseek-v4-unknown');
  tracker1.addUsage({ input_tokens: 1_000_000, output_tokens: 0 });
  assert.ok(Math.abs(tracker1.getTotalCost() - 0.27) < 0.01, 'should fallback to deepseek-chat');

  // gpt-unknown → gpt-4o pricing
  const tracker2 = new CostTracker('gpt-unknown-thing');
  tracker2.addUsage({ input_tokens: 1_000_000, output_tokens: 0 });
  assert.ok(Math.abs(tracker2.getTotalCost() - 2.5) < 0.01, 'should fallback to gpt-4o');

  // completely unknown → gpt-4o
  const tracker3 = new CostTracker('some-unknown-model');
  tracker3.addUsage({ input_tokens: 1_000_000, output_tokens: 0 });
  assert.ok(Math.abs(tracker3.getTotalCost() - 2.5) < 0.01, 'should fallback to gpt-4o');

  // Doesn't throw
  assert.ok(true);
});

// ──────────────────────────────────────────────
// file-state 测试
// ──────────────────────────────────────────────

// 用例 5：未读过就 validateEdit → 拒绝
test('file-state rejects edit without prior read', () => {
  clearAllFileStates();
  const result = validateEdit('agent-A', '/some/file.ts', 'hello');
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('read_file first'), `message should mention read_file: ${result.message}`);
});

// 用例 6：0 匹配 → 拒绝并含前 5 行预览
test('file-state rejects 0-match edit with preview', () => {
  clearAllFileStates();
  const content = 'line one\nline two\nline three\nline four\nline five\nline six';
  recordFileRead('agent-A', '/test.txt', content);
  const result = validateEdit('agent-A', '/test.txt', 'nonexistent');
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('not found'));
  assert.ok(result.message.includes('1\tline one'), 'should contain first 5 line preview');
  assert.ok(result.message.includes('5\tline five'), 'should contain 5 lines');
  assert.ok(!result.message.includes('6\tline six'), 'should NOT contain line 6 (only first 5)');
});

// 用例 7：2 处匹配无 replaceAll → 拒绝
test('file-state rejects multi-match without replaceAll', () => {
  clearAllFileStates();
  const content = 'hello\nworld\nhello';
  recordFileRead('agent-A', '/test.txt', content);
  const result = validateEdit('agent-A', '/test.txt', 'hello', false);
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('Found 2 matches'));
});

// 用例 7b：2 处匹配有 replaceAll → 允许
test('file-state allows multi-match with replaceAll', () => {
  clearAllFileStates();
  const content = 'hello\nworld\nhello';
  recordFileRead('agent-A', '/test.txt', content);
  const result = validateEdit('agent-A', '/test.txt', 'hello', true);
  assert.equal(result.ok, true);
  const newContent = applyEdit('agent-A', '/test.txt', 'hello', 'hi', true);
  assert.equal(newContent, 'hi\nworld\nhi');

  // 再次验证旧串 0 匹配（缓存已更新）
  const second = validateEdit('agent-A', '/test.txt', 'hello');
  assert.equal(second.ok, false);
});

// 用例 8：单匹配 → applyEdit 成功
test('file-state single match applyEdit succeeds', () => {
  clearAllFileStates();
  const content = 'hello world\nfoo bar';
  recordFileRead('agent-A', '/test.txt', content);
  const result = validateEdit('agent-A', '/test.txt', 'hello world');
  assert.equal(result.ok, true);
  const newContent = applyEdit('agent-A', '/test.txt', 'hello world', 'hi there');
  assert.equal(newContent, 'hi there\nfoo bar');
});

// 用例 9：agent 隔离——A 读过但 B 被拒绝
test('file-state enforces agent isolation', () => {
  clearAllFileStates();
  recordFileRead('agent-A', '/shared.txt', 'secret');
  const result = validateEdit('agent-B', '/shared.txt', 'secret');
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('read_file first'), 'agent B should not see agent A file state');
});

// 用例 10：clearFileState 后回到"未读过"
test('file-state clearFileState resets to unread', () => {
  clearAllFileStates();
  recordFileRead('agent-C', '/x.txt', 'content');
  clearFileState('agent-C');
  const result = validateEdit('agent-C', '/x.txt', 'content');
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('read_file first'));
});

// ──────────────────────────────────────────────
// shell-tracker 测试
// ──────────────────────────────────────────────

// 用例 11：track + cleanup 杀正在运行的进程
test('shell-tracker kills running process on cleanup', { timeout: 15_000 }, async () => {
  clearAllShellTasks();

  // spawn a long-running process
  const child = spawn('sleep', ['10'], { detached: true });
  trackShellTask('agent-1', child);

  // process should be tracked
  assert.equal(getTrackedCount('agent-1'), 1);

  // cleanup should kill it
  cleanupAgentShellTasks('agent-1');

  // wait for exit event (cleanup sent SIGTERM)
  await new Promise(resolve => {
    child.on('exit', resolve);
  });

  // process.kill(-pid) doesn't set child.killed flag, but the process did exit
  assert.ok(child.signalCode !== null || child.exitCode !== null, 'process should have exited');

  // after exit, tracked count should be 0 (auto-remove on exit)
  await new Promise(r => setTimeout(r, 50));
  assert.equal(getTrackedCount('agent-1'), 0);
});

// 用例 12：已退出进程 cleanup 不抛错
test('shell-tracker does not throw on already-exited process', async () => {
  clearAllShellTasks();

  const child = spawn('echo', ['hi']);
  trackShellTask('agent-2', child);

  await new Promise(resolve => child.on('exit', resolve));

  // should not throw
  assert.doesNotThrow(() => cleanupAgentShellTasks('agent-2'));
});

// ──────────────────────────────────────────────
// store 测试
// ──────────────────────────────────────────────

// 用例 13：create/get/update 全流程
test('subagent store full CRUD flow', () => {
  clearAllSubagents();

  const record = createSubagent('sub-1', { subject: 'Test task', description: 'Test description' });
  assert.equal(record.status, 'running');
  assert.equal(record.tasks.length, 1);
  assert.equal(record.tasks[0].subject, 'Test task');
  assert.equal(record.tasks[0].status, 'pending');
  assert.equal(record.cost.totalUSD, 0);
  assert.ok(record.createdAt > 0);

  // get
  const fetched = getSubagent('sub-1');
  assert.ok(fetched);
  assert.equal(fetched.status, 'running');

  // update to completed
  const updated = updateSubagentStatus('sub-1', 'completed', { result: 'All done!' });
  assert.ok(updated);
  assert.equal(updated.status, 'completed');
  assert.equal(updated.result, 'All done!');
  assert.ok(updated.completedAt > 0, 'completedAt should be set for terminal state');
});

// 用例 14：collectSubagentResult 返回并删除
test('subagent store collectSubagentResult removes record', () => {
  clearAllSubagents();
  createSubagent('sub-2', { subject: 'Collectable' });
  updateSubagentStatus('sub-2', 'completed', { result: 'Done' });

  const collected = collectSubagentResult('sub-2');
  assert.ok(collected);
  assert.equal(collected.result, 'Done');

  // 再次 get 应该 undefined
  assert.equal(getSubagent('sub-2'), undefined);
});

// 用例 15：auditLogs 超过 50 条只保留最近 50
test('subagent store auditLogs caps at 50', () => {
  clearAllSubagents();
  createSubagent('sub-3', { subject: 'Audit test' });

  for (let i = 0; i < 60; i++) {
    addAuditLog('sub-3', {
      toolName: `tool_${i}`,
      toolUseId: `id_${i}`,
      input: `{"i":${i}}`,
      startTime: Date.now(),
      endTime: Date.now() + 10,
      durationMs: 10,
      success: true,
      resultSizeChars: 100,
    });
  }

  // getRecentAuditLogs returns last 20
  const recent = getRecentAuditLogs('sub-3');
  assert.equal(recent.length, 20, 'should return last 20');
  assert.equal(recent[0].toolName, 'tool_40', 'first should be the 41st');

  // The record internally has 50 but we only get 20
  const full = getSubagent('sub-3');
  assert.ok(full);
  assert.equal(full.auditLogs.length, 50, 'internal should retain 50');
});

// 用例 16：countRunning 只统计 running
test('subagent store countRunning filters correctly', () => {
  clearAllSubagents();
  createSubagent('r1', { subject: 'Running 1' });
  createSubagent('r2', { subject: 'Running 2' });
  createSubagent('d1', { subject: 'Done 1' });
  updateSubagentStatus('d1', 'completed');

  assert.equal(countRunning(), 2);

  updateSubagentStatus('r2', 'failed');
  assert.equal(countRunning(), 1);
});

// 用例 16b：updateCost + syncTasks + updateSubagentCost
test('subagent store updateCost and syncTasks work', () => {
  clearAllSubagents();
  createSubagent('sub-cost', { subject: 'Cost test' });

  updateCost('sub-cost', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, totalUSD: 0.0035 });
  const r = getSubagent('sub-cost');
  assert.ok(r);
  assert.equal(r.cost.totalUSD, 0.0035);

  // syncTasks
  const tasks = [
    { id: 't1', subject: 'Task 1', description: '', status: 'pending' },
    { id: 't2', subject: 'Task 2', description: '', status: 'completed' },
  ];
  syncTasks('sub-cost', tasks);
  assert.equal(r.tasks.length, 2);

  // updateSubagentCost（通过 UsageSummary 更新）
  updateSubagentCost('sub-cost', { inputTokens: 5000, outputTokens: 1000, cacheReadTokens: 0, totalUSD: 0.02 });
  const r2 = getSubagent('sub-cost');
  assert.ok(r2);
  assert.equal(r2.cost.inputTokens, 5000);
  assert.equal(r2.cost.outputTokens, 1000);
});

// 用例 17：1 小时清理定时器——可注入间隔
test('subagent store auto-cleanup after delay', async () => {
  clearAllSubagents();
  const origDelay = getCleanupDelayMs();
  try {
    setCleanupDelayMs(50); // 50ms for test

    createSubagent('sub-timer', { subject: 'Timer test' });
    updateSubagentStatus('sub-timer', 'completed', { result: 'expired' });

    assert.ok(getSubagent('sub-timer'), 'should exist before timeout');

    // Wait for cleanup
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(getSubagent('sub-timer'), undefined, 'should be cleaned up after delay');
  } finally {
    setCleanupDelayMs(origDelay);
  }
});

// 用例 18：集成——完整生命周期
test('integration: full subagent lifecycle', () => {
  clearAllSubagents();
  clearAllFileStates();
  clearAllShellTasks();

  const agentId = 'lifecycle-1';

  // 1. create
  const record = createSubagent(agentId, { subject: 'Integration test', description: 'Complete cycle' });
  assert.equal(record.status, 'running');

  // 2. sync tasks
  syncTasks(agentId, [
    { id: 't1', subject: 'Step 1', description: '', status: 'in_progress' },
    { id: 't2', subject: 'Step 2', description: '', status: 'pending' },
    { id: 't3', subject: 'Step 3', description: '', status: 'pending' },
  ]);

  // 3. add audit logs
  addAuditLog(agentId, {
    toolName: 'read_file',
    toolUseId: 'tool_1',
    input: '{"path":"/test.ts"}',
    startTime: Date.now() - 100,
    endTime: Date.now(),
    durationMs: 100,
    success: true,
    resultSizeChars: 200,
  });
  addAuditLog(agentId, {
    toolName: 'write_file',
    toolUseId: 'tool_2',
    input: '{"path":"/out.txt"}',
    startTime: Date.now() - 50,
    endTime: Date.now(),
    durationMs: 50,
    success: true,
    resultSizeChars: 50,
  });

  // 4. update cost
  updateCost(agentId, { inputTokens: 5000, outputTokens: 1200, cacheReadTokens: 500, totalUSD: 0.025 });

  // 5. getSubagentResult (reads without removing)
  const before = getSubagentResult(agentId);
  assert.ok(before);
  assert.equal(before.cost.totalUSD, 0.025);

  // 6. complete
  updateSubagentStatus(agentId, 'completed', { result: 'All tasks completed successfully' });

  // 7. collect result
  const collected = collectSubagentResult(agentId);
  assert.ok(collected);
  assert.equal(collected.status, 'completed');
  assert.equal(collected.result, 'All tasks completed successfully');
  assert.equal(collected.tasks.length, 3);
  assert.equal(collected.auditLogs.length, 2);
  assert.ok(collected.cost.totalUSD > 0);
  assert.ok(collected.completedAt > 0);
  assert.ok(collected.createdAt > 0);

  // 8. verify cleanup
  assert.equal(getSubagent(agentId), undefined);
});

// 用例 19：updateSubagentStatus with error field
test('subagent store updateSubagentStatus with error', () => {
  clearAllSubagents();
  createSubagent('sub-err', { subject: 'Error test' });
  const updated = updateSubagentStatus('sub-err', 'failed', { error: 'Something went wrong' });
  assert.ok(updated);
  assert.equal(updated.status, 'failed');
  assert.equal(updated.error, 'Something went wrong');
  assert.equal(updated.result, undefined);
});

// 用例 20：addAuditLog truncates long input and errorMessage
test('subagent store addAuditLog truncates long fields', () => {
  clearAllSubagents();
  createSubagent('sub-trunc', { subject: 'Truncation test' });

  const longInput = 'x'.repeat(2000);
  const longError = 'e'.repeat(1000);
  addAuditLog('sub-trunc', {
    toolName: 'test_tool',
    toolUseId: 'id_1',
    input: longInput,
    startTime: Date.now(),
    endTime: Date.now(),
    durationMs: 1,
    success: false,
    errorType: 'execution_error',
    errorMessage: longError,
    resultSizeChars: 0,
  });

  const logs = getRecentAuditLogs('sub-trunc');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].input.length, 1000, 'input should be truncated to 1000');
  assert.equal(logs[0].errorMessage.length, 500, 'errorMessage should be truncated to 500');
});
