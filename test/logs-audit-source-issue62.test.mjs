/**
 * Logs 数据源契约测试 — issue #62（批5 第 7 刀）。
 *
 * 背景：Logs 屏原先 `auditFacts(5000)` 全扫描 + 屏内 anchorAt 过滤 + 屏内反向切片。
 * 本刀把这三件事下沉到 #64 抽出的 audit seam（AuditLog.recentFactsPage）。
 *
 * G4 锁定策略（先绿锁现状 → 重构 → 快照 diff 为零）：
 *   L1  现状语义特征测试：用 auditFacts + Logs 屏原表达式，期望值手算（独立真相，非代码回声）。
 *       重构前后都必须绿——它锁的是"该显示哪些事实"这个契约本身。
 *   L2  等价测试：新 seam 输出 === L1 的现状表达式输出（矩阵覆盖 page × anchorAt）。
 *       重构前红（方法不存在），重构后绿。
 *   L3  分页信封语义（total/offset/nextOffset，对齐 historyPage/inboxPage 风格）。
 *   L4  5000 条窗口上限保留：facts(5000) 的窗口语义不得因换 seam 而改变（fake io，零文件系统）。
 *
 * 运行：bun test test/logs-audit-source-issue62.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MyTerminalStore } from '../dist/store.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-logs-audit-62-'));
}

function setup(root) {
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const store = new MyTerminalStore(stateDir);
  const { session } = store.registerRoot({ name: 'logs-62-root' });
  return { store, sessionId: session.id };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/** 第 i 条事实固定落在 2026-07-30T07:0i:00.000Z。 */
function at(i) {
  return `2026-07-30T07:0${i}:00.000Z`;
}

function seedFacts(store, sessionId, count) {
  for (let i = 0; i < count; i += 1) {
    store.auditEvent(sessionId, {
      id: `act_${i}`,
      timestamp: at(i),
      completedAt: at(i),
      source: 'actions',
      action: 'my_tool',
      status: 'completed',
      durationMs: 1,
      workspace: '',
      session: sessionId,
      args: {},
      result: { ok: true },
    });
  }
}

/**
 * Logs 屏重构前的原表达式（src/tui/screens/Logs.tsx:92-95 的逐字复刻）。
 * 这是"现状真相"的可执行定义，重构后不得改动它。
 */
function legacyLogsAudit(store, { page, pageSize, anchorAt }) {
  const audit = store.auditFacts(5000).filter((fact) => !anchorAt || fact.at <= anchorAt);
  const end = Math.max(0, audit.length - page * pageSize);
  const start = Math.max(0, end - pageSize);
  return audit.slice(start, end);
}

const ids = (facts) => facts.map((fact) => fact.id);

// ─── L1: 现状语义（手算期望，重构前后都绿） ──────────────────────────────────

test('L1: Logs 屏审计数据源语义 = 「anchorAt 截断后，从最新往回翻第 N 页」', () => {
  const root = tempRoot();
  try {
    const { store, sessionId } = setup(root);
    seedFacts(store, sessionId, 7); // act_0 .. act_6，时间递增

    // 无 anchor：7 条、每页 3 条 → 页 0 是最新 3 条，往回递推，页 3 越界为空
    assert.deepEqual(ids(legacyLogsAudit(store, { page: 0, pageSize: 3 })), ['act_4', 'act_5', 'act_6']);
    assert.deepEqual(ids(legacyLogsAudit(store, { page: 1, pageSize: 3 })), ['act_1', 'act_2', 'act_3']);
    assert.deepEqual(ids(legacyLogsAudit(store, { page: 2, pageSize: 3 })), ['act_0'], '最后一页不足整页');
    assert.deepEqual(ids(legacyLogsAudit(store, { page: 3, pageSize: 3 })), [], '越界页为空');

    // anchorAt 截断：只保留 at <= anchor 的事实（act_0..act_4），再翻页
    const anchorAt = at(4);
    assert.deepEqual(ids(legacyLogsAudit(store, { page: 0, pageSize: 3, anchorAt })), ['act_2', 'act_3', 'act_4']);
    assert.deepEqual(ids(legacyLogsAudit(store, { page: 1, pageSize: 3, anchorAt })), ['act_0', 'act_1']);
    assert.deepEqual(ids(legacyLogsAudit(store, { page: 2, pageSize: 3, anchorAt })), []);
  } finally {
    cleanup(root);
  }
});

