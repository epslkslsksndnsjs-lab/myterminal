// ADR-0051 W1-09 (#82)：D7 双版本审计 raw 保留（0050 F1）— 验收 + 单元测试
//
// 验收覆盖（对应 #82 Acceptance criteria）：
//   AC1 D7 双版本落盘：审计 JSONL 保留 rawResult + shapedResult 两份；raw 含整形前原始版
//       （execute_cli 噪声字段完整）；result 保持整形后版（兼容字段）；D17 无层标记
//   AC2 D12 诊断保全：raw 侧 error 完整未截断（5000 字符 vs 帽 2000），shaped 侧截断
//   AC3 模型可见通道零泄漏：session_history（含非嵌套条目）与 session_context
//       （projectContext→recentToolCalls）无 rawResult / shapedResult
//   AC4 D15 ② 恢复：find_files 主动精简的完整原始版（totalMatches 内部字段）在审计 raw 可取
//   AC5 附带 (a)：L3 失败 reason=l3-unavailable，不再误标 reducer-threw
//   AC6 附带 (b)：task_poll 嵌套整形成功 → 外层审计 applied:true，不再恒 passthrough
//
// 测试方式：单测直接驱动 shapeToolResponse（dist/tool-parse.js）；落盘/模型通道用真实服务器。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MyTerminalRuntime } from '../dist/server.js';
import { TOOL_SHAPES, shapeToolResponse, clearOperationCache, ERROR_MESSAGE_MAX_CHARS } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter, resetL3AdapterInstance } from '../dist/l3/registry.js';

const CONNECTOR_KEY = 'issueW109-connector-key-123456';
const ACTIONS_TOKEN = 'issueW109-actions-token-1234567890123456';

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

const FULL_COMMAND_RESULT = {
  command: 'echo hi', cwd: '/tmp', exitCode: 0, signal: null, timedOut: false,
  stdout: 'hi', stderr: '', truncated: false, durationMs: 12, cancelled: false,
};

function makeCtx(toolDefs = {}) {
  let record;
  const ctx = {
    transport: 'actions',
    sessionId: 's-w109',
    resolveTool: (name) => toolDefs[name],
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

// ── task_poll 嵌套结构（issue-33 同款）──────────────────────────────────────

function makeTaskPoll(nestedOperation, { taskId = 't-w109', status = 'completed' } = {}) {
  return {
    ok: true,
    data: {
      tool: 'task_poll',
      result: { taskId, status, operation: nestedOperation },
    },
  };
}

function nestedExecuteCli(result = FULL_COMMAND_RESULT, ok = true) {
  return { ok, data: { tool: 'execute_cli', result } };
}

// ── 真实服务器助手（issue-29 同款）──────────────────────────────────────────

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-issueW109-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'hello issueW109\n');
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
  const reg = await actionsCall(server, 'session_register', { mode: 'root', name: 'w109-session', role: 'lead' });
  assert.equal(reg.body.ok, true);
  return reg.body.data.result.identity;
}

/** 审计链（JSONL）读取：history/<sessionId>.jsonl 的 tool_audit 条目（store.ts historyPath）。 */
function readAuditEntries(server, sessionId) {
  const file = path.join(server.dirs.stateDir, 'history', `${sessionId}.jsonl`);
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'tool_audit');
}

// ───────────────────────────────────────────────────────────
// AC1：D7 双版本落盘 — 审计 JSONL 保留 raw + shaped
// ───────────────────────────────────────────────────────────

test('W1-09 AC1: 审计 JSONL 保留 rawResult + shapedResult 双版本（raw 含整形前原始版）', async () => {
  const server = await createRuntime();
  try {
    const identity = await registerRoot(server);
    await actionsCall(server, 'execute_cli', { command: 'echo w109-dual' }, identity);

    const entries = readAuditEntries(server, identity.sessionId);
    const execAudit = entries.filter((entry) => entry.data.action === 'execute_cli').at(-1);
    assert.ok(execAudit, 'JSONL 应含 execute_cli 审计条目');

    assert.ok(execAudit.data.rawResult, 'D7：审计链保留整形前原始版 rawResult');
    assert.equal(execAudit.data.rawResult.data.tool, 'execute_cli');
    assert.equal(execAudit.data.rawResult.data.result.command, 'echo w109-dual', 'raw 含噪声字段（整形前原始版）');
    assert.equal(typeof execAudit.data.rawResult.data.result.cwd, 'string', 'raw cwd 原样（resolveWorkspacePath 真实路径）');

    assert.ok(execAudit.data.shapedResult, 'D7：审计链保留整形后版 shapedResult');
    assert.equal(execAudit.data.shapedResult.data.result.command, undefined, 'shaped 已剥噪声（command）');
    // win32 下 echo 输出 CRLF——断言前归一化换行，语义（内容 + 尾随换行）不变
    assert.equal(execAudit.data.shapedResult.data.result.stdout.replace(/\r\n/g, '\n'), 'w109-dual\n', 'shaped 真实数据字段保留');

    assert.equal(execAudit.data.result.data.result.command, undefined, 'result 保持整形后版（兼容字段）');
    assert.equal(execAudit.data.shaping.applied, true, 'shaping 审计照常');
    assertNoShapingMarkers(execAudit.data.rawResult, 'rawResult');
    assertNoShapingMarkers(execAudit.data.shapedResult, 'shapedResult');
  } finally {
    await server.close();
  }
});

