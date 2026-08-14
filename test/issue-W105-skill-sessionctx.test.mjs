// ADR-0051 W1-05 (#78)：skill(list) 注册 count + session_context 明示豁免（0050 A5）
//
// 票文裁决（#78 "注册或明示豁免"）：本票走混合路径——
//   - skill（list 模式）→ 注册（补遗3 权威矩阵缺口 5：count = skills 数组实际长度）
//   - session_context → 明示豁免（D-16）：handler 原生 16K 投影有界（CONTEXT_PROJECTION_LIMIT
//     = 16000，context-projector.ts），矩阵要求的主动精简已在源头达成；投影结构异构，
//     注册 count 无意义。测试锁定"现状为有意 passthrough"；D-16 登记行由主窗口集中登记。
//
// 验收断言：
//   AC1  TOOL_SHAPES 注册 skill → { reduce }；session_context 不注册（豁免的结构锁）
//   AC2  list 模式成功态：skills 原样保留 + count === skills.length（D16.1）
//   AC3  运行态（inline / fork 结果无 skills 数组）→ fail-open 原样，不抛错（D11）
//   AC4  结构不符（skills 非数组）→ fail-open 原样返回，不抛错
//   AC5  D17 静默：结果内无任何层标记（递归扫描，复用 assertNoShapingMarkers 手法）
//   AC6  session_context 明示豁免：shapeToolResponse 原样 passthrough（result 深等于原对象，
//       audit reason === 'passthrough'，applied === false）——锁定现状为有意 passthrough
//   AC7  运行时探测：actions 通道真实调用 skill（无参 = list）断言 count === skills.length
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
    sessionId: 's-w105',
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

// ── AC1：注册表断言 ────────────────────────────────────────────────────────────

test('W1-05-AC1: TOOL_SHAPES 注册 skill；session_context 不注册（豁免结构锁）', () => {
  assert.ok(TOOL_SHAPES.has('skill'), 'skill 应注册');
  assert.equal(typeof TOOL_SHAPES.get('skill').reduce, 'function', 'skill 应有 L1 reducer');
  assert.equal(TOOL_SHAPES.has('session_context'), false, 'session_context 明示豁免 → 不注册（D-16）');
});

// ── AC2：list 模式成功态 ──────────────────────────────────────────────────────

test('W1-05-AC2: list 模式成功态 — skills 原样保留 + count === skills.length（D16.1）', async () => {
  const { ctx: c } = makeCtx();
  const skills = [
    { name: 'alpha', description: 'first', when_to_use: 'w', mode: 'inline' },
    { name: 'beta', description: 'second', when_to_use: 'w', mode: 'fork' },
    { name: 'gamma', description: 'third', when_to_use: 'w', mode: 'inline' },
  ];
  const shaped = await shapeToolResponse(makeResponse('skill', { skills }), c);

  assert.deepEqual(shaped.data.result.skills, skills, 'skills 数组原样保留');
  assert.equal(shaped.data.result.count, 3, 'count === skills 数组实际长度');
  assert.equal(Object.keys(shaped.data.result).length, 2, '只加 count，不多带其他字段');
});

test('W1-05-AC2b: list 模式空列表 — count === 0', async () => {
  const { ctx: c } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('skill', { skills: [] }), c);
  assert.deepEqual(shaped.data.result.skills, [], '空数组原样保留');
  assert.equal(shaped.data.result.count, 0, 'count === 0');
});

// ── AC3：运行态（inline / fork）fail-open ─────────────────────────────────────

test('W1-05-AC3: 运行态（inline / fork 结果无 skills 数组）→ fail-open 原样，不抛错', async () => {
  const { ctx: c, getRecord } = makeCtx();

  const inline = { name: 'demo', description: 'd', mode: 'inline', content: 'instructions' };
  const shapedInline = await shapeToolResponse(makeResponse('skill', inline), c);
  assert.deepEqual(shapedInline.data.result, inline, 'inline 结果原样保留（无 count，不伪造）');
  assert.equal(getRecord().shaping.applied, true, 'L1 路径执行（reducer fail-open 不抛）');

  const fork = { name: 'demo', description: 'd', mode: 'fork', taskId: 't-1', sessionId: 's-1', status: 'running' };
  const shapedFork = await shapeToolResponse(makeResponse('skill', fork), c);
  assert.deepEqual(shapedFork.data.result, fork, 'fork 结果原样保留（无 count，不伪造）');
});

