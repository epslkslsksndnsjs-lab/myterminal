// ADR-0010 runner 修订测试——origin 参数 + status idempotent + notify 带 taskId+origin
// 覆盖决策：13（status idempotent）、14（notify 带 taskId+origin，含 catch 块）
// 目标：runner.ts 改动函数（start/status/finalize）行覆盖率 ≥ 90%；变异体 4/4 被杀死
//
// 变异体清单：
//   M1 status() 仍调 collectSubagentResult（旧行为复活） → 用例 01 杀
//   M2 finalize 的 notify 忘带 taskId                    → 用例 02/03 杀
//   M3 origin 判断反转（skill 消息发给直接启动）         → 用例 03 杀
//   M4 failed 分支忘带 origin 前缀                       → 用例 04 杀

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { createSubagentRunner, setRunnerDepsForTesting, resetSubagentRunner } from '../dist/subagent/runner.js';
import { clearAllSubagents, getSubagent } from '../dist/subagent/store.js';

// ── 测试辅助（与 test/subagent-m8.test.mjs 同款模式）──

function defaultSubagentSettings(overrides = {}) {
  return {
    enabled: true,
    provider: 'openai',
    model: 'gpt-4o',
    maxTurns: 50,
    timeoutSec: 300,
    maxParallel: 2,
    ...overrides,
  };
}

function mockSession(id, overrides = {}) {
  return {
    id,
    name: 'subagent-test',
    role: 'worker',
    phase: 'working',
    presence: 'claimed',
    parentSessionId: overrides.parentSessionId,
    task: overrides.task,
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeDeps(overrides = {}) {
  const callLog = [];
  const deps = {
    runSubagentImpl: overrides.runSubagentImpl ?? (async () => {
      callLog.push('runSubagentImpl');
      return { status: 'completed', result: 'Test completed successfully.' };
    }),
    settings: overrides.settings ?? defaultSubagentSettings(),
    workspaceDir: overrides.workspaceDir ?? '/tmp/test-workspace',
    notify: overrides.notify ?? (async (childId, childIdentity, parentId, body) => {
      callLog.push({ notify: { childId, parentId, body } });
    }),
    checkpoint: overrides.checkpoint ?? (async (childId, childIdentity, phase, summary) => {
      callLog.push({ checkpoint: { childId, phase, summary } });
    }),
    registerAndClaimChild: overrides.registerAndClaimChild ?? ((parentId, args) => {
      const sid = 'ses_child_' + randomBytes(3).toString('hex');
      callLog.push({ registerAndClaimChild: { parentId, args } });
      return {
        session: mockSession(sid, { parentSessionId: parentId, name: args.name, task: args.task }),
        identity: { sessionId: sid, sessionToken: 'tok_' + randomBytes(8).toString('hex') },
      };
    }),
  };
  return { deps, callLog };
}

function setupRunner(overrides = {}) {
  const { deps, callLog } = fakeDeps(overrides);
  const runner = createSubagentRunner(deps);
  setRunnerDepsForTesting(deps);
  return { runner, callLog };
}

function lastNotify(callLog) {
  const entries = callLog.filter((e) => e && e.notify);
  return entries.length ? entries[entries.length - 1].notify : null;
}

// ══════════════════════════════════════════════════════
// 用例 01：决策 13——status idempotent（杀 M1）
// ══════════════════════════════════════════════════════

test('01: completed 后 status 可多次查，result 不丢（杀 M1）', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner } = setupRunner();

  const started = runner.start('ses_parent_t2', { objective: 'Idempotent check' });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const first = runner.status(started.taskId);
  assert.equal(first.status, 'completed');
  assert.equal(first.result, 'Test completed successfully.');

  // 第二次、第三次仍返回 result——旧行为（取走即删）会在这里抛 NOT_FOUND
  const second = runner.status(started.taskId);
  assert.equal(second.status, 'completed');
  assert.equal(second.result, 'Test completed successfully.');
  const third = runner.status(started.taskId);
  assert.equal(third.result, 'Test completed successfully.');

  // 记录仍在 store（清理只靠 1 小时定时器，不归 status 管）
  assert.ok(getSubagent(started.taskId));
});

// ══════════════════════════════════════════════════════
// 用例 02-04：决策 14——notify 带 taskId + origin
// ══════════════════════════════════════════════════════

test('02: skill fork 完成——notify 带 skill 前缀 + taskId（杀 M2）', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner, callLog } = setupRunner();

  const started = runner.start('ses_parent_t2', { objective: 'Fork task' }, { type: 'skill', skillName: 'refactor-module' });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const notify = lastNotify(callLog);
  assert.ok(notify, 'notify must be called');
  assert.match(notify.body, new RegExp(`^skill 'refactor-module' fork completed \\(taskId=${started.taskId}\\): `));
  assert.match(notify.body, /Test completed successfully/);
});

test('03: 直接启动（无 origin）——notify 不带 skill 前缀但带 taskId（杀 M2/M3）', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner, callLog } = setupRunner();

  const started = runner.start('ses_parent_t2', { objective: 'Direct task' });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const notify = lastNotify(callLog);
  assert.ok(notify);
  assert.match(notify.body, new RegExp(`^subagent completed \\(taskId=${started.taskId}\\): `));
  assert.doesNotMatch(notify.body, /skill '/);
});

test('04: skill fork 失败——notify 带 skill 前缀 + failed + taskId（杀 M4）', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner, callLog } = setupRunner({
    runSubagentImpl: async () => ({ status: 'failed', error: 'provider quota exhausted' }),
  });

  const started = runner.start('ses_parent_t2', { objective: 'Failing fork' }, { type: 'skill', skillName: 'audit-code' });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const notify = lastNotify(callLog);
  assert.ok(notify);
  assert.match(notify.body, new RegExp(`^skill 'audit-code' fork failed \\(taskId=${started.taskId}\\): `));
  assert.match(notify.body, /quota exhausted/);
});

// ══════════════════════════════════════════════════════
// 用例 05：catch 块（runSubagentImpl reject）notify 也带 taskId + origin
// ══════════════════════════════════════════════════════

test('05: runSubagentImpl reject——catch 块 notify 带 taskId + skill 前缀', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner, callLog } = setupRunner({
    runSubagentImpl: async () => { throw new Error('network unreachable'); },
  });

  const started = runner.start('ses_parent_t2', { objective: 'Rejecting task' }, { type: 'skill', skillName: 'net-skill' });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const notify = lastNotify(callLog);
  assert.ok(notify, 'catch path must notify');
  assert.match(notify.body, new RegExp(`^skill 'net-skill' fork failed \\(taskId=${started.taskId}\\): `));
  assert.match(notify.body, /network unreachable/);
});

// ══════════════════════════════════════════════════════
// 用例 06：回归——NOT_FOUND 语义不变（不存在的 taskId 仍抛错）
// ══════════════════════════════════════════════════════

test('06: 不存在的 taskId 仍抛 NOT_FOUND（回归）', () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner } = setupRunner();
  assert.throws(() => runner.status('sa_nonexist'), /Subagent not found/);
});
