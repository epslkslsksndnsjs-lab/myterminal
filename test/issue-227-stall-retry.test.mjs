// Workflows T4（#227）：stall 看门狗与重试——引擎级验收
//
// 覆盖（对应 #227 Acceptance criteria）：
//   AC1 停滞 / 挂死剧本（mock）重试 ≤3 且计数进终态记账；被中止的尝试不带结果回来、settled 那次为准
//   AC2 重试 prompt / 选项与首次全同（假模型收到两次相同请求可断言）；重发只换新的 abort controller
//       （脚本侧始终只见一次调用）
//   AC3 非 stall 失败（轮数上限 / 模型错误 / 缺结构化输出）零重试直接记账
//   AC4 dispatch 窗口 / 轮数时钟路径（虚拟钟）；调大需过启动校验、违例 fail-closed；clamp 仅作绝对硬顶
//
// 测试方式：引擎构造器注入假模型 + 虚拟钟 + 缩小整栈的闸门；只跑 workflows 面，不碰真端点。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkflowEngine } from '../dist/workflows/engine.js';
import { virtualClock } from '../dist/workflows/clock.js';
import { llmBackedFactory } from '../dist/workflows/adapter.js';
import { agentFile, runPaths, workflowPaths } from '../dist/workflows/paths.js';
import { agentFailure } from '../dist/workflows/failures.js';

let TMP;

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-227-'));
  TMP = dir;
  const workspaceDir = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const managedRoot = path.join(workspaceDir, '.myterminal');
  return { workspaceDir, managedRoot, paths: workflowPaths(managedRoot) };
}

async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * 假模型剧本：hook(request, callIndex, state) 决定这一笔的结局——resolve、throw、或返回挂死 Promise。
 * 计数面记录每笔请求与它拿到的 signal（用于断"重试换了新控制器、prompt/opts 全同"）。
 */
function scriptedModel(hook) {
  const state = { calls: [], signals: [], prompts: [], progress: [], countsByPrompt: new Map() };
  const factory = () => ({
    complete: async (request) => {
      state.calls.push(request);
      state.signals.push(request.signal);
      state.prompts.push(request.prompt);
      state.progress.push(request.progress);
      const n = (state.countsByPrompt.get(request.prompt) ?? 0) + 1;
      state.countsByPrompt.set(request.prompt, n);
      return hook(request, n, state);
    },
  });
  return { factory, state };
}

const NEVER = () => new Promise(() => {});

/** 挂死剧本用的整栈缩小闸门（满足嵌套校验）。 */
function clockGates(over = {}) {
  return { runGateMs: 5_000, dispatchWindowMs: 3_000, dispatchTurns: 3, stallMs: 900, reducerBudgetMs: 6_000, reducerTimeoutMs: 7_000, reduceSlackMs: 100, ...over };
}

function engineFor(temp, options) {
  const clock = options.clock ?? virtualClock();
  const engine = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock,
    audit: () => { /* 本票不重述审计契约 */ },
    adapterFactory: options.adapterFactory,
    gates: options.gates,
    concurrencyWindow: options.concurrencyWindow ?? 2,
  });
  return { engine, clock };
}

