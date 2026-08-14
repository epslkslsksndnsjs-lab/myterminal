// ADR-0047 T13 (#40)：MCP 出口 + 多进程（D18.2/D18.3）
//
// 验收断言：
//   AC1  mcp__myterminal__* 走完整 L1/L2/L3（与 actions 路由一致）；events 数组原样透传、
//        绝不 strip/摘要/改写（含 checkpoint_due / CHECKPOINT_REQUIRED 控制流）
//   AC2  指针型 result（磁盘溢出引用）当不透明 passthrough，不解析不 strip
//   AC3  cluster 参与者 L3 默认关闭：enabled = env.MYTERMINAL_L3_ENABLED ?? (server.cluster ? false : true)
//        参与者层面 gate（注册时定一次、不随成员增减翻转），不进每请求热路径
//   AC4  L1+L2 每 member 独立跑：整形发生在 owning member 执行点、结果出 RPC 前完成，无双次整形
//   AC5  e2e：MCP 通道整形 + events 不动 + 多进程 L3 默认关
//
// 测试方式：单元测试直接驱动 ../dist/l3/registry.js 与 ../dist/tool-parse.js（build 产物）；
// e2e 启动真实 server 经 MCP 出口调用工具。fake adapter 在测试内构造，真模型不进自动化测试。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import {
  l3Enabled,
  setL3ClusterMode,
  resetL3ClusterMode,
  registerAdapterFactory,
  resetL3Adapter,
} from '../dist/l3/registry.js';
import { runL3 } from '../dist/l3/engine.js';
import { MyTerminalRuntime } from '../dist/server.js';

// ── 测试辅助 ─────────────────────────────────────────────────────────────────

function makeCtx(sessionId = 's-40', transport = 'actions') {
  let record;
  const ctx = {
    transport,
    sessionId,
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

const CONNECTOR_KEY = 'test-connector-key-1234567890';
const ACTIONS_TOKEN = 'test-actions-token-12345678901234567890';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-t13-e2e-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'hello myterminal\n');
  return { workspaceDir, stateDir };
}

async function createRuntime(overrides = {}) {
  const dirs = tempWorkspace();
  const runtime = new MyTerminalRuntime({ ...dirs, settingsPath: path.join(dirs.stateDir, 'test-settings.json'), host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: 'http://127.0.0.1:0', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false, actionsContinuationMode: 'next-call', ...overrides });
  await runtime.start();
  return { runtime, dirs, baseUrl: `http://127.0.0.1:${runtime.port}`, async close() { await runtime.close(); fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); } };
}

async function rpcPost(url, payload, sessionId) {
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await response.text();
  const data = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(text);
  return { response, data, sessionId: response.headers.get('mcp-session-id') };
}

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'myterminal-t13-e2e', version: '1.0.0' } } };

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

afterEach(() => {
  resetL3ClusterMode();
  resetL3Adapter();
});

// ── AC3：cluster 参与者 L3 默认关（参与者层面 gate）──────────────────────────

test('T13-AC3: 默认（未设置 cluster 模式）env 未设置 → true（standalone 默认开）', () => {
  assert.strictEqual(l3Enabled({}), true);
});

test('T13-AC3: setL3ClusterMode(true) 后 env 未设置 → false（cluster 参与者默认关）', () => {
  setL3ClusterMode(true);
  assert.strictEqual(l3Enabled({}), false);
  assert.strictEqual(l3Enabled({ MYTERMINAL_L3_ENABLED: '' }), false);
  assert.strictEqual(l3Enabled({ MYTERMINAL_L3_ENABLED: '   ' }), false);
});

test('T13-AC3: env 显式设置覆盖 cluster 默认（env > 模式默认）', () => {
  setL3ClusterMode(true);
  assert.strictEqual(l3Enabled({ MYTERMINAL_L3_ENABLED: 'true' }), true, 'env 显式 true 覆盖 cluster 默认 false');
  assert.strictEqual(l3Enabled({ MYTERMINAL_L3_ENABLED: '1' }), true);
  assert.strictEqual(l3Enabled({ MYTERMINAL_L3_ENABLED: 'false' }), false);
  assert.strictEqual(l3Enabled({ MYTERMINAL_L3_ENABLED: '0' }), false);
});

test('T13-AC3: gate 注册时定一次、不随重复 set 翻转（幂等语义）', () => {
  setL3ClusterMode(true);
  setL3ClusterMode(true);
  assert.strictEqual(l3Enabled({}), false);
  setL3ClusterMode(false);
  assert.strictEqual(l3Enabled({}), true);
});

test('T13-AC3: cluster gate 关闭后 runL3 走 passthrough，绝不调 adapter（D18.2 行为）', async () => {
  setL3ClusterMode(true);
  let called = false;
  registerAdapterFactory(() => ({
    id: 'fake', supportsStructuredOutput: true,
    isReady: async () => true,
    complete: async () => { called = true; return { object: { x: 1 }, finishReason: 'stop', latencyMs: 1, modelId: 'fake' }; },
  }));
  const outcome = await runL3({ a: 'hi' }, { type: 'object' }, 'mcp', 's-40');
  assert.strictEqual(outcome.shaped, null);
  assert.strictEqual(outcome.reason, 'passthrough');
  assert.strictEqual(called, false, 'L3 关闭时绝不调 adapter');
});

// ── AC2：指针型 result（磁盘溢出引用）不透明 passthrough ─────────────────────

