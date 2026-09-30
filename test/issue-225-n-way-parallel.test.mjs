// Workflows T2（#225）：N 路并发执行——票面验收
//
// 验收覆盖（对应 #225 Acceptance criteria）：
//   AC1 多路 run（假模型）窗口内滚动补位：任一路结算即起下一路（并发水位 + 补位序）
//   AC2 parallel() / pipeline() 语义钉死：默认 pipeline 无组间栅栏、显式分段才有栅栏；
//       await + 变量传递（agent 间零通信）为唯一数据流
//   AC3 workflow(name) 嵌套限单层（第二层 throw）；嵌套共享同 run 预算 / 并发窗口 / registry
//   AC4 键序 = 脚本调用序（admission）；乱序完成后 journal 归位与键序不变
//   AC5 每路独立 adapter 实例（可计数，非共享实例）
//   AC6 三态结算：null（一切沉默）/ reject（调用形状错）/ throw（run 级终结）
//   AC7 run 级判定：终态只有机器三态；全败 → failed；部分失败 → completed（带警告）；无"几路算过"阈值
//   AC8 isolation:'worktree' 选项面透传与记账（隔离实现属 T8）
//   AC9 第一版不做上下文压缩：撞上下文上限 = 该路失败记账（负向声明）
//
// 测试方式：引擎构造器注入假模型 + 虚拟钟 + 显式并发窗口；只跑 workflows 面，不碰真端点。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkflowEngine } from '../dist/workflows/engine.js';
import { virtualClock } from '../dist/workflows/clock.js';
import { Journal } from '../dist/workflows/journal.js';
import { runPaths, workflowPaths } from '../dist/workflows/paths.js';
import { readIndex } from '../dist/workflows/run-index.js';
import { deriveAgentKey, argsChainSeed } from '../dist/workflows/keys.js';
import { agentFailure } from '../dist/workflows/failures.js';

let TMP;

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-225-'));
  TMP = dir;
  const workspaceDir = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const managedRoot = path.join(workspaceDir, '.myterminal');
  return { workspaceDir, managedRoot, paths: workflowPaths(managedRoot) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 让 promise 链跑若干轮（窗口与沙箱都不依赖定时器，0ms 足够）。 */
async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * 假模型剧本：每次调用可挂起（gate）、可抛错、可返回文本。
 * 计数面：adapter 实例数、调用序、在飞水位与最高水位——都是票面要断言的量。
 */
function scripted(behave) {
  const state = {
    instances: 0,
    instanceIds: [],
    contexts: [],
    calls: [],
    prompts: [],
    live: 0,
    highWater: 0,
    signals: [],
  };
  const factory = (context) => {
    const instanceId = ++state.instances;
    state.contexts.push(context);
    return {
      complete: async (request) => {
        state.instanceIds.push(instanceId);
        state.calls.push(request);
        state.prompts.push(request.prompt);
        state.live += 1;
        state.highWater = Math.max(state.highWater, state.live);
        state.signals.push(request.signal);
        try {
          const outcome = behave ? await behave(request, state.calls.length - 1, instanceId) : { text: `answer:${request.prompt}`, outputTokens: 3 };
          if (outcome && outcome.raise) throw outcome.raise;
          return outcome ?? { text: '', outputTokens: 0 };
        } finally {
          state.live -= 1;
        }
      },
    };
  };
  return { factory, state };
}

/** 按 prompt 挂起的手闸：release(prompt) 才让那一路结算。 */
function gateBox(defaultText = (prompt) => `done:${prompt}`) {
  const gates = new Map();
  // 闸按 prompt 建：先 release 后起跑也成立（"这一路不用等"），否则补位断言会撞空闸。
  const gate = (key) => {
    if (!gates.has(key)) gates.set(key, deferred());
    return gates.get(key);
  };
  const behave = async (request) => {
    const key = request.prompt;
    const value = await gate(key).promise;
    return { text: defaultText(key), outputTokens: 3, ...(value && value.__tokens !== undefined ? { outputTokens: value.__tokens } : {}) };
  };
  return { behave, gate, release: (key, value) => gate(key).resolve(value ?? true) };
}

function engineFor(temp, options = {}) {
  const clock = options.clock ?? virtualClock();
  const events = [];
  const engine = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock,
    audit: () => { /* 票面不重述 T1 的审计契约 */ },
    adapterFactory: options.adapterFactory,
    events: options.events,
    thresholds: options.thresholds,
    ...(options.concurrencyWindow !== undefined ? { concurrencyWindow: options.concurrencyWindow } : {}),
  });
  return { engine, clock, events };
}

function journalRows(temp, runId) {
  return Journal.open(runPaths(temp.paths, runId).journalFile);
}

