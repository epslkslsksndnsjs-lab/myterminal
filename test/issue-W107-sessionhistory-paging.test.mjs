// ADR-0051 W1-07 (#80)：session_history 分页 + count/totalCount/truncated（0050 D1/D2）
//
// 验收断言：
//   AC1  count === entries.length；totalCount === history.total（D16.1/16.2）；全页（未截断）
//        truncated === false、不发射 pagination continuation
//   AC2  entries 被截断（offset+limit < total）：truncated === true + pagination{nextCall} 产出
//        → L2 发射 data.continuation.pagination（D15.2/③ 可恢复翻页）
//   AC3  nextCall 复用 history.nextOffset 语义（第二页 offset 取 nextOffset，不丢数据）
//   AC4  末页（offset+entries === total）：truncated === false、无 continuation
//   AC5  嵌套 ToolResponse 摘要化（T08 行为）不回归，与新字段共存
//   AC6  结构不符（无 history / entries 非数组）→ fail-open 原样，不注入计数/分页字段，不抛错
//   AC7  D17 静默：结果内无 pagination / __reduction / 任何层标记（递归扫描）
//   AC8  审计精简详情：entriesTruncated === 分页省略的真实条数
//   AC9  运行时探测：actions 造 >1 页审计历史后调 session_history 断言分页字段 + 第二页不丢数据
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js，遵循 issue-31 seam）；
// 运行时探测走 MyTerminalRuntime actions 通道（遵循 myterminal.test.mjs 手法）。
// 注：任何 src 改动后必须先 bun run build 再跑测试（测试全部从 dist 导入，历史教训见 #43）。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shapeToolResponse } from '../dist/tool-parse.js';
import { MyTerminalRuntime } from '../dist/server.js';

// D17 静默契约：任何层都不插自标识标记（复用 issue-31 手法）
const MARKER_KEYS = ['_shapedBy', '_l1Applied', '_l2Applied', '_l3Applied'];

function assertNoShapingMarkers(value, at = 'root') {
  if (Array.isArray(value)) { for (const item of value) assertNoShapingMarkers(item, `${at}[]`); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assertNoShapingMarkers(item, `${at}.${key}`);
  }
}

const HUGE = 'y'.repeat(100_000); // 100KB 噪声串，模拟嵌套爆炸的单条体量

/** 构造 session_history 响应；entries 已是 handler 切片后的页（store.historyPage 语义）。 */
function makeResponse(entries, { total, offset = 0, nextOffset } = {}) {
  const realTotal = typeof total === 'number' ? total : entries.length;
  const history = { total: realTotal, offset };
  if (nextOffset !== undefined) history.nextOffset = nextOffset;
  history.entries = entries;
  return { ok: true, data: { tool: 'session_history', result: { history } } };
}

/** 普通 state event 条目（无嵌套 result）。 */
function historyEntry(i) {
  return { sessionId: 's-x', sessionName: 'n', at: `2026-08-10T00:00:${String(i).padStart(2, '0')}Z`, type: 'state_event', data: { id: `e-${i}` } };
}

/** 带完整嵌套 ToolResponse 的 tool_audit 条目（T08 摘要对象）。 */
function auditEntry(tool, ok, innerResult) {
  return {
    sessionId: 's-x',
    sessionName: 'n',
    at: '2026-08-10T00:00:00Z',
    type: 'tool_audit',
    data: { id: 'a', tool, ok, result: { ok, data: { tool, result: innerResult } } },
  };
}

function makeCtx() {
  let lastRecord;
  const ctx = {
    transport: 'actions',
    sessionId: 's-w107',
    resolveTool: () => undefined,
    audit: (r) => { lastRecord = r; },
  };
  return { ctx, getRecord: () => lastRecord };
}

test('W1-07-AC1: 全页（未截断）— count/totalCount/truncated:false，不发射 continuation', async () => {
  const { ctx: c } = makeCtx();
  const entries = Array.from({ length: 3 }, (_, i) => historyEntry(i));
  const shaped = await shapeToolResponse(makeResponse(entries, { total: 3 }), c);

  assert.equal(shaped.data.result.history.entries.length, 3);
  assert.equal(shaped.data.result.count, 3, 'count === entries.length（D16.1）');
  assert.equal(shaped.data.result.totalCount, 3, 'totalCount === history.total（D16.2）');
  assert.equal(shaped.data.result.truncated, false);
  assert.equal(shaped.data.continuation, undefined, '未截断不发射 pagination continuation');
});

