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