function rawLines(temp, runId) {
  const file = runPaths(temp.paths, runId).journalFile;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

// ═══════════════════════════════════════════════════════════════
// AC1 滚动补位：全员入队，任一路结算即补下一路
// ═══════════════════════════════════════════════════════════════

const FIVE_WIDE = `const items = [0,1,2,3,4].map((i) => () => agent('p' + i, { label: 'L' + i }));
const results = await parallel(items);
return { ok: results.length };`;

test('AC1 窗口内滚动补位：水位不越限、补位序 = admission 序', async () => {
  const temp = tempWorkspace();
  const box = gateBox();
  const model = scripted(box.behave);
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2 });
  const started = await engine.start({ script: FIVE_WIDE, ownerSessionId: 'sess-a' });

  await settle();
  assert.deepEqual(model.state.prompts, ['p0', 'p1'], '窗口 2：只起两路');
  assert.equal(model.state.highWater, 2);
  assert.equal(model.state.live, 2);

  // N 路全员入队：五路都已 admission（账上有五条 started），只有两路真在飞。
  const rows = rawLines(temp, started.runId);
  assert.equal(rows.filter((r) => r.type === 'started').length, 5, '全员入队 = 五路都已记账');

  // 第二路先结算 → 补第三路（不是等整组跑完）
  box.release('p1');
  await settle();
  assert.deepEqual(model.state.prompts, ['p0', 'p1', 'p2'], '任一路结算即补下一路');

  // 补位按 admission：p0 结算后补的是 p3（第三个入队的），不是最后入队的 p4。
  box.release('p0');
  await settle();
  assert.deepEqual(model.state.prompts, ['p0', 'p1', 'p2', 'p3'], '补位序 = admission 序');
  box.release('p4');
  await settle();
  assert.equal(model.state.prompts.length, 4, 'p4 提前放行手闸也排不到前面——窗口只认队列');
  box.release('p2');
  await settle();
  assert.deepEqual(model.state.prompts, ['p0', 'p1', 'p2', 'p3', 'p4'], '腾出槽位即补最后一队');

  for (const key of ['p3', 'p4']) box.release(key);
  const index = await started.completion;
  assert.equal(index.status, 'completed');
  assert.equal(model.state.highWater, 2, '全程水位从未越过窗口');
  assert.deepEqual(index.dispatches.map((d) => d.label), ['L0', 'L1', 'L2', 'L3', 'L4'], '索引按 admission 归位');
  assert.deepEqual(index.dispatches.map((d) => d.status), ['completed', 'completed', 'completed', 'completed', 'completed']);
});

test('AC1 窗口默认值与硬顶：注入窗口才生效，默认走核数公式', async () => {
  const temp = tempWorkspace();
  const model = scripted();
  const { engine } = engineFor(temp, { adapterFactory: model.factory });
  assert.ok(engine.windowLimit >= 2 && engine.windowLimit <= 16, `默认窗口 = max(2, min(16, 核数−2))，实得 ${engine.windowLimit}`);
  const pinned = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 1 });
  assert.equal(pinned.engine.windowLimit, 1, '注入窗口即所断言窗口');
});

// ═══════════════════════════════════════════════════════════════
// AC2 parallel / pipeline 语义：栅栏只在显式分段处出现
// ═══════════════════════════════════════════════════════════════

test('AC2 pipeline 默认无组间栅栏：第一路第二段可在其余第一段未结算时起', async () => {
  const temp = tempWorkspace();
  const box = gateBox();
  const model = scripted(box.behave);
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 3 });
  const script = `const out = await pipeline([0,1,2],
  (prev, item) => agent('draft-' + item),
  (prev, item) => agent('polish:' + prev + ':' + item));
return out.length;`;
  const started = await engine.start({ script, ownerSessionId: 'sess-a' });
  await settle();
  assert.deepEqual(model.state.prompts, ['draft-0', 'draft-1', 'draft-2'], '三路同时起步');

  box.release('draft-0');
  await settle();
  assert.deepEqual(model.state.prompts, ['draft-0', 'draft-1', 'draft-2', 'polish:done:draft-0:0'], '只有 0 号进入第二段，无栅栏');
  assert.equal(model.state.prompts.filter((p) => p.startsWith('polish')).length, 1, '其余两路仍卡在第一段（各自独立）');

  box.release('draft-1');
  box.release('draft-2');
  for (const k of ['polish:done:draft-0:0', 'polish:done:draft-1:1', 'polish:done:draft-2:2']) box.release(k);
  const index = await started.completion;
  assert.equal(index.status, 'completed');
  assert.deepEqual(index.dispatches.map((d) => d.label), ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5', 'agent-6'], '六路按 admission 序记账');
});

