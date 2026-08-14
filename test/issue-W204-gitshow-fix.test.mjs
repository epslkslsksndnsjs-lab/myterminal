// ADR-0051 W2-04 (#87)：git_show 工具 bug 修复 + schema 注册（0050 I-29 + 0051 D-12）
//
// 验收断言：
//   AC1  TOOL_SHAPES 双条目注册：reduce 保留 + schema 与 D-11 全文一致
//   AC2  fake adapter 结构化返回 → 结果替换为 L3 输出（Q5 后），白名单外 ghost 丢，applied:true
//   AC2b 真实 CommandResult raw：白名单即丢弃（D-10 原则 2）——Q5 值存在性校验要求标量值
//        带引号逐字出现在 rawText（engine.ts 启发式），stdout 未加引号文本中的
//        commitHash/subject/files 被丢、raw 字段值 exitCode/stderr 保留 → 结果替换为
//        {exitCode, stderr}（与 W2-03 git_log 同构）
//   AC3  Q5 全丢（模型幻觉）→ q5-rejected 回落 L1 denoise（数据保全，绝不阻断）
//   AC4  失败矩阵：不可用 / 超预算门 → 回落 L1 denoise，各自 reason 记审计
//   AC5  成功态语义等价：commitHash/subject/files 与 raw 逐字对应（fixture；值作为 raw
//        字段值才能逐字命中 Q5 锚点——真实 stdout 是未加引号文本，见 AC2b）
//   AC6  bug 机制锁定：`git show --stat --oneline -- <rev>` 恒空 stdout（真实 git 复现）；
//        修复拼接 `git show <rev> --stat --oneline` 非空
//   AC7  运行时探测：actions 真实 git 仓库 git_show HEAD → 修复后 stdout 非空 + 去噪；
//        revision '-p' 不注入 patch（#35 安全不变式保全）；fake 结构化 → L3 路由到达
//   AC8  D17 静默：L3 成功 / 回落 L1 全路径无层标记
//
// 测试方式：单测直接驱动 shapeToolResponse（dist/tool-parse.js）+ 注入 fake adapter
// （dist/l3/registry.js，issue-38 / W2-01 手法）；运行时探测走 MyTerminalRuntime actions
// 通道（myterminal.test.mjs 手法）。
// 注：任何 src 改动后必须先 bun run build 再跑测试（测试全部从 dist 导入，历史教训见 #43）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';
import { MyTerminalRuntime } from '../dist/server.js';

// 0051 D-11 拍板 git_show schema 全文（验收 1：TOOL_SHAPES 内 schema 与此逐字一致）
const D11_GIT_SHOW_SCHEMA = {
  type: 'object',
  properties: {
    exitCode: { type: 'number' },
    commitHash: { type: 'string' },
    subject: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, stat: { type: 'string' } },
        required: ['path', 'stat'],
      },
    },
    stderr: { type: 'string' },
  },
};

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

/** 注入 fake adapter（成功/不可用由 object/ready 控制），带调用计数与 lastReq 读取。 */
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
  resetL3Adapter();
  clearL3Quota();
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

/**
 * 语义等价 fixture：值作为 raw 字段值。Q5 值存在性校验的锚点是 raw 的 JSON 序列化
 * （JSON.stringify），字段值带引号出现在 rawText 中才能逐字命中——真实 git_show 的
 * stdout 是未加引号文本（AC2b 覆盖），故语义等价断言用本 fixture 证明「抽取值逐字保留」。
 */