test('W1-07-AC2: 截断页 — truncated:true + pagination{nextCall} → data.continuation.pagination', async () => {
  const { ctx: c } = makeCtx();
  const entries = Array.from({ length: 5 }, (_, i) => historyEntry(i));
  const shaped = await shapeToolResponse(makeResponse(entries, { total: 12, nextOffset: 5 }), c);

  assert.equal(shaped.data.result.count, 5);
  assert.equal(shaped.data.result.totalCount, 12, 'totalCount 为真实总量（跨页累计）');
  assert.equal(shaped.data.result.truncated, true);

  const cont = shaped.data.continuation;
  assert.ok(cont && cont.pagination, '应发射 data.continuation.pagination');
  assert.equal(cont.pagination.truncated, true);
  assert.equal(cont.pagination.nextCall.tool, 'session_history');
  assert.deepEqual(cont.pagination.nextCall.input, { offset: 5, limit: 5 }, 'nextCall 指向下一页');
  assert.equal(cont.pagination.nextCall.purpose, 'fetch next page of session history');

  // D17：内部提示不留在 data.result
  assert.equal('pagination' in shaped.data.result, false, 'data.result 不得含 pagination');
  assert.equal('__reduction' in shaped.data.result, false, 'data.result 不得含 __reduction');
});

test('W1-07-AC3: nextCall 复用 history.nextOffset 语义（第二页可恢复翻页）', async () => {
  const { ctx: c } = makeCtx();
  const entries = Array.from({ length: 5 }, (_, i) => historyEntry(i + 5));
  const shaped = await shapeToolResponse(makeResponse(entries, { total: 12, offset: 5, nextOffset: 10 }), c);

  assert.equal(shaped.data.result.count, 5);
  assert.equal(shaped.data.result.totalCount, 12);
  assert.equal(shaped.data.result.truncated, true);
  const nextCall = shaped.data.continuation.pagination.nextCall;
  assert.equal(nextCall.input.offset, 10, 'offset 取 history.nextOffset（不重算、不丢数据）');
  assert.equal(nextCall.input.limit, 5);
});

test('W1-07-AC4: 末页 — truncated:false、无 continuation', async () => {
  const { ctx: c } = makeCtx();
  const entries = Array.from({ length: 2 }, (_, i) => historyEntry(i + 10));
  const shaped = await shapeToolResponse(makeResponse(entries, { total: 12, offset: 10 }), c);

  assert.equal(shaped.data.result.count, 2);
  assert.equal(shaped.data.result.totalCount, 12, '末页 totalCount 仍为真实总量');
  assert.equal(shaped.data.result.truncated, false);
  assert.equal(shaped.data.continuation, undefined, '末页不发射 pagination');
});

test('W1-07-AC5: T08 嵌套摘要不回归，与新字段共存', async () => {
  const { ctx: c } = makeCtx();
  const big = auditEntry('read_file', true, { session: { id: 's', name: HUGE, log: HUGE } });
  const shaped = await shapeToolResponse(makeResponse([big, historyEntry(1)], { total: 2 }), c);

  // 摘要化仍生效（爆炸消除）
  const summary = shaped.data.result.history.entries[0].data.result;
  assert.equal(summary.tool, 'read_file', '嵌套 ToolResponse 仍被摘要化');
  assert.ok(!JSON.stringify(shaped.data.result.history).includes(HUGE), '摘要后不得再含完整嵌套 result');

  // 新字段共存
  assert.equal(shaped.data.result.count, 2);
  assert.equal(shaped.data.result.totalCount, 2);
  assert.equal(shaped.data.result.truncated, false);
});

test('W1-07-AC6: 结构不符 → fail-open 原样，不注入计数/分页字段，不抛错', async () => {
  const { ctx: c, getRecord } = makeCtx();
  // 缺 history
  const r1 = await shapeToolResponse({ ok: true, data: { tool: 'session_history', result: { total: 0, entries: [] } } }, c);
  assert.equal('history' in r1.data.result, false, '无 history 时结构原样（不注入）');
  assert.equal(getRecord().shaping.applied, true);

  // entries 非数组：原样保全，不注入 count/totalCount/truncated
  const r2 = await shapeToolResponse(makeResponse(null, { total: 0 }), c);
  assert.equal(r2.data.result.history.entries, null, '非数组 entries 原样');
  assert.equal('count' in r2.data.result, false, '畸形不注入 count');
  assert.equal('totalCount' in r2.data.result, false, '畸形不注入 totalCount');
  assert.equal('truncated' in r2.data.result, false, '畸形不注入 truncated');
  assert.equal(r2.data.continuation, undefined, '畸形不发射 pagination');
});

test('W1-07-AC7: D17 静默 — 结果内无任何层标记（递归扫描）', async () => {
  const { ctx: c } = makeCtx();
  const entries = Array.from({ length: 5 }, (_, i) => historyEntry(i));
  const shaped = await shapeToolResponse(makeResponse(entries, { total: 12, nextOffset: 5 }), c);
  assertNoShapingMarkers(shaped);
});