// ─── L2: 新 seam 与现状表达式逐条等价 ────────────────────────────────────────

test('L2: store.auditRecentFactsPage 与 Logs 屏原表达式逐条等价（page × anchorAt 矩阵）', () => {
  const root = tempRoot();
  try {
    const { store, sessionId } = setup(root);
    seedFacts(store, sessionId, 7);

    const anchors = [undefined, at(4), at(0), '2026-07-30T06:00:00.000Z'];
    for (const anchorAt of anchors) {
      for (const pageSize of [1, 3, 100]) {
        for (const page of [0, 1, 2, 3, 9]) {
          const expected = legacyLogsAudit(store, { page, pageSize, anchorAt });
          const actual = store.auditRecentFactsPage(page, pageSize, anchorAt).facts;
          assert.deepEqual(
            actual,
            expected,
            `page=${page} pageSize=${pageSize} anchorAt=${anchorAt} 输出必须与现状逐字段一致`,
          );
        }
      }
    }
  } finally {
    cleanup(root);
  }
});

// ─── L3: 分页信封语义 ────────────────────────────────────────────────────────

test('L3: 分页信封 total/offset/nextOffset（total 为 anchor 截断后的条数）', () => {
  const root = tempRoot();
  try {
    const { store, sessionId } = setup(root);
    seedFacts(store, sessionId, 7);

    const first = store.auditRecentFactsPage(0, 3);
    assert.equal(first.total, 7, 'total = 可见事实总数');
    assert.equal(first.offset, 4, 'offset = 本页在事实流中的起点');
    assert.equal(first.nextOffset, 1, 'nextOffset 指向下一页（更旧一页）的起点');

    const last = store.auditRecentFactsPage(2, 3);
    assert.equal(last.offset, 0);
    assert.equal(last.nextOffset, undefined, '已到最旧一页则无 nextOffset');

    const anchored = store.auditRecentFactsPage(0, 3, at(4));
    assert.equal(anchored.total, 5, 'anchor 截断后 total 只算 at <= anchor 的事实');

    const beyond = store.auditRecentFactsPage(9, 3);
    assert.deepEqual(beyond.facts, [], '越界页为空且不抛错');
    assert.equal(beyond.offset, 0);
  } finally {
    cleanup(root);
  }
});

// ─── L4: 5000 条窗口上限语义保留（fake io，零文件系统） ───────────────────────

test('L4: 保留 facts(5000) 的窗口上限——只看最新 5000 条，再按 anchor 截断', async () => {
  const { AuditLog } = await import('../dist/audit-log.js');

  const session = { id: 's1', name: 'fake' };
  const total = 5100;
  const history = [];
  for (let i = 0; i < total; i += 1) {
    const stamp = new Date(Date.UTC(2026, 6, 30, 0, 0, 0) + i * 1000).toISOString();
    history.push({ at: stamp, type: 'tool_audit', data: { id: `f_${i}`, timestamp: stamp, action: 'my_tool', status: 'completed', durationMs: 1, source: 'actions', workspace: '', session: 's1' } });
  }
  const io = {
    appendToolAudit: () => {},
    readRecentHistory: () => history,
    listSessions: () => [session],
    requireSession: () => session,
  };
  const log = new AuditLog(io);

  // 现状真相：facts(5000) 只返回最新 5000 条（f_100 .. f_5099）
  const windowed = log.facts(5000);
  assert.equal(windowed.length, 5000);
  assert.equal(windowed[0].id, 'f_100', '窗口从第 101 条事实开始');

  const page = log.recentFactsPage(0, 100);
  assert.equal(page.total, 5000, 'total 受 5000 窗口上限约束，不是 5100');
  assert.deepEqual(page.facts.map((f) => f.id), windowed.slice(-100).map((f) => f.id));

  // 窗口外的事实不可达：第 50 页（0-indexed）已越过 5000 条
  assert.deepEqual(log.recentFactsPage(50, 100).facts, [], '窗口耗尽后为空，与现状一致');
});
