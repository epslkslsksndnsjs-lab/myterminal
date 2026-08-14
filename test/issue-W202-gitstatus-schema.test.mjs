// ADR-0051 W2-02 (#85)：git_status schema 注册（dual，0050 B3 + 0051 D-11）
//
// 验收断言（D-10 schema 五原则 + D-11 git_status 全文）：
//   AC1  git_status 注册双条目（reduce 保留 + schema 与 0051 D-11 全文逐字一致）
//   AC2  fake adapter 结构化返回 → 结果替换为 L3 输出（Q5 后：白名单外字段丢），
//        审计 applied:true；schema 原样传入 adapter
//   AC2b 真实 CommandResult raw（stdout 未加引号）→ 白名单即丢弃（D-10 原则 2）：
//        stdout 被结构化替换是设计使然；仅 raw 字段值（exitCode/stderr）逐字存活
//   AC3  Q5 全丢（模型幻觉）→ q5-rejected → 回落 L1 denoise，数据保全（exitCode/
//        stdout/stderr 保留，噪声键剥除），审计 reason=q5-rejected
//   AC4  失败矩阵回落 L1 denoise：L3 不可用（reason=l3-unavailable）/ 配额烧穿
//        （reason=quota）/ 超时（reason=l3-unavailable-timeout）
//   AC5  成功态语义等价：branch/changes/untracked 与 raw 逐字对应（fixture 深等于，
//        D-10 原则 3 Q5 verbatim + 原则 5 语义等价）
//   AC6  运行时探测：actions 通道在临时 git 仓库真实调用 git_status（fake adapter
//        注入）断言 L3 路由到达 + 回落保底数据保全
//   D17  全路径无层标记（递归扫描）
//
// 测试方式：单测直接驱动 shapeToolResponse（dist/tool-parse.js，issue-31 seam）+ 注入
// fake adapter（dist/l3/registry.js，issue-38 手法）；运行时探测走 MyTerminalRuntime
// actions 通道（dist/server.js）。注：任何 src 改动后必须先 bun run build 再跑测试。

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

// D-11 git_status schema 全文（0051 拍板；测试侧逐字参考，实现侧必须与之深等）
const GIT_STATUS_SCHEMA = {
  type: 'object',
  properties: {
    exitCode: { type: 'number' },
    branch: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['path', 'status'],
      },
    },
    untracked: { type: 'array', items: { type: 'string' } },
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

/** 注入 fake adapter（成功/不可用/失败矩阵由 object/ready 控制），带调用计数 + 末次请求。 */
function injectFake({ ready = true, object = { exitCode: 0 }, finishReason = 'stop' } = {}) {
  resetL3Adapter(); // 清旧单例，让本次 factory 在下次懒加载生效（单例常驻语义）
  let calls = 0;
  let lastReq;
  const adapter = {
    id: 'fake',
    supportsStructuredOutput: ready,
    isReady: async () => ready,
    complete: async (req) => {
      calls += 1;
      lastReq = req;
      return { object, finishReason, latencyMs: 1, modelId: 'fake' };
    },
  };
  registerAdapterFactory(() => adapter);
  return { adapter, callCount: () => calls, getLastReq: () => lastReq };
}

function makeResponse(tool, result) {
  return { ok: true, data: { tool, result } };
}

