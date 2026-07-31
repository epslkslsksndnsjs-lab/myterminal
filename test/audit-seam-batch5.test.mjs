/**
 * Seam lock tests for issue #30 (batch5 cut 1): withAudit() extraction.
 *
 * Locks the audit record format and ToolResponse structure across all 4 audit
 * paths: call() sync, call() non-blocking detach, callSubagent(), and
 * completeBackgroundTask/failBackgroundTask.
 *
 * These tests must pass unchanged before AND after the withAudit() refactor.
 * ADR-0032 G4: lock → refactor → re-run (zero diff).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExtensionService } from '../dist/extensions.js';
import { MyTerminalStore } from '../dist/store.js';

const CONNECTOR_KEY = 'test-connector-key-batch5-seam';
const ACTIONS_TOKEN = 'test-actions-token-batch5-seam-00';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-audit-seam-'));
}

function configFor(root, overrides = {}) {
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
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
    ...overrides,
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

function setup(overrides = {}, tools = []) {
  const root = tempRoot();
  const config = configFor(root, overrides);
  const store = new MyTerminalStore(config.stateDir);
  const auditEvents = [];
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const service = new ExtensionService(config, store, toolMap, (event) => auditEvents.push(event));
  const created = store.registerRoot({ name: 'seam-root' });
  return { root, config, store, service, auditEvents, identity: created.identity, sessionId: created.session.id };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Assert that an audit event has the canonical field set (no extra, no missing). */
function assertAuditEventShape(event, { status, source, action, session, workspace }) {
  // Required fields always present
  assert.equal(typeof event.id, 'string', 'audit event must have string id');
  assert.match(event.id, /^act_/, 'audit event id must start with act_');
  assert.equal(typeof event.timestamp, 'string', 'audit event must have timestamp');
  assert.equal(event.source, source, 'audit event source mismatch');
  assert.equal(event.action, action, 'audit event action mismatch');
  assert.equal(event.status, status, 'audit event status mismatch');
  assert.equal(typeof event.durationMs, 'number', 'audit event must have numeric durationMs');
  assert.equal(event.workspace, workspace, 'audit event workspace mismatch');
  assert.equal(event.session, session, 'audit event session mismatch');
  // Terminal events have completedAt
  if (status !== 'running') {
    assert.equal(typeof event.completedAt, 'string', 'terminal audit event must have completedAt');
  }
}

// ─── S1: call() sync success — audit record format ───────────────────────────

test('S1: call() sync success produces correct audit record format', async () => {
  const okTool = tool('seam_ok', async (input) => ({ value: 'done', label: input.label }), { label: { type: 'string' } });
  const { root, config, service, auditEvents, identity, sessionId } = setup({}, [okTool]);
  try {
    const response = await service.call(
      { tool: 'seam_ok', input: { label: 'hello' }, identity },
      { transport: 'actions' },
    );
    assert.equal(response.ok, true);

    // Two audit events: running + completed
    assert.equal(auditEvents.length, 2, 'expected running + completed audit events');
    const [running, completed] = auditEvents;

    assertAuditEventShape(running, { status: 'running', source: 'actions', action: 'seam_ok', session: sessionId, workspace: config.workspaceDir });
    assert.equal(running.durationMs, 0, 'running event durationMs must be 0');
    assert.ok(running.args, 'running event must have args');

    assertAuditEventShape(completed, { status: 'completed', source: 'actions', action: 'seam_ok', session: sessionId, workspace: config.workspaceDir });
    assert.ok(completed.durationMs >= 0, 'completed event durationMs must be >= 0');
    assert.equal(completed.error, undefined, 'completed event must not have error');
    assert.ok(completed.result, 'completed event must have result');
    // result is the full ToolResponse passed to finishAudit
    assert.equal(completed.result.ok, true);
    assert.equal(completed.result.data.tool, 'seam_ok');
    assert.deepEqual(completed.result.data.result, { value: 'done', label: 'hello' });
  } finally {
    cleanup(root);
  }
});

