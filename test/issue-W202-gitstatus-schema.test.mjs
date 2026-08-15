// ADR-0051 增补-04 (#103)：git_status L3 豁免（#92 检查点裁决 A，用户拍板）
//
// 背景：真模型 20 样本评测 git_status×3 全 Q5 挂——答案字段被 Q5 剥光，结构性退化为
// {exitCode,stderr}，比 L1 更差。机理：2B 模型 + Q5 verbatim（D-10 原则 3）+ git 自由文本
// 的根本张力；Q5 是防幻觉护栏（0051 D-9 静默硬约束），不可松 → 豁免 L3（同 git_diff 先例，
// 答案保护）。终态 = L1 被动去噪：TOOL_SHAPES 条目回到 { reduce: denoiseCommandResult }，
// 无 schema → resolveShape 判 kind:'l1'，L3 永不进入（D-16 登记见本地覆盖矩阵 §2）。
//
// 验收断言：
//   AC1  豁免登记：git_status 注册 L1-only——reduce 保留、无 schema 字段（L3 永不进入）、
//        与 git_diff 先例同形（同一 denoiseCommandResult）
//   AC2  L3 永不调用：fake adapter 就绪且结构化返回合法对象 → 仍不调模型（callCount 0），
//        结果 = L1 denoise（5 真实字段，噪声键剥除），审计 applied:true 无 reason
//   AC2b adapter 不可用（supportsStructuredOutput=false）→ 同样不调模型，L1 denoise
//   AC3  adapter 抛错 → 同样不调模型，L1 denoise（无失败矩阵：L1-only 无 L3 失败路径）
//   AC4  运行时探测：actions 通道真实调用 git_status（fake adapter 注入）→ L3 永不调用，
//        结果 = L1 denoise，真实数据保全
//   D17  全路径无层标记（递归扫描）
//
// 测试方式：单测直接驱动 shapeToolResponse（dist/tool-parse.js）+ 注入 fake adapter
// （dist/l3/registry.js）；运行时探测走 MyTerminalRuntime actions 通道（dist/server.js）。
// 注：任何 src 改动后必须先 bun run build 再跑测试。

import { test, afterEach, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// #101（ADR-0051 增补-02 手法）：关预热——运行时探测注入 fake adapter，server.start 后台
// 异步预热会经 getL3Adapter 拿同一单例跑 smoke probe，挤占 complete 计数（L3 永不调用
// 断言会误报）。生产默认（不设旋钮）预热全开不变；本文件为运行时探测类测试，显式关预热。
process.env.MYTERMINAL_L3_WARMUP = 'false';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter, resetL3AdapterInstance } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';
import { MyTerminalRuntime } from '../dist/server.js';

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

/** L1 denoise 后仅留的 5 真实字段（与 issue-31 T03-AC2 同口径）。 */
const DENOISED_KEYS = ['durationMs', 'exitCode', 'stderr', 'stdout', 'truncated'].sort();
const COMMAND_RESULT_NOISE = ['command', 'cwd', 'signal', 'timedOut', 'cancelled'];

