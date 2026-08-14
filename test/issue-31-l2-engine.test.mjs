// ADR-0047 T03 (#31)：L2 引擎核心 + 被动去噪成功路径 — 验收 + 单元测试
//
// 验收覆盖（对应 #31 Acceptance criteria）：
//   AC1 路由判定（内联 shapeResult → 中心表 reduce→L1 / schema→L3 → passthrough）
//   AC2 6 工具 CommandResult 被动去噪（复用同一 reducer）；未声明工具原样放行
//   AC3 预算门 estimateTokens（中文≈×1.5、英文≈÷4）+ RAW_BUDGET_TOKENS 接线
//   AC4 D7 双版本审计（raw + shaped + shaping.reason）；D17 静默（无层标记）
//   AC5 D16 count 引擎规则：reducer 产出数组自动补 count
//   AC6 e2e：execute_cli 真实调用 → 无噪声结果 + 审计双版本 + 预算门行为正确
//
// 测试方式：单测直接驱动 shapeToolResponse（dist/tool-parse.js）；e2e 用真实服务器。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MyTerminalRuntime } from '../dist/server.js';
import { TOOL_SHAPES, shapeToolResponse, estimateTokens, RAW_BUDGET_TOKENS } from '../dist/tool-parse.js';

const CONNECTOR_KEY = 'issue31-connector-key-123456';
const ACTIONS_TOKEN = 'issue31-actions-token-1234567890123456';

// CommandResult 权威 10 字段；被动去噪后保留 5 个真实数据字段
const COMMAND_RESULT_NOISE = ['command', 'cwd', 'signal', 'timedOut', 'cancelled'];
const DENOISED_KEYS = ['durationMs', 'exitCode', 'stderr', 'stdout', 'truncated'].sort();
// D17 静默契约：任何层都不插自标识标记
const MARKER_KEYS = ['_shapedBy', '_l1Applied', '_l2Applied', '_l3Applied'];

function assertNoShapingMarkers(value, at = 'root') {
  if (Array.isArray(value)) { for (const item of value) assertNoShapingMarkers(item, `${at}[]`); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assertNoShapingMarkers(item, `${at}.${key}`);
  }
}