// ───────────────────────────────────────────────────────────
// AC2：D12 诊断保全 — raw 侧 error 完整未截断，shaped 侧截断
// ───────────────────────────────────────────────────────────

test('W1-09 AC2: raw 侧 error 完整未截断（D12），shaped 侧截断', async () => {
  const { ctx, getRecord } = makeCtx();
  const resp = {
    ok: false,
    data: { tool: 'execute_cli', result: { ...FULL_COMMAND_RESULT, exitCode: 7 } },
    error: { code: 'NON_ZERO_EXIT', message: 'm'.repeat(5000), retryable: false },
  };
  await shapeToolResponse(resp, ctx);
  const record = getRecord();
  assert.equal(record.rawResult.error.message.length, 5000, 'raw 保留完整未截断 error（D12 诊断保全）');
  assert.equal(record.shapedResult.error.message.length, ERROR_MESSAGE_MAX_CHARS, 'shaped 侧 D12 截断（2000）');
  assert.equal(record.rawResult.error.code, 'NON_ZERO_EXIT', 'raw 侧 error.code 原样');
  assert.equal(record.shapedResult.error.code, 'NON_ZERO_EXIT', 'shaped 侧 error.code 原样');
});

// ───────────────────────────────────────────────────────────
// AC3：模型可见通道零泄漏（session_history / session_context）
// ───────────────────────────────────────────────────────────

test('W1-09 AC3a: session_history（模型可见）无 rawResult / shapedResult 泄漏', async () => {
  const server = await createRuntime();
  try {
    const identity = await registerRoot(server);
    await actionsCall(server, 'execute_cli', { command: 'echo w109-leak' }, identity);

    const hist = await actionsCall(server, 'session_history', {}, identity);
    assert.equal(hist.body.ok, true);
    const entries = hist.body.data.result.history.entries;
    const execAudit = entries.filter((entry) => entry.type === 'tool_audit' && entry.data.action === 'execute_cli').at(-1);
    assert.ok(execAudit, 'session_history 应含 execute_cli 审计条目');
    // T01-F 先例 + D7「审计永不进模型上下文」：raw 不落盘到模型可见的 tool_audit
    assert.equal(execAudit.data.rawResult, undefined, 'raw 不落盘到模型可见的 tool_audit');
    assert.equal(execAudit.data.shapedResult, undefined, 'shapedResult 同样不落模型可见通道');

    // 非嵌套 result 条目（session_register passthrough）同样剥除 raw（T01-F 未覆盖的新面）
    const registerAudit = entries.filter((entry) => entry.type === 'tool_audit' && entry.data.action === 'session_register').at(-1);
    assert.ok(registerAudit, 'session_history 应含 session_register 审计条目');
    assert.equal(registerAudit.data.rawResult, undefined, 'passthrough 条目 raw 亦剥除');
    assert.equal(registerAudit.data.shapedResult, undefined, 'passthrough 条目 shapedResult 亦剥除');
  } finally {
    await server.close();
  }
});

test('W1-09 AC3b: session_context（projectContext→recentToolCalls）无 rawResult 泄漏', async () => {
  const server = await createRuntime();
  try {
    const identity = await registerRoot(server);
    await actionsCall(server, 'execute_cli', { command: 'echo w109-ctx' }, identity);

    const ctxCall = await actionsCall(server, 'session_context', {}, identity);
    assert.equal(ctxCall.body.ok, true);
    const recent = ctxCall.body.data.result.context.recentToolCalls;
    assert.ok(Array.isArray(recent) && recent.length >= 1, 'recentToolCalls 应含最近工具审计');
    for (const item of recent) {
      assert.equal(item.rawResult, undefined, 'recentToolCalls 无 raw（projectContext 绝不喂模型）');
      assert.equal(item.shapedResult, undefined, 'recentToolCalls 无 shapedResult');
    }
  } finally {
    await server.close();
  }
});

// ───────────────────────────────────────────────────────────
// AC4：D15 ② 恢复 — find_files 主动精简的完整原始版在审计 raw 可取
// ───────────────────────────────────────────────────────────

