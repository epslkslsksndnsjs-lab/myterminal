// ADR-0051 W1-03 (#76)：list_dir count/totalCount + 截断分页 reducer（0050 A3）
//
// 验收断言：
//   AC1  TOOL_SHAPES 注册 list_dir → { reduce }（0050 矩阵：截断 + count + 分页）
//   AC2  成功态：entries 保留 + count === entries.length；非截断无 totalCount；
//        handler 内部上报字段（total/page）剥除（D17 静默）
//   AC3  截断态（truncated:true）：totalCount === 真实总量（D16.2）；entries ≤500 帽保持
//   AC4  截断态分页：响应 data.continuation.pagination 发射（含 nextCall：tool+offset+limit），
//        模型可翻页取全量（D15）
//   AC5  结构不符（无 entries 数组）→ fail-open 原样返回，不抛错（D11）
//   AC6  D17 静默：结果内无任何层标记（递归扫描，复用 issue-31 手法）
//   AC7  运行时探测：actions 通道真实调用 list_dir（临时目录造 >500 条目）断言
//        count/totalCount/truncated/continuation；跟 nextCall 翻第二页取全量
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js，遵循 issue-31 seam）；
// 运行时探测走 MyTerminalRuntime actions 通道（../dist/server.js，遵循 myterminal.test.mjs 手法）。
// 注：任何 src 改动后必须先 bun run build 再跑测试（测试全部从 dist 导入，历史教训见 #43）。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
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

function makeResponse(tool, result) {
  return { ok: true, data: { tool, result } };
}