// ── AC4：结构不符 fail-open ───────────────────────────────────────────────────

test('W1-05-AC4: 结构不符（skills 非数组）→ fail-open 原样返回，不抛错', async () => {
  const { ctx: c, getRecord } = makeCtx();
  const raw = { error: 'boom' };
  const shaped = await shapeToolResponse(makeResponse('skill', raw), c);
  assert.deepEqual(shaped.data.result, raw, '结构不符原样返回');
  assert.equal(getRecord().shaping.applied, true, 'L1 路径执行（reducer fail-open 不抛）');
});

// ── AC5：D17 静默 ─────────────────────────────────────────────────────────────

test('W1-05-AC5: D17 静默 — 结果内无任何层标记（递归扫描）', async () => {
  const { ctx: c } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('skill', {
    skills: [{ name: 'alpha', description: 'first', when_to_use: 'w', mode: 'inline' }],
  }), c);
  assertNoShapingMarkers(shaped);
});

// ── AC6：session_context 明示豁免（锁定现状为有意 passthrough）───────────────

test('W1-05-AC6: session_context 明示豁免 — 原样 passthrough，结果逐字节不变', async () => {
  const { ctx: c, getRecord } = makeCtx();
  const raw = {
    context: {
      session: { id: 's-1', phase: 'active' },
      messages: [{ id: 'm-1', from: 's-1', text: 'hello' }],
      truncated: true, // handler 原生 16K 投影有界（CONTEXT_PROJECTION_LIMIT），截断态也原样
    },
  };
  const shaped = await shapeToolResponse(makeResponse('session_context', raw), c);

  assert.deepEqual(shaped.data.result, raw, 'session_context 原样 passthrough（锁定有意豁免）');
  assert.equal(getRecord().shaping.applied, false, '未走 L1/L3 整形路径');
  assert.equal(getRecord().shaping.reason, 'passthrough', '审计 reason === passthrough（D-16 豁免）');
});

// ── 运行时探测（AC7）：actions 通道真实调用 ───────────────────────────────────

const CONNECTOR_KEY = 'w105-connector-key-123456';
const ACTIONS_TOKEN = 'w105-actions-token-1234567890123456';

const SKILL_MARKDOWN = (name) => `---
name: ${name}
description: W1-05 probe skill for issue #78.
when_to_use: Use in tests.
mode: inline
---
# ${name}

Probe skill body for the runtime probe.
`;

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-w105-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  // 3 个项目级技能（目录式 <name>/SKILL.md），无参调用 skill = list 应列出
  for (const name of ['w105-alpha', 'w105-beta', 'w105-gamma']) {
    const dir = path.join(stateDir, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MARKDOWN(name), 'utf8');
  }
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

async function root(server, name = 'w105-main') {
  const reg = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  return reg.body.data.result.identity;
}

test('W1-05-AC7: 运行时探测 — actions 通道真实调用 skill(list) 断言 count === skills.length', async () => {
  const server = await createRuntime();
  try {
    const identity = await root(server);
    const resp = await call(server, 'skill', {}, identity); // 无参 = list（决策 3）
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    assert.equal(resp.body.ok, true, JSON.stringify(resp.body));

    const result = resp.body.data.result;
    assert.ok(Array.isArray(result.skills), 'list 模式应返回 skills 数组');
    assert.equal(result.count, result.skills.length, 'count === skills 数组实际长度');
    const names = result.skills.map((s) => s.name);
    for (const name of ['w105-alpha', 'w105-beta', 'w105-gamma']) {
      assert.ok(names.includes(name), `项目级技能 ${name} 应在列表中`);
    }
    assertNoShapingMarkers(result);
  } finally {
    await server.close();
  }
});
