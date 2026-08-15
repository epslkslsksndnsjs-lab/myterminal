// Issue #136（ADR-0048 T5 = D5 第四轮微改造）— 完成信号两处微改造
// 1. subagent_status 文本块动态句（mcp.ts summary 函数化，0044 N3 方案）：
//    completed→"子已完成，请验收"、running→"运行中"；其余工具文本块逐字不变
// 2. 完成闸门（store.ts 收工路径，扩展 CHILD_REVIEW_REQUIRED 同机制）：
//    存在未验收子结果 → 抛闸门错误"先查子结果再收工"（taskId 进 details）
// 切片 1：MCP 文本块动态句（本文件上半）；切片 2：runner.status 已验收置位；切片 3：store 闸门两态

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { setRunnerDepsForTesting, resetSubagentRunner, getSubagentRunner } from '../dist/subagent/runner.js';
import { clearAllSubagents, createSubagent, getSubagent, markResultFetched } from '../dist/subagent/store.js';
import { createBuiltinTools } from '../dist/core-tools.js';
import { ExtensionService } from '../dist/extensions.js';
import { MyTerminalStore } from '../dist/store.js';
import { createMcpServer } from '../dist/mcp.js';

// ── 测试辅助 ──

function tempDir() {
  const dir = join(tmpdir(), 'issue-136-' + randomBytes(4).toString('hex'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(dir) {
  return {
    settingsPath: join(dir, 'config', 'settings.json'),
    workspaceDir: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'ck_136_' + randomBytes(4).toString('hex'),
    actionsToken: 'at_136_' + randomBytes(4).toString('hex'),
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 10000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };
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

/** 最小合法 TaskPackage（cleanTask 五项全必填非空） */
function makeTask(objective) {
  return { objective, background: 'slice background', deliverables: ['slice done'], acceptanceCriteria: ['verified'], constraints: ['local only'] };
}

/** 装 fake runner deps——本测试手动建 record，runSubagentImpl 不会真正执行 */
function installFakeRunner(dir) {
  clearAllSubagents();
  resetSubagentRunner();
  setRunnerDepsForTesting({
    runSubagentImpl: async () => ({ status: 'completed', result: 'unused' }),
    settings: defaultSubagentSettings(),
    workspaceDir: dir,
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: () => {
      throw new Error('registerAndClaimChild 不应在切片 1 被调用');
    },
  });
}

function setupExt(dir) {
  const store = new MyTerminalStore(join(dir, 'state'));
  const config = makeConfig(dir);
  const builtins = createBuiltinTools(config, store);
  const ext = new ExtensionService(config, store, builtins, () => {});
  const rootResult = store.registerRoot({ name: 'root', role: 'lead' });
  return { store, config, ext, rootIdentity: rootResult.identity };
}

async function mcpClientFor(ext) {
  const server = createMcpServer(ext);
  const client = new Client({ name: 'issue-136-client', version: '1.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return client;
}

// ══════════════════════════════════════════════════════
// 切片 1：subagent_status 文本块动态句（mcp.ts summary 函数化）
// ══════════════════════════════════════════════════════

test('136-s1: MCP subagent_status running → 文本块"运行中"', async () => {
  const dir = tempDir();
  const { ext, rootIdentity } = setupExt(dir);
  installFakeRunner(dir);
  createSubagent('task-run', { subject: 'running task' }); // 默认 status=running

  const client = await mcpClientFor(ext);
  const res = await client.callTool({ name: 'subagent_status', arguments: { taskId: 'task-run', identity: rootIdentity } });
  assert.equal(res.isError, false, JSON.stringify(res));
  assert.equal(res.content[0].type, 'text');
  assert.equal(res.content[0].text, '运行中');

  rmSync(dir, { recursive: true, force: true });
});

test('136-s2: MCP subagent_status completed → 文本块"子已完成，请验收"', async () => {
  const dir = tempDir();
  const { ext, rootIdentity } = setupExt(dir);
  installFakeRunner(dir);
  const rec = createSubagent('task-done', { subject: 'completed task' });
  rec.status = 'completed';
  rec.result = 'slice done.';
  rec.completedAt = Date.now();

  const client = await mcpClientFor(ext);
  const res = await client.callTool({ name: 'subagent_status', arguments: { taskId: 'task-done', identity: rootIdentity } });
  assert.equal(res.isError, false, JSON.stringify(res));
  assert.equal(res.content[0].text, '子已完成，请验收');

  rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════
// 切片 2：runner.status 终态取结果置「已验收」标记（resultFetched）
// ══════════════════════════════════════════════════════

test('136-s4: 父首次取终态 result 置已验收标记，重复查幂等保留', () => {
  const dir = tempDir();
  installFakeRunner(dir);
  const rec = createSubagent('task-f', { subject: 'finished task' });
  assert.equal(getSubagent('task-f').resultFetched, undefined); // 运行中未置位

  // 子进终态（finalize 写入 result）
  rec.status = 'completed';
  rec.result = 'slice done.';
  rec.completedAt = Date.now();

  const runner = getSubagentRunner();
  const s1 = runner.status('task-f');
  assert.equal(s1.status, 'completed');
  assert.equal(s1.result, 'slice done.');
  assert.equal(getSubagent('task-f').resultFetched, true, '父首次取终态 result 置位');

  // 幂等保留：重复查询仍返回 result，标记保持（ADR-0007 决策 13/7）
  const s2 = runner.status('task-f');
  assert.equal(s2.result, 'slice done.');
  assert.equal(getSubagent('task-f').resultFetched, true);

  rmSync(dir, { recursive: true, force: true });
});

test('136-s5: running 态取 status 不置位；failed 终态取 status 置位（看过 error 即验收）', () => {
  const dir = tempDir();
  installFakeRunner(dir);
  const rec = createSubagent('task-r', { subject: 'still running' });
  const runner = getSubagentRunner();

  // running：未终态，不置位
  runner.status('task-r');
  assert.equal(getSubagent('task-r').resultFetched, undefined);

  // failed 终态：父调过 status（看到 error）即验收
  rec.status = 'failed';
  rec.error = 'boom';
  rec.completedAt = Date.now();
  const s1 = runner.status('task-r');
  assert.equal(s1.status, 'failed');
  assert.equal(s1.error, 'boom');
  assert.equal(getSubagent('task-r').resultFetched, true);

  rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════
// 切片 3：store 收工完成闸门（CHILD_RESULT_UNREVIEWED）
// ══════════════════════════════════════════════════════

test('136-s6: 未验收子结果存在时收工被拦，取过后放行（AC2+AC3）', () => {
  const dir = tempDir();
  const store = new MyTerminalStore(join(dir, 'state'));
  const root = store.registerRoot({ name: 'root', role: 'lead' });
  const childInfo = store.registerDelegate(root.session.id, { name: 'worker', task: makeTask('delegated slice') });
  const childId = childInfo.session.id;

  // 子会话先收工（终态）；child 完成事件发给 root，须 ack 才能过旧闸门
  store.checkpoint(childId, { phase: 'completed', summary: 'child done.' });
  const childEvents = store.snapshot().events.filter((e) => e.recipientSessionId === root.session.id && e.sourceSessionId === childId);
  if (childEvents.length) store.acknowledgeEvents(root.session.id, childEvents.map((e) => e.id));
  // subagent record 进终态但父从未调 status → 未验收
  clearAllSubagents();
  const rec = createSubagent('task-gate', { subject: 'delegated work' });
  rec.status = 'completed';
  rec.result = 'child result payload';
  rec.completedAt = Date.now();
  rec.sessionId = childId;

  // 收工 → 拦
  assert.throws(
    () => store.checkpoint(root.session.id, { phase: 'completed', summary: 'wrap up' }),
    (err) => {
      assert.equal(err.code, 'CHILD_RESULT_UNREVIEWED');
      assert.equal(err.message, '先查子结果再收工');
      assert.equal(err.details.taskId, 'task-gate');
      assert.equal(err.details.childSessionId, childId);
      return true;
    },
  );

  // 父取过终态 result（置位）→ 闸门放行
  markResultFetched('task-gate');
  const done = store.checkpoint(root.session.id, { phase: 'completed', summary: 'wrap up' });
  assert.equal(done.phase, 'completed');

  rmSync(dir, { recursive: true, force: true });
});

test('136-s7: 子 subagent 未终态（running）不触发新闸门，回落旧 CHILD_REVIEW_REQUIRED', () => {
  const dir = tempDir();
  const store = new MyTerminalStore(join(dir, 'state'));
  const root = store.registerRoot({ name: 'root', role: 'lead' });
  const childInfo = store.registerDelegate(root.session.id, { name: 'worker', task: makeTask('still running slice') });

  clearAllSubagents();
  const rec = createSubagent('task-run2', { subject: 'still running' }); // status=running
  rec.sessionId = childInfo.session.id;

  // running（非终态）→ 不满足新闸门 → 旧闸门（子会话未终态）
  assert.throws(
    () => store.checkpoint(root.session.id, { phase: 'completed', summary: 'wrap up' }),
    (err) => {
      assert.equal(err.code, 'CHILD_REVIEW_REQUIRED');
      return true;
    },
  );

  rmSync(dir, { recursive: true, force: true });
});

test('136-s3: MCP 其余工具文本块逐字不变锚点', async () => {
  const dir = tempDir();
  const { ext, rootIdentity } = setupExt(dir);
  installFakeRunner(dir);

  const client = await mcpClientFor(ext);
  // 无必填参数的代表工具：readOnly 与 safeLocalMutation 各取若干
  const anchors = [
    ['session_list', 'List local sessions'],
    ['workspace_info', 'Inspect local workspace'],
    ['session_context', 'Read local session context'],
    ['message_list', 'List local session messages'],
  ];
  for (const [name, title] of anchors) {
    const res = await client.callTool({ name, arguments: { identity: rootIdentity } });
    assert.equal(res.isError, false, `${name}: ${JSON.stringify(res)}`);
    assert.equal(res.content[0].text, `${title} completed.`, `文本块逐字不变: ${name}`);
  }

  rmSync(dir, { recursive: true, force: true });
});
