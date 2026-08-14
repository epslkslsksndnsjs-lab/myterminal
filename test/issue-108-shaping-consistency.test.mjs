// ADR-0051 增补-09 (#108)：整形一致性小修（扩展去噪 / 拷贝 / 恰限 / 末页 / 空stdout）
//
// 来源：A2 F3/F6 + A5a F1/F4 + A5b F3/F5 + e3 复核 R5/R17/R18/R19。
//
// 验收断言：
//   AC1  command-kind 扩展响应剥 5 噪声键（command/cwd/signal/timedOut/cancelled），
//        答案字段（exitCode/stdout/stderr/truncated/durationMs）逐字保全（R5）
//   AC2  fail-open 原 raw 不被注入 count；D7 审计 raw 原样（R19）
//   AC3  find_files 恰中 limit：truncated=false 且 count===真实总量（不误报截断，R17）
//   AC4  message_* 末页（nextOffset 缺失且 offset>0）：truncated=false、无 nextCall 回绕（R18）
//   AC5  空 stdout 不触发 L3（配额 0 增量，回落 L1 denoise；非空小 stdout 仍走 L3 不回归）
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js，遵循 issue-31 seam）；
// 运行时探测走 MyTerminalRuntime actions 通道（myterminal.test.mjs 手法）。
// 注：任何 src 改动后必须先 bun run build 再跑测试（测试全部从 dist 导入，历史教训见 #43）。

import { test, afterEach, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter, resetL3AdapterInstance } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';
import { MyTerminalRuntime } from '../dist/server.js';

const COMMAND_RESULT_NOISE = ['command', 'cwd', 'signal', 'timedOut', 'cancelled'];

// ── seam 帮手（issue-W101/W104 手法）───────────────────────────────────────────

function makeResponse(tool, result) {
  return { ok: true, data: { tool, result } };
}

function makeCtx(sessionId = 's-108') {
  let record;
  const ctx = {
    transport: 'actions',
    sessionId,
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

function pageMessages(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `m-${i}`, from: `sender-${i % 3}`, body: `body ${i}` }));
}

// ── 运行时帮手（myterminal.test.mjs 手法）─────────────────────────────────────

const ACTIONS_TOKEN = 'test-actions-token-12345678901234567890';
const CONNECTOR_KEY = 'test-connector-key-1234567890';

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

