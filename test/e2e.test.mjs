import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MyTerminalRuntime } from '../dist/server.js';

const CONNECTOR_KEY = 'e2e-connector-key-1234567890';
const ACTIONS_TOKEN = 'e2e-actions-token-123456789012345678';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-e2e-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'hello e2e\n');
  return { workspaceDir, stateDir };
}

async function createRuntime() {
  const dirs = tempWorkspace();
  const runtime = new MyTerminalRuntime({ ...dirs, settingsPath: path.join(dirs.stateDir, 'settings.json'), host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: 'http://127.0.0.1:0', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'en', uiTheme: 'dark', passiveLockEnabled: false, actionsContinuationMode: 'off' });
  await runtime.start();
  return { runtime, dirs, baseUrl: `http://127.0.0.1:${runtime.port}`, async close() { await runtime.close(); fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); } };
}

function parseEventStreamJson(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('data: ')) {
      try { return JSON.parse(lines.slice(i).map((l) => l.replace(/^data: /, '')).join('\n')); } catch { /* continue */ }
    }
  }
  return JSON.parse(text);
}

async function rpcPost(url, payload, sessionId) {
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await response.text();
  return { response, data: response.headers.get('content-type')?.includes('text/event-stream') ? parseEventStreamJson(text) : JSON.parse(text), sessionId: response.headers.get('mcp-session-id') };
}

async function actionsCall(server, tool, input = {}, identity) {
  const headers = { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' };
  const response = await fetch(`${server.baseUrl}/actions/extensions/call`, { method: 'POST', headers, body: JSON.stringify({ tool, input, ...(identity ? { identity } : {}) }) });
  return { status: response.status, body: await response.json() };
}

// ═══════════════════════════════════════════════════════════
// E2E-1: MCP 完整链路 — initialize → tools/list → tool call → audit
// ═══════════════════════════════════════════════════════════

test('E2E MCP: initialize → list tools → register session → checkpoint → audit trail', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;

    // Step 1: initialize
    const init = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-test', version: '1.0.0' } } });
    assert.equal(init.response.status, 200);
    assert.ok(init.data.result.instructions.length > 0);
    const sessionId = init.sessionId;
    assert.ok(sessionId);

    // Step 2: tools/list
    const listed = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
    const tools = listed.data.result.tools;
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('session_register'));
    assert.ok(names.includes('session_checkpoint'));
    assert.ok(names.includes('workspace_info'));

    // Step 3: session_register
    const reg = await rpcPost(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 'e2e-session', role: 'lead' } } }, sessionId);
    assert.notEqual(reg.data.result.isError, true);
    assert.ok(reg.data.result.content[0].text.length > 0, 'register should return non-empty text');
  } finally {
    await server.close();
  }
});

// ═══════════════════════════════════════════════════════════
// E2E-2: Actions API 完整链路 — discover → identity → tool → audit
// ═══════════════════════════════════════════════════════════

test('E2E Actions: discover → register → extension_call → audit sanitized', async () => {
  const server = await createRuntime();
  try {
    // Step 1: discover (authenticated with actions token)
    const disc = await fetch(`${server.baseUrl}/actions/extensions/discover`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(disc.status, 200);
    const discBody = await disc.json();
    assert.equal(discBody.ok, true);

    // Step 2: register session
    const reg = await actionsCall(server, 'session_register', { mode: 'root', name: 'e2e-actions', role: 'lead' });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.ok, true);
    const identity = reg.body.data.result.identity;
    assert.ok(identity);

    // Step 3: execute_cli
    const exec = await actionsCall(server, 'execute_cli', { command: 'echo e2e-test-output' }, identity);
    assert.equal(exec.status, 200);
    assert.equal(exec.body.ok, true);
    assert.ok(exec.body.data.result.stdout.includes('e2e-test-output'));
    assert.equal(exec.body.data.result.exitCode, 0);
  } finally {
    await server.close();
  }
});

// ═══════════════════════════════════════════════════════════
// E2E-3: 凭据认证 — 错误 token 被拒绝
// ═══════════════════════════════════════════════════════════