test('AC2 pipeline 的 null 是哨兵：上一段没交回结果该 item 止步，0 / 空串仍算合法值', async () => {
  const temp = tempWorkspace();
  const model = scripted();
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 3 });
  const script = `const out = await pipeline([0,1,2],
  (prev, item) => item === 1 ? null : (item === 0 ? 0 : ''),
  (prev, item) => agent('stage2-' + item + ':' + prev));
return out.filter((v) => v !== null).length;`;
  const started = await engine.start({ script, ownerSessionId: 'sess-a' });
  const index = await started.completion;
  assert.equal(index.status, 'completed', JSON.stringify(index.failures));
  assert.deepEqual(model.state.prompts, ['stage2-0:0', 'stage2-2:'], '只有 null 短路，0 与空串照常传递');
  assert.equal(index.dispatches.length, 2, '1 号 item 不进第二段');
});

test('AC2 显式分段才出现栅栏：第二段全部等第一段结算完', async () => {
  const temp = tempWorkspace();
  const box = gateBox();
  const model = scripted(box.behave);
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 4 });
  const script = `const first = await parallel([0,1,2].map((i) => () => agent('group1-' + i)));
const second = await parallel(first.map((v, i) => () => agent('group2-' + i)));
return [first.length, second.length];`;
  const started = await engine.start({ script, ownerSessionId: 'sess-a' });
  await settle();
  assert.deepEqual(model.state.prompts, ['group1-0', 'group1-1', 'group1-2'], '栅栏前只有第一组');
  box.release('group1-0');
  await settle();
  assert.equal(model.state.prompts.some((p) => p.startsWith('group2')), false, '第一组未全结算 → 一组都不起');
  box.release('group1-1');
  box.release('group1-2');
  await settle();
  assert.deepEqual(model.state.prompts.slice(3), ['group2-0', 'group2-1', 'group2-2'], '栅栏后整组齐发');
  for (const k of ['group2-0', 'group2-1', 'group2-2']) box.release(k);
  assert.equal((await started.completion).status, 'completed');
});

test('AC2 数据只经脚本变量：上游文本被下游 prompt 字面携带', async () => {
  const temp = tempWorkspace();
  const model = scripted(async (request) => ({ text: `[${request.prompt}]`, outputTokens: 2 }));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2 });
  const script = `const a = await agent('first');
const b = await agent('second-sees:' + a);
return b;`;
  const started = await engine.start({ script, ownerSessionId: 'sess-a' });
  const index = await started.completion;
  assert.equal(index.status, 'completed');
  assert.deepEqual(model.state.prompts, ['first', 'second-sees:[first]'], '零通信：数据靠变量传递');
});

test('AC2 沙箱注入面钉死：脚本语义齐备，通道件与控制面一概不可达', async () => {
  const temp = tempWorkspace();
  const { engine } = engineFor(temp, { adapterFactory: scripted().factory });
  // 探针脚本自带断言：面不对就抛，run 即红——两向都可观测（终态 status）。
  const surface = `const have = [typeof agent === 'function', typeof parallel === 'function', typeof pipeline === 'function',
  typeof workflow === 'function', typeof log === 'function', typeof phase === 'function',
  typeof args !== 'undefined', typeof budget === 'object' && budget !== null];
if (have.some((x) => !x)) throw new Error('sandbox surface missing: ' + JSON.stringify(have));
const banned = ['subagent_start', 'subagent_status', 'message_send', 'message_inbox', 'workflow_start', 'workflow_cancel', 'require', 'process', 'fetch', 'global', 'Buffer'];
for (const name of banned) { if (typeof globalThis[name] !== 'undefined') throw new Error('sandbox leaked ' + name); }
return 1;`;
  const ok = await engine.start({ script: surface, ownerSessionId: 'sess-a' });
  const index = await ok.completion;
  assert.equal(index.status, 'completed', `注入面不符合契约：${index.reason}`);
  assert.deepEqual(index.dispatches, [], '纯探针不派发');
});

test('AC2 子 agent 拿不到宿主件：console 存在而 require / process 不可达', async () => {
  const temp = tempWorkspace();
  const { engine } = engineFor(temp, { adapterFactory: scripted().factory });
  const probe = `if (typeof require !== 'undefined') throw new Error('require reachable');
if (typeof process !== 'undefined') throw new Error('process reachable');
if (typeof globalThis.process === 'undefined') return 1;
throw new Error('process on globalThis');`;
  const started = await engine.start({ script: probe, ownerSessionId: 'sess-a' });
  assert.equal((await started.completion).status, 'completed');
});

// ═══════════════════════════════════════════════════════════════
// AC3 workflow(name) 嵌套：限单层，共享同 run 预算 / 窗口 / registry
// ═══════════════════════════════════════════════════════════════

function writeSaved(temp, name, source) {
  fs.mkdirSync(temp.paths.savedRoot, { recursive: true });
  fs.writeFileSync(path.join(temp.paths.savedRoot, `${name}.js`), source, { mode: 0o600 });
}