function actionsHeaders() { return { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' }; }
async function action(server, endpoint, body) {
  const response = await fetch(`${server.baseUrl}/actions/extensions/${endpoint}`, { method: 'POST', headers: actionsHeaders(), body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function call(server, tool, input = {}, identity) { return action(server, 'call', { tool, input, ...(identity ? { identity } : {}) }); }
async function root(server, name = 'main') {
  const response = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(response.body.ok, true, JSON.stringify(response.body));
  return response.body.data.result;
}

// ── L3 fake adapter（issue-W206 手法）──────────────────────────────────────────

function injectFake({ ready = true } = {}) {
  resetL3Adapter();
  let completeCalls = 0;
  const adapter = {
    id: 'fake',
    supportsStructuredOutput: ready,
    isReady: async () => ready,
    complete: async () => {
      completeCalls++;
      return { latencyMs: 1, modelId: 'fake', object: { name: 'alice' }, finishReason: 'stop' };
    },
  };
  registerAdapterFactory(() => adapter);
  return { adapter, getCompleteCalls: () => completeCalls };
}

function shapeRaw(result, ctx) {
  return shapeToolResponse({ ok: true, data: { tool: 'execute_cli', result } }, ctx);
}

afterEach(() => {
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）
  clearL3Quota();
});

// ── AC1：command-kind 扩展剥 5 噪声键（R5）────────────────────────────────────

test('108-AC1: command-kind 扩展响应剥 5 噪声键，答案字段逐字保全', async () => {
  const server = await createRuntime();
  try {
    const main = await root(server);
    const identity = main.identity;
    const spec = {
      name: 'echo_value_108', title: 'Echo value', description: 'Echo a supplied value through a bounded executable.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      handler: { kind: 'command', executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', '{{input.value}}'] },
    };
    for (const actionName of ['validate', 'upsert']) {
      const response = await action(server, 'register', { action: actionName, spec, identity });
      assert.equal(response.body.ok, true, JSON.stringify(response.body));
    }
    const custom = await call(server, 'echo_value_108', { value: 'custom-ok' }, identity);
    assert.equal(custom.body.ok, true, JSON.stringify(custom.body));
    assert.equal(custom.body.data.result.stdout, 'custom-ok', 'stdout 逐字保全');
    for (const key of COMMAND_RESULT_NOISE) {
      assert.equal(key in custom.body.data.result, false, `噪声键 ${key} 应剥除（R5）`);
    }
    assert.equal(typeof custom.body.data.result.exitCode, 'number', 'exitCode 保全');
    assert.equal('stderr' in custom.body.data.result, true, 'stderr 保全');
    assert.equal('truncated' in custom.body.data.result, true, 'truncated 保全');
    assert.equal('durationMs' in custom.body.data.result, true, 'durationMs 保全');
  } finally { await server.close(); }
});

// ── AC2：fail-open 原 raw 不被注入 count；D7 审计 raw 原样（R19）───────────────

test('108-AC2: message fail-open 原 raw 不被注入 count；D7 审计 raw 原样', async () => {
  const { ctx: c, getRecord } = makeCtx();
  const raw = { session: { id: 's-alice' }, messages: 'not-an-array', observations: [{ id: 'o1' }] };
  const shaped = await shapeToolResponse(makeResponse('message_inbox', raw), c);
  assert.equal('count' in raw, false, '原始 raw 对象不被注入 count（R19：不再同引用写）');
  const auditRaw = getRecord().rawResult.data.result;
  assert.equal(auditRaw === raw, true, 'D7 审计 raw 即原始对象（同引用）');
  assert.equal('count' in auditRaw, false, '审计 raw 无伪 count');
  // D16.1 count 规则仍在（拷贝上注入，不触碰原始）：observations 是唯一顶层数组
  assert.equal(shaped.data.result.count, 1, 'count 注入在拷贝上（D16.1 全局规则不回归）');
  assert.equal(shaped.data.result !== raw, true, 'shaped 为拷贝，原始 raw 纯净');
});

// ── AC3：find_files 恰中 limit 不误报截断（R17）────────────────────────────────

test('108-AC3: find_files 恰中 limit — truncated=false 且 count === 真实总量', async () => {
  const server = await createRuntime();
  try {
    const main = await root(server);
    const identity = main.identity;
    // 恰中：5 个匹配文件，limit 5
    for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(server.dirs.workspaceDir, `zzz-q${i}.txt`), `file ${i}\n`);
    const exactly = await call(server, 'find_files', { query: 'zzz-q', limit: 5 }, identity);
    assert.equal(exactly.body.ok, true, JSON.stringify(exactly.body));
    assert.equal(exactly.body.data.result.matches.length, 5, '5 个匹配');
    assert.equal(exactly.body.data.result.truncated, false, '恰中 limit 不误报截断（R17）');
    assert.equal(exactly.body.data.result.count, 5, 'count === 真实总量');
    assert.equal('totalCount' in exactly.body.data.result, false, '非截断无 totalCount');
    assert.equal('totalMatches' in exactly.body.data.result, false, 'totalMatches 不泄漏（D17）');
    // 对照：6 个匹配 limit 5 → 真截断
    fs.writeFileSync(path.join(server.dirs.workspaceDir, 'zzz-q6.txt'), 'file 6\n');
    const over = await call(server, 'find_files', { query: 'zzz-q', limit: 5 }, identity);
    assert.equal(over.body.data.result.truncated, true, '真截断仍报 truncated');
    assert.equal(over.body.data.result.totalCount, 6, '截断态 totalCount === 真实总量');
    assert.equal(over.body.data.result.count, 5, 'count === 本页实际长度');
  } finally { await server.close(); }
});

// ── AC4：message_* 末页 truncated=false、无 nextCall 回绕（R18）────────────────

test('108-AC4: message_inbox 末页（nextOffset 缺失且 offset>0）→ truncated=false 无 nextCall', async () => {
  const { ctx: c } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('message_inbox', {
    session: { id: 's-alice' },
    total: 150, offset: 100,
    messages: pageMessages(50),
    observations: pageMessages(50),
  }), c);
  assert.equal(shaped.data.result.messages.length, 50, 'messages 原样保留');
  assert.equal(shaped.data.result.count, 50);
  assert.equal(shaped.data.result.truncated, false, '末页终态 truncated=false（R18）');
  assert.equal('totalCount' in shaped.data.result, false, '非截断无 totalCount');
  assert.equal(shaped.data.continuation === undefined || shaped.data.continuation.pagination === undefined, true, '不发 nextCall，无 offset 0 回绕');
});

test('108-AC4b: message_list 末页同样 truncated=false 无回绕', async () => {
  const { ctx: c } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('message_list', {
    total: 150, offset: 100,
    messages: pageMessages(50),
    observations: [],
  }), c);
  assert.equal(shaped.data.result.truncated, false, '末页终态 truncated=false');
  assert.equal(shaped.data.continuation === undefined || shaped.data.continuation.pagination === undefined, true, '无 nextCall 回绕');
});

