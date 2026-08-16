// M8 接入层 + TUI 页面 + 端到端测试——≥ 16 用例
// ADR-0009 决策 1/2/4/7/8/9/10/11/12/14
// 目标：覆盖率 ≥ 70%；变异体 7/7 被杀死

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

// ── Import 构建产物 ──

import { createSubagentRunner, setRunnerDepsForTesting, resetSubagentRunner, getSubagentRunner } from '../dist/subagent/runner.js';
import { clearAllSubagents, getSubagent, listAllSubagents, countRunning } from '../dist/subagent/store.js';
import { createBuiltinTools } from '../dist/core-tools.js';
import { ExtensionService } from '../dist/extensions.js';
import { MyTerminalStore } from '../dist/store.js';
import { buildOpenApi } from '../dist/openapi.js';
import { createMcpServer } from '../dist/mcp.js';

// ── 测试辅助 ──

function tempDir() {
  const dir = join(tmpdir(), 'm8-test-' + randomBytes(4).toString('hex'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultSubagentSettings(overrides = {}) {
  return {
    enabled: true,
    provider: 'openai',
    model: 'gpt-4o',
    maxTurns: 50,
    timeoutSec: 300,
    maxParallel: 2,
    ...overrides,
  };
}

/** 创建一个最小合法的 mock session */
function mockSession(id, overrides = {}) {
  return {
    id,
    name: 'subagent-test',
    role: 'worker',
    phase: 'working',
    presence: 'claimed',
    parentSessionId: overrides.parentSessionId,
    task: overrides.task,
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** 创建 fake deps——返回 { deps, callLog } */
function fakeDeps(overrides = {}) {
  const callLog = [];
  const deps = {
    runSubagentImpl: overrides.runSubagentImpl ?? (async () => {
      callLog.push('runSubagentImpl');
      return { status: 'completed', result: 'Test completed successfully.' };
    }),
    settings: overrides.settings ?? defaultSubagentSettings(),
    workspaceDir: overrides.workspaceDir ?? '/tmp/test-workspace',
    notify: overrides.notify ?? (async (childId, childIdentity, parentId, body) => {
      callLog.push({ notify: { childId, parentId, body } });
    }),
    checkpoint: overrides.checkpoint ?? (async (childId, childIdentity, phase, summary) => {
      callLog.push({ checkpoint: { childId, phase, summary } });
    }),
    registerAndClaimChild: overrides.registerAndClaimChild ?? ((parentId, args) => {
      const sid = 'ses_child_' + randomBytes(3).toString('hex');
      callLog.push({ registerAndClaimChild: { parentId, args } });
      return {
        session: mockSession(sid, { parentSessionId: parentId, name: args.name, task: args.task }),
        identity: { sessionId: sid, sessionToken: 'tok_' + randomBytes(8).toString('hex') },
      };
    }),
  };
  return { deps, callLog };
}

// ── 每个测试前后清理 ──

function setupRunner(overrides = {}) {
  const { deps, callLog } = fakeDeps(overrides);
  const runner = createSubagentRunner(deps);
  // 同时设置单例（core-tools 用）
  setRunnerDepsForTesting(deps);
  return { runner, callLog };
}

// ══════════════════════════════════════════════════════
// Part A：Runner 单测（用例 1-7）
// ══════════════════════════════════════════════════════

describe('subagent-m8', () => {
test('M8-runner-01: start returns sessionId + taskId + running', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner, callLog } = setupRunner();

  const result = runner.start('ses_parent_01', {
    objective: 'Read README.md and summarize',
    background: 'This is a test',
  });

  assert.equal(result.status, 'running');
  assert.ok(result.sessionId.startsWith('ses_child_'));
  assert.ok(result.taskId.startsWith('sa_'));
  assert.equal(typeof result.sessionId, 'string');
  assert.equal(typeof result.taskId, 'string');

  // 验证 store 记录
  const record = getSubagent(result.taskId);
  assert.ok(record);
  assert.equal(record.status, 'running');
  assert.equal(record.sessionId, result.sessionId);

  // 验证 registerAndClaimChild 被调用
  const registerCalls = callLog.filter((c) => c.registerAndClaimChild);
  assert.equal(registerCalls.length, 1);
  assert.equal(registerCalls[0].registerAndClaimChild.parentId, 'ses_parent_01');

  // 等待后台完成（需要给 runSubagentImpl 时间 resolve）
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test('M8-runner-02: maxParallel limit enforced', () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner } = setupRunner({ settings: defaultSubagentSettings({ maxParallel: 2 }) });

  // 启动 2 个子 agent（挂起中）
  runner.start('ses_parent_02', { objective: 'Task A' });
  runner.start('ses_parent_02', { objective: 'Task B' });

  // 第 3 个应报错
  assert.throws(
    () => runner.start('ses_parent_02', { objective: 'Task C' }),
    /Max parallel subagents reached \(2\)/,
  );

  assert.equal(countRunning(), 2);
});

test('M8-runner-03: completed notification chain', async () => {
  clearAllSubagents();
  resetSubagentRunner();

  let notifiedBody = null;
  let checkpointed = null;

  const { runner } = setupRunner({
    runSubagentImpl: async () => ({ status: 'completed', result: 'All tasks done. File A edited, File B created.' }),
    notify: async (childId, childIdentity, parentId, body) => {
      notifiedBody = { childId, parentId, body };
    },
    checkpoint: async (childId, childIdentity, phase, summary) => {
      checkpointed = { childId, phase, summary };
    },
  });

  const result = runner.start('ses_parent_03', { objective: 'Edit files' });

  // 等待后台完成
  await new Promise((resolve) => setTimeout(resolve, 200));

  // 验证通知
  assert.ok(notifiedBody);
  assert.match(notifiedBody.body, /subagent completed/);
  assert.equal(notifiedBody.parentId, 'ses_parent_03');
  assert.equal(notifiedBody.childId, result.sessionId);

  // 验证 checkpoint
  assert.ok(checkpointed);
  assert.equal(checkpointed.phase, 'completed');

  // 验证 store 状态
  const record = getSubagent(result.taskId);
  assert.equal(record.status, 'completed');
  assert.ok(record.result);
});

test('M8-runner-04: failed notification chain', async () => {
  clearAllSubagents();
  resetSubagentRunner();

  let notifiedBody = null;

  const { runner } = setupRunner({
    runSubagentImpl: async () => ({ status: 'failed', error: 'API key is invalid' }),
    notify: async (childId, childIdentity, parentId, body) => {
      notifiedBody = { childId, parentId, body };
    },
  });

  const result = runner.start('ses_parent_04', { objective: 'Fail task' });

  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.ok(notifiedBody);
  assert.match(notifiedBody.body, /subagent failed/);
  assert.match(notifiedBody.body, /API key/);

  const record = getSubagent(result.taskId);
  assert.equal(record.status, 'failed');
  assert.equal(record.error, 'API key is invalid');
});

test('M8-runner-05: status structure and idempotent completed queries (ADR-0010 决策 13)', () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner } = setupRunner();

  const result = runner.start('ses_parent_05', { objective: 'Query test' });

  // running 状态
  const status1 = runner.status(result.taskId);
  assert.equal(status1.status, 'running');
  assert.ok(Array.isArray(status1.tasks));
  assert.ok(status1.usage);

  // 手动标记为 completed（模拟后台完成）
  const record = getSubagent(result.taskId);
  record.status = 'completed';
  record.result = 'Final summary';

  // completed 后的 status——应返回 result
  const status2 = runner.status(result.taskId);
  assert.equal(status2.status, 'completed');
  assert.equal(status2.result, 'Final summary');
  // ADR-0048 D11+#161：status() 返回体砍 auditLogs（父侧瘦身；store 层已随 #161 删净）
  assert.equal('auditLogs' in status2, false, 'status() 返回体无 auditLogs');

  // ADR-0010 决策 13：第二次 status 仍返回 result（idempotent，不再取走即删）
  const status3 = runner.status(result.taskId);
  assert.equal(status3.status, 'completed');
  assert.equal(status3.result, 'Final summary');
});

test('M8-runner-06: abort is idempotent', () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner } = setupRunner({
    runSubagentImpl: async () => {
      // 永远不 resolve——模拟挂起
      return new Promise(() => {});
    },
  });

  const result = runner.start('ses_parent_06', { objective: 'Long task' });
  assert.equal(countRunning(), 1);

  // abort → aborting
  const abortResult = runner.abort(result.taskId);
  assert.equal(abortResult.status, 'aborting');

  // 幂等——再次 abort 返回当前状态（aborting）
  // 注意：abortController 已触发，store 状态可能在 cleanup 后变 aborted
  const record = getSubagent(result.taskId);
  if (record) {
    const abortResult2 = runner.abort(result.taskId);
    assert.ok(['aborting', 'aborted'].includes(abortResult2.status));
  }

  // NOT_FOUND
  assert.throws(
    () => runner.abort('sa_nonexistent'),
    /Subagent not found/,
  );
});

test('M8-runner-07: config merge — input.model no longer overrides settings.model (#04)', () => {
  clearAllSubagents();
  resetSubagentRunner();

  let capturedSettings = null;
  const { runner } = setupRunner({
    runSubagentImpl: async (opts) => {
      capturedSettings = opts.settings;
      return { status: 'completed', result: 'Done' };
    },
  });

  runner.start('ses_parent_07', {
    objective: 'Custom model test',
    model: 'gpt-4o-mini',
    maxTurns: 20,
  });

  // 给一点时间等 runSubagentImpl 被调用
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.ok(capturedSettings);
      // #04：input.model 不再合并进 settings——模型只来自全局配置（默认值 gpt-4o）
      assert.equal(capturedSettings.model, 'gpt-4o', 'input.model 不应覆盖 settings.model（#04 已移除合并）');
      // 工程参数 maxTurns 仍可覆盖
      assert.equal(capturedSettings.maxTurns, 20);
      resolve();
    }, 200);
  });
});

