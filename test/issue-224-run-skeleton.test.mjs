// Workflows T1（#224）：run 骨架与启动面
//
// 验收覆盖（对应 #224 Acceptance criteria）：
//   AC1 workflow_start 仅 root 可调（subagent 通道 FORBIDDEN）；三种互斥形态
//       （script / scriptPath / scriptPath + resumeFromRunId）；违规烧 token 前拒，
//       归类 VALIDATION(→EXTENSION_ERROR) / NOT_FOUND / FORBIDDEN；拒因含 reason
//   AC2 内联脚本自动持久化，可经 scriptPath 复用；响应 { runId, status, scriptPath } 立即返回
//   AC3 单路全链路（假模型 + 虚拟钟）：目录 / 每路文件 / 索引 / 终态标记齐全且原子写
//       （无 .tmp 残留）；快照仅终态写；终态标记最后写
//   AC4 机器件带 schemaVersion：旧产物缺字段按缺省、不兼容版本 fail-closed 拒读（双向）
//   AC5 工具面分账：不新增 workflow_status / workflow_list；workflow_start 返回为控制
//       字段 passthrough（不进 TOOL_SHAPES）
//   AC6 构造器注入缝：时钟 / state 根 / adapter 工厂（可计数）/ 阈值可注入，单测不真实等待
//   AC7 进度事件（run 起 / 每路终态 / run 终态）落地；审计 start / settle（含 runId+actor+结果）
//
// 测试方式：直调 dist/workflows/*（引擎构造器注入假 adapter 与虚拟钟）+ 直调
// createBuiltinTools 的工具条目（工具面契约）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkflowEngine, WorkflowStartError } from '../dist/workflows/engine.js';
import { DEFAULT_GATES } from '../dist/workflows/gates.js';
import { virtualClock } from '../dist/workflows/clock.js';
import { initWorkflowEngine, getWorkflowEngine, resetWorkflowEngine } from '../dist/workflows/runtime.js';
import { validateStartArgs, mapStartError } from '../dist/workflows/start.js';
import { SCHEMA_VERSION, VersionMismatchError } from '../dist/workflows/schema.js';
import { readIndex, writeIndex } from '../dist/workflows/run-index.js';
import { runPaths, workflowPaths, managedRootFor } from '../dist/workflows/paths.js';
import { newRunId, isRunId } from '../dist/workflows/ids.js';
import { scanDeterminism } from '../dist/workflows/lint.js';
import { loadScript, persistScript } from '../dist/workflows/saved.js';
import { createExclusive, writeJsonAtomic, readJson } from '../dist/workflows/atomic.js';
import { WorkflowEvents } from '../dist/workflows/events.js';
import { createBuiltinTools } from '../dist/core-tools.js';
import { MyTerminalStore } from '../dist/store.js';
import { validateJsonSchema } from '../dist/security.js';
import { TOOL_SHAPES } from '../dist/tool-parse.js';

const INLINE_SCRIPT = `const answer = await agent('summarise the target', { label: 'summarise' });\nreturn { answer };`;

let TMP;
let STORE;

function makeConfig(workspaceDir, stateDir) {
  return {
    settingsPath: path.join(stateDir, 'settings.json'),
    workspaceDir,
    stateDir,
    host: '127.0.0.1',
    port: 8787,
    connectorKey: 'k'.repeat(32),
    actionsToken: 't'.repeat(32),
    publicBaseUrl: 'http://127.0.0.1:8787',
    maxOutputChars: 4000,
    commandTimeoutSec: 120,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };
}

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-224-'));
  TMP = dir;
  const workspaceDir = path.join(dir, 'workspace');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  STORE = new MyTerminalStore(stateDir);
  return { workspaceDir, stateDir, managedRoot: path.join(workspaceDir, '.myterminal') };
}

