// ADR-0051 W2-03 (#86)：git_log schema 注册（dual — reduce + schema，0050 B3 + 0051 D-11）
//
// 验收覆盖（对应 #86 Acceptance criteria）：
//   AC1  git_log 注册双条目（reduce + schema；schema 与 0051 D-11 git_log 全文逐字一致）
//   AC2  fake adapter 结构化返回 → 结果替换为 L3 输出（Q5 后），审计 applied:true
//   AC2b 真实 CommandResult raw：白名单即丢弃（D-10 原则 2）——Q5 值存在性校验要求标量值
//        带引号逐字出现在 rawText（engine.ts 启发式），stdout 未加引号文本中的 hash/subject
//        被丢、raw 字段值 exitCode/stderr 保留 → 结果替换为 {exitCode, stderr}
//   AC3  Q5 全丢 → q5-rejected 回落 L1 denoise（绝不阻断）
//   AC4  失败矩阵全路径回落 L1 denoise（unavailable / timeout / parse-error / quota /
//        engine-error / passthrough / over-budget）
//   AC5  成功态语义等价：commits[].hash/subject 与 raw 逐字对应（fixture）
//   AC6  运行时探测：actions 在临时 git 仓库真实调用 git_log（fake adapter）断言字段
//   AC7  D17 静默（各路径递归扫描无层标记）
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js）+ 注入 fake adapter
// （registry，issue-38/issue-45 手法）；运行时探测走 MyTerminalRuntime actions 通道
// （myterminal.test.mjs 手法）。注：任何 src 改动后必须先 bun run build 再跑测试（#43）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter, resetL3AdapterInstance } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';
import { MyTerminalRuntime } from '../dist/server.js';

// 0051 D-11 git_log schema（拍板全文，逐字一致断言用）
const GIT_LOG_SCHEMA = {
  type: 'object',
  properties: {
    exitCode: { type: 'number' },
    commits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          hash: { type: 'string' },
          subject: { type: 'string' },
        },
        required: ['hash', 'subject'],
      },
    },
    stderr: { type: 'string' },
  },
};

// D17 静默契约：任何层都不插自标识标记（复用 issue-31 手法）
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

function makeResponse(tool, result) {
  return { ok: true, data: { tool, result } };
}

