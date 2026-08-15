// ADR-0051 W2-06 (#89)：execute_cli schema 注册（dual，0050 B3 + 0051 D-11 8K/96K 边界）
//
// 验收断言：
//   AC1  注册双条目：reduce + schema 与 D-11 全文逐字段一致（grep/deepEqual 双验证）
//   AC2  stdout ≤8K 字符 → 走 L3（fake adapter 被调用；结构化替换生效）
//   AC3  8K < stdout ≤ 96K → 回落 L1 denoise（不调 L3；噪声剥除、stdout 原样）
//   AC4  stdout > 96K → 预算门（≈24K tokens）挡掉 → 回落 L1 denoise（reason=over-budget）
//   AC5  Q5 全丢（模型幻觉字段）→ q5-rejected 回落 L1 denoise（绝不 passthrough 原样）
//   AC6  失败矩阵全路径回落 L1：l3-unavailable / timeout / quota / engine-error（绝不阻断）
//   AC7  成功态语义等价：exitCode/stdout/stderr/truncated/durationMs 与 raw 逐字对应（fixture）
//   AC8  D17 静默：L3 成功态与回落态结果内均无层标记（递归扫描）
//   AC9  运行时探测：actions 真实 execute_cli（小输出）+ fake adapter 断言五字段
//   AC10 纯 schema 条目失败 → passthrough（D-4 语义不回归；resolveShape 改序护栏）
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js，遵循 issue-31 seam）；
// fake adapter 注入走 registry（遵循 issue-44 手法）；运行时探测走 MyTerminalRuntime
// actions 通道（遵循 myterminal.test.mjs / issue-W107 手法）。
// 注：任何 src 改动后必须先 bun run build 再跑测试（测试全部从 dist 导入，历史教训见 #43）。

import { test, afterEach, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// #101（ADR-0051 增补-02）：关预热——AC9 运行时探测注入 fake adapter，server.start 后台
// 异步预热会经 getL3Adapter 拿同一单例跑 smoke probe，挤占 complete 计数（单跑必败 12/1）。
// 生产默认（不设旋钮）预热全开不变；本文件为运行时探测类测试，显式关预热。
process.env.MYTERMINAL_L3_WARMUP = 'false';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter, resetL3AdapterInstance } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';
import { MyTerminalRuntime } from '../dist/server.js';