function makeCtx() {
  let record;
  const ctx = {
    transport: 'actions',
    sessionId: 's-w103',
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

/** handler 原生返回形态（core-tools.ts list_dir，W1-03 起：切片 + 上报 total/page）。 */
function rawListDir({ entries, total, offset = 0, limit = 500 }) {
  return { path: '.', entries, total, page: { offset, limit }, truncated: total > offset + entries.length };
}

test('W1-03-AC1: TOOL_SHAPES 注册 list_dir（0050 矩阵：截断 + count + 分页）', () => {
  assert.ok(TOOL_SHAPES.has('list_dir'), 'list_dir 应注册');
  assert.equal(typeof TOOL_SHAPES.get('list_dir').reduce, 'function', 'list_dir 应有 L1 reducer');
});

test('W1-03-AC2: 成功态 — entries 保留 + count === entries.length；非截断无 totalCount；total/page 剥除', async () => {
  const { ctx: c } = makeCtx();
  const entries = [
    { name: 'a.txt', type: 'file' },
    { name: 'b.txt', type: 'file' },
    { name: 'src', type: 'directory' },
  ];
  const shaped = await shapeToolResponse(makeResponse('list_dir', rawListDir({ entries, total: 3 })), c);

  assert.deepEqual(shaped.data.result.entries, entries, 'entries 原样保留');
  assert.equal(shaped.data.result.count, 3, 'count === entries.length');
  assert.equal(shaped.data.result.truncated, false);
  assert.equal('totalCount' in shaped.data.result, false, '非截断无 totalCount');
  assert.equal('total' in shaped.data.result, false, 'total 不泄漏进结果（D17）');
  assert.equal('page' in shaped.data.result, false, 'page 不泄漏进结果（D17）');
  assert.equal(shaped.data.continuation, undefined, '非截断无 continuation');
});

test('W1-03-AC3: 截断态（truncated:true）— totalCount === 真实总量；500 帽保持', async () => {
  const { ctx: c } = makeCtx();
  const entries = Array.from({ length: 500 }, (_, i) => ({ name: `f-${String(i).padStart(3, '0')}.txt`, type: 'file' }));
  const shaped = await shapeToolResponse(makeResponse('list_dir', rawListDir({ entries, total: 510 })), c);

  assert.equal(shaped.data.result.entries.length, 500, 'entries ≤500 帽保持');
  assert.equal(shaped.data.result.count, 500, 'count === 本页实际长度');
  assert.equal(shaped.data.result.totalCount, 510, 'totalCount === 真实总量（D16.2）');
  assert.equal(shaped.data.result.truncated, true, 'truncated 保留');
  assert.equal('total' in shaped.data.result, false, 'total 剥除、统一 totalCount（D17）');
  assert.equal('page' in shaped.data.result, false, 'page 剥除（D17）');
});

test('W1-03-AC4: 截断态分页 — data.continuation.pagination 发射（含 nextCall），模型可翻页', async () => {
  const { ctx: c } = makeCtx();
  const entries = Array.from({ length: 500 }, (_, i) => ({ name: `f-${String(i).padStart(3, '0')}.txt`, type: 'file' }));
  const shaped = await shapeToolResponse(makeResponse('list_dir', rawListDir({ entries, total: 510 })), c);

  const pagination = shaped.data.continuation.pagination;
  assert.ok(pagination, '截断态应发射 data.continuation.pagination（D15）');
  assert.equal(pagination.truncated, true);
  assert.equal(pagination.nextCall.tool, 'list_dir', 'nextCall 指向 list_dir');
  assert.deepEqual(pagination.nextCall.input, { path: '.', offset: 500, limit: 500 }, 'nextCall 带 path + offset + limit，可翻页取全量');
  assert.equal(typeof pagination.nextCall.purpose, 'string');

  // 翻页续调：offset+limit 后非截断 → 无分页提示
  const page2 = await shapeToolResponse(makeResponse('list_dir', rawListDir({ entries: entries.slice(0, 10), total: 510, offset: 500 })), c);
  assert.equal(page2.data.result.count, 10);
  assert.equal(page2.data.result.truncated, false);
  assert.equal(page2.data.continuation, undefined, '末页无 continuation');
});

test('W1-03-AC5: 结构不符（无 entries 数组）→ fail-open 原样返回，不抛错', async () => {
  const { ctx: c, getRecord } = makeCtx();
  const raw = { path: '.', truncated: false };
  const shaped = await shapeToolResponse(makeResponse('list_dir', raw), c);
  assert.deepEqual(shaped.data.result, raw, '结构不符原样返回');
  assert.equal(getRecord().shaping.applied, true, 'L1 路径执行（reducer fail-open 不抛）');
});

test('W1-03-AC6: D17 静默 — 结果内无任何层标记（递归扫描）', async () => {
  const { ctx: c } = makeCtx();
  const entries = Array.from({ length: 500 }, (_, i) => ({ name: `f-${String(i).padStart(3, '0')}.txt`, type: 'file' }));
  const truncated = await shapeToolResponse(makeResponse('list_dir', rawListDir({ entries, total: 510 })), c);
  assertNoShapingMarkers(truncated);

  const success = await shapeToolResponse(makeResponse('list_dir', rawListDir({ entries: entries.slice(0, 3), total: 3 })), c);
  assertNoShapingMarkers(success);
});

// ── 运行时探测（AC7）：actions 通道真实调用 ─────────────────────────────────────

const CONNECTOR_KEY = 'w103-connector-key-123456';
const ACTIONS_TOKEN = 'w103-actions-token-1234567890123456';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-w103-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  // 510 个条目（> 500 帽）触发截断；放独立子目录 probe-dir，与运行时可能在根目录产生的
  // 任何文件隔离，entries 计数确定（IGNORE_DIRECTORIES 含 .myterminal，状态目录不算）
  const probeDir = path.join(workspaceDir, 'probe-dir');
  fs.mkdirSync(probeDir);
  for (let i = 0; i < 510; i++) fs.writeFileSync(path.join(probeDir, `probe-${String(i).padStart(3, '0')}.txt`), 'x');
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

async function root(server, name = 'w103-main') {
  const reg = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  return reg.body.data.result.identity;
}

test('W1-03-AC7: 运行时探测 — actions 真实调用 list_dir >500 条目截断 + 翻页取全量', async () => {
  const server = await createRuntime();
  try {
    const identity = await root(server);

    // 第一页：500 帽 + 截断态 + 真实总量 + 分页提示
    const page1 = await call(server, 'list_dir', { path: 'probe-dir' }, identity);
    assert.equal(page1.status, 200, JSON.stringify(page1.body));
    assert.equal(page1.body.ok, true, JSON.stringify(page1.body));

    const r1 = page1.body.data.result;
    assert.equal(r1.entries.length, 500, '500 帽保持');
    assert.equal(r1.count, 500, 'count === entries.length');
    assert.equal(r1.truncated, true, '截断态');
    assert.equal(r1.totalCount, 510, 'totalCount === 真实总量（510 个条目）');
    assert.equal('total' in r1, false, 'total 剥除（D17）');
    assert.equal('page' in r1, false, 'page 剥除（D17）');
    assertNoShapingMarkers(r1);

    const pagination = page1.body.data.continuation.pagination;
    assert.ok(pagination, '截断态应发射 data.continuation.pagination');
    assert.equal(pagination.truncated, true);
    assert.equal(pagination.nextCall.tool, 'list_dir');
    assert.deepEqual(pagination.nextCall.input, { path: 'probe-dir', offset: 500, limit: 500 }, 'nextCall 带 path + offset + limit');

    // 第二页：跟 nextCall 翻页 → 余下 10 条，非截断、无 totalCount、无 continuation
    const page2 = await call(server, 'list_dir', pagination.nextCall.input, identity);
    assert.equal(page2.status, 200, JSON.stringify(page2.body));
    assert.equal(page2.body.ok, true, JSON.stringify(page2.body));

    const r2 = page2.body.data.result;
    assert.equal(r2.entries.length, 10, '余下 10 条');
    assert.equal(r2.count, 10, 'count === entries.length');
    assert.equal(r2.truncated, false, '末页非截断');
    assert.equal('totalCount' in r2, false, '末页无 totalCount');
    assert.equal(page2.body.data.continuation, undefined, '末页无 continuation');
    assertNoShapingMarkers(r2);

    // 两页并集 = 全量（模型可翻页取全量）
    const names = new Set([...r1.entries, ...r2.entries].map((e) => e.name));
    assert.equal(names.size, 510, '两页并集 = 全量 510');
  } finally {
    await server.close();
  }
});
