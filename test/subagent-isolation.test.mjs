// ADR-0032 批5 第2刀 #34：双实例隔离 seam 锁定测试
// 验证 createSubagentContext() 创建的两个 context 互不干扰
// 重构后这些测试必须不改一行仍然全绿（G4 锁定测试）

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// ── Import 构建产物 ──
import { createSubagentContext, defaultContext } from '../dist/subagent/context.js';
import {
  createSubagent,
  getSubagent,
  countRunning,
  updateSubagentStatus,
  clearAllSubagents,
} from '../dist/subagent/store.js';
import {
  recordFileRead,
  validateEdit,
  clearAllFileStates,
} from '../dist/subagent/file-state.js';
import {
  trackShellTask,
  getTrackedCount,
  clearAllShellTasks,
} from '../dist/subagent/shell-tracker.js';
import {
  enforceMessageBudget,
  resetReplacementDecisions,
} from '../dist/subagent/result-budget.js';
import { emitAgUi } from '../dist/subagent/tui-bridge.js';

// ════════════════════════════════════════════════════════════════
// 1. store.ts — subagents Map 隔离
// ════════════════════════════════════════════════════════════════

test('isolation: store — ctxA createSubagent 不出现在 ctxB', () => {
  const ctxA = createSubagentContext();
  const ctxB = createSubagentContext();

  createSubagent('agent-a1', { subject: 'task A' }, ctxA);

  // ctxA 能查到
  assert.ok(getSubagent('agent-a1', ctxA), 'ctxA should find agent-a1');
  // ctxB 查不到
  assert.equal(getSubagent('agent-a1', ctxB), undefined, 'ctxB should NOT find agent-a1');
});

test('isolation: store — ctxA countRunning 不影响 ctxB', () => {
  const ctxA = createSubagentContext();
  const ctxB = createSubagentContext();

  createSubagent('agent-a2', { subject: 'running A' }, ctxA);
  createSubagent('agent-a3', { subject: 'running A2' }, ctxA);

  assert.equal(countRunning(ctxA), 2, 'ctxA should have 2 running');
  assert.equal(countRunning(ctxB), 0, 'ctxB should have 0 running');
});

test('isolation: store — ctxB 独立创建不干扰 ctxA', () => {
  const ctxA = createSubagentContext();
  const ctxB = createSubagentContext();

  createSubagent('agent-b1', { subject: 'task B' }, ctxB);

  assert.equal(getSubagent('agent-b1', ctxA), undefined, 'ctxA should NOT find agent-b1');
  assert.ok(getSubagent('agent-b1', ctxB), 'ctxB should find agent-b1');
});

// ════════════════════════════════════════════════════════════════
// 2. file-state.ts — readFileStates Map 隔离
// ════════════════════════════════════════════════════════════════

test('isolation: file-state — ctxA recordFileRead 不影响 ctxB validateEdit', () => {
  const ctxA = createSubagentContext();
  const ctxB = createSubagentContext();

  recordFileRead('agent-f1', '/tmp/test.txt', 'hello world', ctxA);

  // ctxA 能校验通过
  const resultA = validateEdit('agent-f1', '/tmp/test.txt', 'hello', false, ctxA);
  assert.equal(resultA.ok, true, 'ctxA validateEdit should pass');

  // ctxB 报"未读"
  const resultB = validateEdit('agent-f1', '/tmp/test.txt', 'hello', false, ctxB);
  assert.equal(resultB.ok, false, 'ctxB validateEdit should fail');
  assert.ok(resultB.message.includes('not been read'), 'ctxB should report file not read');
});

test('isolation: file-state — ctxB 独立 read 不干扰 ctxA', () => {
  const ctxA = createSubagentContext();
  const ctxB = createSubagentContext();

  recordFileRead('agent-f2', '/tmp/b.txt', 'content B', ctxB);

  const resultA = validateEdit('agent-f2', '/tmp/b.txt', 'content', false, ctxA);
  assert.equal(resultA.ok, false, 'ctxA should NOT see ctxB file state');

  const resultB = validateEdit('agent-f2', '/tmp/b.txt', 'content', false, ctxB);
  assert.equal(resultB.ok, true, 'ctxB should see its own file state');
});

// ════════════════════════════════════════════════════════════════
// 3. shell-tracker.ts — agentShellTasks Map 隔离
// ════════════════════════════════════════════════════════════════

test('isolation: shell-tracker — ctxA trackShellTask 不影响 ctxB getTrackedCount', () => {
  const ctxA = createSubagentContext();
  const ctxB = createSubagentContext();

  // 用 EventEmitter 模拟 ChildProcess（只需 .on 和 .kill 接口）
  const fakeChild = new EventEmitter();
  fakeChild.pid = 99999;
  fakeChild.killed = false;
  fakeChild.exitCode = null;
  fakeChild.kill = () => {};

  trackShellTask('agent-s1', fakeChild, ctxA);

  assert.equal(getTrackedCount('agent-s1', ctxA), 1, 'ctxA should track 1');
  assert.equal(getTrackedCount('agent-s1', ctxB), 0, 'ctxB should track 0');
});

