// Issue #153（ADR-0048 D5 中）— 完成闸门 1 小时旁路封堵
// 旁路：subagent/store.ts 终态清理定时器无条件删除记录 → 父不验收熬过 1h 后
//       闸门 getSubagentBySessionId 查无记录 → 放行收工。
// 修复（方案二）：到点未验收（resultFetched !== true）→ 豁免清理并重新武装定时器；
//       已验收 → 按兜底正常回收。「父取过终态 result 后放行」语义零偏移。
// 切片 1（本文件上半）：subagent/store 清理定时器豁免行为
// 切片 2（本文件下半）：store 收工闸门跨清理点仍拦 + 取过后放行

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  clearAllSubagents,
  createSubagent,
  getSubagent,
  markResultFetched,
  setCleanupDelayMs,
  updateSubagentStatus,
} from '../dist/subagent/store.js';
import { MyTerminalStore } from '../dist/store.js';

// ── 测试辅助 ──

function tempDir() {
  const dir = join(tmpdir(), 'issue-153-' + randomBytes(4).toString('hex'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 最小合法 TaskPackage（cleanTask 五项全必填非空，同 136） */
function makeTask(objective) {
  return { objective, background: 'slice background', deliverables: ['slice done'], acceptanceCriteria: ['verified'], constraints: ['local only'] };
}

// ══════════════════════════════════════════════════════
// 切片 1：清理定时器豁免（subagent/store）
// ══════════════════════════════════════════════════════

test('153-s1: 未验收终态记录过清理点仍存活（豁免兜底清理）', async () => {
  clearAllSubagents();
  setCleanupDelayMs(10);
  createSubagent('task-keep', { subject: 'unreviewed work' });
  updateSubagentStatus('task-keep', 'completed', { result: 'child payload' });

  await Bun.sleep(80); // 远超清理点 10ms，若未豁免记录早被删

  const record = getSubagent('task-keep');
  assert.ok(record, '未验收终态记录豁免 1h 兜底清理，闸门证据不灭失');
  assert.equal(record.resultFetched, undefined);

  // 清理现场：验收后让重武装定时器正常回收
  markResultFetched('task-keep');
  await Bun.sleep(60);
  assert.equal(getSubagent('task-keep'), undefined, '验收后按兜底正常回收');
  setCleanupDelayMs(60 * 60 * 1000);
});

test('153-s2: 已验收终态记录过清理点按兜底回收（正常路径不回退）', async () => {
  clearAllSubagents();
  setCleanupDelayMs(10);
  createSubagent('task-del', { subject: 'reviewed work' });
  updateSubagentStatus('task-del', 'completed', { result: 'child payload' });
  markResultFetched('task-del');

  await Bun.sleep(80);

  assert.equal(getSubagent('task-del'), undefined, '已验收记录仍按 1h 兜底清理');
  setCleanupDelayMs(60 * 60 * 1000);
});

test('153-s3: 过第一清理点后才验收 → 下一清理点正常回收', async () => {
  clearAllSubagents();
  setCleanupDelayMs(10);
  createSubagent('task-late', { subject: 'late reviewed work' });
  updateSubagentStatus('task-late', 'completed', { result: 'child payload' });

  await Bun.sleep(40); // 第一清理点已过（豁免 + 重武装）
  assert.ok(getSubagent('task-late'), '第一清理点后未验收记录仍在');

  markResultFetched('task-late');
  await Bun.sleep(60); // 重武装后的下一清理点
  assert.equal(getSubagent('task-late'), undefined, '验收后下一清理点回收');
  setCleanupDelayMs(60 * 60 * 1000);
});

// ══════════════════════════════════════════════════════
// 切片 2：store 收工完成闸门跨清理点（AC1/AC2，136-s6 同款铺路）
// ══════════════════════════════════════════════════════

test('153-s4: AC1 — 未验收子结果熬过清理点后收工仍被拦', async () => {
  const dir = tempDir();
  const store = new MyTerminalStore(join(dir, 'state'));
  const root = store.registerRoot({ name: 'root', role: 'lead' });
  const childInfo = store.registerDelegate(root.session.id, { name: 'worker', task: makeTask('delegated slice') });
  const childId = childInfo.session.id;

  // 子会话先收工（终态）；child 完成事件发给 root，须 ack 才能过旧闸门（同 136-s6）
  store.checkpoint(childId, { phase: 'completed', summary: 'child done.' });
  const childEvents = store.snapshot().events.filter((e) => e.recipientSessionId === root.session.id && e.sourceSessionId === childId);
  if (childEvents.length) store.acknowledgeEvents(root.session.id, childEvents.map((e) => e.id));

  // subagent record 进终态但父从未调 status → 未验收；清理延迟压到 10ms 模拟 1h 兜底
  clearAllSubagents();
  setCleanupDelayMs(10);
  const rec = createSubagent('task-gate2', { subject: 'delegated work' });
  rec.sessionId = childId;
  updateSubagentStatus('task-gate2', 'completed', { result: 'child result payload' });

  await Bun.sleep(80); // 「熬过 1h」：记录本应被兜底清理删掉（旧行为=旁路）

  assert.throws(
    () => store.checkpoint(root.session.id, { phase: 'completed', summary: 'wrap up' }),
    (err) => {
      assert.equal(err.code, 'CHILD_RESULT_UNREVIEWED');
      assert.equal(err.message, '先查子结果再收工');
      assert.equal(err.details.taskId, 'task-gate2');
      assert.equal(err.details.childSessionId, childId);
      return true;
    },
  );

  // 清理现场：验收让重武装定时器回收
  markResultFetched('task-gate2');
  await Bun.sleep(60);
  setCleanupDelayMs(60 * 60 * 1000);
  rmSync(dir, { recursive: true, force: true });
});

test('153-s5: AC2 — 父取过终态 result 后正常放行（幂等保留语义不变）', async () => {
  const dir = tempDir();
  const store = new MyTerminalStore(join(dir, 'state'));
  const root = store.registerRoot({ name: 'root', role: 'lead' });
  const childInfo = store.registerDelegate(root.session.id, { name: 'worker', task: makeTask('delegated slice') });
  const childId = childInfo.session.id;

  store.checkpoint(childId, { phase: 'completed', summary: 'child done.' });
  const childEvents = store.snapshot().events.filter((e) => e.recipientSessionId === root.session.id && e.sourceSessionId === childId);
  if (childEvents.length) store.acknowledgeEvents(root.session.id, childEvents.map((e) => e.id));

  clearAllSubagents();
  const rec = createSubagent('task-gate3', { subject: 'delegated work' });
  rec.sessionId = childId;
  updateSubagentStatus('task-gate3', 'completed', { result: 'child result payload' });

  // 父取过终态 result（置位）→ 闸门放行
  markResultFetched('task-gate3');
  const done = store.checkpoint(root.session.id, { phase: 'completed', summary: 'wrap up' });
  assert.equal(done.phase, 'completed');

  // 幂等保留：放行后记录仍在（resultFetched 保持 true，等兜底回收），不立即删除
  assert.equal(getSubagent('task-gate3').resultFetched, true);
  markResultFetched('task-gate3');
  assert.equal(getSubagent('task-gate3').resultFetched, true, '重复置位幂等');

  rmSync(dir, { recursive: true, force: true });
});
