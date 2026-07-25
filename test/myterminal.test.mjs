import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { act, createElement } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { MyTerminalRuntime } from '../dist/server.js';
import { ExtensionService } from '../dist/extensions.js';
import { MyTerminalStore, SESSION_TIMING } from '../dist/store.js';
import { WorkspaceDiffTracker } from '../dist/diff.js';
import { conversationGroups, logicalSessionGroups, selectedViewport } from '../dist/tui-model.js';
import { phaseColor, presenceColor, themeFor, TuiController } from '../dist/tui/state.js';
import { initialQuestionState, nextTextValue, optionAnswer, toggleSelectedOption, workspaceChoiceQuestion, workspaceOptionLabel } from '../dist/tui/form-model.js';
import { assessRuntimeEnvironment, createDefaultSettings, loadMyTerminalConfig, readMyTerminalSettings, rotateMyTerminalCredentials, saveMyTerminalSettings, settingsPath, validateSettingsFeasibility } from '../dist/config.js';
import { activeWorkspaceRuntimePids, appendWorkspaceLog, findAvailablePort, readWorkspaceLogs, readWorkspaceRegistry, resolveWorkspaceInput, upsertWorkspaceRecord, workspaceChoiceHint, workspaceId } from '../dist/instances.js';
import { migrateWorkspaceState } from '../dist/migration.js';
import { checkForUpdate, installedVersion, installationRoot, isNewerVersion, isSourceCheckout } from '../dist/update.js';
import { clusterKey, PortClusterRegistry, tokenHash } from '../dist/cluster.js';
import { disarmAllSessionResources, disarmSessionResources, passiveLockStatus } from '../dist/session-resources.js';
import { ADD_WORKSPACE_ID, isAddWorkspaceSelection, selectedWorkspace, workspaceSelectionIndex, workspaceSelectionItems } from '../dist/workspace-selection.js';
import { runtimeSettingsSnapshot } from '../dist/runtime-settings.js';
import { buildWorkspaceSelectorModel } from '../dist/tui/workspace-selector.js';
import { WorkspaceCatalog } from '../dist/workspace-catalog.js';
import { nextCredentialVisibility } from '../dist/tui/credential-visibility.js';
import { rendererProfile, windowsTuiMode } from '../dist/tui/renderer-profile.js';

const CONNECTOR_KEY = 'test-connector-key-1234567890';
const ACTIONS_TOKEN = 'test-actions-token-12345678901234567890';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-'));
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

test('startup errors preserve bind details and the original cause', async () => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const dirs = tempWorkspace();
  const port = blocker.address().port;
  const runtime = new MyTerminalRuntime({ ...dirs, settingsPath: path.join(dirs.stateDir, 'test-settings.json'), host: '127.0.0.1', port, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: `http://127.0.0.1:${port}`, maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark' });
  try {
    await assert.rejects(runtime.start(), (error) => {
      assert.equal(error.code, 'EADDRINUSE');
      assert.equal(error.host, '127.0.0.1');
      assert.equal(error.port, port);
      assert.match(error.message, /Failed to start MyTerminal/);
      assert.match(error.message, /EADDRINUSE/);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  } finally {
    blocker.close();
    fs.rmSync(dirs.workspaceDir, { recursive: true, force: true });
  }
});

function actionsHeaders() { return { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' }; }
async function action(server, endpoint, body) {
  const response = await fetch(`${server.baseUrl}/actions/extensions/${endpoint}`, { method: 'POST', headers: actionsHeaders(), body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function call(server, tool, input = {}, identity) { return action(server, 'call', { tool, input, ...(identity ? { identity } : {}) }); }
async function root(server, name = 'main', continuesSessionId) {
  const response = await call(server, 'session_register', { mode: 'root', name, role: 'lead', ...(continuesSessionId ? { continuesSessionId } : {}) });
  assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.ok, true);
  return response.body.data.result;
}
const task = { objective: 'Implement the assigned slice.', background: 'The root session delegated bounded work.', deliverables: ['Code and summary'], acceptanceCriteria: ['Checks pass'], constraints: ['Stay within scope'] };

test('OpenTUI theme and structured session status colors stay deterministic', () => {
  const theme = themeFor('dark');
  assert.equal(phaseColor(theme, 'completed'), theme.good);
  assert.equal(phaseColor(theme, 'blocked'), theme.bad);
  assert.equal(presenceColor(theme, { presence: 'claimed' }), theme.good);
  assert.equal(presenceColor(theme, { presence: 'stale' }), theme.bad);
});

test('Windows TUI defaults to a bounded keyboard-compatible renderer profile', () => {
  const compatible = rendererProfile('win32', { WT_SESSION: 'terminal-host' });
  assert.equal(windowsTuiMode({ WT_SESSION: 'terminal-host' }), 'compatible');
  assert.deepEqual(compatible, {
    useThread: false,
    targetFps: 20,
    maxFps: 20,
    debounceDelay: 150,
    screenMode: 'main-screen',
    useMouse: false,
    enableMouseMovement: false,
    consoleMode: 'disabled',
    useKittyKeyboard: null,
  });

  const mouse = rendererProfile('win32', { MYTERMINAL_WINDOWS_TUI_MODE: 'mouse' });
  assert.equal(windowsTuiMode({ MYTERMINAL_WINDOWS_TUI_MODE: 'mouse' }), 'mouse');
  assert.equal(mouse.useMouse, true);
  assert.equal(mouse.useThread, false);
  assert.equal(mouse.screenMode, 'main-screen');

  const keymap = fs.readFileSync(path.join(process.cwd(), 'src/tui/keymap.ts'), 'utf8');
  for (const key of ['down', 'up', 'pagedown', 'pageup', 'home', 'end', 'return']) {
    assert.match(keymap, new RegExp(`key: '${key}'`));
  }

  const commands = fs.readFileSync(path.join(process.cwd(), 'src/core-tools.ts'), 'utf8');
  assert.match(commands, /command-tasks/);
  assert.match(commands, /displayCommand: args\.command/);
  assert.match(commands, /detached: true/);
  assert.match(commands, /if \(windowsTermination\) await windowsTermination/);
  assert.doesNotMatch(commands, /\['\/d', '\/s', '\/c', asString\(input\.command/);
});

test('OpenTUI ScrollBox owns wheel scrolling and renderer selection without click leakage', async () => {
  let mouseUps = 0;
  const lines = Array.from({ length: 30 }, (_, index) => createElement('text', { key: index, wrapMode: 'word' }, `row ${String(index).padStart(2, '0')} selectable content`));
  const ui = createElement('box', { width: 36, height: 8, onMouseUp: () => { mouseUps += 1; } },
    createElement('scrollbox', { width: 36, height: 8, focused: true, viewportCulling: true },
      createElement('box', { width: '100%', flexDirection: 'column' }, ...lines)));
  let setup;
  await act(async () => { setup = await testRender(ui, { width: 36, height: 8, useMouse: true, autoFocus: true }); await setup.flush(); });
  try {
    const before = setup.captureCharFrame();
    await act(async () => { await setup.mockMouse.scroll(8, 4, 'down'); await setup.flush(); });
    assert.notEqual(setup.captureCharFrame(), before);
    await act(async () => { await setup.mockMouse.drag(2, 2, 16, 2); await setup.flush(); });
    assert.equal(mouseUps, 1);
    assert.equal(setup.renderer.hasSelection, true);
    assert.ok(setup.renderer.getSelection()?.getSelectedText());
  } finally {
    await act(async () => { setup.renderer.destroy(); });
  }
});

function parseEventStreamJson(text) {
  const dataLine = text.split('\n').find((line) => line.startsWith('data: ')); assert.ok(dataLine, text); return JSON.parse(dataLine.slice(6));
}
async function rpcPost(url, payload, sessionId) {
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }; if (sessionId) headers['mcp-session-id'] = sessionId;
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) }); const text = await response.text();
  return { response, text, data: response.headers.get('content-type')?.includes('text/event-stream') ? parseEventStreamJson(text) : JSON.parse(text), sessionId: response.headers.get('mcp-session-id') };
}

test('TUI settings persist outside workspace and placeholder environment values are ignored', () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-config-workspace-')); const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-user-config-'));
  const env = { MYTERMINAL_CONFIG_DIR: configDir, MYTERMINAL_WORKSPACE_DIR: '/absolute/path/to/project', MYTERMINAL_PUBLIC_BASE_URL: 'https://replace-with-your-tunnel.example' };
  try {
    const settings = createDefaultSettings(workspaceDir); saveMyTerminalSettings(settings, env);
    assert.deepEqual(readMyTerminalSettings(env), { ...settings, workspaceDir: fs.realpathSync(workspaceDir) });
    const config = loadMyTerminalConfig(env); assert.equal(config.workspaceDir, fs.realpathSync(workspaceDir)); assert.equal(config.publicBaseUrl, 'http://127.0.0.1:3210');
    assert.equal(settingsPath(env), path.join(configDir, 'config.json')); assert.equal(fs.existsSync(path.join(workspaceDir, '.myterminal', 'config.json')), false);
    const legacy = { ...settings }; delete legacy.uiLanguage; delete legacy.uiTheme; delete legacy.passiveLockEnabled; delete legacy.actionsContinuationMode; delete legacy.nonBlockingTasksEnabled; fs.writeFileSync(settingsPath(env), JSON.stringify(legacy));
    assert.equal(readMyTerminalSettings(env).uiLanguage, 'zh-CN'); assert.equal(readMyTerminalSettings(env).uiTheme, 'dark'); assert.equal(readMyTerminalSettings(env).passiveLockEnabled, false); assert.equal(readMyTerminalSettings(env).actionsContinuationMode, 'off'); assert.equal(readMyTerminalSettings(env).nonBlockingTasksEnabled, false);
  } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); fs.rmSync(configDir, { recursive: true, force: true }); }
});