// ─── S2: call() sync success — ToolResponse structure ────────────────────────

test('S2: call() sync success ToolResponse structure', async () => {
  const okTool = tool('seam_ok2', async () => ({ answer: 42 }));
  const { root, service, identity } = setup({}, [okTool]);
  try {
    const response = await service.call(
      { tool: 'seam_ok2', input: {}, identity },
      { transport: 'actions' },
    );
    // Top-level shape
    assert.equal(response.ok, true);
    assert.equal(typeof response.data, 'object');
    assert.equal(response.data.tool, 'seam_ok2');
    assert.deepEqual(response.data.result, { answer: 42 });
    // With continuationMode 'off', no continuation decoration expected
    assert.equal(response.data.continuation, undefined, 'no continuation when mode is off');
    // error must be absent on success
    assert.equal(response.error, undefined);
  } finally {
    cleanup(root);
  }
});

// ─── S3: call() sync failure — audit + ToolResponse ──────────────────────────

test('S3: call() sync failure audit record and ToolResponse', async () => {
  const failTool = tool('seam_fail', async () => { throw new Error('boom'); });
  const { root, config, service, auditEvents, identity, sessionId } = setup({}, [failTool]);
  try {
    const response = await service.call(
      { tool: 'seam_fail', input: {}, identity },
      { transport: 'actions' },
    );
    assert.equal(response.ok, false);
    // ToolResponse error structure (ADR-0028: non-MyTerminalError → INTERNAL)
    assert.equal(typeof response.error.code, 'string');
    assert.equal(response.error.code, 'INTERNAL');
    assert.equal(typeof response.error.message, 'string');
    assert.equal(typeof response.error.retryable, 'boolean');
    assert.equal(response.error.retryable, false);

    // Audit: running + failed
    assert.equal(auditEvents.length, 2);
    const [, failed] = auditEvents;
    assertAuditEventShape(failed, { status: 'failed', source: 'actions', action: 'seam_fail', session: sessionId, workspace: config.workspaceDir });
    assert.ok(failed.error, 'failed audit event must have error');
    assert.equal(failed.error.code, 'EXTENSION_ERROR');
  } finally {
    cleanup(root);
  }
});

// ─── S4: callSubagent() success — audit record format ────────────────────────

test('S4: callSubagent() success audit record format (source=subagent)', async () => {
  const okTool = tool('seam_sub_ok', async () => ({ sub: 'result' }));
  const { root, config, store, service, auditEvents, identity, sessionId } = setup({}, [okTool]);
  try {
    const response = await service.callSubagent(
      { tool: 'seam_sub_ok', input: {}, identity },
      { transport: 'subagent' },
    );
    assert.equal(response.ok, true);

    // Two audit events: running + completed
    assert.equal(auditEvents.length, 2);
    const [running, completed] = auditEvents;

    assertAuditEventShape(running, { status: 'running', source: 'subagent', action: 'seam_sub_ok', session: sessionId, workspace: config.workspaceDir });
    assertAuditEventShape(completed, { status: 'completed', source: 'subagent', action: 'seam_sub_ok', session: sessionId, workspace: config.workspaceDir });
    assert.equal(completed.error, undefined);
    assert.ok(completed.result);
    assert.equal(completed.result.ok, true);
    assert.equal(completed.result.data.tool, 'seam_sub_ok');
    assert.deepEqual(completed.result.data.result, { sub: 'result' });
  } finally {
    cleanup(root);
  }
});

// ─── S5: callSubagent() success — ToolResponse trimmed (ADR-0009) ────────────