function makeCtx(sessionId = 's-w202', transport = 'actions') {
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

/** git_status 真实 raw：CommandResult 权威 10 字段（core-tools.ts runCommand 返回）。 */
function gitStatusRaw() {
  return {
    command: 'git status --short --branch', cwd: '/ws', exitCode: 0, signal: null, timedOut: false,
    stdout: '## main\n M modified.txt\n?? new.txt', stderr: '', truncated: false, durationMs: 12, cancelled: false,
  };
}

/**
 * 语义等价 fixture：值作为 raw 字段值。Q5 值存在性校验的锚点是 raw 的 JSON 序列化
 * （JSON.stringify），字段值带引号出现在 rawText 中才能逐字命中——真实 git_status 的
 * stdout 是未加引号文本（AC2b 覆盖），故语义等价断言用本 fixture 证明「抽取值逐字保留」。
 */
function gitStatusStructuredRaw() {
  return {
    exitCode: 0,
    branch: 'main',
    changes: [{ path: 'modified.txt', status: 'M' }],
    untracked: ['new.txt'],
    stderr: '',
  };
}

// ───────────────────────────────────────────────────────────
// AC1：git_status 注册双条目（reduce + schema，D-11 全文一致）
// ───────────────────────────────────────────────────────────

test('W2-02-AC1: git_status 注册双条目 — reduce 保留 + schema 与 0051 D-11 全文一致', () => {
  const shape = TOOL_SHAPES.get('git_status');
  assert.ok(shape, 'git_status 应注册');
  assert.equal(typeof shape.reduce, 'function', 'reduce 保留（L1 回落用）');
  assert.deepEqual(shape.schema, GIT_STATUS_SCHEMA, 'schema 与 D-11 git_status 全文逐字一致');
});

// ───────────────────────────────────────────────────────────
// AC2：L3 成功路径（Q5 后替换 + applied:true）
// ───────────────────────────────────────────────────────────

test('W2-02-AC2: fake adapter 结构化返回 → 结果替换为 L3 输出（Q5 后）+ applied:true', async () => {
  const { getLastReq } = injectFake({
    object: {
      exitCode: 0,
      branch: 'main',
      changes: [{ path: 'modified.txt', status: 'M' }],
      untracked: ['new.txt'],
      stderr: '',
      ghost: 'x', // 白名单外字段（Q5 必丢，D-10 原则 2）
    },
  });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_status', gitStatusStructuredRaw()), ctx);

  assert.deepEqual(shaped.data.result, gitStatusStructuredRaw(), 'Q5 后结果替换（白名单外 ghost 被丢）');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined, '成功无 reason');
  const req = getLastReq();
  assert.ok(req, 'fake adapter complete 被调用（路由到达 L3）');
  assert.deepEqual(req.schema, GIT_STATUS_SCHEMA, 'schema 原样传入');
  assertNoMarkers(shaped);
});

