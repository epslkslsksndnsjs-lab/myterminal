// ADR-0047 T02 (#30)：上游 bug — error.details string 归一化
//
// 修复 extensions.ts decorateContinuation 的 `{ ...(response.error.details ?? {}) }` 炸键
// （L567 已确证 shipped bug：details 为 string 时被 {...string} 展开成字符索引键、原文丢失）。
// 归一化：string → { text }，再与 continuation 合成；object / undefined 行为不变。
//
// 验收：
//   1. string 型 details 的长任务失败响应：details 为对象、含归一化文本 + continuation 子键
//   2. object 型 details 行为不变（原样加 continuation）
//   3. e2e 覆盖失败长任务场景；既有长任务 / continuation 测试全绿
//
// 测试方式：真实服务器 e2e 为主（参照 test/issue-29-shaping-skeleton.test.mjs）；
// string 归一化逻辑抽为纯函数 normalizeErrorDetails（decorateContinuation 私有，经共享纯函数验证 bug + 修复）。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MyTerminalRuntime } from '../dist/server.js';
// 修复前该导出不存在 → 本文件整体加载失败（红灯）；实现后转绿。
import { normalizeErrorDetails, ExtensionService } from '../dist/extensions.js';
import { MyTerminalStore, MyTerminalError } from '../dist/store.js';

const CONNECTOR_KEY = 'issue30-connector-key-123456';
const ACTIONS_TOKEN = 'issue30-actions-token-1234567890123456';

// ═══════════════════════════════════════════════════════════
// 验收 1：string 型 details 归一化（bug + 修复，经共享纯函数验证）
// ═══════════════════════════════════════════════════════════

test('T02-1: string 型 details 归一化为 { text }（消除 {...string} 炸键）', () => {
  const out = normalizeErrorDetails('boom: disk full');
  assert.deepEqual(out, { text: 'boom: disk full' }, 'string 必须归一化为 { text }');
});

test('T02-2: object 型 details 行为不变（原样保留所有键，且拷贝不共享引用）', () => {
  const obj = { code: 'X', hint: 'retry' };
  const out = normalizeErrorDetails(obj);
  assert.deepEqual(out, obj, 'object 应原样保留');
  assert.notStrictEqual(out, obj, '应拷贝，不与入参共享引用');
});

test('T02-3: undefined details → {}（与修复前 `?? {}` 行为一致，回归基线）', () => {
  assert.deepEqual(normalizeErrorDetails(undefined), {});
});

test('T02-4: 修复前语义对照 — {...string} 会炸成字符索引键（本修复消除该行为）', () => {
  const broken = { ...('abc'), continuation: { status: 'working' } };
  assert.deepEqual(Object.keys(broken), ['0', '1', '2', 'continuation'], '旧逻辑把 string 炸成 0/1/2 字符索引键');
});

test('T02-5: object details 加 continuation 后仅追加 continuation 键（验收 2 的组合）', () => {
  const merged = { ...normalizeErrorDetails({ a: 1, b: 'two' }), continuation: { status: 'working' } };
  assert.deepEqual(Object.keys(merged), ['a', 'b', 'continuation'], 'object 原键保留 + continuation 追加，无字符索引键');
});

