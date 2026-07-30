/**
 * #63（批5 第 11 刀·性能刀）G4 锁定测试。
 *
 * 铁律：先锁现状，再动刀，锁定测试不改一行仍全绿。
 *
 * 锁定方式：把 store.context() 现状逻辑（组装 + fitProjection O(n²) 原算法）
 * 逐字复刻为本文件内的 reference 实现（自行从磁盘读 history tail），
 * 对拍 store.context() 的真实输出。重构（抽 ContextProjector 纯函数层、
 * fitProjection 改 O(n)、history tail 缓存）后，本对拍必须逐字节相等。
 *
 * microCompact（#35 并入项 a）同文件锁定：占位替换位置、保留窗口、
 * 未知 tool_use_id 不压缩、原地变更语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MyTerminalStore, publicSession } from '../dist/store.js';
import { microCompact } from '../dist/subagent/executor.js';

const HISTORY_TAIL_LIMIT = 5_000;
const CONTEXT_LIMIT = 16_000;

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-issue63-'));
}

/** 直接向 history JSONL 追加行（绕过 store，与 perf 脚本同法）。 */
function appendHistoryLines(stateDir, sessionId, entries) {
  const file = path.join(stateDir, 'history', `${sessionId}.jsonl`);
  fs.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function auditEntry(index, payloadSize = 64) {
  return {
    at: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    type: 'tool_audit',
    data: { id: `act-${index}`, action: 'list_dir', tool: 'list_dir', status: 'completed', ok: true, durationMs: index % 7, result: { index, payload: 'x'.repeat(payloadSize) } },
  };
}

function noteEntry(index) {
  return { at: new Date(1_700_000_000_000 + index * 1000).toISOString(), type: 'note', data: { index } };
}

// ─── reference 实现：store.ts context()/fitProjection 现状逐字复刻 ───

function readTailFromDisk(stateDir, sessionId) {
  const file = path.join(stateDir, 'history', `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
  const tail = lines.slice(-HISTORY_TAIL_LIMIT);
  const entries = [];
  for (const line of tail) {
    try { entries.push(JSON.parse(line)); } catch { /* tolerate corrupt line */ }
  }
  return entries;
}

function referenceFitProjection(projection, limit) {
  let result = structuredClone(projection);
  while (JSON.stringify(result).length > limit && Array.isArray(result.recentMessages) && result.recentMessages.length) result.recentMessages.shift();
  while (JSON.stringify(result).length > limit && Array.isArray(result.recentToolCalls) && result.recentToolCalls.length) result.recentToolCalls.shift();
  while (JSON.stringify(result).length > limit && Array.isArray(result.inheritedRecentMessages) && result.inheritedRecentMessages.length) result.inheritedRecentMessages.shift();
  while (JSON.stringify(result).length > limit && Array.isArray(result.inheritedRecentToolCalls) && result.inheritedRecentToolCalls.length) result.inheritedRecentToolCalls.shift();
  while (JSON.stringify(result).length > limit && Array.isArray(result.parentRecentToolCalls) && result.parentRecentToolCalls.length) result.parentRecentToolCalls.shift();
  if (JSON.stringify(result).length > limit) result = { session: projection.session, objective: projection.objective, finalSummary: projection.finalSummary, latestSummary: projection.latestSummary };
  const encoded = JSON.stringify(result);
  return encoded.length <= limit ? result : { objective: String(projection.objective || '').slice(0, 4000), finalSummary: String(projection.finalSummary || projection.latestSummary || '').slice(0, 4000), truncated: true };
}

function referenceContext(store, stateDir, sessionId) {
  const state = store.snapshot();
  const find = (id) => {
    const s = state.sessions.find((item) => item.id === id);
    assert.ok(s, `reference: session ${id} missing`);
    return s;
  };
  const session = find(sessionId);
  const history = readTailFromDisk(stateDir, session.id);
  const audits = history.filter((item) => item.type === 'tool_audit').slice(-10).map((item) => item.data);
  const candidates = state.messages.filter((message) => message.from === session.id || message.to === session.id);
  const unread = candidates.filter((message) => message.to === session.id && !message.readAt).slice(-20);
  const messages = [...candidates.filter((message) => message.readAt || message.to !== session.id).slice(-(20 - unread.length)), ...unread];
  const parent = session.parentSessionId ? find(session.parentSessionId) : undefined;
  const parentAudits = parent ? readTailFromDisk(stateDir, parent.id).filter((item) => item.type === 'tool_audit').slice(-10).map((item) => item.data) : [];
  const predecessor = session.continuesSessionId ? find(session.continuesSessionId) : undefined;
  const predecessorAudits = predecessor ? readTailFromDisk(stateDir, predecessor.id).filter((item) => item.type === 'tool_audit').slice(-10).map((item) => item.data) : [];
  const predecessorMessages = predecessor ? state.messages.filter((message) => message.from === predecessor.id || message.to === predecessor.id).slice(-20) : [];
  const projection = {
    session: publicSession(session), objective: session.task?.objective,
    finalSummary: session.finalSummary,
    latestSummary: session.latestCheckpoint?.summary,
    parentContext: parent ? { session: publicSession(parent), finalSummary: parent.finalSummary, latestSummary: parent.latestCheckpoint?.summary } : undefined,
    parentRecentToolCalls: parentAudits,
    inheritedFrom: predecessor ? publicSession(predecessor) : undefined,
    inheritedRecentToolCalls: predecessorAudits,
    inheritedRecentMessages: predecessorMessages,
    recentToolCalls: audits, recentMessages: messages,
  };
  return referenceFitProjection(projection, CONTEXT_LIMIT);
}

const TASK = { objective: 'perf knife', background: 'issue #63', deliverables: ['d'], acceptanceCriteria: ['a'], constraints: ['c'] };

// ─── context() 对拍锁定 ───

test('#63 G4 锁定 01: 普通 root（小 history）context() 与 reference 逐字节一致', () => {
  const stateDir = tmpStateDir();
  const store = new MyTerminalStore(stateDir);
  const root = store.registerRoot({ name: 'plain-root' });
  appendHistoryLines(stateDir, root.session.id, Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? noteEntry(i) : auditEntry(i))));
  const actual = store.context(root.session.id);
  const expected = referenceContext(store, stateDir, root.session.id);
  assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
});

test('#63 G4 锁定 02: child+parent 双 history 路径一致（含超过 tail 上限的 parent history）', () => {
  const stateDir = tmpStateDir();
  const store = new MyTerminalStore(stateDir);
  const root = store.registerRoot({ name: 'parent-root' });
  // parent 历史超过 HISTORY_TAIL_LIMIT，锁定 tail 截断语义
  appendHistoryLines(stateDir, root.session.id, Array.from({ length: HISTORY_TAIL_LIMIT + 50 }, (_, i) => auditEntry(i, 8)));
  const child = store.registerDelegate(root.session.id, { name: 'worker', task: TASK });
  appendHistoryLines(stateDir, child.session.id, Array.from({ length: 40 }, (_, i) => auditEntry(i)));
  store.sendMessage(root.session.id, child.session.id, 'hello child');
  store.sendMessage(child.session.id, root.session.id, 'hello parent');
  const actual = store.context(child.session.id);
  const expected = referenceContext(store, stateDir, child.session.id);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.ok(Array.isArray(actual.parentRecentToolCalls) && actual.parentRecentToolCalls.length === 10);
});

test('#63 G4 锁定 03: root continuation（predecessor）+ 已读/未读消息混合一致', () => {
  const stateDir = tmpStateDir();
  const store = new MyTerminalStore(stateDir);
  const first = store.registerRoot({ name: 'gen-1' });
  const peer = store.registerRoot({ name: 'peer' });
  appendHistoryLines(stateDir, first.session.id, Array.from({ length: 25 }, (_, i) => auditEntry(i)));
  store.sendMessage(peer.session.id, first.session.id, 'legacy inbound'); // predecessor 名下消息（终态前发）
  store.sendMessage(first.session.id, peer.session.id, 'legacy outbound');
  store.checkpoint(first.session.id, { phase: 'completed', summary: 'generation one done' });
  const second = store.registerRoot({ name: 'gen-2', continuesSessionId: first.session.id });
  appendHistoryLines(stateDir, second.session.id, Array.from({ length: 5 }, (_, i) => auditEntry(i)));
  store.sendMessage(peer.session.id, second.session.id, 'read me');
  store.inboxPage(second.session.id, true); // 标记已读
  store.sendMessage(peer.session.id, second.session.id, 'unread tail');
  const actual = store.context(second.session.id);
  const expected = referenceContext(store, stateDir, second.session.id);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.ok(actual.inheritedFrom);
  assert.equal(actual.inheritedRecentToolCalls.length, 10);
});

test('#63 G4 锁定 04: 超预算触发裁剪循环，输出 ≤ 16000 且与 reference 一致', () => {
  const stateDir = tmpStateDir();
  const store = new MyTerminalStore(stateDir);
  const root = store.registerRoot({ name: 'busy-root' });
  const peer = store.registerRoot({ name: 'peer' });
  appendHistoryLines(stateDir, root.session.id, Array.from({ length: 60 }, (_, i) => auditEntry(i, 900)));
  for (let i = 0; i < 25; i += 1) store.sendMessage(peer.session.id, root.session.id, `${i}:${'m'.repeat(1200)}`);
  const actual = store.context(root.session.id);
  const expected = referenceContext(store, stateDir, root.session.id);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.ok(JSON.stringify(actual).length <= CONTEXT_LIMIT);
  // 确认真的发生了裁剪（未裁剪的组装体必须超预算）
  assert.ok(Array.isArray(actual.recentMessages));
  assert.ok(actual.recentMessages.length < 20);
});

test('#63 G4 锁定 05: 巨型 objective 走 minimal 兜底再走 truncated 尾路径', () => {
  const stateDir = tmpStateDir();
  const store = new MyTerminalStore(stateDir);
  const root = store.registerRoot({ name: 'giant-root' });
  // objective/background 上限 4000，deliverables 单项无长度上限——用它把 session 块撑爆，
  // 迫使 minimal 兜底仍超预算，走 truncated 尾路径。
  const child = store.registerDelegate(root.session.id, {
    name: 'giant-task',
    task: { objective: 'O'.repeat(4000), background: 'B'.repeat(4000), deliverables: ['D'.repeat(12_000)], acceptanceCriteria: ['a'], constraints: ['c'] },
  });
  const actual = store.context(child.session.id);
  const expected = referenceContext(store, stateDir, child.session.id);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.equal(actual.truncated, true);
  assert.equal(actual.objective.length, 4000);
});

test('#63 G4 锁定 06: 重复调用 context() 输出逐字节一致（S2 缓存正确性前提）', () => {
  const stateDir = tmpStateDir();
  const store = new MyTerminalStore(stateDir);
  const root = store.registerRoot({ name: 'repeat-root' });
  appendHistoryLines(stateDir, root.session.id, Array.from({ length: 200 }, (_, i) => auditEntry(i)));
  const first = store.context(root.session.id);
  const second = store.context(root.session.id);
  const third = store.context(root.session.id);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(second), JSON.stringify(third));
});

test('#63 G4 锁定 07: context() 之后 auditEvent 追加，下一次 context() 能看到新审计（缓存必须失效）', () => {
  const stateDir = tmpStateDir();
  const store = new MyTerminalStore(stateDir);
  const root = store.registerRoot({ name: 'invalidate-root' });
  appendHistoryLines(stateDir, root.session.id, Array.from({ length: 12 }, (_, i) => auditEntry(i)));
  const before = store.context(root.session.id);
  store.auditEvent(root.session.id, {
    id: 'fresh-audit', timestamp: new Date().toISOString(), source: 'test', action: 'read_file',
    status: 'completed', durationMs: 3, workspace: 'w', session: root.session.id,
  });
  const after = store.context(root.session.id);
  assert.notEqual(JSON.stringify(before), JSON.stringify(after));
  assert.ok(after.recentToolCalls.some((call) => call.id === 'fresh-audit'));
  const expected = referenceContext(store, stateDir, root.session.id);
  assert.equal(JSON.stringify(after), JSON.stringify(expected));
});

// ─── microCompact 行为锁定（#35 并入项 a）───

function mkUse(id, name) { return { type: 'tool_use', id, name, input: {} }; }
function mkResult(id, text) { return { type: 'tool_result', tool_use_id: id, content: text }; }

test('#63 G4 锁定 08: microCompact 结果数 ≤ 5 时原样返回（同一引用，零改动）', () => {
  const messages = [
    { role: 'assistant', content: [mkUse('t1', 'read_file')] },
    { role: 'user', content: [mkResult('t1', 'r1')] },
  ];
  const snapshot = JSON.stringify(messages);
  const output = microCompact(messages);
  assert.equal(output, messages);
  assert.equal(JSON.stringify(output), snapshot);
});

test('#63 G4 锁定 09: microCompact 只压缩早于保留窗口且属于可压缩工具的结果', () => {
  const messages = [
    { role: 'assistant', content: [mkUse('t1', 'read_file'), mkUse('t2', 'write_file')] },
    { role: 'user', content: [mkResult('t1', 'r1'), mkResult('t2', 'r2')] },
    { role: 'assistant', content: [mkUse('t3', 'grep')] },
    { role: 'user', content: [mkResult('t3', 'r3'), mkResult('missing-id', 'orphan')] },
    { role: 'assistant', content: [mkUse('t5', 'execute_cli'), mkUse('t6', 'glob'), mkUse('t7', 'read_file'), mkUse('t8', 'grep'), mkUse('t9', 'execute_cli')] },
    { role: 'user', content: [mkResult('t5', 'r5'), mkResult('t6', 'r6'), mkResult('t7', 'r7'), mkResult('t8', 'r8'), mkResult('t9', 'r9')] },
  ];
  // 9 个 tool_result，保留最近 5 个（t5..t9），压缩窗口为前 4 个（t1,t2,t3,missing-id）
  const output = microCompact(messages);
  assert.equal(output, messages); // 原地变更语义
  assert.equal(output[1].content[0].content, '[此工具结果已被微压缩清理]'); // t1 read_file ∈ 可压缩
  assert.equal(output[1].content[1].content, 'r2'); // t2 write_file ∉ 可压缩
  assert.equal(output[3].content[0].content, '[此工具结果已被微压缩清理]'); // t3 grep ∈ 可压缩
  assert.equal(output[3].content[1].content, 'orphan'); // 未知 tool_use_id → 工具名 '' ∉ 可压缩
  for (const [i, text] of [['r5'], ['r6'], ['r7'], ['r8'], ['r9']].map((v, idx) => [idx, v[0]])) {
    assert.equal(output[5].content[i].content, text); // 最近 5 个全部保留
  }
});

test('#63 G4 锁定 10: microCompact 同一 tool_use_id 重复出现时 first-wins', () => {
  const messages = [
    { role: 'assistant', content: [mkUse('dup', 'read_file')] },
    { role: 'user', content: [mkResult('dup', 'old')] },
    { role: 'assistant', content: [mkUse('dup', 'write_file'), mkUse('k1', 'grep'), mkUse('k2', 'grep'), mkUse('k3', 'grep'), mkUse('k4', 'grep'), mkUse('k5', 'grep')] },
    { role: 'user', content: [mkResult('k1', 'v1'), mkResult('k2', 'v2'), mkResult('k3', 'v3'), mkResult('k4', 'v4'), mkResult('k5', 'v5')] },
  ];
  // 6 个结果，压缩窗口=1（dup）。first-wins → dup 解析为 read_file（可压缩）
  const output = microCompact(messages);
  assert.equal(output[1].content[0].content, '[此工具结果已被微压缩清理]');
  assert.equal(output[3].content[0].content, 'v1');
});
