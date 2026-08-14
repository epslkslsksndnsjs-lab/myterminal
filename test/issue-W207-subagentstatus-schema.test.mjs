// ADR-0051 W2-07 (#90)：subagent_status 真 schema 迁移（0050 H4 + 0051 D-13 旁挂式）
//
// 验收覆盖（对应 #90 Acceptance criteria）：
//   AC1  占位 {summary:string} schema 消除——传给 L3 的 schema 与 0051 D-11 subagent_status
//        全文逐字一致（deliverables/files/blockers/conclusion）
//   AC2  completed + 自由文本 + ≤24K → L3 抽取 extracted 四字段（逐字），result 原文原样不动
//        （D-13 旁挂式；0048 D11「result 必留」+「轮询取全量结果再验收」）
//   AC2b 白名单即丢弃（D-10 原则 2）：模型输出 ghost 字段被 Q5 丢
//   AC3  超预算门（result 子字段 >24K tokens）→ fail-open passthrough，reason=over-budget
//   AC4  非 completed / result 非 string / result 缺失 → 不整形（既有 issue-45 语义保持）
//   AC5  Q5 全丢（模型幻觉）→ q5-rejected fail-open passthrough，不伪造（result 原文不动、
//        无 extracted）
//   AC6  L3 失败矩阵全路径 → passthrough 不伪造（unavailable / timeout / parse-error /
//        quota / engine-error / env 关；纯 schema 旁挂无 reduce 兜底）
//   AC7  运行时探测：actions 真实 subagent 完成后 subagent_status（fake adapter）断言
//        extracted 存在 + result 原文
//   AC8  D17 静默（各路径递归扫描无层标记）
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js）+ 注入 fake adapter
// （registry，issue-45/W2-03 手法）；运行时探测走 MyTerminalRuntime actions 通道
// （W2-03 手法）+ setRunnerDepsForTesting（m8 手法）。注：任何 src 改动后必须先
// bun run build 再跑测试（#43）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shapeToolResponse } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';
import { setRunnerDepsForTesting, resetSubagentRunner, getSubagentRunner } from '../dist/subagent/runner.js';
import { clearAllSubagents } from '../dist/subagent/store.js';
import { MyTerminalRuntime } from '../dist/server.js';

// 0051 D-11 subagent_status schema（拍板全文，逐字一致断言用）
const SUBAGENT_STATUS_SCHEMA = {
  type: 'object',
  properties: {
    deliverables: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    conclusion: { type: 'string' },
  },
};

// D17 静默契约：任何层都不插自标识标记（issue-31 手法）
const MARKER_KEYS = ['_shapedBy', '_l1Applied', '_l2Applied', '_l3Applied'];

function assertNoMarkers(value, at = 'root') {
  if (Array.isArray(value)) { for (const item of value) assertNoMarkers(item, `${at}[]`); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assertNoMarkers(item, `${at}.${key}`);
  }
}

/** 注入 fake adapter；返回 lastReq 读取器。pending → complete 永不 resolve（真超时）。throwing → complete 抛错。 */
function injectFake({ ready = true, object = null, finishReason = 'stop', pending = false, throwing = false } = {}) {
  resetL3Adapter();
  let lastReq = null;
  const adapter = {
    id: 'fake',
    supportsStructuredOutput: ready,
    isReady: async () => ready,
    complete: async (req) => {
      lastReq = req;
      if (pending) return new Promise(() => {});
      if (throwing) throw new Error('fake adapter explosion');
      return { object, finishReason, latencyMs: 1, modelId: 'fake' };
    },
  };
  registerAdapterFactory(() => adapter);
  return { getLastReq: () => lastReq };
}