test('W2-02-AC2b: 真实 CommandResult raw — 白名单即丢弃（stdout 被结构化替换，D-10 原则 2）', async () => {
  // Q5 值存在性校验：标量须带引号逐字出现在 rawText（engine.ts 启发式「对齐 ADR Q5」）。
  // 真实 git_status stdout 是未加引号文本 → 从中抽取的 branch/changes/untracked 被丢；
  // exitCode/stderr 本身是 raw 字段值 → 保留。stdout 被结构化替换是 D-10 原则 2 设计使然。
  const { getLastReq } = injectFake({
    object: { exitCode: 0, branch: 'main', changes: [{ path: 'modified.txt', status: 'M' }], untracked: ['new.txt'], stderr: '' },
  });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_status', gitStatusRaw()), ctx);

  assert.deepEqual(shaped.data.result, { exitCode: 0, stderr: '' }, 'Q5 后只留 raw 字段值');
  assert.equal(getRecord().shaping.applied, true);
  assert.ok(getLastReq(), 'L3 被调用（raw 未超预算）');
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC3：Q5 全丢 → 回落 L1 denoise
// ───────────────────────────────────────────────────────────

test('W2-02-AC3: Q5 全丢（模型幻觉）→ q5-rejected 回落 L1 denoise，数据保全', async () => {
  injectFake({
    object: { exitCode: 987654321, branch: 'hallucinated-branch', changes: [{ path: 'hallucinated-path', status: 'hallucinated-status' }], untracked: ['hallucinated-untracked'], stderr: 'hallucinated-stderr' },
  });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_status', gitStatusRaw()), ctx);

  const r = shaped.data.result;
  assert.equal(r.exitCode, 0, '回落 L1 denoise：真实 exitCode 保留');
  assert.equal(r.stdout, '## main\n M modified.txt\n?? new.txt', 'stdout 保留（真实数据）');
  assert.equal(r.stderr, '', 'stderr 保留');
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
// AC4：失败矩阵回落 L1 denoise
// ───────────────────────────────────────────────────────────

test('W2-02-AC4a: L3 不可用（supportsStructuredOutput=false）→ 回落 L1 denoise，reason=l3-unavailable', async () => {
  const { callCount } = injectFake({ ready: false });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_status', gitStatusRaw()), ctx);

  assert.equal(callCount(), 0, '不可用不调模型');
  const r = shaped.data.result;
  assert.equal(r.exitCode, 0, '回落 L1 denoise：真实数据保留');
  assert.equal(r.stdout, '## main\n M modified.txt\n?? new.txt', 'stdout 保留');
  assert.equal('command' in r, false, '噪声键剥除');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable', '审计 reason=l3-unavailable');
});

test('W2-02-AC4b: L3 配额烧穿 → 回落 L1 denoise，reason=quota', async () => {
  const prev = process.env.MYTERMINAL_L3_MAX_PER_SESSION;
  process.env.MYTERMINAL_L3_MAX_PER_SESSION = '0'; // 0 次配额 → 首调即烧穿
  try {
    const { callCount } = injectFake();
    const { ctx, getRecord } = makeCtx();
    const shaped = await shapeToolResponse(makeResponse('git_status', gitStatusRaw()), ctx);

    assert.equal(callCount(), 0, '配额烧穿不调模型');
    const r = shaped.data.result;
    assert.equal(r.exitCode, 0, '回落 L1 denoise：真实数据保留');
    assert.equal(r.stdout, '## main\n M modified.txt\n?? new.txt', 'stdout 保留');
    assert.equal('command' in r, false, '噪声键剥除');
    assert.equal(getRecord().shaping.applied, true);
    assert.equal(getRecord().shaping.reason, 'quota', '审计 reason=quota');
  } finally {
    if (prev === undefined) delete process.env.MYTERMINAL_L3_MAX_PER_SESSION;
    else process.env.MYTERMINAL_L3_MAX_PER_SESSION = prev;
  }
});

test('W2-02-AC4c: L3 超时（finishReason=timeout）→ 回落 L1 denoise，reason=l3-unavailable-timeout', async () => {
  const { callCount } = injectFake({ object: null, finishReason: 'timeout' });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_status', gitStatusRaw()), ctx);

  assert.equal(callCount(), 1, 'L3 仅尝试 1 次');
  const r = shaped.data.result;
  assert.equal(r.exitCode, 0, '回落 L1 denoise：真实数据保留');
  assert.equal(r.stdout, '## main\n M modified.txt\n?? new.txt', 'stdout 保留');
  assert.equal('command' in r, false, '噪声键剥除');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable-timeout', '审计 reason=l3-unavailable-timeout');
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC5：成功态语义等价（fixture，D-10 原则 3/5）
// ───────────────────────────────────────────────────────────

test('W2-02-AC5: 成功态语义等价 — branch/changes/untracked 与 raw 逐字对应（fixture）', async () => {
  const raw = gitStatusStructuredRaw();
  injectFake({ object: raw }); // 模型逐字抽取（D-10 原则 3：Q5 verbatim）
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_status', raw), ctx);

  assert.deepEqual(shaped.data.result, raw, 'branch/changes/untracked 与 raw 逐字对应，零增删改（语义等价）');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined);
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC6：运行时探测 — actions 通道真实调用 git_status
// ───────────────────────────────────────────────────────────

const CONNECTOR_KEY = 'w202-connector-key-123456';
const ACTIONS_TOKEN = 'w202-actions-token-1234567890123456';

function tempGitWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-w202-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  // 真实 git 仓库：一个提交 + 一个未跟踪文件；git status --short --branch 输出
  // `## main\n M a.txt\n?? new.txt` 形（未加引号文本）
  execFileSync('git', ['init', '-b', 'main'], { cwd: workspaceDir });
  execFileSync('git', ['config', 'user.email', 'probe@test'], { cwd: workspaceDir });
  execFileSync('git', ['config', 'user.name', 'probe'], { cwd: workspaceDir });
  fs.writeFileSync(path.join(workspaceDir, 'a.txt'), 'x');
  execFileSync('git', ['add', 'a.txt'], { cwd: workspaceDir });
  execFileSync('git', ['commit', '-m', 'probe commit'], { cwd: workspaceDir });
  fs.writeFileSync(path.join(workspaceDir, 'a.txt'), 'y'); // 修改 → M a.txt
  fs.writeFileSync(path.join(workspaceDir, 'new.txt'), 'z'); // 未跟踪 → ?? new.txt
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

async function root(server, name = 'w202-main') {
  const reg = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  return reg.body.data.result.identity;
}

test('W2-02-AC6: 运行时探测 — 真实 git_status 调用（fake adapter 幻觉 → Q5 全丢）回落 L1，数据保全', async () => {
  const dirs = tempGitWorkspace();
  // fake adapter 返回全幻觉值 → Q5 全丢 → q5-rejected → 回落 L1 denoise（真实 git_status
  // stdout 为未加引号文本，L3 抽取值无法逐字命中 rawText，回落是真实路径上的保底）
  const { getLastReq } = injectFake({ object: { exitCode: 987654321, branch: 'hallucinated-branch', changes: [{ path: 'hallucinated-path', status: 'hallucinated-status' }], untracked: ['hallucinated-untracked'], stderr: 'hallucinated-stderr' } });
  const server = await createRuntime(dirs);
  try {
    const identity = await root(server);
    const resp = await call(server, 'git_status', {}, identity);
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    assert.equal(resp.body.ok, true, JSON.stringify(resp.body));

    const result = resp.body.data.result;
    assert.equal(result.exitCode, 0, '回落 L1：exitCode 保留');
    assert.ok(result.stdout.includes('M a.txt') && result.stdout.includes('?? new.txt'), 'stdout 保留真实状态数据');
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
