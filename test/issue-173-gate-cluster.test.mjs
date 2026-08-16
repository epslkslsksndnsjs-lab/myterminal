import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { join } from 'node:path';
import { MyTerminalStore } from '../dist/store.js';
import { createSubagent, clearAllSubagents, setCleanupDelayMs, getSubagentBySessionId, markResultFetched, updateSubagentStatus } from '../dist/subagent/store.js';

function tempDir() {
  return fs.mkdtempSync(join(os.tmpdir(), 'mg-173-'));
}

function makeTask(objective) {
  return { objective, background: 'slice background', deliverables: ['slice done'], acceptanceCriteria: ['verified'], constraints: ['local only'] };
}

// #173：D5 闸门簇三修（先组装后置位 / details 契约字段 / 定时器重挂有界）

test('173-F2: 闸门 details 含 unreadMessages/pendingEvents/unreviewedCount', () => {
  const dir = tempDir();
  const store = new MyTerminalStore(join(dir, 'state'));
  const root = store.registerRoot({ name: 'root', role: 'lead' });
  const childInfo = store.registerDelegate(root.session.id, { name: 'worker', task: makeTask('delegated slice') });
  const childId = childInfo.session.id;

  store.checkpoint(childId, { phase: 'completed', summary: 'child done.' });
  const childEvents = store.snapshot().events.filter((e) => e.recipientSessionId === root.session.id && e.sourceSessionId === childId);
  if (childEvents.length) store.acknowledgeEvents(root.session.id, childEvents.map((e) => e.id));

  clearAllSubagents();
  const rec = createSubagent('task-gate-173', { subject: 'delegated work' });
  rec.status = 'completed';
  rec.result = 'child result payload';
  rec.completedAt = Date.now();
  rec.sessionId = childId;

  assert.throws(
    () => store.checkpoint(root.session.id, { phase: 'completed', summary: 'wrap up' }),
    (err) => {
      assert.equal(err.code, 'CHILD_RESULT_UNREVIEWED');
      assert.equal(typeof err.details.unreadMessages, 'number');
      assert.equal(typeof err.details.pendingEvents, 'number');
      assert.equal(err.details.unreviewedCount, 1);
      assert.equal(err.details.taskId, 'task-gate-173');
      return true;
    },
  );
});

test('173-F3: 永未验收记录重挂有界（24 次后强制清理）', async () => {
  setCleanupDelayMs(5);
  clearAllSubagents();
  const rec = createSubagent('task-never-reviewed', { subject: 'orphan work' });
  // 走 updateSubagentStatus 触达终态分支→启动清理定时器（直接改 rec.status 不会启动定时器）
  updateSubagentStatus('task-never-reviewed', 'completed', { result: 'x' });
  // resultFetched 保持 false——重挂 24 次（24×5ms≈120ms）后强制删除；
  // 有界轮询替代固定 400ms（Windows runner 定时器抖动可远超 400ms，#176 CI 实测）
  try {
    let still;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      still = getSubagentBySessionId(rec.sessionId);
      if (still === undefined) break;
    }
    assert.equal(still, undefined, '弃管子记录应在重挂上限后被强制清理');
  } finally {
    setCleanupDelayMs(60 * 60 * 1000);
  }
});

test('173-F1: NOT_FOUND 查询不产生残留标记', () => {
  clearAllSubagents();
  // 无记录时 runner.status 抛 NOT_FOUND——不应有任何 subagent 记录残留
  assert.equal(getSubagentBySessionId('no-such-session'), undefined);
});

test('173-F4（#177）：已验收记录首火即删（resultFetched 快径）', async () => {
  setCleanupDelayMs(5);
  clearAllSubagents();
  const rec = createSubagent('task-reviewed', { subject: 'reviewed work' });
  // 走 updateSubagentStatus 触达终态分支→启动清理定时器（直接改 rec.status 不会启动定时器）
  updateSubagentStatus('task-reviewed', 'completed', { result: 'x' });
  markResultFetched('task-reviewed');
  // 断言窗口 40ms：正确实现首火（~5ms）即删；resultFetched 快径被移除时 24 次重挂（~120ms）前必在
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(getSubagentBySessionId(rec.sessionId), undefined, '已验收记录应在首火即删');
  setCleanupDelayMs(60 * 60 * 1000);
});
