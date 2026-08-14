// ADR-0047 T01 (#29)：整形系统骨架 + 接线 — 零行为变化回归基线
//
// 验收断言：
//   1. tool-parse 模块就位：TOOL_SHAPES 空注册表 + shapeToolResponse(response, ctx) 签名
//   2. actions 路由与 MCP 出口均接线：所有工具响应经 shaper，行为与接线前逐字段一致（passthrough）
//   3. e2e：任一工具调用响应与未接线时逐字段相同（回归基线）
//   4. 审计接收器可用：无整形时记 passthrough 原因
//
// 测试方式：真实服务器 e2e 为主（spec Testing Decisions），参照 test/e2e.test.mjs。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MyTerminalRuntime } from '../dist/server.js';
import { TOOL_SHAPES, shapeToolResponse } from '../dist/tool-parse.js';

const CONNECTOR_KEY = 'issue29-connector-key-123456';
const ACTIONS_TOKEN = 'issue29-actions-token-1234567890123456';

// CommandResult 权威 10 字段（core-tools.ts runCommand 返回，ADR-0047 补遗3 evidence-locked）
const COMMAND_RESULT_KEYS = ['command', 'cwd', 'exitCode', 'signal', 'timedOut', 'stdout', 'stderr', 'truncated', 'durationMs', 'cancelled'].sort();
// T03 被动去噪后保留的 5 个真实数据字段（剥 command/cwd/signal/timedOut/cancelled）
const DENOISED_COMMAND_RESULT_KEYS = ['durationMs', 'exitCode', 'stderr', 'stdout', 'truncated'].sort();

// D17 静默契约：任何层都不插自标识标记
const MARKER_KEYS = ['_shapedBy', '_l1Applied', '_l2Applied', '_l3Applied'];

function assertNoShapingMarkers(value, at = 'root') {
  if (Array.isArray(value)) {
    for (const item of value) assertNoShapingMarkers(item, `${at}[]`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assertNoShapingMarkers(item, `${at}.${key}`);
  }
}

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-issue29-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'hello issue29\n');
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
  return {
    response,
    data: response.headers.get('content-type')?.includes('text/event-stream') ? parseEventStreamJson(text) : JSON.parse(text),
    sessionId: response.headers.get('mcp-session-id'),
  };
}

async function registerRoot(server) {
  const reg = await actionsCall(server, 'session_register', { mode: 'root', name: 't01-session', role: 'lead' });
  assert.equal(reg.body.ok, true);
  return reg.body.data.result.identity;
}

// ═══════════════════════════════════════════════════════════
// 验收 1：tool-parse 模块就位
// ═══════════════════════════════════════════════════════════

test('T01-1: TOOL_SHAPES 注册表 + shapeToolResponse(response, ctx) 签名就位', () => {
  assert.ok(TOOL_SHAPES instanceof Map, 'TOOL_SHAPES 应为 Map 注册表');
  assert.equal(TOOL_SHAPES.size, 12, 'T03 起注册表填充 6 个被动去噪工具（execute_cli/git_status/git_diff/git_log/git_show/run_checks）+ T07 新增 session_list 主动精简 + T08 新增 session_history 主动精简（嵌套 ToolResponse 摘要）+ W1-01 新增 find_files / search_text 主动精简（0050 A1）+ W1-02 新增 read_file 派生 lineCount（0050 A2）+ W1-05 新增 skill list 模式 count（0050 A5）');
  assert.equal(typeof shapeToolResponse, 'function');
  assert.equal(shapeToolResponse.length, 2, '签名应为 shapeToolResponse(response, ctx)');
});

test('T01-2: shapeToolResponse passthrough 契约（ctx 五要素 + audit 收 passthrough）', async () => {
  const response = { ok: true, data: { tool: 'workspace_info', result: { path: '/tmp' } } };
  let record;
  const shaped = await shapeToolResponse(response, {
    transport: 'actions',
    sessionId: 's-test-1',
    resolveTool: (name) => (name === 'workspace_info' ? { name, title: 't', description: 'd', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, invoke: async () => ({}) } : undefined),
    audit: (r) => { record = r; },
  });
  assert.strictEqual(shaped, response, 'passthrough 必须返回原始响应（零行为变化）');
  assert.deepEqual(record.shaping, { applied: false, reason: 'passthrough' });
  assert.strictEqual(record.rawResult, response);
  assert.strictEqual(record.shapedResult, response);
});

// ═══════════════════════════════════════════════════════════
// 验收 2+3：actions 通道接线 — 响应与未接线时逐字段一致
// ═══════════════════════════════════════════════════════════