test('108-AC4c: 非末页（nextOffset 存在）→ truncated=true 正常翻页（不回归 W1-04-AC3）', async () => {
  const { ctx: c } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('message_inbox', {
    session: { id: 's-alice' },
    total: 150, offset: 100, nextOffset: 150,
    messages: pageMessages(50),
    observations: pageMessages(50),
  }), c);
  assert.equal(shaped.data.result.truncated, true, '有后继页仍 truncated');
  assert.equal(shaped.data.result.totalCount, 150);
  assert.deepEqual(shaped.data.continuation.pagination.nextCall, {
    tool: 'message_inbox', input: { offset: 150, limit: 50 }, purpose: 'fetch next page of inbox messages',
  }, 'nextCall 续读 150，不回绕 0');
});

// ── AC5：空 stdout 不触发 L3（A5b F3）─────────────────────────────────────────

test('108-AC5: 空 stdout 不触发 L3（回落 L1 denoise，配额 0 增量）', async () => {
  const { getCompleteCalls } = injectFake();
  const { ctx: c, getRecord } = makeCtx();
  const shaped = await shapeRaw({
    exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1,
    command: 'echo', cwd: '/', signal: null, timedOut: false, cancelled: false,
  }, c);
  assert.equal(getCompleteCalls(), 0, '空输出不调 L3（A5b F3）');
  assert.deepEqual(shaped.data.result, { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1 }, '回落 L1 denoise（5 答案字段）');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined, 'admit 拒收回落无失败原因（W2-06-AC3）');
});

test('108-AC5b: 非空小 stdout 仍走 L3（不回归 W2-06-AC2）', async () => {
  const { getCompleteCalls } = injectFake();
  const { ctx: c } = makeCtx();
  await shapeRaw({
    exitCode: 0, stdout: 'small ok', stderr: '', truncated: false, durationMs: 1,
    command: 'echo', cwd: '/', signal: null, timedOut: false, cancelled: false,
  }, c);
  assert.equal(getCompleteCalls(), 1, '非空小 stdout 仍走 L3');
});

// ── 注册表静态核查（枚举完整性）────────────────────────────────────────────────

test('108-注册: 六去噪工具在位（execute_cli/git_*/run_checks），git_* 无 schema', () => {
  for (const name of ['execute_cli', 'git_status', 'git_diff', 'git_log', 'git_show', 'run_checks']) {
    assert.ok(TOOL_SHAPES.has(name), `${name} 应注册`);
  }
  for (const name of ['git_status', 'git_diff', 'git_log', 'git_show']) {
    assert.equal('schema' in TOOL_SHAPES.get(name), false, `${name} 无 schema（L3 永不进入）`);
  }
});
