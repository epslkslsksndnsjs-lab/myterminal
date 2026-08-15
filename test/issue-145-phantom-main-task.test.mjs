// ADR-0048 A48-W1 M1 (#145)：主任务幻影——createSubagent 注入 vs lazy 清空双路径统一
//
// 验收覆盖：
//   AC1  两路径 tasks 初始化语义统一，无幻影 pending（createSubagent 源点 / runner.start 生产路径 / task_create lazy 路径）
//   AC2  task_update allDone 不再恒 false（有活任务时可达 true，完成后列表自动清空）
//   AC3  STATE_SNAPSHOT 与 tasks 通道一致（无幻影；快照任务与 store.record.tasks 逐一对应）
//
// seam：createSubagent（store.ts）、task_create/task_update（tools.ts）、runSubagent onEvent（executor.ts）、
//       runner.start（runner.ts）
// 手法：bun:test + dist/ 导入；build 先行（#43 惯例）。fakeDeps/setupRunner 同 issue-133、
//       scriptedAdapter 同 issue-135。

import { test, describe, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { getTool } from '../dist/subagent/tools.js';
import { clearAllSubagents, createSubagent, getSubagent, listAllSubagents } from '../dist/subagent/store.js';
import { runSubagent } from '../dist/subagent/executor.js';
import { createSubagentRunner, setRunnerDepsForTesting, resetSubagentRunner } from '../dist/subagent/runner.js';

afterEach(() => {
  clearAllSubagents();
  resetSubagentRunner();
});

function makeCtx(agentId) {
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    agentId,
    readOnly: false,
  };
}

function fakeDeps(overrides = {}) {
  return {
    runSubagentImpl: overrides.runSubagentImpl ?? (async () => ({ status: 'completed', result: 'ok' })),
    settings: overrides.settings ?? { enabled: true, maxTurns: 10, timeoutSec: 60, maxParallel: 2 },
    workspaceDir: '/tmp/test-workspace',
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: (() => ({
      session: { id: 'ses_child_x', name: 'subagent-x', role: 'worker', phase: 'working', presence: 'claimed', task: {} },
      identity: { sessionId: 'ses_child_x', sessionToken: 'tok_x' },
    })),
  };
}