// D-11 execute_cli schema 全文（0051 拍板；逐字对照 docs/adr/0051 D-11）
const D11_EXECUTE_CLI_SCHEMA = {
  type: 'object',
  properties: {
    exitCode: { type: 'number' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    truncated: { type: 'boolean' },
    durationMs: { type: 'number' },
  },
};

const COMMAND_RESULT_NOISE = ['command', 'cwd', 'signal', 'timedOut', 'cancelled'];

// D17 静默契约：任何层都不插自标识标记（复用 issue-31 手法）
const MARKER_KEYS = ['_shapedBy', '_l1Applied', '_l2Applied', '_l3Applied'];

function assertNoShapingMarkers(value, at = 'root') {
  if (Array.isArray(value)) { for (const item of value) assertNoShapingMarkers(item, `${at}[]`); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assertNoShapingMarkers(item, `${at}.${key}`);
  }
}

/** 模拟 execute_cli 原始 CommandResult（core-tools.ts 真实形状：五噪声键 + 五 schema 键）。 */
function makeExecCliResult(stdout, overrides = {}) {
  return {
    command: 'echo probe',
    cwd: '/tmp',
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: '',
    truncated: false,
    durationMs: 12,
    cancelled: false,
    ...overrides,
  };
}

/**
 * 注入 fake adapter。`responses` 按调用次序消费（耗尽后复用最后一个）。
 * 不传 responses → 默认成功返回 { name: 'alice' }（常规单元路径）。
 * `echoFromInstruction` → 从 instruction 中解析 raw JSON（buildInstruction 首行后即为
 * JSON.stringify(rawResult)），把 D-11 五字段逐字回显——运行时探测用（Q5 值存在性必过）。
 */
function injectFake({ ready = true, responses = [], throwOnComplete = false, echoFromInstruction = false } = {}) {
  resetL3Adapter();
  let lastReq = null;
  let completeCalls = 0;
  const adapter = {
    id: 'fake',
    supportsStructuredOutput: ready,
    isReady: async () => ready,
    complete: async (req) => {
      lastReq = req;
      completeCalls++;
      if (throwOnComplete) throw new Error('engine boom');
      if (echoFromInstruction) {
        const rawJson = req.instruction.split('\n')[1]; // '原始返回（RAW）：' 的下一行
        const raw = JSON.parse(rawJson);
        return {
          latencyMs: 1, modelId: 'fake',
          object: {
            exitCode: raw.exitCode,
            stdout: raw.stdout,
            stderr: raw.stderr,
            truncated: raw.truncated,
            durationMs: raw.durationMs,
          },
          finishReason: 'stop',
        };
      }
      const r = responses.length
        ? responses[Math.min(completeCalls - 1, responses.length - 1)]
        : { object: { name: 'alice' }, finishReason: 'stop' };
      return { latencyMs: 1, modelId: 'fake', ...r };
    },
  };
  registerAdapterFactory(() => adapter);
  return { adapter, getLastReq: () => lastReq, getCompleteCalls: () => completeCalls };
}

function makeCtx(sessionId = 's-206', transport = 'actions') {
  let record;
  const ctx = {
    transport,
    sessionId,
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

function shapeRaw(result, ctx) {
  return shapeToolResponse({ ok: true, data: { tool: 'execute_cli', result } }, ctx);
}

afterEach(() => {
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入；injectFake 前置全清保文件内隔离）
  clearL3Quota();
});

// #101：文件结束恢复 env（bun 共享 worker 下 process.env 跨文件可见，防止 false 泄漏到
// 依赖预热默认开的文件——W208 等；生产默认不变）
afterAll(() => {
  delete process.env.MYTERMINAL_L3_WARMUP;
});

// ───────────────────────────────────────────────────────────
// AC1：注册双条目 — reduce + schema 与 D-11 全文一致
// ───────────────────────────────────────────────────────────

test('W2-06-AC1: execute_cli 双条目 — reduce + schema 与 D-11 全文一致', () => {
  const entry = TOOL_SHAPES.get('execute_cli');
  assert.ok(entry, 'execute_cli 在 TOOL_SHAPES');
  assert.equal(typeof entry.reduce, 'function', 'reduce 存在（L1 denoise 兜底）');
  assert.deepEqual(entry.schema, D11_EXECUTE_CLI_SCHEMA, 'schema 与 D-11 全文逐字段一致');
  assert.equal(typeof entry.admitL3, 'function', 'L3 准入边界（stdout ≤8K）存在');
});

// ───────────────────────────────────────────────────────────
// AC2：stdout ≤8K 字符 → L3
// ───────────────────────────────────────────────────────────

test('W2-06-AC2: stdout 7K（≤8K）→ L3（fake adapter 被调用，结构化替换）', async () => {
  const raw = makeExecCliResult('y'.repeat(7_000));
  const { getCompleteCalls } = injectFake({
    responses: [{ object: { exitCode: 0, stdout: raw.stdout, stderr: '', truncated: false, durationMs: 12 }, finishReason: 'stop' }],
  });
  const { ctx } = makeCtx();
  const shaped = await shapeRaw(raw, ctx);
  assert.equal(getCompleteCalls(), 1, 'L3 adapter 被调用（7K ≤ 8K 准入）');
  assert.deepEqual(shaped.data.result, {
    exitCode: 0, stdout: raw.stdout, stderr: '', truncated: false, durationMs: 12,
  }, 'L3 结构化结果替换 data.result');
});

// ───────────────────────────────────────────────────────────
// AC3：8K < stdout ≤ 96K → 回落 L1 denoise
// ───────────────────────────────────────────────────────────

test('W2-06-AC3: stdout 9K（8K~96K）→ 回落 L1 denoise（不调 L3，噪声剥除）', async () => {
  const raw = makeExecCliResult('z'.repeat(9_000));
  const { getCompleteCalls } = injectFake();
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRaw(raw, ctx);
  assert.equal(getCompleteCalls(), 0, 'L3 未被调用（9K 击穿 8K 准入上限）');
  assert.equal(shaped.data.result.stdout, raw.stdout, 'stdout 原样保留（denoise 不截内容）');
  assert.equal(shaped.data.result.exitCode, raw.exitCode, 'exitCode 保留');
  for (const k of COMMAND_RESULT_NOISE) {
    assert.equal(k in shaped.data.result, false, `${k} 被剥除`);
  }
  const rec = getRecord();
  assert.equal(rec.shaping.applied, true, '回落发生则 applied:true');
  assert.equal(rec.shaping.reason, undefined, '准入回落是正常 L1 结果，无失败原因');
});

// ───────────────────────────────────────────────────────────
// AC4：stdout > 96K → 预算门挡掉 → 回落 L1 denoise
// ───────────────────────────────────────────────────────────

test('W2-06-AC4: stdout 100K（>96K）→ 预算门（≈24K tokens）挡掉 → 回落 L1 denoise（over-budget）', async () => {
  const raw = makeExecCliResult('x'.repeat(100_000));
  const { getCompleteCalls } = injectFake();
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRaw(raw, ctx);
  assert.equal(getCompleteCalls(), 0, '不调模型（预算门直接挡掉）');
  assert.equal(shaped.data.result.stdout, raw.stdout, 'stdout 原样（denoise 不截内容）');
  assert.equal('command' in shaped.data.result, false, '噪声剥除');
  const rec = getRecord();
  assert.equal(rec.shaping.applied, true, '回落发生则 applied:true');
  assert.equal(rec.shaping.reason, 'over-budget', '预算门路径 reason=over-budget');
});

// ───────────────────────────────────────────────────────────
// AC5：Q5 全丢 → q5-rejected 回落 L1 denoise
// ───────────────────────────────────────────────────────────

test('W2-06-AC5: Q5 全丢（模型幻觉字段）→ q5-rejected 回落 L1 denoise', async () => {
  const raw = makeExecCliResult('ok');
  const { getCompleteCalls } = injectFake({ responses: [{ object: { bogus: 'hallucinated' }, finishReason: 'stop' }] });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRaw(raw, ctx);
  assert.equal(getCompleteCalls(), 1, 'L3 被调用（小 stdout）');
  assert.equal(shaped.data.result.stdout, raw.stdout, '回落 L1 denoise：stdout 保留');
  assert.equal('command' in shaped.data.result, false, '回落 L1 denoise：噪声剥除');
  const rec = getRecord();
  assert.equal(rec.shaping.applied, true, '回落发生则 applied:true');
  assert.equal(rec.shaping.reason, 'q5-rejected', '失败矩阵 reason 保留');
});

// ───────────────────────────────────────────────────────────
// AC6：失败矩阵全路径回落 L1（绝不阻断）
// ───────────────────────────────────────────────────────────

test('W2-06-AC6a: L3 不可用（supportsStructuredOutput=false）→ 回落 L1 denoise', async () => {
  const raw = makeExecCliResult('ok');
  injectFake({ ready: false });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRaw(raw, ctx);
  assert.equal(shaped.data.result.stdout, raw.stdout, '回落 L1 denoise');
  assert.equal('command' in shaped.data.result, false, '噪声剥除');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable');
});

test('W2-06-AC6b: L3 超时（finishReason=timeout）→ 回落 L1 denoise', async () => {
  const raw = makeExecCliResult('ok');
  injectFake({ responses: [{ object: null, finishReason: 'timeout' }] });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRaw(raw, ctx);
  assert.equal(shaped.data.result.stdout, raw.stdout, '回落 L1 denoise');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable-timeout');
});

test('W2-06-AC6c: 会话配额烧穿 → 回落 L1 denoise', async () => {
  const raw = makeExecCliResult('ok');
  injectFake();
  // 默认 50 次/会话：先烧穿，第 51 次 → quota → 回落 L1
  const { ctx } = makeCtx('s-206-quota');
  for (let i = 0; i < 50; i++) await shapeRaw(raw, ctx);
  const { ctx: ctx51, getRecord } = makeCtx('s-206-quota');
  const shaped = await shapeRaw(raw, ctx51);
  assert.equal(shaped.data.result.stdout, raw.stdout, '回落 L1 denoise');
  assert.equal('command' in shaped.data.result, false, '噪声剥除');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, 'quota');
});

test('W2-06-AC6d: 引擎自身异常 → 回落 L1 denoise（绝不阻断）', async () => {
  const raw = makeExecCliResult('ok');
  injectFake({ throwOnComplete: true });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRaw(raw, ctx);
  assert.equal(shaped.data.result.stdout, raw.stdout, '回落 L1 denoise');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, 'engine-error');
});

// ───────────────────────────────────────────────────────────
// AC7：成功态语义等价 — 五字段与 raw 逐字对应（fixture）
// ───────────────────────────────────────────────────────────

test('W2-06-AC7: 成功态语义等价 — exitCode/stdout/stderr/truncated/durationMs 逐字对应 raw', async () => {
  const raw = makeExecCliResult('line1\nline2\n', {
    exitCode: 2,
    stderr: 'warn: something on stderr\n',
    truncated: true,
    durationMs: 345,
  });
  const { getCompleteCalls } = injectFake({
    responses: [{
      object: {
        exitCode: 2,
        stdout: 'line1\nline2\n',
        stderr: 'warn: something on stderr\n',
        truncated: true,
        durationMs: 345,
      },
      finishReason: 'stop',
    }],
  });
  const { ctx } = makeCtx();
  const shaped = await shapeRaw(raw, ctx);
  assert.equal(getCompleteCalls(), 1, 'L3 被调用');
  assert.deepEqual(shaped.data.result, {
    exitCode: 2,
    stdout: 'line1\nline2\n',
    stderr: 'warn: something on stderr\n',
    truncated: true,
    durationMs: 345,
  }, 'L3 提取与 raw 逐字对应（Q5 verbatim）');
});

// ───────────────────────────────────────────────────────────
// AC8：D17 静默 — L3 成功态与回落态均无层标记
// ───────────────────────────────────────────────────────────

test('W2-06-AC8: D17 静默 — L3 成功 / 预算门回落 / Q5 回落 结果内均无层标记', async () => {
  // L3 成功态
  const raw1 = makeExecCliResult('small ok');
  injectFake({ responses: [{ object: { exitCode: 0, stdout: 'small ok', stderr: '', truncated: false, durationMs: 12 }, finishReason: 'stop' }] });
  const { ctx } = makeCtx();
  const shaped1 = await shapeRaw(raw1, ctx);
  assertNoShapingMarkers(shaped1);

  // 预算门回落（100K）
  const raw2 = makeExecCliResult('x'.repeat(100_000));
  const shaped2 = await shapeRaw(raw2, ctx);
  assertNoShapingMarkers(shaped2);

  // Q5 回落
  const raw3 = makeExecCliResult('ok');
  const shaped3 = await shapeRaw(raw3, ctx);
  assertNoShapingMarkers(shaped3);
});

// ───────────────────────────────────────────────────────────
// AC10：纯 schema 条目失败 → passthrough（D-4 语义不回归；resolveShape 改序护栏）
// ───────────────────────────────────────────────────────────

test('W2-06-AC10: 纯 schema 条目失败 → passthrough（非 dual 语义不回归）', async () => {
  TOOL_SHAPES.set('w206_probe', { schema: D11_EXECUTE_CLI_SCHEMA });
  try {
    injectFake({ ready: false });
    const { ctx, getRecord } = makeCtx();
    const raw = makeExecCliResult('ok');
    const shaped = await shapeToolResponse({ ok: true, data: { tool: 'w206_probe', result: raw } }, ctx);
    assert.strictEqual(shaped.data.result, raw, '纯 schema 失败 → 原样 passthrough（不套 denoise）');
    assert.equal(getRecord().shaping.applied, false);
    assert.equal(getRecord().shaping.reason, 'l3-unavailable');
  } finally {
    TOOL_SHAPES.delete('w206_probe');
  }
});

// ───────────────────────────────────────────────────────────
// AC9：运行时探测 — actions 真实 execute_cli（小输出）+ fake adapter 断言字段
// ───────────────────────────────────────────────────────────

const CONNECTOR_KEY = 'w206-connector-key-123456';
const ACTIONS_TOKEN = 'w206-actions-token-1234567890123456';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-w206-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  return { workspaceDir, stateDir };
}

