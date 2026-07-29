import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MyTerminalRuntime } from '../dist/server.js';
import { toolRegistry } from '../dist/subagent/tools.js';

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0028 red-line test net: structured error codes + no internal-detail leak.
//
// Reuses ADR-0026's P2-1 fixture discipline: ONLY explicit `sk-test-` prefixed
// fake values may appear. If an assertion fails, the "found secret" would print
// into CI logs — so every sensitive-looking value here is obviously fake.
//
// Three red lights (must FAIL against the substring-guess code, PASS after the
// typed-error fix):
//   1. A generic (non-typed) error surfaced through the Actions protocol must
//      map to code INTERNAL with a generic message, and must NOT leak the
//      internal detail (path/param/secret) to the caller.
//   2. A typed error (MyTerminalError) must pass its code through unchanged
//      (regression lock — must stay green both before and after).
//   3. grep with an invalid regex must not guess from the engine message and
//      must not expose the raw engine detail.
// ─────────────────────────────────────────────────────────────────────────────

const CONNECTOR_KEY = 'errorcodes-connector-key-1234567890';
const ACTIONS_TOKEN = 'errorcodes-actions-token-1234567890123456';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-errorcodes-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  return { workspaceDir, stateDir };
}

async function createRuntime() {
  const dirs = tempWorkspace();
  const runtime = new MyTerminalRuntime({
    ...dirs,
    settingsPath: path.join(dirs.stateDir, 'settings.json'),
    host: '127.0.0.1', port: 0,
    connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN,
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 20_000, commandTimeoutSec: 10,
    uiLanguage: 'en', uiTheme: 'dark', passiveLockEnabled: false,
    actionsContinuationMode: 'off',
  });
  await runtime.start();
  return {
    runtime, dirs,
    baseUrl: `http://127.0.0.1:${runtime.port}`,
    async close() { await runtime.close(); fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); },
  };
}

async function actionsCall(server, tool, input = {}, identity) {
  const headers = { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' };
  const response = await fetch(`${server.baseUrl}/actions/extensions/call`, {
    method: 'POST', headers,
    body: JSON.stringify({ tool, input, ...(identity ? { identity } : {}) }),
  });
  return { status: response.status, body: await response.json() };
}

// ── Red light 1 ──────────────────────────────────────────────────────────────
test('protocol: generic error → INTERNAL + generic message, no internal detail leak', async () => {
  const server = await createRuntime();
  try {
    const reg = await actionsCall(server, 'session_register', { mode: 'root', name: 'errcodes-root', role: 'lead' });
    assert.equal(reg.body.ok, true);
    const identity = reg.body.data.result.identity;

    // A command extension whose executable does not exist → spawn ENOENT throws
    // a generic Error whose message contains the (internal) path.
    const LEAK_MARKER = '/tmp/sk-test-leak-internal-9f3a/run-nonexistent';
    await server.runtime.extensions.registerFromTui({ action: 'upsert', spec: {
      name: 'internal_leak', title: 'Internal leak', description: 'Triggers a generic spawn error.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      handler: { kind: 'command', executable: LEAK_MARKER, args: [] },
    } });

    const res = await actionsCall(server, 'internal_leak', {}, identity);
    assert.equal(res.body.ok, false);
    // RED now: current code guesses EXTENSION_ERROR and returns the raw message.
    assert.equal(res.body.error.code, 'INTERNAL');
    assert.equal(res.body.error.message, 'An internal error occurred.');
    assert.equal(res.body.error.message.includes(LEAK_MARKER), false, `internal path leaked to caller: ${res.body.error.message}`);
    assert.equal(res.body.error.message.includes('sk-test-leak-internal'), false, `internal detail leaked to caller: ${res.body.error.message}`);
  } finally {
    await server.close();
  }
});

// ── Lock: typed error code passes through unchanged ───────────────────────────
test('protocol: typed error code passes through (NOT_FOUND for unknown tool)', async () => {
  const server = await createRuntime();
  try {
    const reg = await actionsCall(server, 'session_register', { mode: 'root', name: 'errcodes-root2', role: 'lead' });
    const identity = reg.body.data.result.identity;
    const res = await actionsCall(server, 'does_not_exist_xyz', {}, identity);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  } finally {
    await server.close();
  }
});

// ── Red light 3 ────────────────────────────────────────────────────────────────
test('grep: invalid regex returns friendly message without raw engine detail', async () => {
  const grepTool = toolRegistry.get('grep');
  assert.ok(grepTool, 'grep tool must be registered');
  const result = await grepTool.call({ pattern: '[invalid-regex-(' }, { cwd: os.tmpdir() });
  assert.equal(result.is_error, true);
  // RED now: current code appends the raw engine message (contains
  // "Invalid regular expression").
  assert.equal(result.message.includes('Invalid regular expression'), false, `raw engine detail leaked: ${result.message}`);
  assert.equal(result.message.startsWith('Invalid regex pattern:'), true, `expected friendly prefix, got: ${result.message}`);
});
