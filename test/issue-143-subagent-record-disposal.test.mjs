// Issue #143（ADR-0048 A48-W2 F2）— subagent 记录收口接线
//
// session-resource-manager 登记 'subagent-records' agent 资源：agent 终结（disposeAgent）时
// 经 getSubagentBySessionId 反查对应 session 的 SubagentRecord。清理闸门（决策 7 + AC3）：
//   仅「终态且父已验收（resultFetched）」即清；running 在世不误删；未验收保留给 1h 兜底。
// 切片：
//   S1 终结清理（终态+已验收 → 清）
//   S2 在世不误删（running → 留）
//   S3 未验收保留（终态未验收 → 留）
//   S4 无 sessionId 孤儿（executor 决策 5/25 自建路径 → 留，1h 兜底）
//   S5 1h 定时器兜底语义不变（不经 disposeAgent 仍按 cleanupDelayMs 清理）

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { sessionResourceManager } from '../dist/session-resource-manager.js';
import {
  clearAllSubagents,
  createSubagent,
  getSubagent,
  getCleanupDelayMs,
  markResultFetched,
  setCleanupDelayMs,
  updateSubagentStatus,
} from '../dist/subagent/store.js';

function makeTerminal(id) {
  const rec = createSubagent(id, { subject: 'slice task' });
  rec.sessionId = `sess-${id}`; // runner.ts:168 回填口径
  updateSubagentStatus(id, 'completed', { result: 'slice done.' });
  return rec;
}

// ── S1：终结清理 ──
test('143-s1: 终态且已验收的 record 在 disposeAgent 时即清', () => {
  clearAllSubagents();
  makeTerminal('sa-a');
  markResultFetched('sa-a');

  sessionResourceManager.disposeAgent('sa-a');

  assert.equal(getSubagent('sa-a'), undefined, '已验收终态记录应被收口清理');
});

// ── S2：在世不误删（AC2）──
test('143-s2: running 在世 record 不被 disposeAgent 误删', () => {
  clearAllSubagents();
  const rec = createSubagent('sa-run', { subject: 'still running' });
  rec.sessionId = 'sess-sa-run';

  sessionResourceManager.disposeAgent('sa-run');

  assert.ok(getSubagent('sa-run'), 'running record 必须保留（Home.tsx:160 在世读取）');
  assert.equal(getSubagent('sa-run').status, 'running');
});

// ── S3：未验收保留（决策 7 / AC3 幂等保留）──
test('143-s3: 终态但父未验收的 record 保留给 1h 兜底', () => {
  clearAllSubagents();
  makeTerminal('sa-b');

  sessionResourceManager.disposeAgent('sa-b');

  const kept = getSubagent('sa-b');
  assert.ok(kept, '未验收 record 必须保留（父还需轮询取 result）');
  assert.equal(kept.resultFetched, undefined);
});

// ── S4：无 sessionId 孤儿 ──
test('143-s4: 无 sessionId 的 record（executor 自建路径）不参与反查清理', () => {
  clearAllSubagents();
  const rec = createSubagent('sa-orphan', { subject: 'self-built record' });
  updateSubagentStatus('sa-orphan', 'completed', { result: 'orphan done.' });
  markResultFetched('sa-orphan');

  sessionResourceManager.disposeAgent('sa-orphan');

  assert.ok(getSubagent('sa-orphan'), '无 sessionId 无对应 session 可反查，留给 1h 兜底');
});

// ── S5：1h 定时器兜底语义不变（AC3）──
test('143-s5: 1h 定时器兜底仍按 cleanupDelayMs 清理终态 record', async () => {
  clearAllSubagents();
  const prev = getCleanupDelayMs();
  setCleanupDelayMs(30);
  try {
    makeTerminal('sa-timer');
    assert.ok(getSubagent('sa-timer'), '终态后 record 仍保留（未到兜底时间）');

    await Bun.sleep(90);

    assert.equal(getSubagent('sa-timer'), undefined, '兜底定时器到点即清');
  } finally {
    setCleanupDelayMs(prev);
  }
});