async function createRuntime(overrides = {}) {
  const dirs = tempWorkspace();
  const runtime = new MyTerminalRuntime({
    ...dirs,
    settingsPath: path.join(dirs.stateDir, 'test-settings.json'),
    host: '127.0.0.1', port: 0,
    connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN,
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 20_000, commandTimeoutSec: 10,
    uiLanguage: 'zh-CN', uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    ...overrides,
  });
  await runtime.start();
  return {
    runtime, dirs,
    baseUrl: `http://127.0.0.1:${runtime.port}`,
    async close() { await runtime.close(); fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); },
  };
}

function actionsHeaders() { return { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' }; }

async function action(server, endpoint, body) {
  const response = await fetch(`${server.baseUrl}/actions/extensions/${endpoint}`, { method: 'POST', headers: actionsHeaders(), body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function call(server, tool, input = {}, identity) { return action(server, 'call', { tool, input, ...(identity ? { identity } : {}) }); }

async function root(server, name = 'w206-main') {
  const reg = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  return reg.body.data.result.identity;
}

test('W2-06-AC9: 运行时探测 — actions 真实 execute_cli（小输出）经 L3 结构化后断言字段', async () => {
  // fake adapter 逐字回显 raw 的 D-11 五字段（Q5 值存在性必过）
  const { getCompleteCalls } = injectFake({ echoFromInstruction: true });
  const server = await createRuntime();
  try {
    const identity = await root(server);
    const res = await call(server, 'execute_cli', { command: 'echo hello-w206' }, identity);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    assert.equal(getCompleteCalls(), 1, 'L3 adapter 被调用（小输出准入 → 真走 L3，非 L1 兜底）');
    const result = res.body.data.result;
    assert.equal(typeof result.exitCode, 'number', 'exitCode 为数字');
    assert.equal(typeof result.stdout, 'string', 'stdout 为字符串');
    assert.ok(result.stdout.includes('hello-w206'), `stdout 为真实回显（含 hello-w206，实际 ${JSON.stringify(result.stdout)}）`);
    assert.equal(typeof result.stderr, 'string', 'stderr 为字符串');
    assert.equal(typeof result.truncated, 'boolean', 'truncated 为布尔');
    assert.equal(typeof result.durationMs, 'number', 'durationMs 为数字');
    // 噪声键不回显（L3 提取走 schema 白名单）
    for (const k of COMMAND_RESULT_NOISE) {
      assert.equal(k in result, false, `${k} 不在 L3 提取结果`);
    }
    assertNoShapingMarkers(res.body);
  } finally {
    await server.close();
  }
});