test('W1-09 AC4: find_files 主动精简的完整原始版（totalMatches）在审计 raw 可取', async () => {
  const server = await createRuntime();
  try {
    const identity = await registerRoot(server);
    // 文件名用不含临时目录前缀干扰的独特词（临时目录名含 issueW109-，query 需避开）
    fs.writeFileSync(path.join(server.dirs.workspaceDir, 'w109abc-1.txt'), 'x');
    fs.writeFileSync(path.join(server.dirs.workspaceDir, 'w109abc-2.txt'), 'y');

    const res = await actionsCall(server, 'find_files', { query: 'w109abc' }, identity);
    assert.equal(res.body.ok, true);
    const result = res.body.data.result;
    assert.equal(typeof result.count, 'number', '模型可见响应为精简版（count）');

    const entries = readAuditEntries(server, identity.sessionId);
    const findAudit = entries.filter((entry) => entry.data.action === 'find_files').at(-1);
    assert.ok(findAudit, 'JSONL 应含 find_files 审计条目');

    const rawResult = findAudit.data.rawResult;
    assert.ok(rawResult, '审计 raw 保留完整原始版（D15 ②）');
    assert.ok(Array.isArray(rawResult.data.result.matches), 'raw.matches 为完整数组');
    assert.equal(rawResult.data.result.matches.length, 2, 'raw 含全部匹配（含被精简的内部字段）');
    assert.ok(rawResult.data.result.matches.some((m) => m.endsWith('w109abc-1.txt')), 'raw.matches 含 w109abc-1.txt');
    assert.equal(rawResult.data.result.totalMatches, 2, 'raw 保留 handler 内部 totalMatches（D17 只约束模型通道）');

    const shapedResult = findAudit.data.shapedResult;
    assert.equal(typeof shapedResult.data.result.count, 'number', 'shaped 侧为精简版');
    assert.equal(shapedResult.data.result.totalMatches, undefined, 'shaped 剥除 totalMatches（统一 totalCount）');
  } finally {
    await server.close();
  }
});

// ───────────────────────────────────────────────────────────
// AC5：附带 (a) — L3 失败不再误标 reducer-threw
// ───────────────────────────────────────────────────────────

afterEach(() => {
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）
  TOOL_SHAPES.delete('w109_l3_probe');
  clearOperationCache();
});

test('W1-09 AC5: L3 失败 reason=l3-unavailable（不再误标 reducer-threw）', async () => {
  // 模型不可用（supportsStructuredOutput=false）→ runL3 全路径 fail-open 记 l3-unavailable
  resetL3Adapter();
  registerAdapterFactory(() => fakeUnavailableAdapter());
  TOOL_SHAPES.set('w109_l3_probe', { schema: { type: 'object', properties: { summary: { type: 'string' } } } });

  const { ctx, getRecord } = makeCtx({ w109_l3_probe: { name: 'w109_l3_probe', title: 't', description: 'd', inputSchema: {}, annotations: {}, invoke: async () => ({}) } });
  const resp = { ok: true, data: { tool: 'w109_l3_probe', result: { messy: 'free text '.repeat(60) } } };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.strictEqual(shaped, resp, 'L3 失败 fail-open 原样 passthrough');
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable', 'L3 失败记真实原因，不再误标 reducer-threw');
});

function fakeUnavailableAdapter() {
  return {
    id: 'fake-unavailable',
    supportsStructuredOutput: false,
    isReady: async () => false,
    complete: async () => ({ object: null, finishReason: 'error', latencyMs: 1, modelId: 'fake' }),
  };
}

// ───────────────────────────────────────────────────────────
// AC6：附带 (b) — task_poll 嵌套整形成功 → 外层审计如实 applied:true
// ───────────────────────────────────────────────────────────

test('W1-09 AC6: task_poll 嵌套整形成功 → 外层审计 applied:true（不再恒 passthrough）', async () => {
  clearOperationCache();
  const { ctx, getRecord } = makeCtx();
  const nested = nestedExecuteCli({ ...FULL_COMMAND_RESULT, exitCode: 0 }, true);
  const resp = makeTaskPoll(nested);
  const shaped = await shapeToolResponse(resp, ctx);

  const op = shaped.data.result.operation;
  assert.equal(op.data.result.command, undefined, '嵌套已整形（噪声剥除）');
  assert.equal(getRecord().shaping.applied, true, '嵌套整形成功 → 外层审计如实 applied:true');
  assert.equal(getRecord().shaping.reason, undefined, '成功路径无 reason');
});

// ───────────────────────────────────────────────────────────
// AC7：D17 静默回归（e2e 全链路）— 模型可见响应无层标记
// ───────────────────────────────────────────────────────────

test('W1-09 AC7: 模型可见响应无层标记（D17 静默回归）', async () => {
  const server = await createRuntime();
  try {
    const identity = await registerRoot(server);
    const exec = await actionsCall(server, 'execute_cli', { command: 'echo w109-d17' }, identity);
    assert.equal(exec.body.ok, true);
    assertNoShapingMarkers(exec.body.data.result, 'execute_cli 响应');
  } finally {
    await server.close();
  }
});