test('S5: callSubagent() ToolResponse is trimmed — no continuation, no events', async () => {
  const okTool = tool('seam_sub_trim', async () => ({ trimmed: true }));
  // Use continuation mode 'next-call' to prove callSubagent skips decoration
  const { root, service, identity } = setup({ actionsContinuationMode: 'next-call' }, [okTool]);
  try {
    const response = await service.callSubagent(
      { tool: 'seam_sub_trim', input: {}, identity },
      { transport: 'subagent' },
    );
    assert.equal(response.ok, true);
    assert.equal(response.data.tool, 'seam_sub_trim');
    assert.deepEqual(response.data.result, { trimmed: true });
    // ADR-0009 trimmed: NO continuation decoration
    assert.equal(response.data.continuation, undefined, 'callSubagent must NOT decorate continuation');
    // ADR-0009 trimmed: NO events attachment
    assert.equal(response.events, undefined, 'callSubagent must NOT attach events');
  } finally {
    cleanup(root);
  }
});

// ─── S6: callSubagent() failure — audit + ToolResponse ───────────────────────

test('S6: callSubagent() failure audit record and ToolResponse', async () => {
  const failTool = tool('seam_sub_fail', async () => { throw new Error('sub boom'); });
  const { root, config, service, auditEvents, identity, sessionId } = setup({}, [failTool]);
  try {
    const response = await service.callSubagent(
      { tool: 'seam_sub_fail', input: {}, identity },
      { transport: 'subagent' },
    );
    assert.equal(response.ok, false);
    // ADR-0028: non-MyTerminalError → INTERNAL in ToolResponse
    assert.equal(response.error.code, 'INTERNAL');
    assert.equal(typeof response.error.message, 'string');
    assert.equal(response.error.retryable, false);
    // Trimmed: no continuation, no events even on failure
    assert.equal(response.data, undefined, 'callSubagent failure must not have data');
    assert.equal(response.events, undefined, 'callSubagent failure must not have events');

    // Audit: running + failed
    assert.equal(auditEvents.length, 2);
    const [, failed] = auditEvents;
    assertAuditEventShape(failed, { status: 'failed', source: 'subagent', action: 'seam_sub_fail', session: sessionId, workspace: config.workspaceDir });
    assert.ok(failed.error);
    assert.equal(failed.error.code, 'EXTENSION_ERROR');
  } finally {
    cleanup(root);
  }
});

// ─── S7: completeBackgroundTask — audit record format ────────────────────────

test('S7: completeBackgroundTask audit record format (async completion)', async () => {
  let resolveTool;
  const slowTool = tool('seam_bg_ok', async () => {
    await new Promise((resolve) => { resolveTool = resolve; });
    return { bg: 'done' };
  });
  const { root, config, service, auditEvents, identity, sessionId } = setup({ nonBlockingTasksEnabled: true }, [slowTool]);
  try {
    // Call with non-blocking enabled; tool hangs → detaches after 200ms
    const responsePromise = service.call(
      { tool: 'seam_bg_ok', input: {}, identity },
      { transport: 'actions' },
    );
    // Wait for detach
    const detachResponse = await responsePromise;
    assert.equal(detachResponse.ok, true);
    assert.equal(detachResponse.data.result.status, 'running');
    const taskId = detachResponse.data.result.taskId;
    assert.ok(taskId, 'detach response must include taskId');

    // Now resolve the tool → triggers completeBackgroundTask
    resolveTool();
    // Wait for background completion to flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Audit events: running (from beginAudit) + completed (from completeBackgroundTask)
    assert.ok(auditEvents.length >= 2, `expected >= 2 audit events, got ${auditEvents.length}`);
    const completed = auditEvents.find((e) => e.status === 'completed' && e.action === 'seam_bg_ok');
    assert.ok(completed, 'must have a completed audit event for seam_bg_ok');
    assertAuditEventShape(completed, { status: 'completed', source: 'actions', action: 'seam_bg_ok', session: sessionId, workspace: config.workspaceDir });
    assert.equal(completed.error, undefined);
    assert.ok(completed.result, 'completed background task audit must have result');
    assert.equal(completed.result.ok, true);
    assert.equal(completed.result.data.tool, 'seam_bg_ok');
    assert.deepEqual(completed.result.data.result, { bg: 'done' });
  } finally {
    cleanup(root);
  }
});