/** 假模型：每次调用计数，可整体挂起以便断言"运行中"盘面。 */
function fakeFactory(options = {}) {
  const state = { instances: 0, calls: 0 };
  const factory = () => {
    state.instances += 1;
    return {
      complete: async (request) => {
        state.calls += 1;
        if (options.hang) return await options.hang;
        if (options.fail) throw new Error('model exploded');
        return { text: options.text ?? 'agent answer', outputTokens: options.outputTokens ?? 11 };
      },
    };
  };
  return { factory, state };
}

function engineFor(workspaceDir, managedRoot, extra = {}) {
  const clock = extra.clock ?? virtualClock();
  const events = extra.events ?? new WorkflowEvents();
  const auditLog = extra.auditLog ?? [];
  return new WorkflowEngine({
    workspaceDir,
    managedRoot,
    clock,
    events,
    audit: (entry) => auditLog.push(entry),
    adapterFactory: extra.adapterFactory,
    gates: extra.gates,
    ...(extra.deliverNotice ? { deliverNotice: extra.deliverNotice } : {}),
  });
}

afterEach(() => {
  resetWorkflowEngine();
  STORE = undefined;
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

// ═══════════════════════════════════════════════════════════════
// AC1：参数面——三形态互斥与拒因归类
// ═══════════════════════════════════════════════════════════════

test('AC1 参数面：三种合法形态各自识别', () => {
  assert.deepEqual(validateStartArgs({ script: 'x' }), { ok: true, form: 'inline' });
  assert.deepEqual(validateStartArgs({ scriptPath: '/a/b.js' }), { ok: true, form: 'script-path' });
  assert.deepEqual(validateStartArgs({ scriptPath: '/a/b.js', resumeFromRunId: newRunId() }), { ok: true, form: 'resume' });
  assert.deepEqual(validateStartArgs({ script: 'x', args: { a: 1 } }), { ok: true, form: 'inline' });
});

test('AC1 参数面：互斥违规与形状违例全部烧 token 前拒，且带 reason', () => {
  const cases = [
    [{}, 'source-missing'],
    [{ script: 'x', scriptPath: '/a.js' }, 'script-and-script-path'],
    [{ script: 'x', resumeFromRunId: newRunId() }, 'script-and-resume'],
    [{ resumeFromRunId: newRunId() }, 'resume-requires-script-path'],
    [{ scriptPath: '/a.js', resumeFromRunId: 'wf_ZZZ' }, 'run-id-shape'],
    [{ scriptPath: '/a.js', resumeFromRunId: '../../etc/passwd' }, 'run-id-shape'],
    [{ script: 'x', args: 'nope' }, 'args-not-object'],
    [{ script: 'x', args: [1, 2] }, 'args-not-object'],
  ];
  for (const [input, reason] of cases) {
    const result = validateStartArgs(input);
    assert.equal(result.ok, false, `应拒：${JSON.stringify(input)}`);
    assert.equal(result.reason, reason);
    assert.equal(result.code, 'VALIDATION');
    assert.ok(result.message.length > 0);
  }
});

test('AC1 错误码映射：VALIDATION 以既有 EXTENSION_ERROR 承载，NOT_FOUND / FORBIDDEN 原样', () => {
  assert.deepEqual(mapStartError(new WorkflowStartError('VALIDATION', 'r', 'm')).code, 'EXTENSION_ERROR');
  assert.deepEqual(mapStartError(new WorkflowStartError('VALIDATION', 'r', 'm')).details, { reason: 'r' });
  assert.deepEqual(mapStartError(new WorkflowStartError('NOT_FOUND', 'r', 'm')).code, 'NOT_FOUND');
  assert.deepEqual(mapStartError(new WorkflowStartError('FORBIDDEN', 'r', 'm')).code, 'FORBIDDEN');
  assert.equal(mapStartError(new Error('other')), undefined);
});

test('AC1 runId 形态闸：非法 runId 拼不进路径（防路径穿越）', () => {
  const paths = workflowPaths('/tmp/managed');
  assert.ok(isRunId(newRunId()));
  assert.throws(() => runPaths(paths, 'wf_../../etc'), /runId must match/);
  assert.throws(() => runPaths(paths, 'wf_ABC'), /runId must match/);
  assert.throws(() => runPaths(paths, '/etc/passwd'), /runId must match/);
  assert.equal(runPaths(paths, newRunId()).dir.startsWith(path.join(paths.runsRoot, 'wf_')), true);
});

// ═══════════════════════════════════════════════════════════════
// AC2：内联脚本持久化与复用 + 响应形状
// ═══════════════════════════════════════════════════════════════

test('AC2 内联脚本自动持久化到 saved 目录，响应立即返回三字段', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const fake = fakeFactory();
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: fake.factory });
  const started = await engine.start({ script: INLINE_SCRIPT, ownerSessionId: 'sess-a' });
  assert.equal(started.status, 'running');
  assert.ok(isRunId(started.runId));
  assert.ok(started.scriptPath.endsWith('.js'));
  assert.ok(fs.existsSync(started.scriptPath), '脚本已落盘');
  assert.equal(path.dirname(started.scriptPath), workflowPaths(managedRoot).savedRoot);
  await started.completion;
});