function makeCtx(sessionId = 's-w203', transport = 'local') {
  let record;
  const ctx = {
    transport,
    sessionId,
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

// ── fixture ──────────────────────────────────────────────────────────────────

/** git_log 真实 raw：CommandResult 权威 10 字段（core-tools.ts runCommand 返回）。 */
function gitLogRaw() {
  return {
    command: 'git log --oneline -n 30', cwd: '/ws', exitCode: 0, signal: null, timedOut: false,
    stdout: 'a1b2c3d fix typo\nf6e5d4c feat: add thing', stderr: '', truncated: false, durationMs: 12, cancelled: false,
  };
}

/**
 * 语义等价 fixture：值作为 raw 字段值。Q5 值存在性校验的锚点是 raw 的 JSON 序列化
 * （JSON.stringify），字段值带引号出现在 rawText 中才能逐字命中——真实 git_log 的
 * stdout 是未加引号文本（AC2b 覆盖），故语义等价断言用本 fixture 证明「抽取值逐字保留」。
 */
function gitLogStructuredRaw() {
  return {
    exitCode: 0,
    commits: [
      { hash: 'a1b2c3d', subject: 'fix typo' },
      { hash: 'f6e5d4c', subject: 'feat: add thing' },
    ],
    stderr: '',
  };
}

// ───────────────────────────────────────────────────────────
// AC1：git_log 注册双条目（reduce + schema，D-11 全文一致）
// ───────────────────────────────────────────────────────────

test('W2-03-AC1: git_log 注册双条目 — reduce 保留 + schema 与 0051 D-11 全文一致', () => {
  const shape = TOOL_SHAPES.get('git_log');
  assert.ok(shape, 'git_log 应注册');
  assert.equal(typeof shape.reduce, 'function', 'reduce 保留（L1 回落用）');
  assert.deepEqual(shape.schema, GIT_LOG_SCHEMA, 'schema 与 D-11 git_log 全文逐字一致');
});

// ───────────────────────────────────────────────────────────
// AC2：L3 成功路径（Q5 后替换 + applied:true）
// ───────────────────────────────────────────────────────────

test('W2-03-AC2: fake adapter 结构化返回 → 结果替换为 L3 输出（Q5 后）+ applied:true', async () => {
  const { getLastReq } = injectFake({
    object: {
      exitCode: 0,
      commits: [
        { hash: 'a1b2c3d', subject: 'fix typo' },
        { hash: 'f6e5d4c', subject: 'feat: add thing' },
      ],
      stderr: '',
      ghost: 'x', // 白名单外字段（Q5 必丢）
    },
  });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_log', gitLogStructuredRaw()), ctx);

  assert.deepEqual(shaped.data.result, gitLogStructuredRaw(), 'Q5 后结果替换（白名单外 ghost 被丢）');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined, '成功无 reason');
  const req = getLastReq();
  assert.ok(req, 'fake adapter complete 被调用（路由到达 L3）');
  assert.deepEqual(req.schema, GIT_LOG_SCHEMA, 'schema 原样传入');
  assertNoMarkers(shaped);
});

test('W2-03-AC2b: 真实 CommandResult raw — 白名单即丢弃（stdout 被结构化替换，D-10 原则 2）', async () => {
  // Q5 值存在性校验：标量须带引号逐字出现在 rawText（engine.ts 启发式「对齐 ADR Q5」）。
  // 真实 git_log stdout 是未加引号文本 → 从中抽取的 hash/subject 被丢；exitCode/stderr
  // 本身是 raw 字段值 → 保留。stdout 被结构化替换是 D-10 原则 2 设计使然。
  const { getLastReq } = injectFake({
    object: { exitCode: 0, commits: [{ hash: 'a1b2c3d', subject: 'fix typo' }], stderr: '' },
  });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_log', gitLogRaw()), ctx);

  assert.deepEqual(shaped.data.result, { exitCode: 0, stderr: '' }, 'Q5 后只留 raw 字段值');
  assert.equal(getRecord().shaping.applied, true);
  assert.ok(getLastReq(), 'L3 被调用（raw 未超预算）');
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC3：Q5 全丢 → 回落 L1 denoise
// ───────────────────────────────────────────────────────────

test('W2-03-AC3: Q5 全丢（模型幻觉）→ q5-rejected 回落 L1 denoise，数据保全', async () => {
  injectFake({
    object: { exitCode: 999, commits: [{ hash: 'hallucinated-hash', subject: 'hallucinated-subject' }], stderr: 'hallucinated-stderr' },
  });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_log', gitLogRaw()), ctx);

  const r = shaped.data.result;
  assert.equal(r.exitCode, 0, '回落 L1 denoise：真实 exitCode 保留');
  assert.equal(r.stdout, 'a1b2c3d fix typo\nf6e5d4c feat: add thing', 'stdout 保留（真实数据）');
  assert.equal('command' in r, false, 'command 剥除');
  assert.equal('cwd' in r, false, 'cwd 剥除');
  assert.equal('signal' in r, false, 'signal 剥除');
  assert.equal('timedOut' in r, false, 'timedOut 剥除');
  assert.equal('cancelled' in r, false, 'cancelled 剥除');
  assert.equal(getRecord().shaping.applied, true, '回落仍整形（L1 应用）');
  assert.equal(getRecord().shaping.reason, 'q5-rejected', '审计记 L3 失败原因');
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC4：失败矩阵全路径回落 L1 denoise（绝不阻断）
// ───────────────────────────────────────────────────────────

/** 失败矩阵公共断言：L3 任一失败原因 → 回落 L1 denoise（真实数据保全，绝不阻断）。 */
async function assertFailureFallsBackToL1({ adapter = {}, transport = 'local', env = {}, expectedReason }) {
  const prevEnv = {};
  for (const [k, v] of Object.entries(env)) { prevEnv[k] = process.env[k]; process.env[k] = v; }
  try {
    const { getLastReq } = injectFake(adapter);
    const { ctx, getRecord } = makeCtx('s-w203', transport);
    const shaped = await shapeToolResponse(makeResponse('git_log', gitLogRaw()), ctx);
    const r = shaped.data.result;
    assert.equal(r.exitCode, 0, `${expectedReason}：回落 L1 后 exitCode 保留`);
    assert.equal(r.stdout, 'a1b2c3d fix typo\nf6e5d4c feat: add thing', `${expectedReason}：stdout 保留`);
    assert.equal('command' in r, false, `${expectedReason}：噪声键剥除`);
    assert.equal(getRecord().shaping.applied, true, `${expectedReason}：回落仍整形`);
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

test('W2-03-AC4a: 模型不可用（supportsStructuredOutput=false）→ l3-unavailable 回落 L1', async () => {
  await assertFailureFallsBackToL1({ adapter: { ready: false }, expectedReason: 'l3-unavailable' });
});

test('W2-03-AC4b: 超时（actions 8s 竞速截断）→ l3-unavailable-timeout 回落 L1', async () => {
  await assertFailureFallsBackToL1({ adapter: { pending: true }, transport: 'actions', expectedReason: 'l3-unavailable-timeout' });
}, { timeout: 20000 });

test('W2-03-AC4c: GBNF 失效（非合法 JSON，防御性重试后仍败）→ l3-parse-error 回落 L1', async () => {
  await assertFailureFallsBackToL1({ adapter: { object: null, finishReason: 'error' }, expectedReason: 'l3-parse-error' });
});

test('W2-03-AC4d: 会话配额超限 → quota 回落 L1', async () => {
  await assertFailureFallsBackToL1({ env: { MYTERMINAL_L3_MAX_PER_SESSION: '0' }, expectedReason: 'quota' });
});

test('W2-03-AC4e: 引擎自身异常 → engine-error 回落 L1', async () => {
  await assertFailureFallsBackToL1({ adapter: { throwing: true }, expectedReason: 'engine-error' });
});

test('W2-03-AC4f: env 一键关 L3 → passthrough 回落 L1', async () => {
  await assertFailureFallsBackToL1({ env: { MYTERMINAL_L3_ENABLED: '0' }, expectedReason: 'passthrough' });
});

test('W2-03-AC4g: 超预算门（>24K tokens）→ over-budget 回落 L1（不调模型）', async () => {
  const big = { ...gitLogRaw(), stdout: 'x'.repeat(120000) }; // 120000 拉丁 ≈30000 tokens > 24000
  const { getLastReq } = injectFake({ object: { exitCode: 0, stderr: '' } });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_log', big), ctx);
  const r = shaped.data.result;
  assert.equal(r.exitCode, 0, 'over-budget：回落 L1 后 exitCode 保留');
  assert.equal('command' in r, false, 'over-budget：噪声键剥除');
  assert.equal(getLastReq(), null, 'over-budget：预算门拦截，不调模型');
  assert.equal(getRecord().shaping.applied, true, 'over-budget：回落仍整形');
  assert.equal(getRecord().shaping.reason, 'over-budget');
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC5：成功态语义等价（commits[].hash/subject 与 raw 逐字对应）
// ───────────────────────────────────────────────────────────

test('W2-03-AC5: 成功态语义等价 — L3 输出与 raw 逐字对应（fixture）', async () => {
  const raw = gitLogStructuredRaw();
  injectFake({ object: raw }); // 模型逐字抽取（D-10 原则 3：Q5 verbatim）
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_log', raw), ctx);

  assert.deepEqual(shaped.data.result, raw, 'commits[].hash/subject 与 raw 逐字对应，零增删改');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined);
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC6：运行时探测 — actions 通道真实调用 git_log（临时 git 仓库）
// ───────────────────────────────────────────────────────────

const CONNECTOR_KEY = 'w203-connector-key-123456';
const ACTIONS_TOKEN = 'w203-actions-token-1234567890123456';

function tempGitWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-w203-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  // 真实 git 仓库：一个提交；git_log 输出形如 `HASH probe commit`
  execFileSync('git', ['init', '-b', 'main'], { cwd: workspaceDir });
  execFileSync('git', ['config', 'user.email', 'probe@test'], { cwd: workspaceDir });
  execFileSync('git', ['config', 'user.name', 'probe'], { cwd: workspaceDir });
  fs.writeFileSync(path.join(workspaceDir, 'a.txt'), 'x');
  execFileSync('git', ['add', 'a.txt'], { cwd: workspaceDir });
  execFileSync('git', ['commit', '-m', 'probe commit'], { cwd: workspaceDir });
  return { workspaceDir, stateDir };
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

async function root(server, name = 'w203-main') {
  const reg = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  return reg.body.data.result.identity;
}

test('W2-03-AC6: 运行时探测 — 真实 git_log 调用（fake adapter 幻觉 → Q5 全丢）回落 L1，数据保全', async () => {
  const dirs = tempGitWorkspace();
  // fake adapter 返回全幻觉值 → Q5 全丢 → q5-rejected → 回落 L1 denoise（真实 git_log
  // stdout 为未加引号文本，L3 抽取值无法逐字命中 rawText，回落是真实路径上的保底）
  const { getLastReq } = injectFake({ object: { exitCode: 987654321, commits: [{ hash: 'hallucinated-hash-qqq', subject: 'hallucinated-subject-qqq' }], stderr: 'hallucinated-stderr-zzz' } });
  const server = await createRuntime(dirs);
  try {
    const identity = await root(server);
    const resp = await call(server, 'git_log', {}, identity);
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    assert.equal(resp.body.ok, true, JSON.stringify(resp.body));

    const result = resp.body.data.result;
    assert.equal(result.exitCode, 0, '回落 L1：exitCode 保留');
    assert.ok(result.stdout.includes('probe commit'), 'stdout 保留真实提交数据');
    assert.equal('command' in result, false, '噪声键剥除');
    assert.ok(getLastReq(), 'L3 真实路径被调用（dual 路由到达，未超预算）');
    assertNoMarkers(result);
  } finally {
    await server.close();
    fs.rmSync(dirs.workspaceDir, { recursive: true, force: true });
  }
});

afterEach(() => {
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）
  clearL3Quota();
});