test('AC3 workflow(name) 复用已保存脚本，嵌套路数进同一 run 账', async () => {
  const temp = tempWorkspace();
  writeSaved(temp, 'child', `export const meta = { name: 'child', description: 'child' };\nconst c = await agent('child-path');\nreturn c;`);
  const model = scripted();
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2 });
  const started = await engine.start({ script: `const r = await workflow('child', { target: 'x' });\nreturn { r };`, ownerSessionId: 'sess-a' });
  const index = await started.completion;
  assert.equal(index.status, 'completed', JSON.stringify(index.failures));
  assert.deepEqual(model.state.prompts, ['child-path'], '嵌套脚本真的跑在同一个 run 里');
  assert.equal(index.dispatches.length, 1);
  assert.equal(index.dispatches[0].seq, 1, '嵌套不重置 admission 序');
  assert.equal(registryRunCount(temp), 1, '共享同一 run 的注册表条目');
});

test('AC3 第二层嵌套 throw：孙层脚本一步都不跑', async () => {
  const temp = tempWorkspace();
  writeSaved(temp, 'grandchild', `const g = await agent('never-runs');\nreturn g;`);
  writeSaved(temp, 'child', `const r = await workflow('grandchild');\nreturn r;`);
  const model = scripted();
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2 });
  const started = await engine.start({ script: `await workflow('child');\nreturn 'unreachable';`, ownerSessionId: 'sess-a' });
  const index = await started.completion;
  assert.equal(index.status, 'failed', '第二层嵌套 = run 级失败');
  assert.match(index.reason, /script-failed|nesting/);
  assert.equal(model.state.prompts.includes('never-runs'), false, '孙层绝不执行');
  assert.equal(index.dispatches.length, 0, '一层都没派发');
});

test('AC3 嵌套共享并发窗口与预算：窗口 1 时父子合计不越限', async () => {
  const temp = tempWorkspace();
  writeSaved(temp, 'child', `const b = await agent('child-b');\nconst c = await agent('child-c');\nreturn [b, c];`);
  const box = gateBox();
  const model = scripted(box.behave);
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 1 });
  const started = await engine.start({
    script: `const fan = await parallel([() => agent('parent-a'), () => workflow('child')]);\nreturn fan.length;`,
    ownerSessionId: 'sess-a',
  });
  await settle();
  assert.deepEqual(model.state.prompts, ['parent-a'], '窗口 1：一次只一路');
  box.release('parent-a');
  await settle();
  assert.deepEqual(model.state.prompts, ['parent-a', 'child-b'], '父子共用同一个窗口排队');
  assert.equal(model.state.highWater, 1, '合计水位仍不越限（嵌套不另开窗口）');
  for (const k of ['child-b', 'child-c']) box.release(k);
  const index = await started.completion;
  assert.equal(index.status, 'completed', JSON.stringify(index.failures));
  assert.equal(index.tokens.spent, 3 * 3, '预算合计：三路一份账');
  assert.deepEqual(index.dispatches.map((d) => d.seq ?? d.id), [1, 2, 3], 'admission 序连续共享');
});

test('AC3 saved 脚本头部 meta 被执行前剥掉（真脚本都带 meta），括号不平衡即拒', async () => {
  const temp = tempWorkspace();
  writeSaved(temp, 'withmeta', `export const meta = {
  name: 'withmeta',
  description: 'a saved script',
  phases: [{ title: 'Collect' }],
};
const r = await agent('meta-path', { label: 'meta-path' });
return r;`);
  const model = scripted();
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 1 });
  const started = await engine.start({ script: `await workflow('withmeta');return 1;`, ownerSessionId: 'sess-a' });
  const index = await started.completion;
  assert.equal(index.status, 'completed', `meta 块不得让脚本编译失败：${index.reason}`);
  assert.deepEqual(model.state.prompts, ['meta-path']);

  // 静默截断是历史最坏失败模式：不平衡大括号必须抛，不许剥一半。
  const broken = engineFor(temp, { adapterFactory: scripted().factory });
  const badRun = await broken.engine.start({ script: `export const meta = { name: 'oops', phases: [{ title: 'x' }\nreturn 1;`, ownerSessionId: 'sess-b' });
  const badIndex = await badRun.completion;
  assert.equal(badIndex.status, 'failed', '不平衡的 meta 块拒执行');
});

test('AC3 workflow 名称面：路径形态当名字用即拒，未保存的名字也拒', async () => {
  const temp = tempWorkspace();
  const model = scripted();
  const { engine } = engineFor(temp, { adapterFactory: model.factory });
  const asPath = await engine.start({ script: `await workflow('./saved/child.js');\nreturn 1;`, ownerSessionId: 'sess-a' });
  assert.equal((await asPath.completion).status, 'failed', '裸路径不是合法名字');
  const missing = await engine.start({ script: `await workflow('nope');\nreturn 1;`, ownerSessionId: 'sess-a' });
  const index = await missing.completion;
  assert.equal(index.status, 'failed');
  assert.equal(model.state.calls.length, 0, '两种情况都不烧 token');
});