test('AC2 持久化后的 scriptPath 可被再次复用（script-path 形态）', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const paths = workflowPaths(managedRoot);
  const first = fakeFactory();
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: first.factory });
  const started = await engine.start({ script: INLINE_SCRIPT, ownerSessionId: 'sess-a' });
  await started.completion;
  const scriptPath = started.scriptPath;

  const reused = await engine.start({ scriptPath, ownerSessionId: 'sess-a' });
  assert.equal(reused.scriptPath, scriptPath, '复用同一脚本引用，不重复落盘');
  assert.notEqual(reused.runId, started.runId, '复用脚本 ≠ 复用 run');
  await reused.completion;
  assert.equal(fs.readdirSync(paths.savedRoot).length, 1, 'saved 根内只有一份脚本');
  assert.equal(first.state.calls, 2, '两次 run 各跑自己的一路');
  assert.equal(first.state.instances, 2, '每路一个独立 adapter 实例');
});

test('AC2 scriptPath 白名单：越出 saved 根一律拒（不降级成 not-found）', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const outside = path.join(TMP, 'outside.js');
  fs.writeFileSync(outside, INLINE_SCRIPT, 'utf8');
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: fakeFactory().factory });
  const rejected = await engine.start({ scriptPath: outside, ownerSessionId: 'sess-a' }).catch((e) => e);
  assert.ok(rejected instanceof WorkflowStartError);
  assert.equal(rejected.code, 'VALIDATION');
  assert.equal(rejected.reason, 'script-path-outside-root');
  const loaded = await loadScript(workflowPaths(managedRoot), outside);
  assert.deepEqual(loaded, { ok: false, reason: 'outside-root' });
});

test('AC2 scriptPath 不存在 = NOT_FOUND', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const paths = workflowPaths(managedRoot);
  fs.mkdirSync(paths.savedRoot, { recursive: true });
  const missing = path.join(paths.savedRoot, 'ghost.js');
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: fakeFactory().factory });
  const rejected = await engine.start({ scriptPath: missing, ownerSessionId: 'sess-a' }).catch((e) => e);
  assert.equal(rejected.code, 'NOT_FOUND');
  assert.equal(rejected.reason, 'script-path-not-found');
});

test('AC2 确定性扫描：非确定性脚本在烧任何 token 前被拒', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const fake = fakeFactory();
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: fake.factory });
  const rejected = await engine.start({ script: 'const t = Date.now(); return t;', ownerSessionId: 's' }).catch((e) => e);
  assert.equal(rejected.code, 'VALIDATION');
  assert.equal(rejected.reason, 'non-deterministic-script');
  assert.equal(fake.state.instances, 0, '一个 adapter 实例都没建 = 零 token');
  assert.deepEqual(scanDeterminism('const a = Date.now(); const b = Math.random();').map((v) => v.literal), ['Date.now()', 'Math.random()']);
  assert.deepEqual(scanDeterminism('const t = "Date.now() is fine in a string";').length, 0, '字符串内不算违例');
  assert.deepEqual(scanDeterminism('// Date.now() in a comment\nreturn 1;').length, 0, '注释内不算违例');
});