/** 创建 N 轮脚本化 fake adapter（m7 手法，同 issue-135） */
function scriptedAdapter(turns = []) {
  let turnIndex = 0;
  return {
    provider: 'test',
    callCount: 0,
    async *stream(params, signal) {
      this.callCount++;
      const turn = turns[turnIndex] ?? turns[turns.length - 1];
      turnIndex++;
      if (turn.text) yield { type: 'text_delta', text: turn.text };
      if (turn.toolCalls) {
        for (let i = 0; i < turn.toolCalls.length; i++) {
          const tc = turn.toolCalls[i];
          yield { type: 'tool_call_start', index: i, id: tc.id, name: tc.name };
          const json = JSON.stringify(tc.input);
          for (let j = 0; j < json.length; j += 5) {
            yield { type: 'tool_call_delta', index: i, jsonFragment: json.slice(j, j + 5) };
          }
          yield { type: 'tool_call_end', index: i, id: tc.id };
        }
      }
      yield { type: 'message_end', usage: turn.usage ?? { input_tokens: 10, output_tokens: 5 } };
    },
    async create(params, signal) {
      const turn = turns[Math.min(turnIndex, turns.length - 1)];
      return {
        message: { role: 'assistant', content: [{ type: 'text', text: turn?.text ?? '' }] },
        usage: turn?.usage ?? { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
}

describe('issue-145 主任务幻影（双路径统一）', () => {
  test('AC1a: createSubagent 源点不再注入主任务——record.tasks 初始为空', () => {
    const record = createSubagent('sa-145-a', { subject: 'Test task', description: 'Test description' });
    assert.equal(record.status, 'running');
    assert.equal(record.tasks.length, 0, '源点不应注入幻影主任务');
  });

  test('AC1b: runner.start 生产路径无幻影 pending', () => {
    const deps = fakeDeps();
    const runner = createSubagentRunner(deps);
    setRunnerDepsForTesting(deps);
    runner.start('parent-1', { objective: 'Edit file A' });

    const records = listAllSubagents();
    assert.equal(records.length, 1, '应恰好一个 subagent record');
    assert.equal(records[0].tasks.length, 0, '生产路径初始 tasks 应为空（无幻影 pending）');
  });

  test('AC1c: task_create lazy 路径仅承载真实任务（无幻影）', async () => {
    const agentId = 'sa-145-c';
    const created = await getTool('task_create').call(
      { subject: '真实任务', description: '改 parser' },
      makeCtx(agentId),
    );
    const record = getSubagent(agentId);
    assert.ok(record, 'lazy 兜底应建 record');
    assert.equal(record.tasks.length, 1, '仅含 task_create 的真实任务');
    assert.equal(record.tasks[0].id, created.task.id);
    assert.equal(record.tasks[0].status, 'pending');
  });

  test('AC2: 生产路径 task_update allDone 可达（不再恒 false），完成后自动清空', async () => {
    const deps = fakeDeps();
    const runner = createSubagentRunner(deps);
    setRunnerDepsForTesting(deps);
    runner.start('parent-2', { objective: 'Edit file B' });

    const recordId = listAllSubagents()[0].id;
    const created = await getTool('task_create').call(
      { subject: '任务一', description: '改 parser' },
      makeCtx(recordId),
    );
    const inProg = await getTool('task_update').call(
      { taskId: created.task.id, status: 'in_progress' },
      makeCtx(recordId),
    );
    assert.ok(!inProg.is_error, `不应报错：${inProg.message ?? ''}`);

    const r = await getTool('task_update').call(
      { taskId: created.task.id, status: 'completed' },
      makeCtx(recordId),
    );

    assert.ok(!r.is_error, `不应报错：${r.message ?? ''}`);
    assert.equal(r.allDone, true, '全部完成时 allDone 应可达 true');
    assert.equal(r.message, 'All tasks completed, list cleared');
    assert.equal(getSubagent(recordId).tasks.length, 0, 'allDone 后列表自动清空');
  });

  test('AC3: STATE_SNAPSHOT 与 tasks 通道一致（无幻影）', async () => {
    const events = [];
    const settings = { enabled: true, provider: 'test', model: 'test', maxTurns: 2, timeoutSec: 60, maxParallel: 2 };
    const adapter = scriptedAdapter([
      { toolCalls: [{ id: 'tc-1', name: 'task_create', input: { subject: '任务一', description: '改 parser' } }] },
      { text: 'done' },
    ]);

    await runSubagent({
      agentId: 'sa-145-d',
      task: 'Edit file C',
      cwd: '/tmp',
      settings,
      adapter,
      onEvent: (e) => events.push(e),
    });

    const snapshots = events.filter((e) => e.type === 'STATE_SNAPSHOT');
    assert.ok(snapshots.length > 0, '工具轮应发 STATE_SNAPSHOT');
    for (const snap of snapshots) {
      const tasks = snap.data.tasks;
      assert.equal(tasks.length, 1, '快照只含真实任务，无幻影');
      assert.equal(tasks[0].id, getSubagent('sa-145-d').tasks[0].id, '快照与 store.record.tasks 一致');
      assert.equal(tasks[0].subject, '任务一');
    }
  });

  test('AC3b: 无 task_create 的纯文本 run 不发 STATE_SNAPSHOT（tasks 为空即无幻影广播）', async () => {
    const events = [];
    const settings = { enabled: true, provider: 'test', model: 'test', maxTurns: 2, timeoutSec: 60, maxParallel: 2 };
    const adapter = scriptedAdapter([{ text: 'no tasks needed' }]);

    await runSubagent({
      agentId: 'sa-145-e',
      task: 'Edit file D',
      cwd: '/tmp',
      settings,
      adapter,
      onEvent: (e) => events.push(e),
    });

    assert.equal(
      events.filter((e) => e.type === 'STATE_SNAPSHOT').length,
      0,
      '无真实任务时不应发 STATE_SNAPSHOT',
    );
  });
});
