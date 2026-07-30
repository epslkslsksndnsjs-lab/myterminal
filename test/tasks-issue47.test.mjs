// #47（批4 第 8 刀，坏行为项，G9）：任务状态双源（localTasks 镜像 + 手工 syncTasks）
// 决策块（issue #47 / ADR-0032 #47）：删 localTasks 镜像（tools.ts）与全部手工 syncTasks，store 单源。
// 父侧（subagent_status / executor live event）读 store.record.tasks；tools 以 localTasks 为主、best-effort 镜像同步。
//
// 本测试是 G9 红灯：构造【漏同步】场景（record 缺失时 task_create 成功写 localTasks 但跳过 syncTasks），
// 断言父侧（store）看到任务。当前代码：localTasks 成功、store 为空 → 父侧 stale → RED。
// 修复后：tools 直接读写 store.record.tasks（单源，record 缺失时 lazy createSubagent 兜底），
// 父侧始终与工具一致 → GREEN。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { getTool } from '../dist/subagent/tools.js';
import { getSubagent, clearAllSubagents } from '../dist/subagent/store.js';

function makeCtx(agentId) {
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    agentId,
    readOnly: false,
  };
}

test('#47 G9：task_create 在 record 缺失时父侧（store）仍可见（无漏同步 stale）', async () => {
  clearAllSubagents();
  const agentId = 'sa-47-create';
  const tool = getTool('task_create');
  const result = await tool.call({ subject: 'Build feature', description: 'implement X' }, makeCtx(agentId));
  assert.ok(result.task && result.task.id, 'task_create 应返回 task.id');

  // 红灯判定：父侧必须看到该任务（store 单源）。当前代码漏同步 → record 不存在 → RED。
  const record = getSubagent(agentId);
  assert.ok(record, '父侧（store）应存在该 subagent record（单源）');
  const found = record.tasks.find((t) => t.id === result.task.id);
  assert.ok(found, '父侧（store.tasks）应包含 task_create 创建的任务（无漏同步）');
  assert.equal(found.subject, 'Build feature');
});

test('#47 G9：task_update 状态变更对父侧（store）可见（单源）', async () => {
  clearAllSubagents();
  const agentId = 'sa-47-update';
  const createTool = getTool('task_create');
  const created = await createTool.call({ subject: 'Step', description: 'do' }, makeCtx(agentId));
  const taskId = created.task.id;

  const updateTool = getTool('task_update');
  const r = await updateTool.call({ taskId, status: 'in_progress' }, makeCtx(agentId));
  assert.ok(!r.is_error, 'task_update 不应报错');

  const record = getSubagent(agentId);
  assert.ok(record, '父侧（store）应存在 record');
  const found = record.tasks.find((t) => t.id === taskId);
  assert.ok(found, '父侧应能看到该任务');
  assert.equal(found.status, 'in_progress', '父侧应反映 task_update 的状态变更（单源，无镜像漂移）');
});

test('#47 G9：全部完成后父侧（store）视图同步清空（周边锁定 subagent_status tasks 视图）', async () => {
  clearAllSubagents();
  const agentId = 'sa-47-alldone';
  const createTool = getTool('task_create');
  const created = await createTool.call({ subject: 'Only task', description: 'done' }, makeCtx(agentId));
  const taskId = created.task.id;

  const updateTool = getTool('task_update');
  const r1 = await updateTool.call({ taskId, status: 'in_progress' }, makeCtx(agentId));
  assert.ok(!r1.is_error, 'task_update(in_progress) 不应报错');
  const r = await updateTool.call({ taskId, status: 'completed' }, makeCtx(agentId));
  assert.ok(!r.is_error, 'task_update(completed) 不应报错');
  assert.equal(r.allDone, true, '单一任务完成后应 allDone');

  // 周边锁定：父侧（subagent_status 读取的 record.tasks）应与工具一致清空
  const record = getSubagent(agentId);
  assert.ok(record, 'record 应存在');
  assert.equal(record.tasks.length, 0, '父侧视图应随 allDone 同步清空（无双真相漂移）');
});