function gitShowStructuredRaw() {
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

test('W2-04-AC1: TOOL_SHAPES 双条目注册 — reduce 保留 + schema 与 D-11 全文一致', () => {
  const shape = TOOL_SHAPES.get('git_show');
  assert.ok(shape, 'git_show 应注册');
  assert.equal(typeof shape.reduce, 'function', 'reduce 保留（L1 回落用）');
  assert.deepEqual(shape.schema, D11_GIT_SHOW_SCHEMA, 'schema 与 0051 D-11 全文逐字一致');
});

test('W2-04-AC2: fake 结构化返回 → 结果替换为 L3 输出（Q5 后），白名单外 ghost 丢', async () => {
  const { getLastReq } = injectFake({
    object: {
      exitCode: 0,
      commitHash: 'b8eaea8',
      subject: 'fix: trim trailing whitespace',
      files: [
        { path: 'src/core-tools.ts', stat: '2 ++' },
        { path: 'src/tool-parse.ts', stat: '1 +' },
      ],
      stderr: '',
      ghost: 'x', // 白名单外字段（Q5 必丢）
    },
  });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeToolResponse(makeResponse('git_show', gitShowStructuredRaw()), ctx);
  assert.deepEqual(shaped.data.result, gitShowStructuredRaw(), 'Q5 后结果替换（白名单外 ghost 被丢）');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined, 'L3 成功无 reason');
  const req = getLastReq();
  assert.ok(req, 'fake adapter complete 被调用（路由到达 L3）');
  assert.deepEqual(req.schema, D11_GIT_SHOW_SCHEMA, 'schema 原样传入');
  assertNoShapingMarkers(shaped);
});

test('W2-04-AC2b: 真实 CommandResult raw — 白名单即丢弃（stdout 被结构化替换，D-10 原则 2）', async () => {
  // Q5 值存在性校验：标量须带引号逐字出现在 rawText（engine.ts 启发式「对齐 ADR Q5」）。
  // 真实 git_show stdout 是未加引号文本 → 从中抽取的 commitHash/subject/files 被丢；
  // exitCode/stderr 本身是 raw 字段值 → 保留。stdout 被结构化替换是 D-10 原则 2 设计使然。
  const { getLastReq } = injectFake({
    object: {
      exitCode: 0,
      commitHash: 'b8eaea8',
      subject: 'fix: trim trailing whitespace',
      files: [{ path: 'src/core-tools.ts', stat: '2 ++' }],
      stderr: '',
    },
  });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeToolResponse(makeResponse('git_show', gitShowRaw()), ctx);
  assert.deepEqual(shaped.data.result, { exitCode: 0, stderr: '' }, 'Q5 后只留 raw 字段值');
  assert.equal(getRecord().shaping.applied, true);
  // L3 所见 raw 含完整 stdout（JSON 序列化形态；真实模型按 prompt 规则 2 抽取后受 Q5 锚点约束）
  assert.ok(getLastReq().instruction.includes(JSON.stringify(FIXTURE_STDOUT)), 'L3 prompt 含完整 raw stdout');
  assertNoShapingMarkers(shaped);
});

test('W2-04-AC3: Q5 全丢（模型幻觉）→ q5-rejected 回落 L1 denoise，数据保全', async () => {
  const { callCount } = injectFake({
    object: { exitCode: 999, commitHash: 'hallucinated', subject: 'hallucinated', files: [{ path: 'nope', stat: 'nope' }], stderr: 'hallucinated' },
  });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeToolResponse(makeResponse('git_show', gitShowRaw()), ctx);
  assert.equal(callCount(), 1);
  assert.equal(shaped.data.result.stdout, FIXTURE_STDOUT, '回落 L1：stdout 原样保全');
  for (const noise of ['command', 'cwd', 'signal', 'timedOut', 'cancelled']) {
    assert.equal(shaped.data.result[noise], undefined, `回落 L1 剥噪声 ${noise}`);
  }
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, 'q5-rejected', '失败矩阵 reason');
  assertNoShapingMarkers(shaped);
});

test('W2-04-AC4a: 模型不可用 → l3-unavailable 回落 L1 denoise', async () => {
  const { callCount } = injectFake({ ready: false });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeToolResponse(makeResponse('git_show', gitShowRaw()), ctx);
  assert.equal(callCount(), 0, '不可用不调模型');
  assert.equal(shaped.data.result.stdout, FIXTURE_STDOUT, '回落 L1：stdout 原样');
  assert.equal('command' in shaped.data.result, false, '噪声键剥除');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, 'l3-unavailable', '失败矩阵 reason');
  assertNoShapingMarkers(shaped);
});

