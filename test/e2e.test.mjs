import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MyTerminalRuntime } from '../dist/server.js';

const CONNECTOR_KEY = 'e2e-connector-key-1234567890';
const ACTIONS_TOKEN = 'e2e-actions-token-123456789012345678';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-e2e-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'hello e2e\n');
  return { workspaceDir, stateDir };
}

async function createRuntime() {
  const dirs = tempWorkspace();
  const runtime = new MyTerminalRuntime({ ...dirs, settingsPath: path.join(dirs.stateDir, 'settings.json'), host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: 'http://127.0.0.1:0', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'en', uiTheme: 'dark', passiveLockEnabled: false, actionsContinuationMode: 'off' });
  await runtime.start();
  return { runtime, dirs, baseUrl: `http://127.0.0.1:${runtime.port}`, async close() { await runtime.close(); fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); } };
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
  return { response, data: response.headers.get('content-type')?.includes('text/event-stream') ? parseEventStreamJson(text) : JSON.parse(text), sessionId: response.headers.get('mcp-session-id') };
}

async function actionsCall(server, tool, input = {}, identity) {
  const headers = { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' };
  const response = await fetch(`${server.baseUrl}/actions/extensions/call`, { method: 'POST', headers, body: JSON.stringify({ tool, input, ...(identity ? { identity } : {}) }) });
  return { status: response.status, body: await response.json() };
}

// ═══════════════════════════════════════════════════════════
// E2E-1: MCP 完整链路 — initialize → tools/list → tool call → audit
// ═══════════════════════════════════════════════════════════

test('E2E MCP: initialize → list tools → register session → checkpoint → audit trail', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;

    // Step 1: initialize
    const init = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-test', version: '1.0.0' } } });
    assert.equal(init.response.status, 200);
    assert.ok(init.data.result.instructions.length > 0);
    const sessionId = init.sessionId;
    assert.ok(sessionId);

    // Step 2: tools/list
    const listed = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
    const tools = listed.data.result.tools;
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('session_register'));
    assert.ok(names.includes('session_checkpoint'));
    assert.ok(names.includes('workspace_info'));

    // Step 3: session_register
    const reg = await rpcPost(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 'e2e-session', role: 'lead' } } }, sessionId);
    assert.notEqual(reg.data.result.isError, true);
    assert.ok(reg.data.result.content[0].text.length > 0, 'register should return non-empty text');
  } finally {
    await server.close();
  }
});

// ═══════════════════════════════════════════════════════════
// E2E-2: Actions API 完整链路 — discover → identity → tool → audit
// ═══════════════════════════════════════════════════════════

test('E2E Actions: discover → register → extension_call → audit sanitized', async () => {
  const server = await createRuntime();
  try {
    // Step 1: discover (authenticated with actions token)
    const disc = await fetch(`${server.baseUrl}/actions/extensions/discover`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(disc.status, 200);
    const discBody = await disc.json();
    assert.equal(discBody.ok, true);

    // Step 2: register session
    const reg = await actionsCall(server, 'session_register', { mode: 'root', name: 'e2e-actions', role: 'lead' });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.ok, true);
    const identity = reg.body.data.result.identity;
    assert.ok(identity);

    // Step 3: execute_cli
    const exec = await actionsCall(server, 'execute_cli', { command: 'echo e2e-test-output' }, identity);
    assert.equal(exec.status, 200);
    assert.equal(exec.body.ok, true);
    assert.ok(exec.body.data.result.stdout.includes('e2e-test-output'));
    assert.equal(exec.body.data.result.exitCode, 0);
  } finally {
    await server.close();
  }
});

// ═══════════════════════════════════════════════════════════
// E2E-3: 凭据认证 — 错误 token 被拒绝
// ═══════════════════════════════════════════════════════════