test('settings feasibility ignores a port owned by the current process and state survives outside a detached workspace', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-detachable-workspace-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-detachable-config-'));
  const env = { ...process.env, MYTERMINAL_CONFIG_DIR: configDir };
  const blocker = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  try {
    const port = blocker.address().port;
    const settings = { ...createDefaultSettings(workspaceDir), port };
    const errors = await validateSettingsFeasibility(settings, { host: settings.host, port: settings.port });
    assert.equal(errors.some((error) => error.includes('already in use')), false);
    saveMyTerminalSettings({ ...settings, port: 0 }, env);
    const config = loadMyTerminalConfig(env);
    assert.equal(config.stateDir.startsWith(configDir), true);
    assert.equal(config.stateDir.startsWith(workspaceDir), false);
    const store = new MyTerminalStore(config.stateDir);
    store.registerRoot({ name: 'survives-detach' });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    assert.equal(new MyTerminalStore(config.stateDir).listSessions()[0].name, 'survives-detach');
  } finally {
    blocker.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('workspace profiles isolate state and aggregate local logs', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-workspace-registry-'));
  const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-workspace-a-'));
  const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-workspace-b-'));
  const env = { ...process.env, MYTERMINAL_CONFIG_DIR: configDir };
  try {
    saveMyTerminalSettings({ ...createDefaultSettings(workspaceA), port: 0 }, env);
    const configA = loadMyTerminalConfig(env);
    const storeA = new MyTerminalStore(configA.stateDir);
    storeA.registerRoot({ name: 'workspace-a-session' });
    appendWorkspaceLog(configA.stateDir, { at: new Date().toISOString(), level: 'info', message: 'workspace A log' });

    saveMyTerminalSettings({ ...createDefaultSettings(workspaceB), port: 0 }, env);
    const configB = loadMyTerminalConfig(env);
    const storeB = new MyTerminalStore(configB.stateDir);
    storeB.registerRoot({ name: 'workspace-b-session' });
    appendWorkspaceLog(configB.stateDir, { at: new Date().toISOString(), level: 'info', message: 'workspace B log' });

    assert.notEqual(configA.stateDir, configB.stateDir);
    assert.equal(new MyTerminalStore(configA.stateDir).listSessions()[0].name, 'workspace-a-session');
    assert.equal(new MyTerminalStore(configB.stateDir).listSessions()[0].name, 'workspace-b-session');
    const records = readWorkspaceRegistry(configDir);
    assert.equal(records.length, 2);
    assert.equal(resolveWorkspaceInput('1', records), records[0].workspaceDir);
    assert.match(workspaceChoiceHint(records), /1=/);
    const logs = readWorkspaceLogs(configDir);
    assert.equal(logs.some((group) => group.entries.some((entry) => entry.message === 'workspace A log')), true);
    assert.equal(logs.some((group) => group.entries.some((entry) => entry.message === 'workspace B log')), true);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(workspaceA, { recursive: true, force: true });
    fs.rmSync(workspaceB, { recursive: true, force: true });
  }
});

test('workspace registry preserves concurrent process updates', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-workspace-registry-concurrent-'));
  try {
    const workers = Array.from({ length: 12 }, (_, index) => new Promise((resolve, reject) => {
      const workspaceDir = path.join(configDir, `workspace-${index}`);
      fs.mkdirSync(workspaceDir, { recursive: true });
      const code = `import { upsertWorkspaceRecord, workspaceId, workspaceStateDir } from ${JSON.stringify(new URL('../dist/instances.js', import.meta.url).href)}; const configDir=${JSON.stringify(configDir)}; const workspaceDir=${JSON.stringify(workspaceDir)}; upsertWorkspaceRecord(configDir,{id:workspaceId(workspaceDir),workspaceDir,stateDir:workspaceStateDir(configDir,workspaceDir),lastSeenAt:new Date().toISOString()});`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (exitCode) => exitCode === 0 ? resolve() : reject(new Error(`workspace registry worker exited ${exitCode}`)));
    }));
    await Promise.all(workers);
    const records = readWorkspaceRegistry(configDir);
    assert.equal(records.length, 12);
    assert.equal(new Set(records.map((item) => item.id)).size, 12);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('port conflict helpers choose a different available port', async () => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  try {
    const occupied = blocker.address().port;
    const available = await findAvailablePort('127.0.0.1', occupied);
    assert.notEqual(available, occupied);
    assert.ok(available > 0 && available <= 65535);
  } finally {
    blocker.close();
  }
});

test('workspace migration merges every legacy source without losing session content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-merge-migration-'));
  const target = path.join(root, 'target');
  const older = path.join(root, 'global');
  const workspace = path.join(root, 'workspace');
  for (const dir of [target, older, workspace]) fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  const base = { schemaVersion: 2, revision: 1, messages: [], events: [], subscriptions: [], appBindings: [], extensions: [] };
  const session = (id, summary, updatedAt) => ({ id, name: id, role: 'lead', phase: 'completed', presence: 'unclaimed', tags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt, latestCheckpoint: { at: updatedAt, phase: 'completed', summary }, finalSummary: summary });
  fs.writeFileSync(path.join(older, 'state.json'), JSON.stringify({ ...base, sessions: [session('a', 'old-a', '2026-01-01T00:00:00.000Z'), session('b', 'only-b', '2026-01-02T00:00:00.000Z')] }));
  fs.writeFileSync(path.join(workspace, 'state.json'), JSON.stringify({ ...base, revision: 4, sessions: [session('a', 'new-a', '2026-01-03T00:00:00.000Z'), session('c', 'only-c', '2026-01-04T00:00:00.000Z')] }));
  fs.writeFileSync(path.join(older, 'history', 'a.jsonl'), JSON.stringify({ at: '2026-01-01T00:00:00.000Z', type: 'checkpoint', data: { summary: 'old-a' } }) + '\n');
  fs.writeFileSync(path.join(workspace, 'history', 'a.jsonl'), JSON.stringify({ at: '2026-01-03T00:00:00.000Z', type: 'checkpoint', data: { summary: 'new-a' } }) + '\n');
  try {
    const first = migrateWorkspaceState(target, [older, workspace]);
    const second = migrateWorkspaceState(target, [older, workspace]);
    const state = JSON.parse(fs.readFileSync(path.join(target, 'state.json'), 'utf8'));
    assert.equal(first.sessions, 3);
    assert.equal(second.sessions, 3);
    assert.deepEqual(state.sessions.map((item) => item.id).sort(), ['a', 'b', 'c']);
    assert.equal(state.sessions.find((item) => item.id === 'a').finalSummary, 'new-a');
    const history = fs.readFileSync(path.join(target, 'history', 'a.jsonl'), 'utf8').trim().split('\n');
    assert.equal(history.length, 2);
    assert.match(history[0], /old-a/);
    assert.match(history[1], /new-a/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('update checker compares releases without blocking startup failures', async () => {
  assert.equal(isNewerVersion('v1.0.2', '1.0.1'), true);
  assert.equal(isNewerVersion('v1.0.1', '1.0.1'), false);
  const available = await checkForUpdate(async () => new Response(JSON.stringify({ tag_name: 'v1.2.0' }), { status: 200 }));
  assert.equal(available.updateAvailable, true);
  assert.equal(available.latestVersion, '1.2.0');
  const failed = await checkForUpdate(async () => new Response('offline', { status: 503 }));
  assert.equal(failed.updateAvailable, false);
  assert.match(failed.error, /HTTP 503/);
});

test('binary updater detects versioned installation roots and current versions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-versioned-install-'));
  const previous = process.env.MYTERMINAL_HOME;
  try {
    fs.mkdirSync(path.join(root, 'releases', 'v1.1.0'), { recursive: true });
    fs.writeFileSync(path.join(root, 'current'), 'v1.1.0\n');
    process.env.MYTERMINAL_HOME = root;
    assert.equal(installationRoot(), path.resolve(root));
    assert.equal(installedVersion(root), '1.1.0');
    assert.equal(isSourceCheckout(root), false);
    fs.mkdirSync(path.join(root, '.git'));
    assert.equal(isSourceCheckout(root), true);
  } finally {
    if (previous === undefined) delete process.env.MYTERMINAL_HOME;
    else process.env.MYTERMINAL_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cluster rejects incompatible protocol versions and legacy servers are not joinable', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-cluster-protocol-'));
  const first = new PortClusterRegistry(configDir, '127.0.0.1', 39991);
  const second = new PortClusterRegistry(configDir, '127.0.0.1', 39991);
  const member = (workspaceId, protocolVersion) => ({ pid: process.pid, appVersion: protocolVersion === 1 ? '1.0.1' : '2.0.0', protocolVersion, workspaceId, workspaceDir: `/tmp/${workspaceId}`, internalPort: 41000 + protocolVersion, connectorKey: CONNECTOR_KEY, actionsTokenHash: tokenHash(ACTIONS_TOKEN), secret: `secret-${workspaceId}` });
  try {
    first.register(member('workspace-one', 1));
    assert.throws(() => second.register(member('workspace-two', 2)), /incompatible MyTerminal cluster protocol/);
  } finally {
    first.unregister();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  const legacy = spawn(process.execPath, ['-e', `
    const net = require('node:net');
    const server = net.createServer((socket) => {
      const body = JSON.stringify({ ok: true, product: 'myterminal', version: '1.0.1' });
      socket.end('HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: ' + Buffer.byteLength(body) + '\\r\\nConnection: close\\r\\n\\r\\n' + body);
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    legacy.once('error', reject);
    legacy.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
  });
  try {
    const settings = { ...createDefaultSettings(process.cwd()), host: '127.0.0.1', port };
    const errors = await validateSettingsFeasibility(settings);
    assert.equal(errors.some((error) => error.includes('already in use')), true);
  } finally {
    const exited = new Promise((resolve) => legacy.once('exit', resolve));
    legacy.kill('SIGTERM');
    await exited;
  }
});


test('three workspaces share one port, route by workspace and session, and survive leader exit', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-shared-port-config-'));
  const blocker = net.createServer();
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
  const port = blocker.address().port;
  await new Promise((resolve) => blocker.close(resolve));
  const dirs = [tempWorkspace(), tempWorkspace(), tempWorkspace()];
  const settingsFile = path.join(configDir, 'config.json');
  const runtimes = dirs.map((item) => new MyTerminalRuntime({ ...item, settingsPath: settingsFile, host: '127.0.0.1', port, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: `http://127.0.0.1:${port}`, maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark' }));
  const server = { baseUrl: `http://127.0.0.1:${port}` };
  try {
    for (const runtime of runtimes) await runtime.start();
    const health = await fetch(`${server.baseUrl}/health`).then((response) => response.json());
    assert.equal(health.clustered, true);
    assert.equal(health.workspaces.length, 3);

    const missing = await call(server, 'session_register', { mode: 'root', name: 'ambiguous', role: 'lead' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'WORKSPACE_REQUIRED');

    const workspaceB = workspaceId(dirs[1].workspaceDir);
    const workspaceC = workspaceId(dirs[2].workspaceDir);
    const rootB = await call(server, 'session_register', { mode: 'root', name: 'workspace-b-root', role: 'lead', workspaceId: workspaceB });
    const rootC = await call(server, 'session_register', { mode: 'root', name: 'workspace-c-root', role: 'lead', workspaceId: workspaceC });
    assert.equal(rootB.body.ok, true, JSON.stringify(rootB.body));
    assert.equal(rootC.body.ok, true, JSON.stringify(rootC.body));

    const identityB = rootB.body.data.result.identity;
    const listB = await call(server, 'session_list', {}, identityB);
    assert.equal(listB.body.ok, true, JSON.stringify(listB.body));
    const namesB = listB.body.data.result.sessions.map((item) => item.name);
    assert.equal(namesB.includes('workspace-b-root'), true);
    assert.equal(namesB.includes('workspace-c-root'), false);

    let leaderAcceptedTrafficWhenUnregistered;
    const originalUnregister = runtimes[0].cluster.unregister.bind(runtimes[0].cluster);
    runtimes[0].cluster.unregister = () => {
      leaderAcceptedTrafficWhenUnregistered = Boolean(runtimes[0].publicServer?.listening);
      return originalUnregister();
    };
    await runtimes[0].close();
    assert.equal(leaderAcceptedTrafficWhenUnregistered, false, 'leader must stop public traffic before removing its workspace registration');
    const deadline = Date.now() + 8000;
    let recovered;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${server.baseUrl}/health`);
        if (response.ok) { recovered = await response.json(); break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(recovered, 'a follower should take over the public port');
    assert.equal(recovered.workspaces.length, 2);
    const afterFailover = await call(server, 'session_list', {}, identityB);
    assert.equal(afterFailover.body.ok, true, JSON.stringify(afterFailover.body));
  } finally {
    for (const runtime of runtimes.slice(1)) await runtime.close().catch(() => undefined);
    fs.rmSync(configDir, { recursive: true, force: true });
    for (const item of dirs) fs.rmSync(item.workspaceDir, { recursive: true, force: true });
  }
});

test('terminal session cleanup terminates a bound helper process', async () => {
  if (process.platform !== 'darwin') return;
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-resource-workspace-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-resource-state-'));
  const child = spawn(process.execPath, ['-e', "process.title='MyTerminalPassiveLock'; setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  const sessionId = 'ses_resource_cleanup_test';
  const directory = path.join(stateDir, 'session-resources');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${sessionId}.pid`), `${child.pid}
`);
  const config = { workspaceDir, stateDir };
  try {
    const result = disarmSessionResources(config, sessionId);
    assert.equal(result.disarmed, true);
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(fs.existsSync(path.join(directory, `${sessionId}.pid`)), false);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('session resource cleanup refuses to kill a reused unrelated PID', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-resource-workspace-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-resource-state-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const sessionId = 'ses_reused_pid_test';
  const directory = path.join(stateDir, 'session-resources');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${sessionId}.pid`), `${child.pid}\n`);
  try {
    const result = disarmSessionResources({ workspaceDir, stateDir }, sessionId);
    assert.equal(result.disarmed, false);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    assert.equal(fs.existsSync(path.join(directory, `${sessionId}.pid`)), false);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('session action targeting explicitly includes child sessions', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'src/tui/App.tsx'), 'utf8');
  const state = fs.readFileSync(path.join(process.cwd(), 'src/tui/state.ts'), 'utf8');
  const sessions = fs.readFileSync(path.join(process.cwd(), 'src/tui/screens/Sessions.tsx'), 'utf8');
  assert.match(app, /sessionAction\(\[\.\.\.group\.sessions, \.\.\.group\.children\], ask\)/);
  assert.match(state, /Session to operate on/);
  assert.match(state, /选择操作对象/);
  assert.match(state, /item\.parentSessionId/);
  assert.match(state, /optionsLayout: 'column'/);
  assert.match(state, /Target/);
  assert.match(state, /操作对象/);
  assert.match(state, /item\.children\.some\(\(child\) => child\.id === session\.id\)/);
  assert.match(sessions, /按 u 后选择具体根\/续作\/子 session/);
});

test('startup usability gates keep workspace options scrollable and cancellation non-fatal', () => {
  const formDialog = fs.readFileSync(path.join(process.cwd(), 'src/tui/components/FormDialog.tsx'), 'utf8');
  const tuiIndex = fs.readFileSync(path.join(process.cwd(), 'src/tui/index.tsx'), 'utf8');
  const cli = fs.readFileSync(path.join(process.cwd(), 'src/cli.ts'), 'utf8');
  const state = fs.readFileSync(path.join(process.cwd(), 'src/tui/state.ts'), 'utf8');
  assert.match(formDialog, /ScrollBoxRenderable/);
  assert.match(formDialog, /scrollChildIntoView/);
  assert.match(formDialog, /height=\{Math\.max\(3, Math\.min\(16, height - 10\)\)\}/);
  assert.match(tuiIndex, /onCancel: \(\) => resolve\(undefined\)/);
  assert.match(tuiIndex, /onCancel: \(\) => resolve\('cancel'\)/);
  assert.match(cli, /class StartupCancelled extends Error/);
  assert.match(cli, /if \(!headless && !\(await chooseWorkspace\(env\)\)\) return/);
  assert.match(cli, /throw new StartupCancelled\(\)/);
  assert.match(cli, /error instanceof StartupCancelled/);
  assert.doesNotMatch(state, /Registered workspaces:/);
  assert.doesNotMatch(state, /已登记工作区：/);
  assert.match(state, /buildWorkspaceSelectorModel\(/);
});

test('consecutive form requests remount and reset request-local state', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'src/tui/App.tsx'), 'utf8');
  const dialog = fs.readFileSync(path.join(process.cwd(), 'src/tui/components/FormDialog.tsx'), 'utf8');
  assert.match(app, /id: number/);
  assert.match(app, /nextFormId\.current \+= 1/);
  assert.match(app, /setForm\(\{ id: nextFormId\.current, questions, preamble, resolve \}\)/);
  assert.match(app, /<FormDialog key=\{form\.id\}/);
  assert.match(dialog, /setIndex\(0\)/);
  assert.match(dialog, /setAnswers\(\[\]\)/);
  assert.match(dialog, /applyQuestionState\(0\)/);
  assert.match(dialog, /\}, \[questions\]\)/);
});

test('form option state submits the latest multi-select values and resets between questions', () => {
  const fields = { label: 'Choose settings', options: ['port', 'passive-lock'], multiSelect: true };
  const state = initialQuestionState(fields);
  assert.deepEqual(state.selectedOptions, []);
  const selected = toggleSelectedOption(state.selectedOptions, 'passive-lock');
  assert.equal(optionAnswer(fields, 1, selected), 'passive-lock');
  const nextQuestion = initialQuestionState({ label: 'Passive lock', fallback: 'standby', options: ['off', 'arm', 'standby'] });
  assert.equal(nextQuestion.optionIndex, 2);
  assert.deepEqual(nextQuestion.selectedOptions, []);
  assert.equal(nextTextValue('3000', '30001', true), '1');
  assert.equal(nextTextValue('3000', '3100', true), '3100');
  assert.equal(nextTextValue('3000', '30001', false), '30001');
  assert.equal(workspaceOptionLabel('MyTerminal', '/Users/example/myterminal', 'active · 127.0.0.1:3000'), 'MyTerminal\n/Users/example/myterminal\nactive · 127.0.0.1:3000');
  const manyWorkspaces = Array.from({ length: 40 }, (_, index) => ({ title: `Workspace ${index + 1}`, workspaceDir: `/tmp/workspace-${index + 1}`, status: index === 17 ? 'active · 127.0.0.1:3017' : 'inactive', active: index === 17 }));
  const workspaceQuestion = workspaceChoiceQuestion('Workspace', manyWorkspaces, 17);
  assert.equal(workspaceQuestion.optionsLayout, 'column');
  assert.equal(workspaceQuestion.options.length, 40);
  assert.equal(workspaceQuestion.optionLabels.length, 40);
  assert.equal(workspaceQuestion.fallback, '18');
  assert.equal(workspaceQuestion.optionLabels[17], 'Workspace 18');
  assert.equal(workspaceQuestion.optionDescriptions[17], '/tmp/workspace-18');
  assert.deepEqual(workspaceQuestion.optionBadges[17], { label: 'active · 127.0.0.1:3017', tone: 'good' });
  assert.deepEqual(workspaceQuestion.optionBadges[0], { label: 'inactive', tone: 'muted' });
});

test('workspace runtime leases follow repeated switches and never leak to previous workspaces', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-workspace-switch-leases-'));
  const settingsFile = path.join(configDir, 'settings.json');
  const dirs = ['A', 'B', 'C'].map((name) => {
    const workspaceDir = path.join(configDir, name);
    const stateDir = path.join(configDir, 'state', name);
    fs.mkdirSync(workspaceDir, { recursive: true });
    return { workspaceDir, stateDir };
  });
  const makeRuntime = (entry) => new MyTerminalRuntime({ ...entry, settingsPath: settingsFile, host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false });
  try {
    for (const index of [0, 1, 2, 0]) {
      const runtime = makeRuntime(dirs[index]);
      await runtime.start();
      const records = readWorkspaceRegistry(configDir);
      const active = records.filter((record) => record.lastPid === process.pid);
      assert.equal(active.length, 1);
      assert.equal(active[0].workspaceDir, dirs[index].workspaceDir);
      assert.equal(active[0].lastPort, runtime.port);
      await runtime.close();
      assert.equal(readWorkspaceRegistry(configDir).filter((record) => record.lastPid === process.pid).length, 0);
    }
    const records = readWorkspaceRegistry(configDir);
    const startup = buildWorkspaceSelectorModel({ label: '选择工作区', records, currentWorkspaceDir: dirs[0].workspaceDir, zh: true });
    const settings = buildWorkspaceSelectorModel({ label: '工作区', records, currentWorkspaceDir: dirs[0].workspaceDir, currentRuntime: { workspaceDir: dirs[0].workspaceDir, host: '127.0.0.1', port: 3101, pid: process.pid }, zh: true });
    assert.deepEqual(startup.question.optionLabels, settings.question.optionLabels);
    assert.deepEqual(startup.question.optionDescriptions, settings.question.optionDescriptions);
    assert.equal(new Set(startup.question.optionLabels).size, 4);
    assert.deepEqual(startup.question.optionLabels, ['A', 'B', 'C', '添加新的工作区…']);
    assert.ok(startup.items.every((item) => item.activity === 'inactive'));
    assert.equal(settings.items[0].activity, 'current');
    assert.ok(settings.items.slice(1).every((item) => item.activity === 'inactive'));
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('runtime, startup, setup, and settings share one workspace catalog source without path fallback', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-workspace-catalog-source-'));
  const workspaceDir = path.join(configDir, 'current');
  const otherDir = path.join(configDir, 'other');
  const stateDir = path.join(configDir, 'state-current');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  const settingsPath = path.join(configDir, 'config.json');
  const catalog = new WorkspaceCatalog(configDir);
  upsertWorkspaceRecord(configDir, { id: workspaceId(workspaceDir), workspaceDir, stateDir, lastSeenAt: new Date().toISOString() });
  upsertWorkspaceRecord(configDir, { id: workspaceId(otherDir), workspaceDir: otherDir, stateDir: path.join(configDir, 'state-other'), lastSeenAt: new Date().toISOString() });
  const runtime = new MyTerminalRuntime({ workspaceDir, stateDir, settingsPath, host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false });
  try {
    assert.equal(runtime.workspaceCatalog.configDir, catalog.configDir);
    assert.deepEqual(runtime.workspaceCatalog.snapshot().map((item) => item.workspaceDir), catalog.snapshot().map((item) => item.workspaceDir));
    const stateSource = fs.readFileSync(path.join(process.cwd(), 'src/tui/state.ts'), 'utf8');
    const setupSource = fs.readFileSync(path.join(process.cwd(), 'src/tui/Setup.tsx'), 'utf8');
    const cliSource = fs.readFileSync(path.join(process.cwd(), 'src/cli.ts'), 'utf8');
    assert.match(stateSource, /this\.currentRuntime\.workspaceCatalog\.snapshot\(\)/);
    assert.doesNotMatch(stateSource, /Workspace path.*fallback: current\.workspaceDir/);
    assert.doesNotMatch(stateSource, /readWorkspaceRegistry\(path\.dirname\(settingsPath\(\)\)\)/);
    assert.match(setupSource, /records: WorkspaceRecord\[\]/);
    assert.doesNotMatch(setupSource, /readWorkspaceRegistry\(/);
    assert.match(cliSource, /new WorkspaceCatalog\(path\.dirname\(settingsPath\(env\)\)\)/);
  } finally {
    await runtime.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('workspace selection uses one runtime-aware model across startup and settings', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-workspace-current-'));
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-workspace-other-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const records = [
      { id: workspaceId(workspaceDir), workspaceDir, stateDir: path.join(workspaceDir, '.state'), lastPid: 999999, lastPort: 1111, lastHost: 'stale-host', lastSeenAt: new Date().toISOString() },
      { id: workspaceId(otherDir), workspaceDir: otherDir, stateDir: path.join(otherDir, '.state'), lastPid: child.pid, lastPort: 4242, lastHost: '127.0.0.1', lastSeenAt: new Date().toISOString() },
    ];
    const items = workspaceSelectionItems(records, { workspaceDir, host: '127.0.0.1', port: 3131, pid: process.pid }, true);
    assert.equal(items.length, 2);
    assert.equal(items[0].activity, 'current');
    assert.equal(items[0].disabled, false);
    assert.match(items[0].status, /当前进程运行中/);
    assert.match(items[0].status, /127\.0\.0\.1:3131/);
    assert.equal(items[1].activity, 'active');
    assert.equal(items[1].disabled, true);
    assert.match(items[1].status, /其他进程运行中/);
    assert.equal(workspaceSelectionIndex(items, workspaceDir), 0);
    assert.equal(selectedWorkspace(items, '2')?.workspaceDir, otherDir);
    const question = workspaceChoiceQuestion('Workspace', items, 0);
    assert.deepEqual(question.optionDisabled, [false, true]);
    assert.equal(question.optionBadges[0].tone, 'good');
    assert.equal(question.optionBadges[1].tone, 'warn');

    const cli = fs.readFileSync(path.join(process.cwd(), 'src/cli.ts'), 'utf8');
    const state = fs.readFileSync(path.join(process.cwd(), 'src/tui/state.ts'), 'utf8');
    assert.doesNotMatch(cli, /records\.filter\(\(record\) => !isWorkspaceRecordActive/);
    assert.match(cli, /runWorkspaceChooserTui\(records,/);
    assert.match(state, /runtimeSettingsSnapshot\(this\.currentRuntime, persisted\)/);
    assert.match(state, /buildWorkspaceSelectorModel\(/);
    const effective = runtimeSettingsSnapshot({
      port: 3131,
      config: { schemaVersion: 1, workspaceDir, stateDir: '', settingsPath: '', host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'en', uiTheme: 'dark', passiveLockEnabled: false },
    });
    assert.equal(effective.port, 3131);
    assert.equal(effective.workspaceDir, workspaceDir);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  }
});

test('workspace selector always exposes an explicit add-new action', () => {
  const records = [{ id: 'one', workspaceDir: '/tmp/one', stateDir: '/tmp/state-one', lastSeenAt: new Date().toISOString() }];
  const items = workspaceSelectionItems(records, undefined, true, true);
  assert.equal(items.length, 2);
  assert.equal(items[1].id, ADD_WORKSPACE_ID);
  assert.equal(isAddWorkspaceSelection(items[1]), true);
  assert.match(items[1].title, /添加新的工作区/);
  assert.equal(items[1].disabled, false);
});

test('credential reveal survives normalized release packets while v repeats continue', () => {
  assert.equal(nextCredentialVisibility(false, { name: 'v', eventType: 'press' }, true), true);
  assert.equal(nextCredentialVisibility(true, { name: '', eventType: 'release' }, true), true);
  assert.equal(nextCredentialVisibility(true, { name: 'unknown', eventType: 'release' }, true), true);
  assert.equal(nextCredentialVisibility(true, { name: 'v', eventType: 'repeat' }, true), true);
  assert.equal(nextCredentialVisibility(true, { name: 'v', eventType: 'repeat' }, false), false);
});

test('workspace cards render status as an independent badge and require explicit mouse confirmation', () => {
  const formDialog = fs.readFileSync(path.join(process.cwd(), 'src/tui/components/FormDialog.tsx'), 'utf8');
  const model = fs.readFileSync(path.join(process.cwd(), 'src/tui/form-model.ts'), 'utf8');
  assert.match(model, /optionDescriptions:/);
  assert.match(model, /optionBadges:/);
  assert.doesNotMatch(model, /optionLabels: items\.map\(\(item\) => workspaceOptionLabel/);
  assert.match(formDialog, /mouseArmedOptionRef/);
  assert.match(formDialog, /const wasArmed = mouseArmedOptionRef\.current === position/);
  assert.match(formDialog, /else if \(wasArmed\)/);
  assert.match(formDialog, /first click selects, second click confirms/);
  assert.match(formDialog, /badges\[position\]\.label/);
  assert.match(formDialog, /descriptions\[position\]/);
});

test('cluster heartbeat restores a missing local member instead of persisting an empty registry', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-cluster-self-heal-'));
  const port = 39991;
  try {
    const registry = new PortClusterRegistry(configDir, '127.0.0.1', port);
    const member = registry.register({
      pid: process.pid,
      appVersion: '1.1.0',
      protocolVersion: 1,
      workspaceId: 'workspace-one',
      workspaceDir: '/tmp/workspace-one',
      internalPort: 41001,
      connectorKey: CONNECTOR_KEY,
      actionsTokenHash: tokenHash(ACTIONS_TOKEN),
      secret: 'cluster-secret',
    });
    const registryFile = path.join(configDir, 'clusters', `${clusterKey('127.0.0.1', port)}.json`);
    fs.rmSync(registryFile, { force: true });
    registry.heartbeat();
    const state = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    assert.equal(state.members.length, 1);
    assert.equal(state.members[0].id, member.id);
    assert.equal(state.members[0].workspaceId, 'workspace-one');
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('process topology reports shared-port member count and leader role', async () => {
  const port = await findAvailablePort('127.0.0.1', 39000);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-topology-config-'));
  const runtimes = [];
  try {
    for (const name of ['one', 'two']) {
      const workspaceDir = path.join(configDir, name);
      const stateDir = path.join(configDir, `state-${name}`);
      fs.mkdirSync(workspaceDir, { recursive: true });
      const runtime = new MyTerminalRuntime({ workspaceDir, stateDir, settingsPath: path.join(configDir, 'settings.json'), host: '127.0.0.1', port, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: `http://127.0.0.1:${port}`, maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false });
      await runtime.start(); runtimes.push(runtime);
    }
    const topology = runtimes.map((runtime) => runtime.processTopology());
    assert.deepEqual(topology.map((item) => item.memberCount), [2, 2]);
    assert.equal(topology.filter((item) => item.role === 'leader').length, 1);
    assert.equal(topology.filter((item) => item.role === 'member').length, 1);
    assert.ok(topology.every((item) => item.sharedPort === port));
  } finally {
    for (const runtime of runtimes.reverse()) await runtime.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('single configured-port runtime uses single-workspace mode and repairs a deleted registry', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-topology-gap-'));
  const workspaceDir = path.join(configDir, 'workspace');
  const stateDir = path.join(configDir, 'state');
  const port = await findAvailablePort('127.0.0.1', 39500);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const runtime = new MyTerminalRuntime({ workspaceDir, stateDir, settingsPath: path.join(configDir, 'settings.json'), host: '127.0.0.1', port, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false });
  try {
    await runtime.start();
    const first = runtime.processTopology();
    assert.equal(first.mode, 'single-workspace');
    assert.equal(first.memberCount, 1);
    assert.equal(first.role, 'standalone');
    const registryFile = path.join(configDir, 'clusters', `${clusterKey('127.0.0.1', port)}.json`);
    fs.rmSync(registryFile, { force: true });
    const repaired = runtime.processTopology();
    assert.equal(repaired.mode, 'single-workspace');
    assert.equal(repaired.memberCount, 1);
    const state = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    assert.equal(state.members.length, 1);
    assert.equal(state.members[0].workspaceDir, workspaceDir);
  } finally {
    await runtime.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('malformed cluster registry is reported as degraded and never as zero members', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-topology-corrupt-'));
  const workspaceDir = path.join(configDir, 'workspace');
  const stateDir = path.join(configDir, 'state');
  const port = await findAvailablePort('127.0.0.1', 39600);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const runtime = new MyTerminalRuntime({ workspaceDir, stateDir, settingsPath: path.join(configDir, 'settings.json'), host: '127.0.0.1', port, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false });
  try {
    await runtime.start();
    const registryFile = path.join(configDir, 'clusters', `${clusterKey('127.0.0.1', port)}.json`);
    fs.writeFileSync(registryFile, '{broken');
    const topology = runtime.processTopology();
    assert.equal(topology.mode, 'degraded');
    assert.equal(topology.memberCount, undefined);
    assert.match(topology.error, /JSON|Unexpected|position/i);
  } finally {
    fs.rmSync(path.join(configDir, 'clusters', `${clusterKey('127.0.0.1', port)}.json`), { force: true });
    await runtime.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('runtime close disarms session helpers and stops the global passive-lock service', async () => {
  if (process.platform !== 'darwin') return;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-resource-config-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-resource-workspace-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-resource-state-'));
  const settingsPath = path.join(configDir, 'config.json');
  const sessionChildren = [
    spawn(process.execPath, ['-e', "process.title='MyTerminalPassiveLock'; setInterval(() => {}, 1000)"], { stdio: 'ignore' }),
    spawn(process.execPath, ['-e', "process.title='MyTerminalPassiveLock'; setInterval(() => {}, 1000)"], { stdio: 'ignore' }),
  ];
  const passiveChild = spawn(process.execPath, ['-e', "process.title='MyTerminalPassiveLock'; setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  const directory = path.join(stateDir, 'session-resources');
  const passiveDirectory = path.join(configDir, 'passive-lock');
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(passiveDirectory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'ses_one.pid'), `${sessionChildren[0].pid}\n`);
  fs.writeFileSync(path.join(directory, 'ses_two.pid'), `${sessionChildren[1].pid}\n`);
  fs.writeFileSync(path.join(passiveDirectory, 'passive-lock.pid'), `${passiveChild.pid}\n`);
  fs.writeFileSync(path.join(passiveDirectory, 'passive-lock.log'), `${new Date().toISOString()} standby_requested\n`);
  const runtimeConfig = { workspaceDir, stateDir, settingsPath, host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false };
  const runtime = new MyTerminalRuntime(runtimeConfig);
  try {
    assert.equal(passiveLockStatus(runtimeConfig).pid, passiveChild.pid);
    await runtime.start();
    await runtime.close();
    await Promise.all(sessionChildren.map((child) => new Promise((resolve) => child.once('exit', resolve))));
    assert.equal(fs.readdirSync(directory).some((entry) => entry.endsWith('.pid')), false);
    if (passiveChild.exitCode === null) await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      passiveChild.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    assert.equal(passiveLockStatus(runtimeConfig).running, false);
  } finally {
    for (const child of sessionChildren) child.kill('SIGKILL');
    passiveChild.kill('SIGKILL');
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('passive lock remains alive while another MyTerminal process lease exists', async () => {
  if (process.platform !== 'darwin') return;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-passive-shared-config-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-passive-shared-workspace-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-passive-shared-state-'));
  const settingsPath = path.join(configDir, 'settings.json');
  const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const passiveChild = spawn(process.execPath, ['-e', "process.title='MyTerminalPassiveLock'; setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  const passiveDirectory = path.join(configDir, 'passive-lock');
  fs.mkdirSync(passiveDirectory, { recursive: true });
  fs.writeFileSync(path.join(passiveDirectory, 'passive-lock.pid'), `${passiveChild.pid}\n`);
  fs.writeFileSync(path.join(passiveDirectory, 'passive-lock.log'), `${new Date().toISOString()} standby_requested\n`);
  const peerWorkspace = path.join(configDir, 'peer'); fs.mkdirSync(peerWorkspace, { recursive: true });
  upsertWorkspaceRecord(configDir, { id: workspaceId(peerWorkspace), workspaceDir: peerWorkspace, stateDir: path.join(configDir, 'peer-state'), lastPid: peer.pid, lastHost: '127.0.0.1', lastPort: 3101, lastSeenAt: new Date().toISOString() });
  const config = { workspaceDir, stateDir, settingsPath, host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false };
  const runtime = new MyTerminalRuntime(config);
  try {
    await runtime.start();
    assert.deepEqual(activeWorkspaceRuntimePids(configDir, process.pid), [peer.pid]);
    await runtime.close();
    assert.equal(passiveLockStatus(config).running, true);
  } finally {
    peer.kill('SIGKILL'); passiveChild.kill('SIGKILL');
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('OpenAPI 3.1 exposes exactly three facade operations and concrete identity schemas', async () => {
  const server = await createRuntime();
  try {
    const schema = await (await fetch(`${server.baseUrl}/openapi.json`)).json();
    assert.equal(schema.openapi, '3.1.0'); assert.equal(typeof schema.components.schemas, 'object'); assert.equal(Array.isArray(schema.components.schemas), false);
    assert.deepEqual(Object.keys(schema.paths).sort(), ['/actions/extensions/call', '/actions/extensions/discover', '/actions/extensions/register']);
    assert.deepEqual(Object.values(schema.paths).map((item) => item.post.operationId).sort(), ['extensionCall', 'extensionDiscover', 'extensionRegister']);
    assert.deepEqual(schema.components.schemas.SessionIdentity.required, ['sessionId', 'sessionToken']);
    assert.deepEqual(schema.components.schemas.ExtensionCallRequest.properties.identity.anyOf, [{ $ref: '#/components/schemas/SessionIdentity' }, { type: 'null' }]);
    assert.deepEqual(schema.components.schemas.ExtensionDiscoverRequest.properties.identity.anyOf, [{ $ref: '#/components/schemas/SessionIdentity' }, { type: 'null' }]);
    assert.equal(schema.components.schemas.ExtensionRegisterRequest.properties.identity.$ref, '#/components/schemas/SessionIdentity');
    assert.equal(schema.components.schemas.ExtensionRegisterRequest.properties.spec.$ref, '#/components/schemas/ExtensionSpec');
    assert.equal(schema.components.schemas.ToolResponse.properties.events.maxItems, 5);
    assert.equal(schema.components.schemas.ExtensionToolInput.properties.nextCalls.minItems, 1);
    assert.equal(schema.components.schemas.ExtensionToolInput.properties.nextCalls.maxItems, 1);
    assert.equal(schema.components.schemas.PlannedToolCall.required.includes('tool'), true);
    assert.match(schema.paths['/actions/extensions/call'].post.description, /next-call/);
    assert.match(schema.paths['/actions/extensions/call'].post.description, /200ms/);
    assert.deepEqual(await (await fetch(`${server.baseUrl}/openapi-3.1.json`)).json(), schema);
  } finally { await server.close(); }
});

test('Actions bootstrap treats null identity as absent without weakening authenticated calls', async () => {
  const server = await createRuntime();
  try {
    const anonymous = await action(server, 'discover', { includeSchemas: false, identity: null });
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.body.data.identityRequired, true);

    const created = await action(server, 'call', {
      tool: 'session_register',
      input: { mode: 'root', name: 'null-bootstrap-root', role: 'lead' },
      identity: null,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.ok, true);
    const identity = created.body.data.result.identity;

    const emptyIdentity = await action(server, 'call', {
      tool: 'session_register',
      input: { mode: 'root', name: 'invalid-empty-identity', role: 'lead' },
      identity: {},
    });
    assert.equal(emptyIdentity.status, 400);
    assert.equal(emptyIdentity.body.error.code, 'INVALID_INPUT');

    const ordinary = await action(server, 'call', { tool: 'workspace_info', input: {}, identity: null });
    assert.equal(ordinary.status, 401);
    assert.equal(ordinary.body.error.code, 'IDENTITY_REQUIRED');

    const registry = await action(server, 'register', { action: 'remove', name: 'missing', identity: null });
    assert.equal(registry.status, 401);
    assert.equal(registry.body.error.code, 'IDENTITY_REQUIRED');

    const unauthorizedDelegate = await action(server, 'call', {
      tool: 'session_register',
      input: { mode: 'delegate', name: 'unauthorized-worker', role: 'developer', task },
      identity: null,
    });
    assert.equal(unauthorizedDelegate.status, 401);
    assert.equal(unauthorizedDelegate.body.error.code, 'IDENTITY_REQUIRED');

    const delegated = await call(server, 'session_register', { mode: 'delegate', name: 'null-inherit-worker', role: 'developer', task }, identity);
    assert.equal(delegated.body.ok, true, JSON.stringify(delegated.body));
    const inherited = await action(server, 'call', {
      tool: 'session_inherit',
      input: { sessionId: delegated.body.data.result.session.id, claimCode: delegated.body.data.result.claimCode },
      identity: null,
    });
    assert.equal(inherited.status, 200, JSON.stringify(inherited.body));
    assert.equal(inherited.body.ok, true);
  } finally { await server.close(); }
});

test('Actions identity, delegation, messages, ACK, completion audit, and continuation form a full loop', async () => {
  const server = await createRuntime();
  try {
    const anonymous = await action(server, 'discover', { includeSchemas: false });
    assert.equal(anonymous.body.data.identityRequired, true); assert.equal(anonymous.body.data.tools, undefined);
    const main = await root(server); const mainIdentity = main.identity;
    const wrong = await call(server, 'workspace_info', {}, { sessionId: mainIdentity.sessionId, sessionToken: 'wrong' });
    assert.equal(wrong.status, 401); assert.equal(wrong.body.error.code, 'INVALID_IDENTITY');
    const delegate = await call(server, 'session_register', { mode: 'delegate', name: 'worker', role: 'developer', task }, mainIdentity);
    assert.equal(delegate.status, 200, JSON.stringify(delegate.body)); const childInfo = delegate.body.data.result;
    assert.equal(childInfo.session.phase, 'pending'); assert.equal(childInfo.session.presence, 'unclaimed'); assert.ok(childInfo.handoffPrompt.includes('session_inherit'));
    const child = await call(server, 'session_inherit', { sessionId: childInfo.session.id, claimCode: childInfo.claimCode });
    assert.equal(child.status, 200, JSON.stringify(child.body)); const childIdentity = child.body.data.result.identity;
    assert.equal(child.body.data.result.context.parentContext.session.id, main.session.id); assert.equal(child.body.data.result.context.objective, task.objective);
    const secondClaim = await call(server, 'session_inherit', { sessionId: childInfo.session.id, claimCode: childInfo.claimCode });
    assert.equal(secondClaim.body.error.code, 'SESSION_ALREADY_CLAIMED');
    const sent = await call(server, 'message_send', { to: main.session.id, body: 'Child progress is ready.' }, childIdentity);
    assert.equal(sent.body.ok, true); assert.equal(sent.body.data.result.message.source, 'session'); assert.ok(sent.body.data.result.timing.sentAt); assert.ok(sent.body.data.result.timing.returnedAt); assert.ok(sent.body.data.result.timing.elapsedMs >= 0);
    const reply = await call(server, 'message_send', { to: 'worker', body: 'Root acknowledges the update.' }, mainIdentity); assert.equal(reply.body.ok, true);
    const messageList = await call(server, 'message_list', {}, childIdentity); assert.deepEqual(messageList.body.data.result.messages.map((message) => message.body), ['Child progress is ready.', 'Root acknowledges the update.']); assert.equal(messageList.body.data.result.observations.length, 2); assert.ok(messageList.body.data.result.observations.every((item) => item.observedAt && item.ageMs >= 0 && Array.isArray(item.operationsSinceSend)));
    const conversation = await call(server, 'message_conversation', { with: 'main' }, childIdentity); assert.equal(conversation.body.data.result.conversation.messages.length, 2); assert.equal(conversation.body.data.result.observations.length, 2);
    const rootContext1 = await call(server, 'session_context', {}, mainIdentity);
    const rootEvents = rootContext1.body.events; assert.ok(rootEvents.length <= 5); assert.ok(rootEvents.some((event) => event.kind === 'message'));
    const rootContext2 = await call(server, 'session_context', {}, mainIdentity);
    assert.deepEqual(rootContext2.body.events.map((event) => event.id), rootEvents.map((event) => event.id));
    const ack = await call(server, 'session_events_ack', { eventIds: rootEvents.map((event) => event.id) }, mainIdentity); assert.equal(ack.body.ok, true);
    const afterAck = await call(server, 'session_context', {}, mainIdentity);
    assert.equal((afterAck.body.events || []).some((event) => rootEvents.some((old) => old.id === event.id)), false);
    const premature = await call(server, 'session_checkpoint', { phase: 'completed', summary: 'Root thinks it is done.' }, mainIdentity);
    assert.equal(premature.body.error.code, 'CHILD_REVIEW_REQUIRED'); assert.equal(premature.body.error.details.children.length, 1);
    assert.equal(premature.body.error.details.mustContinue, true); assert.equal(premature.body.error.details.userFacingFinalProhibited, true); assert.ok(premature.body.error.details.currentTime);
    assert.equal(premature.body.error.details.rootSession.phase, 'working'); assert.match(premature.body.error.details.rootSession.latestCheckpoint.summary, /Completion blocked/);
    assert.ok(Array.isArray(premature.body.error.details.children[0].recentOperations)); assert.ok(typeof premature.body.error.details.children[0].inactivityMs === 'number');
    const childDone = await call(server, 'session_checkpoint', { phase: 'completed', summary: 'Implemented and verified the delegated slice.', milestone: 'child-complete' }, childIdentity);
    assert.equal(childDone.body.data.result.session.phase, 'completed'); assert.equal(childDone.body.data.result.session.controller, undefined);
    const stillNeedsReview = await call(server, 'session_checkpoint', { phase: 'completed', summary: 'Attempt before reading child results.' }, mainIdentity);
    assert.equal(stillNeedsReview.body.error.code, 'CHILD_REVIEW_REQUIRED'); assert.ok(stillNeedsReview.body.error.details.children[0].unreadMessages.length > 0 || stillNeedsReview.body.error.details.children[0].pendingEvents.length > 0);
    const reviewedInbox = await call(server, 'message_inbox', { markRead: true }, mainIdentity); assert.equal(reviewedInbox.body.ok, true);
    const reviewContext = await call(server, 'session_context', {}, mainIdentity);
    const childEvents = (reviewContext.body.events || []).filter((event) => event.sourceSessionId === childInfo.session.id);
    if (childEvents.length) { const reviewAck = await call(server, 'session_events_ack', { eventIds: childEvents.map((event) => event.id) }, mainIdentity); assert.equal(reviewAck.body.ok, true); }
    const rootDone = await call(server, 'session_checkpoint', { phase: 'completed', summary: 'Reviewed all child work and completed the root objective.' }, mainIdentity);
    assert.equal(rootDone.body.data.result.session.phase, 'completed');
    const immutable = await call(server, 'session_checkpoint', { phase: 'working', summary: 'Reopen.' }, mainIdentity); assert.equal(immutable.body.error.code, 'INVALID_IDENTITY');
    const continuation = await root(server, 'main-followup', main.session.id);
    assert.equal(continuation.session.continuesSessionId, main.session.id); assert.equal(continuation.session.parentSessionId, undefined);
    assert.equal(continuation.context.inheritedFrom.id, main.session.id); assert.equal(continuation.context.inheritedFrom.finalSummary, 'Reviewed all child work and completed the root objective.');
    const permanentHistory = await call(server, 'session_history', { limit: 500, includeAncestors: true }, continuation.identity);
    assert.ok(permanentHistory.body.data.result.history.entries.some((entry) => entry.sessionId === main.session.id && entry.type === 'checkpoint'));
    const actionFacts = server.runtime.store.auditFacts(500);
    assert.ok(actionFacts.length > 10);
    assert.equal(actionFacts.every((fact) => fact.source === 'actions'), true);
    assert.equal(actionFacts.every((fact) => ['running', 'completed', 'failed', 'timeout'].includes(fact.status)), true);
    assert.equal(new Set(actionFacts.map((fact) => fact.id)).size, actionFacts.length);
    const actionRuntimeLogs = server.runtime.logs.filter((entry) => entry.audit);
    assert.equal(new Set(actionRuntimeLogs.map((entry) => entry.audit.id)).size, actionRuntimeLogs.length);
  } finally { await server.close(); }
});

test('TUI user messages are attributed to the user and preserve timing observations', () => {
  const dirs = tempWorkspace(); const store = new MyTerminalStore(dirs.stateDir);
  try {
    const rootSession = store.registerRoot({ name: 'recipient' });
    const userMessage = store.sendUserMessage(rootSession.session.id, 'Please continue with the review.');
    assert.equal(userMessage.from, 'user'); assert.equal(userMessage.source, 'user'); assert.equal(userMessage.to, rootSession.session.id);
    const observations = store.observeMessages([userMessage]);
    assert.equal(observations.length, 1); assert.equal(observations[0].sentAt, userMessage.createdAt); assert.ok(observations[0].observedAt); assert.ok(observations[0].ageMs >= 0); assert.ok(Array.isArray(observations[0].operationsSinceSend));
    const groups = conversationGroups(store.snapshot().messages); assert.equal(groups.length, 1); assert.ok(groups[0].sessionIds.includes('user'));
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('TUI model collapses continuation records and groups two-way conversations with stable scrolling', () => {
  const dirs = tempWorkspace(); const store = new MyTerminalStore(dirs.stateDir);
  try {
    const first = store.registerRoot({ name: 'logical-a' }); store.checkpoint(first.session.id, { phase: 'completed', summary: 'first complete' });
    const continuation = store.registerRoot({ name: 'logical-a-next', continuesSessionId: first.session.id }); const independent = store.registerRoot({ name: 'logical-b' });
    store.sendMessage(continuation.session.id, independent.session.id, 'one'); store.sendMessage(independent.session.id, continuation.session.id, 'two');
    const groups = logicalSessionGroups(store.listSessions()); assert.equal(groups.length, 2);
    const chain = groups.find((group) => group.id === first.session.id); assert.equal(chain.sessions.length, 2); assert.equal(chain.current.id, continuation.session.id);
    const conversations = conversationGroups(store.snapshot().messages); assert.equal(conversations.length, 1); assert.equal(conversations[0].messages.length, 2);
    assert.deepEqual(selectedViewport(['a', 'b', 'c', 'd'], 3, 2), { selected: 3, start: 2, visible: ['c', 'd'] });
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('workspace diff tracker includes tracked and untracked changes while excluding MyTerminal state', async () => {
  const dirs = tempWorkspace();
  try {
    execFileSync('git', ['init'], { cwd: dirs.workspaceDir }); execFileSync('git', ['config', 'user.email', 'dev@example.test'], { cwd: dirs.workspaceDir }); execFileSync('git', ['config', 'user.name', 'MyTerminal Test'], { cwd: dirs.workspaceDir });
    execFileSync('git', ['add', 'hello.txt'], { cwd: dirs.workspaceDir }); execFileSync('git', ['commit', '-m', 'baseline'], { cwd: dirs.workspaceDir });
    fs.writeFileSync(path.join(dirs.workspaceDir, 'hello.txt'), 'changed content\n'); fs.writeFileSync(path.join(dirs.workspaceDir, 'new.txt'), 'new line\n'); fs.mkdirSync(path.join(dirs.workspaceDir, 'large-untracked')); fs.writeFileSync(path.join(dirs.workspaceDir, 'large-untracked', 'nested.txt'), 'nested content\n'); fs.writeFileSync(path.join(dirs.stateDir, 'internal.txt'), 'hidden\n');
    const tracker = new WorkspaceDiffTracker({ ...dirs, settingsPath: '', host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'en', uiTheme: 'dark' });
    await tracker.refresh(); const diff = tracker.snapshot(); const text = diff.lines.join('\n');
    assert.match(text, /-hello myterminal/); assert.match(text, /\+changed content/); assert.match(text, /diff --git a\/new.txt b\/new.txt/); assert.match(text, /\?\? large-untracked\/ \(untracked directory; contents collapsed\)/); assert.doesNotMatch(text, /nested content/); assert.doesNotMatch(text, /internal.txt/);
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('diff tracker samples large untracked binaries without reading the whole file', async () => {
  const dirs = tempWorkspace();
  try {
    execFileSync('git', ['init'], { cwd: dirs.workspaceDir });
    execFileSync('git', ['config', 'user.email', 'dev@example.test'], { cwd: dirs.workspaceDir });
    execFileSync('git', ['config', 'user.name', 'MyTerminal Test'], { cwd: dirs.workspaceDir });
    execFileSync('git', ['add', 'hello.txt'], { cwd: dirs.workspaceDir });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: dirs.workspaceDir });
    const sample = path.join(dirs.workspaceDir, 'bun.exe');
    const descriptor = fs.openSync(sample, 'w');
    try { fs.writeSync(descriptor, Buffer.from([0, 1, 2, 3]), 0, 4, 0); fs.ftruncateSync(descriptor, 256 * 1024 * 1024); }
    finally { fs.closeSync(descriptor); }
    const tracker = new WorkspaceDiffTracker({ ...dirs, settingsPath: '', host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'en', uiTheme: 'dark' });
    const started = Date.now(); await tracker.refresh(); const elapsed = Date.now() - started;
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.error, undefined);
    assert.match(snapshot.lines.join('\n'), /Binary file bun\.exe is untracked \(268435456 bytes\)/);
    assert.ok(elapsed < 5_000, `bounded binary sampling took ${elapsed}ms`);
    fs.rmSync(sample, { force: true });
    assert.equal(fs.existsSync(sample), false);
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('non-Git workspaces disable diff tracking without crashing or repeated Git failures', async () => {
  const dirs = tempWorkspace();
  try {
    const tracker = new WorkspaceDiffTracker({ ...dirs, settingsPath: '', host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'en', uiTheme: 'dark' }, 10);
    await tracker.refresh();
    const first = tracker.snapshot();
    assert.equal(first.error, undefined);
    assert.equal(first.unavailableReason, 'not-git-repository');
    assert.deepEqual(first.lines, []);
    tracker.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const later = tracker.snapshot();
    assert.equal(later.error, undefined);
    assert.equal(later.unavailableReason, 'not-git-repository');
    tracker.stop();
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('only roots delegate, multiple children coexist, and TUI revoke invalidates old controller', async () => {
  const server = await createRuntime();
  try {
    const main = await root(server); const identity = main.identity;
    const first = await call(server, 'session_register', { mode: 'delegate', name: 'one', task }, identity);
    const second = await call(server, 'session_register', { mode: 'delegate', name: 'two', task }, identity);
    assert.equal(first.body.ok, true); assert.equal(second.body.ok, true);
    const claimed = await call(server, 'session_inherit', { sessionId: first.body.data.result.session.id, claimCode: first.body.data.result.claimCode }); const childIdentity = claimed.body.data.result.identity;
    const grandchild = await call(server, 'session_register', { mode: 'delegate', name: 'grandchild', task }, childIdentity);
    assert.equal(grandchild.body.error.code, 'MAX_SESSION_DEPTH');
    const revoked = server.runtime.store.revokeFromTui(first.body.data.result.session.id);
    const oldRejected = await call(server, 'workspace_info', {}, childIdentity); assert.equal(oldRejected.body.error.code, 'INVALID_IDENTITY');
    const reclaimed = await call(server, 'session_inherit', { sessionId: revoked.session.id, claimCode: revoked.claimCode }); assert.equal(reclaimed.body.ok, true);
  } finally { await server.close(); }
});

test('checkpoint reminder, block, and stale transitions use fixed non-resetting deadlines', () => {
  const dirs = tempWorkspace(); let now = Date.parse('2026-01-01T00:00:00.000Z'); const store = new MyTerminalStore(dirs.stateDir, () => now);
  try {
    const created = store.registerRoot({ name: 'clock' }); store.beforeOrdinaryCall(created.session.id);
    const started = store.session(created.session.id).checkpointStartedAt; now += 60_000; store.beforeOrdinaryCall(created.session.id); assert.equal(store.session(created.session.id).checkpointStartedAt, started);
    now = Date.parse(started) + SESSION_TIMING.CHECKPOINT_REMINDER_MS; store.refreshTemporalStates(); assert.ok(store.pendingEvents(created.session.id).some((event) => event.kind === 'checkpoint_due'));
    now = Date.parse(started) + SESSION_TIMING.CHECKPOINT_BLOCK_MS;
    assert.throws(() => store.beforeOrdinaryCall(created.session.id), (error) => error.code === 'CHECKPOINT_REQUIRED');
    store.checkpoint(created.session.id, { phase: 'working', summary: 'Checkpoint resets the work window.' }); assert.equal(store.session(created.session.id).checkpointStartedAt, undefined);
    store.beforeOrdinaryCall(created.session.id); const activity = Date.parse(store.session(created.session.id).controller.lastActivityAt); now = activity + SESSION_TIMING.STALE_MS; store.refreshTemporalStates();
    assert.equal(store.session(created.session.id).presence, 'stale');
    const recoveryPrompt = store.handoffForTui(created.session.id); assert.ok(recoveryPrompt);
    const restarted = new MyTerminalStore(dirs.stateDir, () => now);
    assert.equal(restarted.handoffForTui(created.session.id), undefined);
    const recovered = restarted.inherit(created.session.id, { sessionToken: created.identity.sessionToken });
    assert.equal(recovered.session.presence, 'claimed'); assert.notEqual(recovered.identity.sessionToken, created.identity.sessionToken);
    const released = restarted.release(recovered.session.id);
    assert.throws(() => restarted.inherit(created.session.id, { sessionToken: created.identity.sessionToken }), (error) => error.code === 'INVALID_RECOVERY_CREDENTIAL');
    const handedOff = restarted.inherit(created.session.id, { claimCode: released.claimCode });
    assert.equal(handedOff.session.presence, 'claimed');
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('extension registry and workspace tools require identity and audit keeps complete sanitized arguments and results', async () => {
  const server = await createRuntime();
  try {
    const denied = await call(server, 'read_file', { path: 'hello.txt' }); assert.equal(denied.body.error.code, 'IDENTITY_REQUIRED');
    const main = await root(server); const identity = main.identity;
    const valid = await call(server, 'read_file', { path: 'hello.txt' }, identity); assert.equal(valid.body.data.result.content, 'hello myterminal\n');
    const protectedState = await call(server, 'read_file', { path: '.myterminal/state.json' }, identity); assert.equal(protectedState.body.ok, false);
    const spec = { name: 'echo_value', title: 'Echo value', description: 'Echo a supplied value through a bounded executable.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, handler: { kind: 'command', executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', '{{input.value}}'] } };
    const deniedRegistry = await action(server, 'register', { action: 'validate', spec }); assert.equal(deniedRegistry.body.error.code, 'IDENTITY_REQUIRED');
    for (const actionName of ['validate', 'upsert']) { const response = await action(server, 'register', { action: actionName, spec, identity }); assert.equal(response.body.ok, true, JSON.stringify(response.body)); }
    const custom = await call(server, 'echo_value', { value: 'custom-ok' }, identity); assert.equal(custom.body.data.result.stdout, 'custom-ok');
    await call(server, 'message_send', { to: main.session.id, body: 'sensitive body' }, identity);
    const history = fs.readFileSync(path.join(server.dirs.stateDir, 'history', `${main.session.id}.jsonl`), 'utf8');
    assert.equal(history.includes(identity.sessionToken), false); assert.ok(history.includes('[REDACTED'));
    const facts = server.runtime.store.auditFacts(100);
    const customAudit = facts.find((fact) => fact.action === 'echo_value');
    assert.equal(customAudit.status, 'completed');
    assert.equal(customAudit.args.value, 'custom-ok');
    assert.equal(customAudit.result.data.result.stdout, 'custom-ok');
    assert.equal(facts.filter((fact) => fact.id === customAudit.id).length, 1);
  } finally { await server.close(); }
});

test('events cap at five, persist until ACK, subscriptions deliver milestones, and messages are never pruned', () => {
  const dirs = tempWorkspace(); const store = new MyTerminalStore(dirs.stateDir);
  try {
    const rootSession = store.registerRoot({ name: 'root' }); const observer = store.registerRoot({ name: 'observer' }); store.subscribe(observer.session.id, rootSession.session.id);
    for (let i = 0; i < 8; i += 1) store.sendMessage(rootSession.session.id, observer.session.id, `message-${i}`);
    assert.equal(store.pendingEvents(observer.session.id).length, 5); const first = store.pendingEvents(observer.session.id); assert.deepEqual(store.pendingEvents(observer.session.id).map((event) => event.id), first.map((event) => event.id));
    store.acknowledgeEvents(observer.session.id, first.map((event) => event.id)); assert.equal(store.pendingEvents(observer.session.id).length, 3);
    store.checkpoint(rootSession.session.id, { phase: 'working', summary: 'Reached a milestone.', milestone: 'api-ready' });
    assert.ok(store.pendingEvents(observer.session.id).some((event) => event.kind === 'milestone'));
    for (let i = 8; i < 5100; i += 1) store.sendMessage(rootSession.session.id, observer.session.id, `message-${i}`);
    assert.equal(store.snapshot().messages.length, 5100);
    const reloaded = new MyTerminalStore(dirs.stateDir);
    assert.equal(reloaded.snapshot().messages.length, 5100);
    const inboxPage = reloaded.inboxPage(observer.session.id);
    assert.equal(inboxPage.total, 5100);
    assert.equal(inboxPage.messages.length, 50);
    assert.equal(inboxPage.messages.at(-1).body, 'message-5099');
    assert.equal(reloaded.pendingEvents(observer.session.id).length, 5);
    assert.equal(reloaded.revision(), store.revision());
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
}, 300000);

test('v1 state migrates to v2 with stale roots and durable history; context stays under 16K', () => {
  const dirs = tempWorkspace();
  try {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dirs.stateDir, 'state.json'), JSON.stringify({ schemaVersion: 1, revision: 4, sessions: [{ id: 'ses_old', name: 'old', role: 'developer', status: 'active', note: 'legacy note', clientSessionKey: 'ignored', createdAt: now, updatedAt: now }], messages: [{ id: 'msg_old', from: 'ses_old', to: 'ses_old', body: 'legacy message', createdAt: now }], extensions: [] }));
    const store = new MyTerminalStore(dirs.stateDir); const migrated = store.snapshot(); assert.equal(migrated.schemaVersion, 2); assert.equal(migrated.sessions[0].phase, 'working'); assert.equal(migrated.sessions[0].presence, 'stale'); assert.equal(migrated.sessions[0].clientSessionKey, undefined);
    assert.ok(fs.readFileSync(path.join(dirs.stateDir, 'history', 'ses_old.jsonl'), 'utf8').includes('migration_v1'));
    assert.ok(JSON.stringify(store.context('ses_old')).length <= 16_000);
    assert.throws(() => store.deleteFromTui('ses_old'), (error) => error.code === 'DELETE_CONFIRMATION_REQUIRED');
    assert.deepEqual(store.deleteFromTui('ses_old', 'DELETE ses_old').deleted, ['ses_old']);
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('Actions next-call mode rejects stopping and enforces the exact post-checkpoint call', async () => {
  const server = await createRuntime({ actionsContinuationMode: 'next-call' });
  try {
    const created = await root(server, 'next-call-mode');
    const identity = created.identity;
    const missing = await call(server, 'session_checkpoint', { phase: 'working', summary: 'Still working.' }, identity);
    assert.equal(missing.body.error.code, 'CONTINUATION_PLAN_REQUIRED');
    assert.equal(missing.body.error.details.requiredCount, 1);
    assert.equal(missing.body.error.details.example.nextCalls[0].tool, 'workspace_info');
    assert.deepEqual(missing.body.error.details.example.nextCalls[0].input, {});
    const checkpoint = await call(server, 'session_checkpoint', {
      phase: 'working', summary: 'Inspect the workspace next.',
      nextCalls: [{ tool: 'workspace_info', input: {}, purpose: 'Continue the active inspection.' }],
    }, identity);
    assert.equal(checkpoint.body.data.continuation.mustContinue, true);
    assert.equal(checkpoint.body.data.continuation.nextCall.tool, 'workspace_info');
    const wrong = await call(server, 'list_dir', { path: '.' }, identity);
    assert.equal(wrong.body.error.code, 'NEXT_CALL_REQUIRED');
    assert.equal(wrong.body.error.details.nextCall.tool, 'workspace_info');
    const continued = await call(server, 'workspace_info', {}, identity);
    assert.equal(continued.body.ok, true);
    assert.equal(continued.body.data.continuation.reason, 'continuation_plan_exhausted');
    assert.match(continued.body.data.continuation.nextCallRequired, /exactly 1 nextCalls/);
  } finally { await server.close(); }
});

test('optional Actions harness defaults off, adaptive accepts 1-3 calls, and contract changes require rediscovery', async () => {
  const off = await createRuntime({ actionsContinuationMode: 'off' });
  try {
    const created = await root(off, 'harness-off');
    const checkpoint = await call(off, 'session_checkpoint', { phase: 'working', summary: 'Core harness remains active.' }, created.identity);
    assert.equal(checkpoint.body.ok, true);
    assert.equal(checkpoint.body.data.continuation, undefined);
  } finally { await off.close(); }

  const adaptive = await createRuntime({ actionsContinuationMode: 'adaptive' });
  try {
    const created = await root(adaptive, 'harness-adaptive');
    const missing = await call(adaptive, 'session_checkpoint', { phase: 'working', summary: 'Need a concrete plan.' }, created.identity);
    assert.equal(missing.body.error.code, 'CONTINUATION_PLAN_REQUIRED');
    assert.equal(missing.body.error.details.minCalls, 1);
    assert.equal(missing.body.error.details.maxCalls, 3);
    assert.equal(missing.body.error.details.example.nextCalls.length, 1);
    const checkpoint = await call(adaptive, 'session_checkpoint', { phase: 'working', summary: 'Use one step before uncertain evidence.', nextCalls: [{ tool: 'workspace_info', input: {} }] }, created.identity);
    assert.equal(checkpoint.body.data.continuation.nextCall.tool, 'workspace_info');
  } finally { await adaptive.close(); }

  const dirs = tempWorkspace();
  try {
    const base = { ...dirs, settingsPath: path.join(dirs.stateDir, 'settings.json'), host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'en', uiTheme: 'dark', passiveLockEnabled: false };
    const store = new MyTerminalStore(dirs.stateDir);
    new ExtensionService({ ...base, actionsContinuationMode: 'off' }, store, new Map());
    const created = store.registerRoot({ name: 'requirements-change' });
    const adaptiveService = new ExtensionService({ ...base, actionsContinuationMode: 'adaptive' }, store, new Map());
    const event = store.pendingEvents(created.session.id).find((item) => item.kind === 'requirements_changed');
    assert.equal(event.payload.mode, 'adaptive');
    const discovered = await adaptiveService.discover({ identity: created.identity }, { transport: 'actions' });
    assert.equal(discovered.data.harness.mode, 'adaptive');
    assert.equal(store.pendingEvents(created.session.id).some((item) => item.kind === 'requirements_changed'), false);
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('Actions lookahead-3 mode advances a server-confirmed three-call queue', async () => {
  const server = await createRuntime({ actionsContinuationMode: 'lookahead-3' });
  try {
    const schema = await (await fetch(`${server.baseUrl}/openapi.json`)).json();
    assert.equal(schema.components.schemas.ExtensionToolInput.properties.nextCalls.minItems, 3);
    assert.equal(schema.components.schemas.ExtensionToolInput.properties.nextCalls.maxItems, 3);
    const created = await root(server, 'lookahead-mode');
    const identity = created.identity;
    const short = await call(server, 'session_checkpoint', { phase: 'working', summary: 'Plan is too short.', nextCalls: [{ tool: 'workspace_info', input: {} }] }, identity);
    assert.equal(short.body.error.code, 'CONTINUATION_PLAN_REQUIRED');
    assert.equal(short.body.error.details.requiredCount, 3);
    const plan = [
      { tool: 'workspace_info', input: {}, purpose: 'Read runtime metadata.' },
      { tool: 'list_dir', input: { path: '.' }, purpose: 'Read the workspace root.' },
      { tool: 'read_file', input: { path: 'hello.txt' }, purpose: 'Read the fixture file.' },
    ];
    const checkpoint = await call(server, 'session_checkpoint', { phase: 'working', summary: 'Execute the three-step inspection.', nextCalls: plan }, identity);
    assert.equal(checkpoint.body.data.continuation.continuationMode, 'lookahead-3');
    assert.equal(checkpoint.body.data.continuation.nextCall.tool, plan[0].tool);
    for (let index = 0; index < plan.length; index += 1) {
      const response = await call(server, plan[index].tool, plan[index].input, identity);
      assert.equal(response.body.ok, true, JSON.stringify(response.body));
      if (index < plan.length - 1) assert.equal(response.body.data.continuation.nextCall.tool, plan[index + 1].tool);
      else assert.match(response.body.data.continuation.nextCallRequired, /exactly 3 nextCalls/);
    }
  } finally { await server.close(); }
});

test('operations exceeding 200ms detach, keep running, and complete through task_poll', async () => {
  const server = await createRuntime({ actionsContinuationMode: 'next-call', nonBlockingTasksEnabled: true });
  try {
    const registration = await server.runtime.extensions.registerFromTui({ action: 'upsert', spec: {
      name: 'slow_echo', title: 'Slow echo', description: 'Waits long enough to exercise background task detachment.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      handler: { kind: 'command', executable: process.execPath, args: ['-e', "setTimeout(() => process.stdout.write('done'), 450)"] },
    } });
    assert.equal(registration.ok, true);
    const created = await root(server, 'background-mode');
    const identity = created.identity;
    await call(server, 'session_checkpoint', { phase: 'working', summary: 'Run the slow operation.', nextCalls: [{ tool: 'slow_echo', input: {} }] }, identity);
    const started = performance.now();
    const detached = await call(server, 'slow_echo', {}, identity);
    const elapsed = performance.now() - started;
    assert.equal(detached.body.data.result.status, 'running');
    assert.ok(elapsed < 380, `expected fast return near 200ms, got ${elapsed}ms`);
    const taskId = detached.body.data.result.taskId;
    assert.equal(detached.body.data.continuation.nextCall.tool, 'task_poll');
    const early = await call(server, 'task_poll', { taskId }, identity);
    assert.equal(early.body.data.result.status, 'running');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const completed = await call(server, 'task_poll', { taskId }, identity);
    assert.equal(completed.body.data.result.status, 'completed');
    assert.equal(completed.body.data.result.operation.data.result.stdout, 'done');
    assert.equal(completed.body.data.continuation.reason, 'continuation_plan_exhausted');
  } finally { await server.close(); }
});

test('completed background task retention is bounded by count and serialized bytes', async () => {
  const dirs = tempWorkspace();
  const config = { ...dirs, settingsPath: path.join(dirs.stateDir, 'settings.json'), host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'en', uiTheme: 'dark', passiveLockEnabled: false, actionsContinuationMode: 'off', nonBlockingTasksEnabled: true };
  const service = new ExtensionService(config, new MyTerminalStore(dirs.stateDir), new Map());
  try {
    const completedAt = new Date().toISOString();
    for (let index = 0; index < 110; index += 1) {
      service.backgroundTasks.set(`task-${index}`, {
        id: `task-${index}`, sessionId: 'fixture', tool: 'fixture', input: {}, source: 'actions',
        startedAt: Date.now(), status: 'completed', completedAt,
        response: { ok: true, data: { payload: 'x'.repeat(300_000), index } },
      });
    }
    service.trimBackgroundTasks();
    const retained = [...service.backgroundTasks.values()];
    const retainedBytes = retained.reduce((total, task) => total + Buffer.byteLength(JSON.stringify(task.response)), 0);
    assert.ok(retained.length <= 100);
    assert.ok(retainedBytes <= 24 * 1024 * 1024);
    assert.equal(service.backgroundTasks.has('task-0'), false);
  } finally {
    await service.shutdown();
    fs.rmSync(dirs.workspaceDir, { recursive: true, force: true });
  }
});

test('non-blocking task scheduling is independent and disabled by default', async () => {
  const server = await createRuntime({ actionsContinuationMode: 'off', nonBlockingTasksEnabled: false });
  try {
    await server.runtime.extensions.registerFromTui({ action: 'upsert', spec: {
      name: 'attached_echo', title: 'Attached echo', description: 'Waits past the optional fast-return threshold.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      handler: { kind: 'command', executable: process.execPath, args: ['-e', "setTimeout(() => process.stdout.write('attached'), 300)"] },
    } });
    const created = await root(server, 'attached-default');
    const started = performance.now();
    const response = await call(server, 'attached_echo', {}, created.identity);
    assert.ok(performance.now() - started >= 250);
    assert.equal(response.body.data.result.stdout, 'attached');
    assert.equal(response.body.data.result.status, undefined);
  } finally { await server.close(); }
});

test('harness-off failures do not inject an empty continuation contract', async () => {
  const server = await createRuntime({ actionsContinuationMode: 'off', nonBlockingTasksEnabled: false });
  try {
    const created = await root(server, 'off-failure');
    const response = await call(server, 'execute_cli', { command: `${JSON.stringify(process.execPath)} -e "process.exit(2)"` }, created.identity);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, 'NON_ZERO_EXIT');
    assert.equal(response.body.data.continuation, undefined);
  } finally { await server.close(); }
});

test('runtime close cancels a detached command tree before it can mutate the workspace', async () => {
  const server = await createRuntime({ actionsContinuationMode: 'off', nonBlockingTasksEnabled: true });
  const target = path.join(server.dirs.workspaceDir, 'late-write.txt');
  try {
    const created = await root(server, 'shutdown-cancel');
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => require('fs').writeFileSync('late-write.txt', 'late'), 1200)")}`;
    const detached = await call(server, 'execute_cli', { command, timeoutSec: 10 }, created.identity);
    assert.equal(detached.body.data.result.status, 'running');
    await server.runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 1350));
    assert.equal(fs.existsSync(target), false);
    assert.ok(server.runtime.store.auditFacts(100).some((fact) => fact.action === 'execute_cli' && fact.status === 'failed'));
  } finally {
    await server.runtime.close().catch(() => undefined);
    fs.rmSync(server.dirs.workspaceDir, { recursive: true, force: true });
  }
});

test('history pagination uses bounded ranges and notices external appends', () => {
  const dirs = tempWorkspace();
  try {
    const store = new MyTerminalStore(dirs.stateDir);
    const created = store.registerRoot({ name: 'history-index' });
    const historyPath = path.join(dirs.stateDir, 'history', `${created.session.id}.jsonl`);
    const rows = Array.from({ length: 3000 }, (_, index) => JSON.stringify({ at: new Date(index).toISOString(), type: 'fixture', data: { index } })).join('\n') + '\n';
    fs.appendFileSync(historyPath, rows);
    const totalBefore = store.historyCount(created.session.id);
    const page = store.historyPage(created.session.id, 1500, 10, false);
    assert.equal(page.total, totalBefore);
    assert.equal(page.entries.length, 10);
    assert.equal(page.entries[0].data.index, 1499);
    fs.appendFileSync(historyPath, `${JSON.stringify({ at: new Date(4000).toISOString(), type: 'external', data: { index: 3000 } })}\n`);
    assert.equal(store.historyCount(created.session.id), totalBefore + 1);
    assert.equal(store.historyPage(created.session.id, totalBefore, 1, false).entries[0].type, 'external');
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('Apps exposes full generic and narrow direct tools, binds root sessions automatically, and stages blobs safely', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'myterminal-test', version: '1.0.0' } } });
    assert.match(init.data.result.instructions, /Do not use session_inherit to continue completed work/); assert.match(init.data.result.instructions, /message_conversation/);
    const listed = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sessionId);
    const appTools = listed.data.result.tools;
    const names = appTools.map((tool) => tool.name);
    for (const required of ['session_register', 'session_checkpoint', 'workspace_info', 'read_file', 'blob_create', 'blob_write_file', 'task_poll']) assert.ok(names.includes(required), required);
    assert.equal(names.includes('extension_call'), true);
    assert.equal(names.includes('extension_register'), true);
    const genericCall = appTools.find((tool) => tool.name === 'extension_call');
    const genericRegister = appTools.find((tool) => tool.name === 'extension_register');
    assert.equal(genericCall.annotations.destructiveHint, true);
    assert.equal(genericCall.annotations.openWorldHint, true);
    assert.equal(genericRegister.annotations.destructiveHint, true);
    assert.equal(genericRegister.annotations.openWorldHint, false);
    const narrowTools = appTools.filter((tool) => !['extension_call', 'extension_register'].includes(tool.name));
    assert.equal(narrowTools.every((tool) => tool.annotations?.destructiveHint === false && tool.annotations?.openWorldHint === false), true);
    assert.equal(appTools.find((tool) => tool.name === 'message_inbox').annotations.readOnlyHint, false);
    const anonymous = await rpcPost(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'extension_discover', arguments: { identity: null }, _meta: { 'openai/session': 'chat-a' } } }, init.sessionId);
    assert.equal(anonymous.data.result.structuredContent.data.identityRequired, true);
    const created = await rpcPost(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 'apps-root' }, _meta: { 'openai/session': 'chat-a' } } }, init.sessionId);
    const identity = created.data.result.structuredContent.data.result.identity;
    assert.ok(identity.sessionId && identity.sessionToken);
    const bound = await rpcPost(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'session_list', arguments: {}, _meta: { 'openai/session': 'chat-a' } } }, init.sessionId);
    assert.equal(bound.data.result.structuredContent.data.result.sessions[0].name, 'apps-root');
    const staged = await rpcPost(url, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'blob_create', arguments: { content: 'staged through apps' }, _meta: { 'openai/session': 'chat-a' } } }, init.sessionId);
    const sha256 = staged.data.result.structuredContent.data.result.sha256;
    const written = await rpcPost(url, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'blob_write_file', arguments: { sha256, path: 'from-blob.txt' }, _meta: { 'openai/session': 'chat-a' } } }, init.sessionId);
    assert.equal(written.data.result.structuredContent.data.result.sha256, sha256);
    assert.equal(written.data.result.structuredContent.data.result.alreadyExisted, false);
    assert.equal(fs.readFileSync(path.join(server.dirs.workspaceDir, 'from-blob.txt'), 'utf8'), 'staged through apps');
    const repeated = await rpcPost(url, { jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'blob_write_file', arguments: { sha256, path: 'from-blob.txt' }, _meta: { 'openai/session': 'chat-a' } } }, init.sessionId);
    assert.equal(repeated.data.result.structuredContent.ok, true);
    assert.equal(repeated.data.result.structuredContent.data.result.alreadyExisted, true);
    const overwritten = await rpcPost(url, { jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'write_file', input: { path: 'from-blob.txt', content: 'overwritten through generic Apps facade' } }, _meta: { 'openai/session': 'chat-a' } } }, init.sessionId);
    assert.equal(overwritten.data.result.structuredContent.ok, true, JSON.stringify(overwritten.data.result.structuredContent));
    assert.equal(fs.readFileSync(path.join(server.dirs.workspaceDir, 'from-blob.txt'), 'utf8'), 'overwritten through generic Apps facade');
    const collision = await rpcPost(url, { jsonrpc: '2.0', id: 72, method: 'tools/call', params: { name: 'blob_write_file', arguments: { sha256, path: 'from-blob.txt' }, _meta: { 'openai/session': 'chat-a' } } }, init.sessionId);
    assert.equal(collision.data.result.structuredContent.ok, false);
    assert.match(collision.data.result.structuredContent.error.message, /different content/);
    const appFacts = server.runtime.store.auditFacts(100);
    assert.ok(appFacts.some((fact) => fact.source === 'apps' && fact.action === 'session_register' && fact.status === 'completed'));
    assert.equal(appFacts.every((fact) => fact.source === 'apps'), true);
    const completedAppCall = appFacts.find((fact) => fact.action === 'session_register' && fact.result);
    assert.ok(completedAppCall.timestamp);
    assert.ok(completedAppCall.completedAt);
    assert.equal(completedAppCall.result.ok, true);
    const differentChat = await rpcPost(url, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'session_list', arguments: {}, _meta: { 'openai/session': 'chat-b' } } }, init.sessionId);
    assert.equal(differentChat.data.result.structuredContent.error.code, 'IDENTITY_REQUIRED');
  } finally { await server.close(); }
});


test('temporarily unavailable workspace preserves parsed settings and credentials byte-for-byte', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-credential-stability-'));
  const workspaceDir = path.join(root, 'workspace');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const env = { ...process.env, MYTERMINAL_CONFIG_DIR: configDir };
  const settings = { ...createDefaultSettings(workspaceDir), connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN };
  saveMyTerminalSettings(settings, env);
  const before = fs.readFileSync(settingsPath(env));
  fs.renameSync(workspaceDir, `${workspaceDir}.offline`);
  const parsed = readMyTerminalSettings(env);
  assert.equal(parsed.connectorKey, CONNECTOR_KEY);
  assert.equal(parsed.actionsToken, ACTIONS_TOKEN);
  assert.equal(assessRuntimeEnvironment(parsed, env).status, 'workspace_missing');
  assert.deepEqual(fs.readFileSync(settingsPath(env)), before);
  fs.rmSync(root, { recursive: true, force: true });
});

test('credential generation is explicit and read failures never invoke rotation', () => {
  const source = fs.readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  assert.match(source, /Invalid or temporarily unreadable settings must never fall through/);
  assert.doesNotMatch(source, /catch \(error\)[\s\S]{0,160}createDefaultSettings/);
  const stable = { ...createDefaultSettings(process.cwd()), connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN };
  const rotated = rotateMyTerminalCredentials(stable);
  assert.notEqual(rotated.connectorKey, stable.connectorKey);
  assert.notEqual(rotated.actionsToken, stable.actionsToken);
});

test('runtime enters degraded state for mount loss and recovers without changing credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-resume-'));
  const workspaceDir = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const runtime = new MyTerminalRuntime({ workspaceDir, stateDir, settingsPath: path.join(root, 'config.json'), host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: 'http://127.0.0.1:0', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false });
  await runtime.start();
  const renamed = `${workspaceDir}.offline`;
  try {
    fs.renameSync(workspaceDir, renamed);
    const degraded = await runtime.revalidateAfterResume('test mount loss');
    assert.equal(degraded.phase, 'degraded');
    assert.equal(runtime.config.connectorKey, CONNECTOR_KEY);
    assert.equal(runtime.config.actionsToken, ACTIONS_TOKEN);
    fs.renameSync(renamed, workspaceDir);
    const recovered = await runtime.revalidateAfterResume('test mount restored');
    assert.equal(recovered.phase, 'active');
  } finally {
    if (fs.existsSync(renamed) && !fs.existsSync(workspaceDir)) fs.renameSync(renamed, workspaceDir);
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fatal TUI boundary logs render failures and exposes q or Escape safe exit', () => {
  const boundary = fs.readFileSync(new URL('../src/tui/FatalErrorBoundary.tsx', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../src/tui/App.tsx', import.meta.url), 'utf8');
  assert.match(boundary, /componentDidCatch/);
  assert.match(boundary, /runtime\.log/);
  assert.match(boundary, /Press q or Esc|按 q 或 Esc/);
  assert.match(app, /fatalError && \(event\.name === 'q' \|\| event\.name === 'escape'\)/);
  assert.match(app, /void quit\(\)/);
});

test('message composer does not open when no active recipient exists', () => {
  const source = fs.readFileSync(new URL('../src/tui/state.ts', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('async sendMessage'), source.indexOf('async addExtension'));
  assert.match(block, /if \(!sessions\.length\)/);
  assert.match(block, /No active sessions are available to receive a message/);
  assert.doesNotMatch(block, /not impersonating any session|不会冒充任何 session/);
  assert.ok(block.indexOf('if (!sessions.length)') < block.indexOf('const answers = await ask'));
});

test('project copy constraints forbid exposing implementation requirements as UI copy', () => {
  const constraints = fs.readFileSync(new URL('../AI_RULES.md', import.meta.url), 'utf8');
  assert.match(constraints, /must not be shown as user-facing UI copy/);
});

test('credential reveal has a fail-closed deadline when terminals omit key release', () => {
  const app = fs.readFileSync(new URL('../src/tui/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /credentialRevealDeadline/);
  assert.match(app, /performance\.now\(\) \+ 450/);
  assert.match(app, /setInterval\([\s\S]*setRevealCredentials\(false\)/);
  assert.doesNotMatch(app, /event\.eventType === 'release'[\s\S]*credentialRevealDeadline\.current = 0/);
  assert.match(app, /event\.eventType !== 'release'[\s\S]*credentialRevealDeadline\.current = performance\.now\(\) \+ 450/);
});

test('release installers resume partial downloads and repair incomplete layouts', () => {
  for (const file of ['../scripts/install-macos.sh', '../scripts/install-linux.sh']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /--continue-at|-C -/);
    assert.match(source, /\.part/);
    assert.match(source, /install_dir\/releases|\$install_dir\/releases/);
    assert.match(source, /Invalid MyTerminal version/);
    assert.match(source, /Refusing unsafe installation root/);
    assert.match(source, /--verify-installation/);
    assert.match(source, /Release version mismatch/);
  }
  const windows = fs.readFileSync(new URL('../scripts/install-windows.ps1', import.meta.url), 'utf8');
  assert.match(windows, /curl\.exe[\s\S]*--continue-at/);
  assert.match(windows, /\$\{Version\}: \$InstallDir/);
  assert.match(windows, /Invalid MyTerminal version/);
  assert.match(windows, /Refusing unsafe installation root/);
  assert.match(windows, /--verify-installation/);
  assert.match(windows, /CandidateVerified/);
  assert.match(windows, /InstalledVerified/);
  assert.match(windows, /Attempt -le 10/);
  assert.doesNotMatch(windows, /\$Version: \$InstallDir/);
});

test('macOS binary release packages and resolves the passive-lock helper source', () => {
  const resources = fs.readFileSync(new URL('../src/session-resources.ts', import.meta.url), 'utf8');
  const workflow = fs.readFileSync(new URL('../.github/workflows/release.yaml', import.meta.url), 'utf8');
  assert.match(resources, /path\.dirname\(process\.execPath\)/);
  assert.match(workflow, /mac-one-shot-awake-lock\.swift/);
  assert.match(workflow, /--verify-installation/);
  assert.match(workflow, /bun-darwin-x64-baseline/);
  assert.match(workflow, /bun-linux-x64-baseline/);
  assert.match(workflow, /bun-windows-x64-baseline/);
  assert.match(workflow, /bun-v1\.3\.14\/bun-windows-x64-baseline\.zip/);
  assert.match(workflow, /Build standalone executable with baseline Bun/);
  assert.match(workflow, /WriteAllText\([^\n]+`n[^\n]+UTF8Encoding/);
});

test('idle TUI refresh is revision-driven and never forces periodic deep snapshot renders', () => {
  const app = fs.readFileSync(new URL('../src/tui/App.tsx', import.meta.url), 'utf8');
  const controller = fs.readFileSync(new URL('../src/tui/state.ts', import.meta.url), 'utf8');
  assert.match(controller, /renderRevision\(\)/);
  assert.match(app, /nextRevision !== renderedRevision/);
  assert.doesNotMatch(app, /tickReminders\(\);\s*refresh\(\)/);
  assert.doesNotMatch(app, /setInterval\([^)]*500\)/);
});

test('TUI snapshots are referentially cached until a runtime revision changes', () => {
  const dirs = tempWorkspace();
  const runtime = new MyTerminalRuntime({ ...dirs, settingsPath: path.join(dirs.stateDir, 'test-settings.json'), host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: 'http://127.0.0.1:0', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark' });
  const controller = new TuiController(runtime, async () => { throw new Error('not used'); });
  try {
    const first = controller.snapshot();
    assert.equal(controller.snapshot(), first);
    runtime.log('snapshot revision changed');
    assert.notEqual(controller.snapshot(), first);
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('runtime logs rotate at bounded size and tail pages avoid loading the full file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-log-rotation-'));
  const configDir = path.join(root, 'config');
  const workspaceDir = path.join(root, 'workspace');
  const stateDir = path.join(configDir, 'workspaces', workspaceId(workspaceDir));
  fs.mkdirSync(stateDir, { recursive: true });
  upsertWorkspaceRecord(configDir, { id: workspaceId(workspaceDir), workspaceDir, stateDir, lastSeenAt: new Date().toISOString() });
  const payload = 'x'.repeat(4096);
  for (let index = 0; index < 1400; index += 1) appendWorkspaceLog(stateDir, { at: new Date(index).toISOString(), level: 'info', message: `${index}:${payload}` });
  const files = fs.readdirSync(stateDir).filter((name) => name.startsWith('runtime.jsonl'));
  assert.ok(files.length <= 4, `expected current log plus at most three archives, got ${files.length}`);
  assert.ok(fs.statSync(path.join(stateDir, 'runtime.jsonl')).size < 5.1 * 1024 * 1024);
  const firstPage = readWorkspaceLogs(configDir, 25, 0)[0].entries;
  const secondPage = readWorkspaceLogs(configDir, 25, 25)[0].entries;
  assert.equal(firstPage.length, 25);
  assert.equal(secondPage.length, 25);
  assert.notDeepEqual(firstPage, secondPage);
  assert.match(firstPage.at(-1).message, /^1399:/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('logs screen paginates rendering and exposes page navigation', () => {
  const screen = fs.readFileSync(new URL('../src/tui/screens/Logs.tsx', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../src/tui/App.tsx', import.meta.url), 'utf8');
  assert.match(screen, /PAGE_SIZE = 100/);
  assert.match(screen, /PgUp\/PgDn/);
  assert.match(app, /event\.name === 'pagedown'/);
  assert.match(app, /event\.name === 'pageup'/);
});

test('update transaction snapshots configuration and restores regressed state and logs', async () => {
  const { snapshotUpdateData, restoreMissingUpdateData } = await import('../dist/update.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-update-data-'));
  const stateDir = path.join(root, 'workspaces', 'abc');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ schemaVersion: 1, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN }));
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ schemaVersion: 2, revision: 9, sessions: [{ id: 's' }], messages: [{ id: 'm' }] }));
  fs.writeFileSync(path.join(stateDir, 'runtime.jsonl'), '{"message":"before"}\n');
  const snapshot = snapshotUpdateData(root);
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ schemaVersion: 2, revision: 1, sessions: [], messages: [] }));
  fs.writeFileSync(path.join(stateDir, 'runtime.jsonl'), '');
  restoreMissingUpdateData(snapshot, root);
  const restored = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  assert.equal(restored.revision, 9);
  assert.equal(restored.sessions.length, 1);
  assert.match(fs.readFileSync(path.join(stateDir, 'runtime.jsonl'), 'utf8'), /before/);
  assert.match(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), new RegExp(CONNECTOR_KEY));
  fs.rmSync(root, { recursive: true, force: true });
});

test('installers keep legacy backups under config and Windows launcher avoids PowerShell policy', () => {
  for (const file of ['../scripts/install-macos.sh', '../scripts/install-linux.sh']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /install-backups/);
    assert.doesNotMatch(source, /\$\{install_dir\}\.backup/);
  }
  const windows = fs.readFileSync(new URL('../scripts/install-windows.ps1', import.meta.url), 'utf8');
  assert.match(windows, /myterminal\.cmd/);
  assert.match(windows, /set \/p VERSION/);
  assert.match(windows, /Remove-Item[^\n]*myterminal\.ps1|\$PowerShellLauncher/);
  assert.doesNotMatch(windows, /powershell\.exe -NoProfile -ExecutionPolicy Bypass -File/);
});

test('policy rejections (NEXT_CALL_REQUIRED) are audited as policy_rejected, not failed', async () => {
  const server = await createRuntime({ actionsContinuationMode: 'next-call' });
  try {
    const created = await root(server, 'policy-audit');
    const identity = created.identity;
    await call(server, 'session_checkpoint', {
      phase: 'working', summary: 'Plan set.',
      nextCalls: [{ tool: 'workspace_info', input: {}, purpose: 'Next step.' }],
    }, identity);
    const wrong = await call(server, 'list_dir', { path: '.' }, identity);
    assert.equal(wrong.body.error.code, 'NEXT_CALL_REQUIRED');
    const facts = server.runtime.store.auditFacts(500);
    const rejected = facts.find((f) => f.action === 'list_dir' && f.status === 'policy_rejected');
    assert.ok(rejected, 'policy rejection should be audited as policy_rejected');
    assert.equal(rejected.errorCode, 'NEXT_CALL_REQUIRED');
    const failedListDir = facts.find((f) => f.action === 'list_dir' && f.status === 'failed');
    assert.equal(failedListDir, undefined, 'policy rejection must not be audited as failed');
  } finally { await server.close(); }
});

test('CONTINUATION_PLAN_REQUIRED checkpoint rejection is audited as policy_rejected', async () => {
  const server = await createRuntime({ actionsContinuationMode: 'next-call' });
  try {
    const created = await root(server, 'checkpoint-policy-audit');
    const identity = created.identity;
    const missing = await call(server, 'session_checkpoint', { phase: 'working', summary: 'No nextCalls.' }, identity);
    assert.equal(missing.body.error.code, 'CONTINUATION_PLAN_REQUIRED');
    const facts = server.runtime.store.auditFacts(500);
    const rejected = facts.find((f) => f.action === 'session_checkpoint' && f.status === 'policy_rejected');
    assert.ok(rejected, 'checkpoint policy rejection should be audited as policy_rejected');
    assert.equal(rejected.errorCode, 'CONTINUATION_PLAN_REQUIRED');
  } finally { await server.close(); }
});

test('search_text and find_files normalize the pattern alias to query (Claude Code compatibility)', async () => {
  const server = await createRuntime({ actionsContinuationMode: 'off' });
  try {
    const created = await root(server, 'alias-test');
    const identity = created.identity;
    const search = await call(server, 'search_text', { pattern: 'hello' }, identity);
    assert.equal(search.body.ok, true, JSON.stringify(search.body));
    assert.ok(search.body.data.result.matches.length > 0, 'search_text should find hello via pattern alias');
    const find = await call(server, 'find_files', { pattern: 'hello' }, identity);
    assert.equal(find.body.ok, true, JSON.stringify(find.body));
    assert.ok(find.body.data.result.matches.length > 0, 'find_files should match hello.txt via pattern alias');
  } finally { await server.close(); }
});

test('auditFact fills UNKNOWN_ERROR for failed records missing an error code', () => {
  const dirs = tempWorkspace();
  try {
    const store = new MyTerminalStore(dirs.stateDir);
    const created = store.registerRoot({ name: 'fallback-test' });
    store.auditEvent(created.session.id, {
      id: 'act_test_fallback', timestamp: new Date().toISOString(), completedAt: new Date().toISOString(),
      source: 'actions', action: 'execute_cli', status: 'failed', durationMs: 100,
      workspace: dirs.workspaceDir, session: created.session.id, args: {}, result: {},
    });
    const facts = store.auditFacts(100);
    const fact = facts.find((f) => f.id === 'act_test_fallback');
    assert.ok(fact, 'fallback audit fact should exist');
    assert.equal(fact.status, 'failed');
    assert.equal(fact.errorCode, 'UNKNOWN_ERROR', 'missing error code should fall back to UNKNOWN_ERROR');
    assert.ok(fact.error && fact.error.code === 'UNKNOWN_ERROR');
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('delegate session with blockedBy creates bidirectional dependency links', async () => {
  const server = await createRuntime({ actionsContinuationMode: 'off' });
  try {
    const created = await root(server, 'parent-dag');
    const identity = created.identity;
    const del = await call(server, 'session_register', { mode: 'delegate', name: 'child-dag', role: 'worker', task, blockedBy: [created.session.id] }, identity);
    assert.equal(del.body.ok, true);
    const all = server.runtime.store.listSessions();
    const parent = all.find((s) => s.id === created.session.id);
    const child = all.find((s) => s.name === 'child-dag');
    assert.ok(parent, 'parent should exist');
    assert.ok(child, 'child should exist');
    assert.ok(child.blockedBy.includes(parent.id), 'child blockedBy parent');
    assert.ok(parent.blocks.includes(child.id), 'parent blocks child');
  } finally { await server.close(); }
});
