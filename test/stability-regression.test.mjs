import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';

import { ControlChannelMonitor, classifyControlChannelFailure, exponentialBackoffDelay } from '../dist/control-channel.js';
import { WorkspaceDiffTracker } from '../dist/diff.js';
import { ExtensionService } from '../dist/extensions.js';
import { MyTerminalRuntime } from '../dist/server.js';
import { MyTerminalStore } from '../dist/store.js';
import { readRuntimeLifecycle } from '../dist/runtime-lifecycle.js';
import { executeUpdateTransaction, readUpdateHistory } from '../dist/update-transaction.js';
import { installUpdate, restoreUpdateData, snapshotUpdateData } from '../dist/update.js';
import { buildOpenApi } from '../dist/openapi.js';
import { workspaceId } from '../dist/instances.js';

const CONNECTOR_KEY = 'connector-key-stability-1234567890';
const ACTIONS_TOKEN = 'actions-token-stability-12345678901234567890';

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
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
    connectorKey: CONNECTOR_KEY,
    actionsToken: ACTIONS_TOKEN,
    publicBaseUrl: '',
    maxOutputChars: 20_000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
  };
}

function tool(name, invoke, properties = {}) {
  return {
    name,
    title: name,
    description: `Test tool ${name}`,
    inputSchema: { type: 'object', properties, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    invoke,
  };
}

async function waitFor(predicate, timeoutMs = 2_000, intervalMs = 5) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms.`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('Actions OpenAPI explicitly exposes workspaceId for root bootstrap', () => {
  const root = tempRoot('myterminal-openapi-workspace-');
  try {
    const document = buildOpenApi({ ...configFor(root), publicBaseUrl: 'https://example.test' });
    const input = document.components.schemas.ExtensionToolInput;
    assert.ok(input.properties.workspaceId);
    const example = document.paths['/actions/extensions/call'].post.requestBody.content['application/json'].examples.registerRoot.value;
    assert.equal(example.input.workspaceId, 'workspace-id-from-extensionDiscover');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('diff capture terminates at line budget and unchanged refresh keeps revision stable', async () => {
  const root = tempRoot('myterminal-diff-budget-');
  const config = configFor(root);
  try {
    execFileSync('git', ['init', '-q'], { cwd: config.workspaceDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: config.workspaceDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: config.workspaceDir });
    const file = path.join(config.workspaceDir, 'large.txt');
    fs.writeFileSync(file, 'a\n'.repeat(5000));
    execFileSync('git', ['add', 'large.txt'], { cwd: config.workspaceDir });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: config.workspaceDir });
    fs.writeFileSync(file, 'b\n'.repeat(5000));
    const tracker = new WorkspaceDiffTracker(config, 60_000, 100_000, 200, 20);
    await tracker.refresh();
    const first = tracker.snapshot();
    assert.ok(first.lines.length <= 200);
    assert.equal(first.truncated, true);
    assert.ok(first.truncationReasons.some((reason) => /line/.test(reason)));
    await tracker.refresh();
    const second = tracker.snapshot();
    assert.equal(second.updatedAt, first.updatedAt);
    tracker.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('healthy control polling emits one connected state across repeated probes', async () => {
  let calls = 0;
  const states = [];
  const monitor = new ControlChannelMonitor({
    baseUrl: 'https://example.test',
    healthyIntervalMs: 2,
    fetcher: async () => { calls += 1; return new Response('{"ok":true,"product":"myterminal"}', { status: 200 }); },
    onState: (state) => states.push(state),
  });
  monitor.start();
  await waitFor(() => calls >= 3);
  monitor.stop();
  assert.ok(calls >= 3);
  assert.equal(states.filter((state) => state.phase === 'connected').length, 1);
});

test('shared port has one control monitor and public Actions schema completes discover to workspace register', async () => {
  const root = tempRoot('myterminal-shared-control-actions-');
  const sharedConfig = path.join(root, 'config');
  fs.mkdirSync(sharedConfig, { recursive: true });
  const port = await freePort();
  const makeConfig = (name) => {
    const workspaceDir = path.join(root, `workspace-${name}`);
    const stateDir = path.join(root, `state-${name}`);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    return {
      workspaceDir,
      stateDir,
      settingsPath: path.join(sharedConfig, `${name}.json`),
      host: '127.0.0.1',
      port,
      connectorKey: CONNECTOR_KEY,
      actionsToken: ACTIONS_TOKEN,
      publicBaseUrl: 'https://control.example.test',
      maxOutputChars: 20_000,
      commandTimeoutSec: 10,
      uiLanguage: 'en',
      uiTheme: 'dark',
      passiveLockEnabled: false,
    };
  };
  const configA = makeConfig('a');
  const configB = makeConfig('b');
  const runtimeA = new MyTerminalRuntime(configA);
  const runtimeB = new MyTerminalRuntime(configB);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'control.example.test') {
      return new Response(JSON.stringify({ ok: true, product: 'myterminal', workspaceId: url.searchParams.get('workspaceId') }), { status: 200 });
    }
    return originalFetch(input, init);
  };
  try {
    await runtimeA.start();
    await runtimeB.start();
    await waitFor(() => [runtimeA.controlChannelStatus(), runtimeB.controlChannelStatus()].filter(Boolean).length === 1);
    assert.equal([runtimeA.controlChannelStatus(), runtimeB.controlChannelStatus()].filter(Boolean).length, 1);

    const base = `http://127.0.0.1:${port}`;
    const schema = await (await originalFetch(`${base}/openapi.json`)).json();
    assert.ok(schema.components.schemas.ExtensionToolInput.properties.workspaceId);
    const headers = { Authorization: `Bearer ${ACTIONS_TOKEN}`, 'Content-Type': 'application/json' };
    const discover = await (await originalFetch(`${base}/actions/extensions/discover`, {
      method: 'POST', headers, body: JSON.stringify({ query: 'session' }),
    })).json();
    assert.equal(discover.ok, true);
    assert.ok(discover.data.workspaces.some((item) => item.id === workspaceId(configB.workspaceDir)));
    const register = await (await originalFetch(`${base}/actions/extensions/call`, {
      method: 'POST', headers, body: JSON.stringify({ tool: 'session_register', input: { mode: 'root', workspaceId: workspaceId(configB.workspaceDir), name: 'actions-bootstrap', role: 'lead' } }),
    })).json();
    assert.equal(register.ok, true);
    assert.equal(register.data.result.session.name, 'actions-bootstrap');
  } finally {
    globalThis.fetch = originalFetch;
    await runtimeB.close().catch(() => undefined);
    await runtimeA.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('action lifecycle audit records start, success, failure, timeout, workspace scope, and clears pending actions', async () => {
  const root = tempRoot('myterminal-action-audit-');
  const config = configFor(root);
  const store = new MyTerminalStore(config.stateDir);
  let releaseHang;
  const hang = new Promise((resolve) => { releaseHang = resolve; });
  const tools = new Map([
    ['ok_action', tool('ok_action', async (input) => ({ value: 'ok', echoed: input.label }), { label: { type: 'string' } })],
    ['timeout_action', tool('timeout_action', async () => ({ command: 'fake', cwd: config.workspaceDir, exitCode: null, signal: 'SIGTERM', timedOut: true, stdout: '', stderr: '', truncated: false, durationMs: 1 }), { token: { type: 'string' } })],
    ['domain_action', tool('domain_action', async () => ({ timedOut: true, status: 'legitimate-domain-field' }))],
    ['hang_action', tool('hang_action', async () => { await hang; return { value: 'late' }; })],
    ['secret_failure', tool('secret_failure', async (input) => { throw new Error(`failure echoed ${input.token}`); }, { token: { type: 'string' } })],
  ]);
  const streamed = [];
  const service = new ExtensionService(config, store, tools, (event) => streamed.push(event));
  const created = store.registerRoot({ name: 'audit-root' });
  const identity = created.identity;
  try {
    const discovered = await service.discover({ identity, query: 'ok' }, { transport: 'actions' });
    assert.equal(discovered.ok, true);

    const ok = await service.call({ tool: 'ok_action', input: { label: 'complete input value' }, identity }, { transport: 'actions' });
    assert.equal(ok.ok, true);

    const timeout = await service.call({ tool: 'timeout_action', input: { token: 'DO-NOT-PERSIST' }, identity }, { transport: 'actions' });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.error.code, 'ACTION_TIMEOUT');

    const domain = await service.call({ tool: 'domain_action', input: {}, identity }, { transport: 'actions' });
    assert.equal(domain.ok, true);

    const failed = await service.call({ tool: 'missing_action', input: {}, identity }, { transport: 'actions' });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'NOT_FOUND');

    const secretFailure = await service.call({ tool: 'secret_failure', input: { token: 'ERROR-SECRET-MUST-NOT-PERSIST' }, identity }, { transport: 'actions' });
    assert.equal(secretFailure.ok, false);

    const pendingCall = service.call({ tool: 'hang_action', input: {}, identity }, { transport: 'actions' });
    await waitFor(() => service.activeActionCount() === 1);
    assert.equal(service.activeActionCount(), 1);
    assert.equal(service.pendingActions().length, 1);
    assert.equal(service.expirePendingActions(0, 'resume cleanup'), 1);
    assert.equal(service.activeActionCount(), 0);
    releaseHang();
    await pendingCall;

    const facts = store.auditFacts(100);
    assert.equal(facts.filter((fact) => fact.action === 'extension_discover').length, 1);
    assert.ok(facts.some((fact) => fact.action === 'extension_discover' && fact.status === 'completed'));
    assert.equal(facts.filter((fact) => fact.action === 'ok_action').length, 1);
    const completed = facts.find((fact) => fact.action === 'ok_action');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.source, 'actions');
    assert.equal(completed.args.label, 'complete input value');
    assert.equal(completed.result.data.result.echoed, 'complete input value');
    assert.ok(completed.timestamp);
    assert.ok(completed.completedAt);
    assert.ok(facts.some((fact) => fact.action === 'timeout_action' && fact.status === 'timeout' && fact.errorCode === 'ACTION_TIMEOUT'));
    assert.ok(facts.some((fact) => fact.action === 'domain_action' && fact.status === 'completed'));
    assert.equal(facts.some((fact) => fact.action === 'domain_action' && fact.status === 'timeout'), false);
    assert.ok(facts.some((fact) => fact.action === 'missing_action' && fact.status === 'failed'));
    assert.ok(facts.some((fact) => fact.action === 'hang_action' && fact.errorCode === 'PENDING_ACTION_CLEARED'));
    assert.equal(facts.every((fact) => fact.workspace === config.workspaceDir), true);
    assert.equal(facts.every((fact) => fact.session === created.session.id), true);
    assert.equal(service.activeActionCount(), 0);
    assert.ok(streamed.some((event) => event.status === 'running'));
    assert.ok(streamed.some((event) => event.status === 'completed'));
    assert.ok(streamed.some((event) => event.status === 'timeout'));

    const history = fs.readFileSync(path.join(config.stateDir, 'history', `${created.session.id}.jsonl`), 'utf8');
    assert.equal(history.includes('DO-NOT-PERSIST'), false);
    assert.equal(history.includes('ERROR-SECRET-MUST-NOT-PERSIST'), false);
    assert.equal(history.includes('failure echoed ERROR-SECRET-MUST-NOT-PERSIST'), false);
    assert.match(history, /\[REDACTED\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('control channel classifies Cloudflare/backend failures and reconnects with bounded exponential backoff', async () => {
  assert.equal(classifyControlChannelFailure({ statusCode: 502 }), 'backend_502');
  assert.equal(classifyControlChannelFailure({ statusCode: 530, body: 'Cloudflare Tunnel error 1033' }), 'cloudflare_1033');
  assert.equal(classifyControlChannelFailure({ error: new Error('request timed out') }), 'timeout');
  assert.equal(classifyControlChannelFailure({ error: new Error('connect ECONNREFUSED 127.0.0.1') }), 'backend_unavailable');
  assert.deepEqual([1, 2, 3, 4, 5].map((attempt) => exponentialBackoffDelay(attempt, 100, 500)), [100, 200, 400, 500, 500]);

  let calls = 0;
  let recovered = 0;
  const states = [];
  const monitor = new ControlChannelMonitor({
    baseUrl: 'https://example.test',
    baseDelayMs: 1,
    maxDelayMs: 5,
    timeoutMs: 50,
    fetcher: async () => {
      calls += 1;
      return calls === 1 ? new Response('bad gateway', { status: 502 }) : new Response('{"ok":true,"product":"myterminal"}', { status: 200 });
    },
    onState: (state) => states.push(state),
    onRecovered: () => { recovered += 1; },
  });
  monitor.start();
  await waitFor(() => calls >= 2 && monitor.snapshot().phase === 'connected');
  const snapshot = monitor.snapshot();
  monitor.stop();
  assert.ok(calls >= 2);
  assert.equal(snapshot.phase, 'connected');
  assert.equal(snapshot.attempt, 0);
  assert.ok(recovered >= 1);
  assert.ok(states.some((state) => state.phase === 'disconnected' && state.classification === 'backend_502'));
  assert.ok(states.some((state) => state.phase === 'recovering'));
});

test('one workspace control-channel outage does not alter another workspace monitor', async () => {
  const statesA = [];
  const statesB = [];
  const monitorA = new ControlChannelMonitor({
    baseUrl: 'https://workspace-a.example.test',
    baseDelayMs: 2,
    maxDelayMs: 5,
    timeoutMs: 50,
    fetcher: async () => new Response('Cloudflare Tunnel error 1033', { status: 530 }),
    onState: (state) => statesA.push(state),
  });
  const monitorB = new ControlChannelMonitor({
    baseUrl: 'https://workspace-b.example.test',
    baseDelayMs: 2,
    maxDelayMs: 5,
    timeoutMs: 50,
    fetcher: async () => new Response('{"ok":true,"product":"myterminal"}', { status: 200 }),
    onState: (state) => statesB.push(state),
  });
  monitorA.start();
  monitorB.start();
  await waitFor(() => monitorA.snapshot().phase === 'disconnected' && monitorB.snapshot().phase === 'connected');
  const snapshotA = monitorA.snapshot();
  const snapshotB = monitorB.snapshot();
  monitorA.stop();
  monitorB.stop();
  assert.equal(snapshotA.phase, 'disconnected');
  assert.equal(snapshotA.classification, 'cloudflare_1033');
  assert.equal(snapshotB.phase, 'connected');
  assert.equal(snapshotB.attempt, 0);
  assert.equal(statesB.some((state) => state.phase === 'disconnected'), false);
  assert.ok(statesA.some((state) => state.phase === 'disconnected'));
});

test('update transaction records all stages and classifies snapshot, install, migration, restart, recovery, and rollback failures', async () => {
  const stages = [
    { name: 'snapshot', snapshot: () => { throw new Error('snapshot failed'); } },
    { name: 'install', install: async () => { throw new Error('install failed token=UPDATE-SECRET'); } },
    { name: 'migration', migrate: async () => { throw new Error('migration failed'); } },
    { name: 'restart', restart: async () => { throw new Error('restart failed'); } },
  ];
  for (const scenario of stages) {
    const root = tempRoot(`myterminal-update-${scenario.name}-`);
    let rollbackCalls = 0;
    try {
      await assert.rejects(executeUpdateTransaction({
        historyRoot: root,
        oldVersion: '1.1.1',
        newVersion: '9.9.9',
        snapshot: scenario.snapshot || (() => ({ id: 'snapshot' })),
        install: scenario.install || (async () => undefined),
        migrate: scenario.name === 'migration' ? scenario.migrate : undefined,
        restart: scenario.name === 'restart' ? scenario.restart : undefined,
        restore: (_snapshot, force) => {
          if (force) rollbackCalls += 1;
          return { restored: [], skipped: [], failed: [], credentialsPreserved: true };
        },
      }), (error) => {
        assert.match(error.audit.error.code, new RegExp(`UPDATE_${scenario.name.toUpperCase()}`));
        return true;
      });
      const history = readUpdateHistory(root, 100);
      assert.equal(history[0].event, 'start');
      assert.equal(history.at(-1).event, 'complete');
      assert.equal(history.at(-1).status, 'failed');
      assert.equal(rollbackCalls, scenario.name === 'snapshot' ? 0 : 1);
      if (scenario.name === 'install') {
        const encoded = fs.readFileSync(path.join(root, 'update-history.jsonl'), 'utf8');
        assert.equal(encoded.includes('UPDATE-SECRET'), false);
        assert.match(encoded, /\[REDACTED\]/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const recoveryRoot = tempRoot('myterminal-update-recovery-');
  try {
    let restores = 0;
    await assert.rejects(executeUpdateTransaction({
      historyRoot: recoveryRoot,
      oldVersion: '1.1.1',
      newVersion: '9.9.9',
      snapshot: () => ({ id: 'snapshot' }),
      install: async () => undefined,
      restore: (_snapshot, force) => {
        restores += 1;
        if (!force) return { restored: [], skipped: [], failed: [{ file: 'state.json', error: 'partial' }], credentialsPreserved: true };
        throw new Error('rollback failed');
      },
    }), (error) => {
      assert.equal(error.audit.rollbackResult, 'failed');
      assert.equal(error.audit.recoveryResult, 'failed');
      return true;
    });
    assert.equal(restores, 2);
    const history = readUpdateHistory(recoveryRoot, 100);
    assert.ok(history.some((entry) => entry.stage === 'recovery' && entry.status === 'failed'));
    assert.ok(history.some((entry) => entry.stage === 'rollback' && entry.error.code === 'UPDATE_ROLLBACK_FAILED'));
  } finally {
    fs.rmSync(recoveryRoot, { recursive: true, force: true });
  }
});

test('failed update restores data and credentials byte-for-byte, remains restartable, and a second update can succeed', async () => {
  const root = tempRoot('myterminal-update-integrity-');
  const workspaceDir = path.join(root, 'workspace');
  const stateDir = path.join(root, 'workspaces', 'a');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(root, 'config.json');
  const statePath = path.join(stateDir, 'state.json');
  const logPath = path.join(stateDir, 'runtime.jsonl');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, workspaceDir: '/tmp/a' }, null, 2));
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 2, revision: 9, sessions: [], messages: [], events: [], subscriptions: [], appBindings: [], extensions: [] }));
  fs.writeFileSync(logPath, '{"message":"before"}\n');
  const before = new Map([[configPath, fs.readFileSync(configPath)], [statePath, fs.readFileSync(statePath)], [logPath, fs.readFileSync(logPath)]]);
  try {
    await assert.rejects(installUpdate('9.9.9', {
      root,
      oldVersion: '1.1.1',
      restartReason: 'failure_matrix_test',
      installer: async () => {
        fs.writeFileSync(configPath, JSON.stringify({ connectorKey: 'rotated', actionsToken: 'rotated' }));
        fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 2, revision: 1, sessions: [], messages: [], events: [], subscriptions: [], appBindings: [], extensions: [] }));
        fs.writeFileSync(logPath, '');
        throw new Error('replacement interrupted');
      },
    }));
    for (const [file, content] of before) assert.deepEqual(fs.readFileSync(file), content);
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(parsed.connectorKey, CONNECTOR_KEY);
    assert.equal(parsed.actionsToken, ACTIONS_TOKEN);

    const runtime = new MyTerminalRuntime({
      workspaceDir,
      stateDir,
      settingsPath: configPath,
      host: '127.0.0.1',
      port: 0,
      connectorKey: CONNECTOR_KEY,
      actionsToken: ACTIONS_TOKEN,
      publicBaseUrl: '',
      maxOutputChars: 20_000,
      commandTimeoutSec: 10,
      uiLanguage: 'en',
      uiTheme: 'dark',
      passiveLockEnabled: false,
    });
    await runtime.start();
    assert.equal(readRuntimeLifecycle(stateDir).phase, 'active');
    await runtime.revalidateAfterResume('post-update restart validation');
    assert.equal(readRuntimeLifecycle(stateDir).phase, 'active');
    assert.ok(runtime.logs.some((entry) => /log persistence revalidated/.test(entry.message)));
    await runtime.close();
    assert.equal(readRuntimeLifecycle(stateDir).phase, 'stopped');

    const successful = await installUpdate('9.9.9', {
      root,
      oldVersion: '1.1.1',
      restartReason: 'retry_after_rollback',
      installer: async () => undefined,
      migrate: async () => undefined,
      restart: async () => undefined,
    });
    assert.equal(successful.status, 'succeeded');
    assert.equal(successful.migrationResult, 'succeeded');
    assert.ok(readUpdateHistory(root, 100).some((entry) => entry.restartReason === 'retry_after_rollback' && entry.status === 'succeeded'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('update lock rejects concurrent writers and failed replacement restores installed current pointer', async () => {
  const root = tempRoot('myterminal-update-lock-');
  const packageRoot = path.join(root, 'installation');
  const configRoot = path.join(root, 'config');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, 'config.json'), JSON.stringify({ connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN }));
  let releaseInstall;
  const installGate = new Promise((resolve) => { releaseInstall = resolve; });
  try {
    const first = installUpdate('9.9.9', {
      root: configRoot,
      installationRoot: packageRoot,
      oldVersion: '1.1.1',
      installer: async () => { await installGate; },
    });
    for (let attempt = 0; attempt < 50 && !fs.existsSync(path.join(configRoot, 'update.lock')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await assert.rejects(installUpdate('9.9.9', {
      root: configRoot,
      installationRoot: packageRoot,
      oldVersion: '1.1.1',
      installer: async () => undefined,
    }), /Another MyTerminal update is active/);
    releaseInstall();
    await first;
    assert.equal(fs.existsSync(path.join(configRoot, 'update.lock')), false);

    fs.writeFileSync(path.join(configRoot, 'update.lock'), '{');
    await assert.rejects(installUpdate('9.9.9', {
      root: configRoot,
      installationRoot: packageRoot,
      oldVersion: '1.1.1',
      installer: async () => undefined,
    }), /update lock is being initialized/);
    fs.rmSync(path.join(configRoot, 'update.lock'), { force: true });

    const oldRelease = path.join(packageRoot, 'releases', 'v1.1.1');
    fs.mkdirSync(oldRelease, { recursive: true });
    fs.writeFileSync(path.join(oldRelease, process.platform === 'win32' ? 'myterminal.exe' : 'myterminal'), 'old');
    fs.writeFileSync(path.join(packageRoot, 'current'), 'v1.1.1\n');
    await assert.rejects(installUpdate('9.9.9', {
      root: configRoot,
      installationRoot: packageRoot,
      oldVersion: '1.1.1',
      installer: async () => {
        const next = path.join(packageRoot, 'releases', 'v9.9.9');
        fs.mkdirSync(next, { recursive: true });
        fs.writeFileSync(path.join(next, process.platform === 'win32' ? 'myterminal.exe' : 'myterminal'), 'new');
        fs.writeFileSync(path.join(packageRoot, 'current'), 'v9.9.9\n');
        throw new Error('replacement interrupted');
      },
    }));
    assert.equal(fs.readFileSync(path.join(packageRoot, 'current'), 'utf8').trim(), 'v1.1.1');
    let failed = readUpdateHistory(configRoot, 20).filter((entry) => entry.event === 'complete' && entry.status === 'failed').at(-1);
    assert.equal(failed.rollbackResult, 'succeeded');

    fs.rmSync(oldRelease, { recursive: true, force: true });
    fs.writeFileSync(path.join(packageRoot, 'current'), 'v1.1.1\n');
    await assert.rejects(installUpdate('9.9.9', {
      root: configRoot,
      installationRoot: packageRoot,
      oldVersion: '1.1.1',
      installer: async () => {
        fs.writeFileSync(path.join(packageRoot, 'current'), 'v9.9.9\n');
        throw new Error('replacement interrupted without rollback binary');
      },
    }));
    failed = readUpdateHistory(configRoot, 20).filter((entry) => entry.event === 'complete' && entry.status === 'failed').at(-1);
    assert.equal(failed.rollbackResult, 'partial_failure');
  } finally {
    releaseInstall?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('update backups, histories, credentials, and rollback remain isolated per workspace/config root', () => {
  const parent = tempRoot('myterminal-update-isolation-');
  const rootA = path.join(parent, 'a');
  const rootB = path.join(parent, 'b');
  for (const [root, key] of [[rootA, 'A'], [rootB, 'B']]) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ connectorKey: `connector-${key}`, actionsToken: `token-${key}` }));
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ schemaVersion: 2, revision: key === 'A' ? 10 : 20, sessions: [{ id: key }], messages: [] }));
  }
  try {
    const snapshotA = snapshotUpdateData(rootA);
    fs.writeFileSync(path.join(rootA, 'config.json'), JSON.stringify({ connectorKey: 'bad-A', actionsToken: 'bad-A' }));
    fs.writeFileSync(path.join(rootB, 'config.json'), JSON.stringify({ connectorKey: 'changed-B', actionsToken: 'changed-B' }));
    const restored = restoreUpdateData(snapshotA, rootA, true);
    assert.equal(restored.failed.length, 0);
    assert.equal(restored.credentialsPreserved, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(rootA, 'config.json'), 'utf8')).connectorKey, 'connector-A');
    assert.equal(JSON.parse(fs.readFileSync(path.join(rootB, 'config.json'), 'utf8')).connectorKey, 'changed-B');
    assert.equal(snapshotA.backupDir.startsWith(path.join(rootA, 'update-backups')), true);
    assert.equal(fs.existsSync(path.join(rootB, 'update-backups')), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
