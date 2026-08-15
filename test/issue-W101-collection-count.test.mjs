// ADR-0051 W1-01 (#74)：find_files / search_text L1 主动精简 reducer（0050 A1）
//
// 验收断言：
//   AC1  TOOL_SHAPES 注册 find_files / search_text → { reduce }（补遗3 权威矩阵主动精简）
//   AC2  成功态：matches 保留 + count === matches.length；非截断无 totalCount；totalMatches 不泄漏（D17）
//   AC3  截断态（truncated:true 且 totalMatches 已知）：totalCount === 真实总量（D16.2）
//   AC4  截断态总量未知（search_text timedOut 场景）：只附 count，不伪造 totalCount（D11）
//   AC5  结构不符（无 matches 数组）→ fail-open 原样返回，不抛错
//   AC6  D17 静默：结果内无任何层标记（递归扫描，复用 assertNoShapingMarkers 手法）
//   AC7  运行时探测：actions 通道真实调用 find_files（临时工作区 150 文件触发截断）断言 count/totalCount
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
    sessionId: 's-w101',
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

test('W1-01-AC1: TOOL_SHAPES 注册 find_files / search_text（补遗3 主动精简）', () => {
  assert.ok(TOOL_SHAPES.has('find_files'), 'find_files 应注册');
  assert.ok(TOOL_SHAPES.has('search_text'), 'search_text 应注册');
  assert.equal(typeof TOOL_SHAPES.get('find_files').reduce, 'function', 'find_files 应有 L1 reducer');
  assert.equal(typeof TOOL_SHAPES.get('search_text').reduce, 'function', 'search_text 应有 L1 reducer');
});

test('W1-01-AC2: 成功态 — matches 保留 + count === matches.length；非截断无 totalCount；totalMatches 剥除', async () => {
  const { ctx: c } = makeCtx();
  const find = await shapeToolResponse(makeResponse('find_files', { matches: ['a.txt', 'b.txt', 'c.txt'], truncated: false, totalMatches: 3 }), c);
  assert.deepEqual(find.data.result.matches, ['a.txt', 'b.txt', 'c.txt'], 'matches 原样保留');
  assert.equal(find.data.result.count, 3, 'count === matches.length');
  assert.equal(find.data.result.truncated, false);
  assert.equal('totalCount' in find.data.result, false, '非截断无 totalCount');
  assert.equal('totalMatches' in find.data.result, false, 'totalMatches 不泄漏进结果（D17）');

  const search = await shapeToolResponse(makeResponse('search_text', {
    matches: [{ path: 'a.txt', line: 1, text: 'x' }, { path: 'b.txt', line: 2, text: 'y' }],
    truncated: false,
  }), c);
  assert.equal(search.data.result.matches.length, 2, 'search_text matches 原样保留');
  assert.equal(search.data.result.count, 2, 'count === matches.length');
  assert.equal('totalCount' in search.data.result, false, '非截断无 totalCount');
});

test('W1-01-AC3: 截断态（truncated:true 且总量已知）— totalCount === 真实总量', async () => {
  const { ctx: c } = makeCtx();
  const matches = Array.from({ length: 100 }, (_, i) => `f-${i}.txt`);
  const shaped = await shapeToolResponse(makeResponse('find_files', { matches, truncated: true, totalMatches: 150 }), c);

  assert.equal(shaped.data.result.matches.length, 100, 'matches 原样保留');
  assert.equal(shaped.data.result.count, 100, 'count === 本页实际长度');
  assert.equal(shaped.data.result.totalCount, 150, 'totalCount === 真实总量（D16.2）');
  assert.equal(shaped.data.result.truncated, true, 'truncated 保留');
  assert.equal('totalMatches' in shaped.data.result, false, 'totalMatches 剥除、统一 totalCount（D17）');
});

test('W1-01-AC4: 截断态总量未知（search_text timedOut）— 只附 count，不伪造 totalCount', async () => {
  const { ctx: c } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('search_text', {
    matches: [{ path: 'a.txt', line: 1, text: 'hit' }, { path: 'b.txt', line: 3, text: 'hit' }],
    truncated: true, // timedOut 触发：真实总量未知，handler 无 totalMatches
  }), c);

  assert.equal(shaped.data.result.count, 2);
  assert.equal(shaped.data.result.truncated, true);
  assert.equal('totalCount' in shaped.data.result, false, '总量未知绝不伪造 totalCount（D11）');
  assert.equal('totalMatches' in shaped.data.result, false);
});

test('W1-01-AC5: 结构不符（无 matches 数组）→ fail-open 原样返回，不抛错', async () => {
  const { ctx: c, getRecord } = makeCtx();
  const raw = { path: '.', truncated: false };
  const shaped = await shapeToolResponse(makeResponse('find_files', raw), c);
  assert.deepEqual(shaped.data.result, raw, '结构不符原样返回');
  assert.equal(getRecord().shaping.applied, true, 'L1 路径执行（reducer fail-open 不抛）');
});

test('W1-01-AC6: D17 静默 — 结果内无任何层标记（递归扫描）', async () => {
  const { ctx: c } = makeCtx();
  const matches = Array.from({ length: 100 }, (_, i) => `f-${i}.txt`);
  const truncated = await shapeToolResponse(makeResponse('find_files', { matches, truncated: true, totalMatches: 150 }), c);
  assertNoShapingMarkers(truncated);

  const success = await shapeToolResponse(makeResponse('search_text', {
    matches: [{ path: 'a.txt', line: 1, text: 'hit' }],
    truncated: false,
  }), c);
  assertNoShapingMarkers(success);
});

// ── 运行时探测（AC7）：actions 通道真实调用 ─────────────────────────────────────

const CONNECTOR_KEY = 'w101-connector-key-123456';
const ACTIONS_TOKEN = 'w101-actions-token-1234567890123456';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-w101-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  // 150 个匹配文件（> 默认 limit 100）触发截断；unrelated 不匹配 query
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(workspaceDir, `probe-${String(i).padStart(3, '0')}.txt`), 'x');
  fs.writeFileSync(path.join(workspaceDir, 'unrelated.txt'), 'x');
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

async function root(server, name = 'w101-main') {
  const reg = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  return reg.body.data.result.identity;
}

test('W1-01-AC7: 运行时探测 — actions 通道真实调用 find_files 截断态 count/totalCount', async () => {
  const server = await createRuntime();
  try {
    const identity = await root(server);
    const resp = await call(server, 'find_files', { query: 'probe' }, identity);
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    assert.equal(resp.body.ok, true, JSON.stringify(resp.body));

    const result = resp.body.data.result;
    assert.equal(result.matches.length, 100, '默认 limit 100 帽');
    assert.equal(result.count, 100, 'count === matches.length');
    assert.equal(result.truncated, true, '截断态');
    assert.equal(result.totalCount, 150, 'totalCount === 真实总量（150 个匹配文件）');
    assert.equal('totalMatches' in result, false, 'totalMatches 剥除（D17）');
    assertNoShapingMarkers(result);
  } finally {
    await server.close();
  }
});