test('T13-AC2: 指针型 result（type=tool_result_reference）→ 不透明 passthrough，不进 reducer', async () => {
  TOOL_SHAPES.set('t40_ptr_probe', { reduce: () => ({ denoised: true }) });
  const { ctx, getRecord } = makeCtx();
  const resp = {
    ok: true,
    data: { tool: 't40_ptr_probe', result: { type: 'tool_result_reference', file: '/tmp/spill-1.json' } },
  };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.strictEqual(shaped, resp, '指针型 result 原样 passthrough，不解析不 strip');
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'passthrough');
  TOOL_SHAPES.delete('t40_ptr_probe');
});

test('T13-AC2: 指针型 result（带 reference 语义 type）不进 L3', async () => {
  TOOL_SHAPES.set('t40_ptr_l3', { schema: { type: 'object' } });
  registerAdapterFactory(() => ({
    id: 'fake', supportsStructuredOutput: true,
    isReady: async () => true,
    complete: async () => ({ object: { x: 1 }, finishReason: 'stop', latencyMs: 1, modelId: 'fake' }),
  }));
  const { ctx, getRecord } = makeCtx();
  const resp = { ok: true, data: { tool: 't40_ptr_l3', result: { type: 'pointer', file: '/tmp/spill-2.json' } } };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.strictEqual(shaped, resp, '指针型 result 不进 L3，原样 passthrough');
  assert.equal(getRecord().shaping.reason, 'passthrough');
  TOOL_SHAPES.delete('t40_ptr_l3');
});

test('T13-AC2: 普通对象 result（无引用 type）照常走 reducer（不误伤）', async () => {
  TOOL_SHAPES.set('t40_normal', { reduce: (r) => ({ ...r, denoised: true }) });
  const { ctx, getRecord } = makeCtx();
  const resp = { ok: true, data: { tool: 't40_normal', result: { stdout: 'hi', exitCode: 0 } } };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.strictEqual(shaped.data.result.denoised, true, '普通 result 照常整形');
  assert.equal(getRecord().shaping.applied, true);
  TOOL_SHAPES.delete('t40_normal');
});

// ── AC1：events 数组原样透传（绝不 strip/摘要/改写）──────────────────────────

test('T13-AC1: events 数组（含 checkpoint_due / CHECKPOINT_REQUIRED）原样透传', async () => {
  TOOL_SHAPES.set('t40_events', { reduce: (r) => ({ ...r, denoised: true }) });
  const { ctx } = makeCtx();
  const events = [
    { type: 'checkpoint_due', checkpointStartedAt: '2026-08-14T00:00:00Z', blockAfterMinutes: 5 },
    { type: 'CHECKPOINT_REQUIRED', message: 'checkpoint overdue' },
  ];
  const resp = { ok: true, data: { tool: 't40_events', result: { stdout: 'hi', command: 'noise' } }, events };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.deepStrictEqual(shaped.events, events, 'events 原样透传，不 strip/摘要/改写');
  assert.strictEqual(shaped.data.result.denoised, true, 'data.result 照常整形');
  assert.strictEqual(shaped.data.result.stdout, 'hi', 'data.result 其余字段原样保留');
  TOOL_SHAPES.delete('t40_events');
});

// ── AC1/AC5 e2e：MCP 通道走完整 L1 整形（与 actions 路由一致）────────────────

test('T13-AC1 e2e: MCP 通道 extension_call → execute_cli 走完整 L1 去噪', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(url, INITIALIZE);
    const SID = init.sessionId;
    await rpcPost(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 't40-root' } } }, SID);

    const exec = await rpcPost(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'execute_cli', input: { command: 'echo t40-shape-output' } } } }, SID);
    const result = exec.data.result.structuredContent.data.result;
    // L1 被动去噪（CommandResult 5 噪声字段 strip）
    assert.equal(result.command, undefined, 'command 噪声被 strip');
    assert.equal(result.cwd, undefined, 'cwd 噪声被 strip');
    assert.equal(result.signal, undefined, 'signal 噪声被 strip');
    assert.equal(result.timedOut, undefined, 'timedOut 噪声被 strip');
    assert.equal(result.cancelled, undefined, 'cancelled 噪声被 strip');
    // 保留字段
    assert.ok(result.stdout.includes('t40-shape-output'), 'stdout 保留');
    assert.equal(result.exitCode, 0, 'exitCode 保留');
    assert.equal(typeof result.durationMs, 'number', 'durationMs 保留');
  } finally { await server.close(); }
});

// ── AC4/AC5 e2e：多进程（cluster 参与者）L3 默认关 + L1 去噪每 member 独立跑 ──

test('T13-AC4/AC5 e2e: cluster 参与者启动后 L3 默认关，L1 去噪仍独立跑（无双次整形）', async () => {
  const port = await findFreePort();
  // port 非 0 → server.start 走 cluster 分支（注册 PortClusterRegistry + tryBecomeLeader）
  const server = await createRuntime({ port });
  try {
    // AC5：cluster 参与者 L3 默认关（server.start 已调 setL3ClusterMode(true)）
    assert.strictEqual(l3Enabled({}), false, 'cluster 参与者 L3 默认关');

    // AC4：L1 去噪发生在 owning member 执行点（L3 虽关，L1/L2 每 member 独立跑）
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(url, INITIALIZE);
    const SID = init.sessionId;
    await rpcPost(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 't40-cluster-root' } } }, SID);
    const exec = await rpcPost(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'execute_cli', input: { command: 'echo t40-cluster-shape' } } } }, SID);
    const result = exec.data.result.structuredContent.data.result;
    assert.equal(result.command, undefined, 'L1 去噪在 member 本地执行（L3 关不影响 L1/L2）');
    assert.ok(result.stdout.includes('t40-cluster-shape'), 'stdout 保留');
    assert.equal(result.exitCode, 0);
  } finally { await server.close(); }
});