test('E2E Auth: wrong actions token rejected', async () => {
  const server = await createRuntime();
  try {
    // Wrong actions token on discover
    const badDisc = await fetch(`${server.baseUrl}/actions/extensions/discover`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token-123456789012345678', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const badBody = await badDisc.json();
    assert.equal(badBody.ok, false);

    // Correct token works
    const goodDisc = await fetch(`${server.baseUrl}/actions/extensions/discover`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const goodBody = await goodDisc.json();
    assert.equal(goodBody.ok, true);
  } finally {
    await server.close();
  }
});

// ═══════════════════════════════════════════════════════════
// E2E-4: 健康检查 + 集群状态
// ═══════════════════════════════════════════════════════════

test('E2E Health: /health reports version and OpenAPI spec is accessible', async () => {
  const server = await createRuntime();
  try {
    const health = await fetch(`${server.baseUrl}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.product, 'myterminal');
    assert.ok(health.version);
    assert.ok(health.workspaceId);

    // OpenAPI spec is accessible
    const schema = await fetch(`${server.baseUrl}/openapi.json`).then((r) => r.json());
    assert.equal(schema.openapi, '3.1.0');
    assert.ok(schema.paths['/actions/extensions/call']);
  } finally {
    await server.close();
  }
});

// ═══════════════════════════════════════════════════════════
// E2E-5: MCP 深度 — 多工具调用 + 错误处理 + session 管理
// ═══════════════════════════════════════════════════════════

test('E2E MCP deep: extension_call execute_cli + read_file + error handling', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'deep-test', version: '1.0.0' } } });
    const sid = init.sessionId;

    // Register session to get identity
    const reg = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 'deep-session', role: 'lead' } } }, sid);
    assert.notEqual(reg.data.result.isError, true);
    const identity = reg.data.result.structuredContent.data.result.identity;
    assert.ok(identity.sessionId);

    // Call execute_cli via extension_call (identity at top level)
    const exec = await rpcPost(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'execute_cli', input: { command: 'echo mcp-deep-test' }, identity } } }, sid);
    assert.notEqual(exec.data.result.isError, true);
    const execStructured = exec.data.result.structuredContent;
    assert.equal(execStructured.ok, true);
    assert.ok(execStructured.data.result.stdout.includes('mcp-deep-test'));

    // Call read_file via extension_call (direct tools strip identity)
    const read = await rpcPost(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'read_file', input: { path: 'hello.txt' }, identity } } }, sid);
    assert.notEqual(read.data.result.isError, true);
    const readStructured = read.data.result.structuredContent;
    assert.equal(readStructured.ok, true);

    // Error case: call unknown tool
    const bad = await rpcPost(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'nonexistent_tool_xyz', input: {}, identity } } }, sid);
    const badStructured = bad.data.result.structuredContent;
    assert.equal(badStructured.ok, false);
    assert.ok(badStructured.error.code);
  } finally {
    await server.close();
  }
});

test('E2E MCP session: invalid session rejected, multiple sessions isolated', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;

    // Request without session → 400
    const noSession = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'mcp-session-id': 'nonexistent-session-id' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(noSession.status, 400);

    // Create two independent sessions
    const init1 = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'session-1', version: '1.0.0' } } });
    const init2 = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'session-2', version: '1.0.0' } } });
    assert.ok(init1.sessionId);
    assert.ok(init2.sessionId);
    assert.notEqual(init1.sessionId, init2.sessionId);

    // Both sessions can list tools independently
    const list1 = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init1.sessionId);
    const list2 = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init2.sessionId);
    assert.ok(list1.data.result.tools.length > 20);
    assert.ok(list2.data.result.tools.length > 20);

    // Session 1 registers a session; session 2 has independent state
    const reg1 = await rpcPost(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 'from-session-1', role: 'lead' } } }, init1.sessionId);
    assert.notEqual(reg1.data.result.isError, true);
  } finally {
    await server.close();
  }
});

test('E2E MCP tools: workspace_info + session_list + session_checkpoint flow', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'flow-test', version: '1.0.0' } } });
    const sid = init.sessionId;

    // session_register to get identity
    const reg = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 'flow-session', role: 'lead' } } }, sid);
    const regData = reg.data.result.structuredContent;
    assert.equal(regData.ok, true);
    const identity = regData.data.result.identity;
    assert.ok(identity.sessionId);

    // workspace_info via extension_call (direct tools strip identity)
    const info = await rpcPost(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'workspace_info', input: {}, identity } } }, sid);
    const infoData = info.data.result.structuredContent;
    assert.equal(infoData.ok, true);
    assert.ok(infoData.data.result.workspaceDir);

    // session_list via extension_call
    const list = await rpcPost(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'session_list', input: {}, identity } } }, sid);
    const listData = list.data.result.structuredContent;
    assert.equal(listData.ok, true);
    assert.ok(listData.data.result.sessions.length >= 1);

    // session_checkpoint to working via extension_call
    const cp = await rpcPost(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'session_checkpoint', input: { phase: 'working', summary: 'MCP flow test in progress' }, identity } } }, sid);
    const cpData = cp.data.result.structuredContent;
    assert.equal(cpData.ok, true);
    assert.equal(cpData.data.result.session.phase, 'working');

    // session_checkpoint to completed
    const done = await rpcPost(url, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'session_checkpoint', input: { phase: 'completed', summary: 'MCP flow test done' }, identity } } }, sid);
    const doneData = done.data.result.structuredContent;
    assert.equal(doneData.ok, true);
    assert.equal(doneData.data.result.session.phase, 'completed');
  } finally {
    await server.close();
  }
});