// 真实 decorateContinuation 路径（经 ExtensionService.call 公开入口）覆盖 string details 失败响应：
// 旧有 bug 代码会把 {...string} 炸成字符索引键、丢失 text；本测试在 live 路径上断言归一化为 {text}+continuation。
// 旧代码下此测试必红（details 含 '0'/'1'/... 且无 'text'），故是真实的回归闸门。
test('T02-L: 真实 decorateContinuation 路径 — string details 失败响应归一化为 {text}+continuation（live 回归闸门）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-issue30-live-'));
  const workspaceDir = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const config = {
    workspaceDir, stateDir, settingsPath: path.join(root, 'config.json'),
    host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN,
    publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10,
    uiLanguage: 'en', uiTheme: 'dark', passiveLockEnabled: false,
    actionsContinuationMode: 'adaptive', nonBlockingTasksEnabled: false,
  };
  const store = new MyTerminalStore(stateDir);
  // 抛 MyTerminalError，details 在运行时为 string（绕过 TS 类型，模拟契约违规输入）——经 call→failure→decorateContinuation live 路径
  const failingTool = {
    name: 'issue30_fake_fail', title: 'issue30_fake_fail', description: 'returns a string-details failure',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    invoke: async () => { throw new MyTerminalError('FAKE_FAIL', 'fake failure', 'boom: disk full'); },
  };
  const service = new ExtensionService(config, store, new Map([[failingTool.name, failingTool]]), () => {});
  const created = store.registerRoot({ name: 'issue30-live-root' });
  const response = await service.call({ tool: failingTool.name, input: {}, identity: created.identity }, { transport: 'actions' });
  assert.equal(response.ok, false, '工具应失败');
  assert.equal(response.error.code, 'FAKE_FAIL');
  const details = response.error.details;
  assert.ok(details && typeof details === 'object' && !Array.isArray(details), 'error.details 必须是对象（未炸成字符索引键）');
  assert.equal(details.text, 'boom: disk full', 'string details 归一化为 text 键（原文保全）');
  assert.ok('continuation' in details, 'details 含 continuation 子键（控制流保全）');
  assert.deepEqual(Object.keys(details).sort(), ['continuation', 'text'], 'details 仅含 text + continuation，无 0/1/2 字符索引键（炸键已修）');
  fs.rmSync(root, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════
// 验收 3：e2e 失败长任务回归（真实 decorateContinuation 路径）
// ═══════════════════════════════════════════════════════════

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-issue30-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'hello issue30\n');
  return { workspaceDir, stateDir };
}

async function createRuntime(overrides = {}) {
  const dirs = tempWorkspace();
  const runtime = new MyTerminalRuntime({
    ...dirs, settingsPath: path.join(dirs.stateDir, 'settings.json'), host: '127.0.0.1', port: 0,
    connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'en', uiTheme: 'dark',
    passiveLockEnabled: false, actionsContinuationMode: 'off', nonBlockingTasksEnabled: false,
    ...overrides,
  });
  await runtime.start();
  return {
    runtime, dirs, baseUrl: `http://127.0.0.1:${runtime.port}`,
    async close() { await runtime.close(); fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); },
  };
}

async function actionsCall(server, tool, input = {}, identity) {
  const response = await fetch(`${server.baseUrl}/actions/extensions/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, input, ...(identity ? { identity } : {}) }),
  });
  return { status: response.status, body: await response.json() };
}

async function registerRoot(server) {
  const reg = await actionsCall(server, 'session_register', { mode: 'root', name: 't02-session', role: 'lead' });
  assert.equal(reg.body.ok, true);
  return reg.body.data.result.identity;
}

test('T02-E: 失败长任务响应 operation.error.details 为对象含 continuation、无字符索引键（回归炸键）', async () => {
  const server = await createRuntime({ nonBlockingTasksEnabled: true, actionsContinuationMode: 'adaptive' });
  try {
    const identity = await registerRoot(server);
    // 慢命令强制 detach 成后台长任务，并以非 0 退出 → 失败长任务
    const exec = await actionsCall(server, 'execute_cli', { command: 'node -e "setTimeout(()=>process.exit(3),300)"' }, identity);
    assert.equal(exec.body.data.result.status, 'running', 'nonBlocking 慢命令应 detach 为 running');
    const taskId = exec.body.data.result.taskId;

    let poll;
    for (let i = 0; i < 120; i++) {
      poll = await actionsCall(server, 'task_poll', { taskId }, identity);
      if (poll.body.data.result.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(poll.body.data.result.status, 'failed', 'exit 3 应得到 failed 长任务');

    const operation = poll.body.data.result.operation;
    assert.ok(operation && typeof operation === 'object', 'operation 嵌套 ToolResponse 必须存在');
    assert.equal(operation.ok, false, 'operation 应为失败');

    const details = operation.error.details;
    assert.ok(details && typeof details === 'object' && !Array.isArray(details),
      'error.details 必须是对象（未炸成字符索引键）');
    assert.ok('continuation' in details, 'details 含 continuation 子键（控制流保全）');
    assert.deepEqual(Object.keys(details), ['continuation'],
      'details 仅含 continuation 键、无 0/1/2 字符索引键（炸键已修）');
    assert.ok(details.continuation && typeof details.continuation === 'object',
      'continuation 子键为对象（控制流结构完整）');

    // 回归：装饰路径不应在 data 之外污染其它字段
    assert.equal(operation.error.code, 'NON_ZERO_EXIT', '失败错误码保全');
  } finally {
    await server.close();
  }
});
