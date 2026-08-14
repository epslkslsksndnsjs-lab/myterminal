// ADR-0051 增补-04 (#103)：git_show L3 豁免（#92 检查点裁决 A，用户拍板）
//
// 背景：真模型 20 样本评测 git_show×3 全 Q5 挂——答案字段被 Q5 剥光，结构性退化为
// {exitCode,stderr}，比 L1 更差。机理：2B 模型 + Q5 verbatim（D-10 原则 3）+ git 自由文本
// 的根本张力；Q5 是防幻觉护栏（0051 D-9 静默硬约束），不可松 → 豁免 L3（同 git_diff 先例，
// 答案保护）。终态 = L1 被动去噪：TOOL_SHAPES 条目回到 { reduce: denoiseCommandResult }，
// 无 schema → resolveShape 判 kind:'l1'，L3 永不进入（D-16 登记见本地覆盖矩阵 §2）。
// D-12 bug 修复（`git show <rev> --stat --oneline` 拼接，core-tools.ts）与 L3 无关，保留。
//
// 验收断言：
//   AC1  豁免登记：git_show 注册 L1-only——reduce 保留、无 schema 字段（L3 永不进入）、
//        与 git_diff 先例同形（同一 denoiseCommandResult）
//   AC2  L3 永不调用：fake adapter 就绪且结构化返回合法对象 → 仍不调模型（callCount 0），
//        结果 = L1 denoise（FIXTURE_STDOUT 逐字保全），审计 applied:true 无 reason
//   AC2b adapter 不可用 → 不调模型，L1 denoise
//   AC3  超大 stdout（超预算门量级）→ 仍 L1 denoise、stdout 全量保留（豁免后无预算门路径）
//   AC6  bug 机制锁定：`git show --stat --oneline -- <rev>` 恒空 stdout（真实 git 复现）；
//        修复拼接 `git show <rev> --stat --oneline` 非空（与 L3 无关，保留）
//   AC7  运行时探测：actions 真实 git 仓库 git_show HEAD → 去噪后非空 stdout + 噪声剥除；
//        revision '-p' 不注入 patch（#35 安全不变式保全）；fake 结构化 → L3 永不调用
//   D17  全路径无层标记（递归扫描）
//
// 测试方式：单测直接驱动 shapeToolResponse（dist/tool-parse.js）+ 注入 fake adapter
// （dist/l3/registry.js）；运行时探测走 MyTerminalRuntime actions 通道（myterminal.test.mjs 手法）。
// 注：任何 src 改动后必须先 bun run build 再跑测试（测试全部从 dist 导入，历史教训见 #43）。

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

function assertNoShapingMarkers(value, at = 'root') {
  if (Array.isArray(value)) { for (const item of value) assertNoShapingMarkers(item, `${at}[]`); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assertNoShapingMarkers(item, `${at}.${key}`);
  }
}

/** 注入 fake adapter（就绪/不可用由 ready 控制），带调用计数与 lastReq 读取。 */
function injectFake({ ready = true, object = {} } = {}) {
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
      return { object, finishReason: 'stop', latencyMs: 1, modelId: 'fake' };
    },
  };
  registerAdapterFactory(() => adapter);
  return { adapter, callCount: () => calls, getLastReq: () => lastReq };
}

