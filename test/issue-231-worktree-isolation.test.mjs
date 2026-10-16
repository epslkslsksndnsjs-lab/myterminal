// Workflows T8（#231）：写必隔离（worktree）——引擎级验收
//
// 真 git fixture + 假模型 + 虚拟钟：一条 run 里的隔离路真建一块 worktree、真写盘、真按
// clean / 有改动两条路收场。断言只盯外部行为——写落在哪、主 checkout 与主 .git 是不是摸不到、
// 未标隔离的写请求怎么判败且零 token、配额到线涉事路怎么 fail-closed、per-dispatch 生命周期
// 在重试与重跑两条路上各自的形状。零件契约在 -units 文件。
//
// 诚实边界（ADR-0052 §11）：这里锁的是**工具面**的边界。agent 在 execute_cli 内部自行 cd 逃逸
// 属既有 subagent 同等暴露面，shell 级沙箱独立立项、不在这一版——用例只断工具面拒了什么。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import { WorkflowEngine } from '../dist/workflows/engine.js';
import { virtualClock } from '../dist/workflows/clock.js';
import { workflowPaths, runPaths, worktreesRootFor, isInsideWorktreesRoot } from '../dist/workflows/paths.js';
import { WorktreeService } from '../dist/workflows/worktree-service.js';
import { isWithinBoundary } from '../dist/workflows/tool-boundary.js';

const TMP = [];
const skipOnWin = process.platform === 'win32';

afterEach(() => {
  while (TMP.length) {
    const dir = TMP.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

function git(command, cwd) {
  return execFileSync('git', command, { cwd, encoding: 'utf8' });
}

/** 真 git fixture：一个干净提交过的仓库（脏树会被创建闸门拒绝，所以每个用例都从干净起跑）。 */
function gitWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-231-')));
  TMP.push(root);
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.gitignore'), '.myterminal/\n');
  fs.writeFileSync(path.join(workspaceDir, 'keep.txt'), 'original\n');
  git(['init', '-q', '-b', 'main', '.'], workspaceDir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], workspaceDir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'baseline'], workspaceDir);
  const managedRoot = path.join(workspaceDir, '.myterminal');
  return { workspaceDir, managedRoot, paths: workflowPaths(managedRoot) };
}

/** 一个不是 git 仓库的工作区（创建闸门的另一条臂）。 */
function plainWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-231-plain-')));
  TMP.push(root);
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const managedRoot = path.join(workspaceDir, '.myterminal');
  return { workspaceDir, managedRoot, paths: workflowPaths(managedRoot) };
}

function scriptedModel(script) {
  const state = { calls: [], byPrompt: new Map() };
  const factory = () => ({
    complete: async (request) => {
      // 逐轮留一份快照：循环原地加长 messages，留引用会让所有轮都看到终态。
      state.calls.push({
        ...request,
        messages: (request.messages ?? []).map((message) => ({ role: message.role, content: [...message.content] })),
        tools: request.tools ?? [],
      });
      const n = (state.byPrompt.get(request.prompt) ?? 0) + 1;
      state.byPrompt.set(request.prompt, n);
      const reply = script(request, n, state);
      return reply ?? { text: 'ok', outputTokens: 2 };
    },
  });
  return {
    factory,
    calls: state.calls,
    count: () => state.calls.length,
    toolNames: (index) => ((state.calls[index]?.tools) ?? []).map((tool) => tool.name),
    /** 第 index 轮里模型新收到的那条 tool_result（解析后的载荷）。 */
    lastToolResult: (index) => {
      const messages = state.calls[index]?.messages ?? [];
      const block = messages[messages.length - 1]?.content?.[0];
      return block?.content ? JSON.parse(block.content) : undefined;
    },
  };
}

function toolUse(id, name, input) {
  return { text: '', outputTokens: 1, toolUses: [{ id, name, input }] };
}

function done(text, outputTokens = 2) {
  return { text, outputTokens };
}

/**
 * 隔离服务替身：只记调用、可按用例编排拒绝，其余（配额 / 盘面 / git）都不碰。
 * 用来锁"涉事路怎么判败"与"provision / release 各发生几次"这类形状，不重验 git 行为。
 */
