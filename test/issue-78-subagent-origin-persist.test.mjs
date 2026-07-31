// Issue #78（ADR-0042 选项 A）— SubagentOrigin 未落 SubagentRecord
//
// CP1（先证后修）：runner.start 传入 origin，createSubagent 必须把它写入 record，
// 且 runner.status 必须回传 origin。修复前 origin 仅用于 notify 文案、从不进 record
// → record.origin / status.origin 为 undefined（RED）。修复后逐字节一致 → GREEN。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  createSubagentRunner,
  setRunnerDepsForTesting,
  resetSubagentRunner,
} from '../dist/subagent/runner.js';
import { getSubagent, clearAllSubagents } from '../dist/subagent/store.js';

function fakeDeps() {
  return {
    runSubagentImpl: async () => ({ status: 'completed', result: 'ok' }),
    settings: { enabled: true, provider: 'qwen', model: 'qwen3.7-plus', maxTurns: 10, timeoutSec: 600, maxParallel: 5 },
    workspaceDir: '/tmp/issue-78',
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: (parentId, args) => ({
      session: { id: 'ses_child_' + Math.random().toString(36).slice(2, 8), parentSessionId: parentId, name: args.name, task: args.task },
      identity: { sessionId: 'sid', sessionToken: 'tok' },
    }),
  };
}

test('CP1: runner.start 透传 origin，createSubagent + status 读回一致（#78 选项 A）', () => {
  clearAllSubagents();
  resetSubagentRunner();
  const deps = fakeDeps();
  setRunnerDepsForTesting(deps);
  const runner = createSubagentRunner(deps);

  const origin = { type: 'skill', skillName: 'adaptive-guard' };
  const result = runner.start('ses_parent_78', { objective: 'do it' }, origin);

  // ① record 必须含 origin
  const record = getSubagent(result.taskId);
  assert.ok(record, 'record 应存在');
  assert.deepEqual(record.origin, origin, 'createSubagent 应写入 origin（#78 修复点）');

  // ② status 输出必须透出 origin
  const status = runner.status(result.taskId);
  assert.deepEqual(status.origin, origin, 'runner.status 应透出 origin');

  clearAllSubagents();
  resetSubagentRunner();
});

test('CP1: 无 origin（direct start）时 record.origin 为 undefined（向后兼容）', () => {
  clearAllSubagents();
  resetSubagentRunner();
  const deps = fakeDeps();
  setRunnerDepsForTesting(deps);
  const runner = createSubagentRunner(deps);

  const result = runner.start('ses_parent_78b', { objective: 'direct start' });
  const record = getSubagent(result.taskId);
  assert.equal(record.origin, undefined, 'direct start 时 origin 应为 undefined');

  clearAllSubagents();
  resetSubagentRunner();
});