function registryRunCount(temp) {
  const file = temp.paths.registryFile;
  if (!fs.existsSync(file)) return 0;
  return JSON.parse(fs.readFileSync(file, 'utf8')).runs.length;
}

// ═══════════════════════════════════════════════════════════════
// AC4 键序 = 脚本调用序；乱序完成后 journal 与索引归位不变
// ═══════════════════════════════════════════════════════════════

test('AC4 乱序完成：键链按 admission，账本与索引归位不动', async () => {
  const temp = tempWorkspace();
  const box = gateBox();
  const model = scripted(box.behave);
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 4 });
  const script = `const out = await parallel([0,1,2,3].map((i) => () => agent('call-' + i, { label: 'K' + i, phase: 'P' + i })));
return out.length;`;
  const started = await engine.start({ script, args: { run: 'seed' }, ownerSessionId: 'sess-a' });
  await settle();

  const rows = rawLines(temp, started.runId);
  const startedRows = rows.filter((r) => r.type === 'started');
  assert.deepEqual(startedRows.map((r) => r.seq), [1, 2, 3, 4], 'admission 序入账');
  for (const row of startedRows) assert.match(row.key, /^v2:[0-9a-f]{64}$/, '每路都有前缀哈希链键');
  const keys = startedRows.map((r) => r.key);
  assert.equal(new Set(keys).size, 4, '四路四键，互不相同');

  // 反序结算：3、1、4、2
  for (const key of ['call-2', 'call-0', 'call-3', 'call-1']) box.release(key);
  const index = await started.completion;

  assert.deepEqual(index.dispatches.map((d) => d.label), ['K0', 'K1', 'K2', 'K3'], '索引按 admission 归位，与完成序无关');
  const resultRows = rawLines(temp, started.runId).filter((r) => r.type === 'result');
  assert.deepEqual(resultRows.map((r) => r.seq), [1, 2, 3, 4], 'journal 结果行按 admission 归位');
  assert.deepEqual(resultRows.map((r) => r.key), keys, '键序不随完成序漂移');

  // 链本身可复算：前缀 + prompt + 归一 opts 逐步滚动
  let prefix = argsChainSeed({ run: 'seed' });
  for (let i = 0; i < 4; i++) {
    const next = deriveAgentKey(prefix, `call-${i}`, '{}');
    assert.equal(next, keys[i], `第 ${i + 1} 路键 = H(前一路键, 本路入参)`);
    prefix = next;
  }
});

test('AC4 纯展示项不进键：同一位置只换 label / phase / stepId → 键不变', async () => {
  // 链上的两个位置本来就不同键（前缀不同）；要断的是"同一位置、只改展示项"不换键。
  const first = tempWorkspace();
  const engineA = engineFor(first, { adapterFactory: scripted().factory }).engine;
  const runA = await engineA.start({ script: `await agent('same', { label: 'one', phase: 'A', stepId: 's1', stallMs: 900 });return 1;`, ownerSessionId: 'sess-a' });
  await runA.completion;
  const keyA = rawLines(first, runA.runId).filter((r) => r.type === 'started')[0].key;

  const second = tempWorkspace();
  const engineB = engineFor(second, { adapterFactory: scripted().factory }).engine;
  const runB = await engineB.start({ script: `await agent('same', { label: 'two', phase: 'B', stepId: 's2', stallMs: 100 });return 1;`, ownerSessionId: 'sess-a' });
  await runB.completion;
  const keyB = rawLines(second, runB.runId).filter((r) => r.type === 'started')[0].key;

  assert.equal(keyA, keyB, '展示项与计时件都不进键');

  const third = tempWorkspace();
  const engineC = engineFor(third, { adapterFactory: scripted().factory }).engine;
  const runC = await engineC.start({ script: `await agent('same', { model: 'other' });return 1;`, ownerSessionId: 'sess-a' });
  await runC.completion;
  const keyC = rawLines(third, runC.runId).filter((r) => r.type === 'started')[0].key;
  assert.notEqual(keyA, keyC, '行为相关项（model）换键');
});

// ═══════════════════════════════════════════════════════════════
// AC5 每路独立 adapter 实例
// ═══════════════════════════════════════════════════════════════

test('AC5 每路一个独立 adapter 实例（可计数，非共享）', async () => {
  const temp = tempWorkspace();
  const model = scripted();
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 3 });
  const started = await engine.start({
    script: `await parallel([0,1,2].map((i) => () => agent('i' + i)));return 1;`,
    ownerSessionId: 'sess-a',
  });
  await started.completion;
  assert.equal(model.state.instances, 3, '三路 = 三个实例');
  assert.equal(new Set(model.state.instanceIds).size, 3, '每次调用来自互不相同的实例');
  assert.deepEqual([...new Set(model.state.contexts.map((c) => c.runId))], [started.runId], '工厂上下文带本 run 的 runId');
  assert.equal(new Set(model.state.contexts.map((c) => c.dispatchId)).size, 3, '槽位各不同');
  assert.deepEqual(model.state.contexts.map((c) => c.dispatchId), ['d0001', 'd0002', 'd0003'], '槽位 = admission 序');

  // 第二条 run 不得复用上一批实例
  const again = await engine.start({ script: `await agent('again');return 1;`, ownerSessionId: 'sess-a' });
  await again.completion;
  assert.equal(model.state.instances, 4);
});