function makeCtx(sessionId = 's-w204', transport = 'actions') {
  let record;
  const ctx = {
    transport,
    sessionId,
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

function makeResponse(tool, result) {
  return { ok: true, data: { tool, result } };
}

afterEach(() => {
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）
  clearL3Quota();
});

// #101：文件结束恢复 env（bun 共享 worker 下 process.env 跨文件可见，防止 false 泄漏到
// 依赖预热默认开的文件——W208 等；生产默认不变）
afterAll(() => {
  delete process.env.MYTERMINAL_L3_WARMUP;
});

// ── fixtures ──────────────────────────────────────────────────────────────────

const FIXTURE_STDOUT = [
  'b8eaea8 fix: trim trailing whitespace',
  '',
  ' src/core-tools.ts | 2 ++',
  ' src/tool-parse.ts  | 1 +',
  ' 2 files changed, 3 insertions(+)',
].join('\n');

/** 真实 git_show 的 CommandResult raw（runCommand 权威 10 字段）。 */
function gitShowRaw(stdout = FIXTURE_STDOUT) {
  return {
    command: 'git show HEAD --stat --oneline',
    cwd: '/ws',
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: '',
    truncated: false,
    durationMs: 15,
    cancelled: false,
  };
}

/** 理想 L3 抽取结果（若 schema 仍在）：证明即便 adapter 能产出合法结构化对象也不被调用。 */
function gitShowStructuredObject() {
  return {
    exitCode: 0,
    commitHash: 'b8eaea8',
    subject: 'fix: trim trailing whitespace',
    files: [
      { path: 'src/core-tools.ts', stat: '2 ++' },
      { path: 'src/tool-parse.ts', stat: '1 +' },
    ],
    stderr: '',
  };
}

// ───────────────────────────────────────────────────────────
// AC1：豁免登记 — git_show L1-only（无 schema，与 git_diff 先例同形）
// ───────────────────────────────────────────────────────────

test('W2-04-AC1: 豁免登记 — git_show L1-only（无 schema 字段，与 git_diff 先例同形）', () => {
  const shape = TOOL_SHAPES.get('git_show');
  assert.ok(shape, 'git_show 应注册');
  assert.equal(typeof shape.reduce, 'function', 'reduce 保留（L1 被动去噪）');
  assert.equal('schema' in shape, false, '豁免登记：无 schema 字段（L3 永不进入）');
  assert.equal(shape.schema, undefined, 'schema 恒为 undefined');
  const gitDiff = TOOL_SHAPES.get('git_diff');
  assert.ok(gitDiff, '先例 git_diff 在册');
  assert.equal('schema' in gitDiff, false, '先例 git_diff 亦无 schema');
  assert.equal(shape.reduce, gitDiff.reduce, '与 git_diff 先例同形（同一 denoiseCommandResult）');
});

// ───────────────────────────────────────────────────────────
// AC2/AC2b/AC3：L3 永不调用 + L1 denoise 数据保全
// ───────────────────────────────────────────────────────────

test('W2-04-AC2: L3 永不调用 — adapter 就绪且结构化返回合法 → 仍不调模型，结果 L1 denoise', async () => {
  const { callCount, getLastReq } = injectFake({ object: { ...gitShowStructuredObject(), ghost: 'x' } });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeToolResponse(makeResponse('git_show', gitShowRaw()), ctx);
  assert.equal(callCount(), 0, '豁免：L3 永不调用（无 schema 条目）');
  assert.equal(getLastReq(), null, 'adapter complete 未被调用');
  const r = shaped.data.result;
  assert.equal(r.exitCode, 0, 'exitCode 保留');
  assert.equal(r.stdout, FIXTURE_STDOUT, 'stdout 逐字保全（未被结构化替换）');
  assert.equal(r.stderr, '', 'stderr 保留');
  for (const noise of ['command', 'cwd', 'signal', 'timedOut', 'cancelled']) {
    assert.equal(r[noise], undefined, `噪声键剥除 ${noise}`);
  }
  assert.equal(getRecord().shaping.applied, true, 'L1 整形 applied:true');
  assert.equal(getRecord().shaping.reason, undefined, 'L1-only 无 L3 失败 reason');
  assertNoShapingMarkers(shaped);
});

test('W2-04-AC2b: adapter 不可用 → 不调模型，结果 L1 denoise', async () => {
  const { callCount, getLastReq } = injectFake({ ready: false });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeToolResponse(makeResponse('git_show', gitShowRaw()), ctx);
  assert.equal(callCount(), 0, '不调模型');
  assert.equal(getLastReq(), null, 'adapter 不被咨询');
  assert.equal(shaped.data.result.stdout, FIXTURE_STDOUT, 'stdout 原样');
  assert.equal('command' in shaped.data.result, false, '噪声键剥除');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined, '无 reason（不存在 l3-unavailable）');
  assertNoShapingMarkers(shaped);
});

test('W2-04-AC3: 超大 stdout（超预算门量级）→ 仍 L1 denoise、stdout 全量保留（豁免后无预算门）', async () => {
  const { callCount, getLastReq } = injectFake({ object: gitShowStructuredObject() });
  const { ctx, getRecord } = makeCtx();
  const big = 'x'.repeat(200_000); // ≈50K tokens，旧预算门（24K）会拦——豁免后不设门

  const shaped = await shapeToolResponse(makeResponse('git_show', gitShowRaw(big)), ctx);
  assert.equal(callCount(), 0, 'L3 永不调用（无预算门路径）');
  assert.equal(getLastReq(), null, 'adapter 不被咨询');
  assert.equal(shaped.data.result.stdout.length, 200_000, 'stdout 全量保留');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined);
  assertNoShapingMarkers(shaped);
});