function makeCtx(toolDefs = {}) {
  let record;
  const ctx = {
    transport: 'actions',
    sessionId: 's-31',
    resolveTool: (name) => toolDefs[name],
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

const FULL_COMMAND_RESULT = {
  command: 'echo hi', cwd: '/tmp', exitCode: 0, signal: null, timedOut: false,
  stdout: 'hi', stderr: '', truncated: false, durationMs: 12, cancelled: false,
};

// ───────────────────────────────────────────────────────────
// AC1：路由判定（解析顺序）
// ───────────────────────────────────────────────────────────

test('T03-AC1a: 未声明工具原样 passthrough（reason=passthrough）', async () => {
  const { ctx, getRecord } = makeCtx();
  const resp = { ok: true, data: { tool: 'workspace_info', result: { path: '/tmp' } } };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.strictEqual(shaped, resp, '未声明工具必须原样返回');
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'passthrough');
});

test('T03-AC1b: 内联 ToolDefinition.shapeResult 优先于中心表（L1）', async () => {
  const seen = [];
  const { ctx, getRecord } = makeCtx({
    inline_probe: { name: 'inline_probe', shapeResult: (r) => { seen.push('inline'); return { ...r, inlined: true }; } },
  });
  // 即便中心表也注册了同名的 reduce，内联应胜出
  TOOL_SHAPES.set('inline_probe', { reduce: (r) => ({ ...r, table: true }) });
  const resp = { ok: true, data: { tool: 'inline_probe', result: { x: 1 } } };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.deepEqual(seen, ['inline'], '内联 reducer 被调用');
  assert.equal(shaped.data.result.inlined, true, '内联 reducer 生效');
  assert.equal(shaped.data.result.table, undefined, '中心表 reducer 未被调用');
  assert.equal(getRecord().shaping.applied, true);
  TOOL_SHAPES.delete('inline_probe');
});

test('T03-AC1c: 中心表 schema→L3 路由分支可达（T10 后走 L3 引擎，默认 unavailable → l3-unavailable-timeout）', async () => {
  const { ctx, getRecord } = makeCtx();
  TOOL_SHAPES.set('t03_l3_small', { schema: { type: 'object' } });
  const resp = { ok: true, data: { tool: 't03_l3_small', result: { a: 'hi' } } };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.strictEqual(shaped, resp, '默认 unavailable adapter（无注入）下 fail-open 原样');
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable-timeout');
  TOOL_SHAPES.delete('t03_l3_small');
});

// ───────────────────────────────────────────────────────────
// AC2：6 工具 CommandResult 被动去噪（复用同一 reducer）
// ───────────────────────────────────────────────────────────

const SIX_TOOLS = ['execute_cli', 'git_status', 'git_diff', 'git_log', 'git_show', 'run_checks'];

test('T03-AC2: 6 工具 CommandResult 被动去噪（剥 5 噪声字段，保留 5 真实字段）', async () => {
  for (const tool of SIX_TOOLS) {
    const { ctx, getRecord } = makeCtx();
    const resp = { ok: true, data: { tool, result: { ...FULL_COMMAND_RESULT } } };
    const shaped = await shapeToolResponse(resp, ctx);
    const keys = Object.keys(shaped.data.result).sort();
    assert.deepEqual(keys, DENOISED_KEYS, `${tool} 去噪后仅留 5 真实字段`);
    for (const noise of COMMAND_RESULT_NOISE) {
      assert.equal(shaped.data.result[noise], undefined, `${tool} 噪声字段 ${noise} 已剥除`);
    }
    assert.equal(shaped.data.result.stdout, 'hi', `${tool} 真实数据 stdout 保留`);
    assert.equal(shaped.data.result.exitCode, 0);
    assert.equal(getRecord().shaping.applied, true, `${tool} applied:true`);
    assertNoShapingMarkers(shaped);
  }
});

test('T03-AC2b: 失败结果同样去噪（ok:false 仍整形 data.result，error 不动）', async () => {
  const { ctx, getRecord } = makeCtx();
  const error = { code: 'NON_ZERO_EXIT', message: 'boom', retryable: false };
  const resp = { ok: false, data: { tool: 'execute_cli', result: { ...FULL_COMMAND_RESULT, exitCode: 3 } }, error };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.deepEqual(Object.keys(shaped.data.result).sort(), DENOISED_KEYS, '失败结果同样去噪');
  assert.equal(shaped.data.result.exitCode, 3);
  assert.deepEqual(shaped.error, error, 'error 三要素原样（D9）');
  assert.equal(getRecord().shaping.applied, true);
});

test('T03-AC2c: reducer 抛错 → fail-open passthrough（reason=reducer-threw）', async () => {
  TOOL_SHAPES.set('t03_throw', { reduce: () => { throw new Error('kaboom'); } });
  const { ctx, getRecord } = makeCtx();
  const resp = { ok: true, data: { tool: 't03_throw', result: { x: 1 } } };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.strictEqual(shaped, resp, 'reducer 抛错必须原样返回（D11 fail-open）');
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'reducer-threw');
  TOOL_SHAPES.delete('t03_throw');
});

// ───────────────────────────────────────────────────────────
// AC3：预算门 estimateTokens + RAW_BUDGET_TOKENS
// ───────────────────────────────────────────────────────────

test('T03-AC3a: estimateTokens 语言感知（中文≈×1.5、英文≈÷4）', async () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('aaaa'), 1, '4 拉丁 → ceil(4/4)=1');
  assert.equal(estimateTokens('中'), 2, '1 CJK → ceil(1.5)=2');
  assert.equal(estimateTokens('中文'), 3, '2 CJK → ceil(3)=3');
  assert.equal(estimateTokens('ab中'), 2, '2 拉丁 + 1 CJK → ceil(0.5+1.5)=2');
});

test('T03-AC3b: RAW_BUDGET_TOKENS = 24000（pre-T11 公式默认值）', async () => {
  assert.equal(RAW_BUDGET_TOKENS, 24000);
});

test('T03-AC3c: L3 schema 工具超预算门 → passthrough（reason=over-budget）', async () => {
  const { ctx, getRecord } = makeCtx();
  TOOL_SHAPES.set('t03_l3_big', { schema: { type: 'object' } });
  const big = 'x'.repeat(200000); // 200000 拉丁 → ≈50000 tokens > 24000
  const resp = { ok: true, data: { tool: 't03_l3_big', result: { big } } };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.strictEqual(shaped, resp, '超预算必须原样（不调模型）');
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'over-budget');
  TOOL_SHAPES.delete('t03_l3_big');
});

// ───────────────────────────────────────────────────────────
// AC5：D16 count 引擎规则
// ───────────────────────────────────────────────────────────

test('T03-AC5: reducer 产出数组自动补 count', async () => {
  TOOL_SHAPES.set('t03_count_probe', { reduce: (r) => ({ matches: r.items }) });
  const { ctx, getRecord } = makeCtx();
  const resp = { ok: true, data: { tool: 't03_count_probe', result: { items: [1, 2, 3] } } };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.deepEqual(shaped.data.result.matches, [1, 2, 3]);
  assert.equal(shaped.data.result.count, 3, '数组自动补 count');
  assert.equal(getRecord().shaping.applied, true);
  TOOL_SHAPES.delete('t03_count_probe');
});