// ─── S8: failBackgroundTask — audit record format ────────────────────────────

test('S8: failBackgroundTask audit record format (async failure)', async () => {
  let rejectTool;
  const failBgTool = tool('seam_bg_fail', async () => {
    await new Promise((_, reject) => { rejectTool = reject; });
    return {};
  });
  const { root, config, service, auditEvents, identity, sessionId } = setup({ nonBlockingTasksEnabled: true }, [failBgTool]);
  try {
    const responsePromise = service.call(
      { tool: 'seam_bg_fail', input: {}, identity },
      { transport: 'actions' },
    );
    const detachResponse = await responsePromise;
    assert.equal(detachResponse.ok, true);
    assert.equal(detachResponse.data.result.status, 'running');

    // Reject the tool → triggers failBackgroundTask
    rejectTool(new Error('bg explosion'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const failed = auditEvents.find((e) => e.status === 'failed' && e.action === 'seam_bg_fail');
    assert.ok(failed, 'must have a failed audit event for seam_bg_fail');
    assertAuditEventShape(failed, { status: 'failed', source: 'actions', action: 'seam_bg_fail', session: sessionId, workspace: config.workspaceDir });
    assert.ok(failed.error, 'failed background task audit must have error');
    assert.equal(failed.error.code, 'EXTENSION_ERROR');
  } finally {
    cleanup(root);
  }
});

// ─── S9: non-blocking detach immediate response — ToolResponse ───────────────

test('S9: non-blocking detach immediate ToolResponse structure', async () => {
  let resolveTool;
  const hangTool = tool('seam_detach', async () => {
    await new Promise((resolve) => { resolveTool = resolve; });
    return { late: true };
  });
  const { root, service, identity } = setup({ nonBlockingTasksEnabled: true }, [hangTool]);
  try {
    const response = await service.call(
      { tool: 'seam_detach', input: {}, identity },
      { transport: 'actions' },
    );
    // Immediate detach response shape
    assert.equal(response.ok, true);
    assert.equal(typeof response.data, 'object');
    assert.equal(response.data.tool, 'seam_detach');
    assert.equal(typeof response.data.result, 'object');
    assert.equal(response.data.result.status, 'running');
    assert.equal(typeof response.data.result.taskId, 'string');
    assert.match(response.data.result.taskId, /^act_/, 'taskId must be the actionId');
    assert.equal(typeof response.data.result.startedAt, 'string');
    assert.equal(response.data.result.fastReturnMs, 200);
    // No error on detach
    assert.equal(response.error, undefined);

    // Cleanup: resolve to avoid dangling promise
    resolveTool();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    cleanup(root);
  }
});

// ─── S10–S16: #30 错误路径回归锁（ADR-0032）─────────────────────────────────
// 行为契约：authenticate 抛错时，discover / register / callSubagent 必须返回
// 结构化 ToolResponse（ok:false + error），绝不可向上抛异常——main 基线即如此。
// #30 抽取 withAudit 时曾把 authenticate 移出 try，导致错误路径改为 throw；
// 此处锁死「返回结构化错误而非抛异常」，保证与 main 行为一致。
function badTokenIdentity(identity, token = 'wrong-token') {
  return { sessionId: identity.sessionId, sessionToken: token };
}
function ghostIdentity(sessionId) {
  return { sessionId, sessionToken: 'ghost-token' };
}

test('S10: discover() wrong-token identity returns structured ToolResponse (no throw)', async () => {
  const { root, service, identity } = setup({}, []);
  try {
    const response = await service.discover({ identity: badTokenIdentity(identity) }, { transport: 'actions' });
    assert.equal(response.ok, false);
    assert.equal(typeof response.error.code, 'string');
    assert.equal(typeof response.error.message, 'string');
    assert.equal(typeof response.error.retryable, 'boolean');
  } catch (e) {
    assert.fail(`discover() must not throw on bad identity; threw: ${e?.message ?? e}`);
  } finally {
    cleanup(root);
  }
});

test('S11: register() wrong-token identity returns structured ToolResponse (no throw)', async () => {
  const { root, service, identity } = setup({}, []);
  try {
    const response = await service.register({ action: 'validate', name: 'x', identity: badTokenIdentity(identity) }, { transport: 'actions' });
    assert.equal(response.ok, false);
    assert.equal(typeof response.error.code, 'string');
    assert.equal(typeof response.error.message, 'string');
    assert.equal(typeof response.error.retryable, 'boolean');
  } catch (e) {
    assert.fail(`register() must not throw on bad identity; threw: ${e?.message ?? e}`);
  } finally {
    cleanup(root);
  }
});

test('S12: callSubagent() wrong-token identity returns structured ToolResponse (no throw)', async () => {
  const okTool = tool('seam_cs', async () => ({ v: 1 }));
  const { root, service, identity } = setup({}, [okTool]);
  try {
    const response = await service.callSubagent({ tool: 'seam_cs', input: {}, identity: badTokenIdentity(identity) }, { transport: 'subagent' });
    assert.equal(response.ok, false);
    assert.equal(typeof response.error.code, 'string');
    assert.equal(typeof response.error.message, 'string');
    assert.equal(typeof response.error.retryable, 'boolean');
  } catch (e) {
    assert.fail(`callSubagent() must not throw on bad identity; threw: ${e?.message ?? e}`);
  } finally {
    cleanup(root);
  }
});

test('S13: discover() non-existent session returns structured ToolResponse (no throw)', async () => {
  const { root, service, sessionId } = setup({}, []);
  try {
    const response = await service.discover({ identity: ghostIdentity(sessionId) }, { transport: 'actions' });
    assert.equal(response.ok, false);
    assert.equal(typeof response.error.code, 'string');
  } catch (e) {
    assert.fail(`discover() must not throw on ghost session; threw: ${e?.message ?? e}`);
  } finally {
    cleanup(root);
  }
});

test('S14: register() non-existent session returns structured ToolResponse (no throw)', async () => {
  const { root, service, sessionId } = setup({}, []);
  try {
    const response = await service.register({ action: 'validate', name: 'x', identity: ghostIdentity(sessionId) }, { transport: 'actions' });
    assert.equal(response.ok, false);
    assert.equal(typeof response.error.code, 'string');
  } catch (e) {
    assert.fail(`register() must not throw on ghost session; threw: ${e?.message ?? e}`);
  } finally {
    cleanup(root);
  }
});

test('S15: callSubagent() non-existent session returns structured ToolResponse (no throw)', async () => {
  const okTool = tool('seam_cs2', async () => ({ v: 2 }));
  const { root, service, sessionId } = setup({}, [okTool]);
  try {
    const response = await service.callSubagent({ tool: 'seam_cs2', input: {}, identity: ghostIdentity(sessionId) }, { transport: 'subagent' });
    assert.equal(response.ok, false);
    assert.equal(typeof response.error.code, 'string');
  } catch (e) {
    assert.fail(`callSubagent() must not throw on ghost session; threw: ${e?.message ?? e}`);
  } finally {
    cleanup(root);
  }
});

test('S16: callSubagent() bad identity writes NO audit event (auditStarted=false)', async () => {
  const okTool = tool('seam_cs3', async () => ({ v: 3 }));
  const { root, service, auditEvents, identity } = setup({}, [okTool]);
  try {
    const response = await service.callSubagent({ tool: 'seam_cs3', input: {}, identity: badTokenIdentity(identity) }, { transport: 'subagent' });
    assert.equal(response.ok, false);
    // main 基线：authenticate 抛错时 auditStarted=false → 不应落任何审计事件。
    assert.equal(auditEvents.length, 0, 'callSubagent bad identity must not write audit events');
  } catch (e) {
    assert.fail(`callSubagent() must not throw on bad identity; threw: ${e?.message ?? e}`);
  } finally {
    cleanup(root);
  }
});
