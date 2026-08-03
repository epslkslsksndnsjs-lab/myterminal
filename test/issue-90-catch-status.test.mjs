// Issue #90 — SubagentRunner catch 路径缺状态更新 + checkpoint
// 工作流：先证后修。本文件覆盖 4 个回归点（对应之前改坏引入的 4 个缺陷）：
//   A) IMPORTANT-3：childIdentity 缺失时也必须置 failed（杀僵尸）—— 缺陷版只 notify，status 永久 running
//   B) CRITICAL-2：success 路径 finalize 内 checkpoint 失败不得把 completed 误覆盖为 failed
//   C) CRITICAL-1：failure 路径 checkpoint/notify 失败必须静默，不得触发 unhandledRejection（→ cli.ts process.exit(1)）
//   D) 基线：childIdentity 存在时，status=failed + checkpoint('cancelled') + notify 文案含 taskId（#90 原始修复点）

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

test('A) IMPORTANT-3: childIdentity 缺失时 catch 仍须置 status=failed（杀僵尸）(#90)', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const deps = fakeDeps({
    runSubagentImpl: async () => { throw new Error('boom'); },
    // 不返回 identity → childIdentities 存的是 undefined → storedIdentity 为假
    registerAndClaimChild: (parentId, args) => ({
      session: { id: 'ses_child_x', parentSessionId: parentId, name: args.name, task: args.task },
      identity: undefined,
    }),
  });
  setRunnerDepsForTesting(deps);
  const runner = createSubagentRunner(deps);

  const result = runner.start('ses_parent_90a', { objective: 'do it' }, undefined);
  const becameFailed = await waitForStatus(result.taskId, 'failed');

  const record = getSubagent(result.taskId);
  assert.ok(record, 'record 应存在');
  assert.equal(record.status, 'failed', '即使无 childIdentity，catch 也必须置 status=failed（杀僵尸）');
  assert.equal(becameFailed, true);

  clearAllSubagents();
  resetSubagentRunner();
});

test('B) CRITICAL-2: success 路径 finalize 内 checkpoint 失败不得把 completed 误覆盖为 failed (#90)', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const deps = fakeDeps({
    runSubagentImpl: async () => ({ status: 'completed', result: 'all good' }),
    // finalize 的 checkpoint 失败——缺陷版的 .then(finalize).catch() 会捕获并误置 failed
    checkpoint: async () => { throw new Error('checkpoint down'); },
  });
  setRunnerDepsForTesting(deps);
  const runner = createSubagentRunner(deps);

  const result = runner.start('ses_parent_90b', { objective: 'do it' }, undefined);
  const stayedCompleted = await waitForStatus(result.taskId, 'completed');

  const record = getSubagent(result.taskId);
  assert.ok(record, 'record 应存在');
  assert.equal(record.status, 'completed', 'finalize 内 checkpoint 失败不得把 completed 误覆盖为 failed');
  assert.equal(stayedCompleted, true);

  clearAllSubagents();
  resetSubagentRunner();
});

test('C) CRITICAL-1: failure 路径 checkpoint 失败必须静默，不得触发 unhandledRejection (#90)', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  let unhandled = null;
  const onReject = (reason) => { unhandled = reason; };
  process.on('unhandledRejection', onReject);

  const deps = fakeDeps({
    runSubagentImpl: async () => { throw new Error('boom'); },
    checkpoint: async () => { throw new Error('checkpoint down'); },
  });
  setRunnerDepsForTesting(deps);
  const runner = createSubagentRunner(deps);

  const result = runner.start('ses_parent_90c', { objective: 'do it' }, undefined);
  await waitForStatus(result.taskId, 'failed');

  // 等一拍，让后台 promise 真正 settle
  await new Promise((r) => setTimeout(r, 50));
  process.off('unhandledRejection', onReject);

  const record = getSubagent(result.taskId);
  assert.equal(record?.status, 'failed', 'status 仍为 failed');
  assert.equal(unhandled, null, 'checkpoint 失败必须被 .catch 静默，不得产生 unhandledRejection（否则 cli.ts 会 process.exit(1)）');

  clearAllSubagents();
  resetSubagentRunner();
});

test('D) 基线: childIdentity 存在时 status=failed + checkpoint(cancelled) + notify 含 taskId (#90 原始修复点)', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const deps = fakeDeps({ runSubagentImpl: async () => { throw new Error('boom'); } });
  setRunnerDepsForTesting(deps);
  const runner = createSubagentRunner(deps);

  const result = runner.start('ses_parent_90d', { objective: 'do it' }, undefined);
  const becameFailed = await waitForStatus(result.taskId, 'failed');

  const record = getSubagent(result.taskId);
  assert.ok(record, 'record 应存在');
  assert.equal(record.status, 'failed', 'catch 路径必须置 status=failed');
  assert.equal(becameFailed, true);
  assert.ok(deps.__checkpoints.length >= 1, 'catch 路径必须调用 checkpoint');
  assert.equal(deps.__checkpoints[0].phase, 'cancelled', 'checkpoint phase 应为 cancelled');
  assert.ok(deps.__notifies.length >= 1, '失败应触发 notify');
  assert.match(deps.__notifies[0].body, /taskId=sa_/, 'notify 文案应含 taskId');

  clearAllSubagents();
  resetSubagentRunner();
});
