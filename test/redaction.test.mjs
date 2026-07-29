import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MyTerminalRuntime } from '../dist/server.js';
import { MyTerminalStore } from '../dist/store.js';
import { redact } from '../dist/redact.js';

// ── P2-1 fixture constraint: ONLY explicit fake `sk-test-` prefixed values.
// Never put a real credential/token/password in this fixture. If an assertion
// fails, the "found secret" would be printed into CI logs — so the values MUST
// be obviously-fake. This is the permanent regression net for secret egress
// (ADR-0026): every egress (HTTP response / log / audit / error message) must
// route through the single-source redact() and never emit a raw secret. ──────
const SECRET = 'sk-test-REDACT-ME-9f3a';
const TOKEN = 'sk-test-token-aa11bb22';
const PASSWORD = 'sk-test-pass-cc33dd44';

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function configFor(root) {
  const workspaceDir = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    workspaceDir,
    stateDir,
    settingsPath: path.join(root, 'config.json'),
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'connector-key-redaction-1234567890',
    actionsToken: 'actions-token-redaction-1234567890123456',
    publicBaseUrl: '',
    maxOutputChars: 20_000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
  };
}

function readRuntimeLog(stateDir) {
  const file = path.join(stateDir, 'runtime.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// ── Exit: log() — the live leak this fix closes. runtime.log() wrote a raw
// string to runtime.jsonl with NO redaction. Now the logger entry force-redacts. ──
test('exit: log() never writes raw secret to runtime log', () => {
  const root = tempRoot('myterminal-redact-log-');
  try {
    const config = configFor(root);
    const runtime = new MyTerminalRuntime(config);
    runtime.log(`completed handshake token=${TOKEN} password=${PASSWORD}`);
    runtime.log(`auth Bearer ${SECRET}`);
    const log = readRuntimeLog(config.stateDir);
    assert.equal(log.includes(TOKEN), false, `raw token leaked into log: ${log}`);
    assert.equal(log.includes(PASSWORD), false, `raw password leaked into log: ${log}`);
    assert.equal(log.includes(SECRET), false, `raw secret leaked into log: ${log}`);
    assert.match(log, /\[REDACTED\]/, 'expected redaction marker in log');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Exit: audit JSONL (store.auditEvent → history) — already redacted, kept as
// a permanent net so the single-source refactor cannot regress it. ──
test('exit: store.auditEvent redacts secret args in history JSONL', () => {
  const root = tempRoot('myterminal-redact-audit-');
  try {
    const config = configFor(root);
    const store = new MyTerminalStore(config.stateDir);
    const created = store.registerRoot({ name: 'redact-root' });
    store.auditEvent(created.session.id, {
      id: 'act_redact_1',
      timestamp: new Date().toISOString(),
      source: 'actions',
      action: 'secret_action',
      status: 'completed',
      durationMs: 1,
      workspace: config.workspaceDir,
      session: created.session.id,
      args: { password: PASSWORD, token: TOKEN },
      result: { data: { apiKey: SECRET } },
    });
    const history = fs.readFileSync(path.join(config.stateDir, 'history', `${created.session.id}.jsonl`), 'utf8');
    assert.equal(history.includes(PASSWORD), false, `raw password leaked into audit: ${history}`);
    assert.equal(history.includes(TOKEN), false, `raw token leaked into audit: ${history}`);
    assert.equal(history.includes(SECRET), false, 'raw secret leaked into audit');
    assert.match(history, /\[REDACTED\]/, 'expected redaction marker in audit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Single source: object form redacts by sensitive key, body/content, and
// free-string secrets, while preserving non-secret structure. ──
test('single source: redact() object form redacts secrets and preserves shape', () => {
  const input = {
    action: 'x',
    args: { password: PASSWORD, token: TOKEN, nested: { apiKey: SECRET } },
    result: { data: { secret: SECRET } },
    error: { message: `boom token=${TOKEN}` },
    body: 'a fairly long secret body value',
    unchanged: 'hello world',
  };
  const out = redact(input);
  assert.equal(out.args.password, '[REDACTED]');
  assert.equal(out.args.token, '[REDACTED]');
  assert.equal(out.args.nested.apiKey, '[REDACTED]');
  assert.equal(out.result.data.secret, '[REDACTED]');
  assert.match(out.body, /\[REDACTED \d+ chars\]/);
  assert.equal(out.unchanged, 'hello world');
  assert.equal(out.error.message.includes(TOKEN), false, 'free-string secret in error not redacted');
  assert.match(out.error.message, /token=\[REDACTED\]/);
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes(PASSWORD), false);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(SECRET), false);
});

// ── Single source: string form redacts token=/Bearer/?key= patterns. ──
test('single source: redact() string form redacts inline secret patterns', () => {
  const raw = `token=${TOKEN} and Bearer ${SECRET} and ?key=${PASSWORD}`;
  const out = redact(raw);
  assert.equal(out.includes(TOKEN), false);
  assert.equal(out.includes(SECRET), false);
  assert.equal(out.includes(PASSWORD), false);
  assert.match(out, /token=\[REDACTED\]/);
  assert.match(out, /Bearer \[REDACTED\]/);
});

// ── Exit: error message — the mechanism safeErrorMessage() now routes through. ──
test('exit: error message redaction (safeErrorMessage path) drops raw secret', () => {
  const msg = `Update failed during snapshot: Authorization: Bearer ${SECRET}`;
  const out = redact(msg);
  assert.equal(out.includes(SECRET), false, `raw secret in error message: ${out}`);
  assert.match(out, /\[REDACTED\]/);
});

// ── Exit: audit sink payload — the exact transform logAuditEvent() now applies
// to its ToolAuditEvent before persisting to runtime.jsonl. ──
test('exit: audit sink payload is redacted by single source', () => {
  const event = {
    id: 'act_redact_2',
    timestamp: new Date().toISOString(),
    source: 'actions',
    action: 'secret_action',
    status: 'failed',
    durationMs: 3,
    workspace: '/tmp/w',
    session: 's1',
    args: { password: PASSWORD, token: TOKEN },
    result: { data: { apiKey: SECRET } },
    error: { code: 'X', message: `fail token=${TOKEN}` },
  };
  const sink = redact(event);
  const serialized = JSON.stringify(sink);
  assert.equal(serialized.includes(PASSWORD), false);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(sink.args.password, '[REDACTED]');
});