function fakeWorktrees(behaviour = {}) {
  const calls = [];
  const paths = new Map();
  let counter = 0;
  const stub = {
    async load() { /* 替身不读盘 */ },
    async provision(input) {
      calls.push({ op: 'provision', input });
      const decided = behaviour.provision?.(input);
      if (decided) return decided;
      counter += 1;
      const id = `${input.runId}-${input.dispatchId}`;
      const made = { ok: true, id, path: `/fake/worktrees/${counter}-${id}`, branch: `worktree-${id}`, reused: false };
      paths.set(id, made.path);
      return made;
    },
    async pin(input) {
      calls.push({ op: 'pin', input });
      return { ok: true, path: path.resolve(input.workingDir), branch: 'pinned-branch' };
    },
    async release(id) {
      calls.push({ op: 'release', input: { id } });
      const decided = behaviour.release?.(id);
      return { kept: false, id, path: paths.get(id) ?? '/fake/worktrees', branch: `worktree-${id}`, ...decided };
    },
    preserved: () => [],
    async archiveDue(options) { calls.push({ op: 'archiveDue', input: options }); return []; },
  };
  return {
    stub,
    calls,
    paths,
    provisionCount: () => calls.filter((call) => call.op === 'provision').length,
    releaseCount: () => calls.filter((call) => call.op === 'release').length,
  };
}

function engineFor(temp, options = {}) {
  const clock = options.clock ?? virtualClock();
  const engine = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock,
    ...(options.audit ? { audit: options.audit } : { audit: () => { /* 其余用例不重述审计契约 */ } }),
    ...(options.adapterFactory ? { adapterFactory: options.adapterFactory } : {}),
    ...(options.gates ? { gates: options.gates } : {}),
    ...(options.worktrees ? { worktrees: options.worktrees } : {}),
    concurrencyWindow: options.concurrencyWindow ?? 2,
  });
  return { engine, clock };
}

const GATES = {
  runGateMs: 60_000,
  dispatchWindowMs: 30_000,
  dispatchTurns: 12,
  stallMs: 900,
  reducerBudgetMs: 90_000,
  reducerTimeoutMs: 120_000,
  reduceSlackMs: 1_000,
  keepQuotaCount: 50,
  keepQuotaBytes: 5 * 1024 * 1024 * 1024,
};

async function agentFileOf(temp, runId, slot = 'd0001') {
  const run = runPaths(workflowPaths(temp.managedRoot), runId);
  return JSON.parse(await fs.promises.readFile(path.join(run.agentsDir, `${slot}.json`), 'utf8'));
}

/** 轮询到条件成立并回它给的值；等不到即红（残活命令的落笔时机不由测试控制）。 */
async function until(condition, what, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ═══════════════════════════════════════════════════════════════
// AC1 写 dispatch 在独立 worktree 内完成；主 checkout 与主 .git 不可达
// ═══════════════════════════════════════════════════════════════

test('AC1 隔离路真建 worktree，写的字节落在那件里、不落在工作区', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('w1', 'write_file', { path: 'planted.txt', content: 'from an isolated path\n' }) : done('wrote it', 4)));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  const started = await engine.start({
    script: `const a = await agent('write something', { isolation: 'worktree', tools: ['write_file'], label: 'W' });\nreturn a;`,
    ownerSessionId: 'sess-a',
  });
  const index = await started.completion;

  assert.equal(index.status, 'completed', JSON.stringify(index.failures));
  const record = index.dispatches[0];
  assert.equal(record.isolation, 'worktree');
  assert.ok(record.worktree, '该路终态记着它的边界');
  assert.equal(record.worktree.preserved, true, '写了字节就是改了东西 → 保留');
  assert.equal(isInsideWorktreesRoot(temp.managedRoot, record.worktree.path), true, '位置 = 库内 managed 根下 worktrees/');
  assert.equal(fs.readFileSync(path.join(record.worktree.path, 'planted.txt'), 'utf8'), 'from an isolated path\n');
  assert.equal(fs.existsSync(path.join(temp.workspaceDir, 'planted.txt')), false, '主 checkout 一个字节都没被改');
  assert.equal(fs.statSync(path.join(record.worktree.path, '.git')).isFile(), true, '那件的 .git 是指向共同对象库的 FILE');
});