// ════════════════════════════════════════════════════════════════
// 4. result-budget.ts — replacementDecisions 按 agentId 分桶隔离（#77）
// ════════════════════════════════════════════════════════════════

test('isolation: result-budget — agentA 冻结决策不影响 agentB（#77 分桶）', () => {
  const agentA = 'iso-agent-A';
  const agentB = 'iso-agent-B';

  // 构造超预算结果（>200K），触发冻结
  const bigContent = 'x'.repeat(250_000);
  const resultsA = [{ tool_use_id: 'tool-1', content: bigContent, is_error: false }];

  enforceMessageBudget(resultsA, agentA);

  // agentA 自己的冻结决策仍生效：小内容 round2 仍被压
  const smallContent = 'y'.repeat(100);
  const resultsA2 = [{ tool_use_id: 'tool-1', content: smallContent, is_error: false }];
  enforceMessageBudget(resultsA2, agentA);
  assert.ok(resultsA2[0].content.includes('budget-compressed'), 'agentA 自己的冻结决策应仍生效');

  // agentB 处理同 id 的小结果——agentA 的冻结不得泄漏到 agentB，故不被压缩
  const resultsB = [{ tool_use_id: 'tool-1', content: smallContent, is_error: false }];
  enforceMessageBudget(resultsB, agentB);

  assert.equal(resultsB[0].content, smallContent, 'agentB should NOT compress tool-1 (no leak from agentA)');
});

// ════════════════════════════════════════════════════════════════
// 5. tui-bridge.ts — EventEmitter 隔离
// ════════════════════════════════════════════════════════════════

test('isolation: tui-bridge — ctxA emitAgUi 不被 ctxB 监听器收到', () => {
  const ctxA = createSubagentContext();
  const ctxB = createSubagentContext();

  const receivedB = [];
  ctxB.events.on('ag-ui', (event) => receivedB.push(event));

  emitAgUi('agent-e1', 'RUN_STARTED', { foo: 'bar' }, ctxA);

  assert.equal(receivedB.length, 0, 'ctxB listener should NOT receive ctxA events');
});

test('isolation: tui-bridge — ctxA 监听器收到 ctxA 事件', () => {
  const ctxA = createSubagentContext();

  const receivedA = [];
  ctxA.events.on('ag-ui', (event) => receivedA.push(event));

  emitAgUi('agent-e2', 'RUN_FINISHED', { result: 'done' }, ctxA);

  assert.equal(receivedA.length, 1, 'ctxA listener should receive ctxA events');
  assert.equal(receivedA[0].subagentId, 'agent-e2');
  assert.equal(receivedA[0].type, 'RUN_FINISHED');
});

// ════════════════════════════════════════════════════════════════
// 6. 向后兼容：不传 ctx 走 defaultContext
// ════════════════════════════════════════════════════════════════

test('backward-compat: 不传 ctx 走 defaultContext（生产路径不变）', () => {
  // 清理 defaultContext
  clearAllSubagents();
  clearAllFileStates();
  clearAllShellTasks();
  resetReplacementDecisions();

  // 不传 ctx 创建
  createSubagent('compat-1', { subject: 'compat test' });
  assert.ok(getSubagent('compat-1'), 'default context should find compat-1');
  assert.equal(countRunning(), 1, 'default context countRunning should be 1');

  // 隔离 ctx 查不到
  const iso = createSubagentContext();
  assert.equal(getSubagent('compat-1', iso), undefined, 'isolated ctx should NOT find default subagent');

  // 清理
  clearAllSubagents();
  assert.equal(getSubagent('compat-1'), undefined, 'clearAll should work on defaultContext');
});

// ── #34 第 7 项收敛：runner 单例按 context 隔离（#70 门禁补收） ──
test('ISO-RUNNER: SubagentRunner 单例随 context 隔离，reset 互不影响', async () => {
  const { initSubagentRunner, getSubagentRunner, resetSubagentRunner } = await import('../dist/subagent/runner.js');
  const fakeDeps = () => ({
    runSubagentImpl: async () => ({}),
    settings: {},
    workspaceDir: '/tmp',
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: () => ({ session: {}, identity: { sessionId: 's', sessionToken: 't' } }),
  });
  const ctxA = createSubagentContext();
  const ctxB = createSubagentContext();

  initSubagentRunner(fakeDeps(), ctxA);
  assert.throws(() => getSubagentRunner(ctxB), /not initialized/i, 'B 未初始化必须抛（不得看见 A 的 runner）');

  initSubagentRunner(fakeDeps(), ctxB);
  assert.notEqual(getSubagentRunner(ctxA), getSubagentRunner(ctxB), '两 context 的 runner 必须是不同实例');

  resetSubagentRunner(ctxA);
  assert.throws(() => getSubagentRunner(ctxA), /not initialized/i, 'A reset 后必须抛');
  assert.ok(getSubagentRunner(ctxB), 'A reset 不得影响 B');
});