test('W1-07-AC8: 审计精简详情 — entriesTruncated === 分页省略的真实条数', async () => {
  const { ctx: c, getRecord } = makeCtx();
  const entries = Array.from({ length: 5 }, (_, i) => historyEntry(i));
  await shapeToolResponse(makeResponse(entries, { total: 12, nextOffset: 5 }), c);

  const rec = getRecord();
  assert.equal(rec.shaping.applied, true);
  assert.equal(rec.shaping.reduced, true);
  assert.equal(rec.shaping.entriesTruncated, 7, '12 - 5 = 7 条被分页省略');
  assert.ok(typeof rec.shaping.originalSize === 'number' && rec.shaping.originalSize > 0);
  assert.ok(typeof rec.shaping.reducedSize === 'number');
  assert.ok(rec.shaping.originalSize >= rec.shaping.reducedSize);
});

// ── 运行时探测（AC9）：actions 通道真实调用 ─────────────────────────────────────

const CONNECTOR_KEY = 'w107-connector-key-123456';
const ACTIONS_TOKEN = 'w107-actions-token-1234567890123456';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-w107-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'hello myterminal\n');
  return { workspaceDir, stateDir };
}

async function createRuntime(overrides = {}) {
  const dirs = tempWorkspace();
  const runtime = new MyTerminalRuntime({
    ...dirs,
    settingsPath: path.join(dirs.stateDir, 'test-settings.json'),
    host: '127.0.0.1', port: 0,
    connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN,
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 20_000, commandTimeoutSec: 10,
    uiLanguage: 'zh-CN', uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    ...overrides,
  });
  await runtime.start();
  return {
    runtime, dirs,
    baseUrl: `http://127.0.0.1:${runtime.port}`,
    async close() { await runtime.close(); fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); },
  };
}

function actionsHeaders() { return { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' }; }

async function action(server, endpoint, body) {
  const response = await fetch(`${server.baseUrl}/actions/extensions/${endpoint}`, { method: 'POST', headers: actionsHeaders(), body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function call(server, tool, input = {}, identity) { return action(server, 'call', { tool, input, ...(identity ? { identity } : {}) }); }

async function root(server, name = 'w107-main') {
  const reg = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  return reg.body.data.result.identity;
}

test('W1-07-AC9: 运行时探测 — actions 造 >1 页审计历史后 session_history 断言分页字段', async () => {
  const server = await createRuntime();
  try {
    const identity = await root(server);
    // 8 次 session_tag：每次追加 tags_updated + tool_audit 条目 → 总量远超 limit 5 一页
    for (let i = 0; i < 8; i++) {
      const tag = await call(server, 'session_tag', { tags: [`w107-${i}`] }, identity);
      assert.equal(tag.body.ok, true, JSON.stringify(tag.body));
    }

    const hist = await call(server, 'session_history', { limit: 5 }, identity);
    assert.equal(hist.status, 200, JSON.stringify(hist.body));
    assert.equal(hist.body.ok, true, JSON.stringify(hist.body));
    const result = hist.body.data.result;

    assert.equal(result.history.entries.length, 5, '一页 5 条');
    assert.equal(result.count, 5, 'count === entries.length');
    assert.ok(typeof result.totalCount === 'number' && result.totalCount > 5, 'totalCount 为真实总量（> 一页）');
    assert.equal(result.truncated, true, '截断态');

    const cont = hist.body.data.continuation;
    assert.ok(cont && cont.pagination, 'e2e：响应 data.continuation.pagination 存在');
    assert.equal(cont.pagination.truncated, true);
    assert.equal(cont.pagination.nextCall.tool, 'session_history');
    assert.equal(cont.pagination.nextCall.input.offset, 5, 'nextCall 复用 nextOffset');
    assert.equal(cont.pagination.nextCall.input.limit, 5);
    assertNoShapingMarkers(hist.body);

    // 恢复翻页验证：拿 nextCall 翻第二页，数据不丢
    const page2 = await call(server, 'session_history', { offset: 5, limit: 5 }, identity);
    assert.equal(page2.body.ok, true, JSON.stringify(page2.body));
    assert.equal(page2.body.data.result.history.entries.length, 5, '第二页有数据（不丢）');
    assert.equal(page2.body.data.result.count, 5);
    assert.ok(page2.body.data.result.totalCount >= result.totalCount, 'totalCount 只增不减（history 永久 append-only，探测调用自身也在追加审计条目）');
  } finally {
    await server.close();
  }
});
