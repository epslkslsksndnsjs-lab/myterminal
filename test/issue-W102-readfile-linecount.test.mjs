// ADR-0051 W1-02 (#75)：read_file 派生 lineCount reducer（0050 A2）
//
// 验收断言：
//   AC1  TOOL_SHAPES 注册 read_file → { reduce }（补遗3 权威矩阵 read_file 加 lineCount）
//   AC2  lineCount === content 行数（空文件=0、无尾换行=1、N 行=N 的用例）
//   AC3  bytes / sha256 原样保留；不出现 totalBytes 之类发明字段（票面命名约束）
//   AC4  结构不符（无 content 字符串）→ fail-open 原样返回，不抛错（D11）
//   AC5  D17 静默：结果内无任何层标记（递归扫描，复用 assertNoShapingMarkers 手法）
//   AC6  运行时探测：actions 通道真实调用 read_file 断言 lineCount 与 bytes 正确
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
    sessionId: 's-w102',
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

test('W1-02-AC1: TOOL_SHAPES 注册 read_file（补遗3 矩阵 read_file 加 lineCount）', () => {
  assert.ok(TOOL_SHAPES.has('read_file'), 'read_file 应注册');
  assert.equal(typeof TOOL_SHAPES.get('read_file').reduce, 'function', 'read_file 应有 L1 reducer');
});

test('W1-02-AC2: lineCount === content 行数（空=0、无尾换行=1、N 行=N）', async () => {
  const { ctx: c } = makeCtx();
  const cases = [
    ['', 0],            // 空文件 = 0
    ['only-one-line', 1], // 无尾换行 = 1
    ['a\nb\nc', 3],     // N 行（无尾换行）
    ['a\nb\nc\n', 3],   // N 行（带尾换行，不产生额外空行）
    ['a\r\nb\r\nc', 3], // CRLF 兼容
    ['\n', 1],          // 单个空行
  ];
  for (const [content, expected] of cases) {
    const shaped = await shapeToolResponse(makeResponse('read_file', { path: 'f.txt', content, sha256: 'deadbeef', bytes: 7 }), c);
    assert.equal(shaped.data.result.lineCount, expected, `content=${JSON.stringify(content)} 应得 ${expected} 行`);
  }
});

test('W1-02-AC3: bytes / sha256 原样保留；不出现 totalBytes 之类发明字段', async () => {
  const { ctx: c } = makeCtx();
  const raw = { path: 'a.txt', content: 'x\ny\n', sha256: 'deadbeef', bytes: 4, truncated: false };
  const shaped = await shapeToolResponse(makeResponse('read_file', raw), c);
  assert.equal(shaped.data.result.sha256, 'deadbeef', 'sha256 原样保留');
  assert.equal(shaped.data.result.bytes, 4, 'bytes 原样保留');
  assert.equal(shaped.data.result.path, 'a.txt', 'path 原样保留');
  assert.equal(shaped.data.result.truncated, false, 'truncated 原样保留');
  assert.equal('totalBytes' in shaped.data.result, false, '不得发明 totalBytes');
  assert.equal('byteCount' in shaped.data.result, false, '不得发明 byteCount');
  assert.equal('lineCount' in raw, false, 'reducer 不应原地污染入参（不可变派生）');
});

test('W1-02-AC4: 结构不符（无 content 字符串）→ fail-open 原样返回，不抛错', async () => {
  const { ctx: c, getRecord } = makeCtx();
  const raw = { path: 'x', error: 'boom' };
  const shaped = await shapeToolResponse(makeResponse('read_file', raw), c);
  assert.deepEqual(shaped.data.result, raw, '结构不符原样返回');
  assert.equal(getRecord().shaping.applied, true, 'L1 路径执行（reducer fail-open 不抛）');
});

test('W1-02-AC5: D17 静默 — 结果内无任何层标记（递归扫描）', async () => {
  const { ctx: c } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('read_file', { path: 'a.txt', content: 'a\nb\nc\n', sha256: 'deadbeef', bytes: 6 }), c);
  assertNoShapingMarkers(shaped);
});

// ── 运行时探测（AC6）：actions 通道真实调用 ─────────────────────────────────────

const CONNECTOR_KEY = 'w102-connector-key-123456';
const ACTIONS_TOKEN = 'w102-actions-token-1234567890123456';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-w102-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
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

async function root(server, name = 'w102-main') {
  const reg = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  return reg.body.data.result.identity;
}

test('W1-02-AC6: 运行时探测 — actions 通道真实调用 read_file 断言 lineCount 与 bytes', async () => {
  const server = await createRuntime();
  try {
    const identity = await root(server);

    // N 行带尾换行（3 行）
    fs.writeFileSync(path.join(server.dirs.workspaceDir, 'three.txt'), 'alpha\nbeta\ngamma\n');
    const resp = await call(server, 'read_file', { path: 'three.txt' }, identity);
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    assert.equal(resp.body.ok, true, JSON.stringify(resp.body));
    const result = resp.body.data.result;
    assert.equal(result.lineCount, 3, '3 行文件 lineCount=3');
    assert.equal(result.bytes, Buffer.byteLength('alpha\nbeta\ngamma\n'), 'bytes === 文件真实字节数');
    assertNoShapingMarkers(result);

    // 空文件 = 0 行
    fs.writeFileSync(path.join(server.dirs.workspaceDir, 'empty.txt'), '');
    const empty = (await call(server, 'read_file', { path: 'empty.txt' }, identity)).body.data.result;
    assert.equal(empty.lineCount, 0, '空文件 lineCount=0');
    assert.equal(empty.bytes, 0, '空文件 bytes=0');

    // 无尾换行 = 1 行
    fs.writeFileSync(path.join(server.dirs.workspaceDir, 'single.txt'), 'only-one-line');
    const single = (await call(server, 'read_file', { path: 'single.txt' }, identity)).body.data.result;
    assert.equal(single.lineCount, 1, '无尾换行 lineCount=1');
    assert.equal(single.bytes, Buffer.byteLength('only-one-line'), 'bytes === 无尾换行文件字节数');
  } finally {
    await server.close();
  }
});