function rawLines(temp, runId) {
  const file = runPaths(temp.paths, runId).journalFile;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** 把虚拟钟推够多次 stall：每次 advance 后 flush 微任务，让弹性器排下一次尝试。 */
async function driveStall(clock, stallMs, times) {
  for (let i = 0; i < times; i++) {
    clock.advance(stallMs);
    await settle();
  }
}

afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

// ═══════════════════════════════════════════════════════════════
// AC1 挂死重试 ≤3、计数进终态记账、settled 那次为准
// ═══════════════════════════════════════════════════════════════

test('AC1 一路挂死到耗尽：重试恰好 3 次、attempts 进终态、run 不受连坐（带警告完成）', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const gates = clockGates({ dispatchWindowMs: 3_000, stallMs: 900 });
  const model = scriptedModel((request) => (request.prompt === 'slow' ? NEVER() : { text: 'ok', outputTokens: 2 }));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, clock, gates });
  const started = await engine.start({
    script: `const out = await parallel([() => agent('slow', { label: 'S' }), () => agent('well', { label: 'W' })]);return out;`,
    ownerSessionId: 'sess-a',
  });

  await settle();
  assert.equal(model.state.countsByPrompt.get('slow'), 1, '第一次尝试起跑');
  await driveStall(clock, 900, 4);
  const index = await started.completion;

  const slow = index.dispatches.find((d) => d.label === 'S');
  assert.equal(slow.status, 'failed');
  assert.equal(slow.error.kind, 'stalled');
  assert.equal(slow.attempts, 3, '重试次数进该路终态记账（含首次共 3）');
  assert.equal(model.state.countsByPrompt.get('slow'), 3, '挂死那路总计只被调用 3 次（≤3）');
  assert.equal(index.dispatches.find((d) => d.label === 'W').status, 'completed', '其余路不受连坐');
  assert.equal(index.failures.filter((f) => f.label === 'S').length, 1, 'stalled 具名条目进失败清单');
  assert.equal(index.status, 'completed', '部分失败仍 completed（带警告交付）');
  assert.equal(rawLines(temp, started.runId).filter((r) => r.type === 'failed').length, 1);
});

test('AC1 第 2 次尝试恢复：以 settled 那次为准、被中止的尝试不带结果回来', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const gates = clockGates({ stallMs: 900 });
  // slow 第一次挂死（被 stall 弃）、第二次给出真结果。
  const model = scriptedModel((request, n) => {
    if (request.prompt !== 'slow') return { text: 'x', outputTokens: 1 };
    if (n === 1) return NEVER();
    return { text: 'recovered', outputTokens: 7 };
  });
  const { engine } = engineFor(temp, { adapterFactory: model.factory, clock, gates });
  const started = await engine.start({ script: `const v = await agent('slow', { label: 'S' });return v;`, ownerSessionId: 'sess-a' });

  await settle();
  await driveStall(clock, 900, 2);
  const index = await started.completion;

  const slow = index.dispatches[0];
  assert.equal(slow.status, 'completed', '第二次 settled 即该路结果');
  assert.equal(slow.attempts, 2);
  assert.equal(index.tokens.spent, 7, '只有 settled 那次的用量进账（挂死那次不带 token 回来）');
  assert.equal(fs.readFileSync(agentFile(runPaths(temp.paths, started.runId), slow.id), 'utf8').includes('recovered'), true);
  assert.equal(model.state.countsByPrompt.get('slow'), 2, '成功后不再重试第三次');
});

// ═══════════════════════════════════════════════════════════════
// AC2 重试请求与首次全同、只换控制器、脚本侧只见一次调用
// ═══════════════════════════════════════════════════════════════

test('AC2 重试的 prompt / 选项与首次逐字段全同，signal 换新，缓存键与每路文件各一份', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const gates = clockGates({ stallMs: 900 });
  const model = scriptedModel((request, n) => (n === 1 ? NEVER() : { text: 'second', outputTokens: 3 }));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, clock, gates });
  const started = await engine.start({
    script: `const v = await agent('r', { label: 'R', model: 'm1' });return v;`,
    ownerSessionId: 'sess-a',
  });
  await settle();
  await driveStall(clock, 900, 2);
  const index = await started.completion;

  assert.equal(model.state.calls.length, 2, '两次尝试 = 两次模型调用');
  const [first, second] = model.state.calls;
  assert.equal(first.prompt, second.prompt, 'prompt 逐字符相同');
  assert.equal(first.system, second.system, 'system 相同');
  assert.equal(first.maxTokens, second.maxTokens, '输出上限相同');
  assert.equal(first.model, 'm1');
  assert.equal(second.model, 'm1', 'opts 全同 → 缓存键不变');
  assert.notEqual(first.signal, second.signal, '重发只换新的 abort controller');
  // 脚本侧只见一次 agent()：一个 admission、一个 dispatch、一个每路文件、一条 result 行。
  assert.equal(index.dispatches.length, 1, '重试不新占键位 / 不新起一路');
  assert.equal(index.dispatches[0].attempts, 2);
  assert.equal(rawLines(temp, started.runId).filter((r) => r.type === 'result').length, 1);
  assert.equal(fs.existsSync(agentFile(runPaths(temp.paths, started.runId), 'd0001')), true);
});