// ═══════════════════════════════════════════════════════════════
// AC3：单路全链路（假模型 + 虚拟钟）——盘上有账
// ═══════════════════════════════════════════════════════════════

test('AC3 单路全链路：目录 / 每路文件 / 索引 / 终态标记齐全，原子写无残留', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const clock = virtualClock();
  const fake = fakeFactory({ text: 'the answer', outputTokens: 42 });
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: fake.factory, clock });
  const started = await engine.start({ script: INLINE_SCRIPT, args: { target: 'x' }, ownerSessionId: 'sess-a' });
  const run = runPaths(workflowPaths(managedRoot), started.runId);

  const index = await started.completion;
  assert.equal(index.status, 'completed');
  assert.equal(index.runId, started.runId);
  assert.equal(index.ownerSessionId, 'sess-a');
  assert.deepEqual(index.args, { target: 'x' });
  assert.equal(index.argsRecorded, true);
  assert.equal(index.tokens.spent, 42);
  assert.equal(index.dispatches.length, 1);
  assert.equal(index.dispatches[0].status, 'completed');
  assert.equal(index.dispatches[0].label, 'summarise');

  for (const file of [run.indexFile, run.journalFile, run.snapshotFile, run.terminalFile, path.join(run.agentsDir, 'd0001.json')]) {
    assert.ok(fs.existsSync(file), `应存在：${path.basename(file)}`);
  }
  const digest = JSON.parse(fs.readFileSync(path.join(run.agentsDir, 'd0001.json'), 'utf8'));
  assert.equal(digest.result, 'the answer');
  assert.equal(digest.status, 'completed');
  assert.equal(digest.schemaVersion, SCHEMA_VERSION);

  const marker = JSON.parse(fs.readFileSync(run.terminalFile, 'utf8'));
  assert.equal(marker.runId, started.runId);
  assert.equal(marker.status, 'completed');

  // 原子写：整棵 run 目录不允许有任何临时文件残留
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const leftovers = walk(run.dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], '无 .tmp 残留');

  const journalLines = fs.readFileSync(run.journalFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(journalLines[0].type, 'launched', 'launched 是首行——启动过的 run 日志永不为空');
  assert.ok(journalLines.some((l) => l.type === 'started'));
  assert.ok(journalLines.some((l) => l.type === 'result'));
  assert.equal(fake.state.instances, 1, '每路一个独立 adapter 实例');
});

test('AC3 快照仅终态写：运行中没有 snapshot.json 与 terminal 标记', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  let release;
  const hang = new Promise((resolve) => { release = resolve; });
  const fake = fakeFactory({ hang });
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: fake.factory });
  const started = await engine.start({ script: INLINE_SCRIPT, ownerSessionId: 'sess-a' });
  const run = runPaths(workflowPaths(managedRoot), started.runId);

  assert.equal(fs.existsSync(run.terminalFile), false, '运行中无终态标记');
  assert.equal(fs.existsSync(run.snapshotFile), false, '运行中无快照');
  const live = await readIndex(run.indexFile);
  assert.equal(live.status, 'running');

  release({ text: 'late answer', outputTokens: 3 });
  const done = await started.completion;
  assert.equal(done.status, 'completed');
  assert.equal(fs.existsSync(run.snapshotFile), true, '终态后快照才落盘');
  assert.equal(fs.existsSync(run.terminalFile), true);
});

test('AC3 终态标记独占创建：后到者读到已有标记即退让，不写第二份', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: fakeFactory().factory });
  const started = await engine.start({ script: INLINE_SCRIPT, ownerSessionId: 'sess-a' });
  const index = await started.completion;
  const run = runPaths(workflowPaths(managedRoot), started.runId);
  const before = fs.readFileSync(run.terminalFile, 'utf8');
  // 结算只有一处：第二次结算被 settled 位挡住，标记内容逐字节不变
  await started.completion;
  assert.equal(fs.readFileSync(run.terminalFile, 'utf8'), before);
  assert.equal(index.status, 'completed');
  const second = await createExclusive(run.terminalFile, 'other');
  assert.equal(second, false, '独占创建：已存在即 false');
});

