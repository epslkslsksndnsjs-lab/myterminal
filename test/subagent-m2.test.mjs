import { test } from 'bun:test';
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
  addAuditLog,
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

// 用例 1（getTotalCost 定价计算）已随 ADR-0046 D1 移除——CostTracker 降级为纯 token 累加器，不再核算成本。

// 用例 2：多次 addUsage + cacheRead 累积正确（纯 token 累加，不再核算成本）
test('CostTracker multiple addUsage with cacheRead', () => {
  const tracker = new CostTracker();
  tracker.addUsage({ input_tokens: 800_000, output_tokens: 300_000, cache_read_input_tokens: 200_000 });
  tracker.addUsage({ input_tokens: 200_000, output_tokens: 100_000 });

  const usage = tracker.getUsage();
  assert.equal(usage.inputTokens, 1_000_000);
  assert.equal(usage.outputTokens, 400_000);
  assert.equal(usage.cacheReadTokens, 200_000);
});

// 用例 3/4（前缀匹配 / 未知模型回退定价）已随 ADR-0046 D1 移除——resolvePricing 已删


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
  assert.equal(record.usage.inputTokens, 0);

  // get
  const fetched = getSubagent('sub-1');
  assert.ok(fetched);
  assert.equal(fetched.status, 'running');

  // update to completed
  const updated = updateSubagentStatus('sub-1', 'completed', { result: 'All done!' });
  assert.ok(updated);
  assert.equal(updated.status, 'completed');
  assert.equal(updated.result, 'All done!');
});

// 用例 14（collectSubagentResult 返回并删除）已随 ADR-0048 #144 F3 移除——collect 即删语义已废（幂等保留，清理只靠 1 小时定时器）。

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

// 用例 16b：updateSubagentCost（updateUsage 已随 ADR-0048 #144 F1 移除）
test('subagent store updateSubagentCost works', () => {
  clearAllSubagents();
  createSubagent('sub-cost', { subject: 'Cost test' });

  // updateSubagentCost（通过 UsageSummary 更新）
  updateSubagentCost('sub-cost', { inputTokens: 5000, outputTokens: 1000, cacheReadTokens: 0 });
  const r2 = getSubagent('sub-cost');
  assert.ok(r2);
  assert.equal(r2.usage.inputTokens, 5000);
  assert.equal(r2.usage.outputTokens, 1000);
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

  // 2. add audit logs
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
  updateSubagentCost(agentId, { inputTokens: 5000, outputTokens: 1200, cacheReadTokens: 500 });

  // 5. getSubagent (reads without removing)
  const before = getSubagent(agentId);
  assert.ok(before);
  assert.equal(before.usage.inputTokens, 5000);

  // 6. complete
  updateSubagentStatus(agentId, 'completed', { result: 'All tasks completed successfully' });

  // 7. read result（幂等保留，不删记录——清理只靠 1 小时定时器，见用例 17）
  const completed = getSubagent(agentId);
  assert.ok(completed);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result, 'All tasks completed successfully');
  assert.ok(completed.tasks.length >= 1, 'record 应至少含主目标任务（store 单源，任务经 tools 写入）');
  assert.equal(completed.auditLogs.length, 2);
  assert.ok(completed.usage.inputTokens > 0);
  assert.equal(getSubagent(agentId), completed, '记录保留，可重复读取');
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