function makeCtx(sessionId = 's-w207', transport = 'actions') {
  let record;
  const ctx = {
    transport,
    sessionId,
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

/** 构造 subagent_status 的完整 SubagentStatusResult（含全部内部上下文字段）。 */
function makeStatusResult({ status = 'completed', result = RICH_TEXT } = {}) {
  return {
    status,
    sessionId: 'child-1',
    tasks: [{ id: 't1', status: 'completed', description: 'do the thing' }],
    usage: { inputTokens: 100, outputTokens: 50 },
    ...(status === 'completed' && result !== undefined ? { result } : {}),
    origin: { type: 'skill', skillName: 'demo' },
    auditLogs: [{ type: 'tool_audit', tool: 'execute_cli' }],
  };
}

function shapeStatus(result, ctx) {
  return shapeToolResponse({ ok: true, data: { tool: 'subagent_status', result } }, ctx);
}

// ── fixture ──────────────────────────────────────────────────────────────────

/**
 * 自由文本 result：按行组织——D2 分支把 result 原文连同 lines（逐行拆分）传给 L3 引擎，
 * Q5 值存在性校验的锚点是 raw 的 JSON 序列化，行值作为独立数组元素带引号逐字命中
 * （自由文本内部子串无法命中）。四字段抽取值 = 四行，逐字对应。
 */
const RICH_TEXT = [
  'Refactored the parser',
  'src/tool-parse.ts',
  'waiting for review',
  'all tests pass',
].join('\n');

/** 模型逐字抽取（D-10 原则 3：Q5 verbatim）；ghost 为白名单外字段（AC2b 必丢）。 */
const L3_EXTRACTED = {
  deliverables: ['Refactored the parser'],
  files: ['src/tool-parse.ts'],
  blockers: ['waiting for review'],
  conclusion: 'all tests pass',
  ghost: 'x',
};

// ───────────────────────────────────────────────────────────
// AC1：真 schema 全文与 D-11 逐字一致（占位 {summary} 消除）
// ───────────────────────────────────────────────────────────

test('W2-07-AC1: L3 收到 D-11 真 schema（非占位 {summary}）— 与拍板全文逐字一致', async () => {
  const { getLastReq } = injectFake({ object: { conclusion: 'all tests pass' } });
  const { ctx } = makeCtx();
  await shapeStatus(makeStatusResult(), ctx);
  const req = getLastReq();
  assert.ok(req, 'fake adapter complete 被调用（路由到达 L3）');
  assert.deepEqual(req.schema, SUBAGENT_STATUS_SCHEMA, 'schema 与 0051 D-11 subagent_status 全文逐字一致（占位 {summary} 已消除）');
});

// ───────────────────────────────────────────────────────────
// AC2：completed + 自由文本 + ≤24K → extracted 四字段逐字 + result 原文不动
// ───────────────────────────────────────────────────────────

test('W2-07-AC2: L3 抽取 extracted 四字段（逐字）+ result 原文原样不动（D-13 旁挂式）', async () => {
  injectFake({ object: L3_EXTRACTED });
  const { ctx, getRecord } = makeCtx();
  const raw = makeStatusResult();
  const shaped = await shapeStatus(raw, ctx);

  // D-13 旁挂：extracted 挂上（Q5 后四字段逐字；ghost 白名单外被丢）
  assert.deepEqual(shaped.data.result.extracted, {
    deliverables: ['Refactored the parser'],
    files: ['src/tool-parse.ts'],
    blockers: ['waiting for review'],
    conclusion: 'all tests pass',
  }, 'extracted 四字段逐字保留（Q5 后）');
  // 0048 D11「result 必留」：result 原文原样不动（旁挂式不替换）
  assert.equal(shaped.data.result.result, RICH_TEXT, 'result 原文原样不动');
  // 其余内部上下文原样（避免双重整形，issue-45 AC2）
  assert.equal(shaped.data.result.status, 'completed');
  assert.equal(shaped.data.result.sessionId, 'child-1');
  assert.deepEqual(shaped.data.result.tasks, raw.tasks, 'tasks 不整形');
  assert.deepEqual(shaped.data.result.usage, raw.usage, 'usage 不整形');
  assert.deepEqual(shaped.data.result.origin, raw.origin, 'origin 不整形');
  assert.deepEqual(shaped.data.result.auditLogs, raw.auditLogs, 'auditLogs 不整形');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined, '成功无 reason');
  assertNoMarkers(shaped);
});

test('W2-07-AC2b: 白名单即丢弃（D-10 原则 2）— ghost 字段不出现', async () => {
  injectFake({ object: L3_EXTRACTED });
  const { ctx } = makeCtx();
  const shaped = await shapeStatus(makeStatusResult(), ctx);
  assert.equal('ghost' in shaped.data.result.extracted, false, '白名单外字段被 Q5 丢弃');
  assert.equal(shaped.data.result.result, RICH_TEXT, 'result 原文不动');
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC3：超预算门（>24K）→ fail-open passthrough，reason=over-budget
// ───────────────────────────────────────────────────────────

test('W2-07-AC3: 超预算门（result 子字段 >24K tokens）→ over-budget，不调模型', async () => {
  const { getLastReq } = injectFake({ object: { conclusion: 'x' } });
  const { ctx, getRecord } = makeCtx();
  const big = 'x'.repeat(120000); // 120000 拉丁 ≈30000 tokens > 24000
  const raw = makeStatusResult({ result: big });
  const shaped = await shapeStatus(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '超预算 fail-open 原样');
  assert.equal(getLastReq(), null, '超预算不调 L3 模型');
  assert.equal(getRecord().shaping.reason, 'over-budget');
});

// ───────────────────────────────────────────────────────────
// AC4：非 completed / result 非 string / 缺失 → 不整形
// ───────────────────────────────────────────────────────────

test('W2-07-AC4a: 非 completed（running）→ 不整形，passthrough', async () => {
  const { getLastReq } = injectFake({ object: { conclusion: 'x' } });
  const { ctx, getRecord } = makeCtx();
  const raw = makeStatusResult({ status: 'running' });
  const shaped = await shapeStatus(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '非 completed 原样');
  assert.equal(getLastReq(), null, '非 completed 不调 L3');
  assert.equal(getRecord().shaping.reason, 'passthrough');
});

test('W2-07-AC4b: completed 但 result 非 string（对象）→ 不整形', async () => {
  const { getLastReq } = injectFake({ object: { conclusion: 'x' } });
  const { ctx, getRecord } = makeCtx();
  const raw = { status: 'completed', result: { structured: true } };
  const shaped = await shapeStatus(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, 'result 非 string 原样');
  assert.equal(getLastReq(), null, 'result 非 string 不调 L3');
  assert.equal(getRecord().shaping.reason, 'passthrough');
});

test('W2-07-AC4c: completed 但 result 缺失 → 不整形', async () => {
  const { getLastReq } = injectFake({ object: { conclusion: 'x' } });
  const { ctx, getRecord } = makeCtx();
  const raw = { status: 'completed', sessionId: 'child-1' };
  const shaped = await shapeStatus(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '无 result 原样');
  assert.equal(getLastReq(), null, '无 result 不调 L3');
  assert.equal(getRecord().shaping.reason, 'passthrough');
});

// ───────────────────────────────────────────────────────────
// AC5：Q5 全丢（模型幻觉）→ fail-open passthrough，不伪造
// ───────────────────────────────────────────────────────────

test('W2-07-AC5: Q5 全丢（模型幻觉）→ q5-rejected fail-open，result 原文不动、无 extracted', async () => {
  const text = 'final report: all tests passed';
  // 模型抽取值全部不在 raw 文本中 → Q5 值存在性校验全丢 → 整体 fail-open
  injectFake({ object: { deliverables: ['hallucinated-deliverable'], conclusion: 'totally different hallucination' } });
  const { ctx, getRecord } = makeCtx();
  const raw = makeStatusResult({ result: text });
  const shaped = await shapeStatus(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, 'Q5 全丢 fail-open 原样（不伪造）');
  assert.equal('extracted' in shaped.data.result, false, '无 extracted');
  assert.equal(getRecord().shaping.applied, false);
  assert.equal(getRecord().shaping.reason, 'q5-rejected');
});

// ───────────────────────────────────────────────────────────
// AC6：L3 失败矩阵全路径 → passthrough 不伪造（纯 schema 旁挂无 reduce 兜底）
// ───────────────────────────────────────────────────────────

/** 失败矩阵公共断言：L3 任一失败原因 → 原样 passthrough（result 原文不动、无 extracted）。 */
async function assertFailurePassthrough({ adapter = {}, transport = 'actions', env = {}, expectedReason }) {
  const prevEnv = {};
  for (const [k, v] of Object.entries(env)) { prevEnv[k] = process.env[k]; process.env[k] = v; }
  try {
    const { getLastReq } = injectFake(adapter);
    const { ctx, getRecord } = makeCtx('s-w207', transport);
    const raw = makeStatusResult({ result: 'final report: all tests passed' });
    const shaped = await shapeStatus(raw, ctx);
    assert.strictEqual(shaped.data.result, raw, `${expectedReason}：原样 passthrough（result 原文不动）`);
    assert.equal('extracted' in shaped.data.result, false, `${expectedReason}：无 extracted（不伪造）`);
    assert.equal(getRecord().shaping.applied, false, `${expectedReason}：未整形`);
    assert.equal(getRecord().shaping.reason, expectedReason, `审计记 ${expectedReason}`);
    assertNoMarkers(shaped);
    return getLastReq;
  } finally {
    for (const [k] of Object.entries(env)) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
  }
}

test('W2-07-AC6a: 模型不可用（supportsStructuredOutput=false）→ l3-unavailable passthrough', async () => {
  await assertFailurePassthrough({ adapter: { ready: false }, expectedReason: 'l3-unavailable' });
});

test('W2-07-AC6b: 超时（actions 8s 竞速截断）→ l3-unavailable-timeout passthrough', async () => {
  await assertFailurePassthrough({ adapter: { pending: true }, transport: 'actions', expectedReason: 'l3-unavailable-timeout' });
}, { timeout: 20000 });

test('W2-07-AC6c: GBNF 失效（非合法 JSON，防御性重试后仍败）→ l3-parse-error passthrough', async () => {
  await assertFailurePassthrough({ adapter: { object: null, finishReason: 'error' }, expectedReason: 'l3-parse-error' });
});

test('W2-07-AC6d: 会话配额超限 → quota passthrough', async () => {
  await assertFailurePassthrough({ env: { MYTERMINAL_L3_MAX_PER_SESSION: '0' }, expectedReason: 'quota' });
});

test('W2-07-AC6e: 引擎自身异常 → engine-error passthrough', async () => {
  await assertFailurePassthrough({ adapter: { throwing: true }, expectedReason: 'engine-error' });
});

test('W2-07-AC6f: env 一键关 L3 → passthrough', async () => {
  await assertFailurePassthrough({ env: { MYTERMINAL_L3_ENABLED: '0' }, expectedReason: 'passthrough' });
});

// ───────────────────────────────────────────────────────────
// AC7：运行时探测 — actions 通道真实 subagent 完成 → extracted 存在 + result 原文
// ───────────────────────────────────────────────────────────

const CONNECTOR_KEY = 'w207-connector-key-123456';
const ACTIONS_TOKEN = 'w207-actions-token-1234567890123456';

/** fake runner deps（m8 手法）：runSubagentImpl 立即完成并返回固定自由文本。 */
function fakeRunnerDeps() {
  return {
    runSubagentImpl: async () => ({ status: 'completed', result: RICH_TEXT }),
    settings: { enabled: true, provider: 'openai', model: 'gpt-4o', maxTurns: 50, timeoutSec: 300, maxParallel: 2 },
    workspaceDir: '/tmp/test-workspace',
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: (parentId, args) => {
      const sid = `ses_child_${Math.random().toString(36).slice(2, 10)}`;
      return {
        session: { id: sid, name: args.name, role: 'worker', phase: 'working', presence: 'claimed', parentSessionId: parentId, task: args.task, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        identity: { sessionId: sid, sessionToken: `tok_${Math.random().toString(36).slice(2, 10)}` },
      };
    },
  };
}

async function createRuntime(dirs, overrides = {}) {
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
    async close() { await runtime.close(); },
  };
}

function actionsHeaders() { return { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' }; }

async function action(server, endpoint, body) {
  const response = await fetch(`${server.baseUrl}/actions/extensions/${endpoint}`, { method: 'POST', headers: actionsHeaders(), body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function call(server, tool, input = {}, identity) { return action(server, 'call', { tool, input, ...(identity ? { identity } : {}) }); }

async function root(server, name = 'w207-main') {
  const reg = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  return reg.body.data.result.identity;
}

test('W2-07-AC7: 运行时探测 — 真实 subagent 完成后 subagent_status（fake adapter）断言 extracted 存在 + result 原文', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  // set + get 同步相邻 → 捕获的必是本文件注入的 runner（杜绝跨文件单例竞态：
  // subagent-m8 等并行文件会替换单例，经 actions 通道的 subagent_start 可能落到他人 runner）
  setRunnerDepsForTesting(fakeRunnerDeps());
  const runner = getSubagentRunner();
  // fake L3 adapter 逐字抽取（Q5 verbatim）：值全部来自 RICH_TEXT
  const { getLastReq } = injectFake({ object: L3_EXTRACTED });

  // 真实 runner 链：start → runSubagentImpl（fake，立即完成）→ finalize → store 落 completed
  const started = runner.start('ses_parent_w207', { objective: 'probe subagent', readOnly: true });
  assert.equal(started.status, 'running');
  let st = runner.status(started.taskId);
  for (let i = 0; i < 50 && st.status !== 'completed'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    st = runner.status(started.taskId);
  }
  assert.equal(st.status, 'completed', '真实 runner 链完成');
  assert.equal(st.result, RICH_TEXT, 'runner 层 result 原文');

  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-w207-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  const dirs = { workspaceDir, stateDir };
  const server = await createRuntime(dirs);
  try {
    const identity = await root(server);
    // actions 通道 subagent_status（0048 D11：轮询取全量结果再验收；响应经真实整形管线）
    const statusResp = await call(server, 'subagent_status', { taskId: started.taskId }, identity);
    assert.equal(statusResp.status, 200, JSON.stringify(statusResp.body));
    assert.equal(statusResp.body.ok, true, JSON.stringify(statusResp.body));
    const result = statusResp.body.data.result;
    assert.equal(result.status, 'completed', '轮询拿到 completed');
    assert.equal(result.result, RICH_TEXT, 'result 原文原样不动（0048 D11 result 必留）');
    assert.deepEqual(result.extracted, {
      deliverables: ['Refactored the parser'],
      files: ['src/tool-parse.ts'],
      blockers: ['waiting for review'],
      conclusion: 'all tests pass',
    }, 'extracted 四字段存在（D-13 旁挂）');
    assert.ok(getLastReq(), 'L3 真实路径被调用（subagent_status 路由到达）');
    assertNoMarkers(result);
  } finally {
    await server.close();
    fs.rmSync(dirs.workspaceDir, { recursive: true, force: true });
  }
});

afterEach(() => {
  resetL3Adapter();
  clearL3Quota();
});