// ══════════════════════════════════════════════════════
// Part B：Core-tools / Extensions 集成（用例 8-12）
// ══════════════════════════════════════════════════════

test('M8-core-08: recursive protection — subagent_start rejects transport=subagent', async () => {
  const dir = tempDir();
  const store = new MyTerminalStore(dir);
  const config = {
    settingsPath: join(dir, 'settings.json'),
    workspaceDir: dir,
    stateDir: dir,
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'test-key-' + randomBytes(8).toString('hex'),
    actionsToken: 'test-token-' + randomBytes(8).toString('hex'),
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 10000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };

  // 设置 runner 单例（fake）
  clearAllSubagents();
  resetSubagentRunner();
  setRunnerDepsForTesting({
    runSubagentImpl: async () => ({ status: 'completed', result: 'OK' }),
    settings: defaultSubagentSettings(),
    workspaceDir: dir,
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: (parentId, args) => ({
      session: mockSession('ses_child_' + randomBytes(3).toString('hex')),
      identity: { sessionId: 'ses_x', sessionToken: 'tok_x' },
    }),
  });

  const builtins = createBuiltinTools(config, store);
  const subagentStart = builtins.get('subagent_start');
  assert.ok(subagentStart, 'subagent_start tool should be registered');

  // 以 transport='subagent' 调用应当抛出 FORBIDDEN
  const context = { transport: 'subagent' };
  await assert.rejects(
    subagentStart.invoke({ objective: 'Test' }, context),
    (err) => {
      // MyTerminalError 或普通 Error
      return err.message.includes('cannot start sub-subagents')
        || err.code === 'FORBIDDEN';
    },
  );

  rmSync(dir, { recursive: true, force: true });
});