test('W2-04-AC6: bug 机制锁定 — `git show --stat --oneline -- <rev>` 恒空（真实 git 复现）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-w204-mech-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@myterminal.local'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });

    // 旧拼接：`--` 把 revision 当 pathspec → 恒空（D-12 修复对象，与 L3 无关，保留锁定）
    const buggy = execFileSync('git', ['show', '--stat', '--oneline', '--', 'HEAD'], { cwd: dir, encoding: 'utf8' });
    assert.equal(buggy.trim(), '', '旧拼接按 revision 查询恒空（bug 机制）');
    // 修复拼接：revision 在 `--` 前 → 非空
    const fixed = execFileSync('git', ['show', 'HEAD', '--stat', '--oneline'], { cwd: dir, encoding: 'utf8' });
    assert.ok(fixed.trim().length > 0, '修复拼接返回非空 stdout');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 运行时探测（AC7）：actions 通道真实 git 仓库 ───────────────────────────

const CONNECTOR_KEY = 'w204-connector-key-123456';
const ACTIONS_TOKEN = 'w204-actions-token-1234567890123456';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-w204-'));
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

async function root(server, name = 'w204-main') {
  const reg = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  return reg.body.data.result.identity;
}

test('W2-04-AC7: 运行时探测 — 真实 git 仓库 git_show HEAD（去噪保全 + 注入不变式 + L3 永不调用）', async () => {
  const server = await createRuntime();
  try {
    // 真实 git 仓库（seed 提交）
    execFileSync('git', ['init', '-q'], { cwd: server.dirs.workspaceDir });
    execFileSync('git', ['config', 'user.email', 'test@myterminal.local'], { cwd: server.dirs.workspaceDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: server.dirs.workspaceDir });
    fs.writeFileSync(path.join(server.dirs.workspaceDir, 'f.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: server.dirs.workspaceDir });
    execFileSync('git', ['commit', '-q', '-m', 'w204 seed commit'], { cwd: server.dirs.workspaceDir });
    const identity = await root(server);

    // (a) 去噪保全：fake 不可用 → L1 denoise；stdout 非空 + 噪声剥除
    injectFake({ ready: false });
    const head = await call(server, 'git_show', { revision: 'HEAD' }, identity);
    assert.equal(head.body.ok, true, JSON.stringify(head.body));
    const denoised = head.body.data.result;
    assert.ok(typeof denoised.stdout === 'string' && denoised.stdout.trim().length > 0, '按 revision 返回非空 stdout（D-12 修复保留）');
    for (const noise of ['command', 'cwd', 'signal', 'timedOut', 'cancelled']) {
      assert.equal(denoised[noise], undefined, `回落 L1 剥噪声 ${noise}`);
    }
    assertNoShapingMarkers(head.body);

    // (b) #35 安全不变式保全：'-p' 不注入 patch
    const inject = await call(server, 'git_show', { revision: '-p' }, identity);
    assert.equal(inject.body.ok, true, JSON.stringify(inject.body));
    const injectStdout = inject.body.data.result.stdout ?? '';
    assert.ok(!/diff --git|@@ /.test(injectStdout), `'-p' 不得被当 patch option：stdout=${JSON.stringify(injectStdout)}`);

    // (c) fake 结构化：L3 永不调用（豁免生效），结果 = L1 denoise，stdout 全量保全
    resetL3Adapter();
    const { callCount, getLastReq } = injectFake({ object: gitShowStructuredObject() });
    const shapedHead = await call(server, 'git_show', { revision: 'HEAD' }, identity);
    assert.equal(shapedHead.body.ok, true, JSON.stringify(shapedHead.body));
    assert.equal(callCount(), 0, 'L3 永不调用（豁免：无 schema 条目）');
    assert.equal(getLastReq(), null, 'adapter 不被咨询');
    assert.ok(typeof shapedHead.body.data.result.stdout === 'string' && shapedHead.body.data.result.stdout.includes('w204 seed commit'), 'stdout 保全真实提交数据（未被结构化替换）');
    assert.equal('command' in shapedHead.body.data.result, false, '噪声键剥除');
    assertNoShapingMarkers(shapedHead.body);
  } finally {
    await server.close();
  }
});