// ═══════════════════════════════════════════════════════════════
// AC6 三态结算
// ═══════════════════════════════════════════════════════════════

test('AC6 一切沉默坍缩为 null，并作为具名条目连 error 记入索引与账本', async () => {
  const cases = [
    ['轮数上限', agentFailure('max_turns', 'turn budget spent')],
    ['时间上限', agentFailure('timeout', 'dispatch window expired')],
    ['模型错误', new Error('model exploded')],
    ['启动错误', new Error('adapter could not start')],
    ['stall 重试耗尽', agentFailure('stalled', 'no progress on all attempts')],
    ['首响应前死亡', undefined],
  ];
  for (const [title, raised] of cases) {
    const temp = tempWorkspace();
    const model = scripted(async (request) => {
      if (request.prompt !== 'sick') return { text: `well:${request.prompt}`, outputTokens: 2 };
      if (raised === undefined) return { text: '', outputTokens: 0 };
      throw raised;
    });
    const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2 });
    const started = await engine.start({
      script: `const bad = await agent('sick', { label: 'sick' });
const good = await agent('well', { label: 'well' });
return { bad, good };`,
      ownerSessionId: 'sess-a',
    });
    const index = await started.completion;
    const sick = index.dispatches.find((d) => d.label === 'sick');
    assert.equal(sick.status, 'failed', `${title}：该路判败`);
    assert.ok(sick.error.kind, `${title}：错误有种类`);
    assert.equal(index.failures.filter((f) => f.label === 'sick').length, 1, `${title}：具名条目连 error 进 failures`);
    assert.equal(index.dispatches.find((d) => d.label === 'well').status, 'completed', `${title}：其余路不受连坐`);
    assert.equal(index.status, 'completed', `${title}：部分失败仍 completed（带警告）`);
    const rows = rawLines(temp, started.runId);
    assert.equal(rows.filter((r) => r.type === 'failed').length, 1, `${title}：失败进账`);
    assert.equal(rows.filter((r) => r.type === 'result').length, 1, `${title}：失败不写 result 行`);
    assert.equal(model.state.calls.length, 2, `${title}：沉默不重试（该路只被调用一次）`);
    fs.rmSync(temp.workspaceDir, { recursive: true, force: true });
  }
});

test('AC6 缺结构化输出 = 该路失败并具名记账', async () => {
  const temp = tempWorkspace();
  const model = scripted(async (request) => ({ text: request.prompt === 'json' ? '{"a":1}' : 'not json at all', outputTokens: 4 }));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2 });
  const started = await engine.start({
    script: `const a = await agent('json', { schema: { type: 'object', properties: { a: { type: 'number' } } }, label: 'schema-ok' });
const b = await agent('plain', { schema: { type: 'object', properties: { a: { type: 'number' } } }, label: 'schema-missing' });
return { a, b };`,
    ownerSessionId: 'sess-a',
  });
  const index = await started.completion;
  assert.equal(index.dispatches.find((d) => d.label === 'schema-ok').status, 'completed');
  const missing = index.dispatches.find((d) => d.label === 'schema-missing');
  assert.equal(missing.status, 'failed');
  assert.equal(missing.error.kind, 'no_structured_output');
  assert.equal(index.failures.some((f) => f.label === 'schema-missing'), true);
});

test('AC6 reject = 调用形状错：不 admission、不烧 token、不入失败清单', async () => {
  const temp = tempWorkspace();
  const model = scripted();
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2 });
  const started = await engine.start({
    script: `let shape = null;
try { await agent('bad', { isoloation: 'worktree' }); } catch (e) { shape = 'rejected'; }
const after = await agent('good', { label: 'good' });
return { shape, after };`,
    ownerSessionId: 'sess-a',
  });
  const index = await started.completion;
  assert.equal(index.status, 'completed', '形状错被脚本自己接住后 run 继续');
  assert.deepEqual(index.dispatches.map((d) => d.label), ['good'], '坏调用不 admission（不占键位）');
  assert.deepEqual(model.state.prompts, ['good'], '坏调用不烧 token');
  assert.equal(index.failures.length, 0, '形状错不是该路失败');
});