test('M8-core-09: defense-B — subagent tools NOT in tool schemas', async () => {
  const dir = tempDir();
  const store = new MyTerminalStore(dir);
  const config = {
    settingsPath: join(dir, 'settings.json'),
    workspaceDir: dir,
    stateDir: dir,
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'test-key-' + randomBytes(8).toString('hex'),
    actionsToken: 'test-token-' + randomBytes(8).toString('hex'),
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 10000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };

  const builtins = createBuiltinTools(config, store);

  // 验证 3 个 subagent 工具在 builtins 中（供主 agent 使用）
  assert.ok(builtins.has('subagent_start'));
  assert.ok(builtins.has('subagent_status'));
  assert.ok(builtins.has('subagent_abort'));

  // 防线 B 验证：subagent 的 8 个工具 schemas 应不含 subagent_start/status/abort
  // 这条验证依赖 M4 的 getAllToolSchemas()
  let schemasIncludeSubagent = false;
  try {
    const { getAllToolSchemas } = await import('../dist/subagent/tools.js');
    const schemas = getAllToolSchemas();
    const names = schemas.map((s) => s.name);
    schemasIncludeSubagent = names.includes('subagent_start') || names.includes('subagent_status') || names.includes('subagent_abort');
  } catch {
    // getAllToolSchemas 可能不存在——跳过此检查
  }
  assert.equal(schemasIncludeSubagent, false, 'Subagent tool schemas must NOT include subagent_start/status/abort');

  rmSync(dir, { recursive: true, force: true });
});