test('E2E Auth: wrong actions token rejected', async () => {
  const server = await createRuntime();
  try {
    // Wrong actions token on discover
    const badDisc = await fetch(`${server.baseUrl}/actions/extensions/discover`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token-123456789012345678', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const badBody = await badDisc.json();
    assert.equal(badBody.ok, false);

    // Correct token works
    const goodDisc = await fetch(`${server.baseUrl}/actions/extensions/discover`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const goodBody = await goodDisc.json();
    assert.equal(goodBody.ok, true);
  } finally {
    await server.close();
  }
});

// ═══════════════════════════════════════════════════════════
// E2E-4: 健康检查 + 集群状态
// ═══════════════════════════════════════════════════════════

test('E2E Health: /health reports version and OpenAPI spec is accessible', async () => {
  const server = await createRuntime();
  try {
    const health = await fetch(`${server.baseUrl}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.product, 'myterminal');
    assert.ok(health.version);
    assert.ok(health.workspaceId);

    // OpenAPI spec is accessible
    const schema = await fetch(`${server.baseUrl}/openapi.json`).then((r) => r.json());
    assert.equal(schema.openapi, '3.1.0');
    assert.ok(schema.paths['/actions/extensions/call']);
  } finally {
    await server.close();
  }
});

// ═══════════════════════════════════════════════════════════
// E2E-5: MCP 深度 — 多工具调用 + 错误处理 + session 管理
// ═══════════════════════════════════════════════════════════

test('E2E MCP deep: extension_call execute_cli + read_file + error handling', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'deep-test', version: '1.0.0' } } });
    const sid = init.sessionId;

    // Register session to get identity
    const reg = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 'deep-session', role: 'lead' } } }, sid);
    assert.notEqual(reg.data.result.isError, true);
    const identity = reg.data.result.structuredContent.data.result.identity;
    assert.ok(identity.sessionId);

    // Call execute_cli via extension_call (identity at top level)
    const exec = await rpcPost(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'execute_cli', input: { command: 'echo mcp-deep-test' }, identity } } }, sid);
    assert.notEqual(exec.data.result.isError, true);
    const execStructured = exec.data.result.structuredContent;
    assert.equal(execStructured.ok, true);
    assert.ok(execStructured.data.result.stdout.includes('mcp-deep-test'));

    // Call read_file via extension_call (direct tools strip identity)
    const read = await rpcPost(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'read_file', input: { path: 'hello.txt' }, identity } } }, sid);
    assert.notEqual(read.data.result.isError, true);
    const readStructured = read.data.result.structuredContent;
    assert.equal(readStructured.ok, true);

    // Error case: call unknown tool
    const bad = await rpcPost(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'nonexistent_tool_xyz', input: {}, identity } } }, sid);
    const badStructured = bad.data.result.structuredContent;
    assert.equal(badStructured.ok, false);
    assert.ok(badStructured.error.code);
  } finally {
    await server.close();
  }
});

test('E2E MCP session: invalid session rejected, multiple sessions isolated', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;

    // Request without session → 400
    const noSession = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'mcp-session-id': 'nonexistent-session-id' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(noSession.status, 400);

    // Create two independent sessions
    const init1 = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'session-1', version: '1.0.0' } } });
    const init2 = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'session-2', version: '1.0.0' } } });
    assert.ok(init1.sessionId);
    assert.ok(init2.sessionId);
    assert.notEqual(init1.sessionId, init2.sessionId);

    // Both sessions can list tools independently
    const list1 = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init1.sessionId);
    const list2 = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init2.sessionId);
    assert.ok(list1.data.result.tools.length > 20);
    assert.ok(list2.data.result.tools.length > 20);

    // Session 1 registers a session; session 2 has independent state
    const reg1 = await rpcPost(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 'from-session-1', role: 'lead' } } }, init1.sessionId);
    assert.notEqual(reg1.data.result.isError, true);
  } finally {
    await server.close();
  }
});

test('E2E MCP tools: workspace_info + session_list + session_checkpoint flow', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'flow-test', version: '1.0.0' } } });
    const sid = init.sessionId;

    // session_register to get identity
    const reg = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 'flow-session', role: 'lead' } } }, sid);
    const regData = reg.data.result.structuredContent;
    assert.equal(regData.ok, true);
    const identity = regData.data.result.identity;
    assert.ok(identity.sessionId);

    // workspace_info via extension_call (direct tools strip identity)
    const info = await rpcPost(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'workspace_info', input: {}, identity } } }, sid);
    const infoData = info.data.result.structuredContent;
    assert.equal(infoData.ok, true);
    assert.ok(infoData.data.result.workspaceDir);

    // session_list via extension_call
    const list = await rpcPost(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'session_list', input: {}, identity } } }, sid);
    const listData = list.data.result.structuredContent;
    assert.equal(listData.ok, true);
    assert.ok(listData.data.result.sessions.length >= 1);

    // session_checkpoint to working via extension_call
    const cp = await rpcPost(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'session_checkpoint', input: { phase: 'working', summary: 'MCP flow test in progress' }, identity } } }, sid);
    const cpData = cp.data.result.structuredContent;
    assert.equal(cpData.ok, true);
    assert.equal(cpData.data.result.session.phase, 'working');

    // session_checkpoint to completed
    const done = await rpcPost(url, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'session_checkpoint', input: { phase: 'completed', summary: 'MCP flow test done' }, identity } } }, sid);
    const doneData = done.data.result.structuredContent;
    assert.equal(doneData.ok, true);
    assert.equal(doneData.data.result.session.phase, 'completed');
  } finally {
    await server.close();
  }
});

// ═══════════════════════════════════════════════════════════
// E2E T07: session_list 主动精简 + 可恢复翻页（D15 前半）
// ═══════════════════════════════════════════════════════════
test('E2E T07: session_list 主动精简 + 可恢复翻页', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't07-test', version: '1.0.0' } } });
    const sid = init.sessionId;

    // 注册首会话拿 identity
    const reg = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 't07-root', role: 'lead' } } }, sid);
    const identity = reg.data.result.structuredContent.data.result.identity;

    // 再建 25 个 root 会话，总计 26
    for (let i = 0; i < 25; i++) {
      await rpcPost(url, { jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: `t07-page-${i}`, role: 'lead' } } }, sid);
    }

    // 第一页（默认 limit 20）
    const list = await rpcPost(url, { jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'session_list', input: {}, identity } } }, sid);
    const listData = list.data.result.structuredContent;
    assert.equal(listData.ok, true);
    assert.equal(listData.data.result.sessions.length, 20, '第一页限条目 20');
    assert.equal(listData.data.result.totalCount, 26, 'totalCount 真实总量');
    assert.equal(listData.data.result.truncated, true);
    assert.ok(listData.data.continuation?.pagination, '应发射分页 continuation');
    assert.equal(listData.data.continuation.pagination.truncated, true);
    assert.equal(listData.data.continuation.pagination.nextCall.input.offset, 20, 'nextCall 指向下一页');

    // 翻页（offset 20）— 模型按 continuation 恢复
    const page2 = await rpcPost(url, { jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'session_list', input: { offset: 20 }, identity } } }, sid);
    const page2Data = page2.data.result.structuredContent;
    assert.equal(page2Data.data.result.sessions.length, 6, '第二页 6 条');
    assert.equal(page2Data.data.result.totalCount, 26);
    assert.equal(page2Data.data.result.truncated, false, '末页不再 truncated');
    assert.equal(page2Data.data.continuation, undefined, '末页不发射分页 continuation');
  } finally {
    await server.close();
  }
});

// ═══════════════════════════════════════════════════════════
// E2E T08: session_history 嵌套 ToolResponse → 摘要 + read_file_range maxBytes 截断（D15/T08）
// ═══════════════════════════════════════════════════════════
test('E2E T08: session_history 嵌套 ToolResponse 摘要化 + read_file_range maxBytes 截断', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't08-test', version: '1.0.0' } } });
    const sid = init.sessionId;

    const reg = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_register', arguments: { mode: 'root', name: 't08-root', role: 'lead' } } }, sid);
    const identity = reg.data.result.structuredContent.data.result.identity;

    // ── 1) session_history 经 live server 整形：嵌套 ToolResponse → 摘要 ──
    const hist = await rpcPost(url, { jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'session_history', input: { limit: 10 }, identity } } }, sid);
    const histData = hist.data.result.structuredContent;
    assert.equal(histData.ok, true, 'session_history 应 ok');
    const entries = histData.data.result.history.entries;
    assert.ok(Array.isArray(entries) && entries.length > 0, 'history 应含条目');

    // 找带嵌套 result 的 tool_audit 条目（如已完成 session_register）
    const audited = entries.find((e) => e.type === 'tool_audit' && e.data && e.data.result);
    assert.ok(audited, '应存在带嵌套 result 的 tool_audit 条目');
    const summary = audited.data.result;
    // 摘要形态：{ tool, ok, bytes? }，不再含完整嵌套 ToolResponse
    assert.equal(typeof summary.tool, 'string', '嵌套 ToolResponse 应被摘要为 {tool}');
    assert.equal(typeof summary.ok, 'boolean');
    assert.equal(typeof summary.bytes, 'number', '摘要应带 bytes 量级');
    assert.equal('data' in summary, false, '摘要不得再含完整嵌套 data（爆炸消除）');
    assert.equal('result' in summary, false, '摘要不得再含完整嵌套 result（防爆栈）');
    // audit 级 tool/ok 保全
    assert.equal(audited.data.tool, summary.tool, 'audit 级 tool 保全');
    assert.equal(audited.data.ok, summary.ok, 'audit 级 ok 保全');

    // ── 2) read_file_range maxBytes 截断（handler 流式，防全文件进内存）──
    const bigPath = path.join(server.dirs.workspaceDir, 't08-big.txt');
    const line = 'abcdefghij'.repeat(20); // 200 chars/行
    const totalLines = 50;
    // 无尾随换行 → 真实 50 行（与 read_file split 语义一致：尾随空行不计入）
    fs.writeFileSync(bigPath, Array.from({ length: totalLines }, () => line).join('\n'));

    const rfr = await rpcPost(url, { jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'read_file_range', input: { path: 't08-big.txt', startLine: 1, endLine: totalLines, maxBytes: 500 }, identity } } }, sid);
    const rfrData = rfr.data.result.structuredContent;
    assert.equal(rfrData.ok, true, 'read_file_range 应 ok');
    const rr = rfrData.data.result;
    assert.equal(rr.totalLines, totalLines, 'totalLines 应为真实总行数（不被截断影响）');
    assert.equal(rr.truncated, true, '超 maxBytes 应置 truncated:true');
    assert.ok(Buffer.byteLength(rr.content, 'utf8') <= 500, 'content 字节数不应超过 maxBytes');
    assert.ok(typeof rr.sha256 === 'string' && rr.sha256.length === 64, 'sha256 字节精确（全文件哈希）');
    assert.ok(rr.content.includes('1: '), 'content 应为 `行号: 行内容` 格式');

    // ── 2b) 空文件：totalLines 应为 1（匹配 split(/\r?\n/)，不回归为 0）──
    const emptyPath = path.join(server.dirs.workspaceDir, 't08-empty.txt');
    fs.writeFileSync(emptyPath, '');
    const rfrEmpty = await rpcPost(url, { jsonrpc: '2.0', id: 102, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'read_file_range', input: { path: 't08-empty.txt', startLine: 1, endLine: 10 }, identity } } }, sid);
    const rrEmpty = rfrEmpty.data.result.structuredContent.data.result;
    assert.equal(rfrEmpty.data.result.structuredContent.ok, true, '空文件读取应成功');
    assert.equal(rrEmpty.totalLines, 1, '空文件 totalLines 应为 1（与 read_file 一致，不回归为 0）');
    assert.equal(rrEmpty.content, '', '空文件 content 为空');
    assert.equal(rrEmpty.truncated, false);

    // ── 2c) 多字节（CJK）内容：不损坏（StringDecoder 跨块边界安全）──
    const cjkPath = path.join(server.dirs.workspaceDir, 't08-cjk.txt');
    const cjkLine = '中文测试汉字内容混合abc' + '宇'.repeat(20);
    const cjkTotal = 6;
    fs.writeFileSync(cjkPath, Array.from({ length: cjkTotal }, (_, i) => `${cjkLine}行${i}`).join('\n'));
    const rfrCjk = await rpcPost(url, { jsonrpc: '2.0', id: 103, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'read_file_range', input: { path: 't08-cjk.txt', startLine: 1, endLine: cjkTotal }, identity } } }, sid);
    const rrCjk = rfrCjk.data.result.structuredContent.data.result;
    assert.equal(rrCjk.totalLines, cjkTotal, 'CJK 文件总行数正确');
    for (let i = 0; i < cjkTotal; i++) {
      assert.ok(rrCjk.content.includes(`${i + 1}: ${cjkLine}行${i}`), `CJK 第 ${i + 1} 行无损坏`);
    }
    assert.equal(rrCjk.content.includes('�'), false, 'CJK 内容不得含替换字符 U+FFFD');
  } finally {
    await server.close();
  }
});