test('AC3 该路自身失败 = null 并记账，脚本仍跑到尾（判定见 T2 的 run 级规则）', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const failing = fakeFactory({ fail: true });
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: failing.factory });
  const started = await engine.start({ script: INLINE_SCRIPT, ownerSessionId: 'sess-a' });
  const index = await started.completion;
  // #225 钉死 run 级判定：全败 → failed、部分失败 → completed（带警告）、无"几路算过"阈值。
  // 单路 run 里唯一的一路失败即"全败"，所以终态是 failed——注意脚本本身仍跑到了尾（不是被中断）。
  assert.equal(index.status, 'failed');
  assert.equal(index.reason, 'failed');
  assert.equal(index.dispatches[0].status, 'failed');
  assert.equal(index.dispatches[0].error.kind, 'error');
  assert.equal(index.dispatches[0].outputTokens, 0, '该路没交回结果就不计用量');
  assert.equal(index.failures.length, 1, '失败作为具名条目记入索引');
  assert.equal(index.failures[0].label, 'summarise');
  const run = runPaths(workflowPaths(managedRoot), started.runId);
  const journal = fs.readFileSync(run.journalFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(journal.some((l) => l.type === 'failed'), '失败进账');
  assert.ok(!journal.some((l) => l.type === 'result'), '失败不写 result 行');
});

test('AC3 墙钟到期 → failed(run-gate)，虚拟钟推进即触发（单测零真实等待）', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const clock = virtualClock();
  const hang = new Promise(() => { /* 永不兑现 */ });
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: fakeFactory({ hang }).factory, clock, gates: { runGateMs: 1000, dispatchWindowMs: 300, stallMs: 100, reducerBudgetMs: 2000, reducerTimeoutMs: 3000, reduceSlackMs: 100 } });
  const started = await engine.start({ script: INLINE_SCRIPT, ownerSessionId: 'sess-a' });
  assert.equal((await readIndex(runPaths(workflowPaths(managedRoot), started.runId).indexFile)).status, 'running');
  clock.advance(1000);
  const index = await started.completion;
  assert.equal(index.status, 'failed');
  assert.equal(index.reason, 'run-gate');
  assert.equal(DEFAULT_GATES.runGateMs, 30 * 60 * 1000, '默认闸是 30 分钟，测试里才整栈缩短');
});

// ═══════════════════════════════════════════════════════════════
// AC4：机器件 schemaVersion——additive 兼容 + 不兼容 fail-closed
// ═══════════════════════════════════════════════════════════════

test('AC4 旧产物缺字段按缺省处理（additive 兼容）', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const paths = workflowPaths(managedRoot);
  const runId = newRunId();
  const run = runPaths(paths, runId);
  fs.mkdirSync(run.dir, { recursive: true });
  fs.writeFileSync(run.indexFile, JSON.stringify({ schemaVersion: 1, runId, status: 'running', ownerSessionId: 'sess-a', scriptPath: 'x.js', sourceRef: { id: 'x.js', revision: 'r' }, startedAt: '2026-01-01T00:00:00.000Z' }), 'utf8');
  const index = await readIndex(run.indexFile);
  assert.deepEqual(index.dispatches, [], '缺 dispatches → 缺省空数组');
  assert.deepEqual(index.tokens, { spent: 0 }, '缺 tokens → 缺省零账');
  assert.equal(index.argsRecorded, false);
  assert.equal('args' in index, false, '缺 args 不凭空造字段');
  const roundTrip = await writeIndex(run.indexFile, index).then(() => readIndex(run.indexFile));
  assert.equal(roundTrip.schemaVersion, SCHEMA_VERSION);
});