test('T01-A: actions execute_cli 成功响应与基线逐字段一致（CommandResult 10 字段原样）', async () => {
  const server = await createRuntime();
  try {
    const identity = await registerRoot(server);
    const exec = await actionsCall(server, 'execute_cli', { command: 'echo t01a-output' }, identity);
    assert.equal(exec.status, 200);
    assert.equal(exec.body.ok, true);
    const result = exec.body.data.result;
    // T03：execute_cli 经被动去噪，剥 command/cwd/signal/timedOut/cancelled，仅留 5 真实数据字段
    assert.deepEqual(Object.keys(result).sort(), DENOISED_COMMAND_RESULT_KEYS, 'T03 后 CommandResult 仅保留 5 个真实数据字段');
    assert.equal(result.command, undefined, '噪声字段 command 已剥除');
    assert.equal(result.cwd, undefined, '噪声字段 cwd 已剥除');
    assert.equal(result.signal, undefined, '噪声字段 signal 已剥除');
    assert.equal(result.timedOut, undefined, '噪声字段 timedOut 已剥除');
    assert.equal(result.cancelled, undefined, '噪声字段 cancelled 已剥除');
    assert.ok(result.stdout.includes('t01a-output'));
    assert.equal(result.exitCode, 0);
    assert.equal(typeof result.durationMs, 'number');
    assert.equal(exec.body.data.continuation, undefined, 'off 模式无 continuation（与基线一致）');
    assertNoShapingMarkers(exec.body);
  } finally {
    await server.close();
  }
});

test('T01-B: actions execute_cli 失败响应原样（error 三要素 + result 全字段保留）', async () => {
  const server = await createRuntime();
  try {
    const identity = await registerRoot(server);
    const exec = await actionsCall(server, 'execute_cli', { command: 'echo t01b-err >&2; exit 3' }, identity);
    // 失败响应 HTTP 400 是 sendAction 的既有映射（非整形行为）
    assert.equal(exec.status, 400);
    assert.equal(exec.body.ok, false);
    assert.deepEqual(exec.body.error, {
      code: 'NON_ZERO_EXIT',
      message: 'The command exited with code 3.',
      retryable: false,
    });
    assert.deepEqual(Object.keys(exec.body.data.result).sort(), DENOISED_COMMAND_RESULT_KEYS, '失败结果同样去噪（剥 5 噪声字段）');
    assert.ok(exec.body.data.result.stderr.includes('t01b-err'));
    assert.equal(exec.body.data.result.exitCode, 3);
    // error 三要素原样（D9：只动 data.result，error 不动）
    assert.deepEqual(exec.body.error, {
      code: 'NON_ZERO_EXIT',
      message: 'The command exited with code 3.',
      retryable: false,
    });
    assertNoShapingMarkers(exec.body);
  } finally {
    await server.close();
  }
});

test('T01-C: bootstrap（无 identity）session_register 响应原样', async () => {
  const server = await createRuntime();
  try {
    const reg = await actionsCall(server, 'session_register', { mode: 'root', name: 't01-c', role: 'lead' });
    assert.equal(reg.body.ok, true);
    assert.ok(reg.body.data.result.identity.sessionId);
    assert.ok(reg.body.data.result.identity.sessionToken);
    assertNoShapingMarkers(reg.body);
  } finally {
    await server.close();
  }
});