test('W2-04-AC4b: 超预算门 → over-budget 回落 L1 denoise（D-4 双条目）', async () => {
  const { callCount, getLastReq } = injectFake({ object: gitShowStructuredRaw() });
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeToolResponse(makeResponse('git_show', gitShowRaw('x'.repeat(200_000))), ctx); // ≈50K tokens > 24K
  assert.equal(callCount(), 0, '预算门拦截，不调模型');
  assert.equal(getLastReq(), null, '预算门在调模型前');
  assert.equal(shaped.data.result.stdout.length, 200_000, '回落 L1：stdout 原样');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, 'over-budget');
  assertNoShapingMarkers(shaped);
});

test('W2-04-AC5: 成功态语义等价 — commitHash/subject/files 与 raw 逐字对应（fixture）', async () => {
  const raw = gitShowStructuredRaw();
  injectFake({ object: raw }); // 模型逐字抽取（D-10 原则 3：Q5 verbatim）
  const { ctx, getRecord } = makeCtx();

  const shaped = await shapeToolResponse(makeResponse('git_show', raw), ctx);
  assert.deepEqual(shaped.data.result, raw, 'commitHash/subject/files 与 raw 逐字对应，零增删改');
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

    // 旧拼接：`--` 把 revision 当 pathspec → 恒空（本票修复对象）
    const buggy = execFileSync('git', ['show', '--stat', '--oneline', '--', 'HEAD'], { cwd: dir, encoding: 'utf8' });
    assert.equal(buggy.trim(), '', '旧拼接按 revision 查询恒空（bug 机制）');
    // 修复拼接：revision 在 `--` 前 → 非空
    const fixed = execFileSync('git', ['show', 'HEAD', '--stat', '--oneline'], { cwd: dir, encoding: 'utf8' });
    assert.ok(fixed.trim().length > 0, '修复拼接返回非空 stdout');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 运行时探测（AC7/AC8）：actions 通道真实 git 仓库 ───────────────────────────

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

test('W2-04-AC7: 运行时探测 — 真实 git 仓库 git_show HEAD（bug 修复 + 注入保全 + L3 路由到达）', async () => {
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

    // (a) bug 修复：fake 不可用 → 回落 L1 denoise；stdout 非空 + 噪声剥除
    injectFake({ ready: false });
    const head = await call(server, 'git_show', { revision: 'HEAD' }, identity);
    assert.equal(head.body.ok, true, JSON.stringify(head.body));
    const denoised = head.body.data.result;
    assert.ok(typeof denoised.stdout === 'string' && denoised.stdout.trim().length > 0, '修复后按 revision 返回非空 stdout');
    for (const noise of ['command', 'cwd', 'signal', 'timedOut', 'cancelled']) {
      assert.equal(denoised[noise], undefined, `回落 L1 剥噪声 ${noise}`);
    }
    assertNoShapingMarkers(head.body);

    // (b) #35 安全不变式保全：'-p' 不注入 patch
    const inject = await call(server, 'git_show', { revision: '-p' }, identity);
    assert.equal(inject.body.ok, true, JSON.stringify(inject.body));
    const injectStdout = inject.body.data.result.stdout ?? '';
    assert.ok(!/diff --git|@@ /.test(injectStdout), `'-p' 不得被当 patch option：stdout=${JSON.stringify(injectStdout)}`);

    // (c) fake 结构化：L3 路由到达；Q5 锚点约束 → 只留 raw 字段值（AC2b 同构）
    resetL3Adapter();
    const { callCount } = injectFake({
      object: {
        exitCode: 0,
        commitHash: 'b8eaea8',
        subject: 'w204 seed commit',
        files: [{ path: 'f.txt', stat: '1 +' }],
        stderr: '',
      },
    });
    const shapedHead = await call(server, 'git_show', { revision: 'HEAD' }, identity);
    assert.equal(shapedHead.body.ok, true, JSON.stringify(shapedHead.body));
    assert.equal(callCount(), 1, 'L3 被调用（双条目 schema 优先，路由到达）');
    assert.deepEqual(shapedHead.body.data.result, { exitCode: 0, stderr: '' }, 'Q5 后只留 raw 字段值（stdout 内嵌值被丢，D-10 原则 2）');
    assertNoShapingMarkers(shapedHead.body);
  } finally {
    await server.close();
  }
});