/** 注入 fake adapter（就绪/不可用/抛错），带调用计数 + 末次请求。 */
function injectFake({ ready = true, object = { exitCode: 0 }, throwing = false } = {}) {
  resetL3Adapter(); // 清旧单例，让本次 factory 在下次懒加载生效（单例常驻语义）
  let calls = 0;
  let lastReq = null;
  const adapter = {
    id: 'fake',
    supportsStructuredOutput: ready,
    isReady: async () => ready,
    complete: async (req) => {
      calls += 1;
      lastReq = req;
      if (throwing) throw new Error('fake adapter explosion');
      return { object, finishReason: 'stop', latencyMs: 1, modelId: 'fake' };
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

/** 理想 L3 抽取结果（若 schema 仍在）：证明即便 adapter 能产出合法结构化对象也不被调用。 */
function gitStatusStructuredObject() {
  return {
    exitCode: 0,
    branch: 'main',
    changes: [{ path: 'modified.txt', status: 'M' }],
    untracked: ['new.txt'],
    stderr: '',
  };
}

// ───────────────────────────────────────────────────────────
// AC1：豁免登记 — git_status L1-only（无 schema，与 git_diff 先例同形）
// ───────────────────────────────────────────────────────────

test('W2-02-AC1: 豁免登记 — git_status L1-only（无 schema 字段，与 git_diff 先例同形）', () => {
  const shape = TOOL_SHAPES.get('git_status');
  assert.ok(shape, 'git_status 应注册');
  assert.equal(typeof shape.reduce, 'function', 'reduce 保留（L1 被动去噪）');
  assert.equal('schema' in shape, false, '豁免登记：无 schema 字段（L3 永不进入）');
  assert.equal(shape.schema, undefined, 'schema 恒为 undefined');
  const gitDiff = TOOL_SHAPES.get('git_diff');
  assert.ok(gitDiff, '先例 git_diff 在册');
  assert.equal('schema' in gitDiff, false, '先例 git_diff 亦无 schema');
  assert.equal(shape.reduce, gitDiff.reduce, '与 git_diff 先例同形（同一 denoiseCommandResult）');
});

// ───────────────────────────────────────────────────────────
// AC2/AC2b/AC3：L3 永不调用（adapter 就绪 / 不可用 / 抛错）
// ───────────────────────────────────────────────────────────

test('W2-02-AC2: L3 永不调用 — adapter 就绪且结构化返回合法 → 仍不调模型，结果 L1 denoise', async () => {
  const { callCount, getLastReq } = injectFake({ object: { ...gitStatusStructuredObject(), ghost: 'x' } });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_status', gitStatusRaw()), ctx);

  assert.equal(callCount(), 0, '豁免：L3 永不调用（无 schema 条目）');
  assert.equal(getLastReq(), null, 'adapter complete 未被调用');
  const r = shaped.data.result;
  assert.deepEqual(Object.keys(r).sort(), DENOISED_KEYS, '结果 = L1 denoise（5 真实字段）');
  assert.equal(r.exitCode, 0, 'exitCode 保留');
  assert.equal(r.stdout, '## main\n M modified.txt\n?? new.txt', 'stdout 原样保全（未被结构化替换）');
  assert.equal(r.stderr, '', 'stderr 保留');
  for (const noise of COMMAND_RESULT_NOISE) assert.equal(r[noise], undefined, `噪声键剥除 ${noise}`);
  assert.equal(getRecord().shaping.applied, true, 'L1 整形 applied:true');
  assert.equal(getRecord().shaping.reason, undefined, 'L1-only 无 L3 失败 reason');
  assertNoMarkers(shaped);
});

test('W2-02-AC2b: adapter 不可用 → 不调模型，结果 L1 denoise（无 L3 失败矩阵）', async () => {
  const { callCount, getLastReq } = injectFake({ ready: false });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_status', gitStatusRaw()), ctx);

  assert.equal(callCount(), 0, '不调模型');
  assert.equal(getLastReq(), null, 'adapter 不被咨询');
  const r = shaped.data.result;
  assert.deepEqual(Object.keys(r).sort(), DENOISED_KEYS, '结果 = L1 denoise');
  assert.equal(r.stdout, '## main\n M modified.txt\n?? new.txt', 'stdout 原样保全');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined, '无 reason（不存在 l3-unavailable）');
  assertNoMarkers(shaped);
});

test('W2-02-AC3: adapter 抛错 → 不调模型，结果 L1 denoise（无 engine-error 路径）', async () => {
  const { callCount, getLastReq } = injectFake({ throwing: true });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_status', gitStatusRaw()), ctx);

  assert.equal(callCount(), 0, '不调模型');
  assert.equal(getLastReq(), null, 'adapter 不被咨询');
  const r = shaped.data.result;
  assert.deepEqual(Object.keys(r).sort(), DENOISED_KEYS, '结果 = L1 denoise');
  assert.equal(r.exitCode, 0, 'exitCode 保留');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined);
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC4：运行时探测 — actions 通道真实调用 git_status
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

test('W2-02-AC4: 运行时探测 — 真实 git_status 调用（fake adapter 注入）→ L3 永不调用，L1 denoise 数据保全', async () => {
  const dirs = tempGitWorkspace();
  // 即便 fake adapter 返回合法结构化抽取（旧 L3 会替换 stdout），豁免后也必须不调模型
  const { callCount, getLastReq } = injectFake({ object: gitStatusStructuredObject() });
  const server = await createRuntime(dirs);
  try {
    const identity = await root(server);
    const resp = await call(server, 'git_status', {}, identity);
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    assert.equal(resp.body.ok, true, JSON.stringify(resp.body));

    const result = resp.body.data.result;
    assert.equal(callCount(), 0, 'L3 永不调用（豁免生效）');
    assert.equal(getLastReq(), null, 'adapter 不被咨询');
    assert.equal(result.exitCode, 0, 'L1 denoise：exitCode 保留');
    assert.ok(result.stdout.includes('M a.txt') && result.stdout.includes('?? new.txt'), 'stdout 保留真实状态数据（未被结构化替换）');
    assert.equal('command' in result, false, '噪声键剥除');
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

// #101：文件结束恢复 env（bun 共享 worker 下 process.env 跨文件可见，防止 false 泄漏到
// 依赖预热默认开的文件——W208 等；生产默认不变）
afterAll(() => {
  delete process.env.MYTERMINAL_L3_WARMUP;
});
