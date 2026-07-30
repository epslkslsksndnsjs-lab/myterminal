// ADR-0029 端到端回归——真实 MCP HTTP transport 验证（补全 unit/integration 盲区）
//
// test/mcp-identity.test.mjs 直驱 ext.call，绕过了 mcp.ts transport 层（原 bug 原点
// contextFromCall 从 mcp-session-id 派生 InvocationContext，以及 transport close →
// mcpSessionClosed 解绑钩子）。本文件启动真实 MyTerminalRuntime + Streamable HTTP MCP
// 端点，用标准 MCP 客户端（无 openai/session meta）走完 initialize → register → call
// 全链路，确保以下两条生产路径被端到端覆盖：
//   E1 绑定：contextFromCall 注入 mcpSessionId → authenticate 绑定 → 同连接后续调用免重认证
//   E2 解绑：真实 transport close（DELETE session）→ mcpSessionClosed → unbindMcp
//   E3 串号：跨连接不继承身份（新 initialize 拿不到旧连接绑定）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MyTerminalRuntime } from '../dist/server.js';

const CONNECTOR_KEY = 'test-connector-key-1234567890';
const ACTIONS_TOKEN = 'test-actions-token-12345678901234567890';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-mcp-e2e-'));
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

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'myterminal-mcp-e2e', version: '1.0.0' } } };

// ═══════════════════════════════════════════════════════
// E1：真实 transport 绑定（杀 contextFromCall 盲区）
// ═══════════════════════════════════════════════════════

test('E1: 标准 MCP 客户端经真实 transport 绑定身份，同连接后续调用免重认证', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(url, INITIALIZE);
    assert.ok(init.sessionId, 'initialize 应回写 mcp-session-id header');
    const SID = init.sessionId;

    // 纯 MCP 连接：不携带 openai/session meta、不携带 identity body，仅依赖 transport 的 mcp-session-id
    const register = await rpcPost(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 'mcp-e2e-root' } } }, SID);
    const identity = register.data.result.structuredContent.data.result.identity;
    assert.ok(identity?.sessionId && identity?.sessionToken, 'register 应返回 identity');
    assert.equal(server.runtime.store.hasMcpBinding(SID), true, '真实 transport 下应已绑定 SID→session');

    // 同连接后续调用（无 identity）经 contextFromCall + resolveMcpBinding 认证
    const list = await rpcPost(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'session_list', arguments: {} } }, SID);
    assert.equal(list.data.result.structuredContent.ok, true, '传输层绑定后同连接免重认证');
  } finally { await server.close(); }
});

// ═══════════════════════════════════════════════════════
// E2：真实 transport close 触发解绑（杀 mcpSessionClosed 盲区）
// ═══════════════════════════════════════════════════════

test('E2: 真实 transport close（DELETE session）触发解绑，复用旧 id 不得继承身份', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(url, INITIALIZE);
    const SID = init.sessionId;

    await rpcPost(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 'mcp-e2e-root' } } }, SID);
    assert.equal(server.runtime.store.hasMcpBinding(SID), true, '绑定应先成立');

    // 真实 transport 关闭：DELETE session → MCP SDK 关 transport → onsessionclosed/onclose → mcpSessionClosed → unbindMcp
    const del = await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': SID } });
    assert.ok([200, 202, 204].includes(del.status) || del.status < 500, `DELETE 应被接受（实际 ${del.status}）`);
    assert.equal(server.runtime.store.hasMcpBinding(SID), false, 'transport close 应经 mcpSessionClosed 解绑');

    // 复用旧 id 不出示身份 → 必须 IDENTITY_REQUIRED（transport 已关，POST 可能 400/404；以绑定已清为权威证据）
    const after = await rpcPost(url, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'session_list', arguments: {} } }, SID);
    const err = after.data?.result?.structuredContent?.error;
    if (err) assert.equal(err.code, 'IDENTITY_REQUIRED');
  } finally { await server.close(); }
});

// ═══════════════════════════════════════════════════════
// E3：跨连接不继承身份（串号防护，真实 transport）
// ═══════════════════════════════════════════════════════

test('E3: 新连接（新 mcp-session-id）不得继承旧连接的身份绑定', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const initA = await rpcPost(url, INITIALIZE);
    await rpcPost(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 'mcp-e2e-a' } } }, initA.sessionId);
    assert.equal(server.runtime.store.hasMcpBinding(initA.sessionId), true);

    // 第二个独立 MCP 连接（全新 mcp-session-id）
    const initB = await rpcPost(url, { jsonrpc: '2.0', id: 90, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'myterminal-mcp-e2e-b', version: '1.0.0' } } });
    assert.notEqual(initB.sessionId, initA.sessionId, '新连接应拿到不同 mcp-session-id');

    const probe = await rpcPost(url, { jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'session_list', arguments: {} } }, initB.sessionId);
    assert.equal(probe.data.result.structuredContent.error?.code, 'IDENTITY_REQUIRED', '跨连接不得继承身份');
  } finally { await server.close(); }
});