test('T03-AC5b: CommandResult（非数组结果）不触发 count', async () => {
  const { ctx, getRecord } = makeCtx();
  const resp = { ok: true, data: { tool: 'execute_cli', result: { ...FULL_COMMAND_RESULT } } };
  const shaped = await shapeToolResponse(resp, ctx);
  assert.equal(shaped.data.result.count, undefined, '对象结果无 count（仅数组触发）');
  assert.equal(getRecord().shaping.applied, true);
});

// ───────────────────────────────────────────────────────────
// AC4：D7 双版本审计 + D17 静默
// ───────────────────────────────────────────────────────────

test('T03-AC4: D7 双版本审计（raw 含噪声 / shaped 已去噪 / shaping.reason）+ D17 静默', async () => {
  const { ctx, getRecord } = makeCtx();
  const resp = { ok: true, data: { tool: 'execute_cli', result: { ...FULL_COMMAND_RESULT } } };
  const shaped = await shapeToolResponse(resp, ctx);
  const record = getRecord();
  // raw 保留原始（含噪声）
  assert.equal(record.rawResult.data.result.command, 'echo hi', 'raw 保留噪声 command');
  assert.equal(record.rawResult.data.result.cwd, '/tmp');
  // shaped 已去噪
  assert.equal(record.shapedResult.data.result.command, undefined, 'shaped 已剥除 command');
  assert.equal(shaped.data.result.stdout, 'hi');
  // shaping reason
  assert.equal(record.shaping.applied, true);
  assertNoShapingMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC6：e2e — execute_cli 真实调用
// ───────────────────────────────────────────────────────────

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-issue31-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'hello issue31\n');
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

test('T03-AC6: e2e execute_cli 真实调用 → 无噪声结果 + 审计双版本 + 预算门行为正确', async () => {
  const server = await createRuntime();
  try {
    const reg = await actionsCall(server, 'session_register', { mode: 'root', name: 't03-session', role: 'lead' });
    assert.equal(reg.body.ok, true);
    const identity = reg.body.data.result.identity;

    const exec = await actionsCall(server, 'execute_cli', { command: 'echo issue31-ok' }, identity);
    assert.equal(exec.status, 200);
    assert.equal(exec.body.ok, true);
    const result = exec.body.data.result;
    // 无噪声
    assert.deepEqual(Object.keys(result).sort(), DENOISED_KEYS, 'e2e 结果已去噪');
    for (const noise of COMMAND_RESULT_NOISE) assert.equal(result[noise], undefined, `e2e 噪声 ${noise} 已剥除`);
    assert.ok(result.stdout.includes('issue31-ok'));
    assertNoShapingMarkers(exec.body);

    // 审计双版本 + 预算门行为（execute_cli 是 L1，applied 而非 over-budget）
    const hist = await actionsCall(server, 'session_history', {}, identity);
    const entries = hist.body.ok ? hist.body.data.result.history.entries : [];
    const execAudit = entries
      .filter((e) => e.type === 'tool_audit' && e.data.action === 'execute_cli' && e.data.completedAt)
      .at(-1);
    assert.ok(execAudit, 'session_history 含 execute_cli 审计');
    assert.deepEqual(execAudit.data.shaping, { applied: true }, 'e2e 审计 applied:true（非 over-budget）');
    // raw 不落盘到模型可见的 tool_audit（T01 先例 + D7「审计永不进模型上下文」）；raw 侧由 AC4 单测经 ctx.audit 记录锁定。
    assert.equal(execAudit.data.rawResult, undefined, 'raw 不落盘到模型可见的 tool_audit');
    // T08(#36)：session_history 现在把每条 tool_audit 的嵌套 ToolResponse（含 execute_cli）摘要化，
    // 以防递归嵌套爆炸 + 大结果（stdout/token）重入历史；历史里不再保留完整去噪结果。
    const storedSummary = execAudit.data.result;
    assert.equal(typeof storedSummary.tool, 'string', 'T08：历史中嵌套 ToolResponse 已摘要为 {tool}');
    assert.equal(storedSummary.ok, true, '摘要 ok 取自嵌套');
    assert.equal(typeof storedSummary.bytes, 'number', '摘要 bytes（原结果量级）');
    assert.equal('data' in storedSummary, false, '摘要不再含完整嵌套 data（命令/输出不重入历史）');
  } finally {
    await server.close();
  }
});
