/**
 * Seam lock tests for issue #64 (batch5 cut 6): store 审计 seam 抽 AuditLog。
 *
 * 锁定三件事（G4：先绿锁现状 → 重构 → 不改一行仍全绿 + 快照 diff 零）：
 *   T1  auditEvent 返回形状（红化后 args/result 与 event 合并返回）
 *   T2  持久化快照：history jsonl 的 tool_audit.data 固定快照（铁律：不动持久化格式）
 *   T3  auditFacts 回放归一化（同 id 去重 + 保留最早 at/timestamp）
 *
 * 这些测试在重构前对当前 main 代码全绿，重构后（store.auditEvent/auditFacts 委托给
 * AuditLog）必须仍全绿，且 T2 快照零 diff。期望值来自格式契约（独立真相），非代码回声。
 *
 * 运行：bun test test/audit-log-seam-issue64.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MyTerminalStore } from '../dist/store.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-audit-log-64-'));
}

function configFor(root) {
  const workspaceDir = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { workspaceDir, stateDir };
}

function setup(root) {
  const config = configFor(root);
  const store = new MyTerminalStore(config.stateDir);
  const { session } = store.registerRoot({ name: 'audit-log-64-root' });
  return { config, store, sessionId: session.id };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function baseEvent(overrides = {}) {
  return {
    id: 'act_lock_1',
    timestamp: '2026-07-30T07:00:00.000Z',
    completedAt: '2026-07-30T07:00:01.000Z',
    source: 'actions',
    action: 'my_tool',
    status: 'completed',
    durationMs: 1000,
    workspace: '',
    session: '',
    args: { token: 'abc123', label: 'hi' },
    result: { ok: true },
    ...overrides,
  };
}

function readToolAuditData(stateDir, sessionId) {
  const file = path.join(stateDir, 'history', `${sessionId}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const entries = lines.map((l) => JSON.parse(l));
  const audit = entries.find((e) => e.type === 'tool_audit');
  if (!audit) throw new Error('no tool_audit entry found in history');
  return audit.data;
}

// ─── T1: auditEvent 返回形状（红化后 args/result 与 event 合并） ───────────────

test('T1: auditEvent 返回红化后的事件（secret 字段脱敏，其余原样）', () => {
  const root = tempRoot();
  try {
    const { store, sessionId } = setup(root);
    const event = baseEvent({ workspace: root, session: sessionId });
    const returned = store.auditEvent(sessionId, event);

    // 红化：敏感 key 'token' → [REDACTED]
    assert.equal(returned.args.token, '[REDACTED]');
    assert.equal(returned.args.label, 'hi');
    // result 原样透传
    assert.deepEqual(returned.result, { ok: true });
    // 标识与状态透传
    assert.equal(returned.id, 'act_lock_1');
    assert.equal(returned.status, 'completed');
    assert.equal(returned.source, 'actions');
    assert.equal(returned.action, 'my_tool');
  } finally {
    cleanup(root);
  }
});

// ─── T2: 持久化快照（铁律：不动持久化格式） ───────────────────────────────────

test('T2: 持久化 tool_audit.data 快照固定（重构后 diff 必须为零）', () => {
  const root = tempRoot();
  try {
    const { config, store, sessionId } = setup(root);
    const event = baseEvent({ workspace: config.workspaceDir, session: sessionId });
    store.auditEvent(sessionId, event);

    const data = readToolAuditData(config.stateDir, sessionId);
    // 期望值来自格式契约（独立真相），非代码回声。
    const expected = {
      id: 'act_lock_1',
      timestamp: '2026-07-30T07:00:00.000Z',
      completedAt: '2026-07-30T07:00:01.000Z',
      source: 'actions',
      action: 'my_tool',
      status: 'completed',
      durationMs: 1000,
      workspace: config.workspaceDir,
      session: sessionId,
      // 红化后的 args（写入即脱敏）
      args: { token: '[REDACTED]', label: 'hi' },
      result: { ok: true },
      // 兼容性字段（供旧版 history reader / continuation 投影）
      // 注意：error/errorCode 在事件无错时为 undefined，JSON.stringify 会丢弃，
      // 故磁盘 data 不含这两个 key——这正是要锁定的真实现状。
      tool: 'my_tool',
      ok: true,
      startedAt: '2026-07-30T07:00:00.000Z',
    };
    assert.deepEqual(data, expected);
  } finally {
    cleanup(root);
  }
});

// ─── T3: auditFacts 回放归一化（同 id 去重 + 保留最早 at/timestamp） ──────────

test('T3: auditFacts 同 id 去重，更新取最新 status，at/timestamp 保留最早', () => {
  const root = tempRoot();
  try {
    const { config, store, sessionId } = setup(root);
    const e1 = baseEvent({
      id: 'act_dedup', workspace: config.workspaceDir, session: sessionId,
      status: 'running', timestamp: '2026-07-30T07:00:00.000Z', completedAt: undefined,
      result: { ok: false },
    });
    const e2 = baseEvent({
      id: 'act_dedup', workspace: config.workspaceDir, session: sessionId,
      status: 'completed', timestamp: '2026-07-30T07:05:00.000Z', completedAt: '2026-07-30T07:05:01.000Z',
      result: { ok: true, done: 1 },
    });
    store.auditEvent(sessionId, e1);
    store.auditEvent(sessionId, e2);

    const facts = store.auditFacts(100);
    assert.equal(facts.length, 1, '同 id 必须去重为 1 条');
    const f = facts[0];
    assert.equal(f.id, 'act_dedup');
    assert.equal(f.status, 'completed', '更新取最新 status');
    assert.equal(f.at, '2026-07-30T07:00:00.000Z', 'at 保留最早（首次）');
    assert.equal(f.timestamp, '2026-07-30T07:00:00.000Z', 'timestamp 保留最早（首次）');
    assert.equal(f.action, 'my_tool');
    assert.equal(f.tool, 'my_tool');
    assert.equal(f.ok, true);
    assert.equal(f.sessionId, sessionId);
    assert.deepEqual(f.result, { ok: true, done: 1 }, 'result 取最新');
  } finally {
    cleanup(root);
  }
});

// ─── T4: 分页 reader（新增能力，供 #62 复用） ─────────────────────────────────

test('T4: auditFactsPage 连贯分页（total/offset/nextOffset 信封对齐 historyPage）', () => {
  const root = tempRoot();
  try {
    const { config, store, sessionId } = setup(root);
    for (let i = 0; i < 5; i += 1) {
      store.auditEvent(sessionId, baseEvent({
        id: `act_page_${i}`,
        workspace: config.workspaceDir,
        session: sessionId,
        timestamp: `2026-07-30T07:0${i}:00.000Z`,
      }));
    }

    const first = store.auditFactsPage(0, 2);
    assert.equal(first.total, 5);
    assert.equal(first.offset, 0);
    assert.equal(first.nextOffset, 2);
    assert.deepEqual(first.facts.map((f) => f.id), ['act_page_0', 'act_page_1']);

    const second = store.auditFactsPage(first.nextOffset, 2);
    assert.deepEqual(second.facts.map((f) => f.id), ['act_page_2', 'act_page_3']);
    assert.equal(second.nextOffset, 4);

    const last = store.auditFactsPage(second.nextOffset, 2);
    assert.deepEqual(last.facts.map((f) => f.id), ['act_page_4']);
    assert.equal(last.nextOffset, undefined, '最后一页无 nextOffset');

    // 越界 offset 被 clamp 到 total，不抛错
    const beyond = store.auditFactsPage(999, 2);
    assert.equal(beyond.offset, 5);
    assert.deepEqual(beyond.facts, []);
  } finally {
    cleanup(root);
  }
});

// ─── T5: AuditLog 独立可测（fake io + fake redact + fake now，零文件系统） ─────

test('T5: AuditLog 脱离 store 可直测（注入 io/redact/now，不碰文件系统）', async () => {
  const { AuditLog } = await import('../dist/audit-log.js');

  const session = { id: 's1', name: 'fake-session' };
  const written = [];
  const history = [];
  const io = {
    appendToolAudit(sessionId, data) {
      written.push({ sessionId, data });
      history.push({ at: '2026-07-30T08:00:00.000Z', type: 'tool_audit', data });
    },
    readRecentHistory: () => history,
    listSessions: () => [session],
    requireSession: (id) => {
      if (id !== session.id) throw new Error(`unknown session ${id}`);
      return session;
    },
  };
  // fake redact：可辨识的替换，证明红化确实走注入而非硬编码依赖
  const fakeRedact = (value) => JSON.parse(JSON.stringify(value).replaceAll('abc123', '<FAKE-REDACTED>'));
  const fakeNow = () => Date.parse('2026-07-30T08:00:00.000Z');

  const log = new AuditLog(io, fakeNow, fakeRedact);
  const returned = log.event('s1', baseEvent({ workspace: '/w', session: 's1' }));

  assert.equal(returned.args.token, '<FAKE-REDACTED>', '红化走注入的 redact');
  assert.equal(written.length, 1, '落盘经由注入的 io');
  assert.equal(written[0].sessionId, 's1');
  assert.equal(written[0].data.tool, 'my_tool', '兼容字段仍写入');
  assert.equal(written[0].data.ok, true);

  const facts = log.facts(10);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].sessionId, 's1');
  assert.equal(facts[0].sessionName, 'fake-session');
  assert.equal(facts[0].id, 'act_lock_1');

  const page = log.factsPage(0, 1);
  assert.equal(page.total, 1);
  assert.equal(page.nextOffset, undefined);

  log.pruneDeleted(new Set(['s1']));
  assert.equal(log.facts(10).length, 0, 'pruneDeleted 清掉已删会话的缓存事实');
});