// ═══════════════════════════════════════════════════════════════
// AC3 非 stall 失败零重试、直接记账
// ═══════════════════════════════════════════════════════════════

test('AC3 模型错误 / 已归类失败 / 缺结构化输出：各只被调用一次（不重试）', async () => {
  const cases = [
    ['模型错误', () => { throw new Error('model exploded'); }, 'error'],
    ['轮数上限（尝试自抛）', () => { throw agentFailure('max_turns', 'cap'); }, 'max_turns'],
    ['启动错误', () => { throw new Error('adapter could not start'); }, 'error'],
  ];
  for (const [title, fail, expectedKind] of cases) {
    const temp = tempWorkspace();
    const model = scriptedModel((request) => {
      if (request.prompt === 'sick') return fail();
      return { text: 'fine', outputTokens: 1 };
    });
    const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: clockGates() });
    const started = await engine.start({ script: `const bad = await agent('sick', { label: 'S' });return bad;`, ownerSessionId: 'sess-a' });
    const index = await started.completion;
    assert.equal(index.dispatches[0].status, 'failed', `${title}：该路判败`);
    assert.equal(index.dispatches[0].error.kind, expectedKind, `${title}：种类 ${expectedKind}`);
    assert.equal(index.dispatches[0].attempts, 1, `${title}：非 stall 不重试`);
    assert.equal(model.state.countsByPrompt.get('sick'), 1, `${title}：只被调用一次`);
    fs.rmSync(temp.workspaceDir, { recursive: true, force: true });
  }
});

test('AC3 缺结构化输出零重试：schema 路拿到非 JSON 也只调一次', async () => {
  const temp = tempWorkspace();
  const model = scriptedModel(() => ({ text: 'not json at all', outputTokens: 4 }));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: clockGates() });
  const started = await engine.start({
    script: `const a = await agent('j', { schema: { type: 'object', properties: { a: { type: 'number' } } }, label: 'J' });return a;`,
    ownerSessionId: 'sess-a',
  });
  const index = await started.completion;
  assert.equal(index.dispatches[0].error.kind, 'no_structured_output');
  assert.equal(index.dispatches[0].attempts, 1, '缺结构化输出是确定性终态，不重试');
  assert.equal(model.state.calls.length, 1);
});

// ═══════════════════════════════════════════════════════════════
// AC4 dispatch 窗口 / 轮数时钟路径 + 启动校验
// ═══════════════════════════════════════════════════════════════

test('AC4 dispatch 窗口到期 → timeout、不重试（虚拟钟；stall 还没到就先撞墙）', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const gates = clockGates({ stallMs: 900, dispatchWindowMs: 300 });
  const model = scriptedModel(() => NEVER());
  const { engine } = engineFor(temp, { adapterFactory: model.factory, clock, gates });
  const started = await engine.start({ script: `return await agent('wall', { label: 'W' });`, ownerSessionId: 'sess-a' });

  await settle();
  clock.advance(300);
  await settle();
  const index = await started.completion;

  assert.equal(index.dispatches[0].error.kind, 'timeout', '窗口到期即 timeout，不是 stalled');
  assert.equal(index.dispatches[0].attempts, 1, 'timeout 是确定性终态，不触发重试');
  assert.equal(model.state.calls.length, 1);
});

test('AC4 轮数越界 → max_turns、不重试（进展通道上报第 dispatchTurns+1 轮触顶）', async () => {
  const temp = tempWorkspace();
  const model = scriptedModel((request) => {
    // 一口气上报 4 轮（> dispatchTurns=3）：第 4 轮即触顶，随后挂死也不影响判定。
    for (let i = 0; i < 4; i++) request.progress.round();
    return NEVER();
  });
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: clockGates({ stallMs: 900, dispatchWindowMs: 3_000, dispatchTurns: 3 }) });
  const started = await engine.start({ script: `return await agent('t', { label: 'T' });`, ownerSessionId: 'sess-a' });
  await settle();
  const index = await started.completion;
  assert.equal(index.dispatches[0].error.kind, 'max_turns');
  assert.equal(index.dispatches[0].attempts, 1, '轮数越界不重试');
  assert.equal(model.state.calls.length, 1);
});

