// Issue #90 — SubagentRunner catch 路径缺状态更新 + checkpoint
// CP1（先证后修）：runSubagentImpl 抛错时，catch 必须对齐 finalize 失败分支——
// updateSubagentStatus(subagentId,'failed',{error}) + checkpoint('cancelled',error)。
// 修复前 catch 仅 notify + delete，status 永久 running、checkpoint 永不调用 → RED。修复后 GREEN。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  createSubagentRunner,
  setRunnerDepsForTesting,
  resetSubagentRunner,
} from '../dist/subagent/runner.js';
import { getSubagent, clearAllSubagents } from '../dist/subagent/store.js';

function fakeDeps(overrides = {}) {
  const checkpoints = [];
  const notifies = [];
  return {
    runSubagentImpl: async () => ({ status: 'completed', result: 'ok' }),
    settings: { enabled: true, provider: 'qwen', model: 'qwen3.7-plus', maxTurns: 10, timeoutSec: 600, maxParallel: 5 },
    workspaceDir: '/tmp/issue-90',
    notify: async (sid, identity, parent, body) => { notifies.push({ sid, body }); },
    checkpoint: async (sid, identity, phase, summary) => { checkpoints.push({ sid, phase, summary }); },
    registerAndClaimChild: (parentId, args) => ({
      session: { id: 'ses_child_' + Math.random().toString(36).slice(2, 8), parentSessionId: parentId, name: args.name, task: args.task },
      identity: { sessionId: 'sid', sessionToken: 'tok' },
    }),
    __checkpoints: checkpoints,
    __notifies: notifies,
    ...overrides,
  };
}

async function waitForStatus(taskId, want, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = getSubagent(taskId);
    if (rec && rec.status === want) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

test('CP1: runSubagentImpl 抛错 → catch 必须置 status=failed 且 checkpoint 落盘（#90）', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const deps = fakeDeps({ runSubagentImpl: async () => { throw new Error('boom'); } });
  setRunnerDepsForTesting(deps);
  const runner = createSubagentRunner(deps);

  const result = runner.start('ses_parent_90', { objective: 'do it' }, undefined);
  const becameFailed = await waitForStatus(result.taskId, 'failed');

  const record = getSubagent(result.taskId);
  assert.ok(record, 'record 应存在');
  assert.equal(record.status, 'failed', 'catch 路径必须对齐 finalize 置 status=failed（#90 修复点）');
  assert.equal(becameFailed, true, 'status 应变为 failed');
  assert.ok(deps.__checkpoints.length >= 1, 'catch 路径必须调用 checkpoint（#90 修复点）');
  assert.equal(deps.__checkpoints[0].phase, 'cancelled', 'checkpoint phase 应为 cancelled');

  clearAllSubagents();
  resetSubagentRunner();
});

test('CP2: catch 失败通知文案含 taskId（向后兼容 notify 行为）', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const deps = fakeDeps({ runSubagentImpl: async () => { throw new Error('boom'); } });
  setRunnerDepsForTesting(deps);
  const runner = createSubagentRunner(deps);
  const result = runner.start('ses_parent_90b', { objective: 'do it' }, undefined);
  await waitForStatus(result.taskId, 'failed');
  assert.ok(deps.__notifies.length >= 1, '失败应触发 notify');
  assert.match(deps.__notifies[0].body, /taskId=sa_/, 'notify 文案应含 taskId');
  clearAllSubagents();
  resetSubagentRunner();
});
