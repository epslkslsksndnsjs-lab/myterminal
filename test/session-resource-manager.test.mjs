// 批5 #38（ADR-0032）— SessionResourceManager 锁定测试：泄漏回归 + seam 快照
//
// G4 约束：本测试锁定"现状清理集/顺序/行为"，重构后必须保持绿、快照 diff 为零。
// 覆盖：
//   A. 注册快照——生产单例的 agent 资源名/顺序固定（现状 finally 的 ①②③）
//   B. 泄漏回归——disposeAgent 真正清掉三类 agent 资源（shell / file-state / replacement）
//   C. dispatch 契约——各作用域 disposer 按注册顺序各调用一次，入参透传

import assert from 'node:assert';
import { sessionResourceManager, SessionResourceManager } from '../dist/session-resource-manager.js';
import { defaultContext } from '../dist/subagent/context.js';
import { recordFileRead, clearAllFileStates } from '../dist/subagent/file-state.js';
import { resetReplacementDecisions } from '../dist/subagent/result-budget.js';
import { trackShellTask, getTrackedCount, clearAllShellTasks } from '../dist/subagent/shell-tracker.js';

function resetContext() {
  clearAllFileStates();
  clearAllShellTasks();
  resetReplacementDecisions();
}

// ── A. 注册快照（seam 锁定）──
test('agent resource registration snapshot matches current finally set/order', () => {
  assert.deepStrictEqual(sessionResourceManager.agentResourceNames(), [
    'agent-shell-tasks',
    'file-state',
    'replacement-decisions',
  ]);
});

// ── B. 泄漏回归 ──
test('disposeAgent clears file state (no leak)', () => {
  resetContext();
  recordFileRead('leak-A', '/tmp/leak-file.txt', 'hello');
  assert.strictEqual(defaultContext.readFileStates.get('leak-A')?.size, 1);
  sessionResourceManager.disposeAgent('leak-A');
  assert.strictEqual(defaultContext.readFileStates.has('leak-A'), false);
});

test('disposeAgent resets replacement decisions (no leak)', () => {
  resetContext();
  // 模拟跨 turn 冻结决策
  defaultContext.replacementDecisions.set('leak-t1', 'preview');
  assert.strictEqual(defaultContext.replacementDecisions.get('leak-t1'), 'preview');
  sessionResourceManager.disposeAgent('leak-A');
  assert.strictEqual(defaultContext.replacementDecisions.has('leak-t1'), false);
});

test('disposeAgent kills tracked shell tasks (no leak)', () => {
  resetContext();
  // 假 child：pid 不存在，kill 抛错被 cleanupAgentShellTasks 吞没；Set 删除在同步路径
  const fake = { pid: 99_999, killed: false, exitCode: null, on() {}, kill() {} };
  trackShellTask('leak-A', fake);
  assert.strictEqual(getTrackedCount('leak-A'), 1);
  sessionResourceManager.disposeAgent('leak-A');
  assert.strictEqual(getTrackedCount('leak-A'), 0);
});

// ── C. dispatch 契约 ──
test('disposeAgent invokes each agent disposer once in registration order', () => {
  const m = new SessionResourceManager();
  const calls = [];
  m.registerAgentResource('a', (id) => calls.push(['a', id]));
  m.registerAgentResource('b', (id) => calls.push(['b', id]));
  m.registerAgentResource('c', (id) => calls.push(['c', id]));
  m.disposeAgent('agent-X');
  assert.deepStrictEqual(calls, [['a', 'agent-X'], ['b', 'agent-X'], ['c', 'agent-X']]);
});

test('disposeSession invokes registered session disposer with config + id', () => {
  const m = new SessionResourceManager();
  const calls = [];
  m.registerSessionResource('s', (c, id) => calls.push([c, id]));
  const cfg = { marker: 'cfg' };
  m.disposeSession(cfg, 'sid-1');
  assert.deepStrictEqual(calls, [[cfg, 'sid-1']]);
});

test('reap/disarmAll invoke the named global disposer only', () => {
  const m = new SessionResourceManager();
  const log = [];
  m.registerGlobalResource('reap', (c) => log.push(['reap', c]));
  m.registerGlobalResource('disarm-all', (c) => log.push(['disarm-all', c]));
  const cfg = { marker: 'cfg' };
  m.reap(cfg);
  m.disarmAll(cfg);
  assert.deepStrictEqual(log, [['reap', cfg], ['disarm-all', cfg]]);
});