test('AC4 调大逐路窗口击穿嵌套 → 启动校验 fail-closed（FORBIDDEN），clamp 只是绝对硬顶', async () => {
  const temp = tempWorkspace();
  // 默认 runGate 30min：逐路上限 = 30 − reduceSlack 5 = 25min。60min 在 clamp 100min 之内，
  // 却击穿嵌套——证明有效上限由启动校验裁定，clamp 只是绝对硬顶。
  const tooWide = clockGates({
    runGateMs: 30 * 60_000,
    dispatchWindowMs: 60 * 60_000,
    stallMs: 180_000,
    reducerBudgetMs: 35 * 60_000,
    reducerTimeoutMs: 40 * 60_000,
    reduceSlackMs: 5 * 60_000,
  });
  const rejectEngine = engineFor(temp, { adapterFactory: scriptedModel(() => ({ text: 'x', outputTokens: 1 })).factory, gates: tooWide }).engine;
  await assert.rejects(
    () => rejectEngine.start({ script: `return 1;`, ownerSessionId: 'sess-a' }),
    (error) => error.code === 'FORBIDDEN' && error.reason === 'clock-nesting',
    '越嵌套界必须拒启动，违例码 FORBIDDEN',
  );

  // 合规值（20min < 25min）放行。
  const ok = clockGates({
    runGateMs: 30 * 60_000,
    dispatchWindowMs: 20 * 60_000,
    stallMs: 180_000,
    reducerBudgetMs: 35 * 60_000,
    reducerTimeoutMs: 40 * 60_000,
    reduceSlackMs: 5 * 60_000,
  });
  const okEngine = engineFor(temp, { adapterFactory: scriptedModel(() => ({ text: 'x', outputTokens: 1 })).factory, gates: ok }).engine;
  const started = await okEngine.start({ script: `return 1;`, ownerSessionId: 'sess-a' });
  const index = await started.completion;
  assert.equal(index.status, 'completed', '嵌套合规的窗口放行');
});

test('AC5 集成：引擎注入的虚拟钟同时驱动传输 backoff（两层共用一只钟、backoff<stall 不误判整路重试）', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  let creates = 0;
  // 走真实 llmBackedFactory（其 withTransientRetry 用引擎注入的这只钟），只把端点换成 make()。
  const make = () => ({
    provider: 'fake',
    stream: async function* () { /* 非流式 */ },
    create: async () => {
      creates += 1;
      if (creates === 1) { const e = new Error('rate limited'); e.name = 'LlmError'; e.kind = 'rate_limit'; throw e; }
      return { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { input_tokens: 0, output_tokens: 4 } };
    },
  });
  const factory = llmBackedFactory(
    { enabled: true, model: 'm', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', maxTurns: 700, timeoutSec: 7200, maxParallel: 2 },
    make,
  );
  // stall(3000) 远大于首档 backoff(2000)：传输层在同一只钟上退避补枪，绝不被看门狗判成无进展。
  const { engine } = engineFor(temp, { adapterFactory: factory, clock, gates: clockGates({ stallMs: 3_000, dispatchWindowMs: 4_000 }) });
  const started = await engine.start({ script: `return await agent('p', { label: 'P' });`, ownerSessionId: 'sess-a' });

  await settle();
  assert.equal(creates, 1, '第一枪瞬态失败，正在 backoff');
  clock.advance(2_000); // 走完首档 backoff（2s）
  const index = await started.completion;

  assert.equal(creates, 2, '退避后同一路补枪成功');
  assert.equal(index.dispatches[0].status, 'completed');
  assert.equal(index.dispatches[0].attempts, 1, '传输层重试对 dispatch 透明：stall 尝试数仍是 1');
  assert.equal(index.tokens.spent, 4, '失败那一枪不带 token 回来，只记 settled 那次');
});