test('AC4 不兼容版本 fail-closed 拒读（新码读未来产物）', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const paths = workflowPaths(managedRoot);
  const run = runPaths(paths, newRunId());
  fs.mkdirSync(run.dir, { recursive: true });
  fs.writeFileSync(run.indexFile, JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, runId: 'wf_1', status: 'running' }), 'utf8');
  await assert.rejects(() => readIndex(run.indexFile), (error) => {
    assert.ok(error instanceof VersionMismatchError);
    assert.match(error.message, /schema version mismatch/);
    return true;
  });
});

test('AC4 旧码读新产物同样拒（双向：readerVersion 更小的读取方）', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const paths = workflowPaths(managedRoot);
  const run = runPaths(paths, newRunId());
  fs.mkdirSync(run.dir, { recursive: true });
  fs.writeFileSync(run.indexFile, JSON.stringify({ schemaVersion: 2, runId: 'wf_1', status: 'running' }), 'utf8');
  await assert.rejects(() => readIndex(run.indexFile, 1), VersionMismatchError);
  const ok = await readIndex(run.indexFile, 2);
  assert.equal(ok.schemaVersion, 2);
});

test('AC4 缺版本号或脏产物同样拒（不许半读半猜）', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const paths = workflowPaths(managedRoot);
  const run = runPaths(paths, newRunId());
  fs.mkdirSync(run.dir, { recursive: true });
  fs.writeFileSync(run.indexFile, JSON.stringify({ runId: 'wf_1', status: 'running' }), 'utf8');
  await assert.rejects(() => readIndex(run.indexFile), VersionMismatchError);
  fs.writeFileSync(run.indexFile, 'not json at all', 'utf8');
  await assert.rejects(() => readIndex(run.indexFile));
});

// ═══════════════════════════════════════════════════════════════
// AC5：工具面分账
// ═══════════════════════════════════════════════════════════════

test('AC5 工具面分账：只加 workflow_start，不新增 workflow_status / workflow_list', () => {
  const { workspaceDir, stateDir } = tempWorkspace();
  const tools = createBuiltinTools(makeConfig(workspaceDir, stateDir), STORE);
  assert.ok(tools.has('workflow_start'));
  assert.equal(tools.has('workflow_status'), false);
  assert.equal(tools.has('workflow_list'), false);
  assert.equal(tools.has('workflow_cancel'), false, '取消面不属本票');
  assert.equal(TOOL_SHAPES.has('workflow_start'), false, '控制字段 passthrough，不进整形表');
  const names = [...tools.keys()].filter((n) => n.startsWith('workflow_'));
  assert.deepEqual(names, ['workflow_start']);
});

test('AC5 workflow_start schema 形状：只四种参数、无闸门参数', () => {
  const { workspaceDir, stateDir } = tempWorkspace();
  const tools = createBuiltinTools(makeConfig(workspaceDir, stateDir), STORE);
  const schema = tools.get('workflow_start').inputSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['args', 'resumeFromRunId', 'script', 'scriptPath']);
  assert.equal(schema.additionalProperties, false);
  for (const gate of ['tokenCap', 'runGate', 'maxAgents', 'concurrency', 'maxWallClockMs']) {
    assert.equal(gate in schema.properties, false, `闸门参数 ${gate} 不得出现在模型面`);
  }
  assert.deepEqual(validateJsonSchema(schema, { script: 'x' }), []);
  assert.deepEqual(validateJsonSchema(schema, { scriptPath: '/a.js', resumeFromRunId: newRunId() }), []);
  assert.ok(validateJsonSchema(schema, { script: '' }).length > 0, '空脚本被形状拒');
  assert.ok(validateJsonSchema(schema, { script: 'x', nope: 1 }).length > 0, '未知字段被拒');
});

test('AC5 workflow_start 仅 root：subagent 通道 FORBIDDEN', async () => {
  const { workspaceDir, stateDir, managedRoot } = tempWorkspace();
  initWorkflowEngine({ workspaceDir, managedRoot, adapterFactory: fakeFactory().factory });
  const tools = createBuiltinTools(makeConfig(workspaceDir, stateDir), STORE);
  const tool = tools.get('workflow_start');
  const { session } = STORE.registerRoot({ name: 'root' });
  await assert.rejects(
    () => tool.invoke({ script: INLINE_SCRIPT }, { transport: 'subagent', authenticatedSession: session }),
    (error) => { assert.equal(error.code, 'FORBIDDEN'); assert.equal(error.details.reason, 'subagent-channel'); return true; },
  );
});