test('AC6 批量内的形状错：该槽 null、兄弟不受连坐、失败清单不加账', async () => {
  const temp = tempWorkspace();
  const model = scripted();
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 3 });
  const started = await engine.start({
    script: `const out = await parallel([
  () => agent('a', { label: 'A' }),
  () => agent('b', { effort: 'ludicrous' }),
  () => agent('c', { label: 'C' }),
]);
return out;`,
    ownerSessionId: 'sess-a',
  });
  const index = await started.completion;
  assert.deepEqual(index.dispatches.map((d) => d.label), ['A', 'C'], '坏 thunk 不占 admission 序');
  assert.equal(model.state.prompts.includes('b'), false);
  assert.equal(index.status, 'completed');
});

test('AC6 reject 也覆盖 fan-out 调用本身的形状错', async () => {
  const temp = tempWorkspace();
  const { engine } = engineFor(temp, { adapterFactory: scripted().factory });
  const notThunks = await engine.start({ script: `await parallel([agent('x')]);return 1;`, ownerSessionId: 'sess-a' });
  assert.equal((await notThunks.completion).status, 'failed', '传已启动的 promise = 形状错');
  const notArray = await engine.start({ script: `await parallel(agent('x'));return 1;`, ownerSessionId: 'sess-a' });
  assert.equal((await notArray.completion).status, 'failed');
  const badPipeline = await engine.start({ script: `await pipeline([1], 'not-a-stage');return 1;`, ownerSessionId: 'sess-a' });
  assert.equal((await badPipeline.completion).status, 'failed');
  const emptyTools = await engine.start({ script: `await agent('x', { tools: [] });return 1;`, ownerSessionId: 'sess-a' });
  assert.equal((await emptyTools.completion).status, 'failed');
});

test('AC6 throw = run 级终结：agentCap 越限即整 run 判败、在飞中止、队列丢弃', async () => {
  const temp = tempWorkspace();
  const box = gateBox();
  const model = scripted(box.behave);
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2, thresholds: { agentCap: 2 } });
  const started = await engine.start({
    script: `await parallel([0,1,2,3,4].map((i) => () => agent('cap' + i)));return 1;`,
    ownerSessionId: 'sess-a',
  });
  const index = await started.completion;
  assert.equal(index.status, 'failed', 'run 级越限 = 整 run 终结');
  assert.equal(index.reason, 'agent-cap');
  assert.ok(model.state.prompts.length <= 2, `越限后不再起新批次（实起 ${model.state.prompts.length}）`);
  assert.equal(index.dispatches.length, 2, '队列丢弃：第 3 路不 admission');
  assert.equal(await fs.promises.readFile(runPaths(temp.paths, started.runId).terminalFile, 'utf8').then((s) => s.includes('agent-cap')), true, '三件套照发');
});

test('AC6 throw = run 级终结：token 预算越限即整 run 判败', async () => {
  const temp = tempWorkspace();
  const model = scripted(async () => ({ text: 'chunk', outputTokens: 60 }));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 1, thresholds: { tokenCap: 100 } });
  const started = await engine.start({
    script: `await parallel([0,1,2,3].map((i) => () => agent('t' + i)));return 1;`,
    ownerSessionId: 'sess-a',
  });
  const index = await started.completion;
  assert.equal(index.status, 'failed');
  assert.equal(index.reason, 'token-budget', '预算超限走 run 级 throw');
  assert.ok(index.tokens.spent <= 180, `超支上界 ≈ (窗口−1)×单路用量，实得 ${index.tokens.spent}`);
  assert.ok(model.state.prompts.length < 4, '入口 + 取槽两级检查把后续批次挡在门外');
});

// ═══════════════════════════════════════════════════════════════
// AC7 run 级判定：只有机器三态，没有"几路算过"的阈值
// ═══════════════════════════════════════════════════════════════

test('AC7 全败 → failed；部分失败 → completed 带警告；无阈值判定', async () => {
  const runWith = async (paths, failFrom) => {
    const temp = tempWorkspace();
    const model = scripted(async (request) => {
      const n = Number(request.prompt.replace('p', ''));
      if (n >= failFrom) throw new Error(`path ${n} exploded`);
      return { text: `ok-${n}`, outputTokens: 1 };
    });
    const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2 });
    const started = await engine.start({
      script: `await parallel(Array.from({length: ${paths}}, (_, i) => () => agent('p' + i, { label: 'p' + i })));return 1;`,
      ownerSessionId: 'sess-a',
    });
    const index = await started.completion;
    fs.rmSync(temp.workspaceDir, { recursive: true, force: true });
    return index;
  };

  const allFail = await runWith(3, 0);
  assert.equal(allFail.status, 'failed', '全败 → failed');
  assert.equal(allFail.reason, 'failed');
  assert.equal(allFail.failures.length, 3);

  const oneOfTwo = await runWith(2, 1);
  assert.equal(oneOfTwo.status, 'completed', '一半失败仍是 completed：模块不做语义判断');
  assert.equal(oneOfTwo.failures.length, 1);

  const oneOfHundred = await runWith(20, 1);
  assert.equal(oneOfHundred.status, 'completed', '19/20 失败仍是 completed：模块不懂 issue 语义、没有通过线');
  assert.equal(oneOfHundred.failures.length, 19);

  const noneAdmitted = await runWith(0, 0);
  assert.equal(noneAdmitted.status, 'completed', '零派发不判败（无"几路"可算）');
  assert.deepEqual(noneAdmitted.failures, []);
});