test('T01-D: task_poll 完成态嵌套 operation（完整 ToolResponse）原样保全', async () => {
  const server = await createRuntime({ nonBlockingTasksEnabled: true });
  try {
    const identity = await registerRoot(server);
    const exec = await actionsCall(server, 'execute_cli', { command: 'sleep 0.4' }, identity);
    assert.equal(exec.body.data.result.status, 'running', 'nonBlocking 下慢命令应 detach');
    assert.ok(exec.body.data.continuation, 'detach 响应带 background_task_running continuation（基线行为）');
    const taskId = exec.body.data.result.taskId;
    let poll;
    for (let i = 0; i < 60; i++) {
      poll = await actionsCall(server, 'task_poll', { taskId }, identity);
      if (poll.body.data.result.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(poll.body.data.result.status, 'completed');
    assert.equal(poll.body.data.continuation, undefined, 'completed 无 continuation（基线行为）');
    const operation = poll.body.data.result.operation;
    assert.ok(operation && typeof operation === 'object', 'operation 嵌套必须原样存在');
    assert.equal(operation.ok, true, 'operation.ok 保全');
    assert.equal(operation.data.tool, 'execute_cli', 'operation.data.tool 保全');
    // T03：后台完成审计在存储前整形（D18.2 执行点），嵌套 CommandResult 同样被动去噪
    assert.deepEqual(Object.keys(operation.data.result).sort(), DENOISED_COMMAND_RESULT_KEYS, '嵌套 CommandResult 已去噪');
    for (const noise of ['command', 'cwd', 'signal', 'timedOut', 'cancelled']) {
      assert.equal(operation.data.result[noise], undefined, `嵌套噪声字段 ${noise} 已剥除`);
    }
    assertNoShapingMarkers(poll.body);

    // 完成态在存储前整形（D18.2 执行点）：后台完成审计记去噪原因（D7）
    const hist = await actionsCall(server, 'session_history', {}, identity);
    const completedExec = hist.body.data.result.history.entries
      .filter((entry) => entry.type === 'tool_audit' && entry.data.action === 'execute_cli' && entry.data.completedAt).at(-1);
    assert.ok(completedExec, '后台任务完成审计条目存在');
    assert.deepEqual(completedExec.data.shaping, { applied: true }, 'T03 后台完成审计记 applied:true（去噪）');
  } finally {
    await server.close();
  }
});

// ═══════════════════════════════════════════════════════════
// 验收 2+3：MCP 出口接线 — 结果字段集合与 actions 一致 + events 透传
// ═══════════════════════════════════════════════════════════

test('T01-E: MCP 通道 execute_cli 结果字段集合与 actions 一致 + events 原样透传', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'issue29', version: '1.0.0' } },
    });
    const mcpSessionId = init.sessionId;
    assert.ok(mcpSessionId);

    const reg = await rpcPost(url, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'session_register', arguments: { mode: 'root', name: 't01-mcp', role: 'lead' } },
    }, mcpSessionId);
    const identity = reg.data.result.structuredContent.data.result.identity;
    assert.ok(identity);

    const exec = await rpcPost(url, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      // execute_cli 不在 MCP direct 工具表（既有暴露面），经 extension_call facade 调用
      params: { name: 'extension_call', arguments: { tool: 'execute_cli', input: { command: 'echo t01e-mcp-output' }, identity } },
    }, mcpSessionId);
    assert.notEqual(exec.data.result.isError, true);
    const structured = exec.data.result.structuredContent;
    assert.equal(structured.ok, true);
    assert.deepEqual(Object.keys(structured.data.result).sort(), DENOISED_COMMAND_RESULT_KEYS, 'MCP 与 actions 同样经被动去噪');
    assert.ok(structured.data.result.stdout.includes('t01e-mcp-output'));
    assert.equal(structured.data.result.command, undefined, 'MCP 噪声字段 command 已剥除');
    if (structured.events !== undefined) {
      assert.ok(Array.isArray(structured.events), 'events 数组原样透传');
      for (const event of structured.events) {
        assert.ok(typeof event.id === 'string' && typeof event.kind === 'string' && typeof event.createdAt === 'string');
      }
    }
    assertNoShapingMarkers(structured);

    // MCP direct-tool 路径（mcp.ts registerDirect）同样经 shaper：响应原样 + 无标记
    const direct = await rpcPost(url, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'session_list', arguments: { identity } },
    }, mcpSessionId);
    assert.notEqual(direct.data.result.isError, true);
    const directStructured = direct.data.result.structuredContent;
    assert.equal(directStructured.ok, true);
    assertNoShapingMarkers(directStructured);
  } finally {
    await server.close();
  }
});

// ═══════════════════════════════════════════════════════════
// 验收 4：审计接收器 — 无整形时记 passthrough 原因
// ═══════════════════════════════════════════════════════════

test('T01-F: 无整形时审计事件带 shaping { applied:false, reason:"passthrough" }', async () => {
  const server = await createRuntime();
  try {
    const identity = await registerRoot(server);
    const exec = await actionsCall(server, 'execute_cli', { command: 'echo t01f-audit' }, identity);
    assert.equal(exec.body.ok, true);

    const hist = await actionsCall(server, 'session_history', {}, identity);
    assert.equal(hist.body.ok, true);
    const entries = hist.body.data.result.history.entries;
    const auditEntries = entries.filter((entry) => entry.type === 'tool_audit' && entry.data.completedAt);
    const executeAudit = auditEntries.filter((entry) => entry.data.action === 'execute_cli').at(-1);
    assert.ok(executeAudit, 'session_history 应含 execute_cli 审计条目');
    assert.deepEqual(executeAudit.data.shaping, { applied: true }, 'T03 后 execute_cli 整形成功记 applied:true（无 reason）');
    // D7 双版本审计：raw 侧由单测（ctx.audit 记录）锁定（见 issue-31 AC4）。持久化层只留 shaping + 整形后 result；
    // raw 不落盘到模型可见的 tool_audit——T01(#29) 先例 + D7「审计永不进模型上下文」，
    // 否则 projectContext→recentToolCalls 会把 raw 喂给模型，既违 D7 又让整形形同虚设。
    assert.equal(executeAudit.data.rawResult, undefined, 'raw 不落盘到模型可见的 tool_audit');
    // T08(#36)：session_history 现在把每条 tool_audit 的嵌套 ToolResponse（含 execute_cli）摘要化，
    // 以防递归嵌套爆炸 + 大结果（stdout/token）重入历史；历史里不再保留完整去噪结果（命令/输出不泄露到历史）。
    const storedSummary = executeAudit.data.result;
    assert.equal(typeof storedSummary.tool, 'string', 'T08：历史中嵌套 ToolResponse 已摘要为 {tool}');
    assert.equal(storedSummary.ok, true, '摘要 ok 取自嵌套');
    assert.equal(typeof storedSummary.bytes, 'number', '摘要 bytes（原结果量级）');
    assert.equal('data' in storedSummary, false, '摘要不再含完整嵌套 data（命令/输出不重入历史）');

    const registerAudit = auditEntries.filter((entry) => entry.data.action === 'session_register').at(-1);
    assert.ok(registerAudit, 'session_history 应含 session_register 审计条目');
    assert.deepEqual(registerAudit.data.shaping, { applied: false, reason: 'passthrough' });
  } finally {
    await server.close();
  }
});