test('AC5 工具层拒因带 reason 字段（归类：不存在=NOT_FOUND / 归属=FORBIDDEN）', async () => {
  const { workspaceDir, stateDir, managedRoot } = tempWorkspace();
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: fakeFactory().factory });
  initWorkflowEngine({ workspaceDir, managedRoot, adapterFactory: fakeFactory().factory });
  const tools = createBuiltinTools(makeConfig(workspaceDir, stateDir), STORE);
  const tool = tools.get('workflow_start');
  const { session } = STORE.registerRoot({ name: 'root' });
  const ctx = { transport: 'actions', authenticatedSession: session };

  const missing = await tool.invoke({ scriptPath: path.join(workflowPaths(managedRoot).savedRoot, 'ghost.js') }, ctx).catch((e) => e);
  assert.equal(missing.code, 'NOT_FOUND');
  assert.equal(missing.details.reason, 'script-path-not-found');

  const exclusive = await tool.invoke({ script: 'x', scriptPath: '/a.js' }, ctx).catch((e) => e);
  assert.equal(exclusive.code, 'EXTENSION_ERROR');
  assert.equal(exclusive.details.reason, 'script-and-script-path');

  // 归属：手工造一个别人的 run（有索引、无终态标记），续跑必须被拒
  const foreignRunId = newRunId();
  const foreign = runPaths(workflowPaths(managedRoot), foreignRunId);
  fs.mkdirSync(foreign.dir, { recursive: true });
  const saved = await persistScript(workflowPaths(managedRoot), INLINE_SCRIPT, foreignRunId);
  await writeIndex(foreign.indexFile, {
    schemaVersion: SCHEMA_VERSION, runId: foreignRunId, status: 'running', ownerSessionId: 'someone-else',
    scriptPath: saved.path, sourceRef: saved.sourceRef, argsRecorded: false, startedAt: '2026-01-01T00:00:00.000Z',
    dispatches: [], tokens: { spent: 0 },
  });
  const notMine = await tool.invoke({ scriptPath: saved.path, resumeFromRunId: foreignRunId }, ctx).catch((e) => e);
  assert.equal(notMine.code, 'FORBIDDEN');
  assert.equal(notMine.details.reason, 'run-not-owned');
});

test('AC5 正常启动经工具面返回 { runId, status, scriptPath } 且立即返回', async () => {
  const { workspaceDir, stateDir, managedRoot } = tempWorkspace();
  let release;
  const hang = new Promise((resolve) => { release = resolve; });
  const fake = fakeFactory({ hang });
  initWorkflowEngine({ workspaceDir, managedRoot, adapterFactory: fake.factory });
  const tools = createBuiltinTools(makeConfig(workspaceDir, stateDir), STORE);
  const { session } = STORE.registerRoot({ name: 'root' });
  const result = await tools.get('workflow_start').invoke({ script: INLINE_SCRIPT }, { transport: 'actions', authenticatedSession: session });
  assert.deepEqual(Object.keys(result).sort(), ['runId', 'scriptPath', 'status']);
  assert.equal(result.status, 'running');
  assert.ok(isRunId(result.runId));
  release({ text: 'done', outputTokens: 1 });
  // 后台 run 必须等它结算完再退场：否则 afterEach 删树会撞上还在飞的终态写盘。
  await getWorkflowEngine()?.settled(result.runId);
});

// ═══════════════════════════════════════════════════════════════
// AC6：构造器注入缝
// ═══════════════════════════════════════════════════════════════