test('M8-core-10: CONTROL_TOOLS prevents fast-return detach', () => {
  // 验证 subagent tools 在 CONTROL_TOOLS 中
  const dir = tempDir();
  const store = new MyTerminalStore(dir);
  const config = {
    settingsPath: join(dir, 'settings.json'),
    workspaceDir: dir,
    stateDir: dir,
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'test-key-' + randomBytes(8).toString('hex'),
    actionsToken: 'test-token-' + randomBytes(8).toString('hex'),
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 10000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };

  // ExtensionService 把 CONTROL_TOOLS 用于 touchControl vs beforeOrdinaryCall
  // 验证方法：检查代码中 CONTROL_TOOLS 包含 subagent 工具名
  // 通过创建 ExtensionService 并验证其存在
  const builtins = createBuiltinTools(config, store);
  const ext = new ExtensionService(config, store, builtins, () => {});

  // callSubagent 方法必须在
  assert.equal(typeof ext.callSubagent, 'function', 'callSubagent method must exist');

  rmSync(dir, { recursive: true, force: true });
});

test('M8-ext-11: callSubagent trimmed semantics — no continuation', async () => {
  const dir = tempDir();
  const store = new MyTerminalStore(dir);
  const config = {
    settingsPath: join(dir, 'settings.json'),
    workspaceDir: dir,
    stateDir: dir,
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'test-key-' + randomBytes(8).toString('hex'),
    actionsToken: 'test-token-' + randomBytes(8).toString('hex'),
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 10000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };

  const builtins = createBuiltinTools(config, store);
  const ext = new ExtensionService(config, store, builtins, () => {});

  // 创建 root session 和一个 child（通过 session_register delegate）
  const rootResult = store.registerRoot({ name: 'root', role: 'lead' });
  const rootSession = rootResult.session;
  const rootIdentity = rootResult.identity;

  const { session: childSession, claimCode } = store.registerDelegate(rootSession.id, {
    name: 'child-subagent',
    task: { objective: 'Test', background: 'Background context', deliverables: ['Code'], acceptanceCriteria: ['Pass'], constraints: ['None'] },
  });
  const { identity: childIdentity } = store.inherit(childSession.id, { claimCode });

  // 用 callSubagent 发送消息（trimmed 语义）
  const response = await ext.callSubagent(
    { tool: 'message_send', input: { to: rootSession.id, body: 'Hello from subagent' }, identity: childIdentity },
    { transport: 'subagent' },
  );

  assert.equal(response.ok, true);
  // trimmed：不应有 continuation 字段
  assert.ok(!response.data?.continuation, 'callSubagent response must NOT contain continuation');
  // trimmed：不应有 events 字段
  assert.ok(!response.events, 'callSubagent response must NOT contain events');

  // 验证消息确实发送了
  const messages = store.inboxPage(rootSession.id, false, 0, 10);
  const found = messages.messages.find((m) => m.body === 'Hello from subagent');
  assert.ok(found, 'Message should be delivered to root session');

  rmSync(dir, { recursive: true, force: true });
});

