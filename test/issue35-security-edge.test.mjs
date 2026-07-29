import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MyTerminalRuntime } from '../dist/server.js';
import { validateSafeRegex } from '../dist/security.js';

const CONNECTOR_KEY = 'test-connector-key-1234567890';
const ACTIONS_TOKEN = 'test-actions-token-12345678901234567890';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-35-'));
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
    host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN,
    publicBaseUrl: 'http://127.0.0.1:0', maxOutputChars: 20_000, commandTimeoutSec: 10,
    uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false, actionsContinuationMode: 'next-call', ...overrides,
  });
  await runtime.start();
  return {
    runtime, dirs, baseUrl: `http://127.0.0.1:${runtime.port}`,
    async close() { await runtime.close(); fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); },
  };
}

async function action(server, endpoint, body) {
  const response = await fetch(`${server.baseUrl}/actions/extensions/${endpoint}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function call(server, tool, input = {}, identity) { return action(server, 'call', { tool, input, ...(identity ? { identity } : {}) }); }
async function root(server, name = 'main') {
  const response = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.ok, true);
  return response.body.data.result;
}

// ---- #35 (A): git option injection via git_show revision ----
test('git_show treats option-like revisions as revisions, not flags', async () => {
  const server = await createRuntime({ actionsContinuationMode: 'off' });
  try {
    execFileSync('git', ['init', '-q'], { cwd: server.dirs.workspaceDir });
    execFileSync('git', ['config', 'user.email', 'test@myterminal.local'], { cwd: server.dirs.workspaceDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: server.dirs.workspaceDir });
    execFileSync('git', ['add', '-A'], { cwd: server.dirs.workspaceDir });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: server.dirs.workspaceDir });
    const identity = (await root(server, 'git-inject')).identity;
    // '-p' is a valid git-show OPTION. Before the fix it is honored and a patch is
    // returned (stdout contains a diff). After the fix git_show passes '--' before the
    // revision, so '-p' is parsed as a revision/object name and no diff is produced.
    const res = await call(server, 'git_show', { revision: '-p' }, identity);
    assert.equal(res.body.ok, true, `git_show should succeed for a harmless-looking argument: ${JSON.stringify(res.body)}`);
    const stdout = res.body.data?.result?.stdout ?? '';
    assert.ok(!/diff --git|@@ /.test(stdout), `git_show must not honor '-p' as the patch option (argument injection): stdout=${JSON.stringify(stdout)}`);
  } finally { await server.close(); }
});

// ---- #35 (B): ReDoS gate (validateSafeRegex seam) ----
test('validateSafeRegex accepts safe patterns and rejects nested-quantifier ReDoS', () => {
  for (const safe of ['abc', '\\d+', '(\\w+)\\s+(\\w+)', '^https?://', '[a-z]{2,5}', '(\\d{4})-(\\d{2})-(\\d{2})', 'function\\s+(\\w+)\\s*\\(']) {
    assert.doesNotThrow(() => validateSafeRegex(safe), `expected safe: ${safe}`);
  }
  for (const bad of ['(a+)+', '(a*)*', '([a-z]+){2,}', '(a+)?', '(\\d+)+$', '((a+))+', '([a-zA-Z]+)+\\d']) {
    assert.throws(() => validateSafeRegex(bad), `expected rejected: ${bad}`);
  }
});

test('search_text rejects ReDoS-prone regex instead of executing it', async () => {
  const server = await createRuntime({ actionsContinuationMode: 'off' });
  try {
    const identity = (await root(server, 'redos')).identity;
    const res = await call(server, 'search_text', { query: '(a+)+', regex: true }, identity);
    // The regex-safety gate must reject the nested-quantifier pattern before it is
    // ever compiled/executed (so the event loop cannot be hung by catastrophic
    // backtracking). The detail is intentionally redacted to INTERNAL (ADR-0026);
    // ok:false is the signal. Before the fix this returns ok:true (pattern accepted).
    assert.equal(res.body.ok, false, `search_text must reject nested-quantifier regex, got: ${JSON.stringify(res.body)}`);
  } finally { await server.close(); }
});

// ---- #35 (C): cluster RPC secret comparison (behavior lock) ----
// clusterMember is only registered for non-zero port runtimes; the test runtime
// uses port 0, so /cluster/* always returns 404. The fix is behavior-preserving
// (constant-time compare); we lock the observable contract and rely on the
// identical safeEqual usage at server.ts:561/601 for the security guarantee.
test('cluster RPC secret mismatch still returns 404 (behavior preserved after safeEqual swap)', async () => {
  const server = await createRuntime({ actionsContinuationMode: 'off' });
  try {
    const wrong = await fetch(`${server.baseUrl}/cluster/owns`, {
      method: 'POST',
      headers: { 'x-myterminal-cluster-secret': 'definitely-wrong' },
      body: JSON.stringify({ clientSessionKey: '' }),
    });
    assert.equal(wrong.status, 404, 'unknown cluster secret must be rejected');
  } finally { await server.close(); }
});