test('AC6 state 根可重定向：产物落在注入的 managed 根下', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const redirected = path.join(TMP, 'elsewhere', 'managed');
  const engine = engineFor(workspaceDir, redirected, { adapterFactory: fakeFactory().factory });
  const started = await engine.start({ script: INLINE_SCRIPT, ownerSessionId: 's' });
  await started.completion;
  assert.ok(fs.existsSync(path.join(redirected, 'workflows', 'runs', started.runId, 'index.json')));
  assert.equal(fs.existsSync(managedRoot), false, '默认根未被使用');
  assert.equal(managedRootFor(workspaceDir), managedRoot);
});

test('AC6 时钟注入：盘上时间戳取自注入时钟，不读系统时间', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const clock = virtualClock(1_800_000_000_000);
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: fakeFactory().factory, clock });
  const started = await engine.start({ script: INLINE_SCRIPT, ownerSessionId: 's' });
  const index = await started.completion;
  const expected = new Date(1_800_000_000_000).toISOString();
  assert.equal(index.startedAt, expected);
  assert.equal(index.endedAt, expected);
  assert.equal(index.dispatches[0].startedAt, expected);
});

test('AC6 阈值可注入：墙钟缩短后到期判定随注入值走', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const clock = virtualClock();
  const hang = new Promise(() => {});
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: fakeFactory({ hang }).factory, clock, gates: { runGateMs: 50, dispatchWindowMs: 10, stallMs: 5, reducerBudgetMs: 100, reducerTimeoutMs: 150, reduceSlackMs: 5 } });
  const started = await engine.start({ script: INLINE_SCRIPT, ownerSessionId: 's' });
  clock.advance(49);
  assert.equal((await readIndex(runPaths(workflowPaths(managedRoot), started.runId).indexFile)).status, 'running');
  clock.advance(1);
  assert.equal((await started.completion).reason, 'run-gate');
});

// ═══════════════════════════════════════════════════════════════
// AC7：进度事件与审计
// ═══════════════════════════════════════════════════════════════

test('AC7 进度事件三件套：run 起 / 每路终态 / run 终态，按序落地', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const events = new WorkflowEvents();
  const seen = [];
  events.on((event) => seen.push(event));
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: fakeFactory().factory, events });
  const started = await engine.start({ script: INLINE_SCRIPT, ownerSessionId: 'sess-a' });
  await started.completion;
  assert.deepEqual(seen.map((e) => e.type), ['run_started', 'dispatch_settled', 'run_settled']);
  assert.equal(seen[0].runId, started.runId);
  assert.equal(seen[1].data.dispatchId, 'd0001');
  assert.equal(seen[2].data.status, 'completed');
});

test('AC7 审计 start / settle 两条，含 runId + actor + 结果字段', async () => {
  const { workspaceDir, managedRoot } = tempWorkspace();
  const auditLog = [];
  const engine = engineFor(workspaceDir, managedRoot, { adapterFactory: fakeFactory().factory, auditLog });
  const started = await engine.start({ script: INLINE_SCRIPT, ownerSessionId: 'sess-a' });
  await started.completion;
  assert.deepEqual(auditLog.map((e) => e.action), ['workflow_start', 'workflow_settle']);
  for (const entry of auditLog) {
    assert.equal(entry.runId, started.runId);
    assert.equal(entry.actor, 'sess-a');
    assert.ok(entry.at.length > 0);
  }
  assert.equal(auditLog[0].status, 'running');
  assert.equal(auditLog[1].status, 'completed');
  assert.equal(auditLog[1].reason, 'completed');
});

// ═══════════════════════════════════════════════════════════════
// 盘面卫生（原子写原语）
// ═══════════════════════════════════════════════════════════════

test('原子写：临时文件不留残留，读者只见完整内容', async () => {
  const { workspaceDir } = tempWorkspace();
  const dir = path.join(TMP, 'atomic');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'x.json');
  await writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(await readJson(file), { a: 1 });
  assert.deepEqual(fs.readdirSync(dir), ['x.json'], '无 .tmp 残留');
  await writeJsonAtomic(file, { a: 2 });
  assert.deepEqual(await readJson(file), { a: 2 });
  assert.equal(await readJson(path.join(dir, 'missing.json')), undefined, '缺失 ≠ 损坏');
});