test('AC1 越界读写都摸不到主 checkout 与主 .git', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const probes = [
    { path: '../../../.git/config' },
    { path: path.join(temp.workspaceDir, '.git', 'config') },
    { path: '../../../keep.txt' },
    { path: 'not-here.txt' },
  ];
  const model = scriptedModel((request, n) => (n <= probes.length ? toolUse(`p${n}`, 'read_file', probes[n - 1]) : done('done', 1)));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  const index = await (await engine.start({
    script: `await agent('probe the boundary', { isolation: 'worktree', tools: ['read_file', 'write_file'], label: 'P' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.equal(index.status, 'completed');
  const reasons = probes.map((_, probeIndex) => model.lastToolResult(probeIndex + 1)?.reason);
  assert.deepEqual(reasons.slice(0, 3), ['outside-boundary', 'outside-boundary', 'outside-boundary'], '上跳到主 .git / 绝对直书主 .git / 上跳读工作区文件，三条全拒');
  assert.equal(reasons[3], 'not-found', '界内路径过了边界闸、真去读了盘（读不到是另一回事）');
});

test('AC1 经界内 symlink 逃逸写盘被拒，一个字节都不落在界外', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const model = scriptedModel((request, n) => (n === 1
    ? toolUse('l1', 'execute_cli', { command: 'ln -s ../../.. escape' })
    : n === 2
      ? toolUse('l2', 'write_file', { path: 'escape/escaped.txt', content: 'nope\n' })
      : done('stopped', 1)));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  await (await engine.start({
    script: `await agent('escape through a symlink', { isolation: 'worktree', tools: ['execute_cli', 'write_file'], label: 'S' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.equal(model.lastToolResult(1)?.ok, true, '建 symlink 本身是界内动作');
  const through = model.lastToolResult(2);
  assert.equal(through?.reason, 'outside-boundary');
  assert.match(through?.error, /symlink or mount point/);
  assert.equal(fs.existsSync(path.join(temp.workspaceDir, 'escaped.txt')), false, '主 checkout 没被写进去');
});

test('AC1 未标隔离的写请求：该路判败记入索引、run 继续、零 token 消耗', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const model = scriptedModel(() => done('read-only is enough', 7));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  const started = await engine.start({
    script: `const bad = await agent('wants a write', { tools: ['write_file'], label: 'BAD' });
const good = await agent('reads', { label: 'GOOD' });
return [bad, good];`,
    ownerSessionId: 'sess-a',
  });
  const index = await started.completion;
  assert.equal(index.status, 'completed', '一路判败不升成 run 级终结');
  assert.equal(index.dispatches[0].status, 'failed');
  assert.equal(index.dispatches[0].error.reason, 'isolation-required');
  assert.equal(index.failures[0].reason, 'isolation-required');
  assert.equal(index.dispatches[0].outputTokens, 0, '零 token：模型一次都没被叫');
  assert.equal(index.dispatches[0].attempts, 1);
  assert.equal(index.dispatches[1].status, 'completed');
  assert.equal(model.count(), 1, '只有没请求写的那一路打了模型');
  assert.equal(index.tokens.spent, 7);
  const perPath = await agentFileOf(temp, started.runId, 'd0001');
  assert.equal(perPath.status, 'failed');
  assert.equal(perPath.error.reason, 'isolation-required');
  assert.equal('result' in perPath, false, '判败那一路不产出结果值');
});

test('AC1 展示名与拼写名互认：请求 "Write file" 同样算请求写', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const model = scriptedModel(() => done('ok', 1));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  const index = await (await engine.start({ script: `await agent('x', { tools: ['Write file'], label: 'A' });\nreturn 1;`, ownerSessionId: 'sess-a' })).completion;
  assert.equal(index.dispatches[0].error.reason, 'isolation-required');
  assert.equal(model.count(), 0, '换写法也照样烧不到 token');
});

// ═══════════════════════════════════════════════════════════════
// AC2 工具面随模式变；写工具只在隔离面出现
// ═══════════════════════════════════════════════════════════════

test('AC2 工具面随模式变化：隔离面递出写工具，只读面递不出', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const model = scriptedModel(() => done('done', 1));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  const index = await (await engine.start({
    script: `await parallel([() => agent('iso', { isolation: 'worktree', label: 'I' }), () => agent('plain', { label: 'P' })]);\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.equal(index.status, 'completed', JSON.stringify(index.failures));
  assert.equal(model.count(), 2);
  const isolatedAt = model.calls.findIndex((_, callIndex) => model.toolNames(callIndex).includes('write_file'));
  assert.ok(isolatedAt >= 0, '有一轮的工具表里有写工具');
  assert.equal(model.calls[isolatedAt].system.includes('# If you change files'), true, '那一轮的系统提示词说清了它进了隔离面');
  const plainAt = isolatedAt === 0 ? 1 : 0;
  assert.equal(model.toolNames(plainAt).includes('apply_patch'), false, '只读那一轮一个写工具都没有');
  assert.ok(model.toolNames(plainAt).includes('read_file'));
});

// ═══════════════════════════════════════════════════════════════
// AC3 clean 自动删、有改动保留并回报
// ═══════════════════════════════════════════════════════════════

test('AC3 什么都没改的一路：worktree 自动删，登记进 removed', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const model = scriptedModel(() => done('nothing to change', 2));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  const index = await (await engine.start({ script: `await agent('read only', { isolation: 'worktree', label: 'C' });\nreturn 1;`, ownerSessionId: 'sess-a' })).completion;
  const record = index.dispatches[0];
  assert.equal(record.worktree.preserved, false);
  assert.equal(fs.existsSync(record.worktree.path), false, 'clean 件不留');
  const registry = JSON.parse(await fs.promises.readFile(path.join(worktreesRootFor(temp.managedRoot), 'registry.json'), 'utf8'));
  assert.equal(registry.entries[0].state, 'removed');
  assert.equal(registry.schemaVersion, 1);
  assert.equal(git(['worktree', 'list'], temp.workspaceDir).trim().split('\n').length, 1, 'git 侧注册位也被 prune 收回');
});

test('AC3 有改动：保留并回报 path + branch，文本尾巴让人看得见', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('w', 'write_file', { path: 'note.md', content: 'kept\n' }) : done('finished the edit', 2)));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  const index = await (await engine.start({ script: `const a = await agent('edit', { isolation: 'worktree', tools: ['write_file'], label: 'K' });\nreturn a;`, ownerSessionId: 'sess-a' })).completion;
  const record = index.dispatches[0];
  assert.equal(record.worktree.preserved, true);
  assert.match(record.worktree.branch, /^worktree-wf_[0-9a-f]+-d0001$/);
  // 结果的落点是每路文件（索引只留账目与失败清单），回报尾巴要跟着结果走。
  const perPath = await agentFileOf(temp, index.runId, 'd0001');
  assert.match(perPath.result, /\[worktree preserved: .+ \(branch worktree-wf_/);
  assert.equal(fs.existsSync(record.worktree.path), true);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], temp.workspaceDir).trim(), 'main', '主 checkout 的分支没被切走');
});

test('AC3 schema 路不被尾巴污染：机器件记边界，结构化结果一个字节都不动', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
  const model = scriptedModel((request, n) => (n === 1
    ? toolUse('w', 'write_file', { path: 'x.txt', content: 'y\n' })
    : n === 2
      ? toolUse('s', 'structured_output', { verdict: 'ok' })
      : done('unreachable', 1)));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  const index = await (await engine.start({
    script: `const a = await agent('edit', { isolation: 'worktree', tools: ['write_file'], schema: ${JSON.stringify(schema)}, label: 'S' });\nreturn a;`,
    ownerSessionId: 'sess-a',
  })).completion;
  const perPath = await agentFileOf(temp, index.runId, 'd0001');
  assert.deepEqual(perPath.result, { verdict: 'ok' }, '结构化出口是对象，宿主侧的回报不塞进它');
  assert.equal(index.dispatches[0].worktree.preserved, true, '但边界账照记');
});

// ═══════════════════════════════════════════════════════════════
// AC4 位置与可见性 + 宽限期残活写入仍在边界内
// ═══════════════════════════════════════════════════════════════

test('AC4 位置：worktrees/ 在库内 managed 根下、不进 git 视野、root 读得到保留项', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('w', 'write_file', { path: 'kept.txt', content: 'mine\n' }) : done('done', 1)));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  const index = await (await engine.start({ script: `await agent('keep', { isolation: 'worktree', tools: ['write_file'], label: 'G' });\nreturn 1;`, ownerSessionId: 'sess-a' })).completion;
  const kept = index.dispatches[0].worktree.path;
  assert.equal(kept.startsWith(path.join(temp.managedRoot, 'worktrees') + path.sep), true);
  assert.equal(git(['status', '--porcelain'], temp.workspaceDir).trim(), '', '隔离区不进 git 视野');
  assert.equal(isWithinBoundary(kept, temp.workspaceDir), true, 'root / GPT 的读面边界覆盖得到它');
  assert.equal(fs.existsSync(path.join(kept, 'kept.txt')), true);
});

test('AC4 宽限期残活进程的写入仍被边界锁在 worktree 内', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  // 一条命令先在 worktree 里落笔，再挂住不返；这期间取消整 run —— 收尸有宽限，
  // 残活的那一支能写的地方只有它自己的 cwd（那块 worktree），主 checkout 摸不到。
  const model = scriptedModel((request, n) => (n === 1
    ? toolUse('b', 'execute_cli', { command: 'echo tick >> heartbeat.log; sleep 30' })
    : done('unreachable', 1)));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  const started = await engine.start({
    script: `await agent('lingering writer', { isolation: 'worktree', tools: ['execute_cli', 'write_file'], label: 'B' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  });
  const zone = worktreesRootFor(temp.managedRoot);
  const written = await until(async () => {
    if (!fs.existsSync(zone)) return false;
    for (const entry of fs.readdirSync(zone)) {
      const candidate = path.join(zone, entry, 'heartbeat.log');
      if (fs.existsSync(candidate)) return candidate;
    }
    return false;
  }, '残活命令在 worktree 里落笔');
  await engine.cancel(started.runId, ['sess-a']);
  const worktree = path.dirname(written);
  assert.equal(fs.existsSync(path.join(temp.workspaceDir, 'heartbeat.log')), false, '工作区没被写上');
  assert.equal(fs.readFileSync(written, 'utf8'), 'tick\n');
  // 收场与取消赛跑：整 run 先封口，这一路的隔离件随后才定性（燃烧秒级停是硬要求，收尸不是）。
  const entry = await until(async () => {
    const registry = JSON.parse(await fs.promises.readFile(path.join(zone, 'registry.json'), 'utf8'));
    const found = registry.entries.find((item) => item.path === worktree);
    return found && found.state !== 'active' && found.state !== 'starting' ? found : false;
  }, '被取消那一路的隔离件完成定性');
  assert.equal(entry.state, 'preserved', '残活写过的件按"有改动"留下，等人处置');
  assert.equal(fs.existsSync(worktree), true);
});

// ═══════════════════════════════════════════════════════════════
// AC5 per-dispatch 生命周期
// ═══════════════════════════════════════════════════════════════

test('AC5 重试共享同一 worktree：一次调用只建一件、只收一件', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const probe = fakeWorktrees();
  const clock = virtualClock();
  const gates = { ...GATES, stallMs: 900, dispatchWindowMs: 5_000 };
  let round = 0;
  const model = scriptedModel(() => {
    round += 1;
    if (round === 1) return new Promise(() => {});
    return done('second attempt', 2);
  });
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates, clock, worktrees: probe.stub });
  const started = await engine.start({ script: `await agent('stally', { isolation: 'worktree', label: 'R' });\nreturn 1;`, ownerSessionId: 'sess-a' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  clock.advance(gates.stallMs);
  await new Promise((resolve) => setTimeout(resolve, 10));
  clock.advance(gates.stallMs);
  const index = await started.completion;
  assert.equal(index.dispatches[0].attempts, 2, '一次调用被重试过');
  assert.equal(probe.provisionCount(), 1, 'per-dispatch：重试不再建一件新的');
  assert.equal(probe.releaseCount(), 1, '也只收一次');
});

test('AC5 被打断后重跑不自动续用旧件：新 run 出新件', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const model = scriptedModel(() => done('ok', 1));
  const first = await (await engineFor(temp, { adapterFactory: model.factory, gates: GATES }).engine.start({
    script: `await agent('a', { isolation: 'worktree', label: 'A' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  const second = await (await engineFor(temp, { adapterFactory: model.factory, gates: GATES }).engine.start({
    script: `await agent('a', { isolation: 'worktree', label: 'A' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.notEqual(first.dispatches[0].worktree.path, second.dispatches[0].worktree.path);
  assert.notEqual(first.runId, second.runId, '新 run 无跨 run 记忆，件也各是各的');
});

// ═══════════════════════════════════════════════════════════════
// AC9 审计：quota-warn / quota-blocked 落到既有审计汇（runId + actor + 结果）
// ═══════════════════════════════════════════════════════════════

test('AC9 配额软阈值与硬上限两条都落进审计汇，带 runId + actor + 具名理由', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const entries = [];
  const model = scriptedModel(() => toolUse('w', 'write_file', { path: 'keep.txt', content: 'kept\n' }));
  const { engine } = engineFor(temp, {
    adapterFactory: model.factory,
    gates: { ...GATES, keepQuotaCount: 5, keepQuotaBytes: GATES.keepQuotaBytes },
    audit: (entry) => entries.push(entry),
  });
  const started = await engine.start({
    script: `await agent('w1', { isolation: 'worktree', tools: ['write_file'], label: 'W1' });
await agent('w2', { isolation: 'worktree', tools: ['write_file'], label: 'W2' });
await agent('w3', { isolation: 'worktree', tools: ['write_file'], label: 'W3' });
await agent('w4', { isolation: 'worktree', tools: ['write_file'], label: 'W4' });
await agent('w5', { isolation: 'worktree', tools: ['write_file'], label: 'W5' });
await agent('w6', { isolation: 'worktree', tools: ['write_file'], label: 'W6' });
return 1;`,
    ownerSessionId: 'sess-owner',
  });
  const index = await started.completion;
  const warns = entries.filter((entry) => entry.action === 'worktree-quota-warn');
  const blocked = entries.filter((entry) => entry.action === 'worktree-quota-blocked');
  assert.equal(warns.length, 1, '达 80%（4/5）那一次建件留下一条告警');
  assert.equal(blocked.length, 1, '达硬上限（5/5）后的一次建件留下一条拒建');
  for (const entry of [...warns, ...blocked]) {
    assert.equal(entry.runId, started.runId, '每条都带 runId');
    assert.equal(entry.actor, 'sess-owner', 'actor 换成这条 run 的归属会话');
    assert.ok(typeof entry.status === 'string' && entry.status.length > 0);
    assert.match(entry.reason, /keep-quota-count/);
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/, '每条带时刻');
  }
  assert.equal(blocked[0].status, 'failed', '拒建那条是失败态');
  assert.equal(warns[0].status, 'completed', '告警那条不是失败');
  assert.equal(index.dispatches[5].error.reason, 'worktree-quota', '涉事路具名判败');
});

// ═══════════════════════════════════════════════════════════════
// AC6 / AC7 并发独立、gc 关闭、配额 fail-closed、全败即 run 级 failed
// ═══════════════════════════════════════════════════════════════

test('AC6 N 路并发各自一块：路径互不相同、彼此看不见', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('w', 'write_file', { path: 'mine.txt', content: 'only mine\n' }) : done('done', 1)));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES, concurrencyWindow: 3 });
  const index = await (await engine.start({
    script: `await parallel([() => agent('a', { isolation: 'worktree', tools: ['write_file'], label: 'A' }), () => agent('b', { isolation: 'worktree', tools: ['write_file'], label: 'B' }), () => agent('c', { isolation: 'worktree', tools: ['write_file'], label: 'C' })]);\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  const paths = index.dispatches.map((record) => record.worktree.path);
  assert.equal(new Set(paths).size, 3, '三路三件');
  assert.equal(index.dispatches.every((record) => record.status === 'completed'), true, JSON.stringify(index.failures));
  for (const one of paths) {
    for (const sibling of paths.filter((item) => item !== one)) {
      assert.equal(fs.existsSync(path.join(one, path.basename(sibling))), false, 'worktree 之间互不可见');
    }
  }
});

test('AC6 每条 git 命令都关着对象库自动 gc（真 git 记录器逐条核 argv 前缀）', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const seen = [];
  const recording = async (argv, cwd) => {
    seen.push(argv.join(' '));
    return await new Promise((resolve) => {
      const child = spawn('git', argv, { cwd });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  };
  const service = new WorktreeService({
    worktreesRoot: worktreesRootFor(temp.managedRoot),
    workspaceDir: temp.workspaceDir,
    git: recording,
    gates: { keepQuotaCount: GATES.keepQuotaCount, keepQuotaBytes: GATES.keepQuotaBytes },
  });
  const made = await service.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'G' });
  assert.equal(made.ok, true, made.message);
  assert.ok(seen.length >= 3, seen.join('\n'));
  for (const line of seen) assert.ok(line.startsWith('-c gc.auto=0 --no-optional-locks '), line);
  const released = await service.release(made.id);
  assert.equal(released.kept, false);
});

test('AC7 配额到硬上限：涉事路 fail-closed 具名判败，run 继续', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const model = scriptedModel(() => done('fine', 3));
  const blocked = { ok: false, reason: 'worktree-quota', message: 'No new worktree may be created (keep-quota-count): 50 kept of 50.' };
  const probe = fakeWorktrees({ provision: () => blocked });
  const index = await (await engineFor(temp, { adapterFactory: model.factory, gates: GATES, worktrees: probe.stub }).engine.start({
    script: `const iso = await agent('needs a worktree', { isolation: 'worktree', label: 'Q' });
const plain = await agent('reads only', { label: 'P' });
return [iso, plain];`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.equal(index.status, 'completed', '一路因配额判败不是全败，run 不升 run 级 failed');
  assert.equal(index.dispatches[0].error.reason, 'worktree-quota');
  assert.equal(index.dispatches[1].status, 'completed');
  assert.equal(model.count(), 1, '被配额挡住的那一路一次模型都没打');
});

test('AC7 全部路都因配额失败 → run 级 failed（不许假完整交付）', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const model = scriptedModel(() => done('never reached', 1));
  const probe = fakeWorktrees({ provision: () => ({ ok: false, reason: 'worktree-quota', message: 'blocked by keep-quota-bytes' }) });
  const index = await (await engineFor(temp, { adapterFactory: model.factory, gates: GATES, worktrees: probe.stub }).engine.start({
    script: `const out = await parallel([() => agent('a', { isolation: 'worktree', label: 'A' }), () => agent('b', { isolation: 'worktree', label: 'B' })]);\nreturn out.length;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.equal(index.status, 'failed');
  assert.equal(index.failures.length, 2);
  assert.equal(index.failures.every((entry) => entry.reason === 'worktree-quota'), true);
  assert.equal(model.count(), 0);
});

test('AC7 脏树与非仓库两条拒绝各有各的具名，都不烧 token、都不落地目录', { skip: skipOnWin }, async () => {
  const dirty = gitWorkspace();
  fs.writeFileSync(path.join(dirty.workspaceDir, 'uncommitted.txt'), 'dirty\n');
  const model = scriptedModel(() => done('x', 1));
  const dirtyIndex = await (await engineFor(dirty, { adapterFactory: model.factory, gates: GATES }).engine.start({
    script: `await agent('a', { isolation: 'worktree', label: 'D' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.equal(dirtyIndex.dispatches[0].error.reason, 'worktree-dirty-tree');
  assert.equal(model.count(), 0, '拒绝在任何资源副作用与模型调用之前');
  assert.equal(fs.existsSync(worktreesRootFor(dirty.managedRoot)), false, '脏树被拒时连隔离区都不落地');

  const notRepo = plainWorkspace();
  const repoLess = scriptedModel(() => done('x', 1));
  const plainIndex = await (await engineFor(notRepo, { adapterFactory: repoLess.factory, gates: GATES }).engine.start({
    script: `await agent('a', { isolation: 'worktree', label: 'N' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.ok(['worktree-not-a-repository', 'worktree-git-unavailable'].includes(plainIndex.dispatches[0].error.reason), plainIndex.dispatches[0].error.message);
  assert.equal(repoLess.count(), 0);
});

// ═══════════════════════════════════════════════════════════════
// 可选自动归档（默认关）的接线位
// ═══════════════════════════════════════════════════════════════

test('自动归档默认关：结算不碰它；本机设置面打开后才在结算后触发', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const probe = fakeWorktrees();
  const off = scriptedModel(() => done('x', 1));
  const offEngine = engineFor(temp, { adapterFactory: off.factory, gates: { ...GATES, autoArchive: false }, worktrees: probe.stub }).engine;
  await (await offEngine.start({ script: `await agent('a', { isolation: 'worktree', label: 'A' });\nreturn 1;`, ownerSessionId: 'sess-a' })).completion;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(probe.calls.filter((call) => call.op === 'archiveDue').length, 0, '关着时结算一条都不归档');

  const onProbe = fakeWorktrees();
  onProbe.stub.archiveDue = async (options) => { onProbe.calls.push({ op: 'archiveDue', input: options }); return []; };
  const on = scriptedModel(() => done('y', 1));
  const onEngine = engineFor(temp, { adapterFactory: on.factory, gates: { ...GATES, autoArchive: true, archiveAfterDays: 30 }, worktrees: onProbe.stub }).engine;
  await (await onEngine.start({ script: `await agent('a', { isolation: 'worktree', label: 'A' });\nreturn 1;`, ownerSessionId: 'sess-a' })).completion;
  await until(async () => onProbe.calls.some((call) => call.op === 'archiveDue'), '结算后触发归档一次');
  assert.deepEqual(onProbe.calls.find((call) => call.op === 'archiveDue').input, { autoArchive: true, archiveAfterDays: 30 }, '参数取自本机设置面');
});

// ═══════════════════════════════════════════════════════════════
// workingDir pin（选项闸把这条交给了本票）
// ═══════════════════════════════════════════════════════════════

test('workingDir 只认 git 注册表：注册过的才 rebind，未注册一律拒', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const registered = path.join(temp.workspaceDir, 'someone-elses-worktree');
  git(['worktree', 'add', '-b', 'worktree-someone', registered, 'HEAD'], temp.workspaceDir);
  fs.writeFileSync(path.join(registered, 'pin-target.txt'), 'pinned\n');

  const model = scriptedModel((request, n) => (n === 1 ? toolUse('r', 'read_file', { path: 'pin-target.txt' }) : done('pinned read', 2)));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  const index = await (await engine.start({
    script: `await agent('read the pinned tree', { workingDir: ${JSON.stringify(registered)}, tools: ['read_file'], label: 'PIN' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.equal(index.dispatches[0].status, 'completed', JSON.stringify(index.failures));
  assert.equal(index.dispatches[0].worktree, undefined, 'pin 路不建件也不登记，rebind 完就还回去');
  assert.equal(model.lastToolResult(1)?.ok, true, '边界确实挪到了那块件里');

  const fake = scriptedModel(() => done('x', 1));
  const nowhere = await (await engineFor(temp, { adapterFactory: fake.factory, gates: GATES }).engine.start({
    script: `await agent('nowhere', { workingDir: ${JSON.stringify(path.join(temp.workspaceDir, 'not-a-worktree'))}, tools: ['read_file'], label: 'BAD' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.equal(nowhere.dispatches[0].error.reason, 'worktree-not-registered');
  assert.equal(fake.count(), 0, 'pin 不上就不跑，token 一个不烧');
});

test('pin 到未注册目录不会被"看起来像 worktree"蒙住：伪造的 .git 文件照样拒', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const impostor = path.join(temp.workspaceDir, 'impostor');
  fs.mkdirSync(impostor, { recursive: true });
  fs.writeFileSync(path.join(impostor, '.git'), 'gitdir: /nowhere/worktrees/x\n');
  fs.writeFileSync(path.join(impostor, 'looks-normal.txt'), 'x');
  const model = scriptedModel(() => done('x', 1));
  const index = await (await engineFor(temp, { adapterFactory: model.factory, gates: GATES }).engine.start({
    script: `await agent('impostor', { workingDir: ${JSON.stringify(impostor)}, tools: ['read_file'], label: 'I' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.equal(index.dispatches[0].error.reason, 'worktree-not-registered');
  assert.equal(model.count(), 0);
});

test('pin 只挪读边界，不放开写权限：写面只随模块自己建出来的那件出现（ADR-0052 §11）', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const registered = path.join(temp.workspaceDir, 'borrowed-tree');
  git(['worktree', 'add', '-b', 'worktree-borrowed', registered, 'HEAD'], temp.workspaceDir);
  const model = scriptedModel(() => done('read only', 1));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  const index = await (await engine.start({
    script: `await agent('borrow', { workingDir: ${JSON.stringify(registered)}, label: 'B' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.equal(index.dispatches[0].status, 'completed', JSON.stringify(index.failures));
  assert.equal(model.toolNames(0).includes('write_file'), false, 'pin 那一轮的工具表里没有写工具');
  assert.equal(model.toolNames(0).includes('execute_cli'), true, '读面照旧');
  assert.equal(index.dispatches[0].worktree, undefined, '不建件、不登记、不计配额');
});

test('pin 路上点名要写 = 同样判败 isolation-required（写必隔离不因借树而开口子）', { skip: skipOnWin }, async () => {
  const temp = gitWorkspace();
  const registered = path.join(temp.workspaceDir, 'borrowed-for-write');
  git(['worktree', 'add', '-b', 'worktree-borrow2', registered, 'HEAD'], temp.workspaceDir);
  const model = scriptedModel(() => done('never', 1));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: GATES });
  const index = await (await engine.start({
    script: `await agent('borrow to write', { workingDir: ${JSON.stringify(registered)}, tools: ['write_file'], label: 'W' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.equal(index.dispatches[0].error.reason, 'isolation-required');
  assert.equal(model.count(), 0, '零 token');
});

test('仓库没把托管目录写进 .gitignore 也照样能建件：模块自己的账本不算用户未提交的工作', { skip: skipOnWin }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-231-')));
  TMP.push(root);
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'keep.txt'), 'original\n');
  git(['init', '-q', '-b', 'main', '.'], workspaceDir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], workspaceDir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'baseline'], workspaceDir);
  const temp = { workspaceDir, managedRoot: path.join(workspaceDir, '.myterminal'), paths: workflowPaths(path.join(workspaceDir, '.myterminal')) };
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('w', 'write_file', { path: 'first.txt', content: 'one\n' }) : done('one', 1)));
  const first = await (await engineFor(temp, { adapterFactory: model.factory, gates: GATES }).engine.start({
    script: `await agent('a', { isolation: 'worktree', tools: ['write_file'], label: 'A' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.equal(first.dispatches[0].status, 'completed', '第一条写路不被脏检查挡住：' + JSON.stringify(first.failures));
  const second = scriptedModel((request, n) => (n === 1 ? toolUse('w', 'write_file', { path: 'second.txt', content: 'two\n' }) : done('two', 1)));
  const again = await (await engineFor(temp, { adapterFactory: second.factory, gates: GATES }).engine.start({
    script: `await agent('b', { isolation: 'worktree', tools: ['write_file'], label: 'B' });\nreturn 1;`,
    ownerSessionId: 'sess-a',
  })).completion;
  assert.equal(again.dispatches[0].status, 'completed', '跑过一轮、托管根里已有账，第二条写路照样能建：' + JSON.stringify(again.failures));
  // 边界说清楚：§10/§11 的"gitignored"是对托管根布局的约定（本仓库 .gitignore:5 已钉），
  // 模块不擅自往用户仓库的 .gitignore 里写规则；这里锁的是更强的那条——
  // 就算用户没 ignore，建件的脏检查也不把我们自己的账本算成他没提交的活。
  assert.equal(git(['status', '--porcelain'], workspaceDir).trim(), '?? .myterminal/', '没 ignore 时它就是一条未跟踪目录，不是脏改动');
});