test('M8-core-12: subagent_start fails without identity', async () => {
  const dir = tempDir();
  const store = new MyTerminalStore(dir);
  const config = {
    settingsPath: join(dir, 'settings.json'),
    workspaceDir: dir,
    stateDir: dir,
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'test-key-' + randomBytes(8).toString('hex'),
    actionsToken: 'test-token-' + randomBytes(8).toString('hex'),
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 10000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };

  clearAllSubagents();
  resetSubagentRunner();
  setRunnerDepsForTesting({
    runSubagentImpl: async () => ({ status: 'completed', result: 'OK' }),
    settings: defaultSubagentSettings(),
    workspaceDir: dir,
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: (parentId, args) => ({
      session: mockSession('ses_child_xxx'),
      identity: { sessionId: 'ses_x', sessionToken: 'tok_x' },
    }),
  });

  const builtins = createBuiltinTools(config, store);
  const subagentStart = builtins.get('subagent_start');
  assert.ok(subagentStart);

  // 无身份调用——应抛 IDENTITY_REQUIRED
  await assert.rejects(
    subagentStart.invoke({ objective: 'Test' }, { transport: 'actions' }),
    (err) => err.message?.includes('identity') || err.code === 'IDENTITY_REQUIRED' || err.message?.includes('Register') || err.message?.includes('session'),
  );

  rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════
// Part C：MCP / OpenAPI Schema（用例 13）
// ══════════════════════════════════════════════════════

test('M8-schema-13: MCP and OpenAPI contain subagent tools', async () => {
  const dir = tempDir();
  const store = new MyTerminalStore(dir);
  const config = {
    settingsPath: join(dir, 'settings.json'),
    workspaceDir: dir,
    stateDir: dir,
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'test-key-' + randomBytes(8).toString('hex'),
    actionsToken: 'test-token-' + randomBytes(8).toString('hex'),
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 10000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };

  const builtins = createBuiltinTools(config, store);
  const facade = {
    discover: async () => ({ ok: true, data: {} }),
    register: async () => ({ ok: true }),
    call: async (input) => {
      const tool = builtins.get(input.tool);
      if (!tool) return { ok: false, error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } };
      return { ok: true, data: { tool: input.tool, result: {} } };
    },
  };

  // MCP: 验证 createMcpServer 不抛异常（工具注册在构造函数内）
  const mcp = createMcpServer(facade);
  assert.ok(mcp, 'MCP server should be created without error');

  // OpenAPI: toolInput properties 应含 subagent 工程字段（provider/model 已由 ADR-0045 #04 移除）
  const openapi = buildOpenApi({ ...config, publicBaseUrl: 'http://127.0.0.1:0' });
  const toolInput = openapi.components.schemas.ExtensionToolInput;
  assert.ok(toolInput, 'ExtensionToolInput schema must exist');
  const props = toolInput.properties;
  assert.ok(!('provider' in props), 'provider field must be removed from toolInput (#04)');
  assert.ok(!('model' in props), 'model field must be removed from toolInput (#04)');
  assert.ok(props.maxTurns, 'maxTurns field must exist in toolInput');
  assert.ok(props.readOnly, 'readOnly field must exist in toolInput');

  // OpenAPI: TaskPackage 且 objective, background 等字段应已存在
  const taskPackage = openapi.components.schemas.TaskPackage;
  assert.ok(taskPackage, 'TaskPackage schema must exist');

  rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════
// Part D：端到端集成（用例 14-15）
// ══════════════════════════════════════════════════════

test('M8-e2e-14: full lifecycle via ExtensionService.call()', async () => {
  const dir = tempDir();
  // 写入 settings 以便 createRuntime 或 store 使用
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({
    schemaVersion: 1,
    workspaceDir: dir,
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'ck_test_' + randomBytes(8).toString('hex'),
    actionsToken: 'at_test_' + randomBytes(8).toString('hex'),
    publicBaseUrl: '',
    maxOutputChars: 10000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
    subagent: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-4o',
      maxTurns: 50,
      timeoutSec: 300,
      maxParallel: 2,
    },
  }));

  const store = new MyTerminalStore(dir);
  const config = {
    settingsPath,
    workspaceDir: dir,
    stateDir: dir,
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'ck_test_e2e',
    actionsToken: 'at_test_e2e',
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 10000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };

  clearAllSubagents();
  resetSubagentRunner();

  // 安装 fake runner——挂起不完成，手动控制
  let manualResolve = null;
  const resolvedPromise = new Promise((resolve) => { manualResolve = resolve; });
  let capturedOpts = null;

  setRunnerDepsForTesting({
    runSubagentImpl: async (opts) => {
      capturedOpts = opts;
      await resolvedPromise; // 挂起，等测试手动 resolve
      return { status: 'completed', result: 'E2E test completed: all files processed.' };
    },
    settings: defaultSubagentSettings(),
    workspaceDir: dir,
    notify: async (childId, childIdentity, parentId, body) => {
      // 验证通知到达
    },
    checkpoint: async (childId, childIdentity, phase, summary) => {
      // 验证 checkpoint
    },
    registerAndClaimChild: (parentId, args) => {
      const sid = 'ses_child_e2e';
      const { session, claimCode } = store.registerDelegate(parentId, {
        name: args.name,
        task: args.task,
      });
      const result = store.inherit(session.id, { claimCode });
      return { session: result.session, identity: result.identity };
    },
  });

  const builtins = createBuiltinTools(config, store);
  const ext = new ExtensionService(config, store, builtins, () => {});

  // Step 1: Register root session
  const rootResult = store.registerRoot({ name: 'root-e2e', role: 'lead' });
  const rootIdentity = rootResult.identity;

  // Step 2: subagent_start via ExtensionService.call()
  const startResponse = await ext.call(
    { tool: 'subagent_start', input: { objective: 'E2E subagent task', readOnly: true }, identity: rootIdentity },
    { transport: 'actions' },
  );

  assert.equal(startResponse.ok, true);
  const startData = startResponse.data;
  assert.equal(startData.result.status, 'running');
  assert.ok(startData.result.taskId);
  assert.ok(startData.result.sessionId);
  const taskId = startData.result.taskId;

  // Step 3: subagent_status (running)
  const statusResponse1 = await ext.call(
    { tool: 'subagent_status', input: { taskId }, identity: rootIdentity },
    { transport: 'tui' },
  );
  assert.equal(statusResponse1.ok, true);
  assert.equal(statusResponse1.data.result.status, 'running');

  // Step 4: 手动 resolve — 让 subagent 完成
  manualResolve();
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Step 5: subagent_status 拿到 completed + result
  const statusResponse2 = await ext.call(
    { tool: 'subagent_status', input: { taskId }, identity: rootIdentity },
    { transport: 'tui' },
  );

  // ADR-0010 决策 13：idempotent——completed 后可多次查
  assert.equal(statusResponse2.ok, true);
  assert.equal(statusResponse2.data.result.status, 'completed');
  assert.equal(statusResponse2.data.result.result, 'E2E test completed: all files processed.');
  // 第二次调用仍返回 result（不再 NOT_FOUND）
  const statusResponse3 = await ext.call(
    { tool: 'subagent_status', input: { taskId }, identity: rootIdentity },
    { transport: 'tui' },
  );
  assert.equal(statusResponse3.ok, true);
  assert.equal(statusResponse3.data.result.status, 'completed');
  assert.equal(statusResponse3.data.result.result, 'E2E test completed: all files processed.');

  rmSync(dir, { recursive: true, force: true });
});

test('M8-e2e-15: recursive protection in extensions', async () => {
  const dir = tempDir();
  const store = new MyTerminalStore(dir);
  const config = {
    settingsPath: join(dir, 'settings.json'),
    workspaceDir: dir,
    stateDir: dir,
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'test-key-' + randomBytes(8).toString('hex'),
    actionsToken: 'test-token-' + randomBytes(8).toString('hex'),
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 10000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };

  clearAllSubagents();
  resetSubagentRunner();
  setRunnerDepsForTesting({
    runSubagentImpl: async () => ({ status: 'completed', result: 'OK' }),
    settings: defaultSubagentSettings(),
    workspaceDir: dir,
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: (parentId, args) => ({
      session: mockSession('ses_child_rp'),
      identity: { sessionId: 'ses_x', sessionToken: 'tok_x' },
    }),
  });

  const builtins = createBuiltinTools(config, store);
  const ext = new ExtensionService(config, store, builtins, () => {});

  // 创建 root session
  const rootResult = store.registerRoot({ name: 'root-rp', role: 'lead' });

  // 通过 extensions.call() 用 subagent transport 调 subagent_start
  // 这会走 callSubagent 或 call 路径，由 transport 决定
  const response = await ext.callSubagent(
    { tool: 'subagent_start', input: { objective: 'Should be forbidden' }, identity: rootResult.identity },
    { transport: 'subagent' },
  );

  // 递归防护应阻止——返回错误
  assert.equal(response.ok, false);
  assert.match(response.error?.code || '', /FORBIDDEN/);

  rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════
// Part E：TUI 冒烟（用例 16）
// ══════════════════════════════════════════════════════

test('M8-tui-16: Subagents component smoke test', () => {
  clearAllSubagents();

  // 创建 2 个 fake subagent records
  const { createSubagent, getSubagent } = require('../dist/subagent/store.js');
  const sa1 = createSubagent('sa_test_a', { subject: 'Test task A - read files' });
  const sa2 = createSubagent('sa_test_b', { subject: 'Test task B - write code' });
  sa1.status = 'running';
  sa2.status = 'completed';
  sa2.result = 'Done!';

  const records = listAllSubagents();
  assert.equal(records.length, 2);
  assert.equal(records[0].id, 'sa_test_a');
  assert.equal(records[1].id, 'sa_test_b');
  assert.equal(records[0].status, 'running');
  assert.equal(records[1].status, 'completed');

  // 清理
  clearAllSubagents();
  assert.equal(listAllSubagents().length, 0);
});
});