test('AC7 终态只有机器三态：终态标记与索引状态一致', async () => {
  const temp = tempWorkspace();
  const { engine } = engineFor(temp, { adapterFactory: scripted().factory, concurrencyWindow: 2 });
  const started = await engine.start({ script: `await agent('x');return 1;`, ownerSessionId: 'sess-a' });
  const index = await started.completion;
  assert.equal(WorkflowEngine.isTerminal(index.status), true);
  const marker = JSON.parse(await fs.promises.readFile(runPaths(temp.paths, started.runId).terminalFile, 'utf8'));
  assert.equal(marker.status, index.status);
  assert.equal(marker.reason, index.reason);
});

// ═══════════════════════════════════════════════════════════════
// AC8 isolation 标记透传与记账（隔离实现属 T8）
// ═══════════════════════════════════════════════════════════════

test('AC8 isolation:worktree 透传到派发记账并进键，但不建 worktree', async () => {
  const temp = tempWorkspace();
  const model = scripted();
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2 });
  const started = await engine.start({
    script: `await agent('iso', { isolation: 'worktree', label: 'iso' });
await agent('plain', { label: 'plain' });
return 1;`,
    ownerSessionId: 'sess-a',
  });
  const index = await started.completion;
  assert.equal(index.status, 'completed', JSON.stringify(index.failures));
  assert.equal(index.dispatches[0].isolation, 'worktree', '标记随每路记账');
  assert.equal('isolation' in index.dispatches[1], false, '未声明即不凭空造字段');
  const keys = rawLines(temp, started.runId).filter((r) => r.type === 'started').map((r) => r.key);
  assert.notEqual(keys[0], keys[1], 'isolation 是行为相关项：进键');
  const perPath = JSON.parse(await fs.promises.readFile(path.join(runPaths(temp.paths, started.runId).agentsDir, 'd0001.json'), 'utf8'));
  assert.equal(perPath.isolation, 'worktree');
  assert.equal(fs.existsSync(path.join(temp.managedRoot, 'worktrees')), false, 'T2 只做透传与记账，隔离创建属 T8');
});

// ═══════════════════════════════════════════════════════════════
// AC9 第一版不做上下文压缩
// ═══════════════════════════════════════════════════════════════

test('AC9 撞上下文上限 = 该路失败记账，不压缩也不重试', async () => {
  const temp = tempWorkspace();
  const model = scripted(async (request) => {
    if (request.prompt === 'huge') throw new Error('prompt is too long: 900000 tokens > 200000 maximum');
    return { text: 'ok', outputTokens: 2 };
  });
  const { engine } = engineFor(temp, { adapterFactory: model.factory, concurrencyWindow: 2 });
  const started = await engine.start({
    script: `const big = await agent('huge', { label: 'huge' });
const small = await agent('fine', { label: 'fine' });
return { big, small };`,
    ownerSessionId: 'sess-a',
  });
  const index = await started.completion;
  const huge = index.dispatches.find((d) => d.label === 'huge');
  assert.equal(huge.status, 'failed', '撞上限即该路失败');
  assert.equal(huge.error.kind, 'error');
  assert.equal(huge.error.reason, 'context-overflow', '具名原因可查');
  assert.equal(index.failures.find((f) => f.label === 'huge').reason, 'context-overflow');
  assert.equal(index.status, 'completed', '一路撞上限不拖垮整 run');
  assert.equal(model.state.calls.length, 2, '零压缩、零重试：每路各一次调用');
});

test('AC9 负向声明：模块不复用上下文压缩件，也不 import 既有 subagent 体系', () => {
  const dir = path.join(process.cwd(), 'src', 'workflows');
  const files = fs.readdirSync(dir).filter((f) => /\.ts$/.test(f));
  assert.ok(files.length >= 10, '扫到模块文件才谈得上负向断言');
  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(/microCompact|autoCompact/.test(source), false, `${file} 不得引用上下文压缩件`);
    for (const specifier of [...source.matchAll(/from\s+'(\.\.\/[^']+)'/g)].map((m) => m[1])) {
      if (!specifier.startsWith('../subagent/')) continue;
      assert.equal(specifier, '../subagent/llm-adapter.js', `${file} 只允许继承 LlmAdapter，实得 ${specifier}`);
      assert.equal(file, 'adapter.ts', `只有 adapter.ts 有权继承 LlmAdapter，实得 ${file}`);
    }
  }
});
