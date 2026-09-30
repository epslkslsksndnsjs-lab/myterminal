// Workflows T2（#225）：N 路并发执行的零件契约
//
// 这一份锁的是"每个零件自己的行为边界"——选项闸、缓存键链、并发窗口、
// 账本归位序、三态结算的归类。行为锁定 = 改了就红，行覆盖高而断言弱不算数。
// 引擎级验收（补位水位 / parallel / pipeline / 嵌套 / 判定）在
// issue-225-n-way-parallel.test.mjs。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  gateAgentOpts,
  canonicalAgentOpts,
  AgentCallShapeError,
  KNOWN_AGENT_OPTS,
  EFFORT_TIERS,
  DISPATCH_AFFECTING_AGENT_OPTS,
  DISPLAY_ONLY_AGENT_OPTS,
  canonicalAgentToolName,
} from '../dist/workflows/agent-opts.js';
import { argsChainSeed, deriveAgentKey, JOURNAL_KEY_VERSION, KEYS_MAX_DEPTH } from '../dist/workflows/keys.js';
import {
  createDispatchWindow,
  defaultConcurrencyWindow,
  MIN_CONCURRENCY,
  MAX_DEFAULT_CONCURRENCY,
  HARD_CONCURRENCY_CEILING,
} from '../dist/workflows/scheduler.js';
import {
  AGENT_FAILURE_KINDS,
  agentFailure,
  isAgentFailure,
  runLevelError,
  isRunLevelError,
  classifyAdapterError,
  WorkflowAgentCapExceededError,
  WorkflowBudgetExceededError,
} from '../dist/workflows/failures.js';
import { assertThunks, assertItemsAndStages, runParallel, runPipeline } from '../dist/workflows/fanout.js';
import { normalizeIndex } from '../dist/workflows/run-index.js';
import { runInSandbox, stripWorkflowMeta } from '../dist/workflows/sandbox.js';
import { Journal } from '../dist/workflows/journal.js';

let TMP;

function tempFile(name) {
  if (!TMP) TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-225u-'));
  return path.join(TMP, name);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 让微任务队列与 promise 链彻底跑一轮（窗口无定时器，0ms 足够）。 */
async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

// ═══════════════════════════════════════════════════════════════
// 一、agent() 选项闸——调用形状错一律 reject（不消耗缓存键）
// ═══════════════════════════════════════════════════════════════

test('选项闸：票面八个选项加 stepId 等已知键全部接受，未知键即形状错', () => {
  const all = {
    stepId: 's1',
    label: 'gather',
    phase: 'Collect',
    schema: { type: 'object', properties: { a: { type: 'string' } } },
    model: 'some-model',
    effort: 'high',
    agentType: 'researcher',
    isolation: 'worktree',
    stallMs: 5_000,
    disallowedTools: ['write_file'],
    tools: ['read_file'],
  };
  assert.deepEqual([...KNOWN_AGENT_OPTS].sort(), [...Object.keys(all), 'workingDir'].sort(), '已知选项表就是这十二项');
  const gated = gateAgentOpts(all);
  assert.equal(gated.label, 'gather');
  assert.equal(gated.model, 'some-model');
  // 未知键（拼错也要拒）——静默吞掉会让"以为传了、其实没传"一路跑下去。
  for (const bad of [{ labelle: 'x' }, { isolationn: 'worktree' }, JSON.parse('{"__proto__":{"x":1},"label":"a"}')]) {
    assert.throws(() => gateAgentOpts(bad), AgentCallShapeError, `未知键应拒：${JSON.stringify(bad)}`);
  }
  // 原型污染走 JSON 复活的路子也进不来：__proto__ 是未知键，在闸口即拒。
  assert.equal({}.polluted, undefined, '原型未被污染');
  assert.throws(() => gateAgentOpts('nope'), AgentCallShapeError, 'opts 非对象即形状错');
  assert.throws(() => gateAgentOpts(['a']), AgentCallShapeError, 'opts 数组即形状错');
  assert.deepEqual(gateAgentOpts(undefined), {}, '缺省 opts = 空对象');
});

test('选项闸：isolation 只认 worktree / remote 两个字面值', () => {
  for (const ok of ['worktree', 'remote']) assert.equal(gateAgentOpts({ isolation: ok }).isolation, ok);
  for (const bad of ['Worktree', 'worktree ', 'none', 'git', '', 1, null, true]) {
    assert.throws(() => gateAgentOpts({ isolation: bad }), AgentCallShapeError, `应拒：${JSON.stringify(bad)}`);
  }
});

test('选项闸：workingDir 与 isolation 互斥，非空字符串才有资格', () => {
  assert.throws(() => gateAgentOpts({ isolation: 'worktree', workingDir: '/tmp/x' }), /workingDir/i);
  for (const bad of ['', '   ', '/tmp/a/b/../c', 1, {}, []]) {
    assert.throws(() => gateAgentOpts({ workingDir: bad }), AgentCallShapeError, `workingDir 应拒：${JSON.stringify(bad)}`);
  }
});

test('选项闸：effort 归一到档位（大小写与别名同档），未知档位拒并回显档位表', () => {
  assert.equal(gateAgentOpts({ effort: 'HIGH' }).effort, 'high');
  assert.equal(gateAgentOpts({ effort: '  xhigh  ' }).effort, 'xhigh');
  assert.equal(gateAgentOpts({ effort: 'med' }).effort, 'medium', '别名 med 归一到 medium');
  assert.equal(gateAgentOpts({ effort: 'x-high' }).effort, 'xhigh', '别名 x-high 归一到 xhigh');
  assert.deepEqual([...EFFORT_TIERS], ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const bad of ['turbo', '', '  ', 3, null, 'extreme']) {
    assert.throws(() => gateAgentOpts({ effort: bad }), /effort/i, `应拒：${JSON.stringify(bad)}`);
    try { gateAgentOpts({ effort: bad }); } catch (error) {
      for (const tier of EFFORT_TIERS) assert.ok(error.message.includes(tier), `拒因回显档位表缺 ${tier}`);
    }
  }
});

test('选项闸：tools 空数组拒、通配与整 server 拒；disallowedTools 空数组删键', () => {
  assert.deepEqual(gateAgentOpts({ tools: ['read_file', 'search_text'] }).tools, ['read_file', 'search_text']);
  assert.throws(() => gateAgentOpts({ tools: [] }), AgentCallShapeError, '空 tools = 什么都不给做，刻意拒');
  for (const bad of ['*', 'exec', 'mcp__server', 'read_file ', 1, {}]) {
    assert.throws(() => gateAgentOpts({ tools: [bad] }), AgentCallShapeError, `tools 条目应拒：${JSON.stringify(bad)}`);
  }
  assert.throws(() => gateAgentOpts({ tools: 'read_file' }), AgentCallShapeError, 'tools 必须是数组');
  // disallowedTools 与 tools 刻意不对称：清空禁单是合法意图，删键而不是拒。
  const cleared = gateAgentOpts({ disallowedTools: [] });
  assert.equal('disallowedTools' in cleared, false, '空禁单删键');
  assert.deepEqual(gateAgentOpts({ disallowedTools: ['write_file'] }).disallowedTools, ['write_file']);
  assert.equal(canonicalAgentToolName('mcp__server__tool'), 'mcp__server__tool', '三段 MCP 名放行');
});

test('选项闸：stallMs 0 合法（关看门狗），非有限数拒', () => {
  assert.equal(gateAgentOpts({ stallMs: 0 }).stallMs, 0);
  assert.equal(gateAgentOpts({ stallMs: 1500 }).stallMs, 1500);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1500', null]) {
    assert.throws(() => gateAgentOpts({ stallMs: bad }), AgentCallShapeError, `应拒：${String(bad)}`);
  }
});

test('选项闸：schema 必须是非空对象，stepId 限长，label / phase 必须是字符串', () => {
  assert.deepEqual(gateAgentOpts({ schema: { type: 'object' } }).schema, { type: 'object' });
  for (const bad of [{}, [], 'nope', null, undefined]) {
    if (bad === undefined) continue;
    assert.throws(() => gateAgentOpts({ schema: bad }), AgentCallShapeError, `schema 应拒：${JSON.stringify(bad)}`);
  }
  assert.equal(gateAgentOpts({ stepId: 'a'.repeat(128) }).stepId, 'a'.repeat(128));
  assert.throws(() => gateAgentOpts({ stepId: 'a'.repeat(129) }), AgentCallShapeError);
  assert.throws(() => gateAgentOpts({ label: 42 }), AgentCallShapeError);
  assert.throws(() => gateAgentOpts({ phase: {} }), AgentCallShapeError);
  assert.throws(() => gateAgentOpts({ model: '   ' }), AgentCallShapeError, '空白 model 等同没给，拒');
});

// ═══════════════════════════════════════════════════════════════
// 二、缓存键的投影——行为相关项进键，纯展示项不进
// ═══════════════════════════════════════════════════════════════

test('进键项 = 八项，展示项 = label / phase / stepId / stallMs（改这些不换键）', () => {
  assert.deepEqual([...DISPATCH_AFFECTING_AGENT_OPTS].sort(), ['agentType', 'disallowedTools', 'effort', 'isolation', 'model', 'schema', 'tools', 'workingDir'].sort());
  assert.deepEqual([...DISPLAY_ONLY_AGENT_OPTS].sort(), ['label', 'phase', 'stallMs', 'stepId'].sort());
  const base = { label: 'a', phase: 'P', stepId: 's', stallMs: 1000 };
  assert.equal(canonicalAgentOpts(gateAgentOpts(base)), '{}', '纯展示项投影为空对象');
  assert.equal(
    canonicalAgentOpts(gateAgentOpts({ ...base, model: 'm' })),
    canonicalAgentOpts(gateAgentOpts({ model: 'm' })),
    '展示项不参与键',
  );
  assert.notEqual(canonicalAgentOpts(gateAgentOpts({ model: 'm' })), canonicalAgentOpts(gateAgentOpts({ model: 'n' })));
});

test('归一化：tools / disallowedTools 的顺序与重复不影响键，effort 换档换键', () => {
  const a = canonicalAgentOpts(gateAgentOpts({ tools: ['read_file', 'search_text'] }));
  const b = canonicalAgentOpts(gateAgentOpts({ tools: ['search_text', 'read_file', 'read_file'] }));
  assert.equal(a, b, '顺序与重复不影响');
  assert.notEqual(a, canonicalAgentOpts(gateAgentOpts({ tools: ['read_file'] })), '内容变了要换键');
  assert.notEqual(
    canonicalAgentOpts(gateAgentOpts({ effort: 'medium' })),
    canonicalAgentOpts(gateAgentOpts({ effort: 'high' })),
    'effort 换档 = 换键',
  );
  assert.equal(
    canonicalAgentOpts(gateAgentOpts({ effort: 'MED' })),
    canonicalAgentOpts(gateAgentOpts({ effort: 'medium' })),
    '别名归一后同键',
  );
  assert.notEqual(
    canonicalAgentOpts(gateAgentOpts({ disallowedTools: ['write_file'] })),
    canonicalAgentOpts(gateAgentOpts({})),
    '禁单内容进键',
  );
  assert.notEqual(
    canonicalAgentOpts(gateAgentOpts({ isolation: 'worktree' })),
    canonicalAgentOpts(gateAgentOpts({})),
    'isolation 进键（T2 只透传与记账，隔离实现属 T8）',
  );
});

test('内置工具展示名与拼写名互认（同键），其它拼写按变更处理', () => {
  assert.equal(canonicalAgentToolName('Read file'), 'read_file');
  assert.equal(canonicalAgentToolName('READ_FILE'), 'read_file');
  assert.equal(canonicalAgentToolName('Execute command'), 'execute_cli');
  assert.equal(canonicalAgentToolName('SomeUnknownTool'), 'someunknowntool', '未知拼写不判存在性：原样归一');
  const viaTitle = canonicalAgentOpts(gateAgentOpts({ tools: ['Read file'] }));
  const viaName = canonicalAgentOpts(gateAgentOpts({ tools: ['read_file'] }));
  assert.equal(viaTitle, viaName, '展示名与拼写名共享缓存键');
  assert.notEqual(viaName, canonicalAgentOpts(gateAgentOpts({ tools: ['Readfile'] })), '别的拼写就是别的键');
});

test('schema 进键：键序无关（对象键排序），内容变化换键', () => {
  const one = canonicalAgentOpts(gateAgentOpts({ schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } }));
  const two = canonicalAgentOpts(gateAgentOpts({ schema: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' } }));
  assert.equal(one, two, 'schema 内部键序不影响');
  const three = canonicalAgentOpts(gateAgentOpts({ schema: { type: 'object', properties: { a: { type: 'integer' } } } }));
  assert.notEqual(one, three);
});

// ═══════════════════════════════════════════════════════════════
// 三、前缀哈希链——键序 = 脚本调用序
// ═══════════════════════════════════════════════════════════════

test('键链：key_n 依赖 key_(n-1)，同 prompt 同 opts 在前缀不同处得到不同键', () => {
  const seed = argsChainSeed(null);
  const k1 = deriveAgentKey(seed, 'first', '{}');
  const k2 = deriveAgentKey(k1, 'same', '{}');
  const k2Other = deriveAgentKey(argsChainSeed({ a: 1 }), 'same', '{}');
  assert.equal(k2.length, k2Other.length);
  assert.notEqual(k2, k2Other, '前缀不同 → 键不同（第一个变更点起全链失效）');
  assert.equal(deriveAgentKey(seed, 'first', '{}'), k1, '纯函数：同入参同键');
  assert.notEqual(deriveAgentKey(seed, 'first ', '{}'), k1, 'prompt 逐字符进键');
});

test('键形态钉死：v2: + 64 位十六进制', () => {
  const key = deriveAgentKey(argsChainSeed(null), 'p', '{}');
  assert.ok(key.startsWith(`${JOURNAL_KEY_VERSION}:`), `前缀 = ${JOURNAL_KEY_VERSION}`);
  assert.match(key, /^v2:[0-9a-f]{64}$/);
});

test('args 是链的种子：改 args 换种子；不可序列化 args 回退固定串（不抛）', () => {
  assert.equal(argsChainSeed(undefined), argsChainSeed(null), '未提供 args 与 null 同种子');
  assert.notEqual(argsChainSeed({ target: 'a' }), argsChainSeed({ target: 'b' }));
  const circular = {};
  circular.self = circular;
  const fallback = argsChainSeed(circular);
  assert.match(fallback, /^v2:[0-9a-f]{64}$/);
  assert.equal(fallback, argsChainSeed(() => 0), '循环引用与函数一律走同一回退，绝不抛');
  assert.equal(argsChainSeed(42), argsChainSeed(42));
});

test('args 深度上限：超深不炸栈、按回退处理', () => {
  let deep = { leaf: 1 };
  for (let i = 0; i < KEYS_MAX_DEPTH + 8; i++) deep = { nested: deep };
  assert.match(argsChainSeed(deep), /^v2:[0-9a-f]{64}$/);
});

// ═══════════════════════════════════════════════════════════════
// 四、并发窗口——滚动补位
// ═══════════════════════════════════════════════════════════════

test('窗口构造：limit 必须正整数，0 / 负 / 小数 / NaN 同步 throw 且消息回显原值', () => {
  for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '3']) {
    assert.throws(() => createDispatchWindow(bad), /limit/i, `应拒：${String(bad)}`);
    try { createDispatchWindow(bad); } catch (error) {
      assert.ok(error.message.includes(String(bad)), `消息须回显原值：${error.message}`);
    }
  }
});

test('窗口：水位不越限，任一路结算即按 admission 序补下一路', async () => {
  const window = createDispatchWindow(3);
  const gates = Array.from({ length: 10 }, () => deferred());
  const started = [];
  const promises = gates.map((gate, i) => window.run(() => { started.push(i); return gate.promise; }));
  await settle();
  assert.deepEqual(started, [0, 1, 2], '前三个先起，其余排队');
  assert.equal(window.inFlight(), 3);
  assert.equal(window.queued(), 7);

  const refilled = [];
  for (let i = 0; i < 10; i++) {
    if (i === 0) {
      gates[0].resolve('done-0');
      await settle();
      assert.deepEqual(started.slice(3), [3], '第一路结算 → 补起第四路（不是等整组）');
    }
    gates[i].resolve(`done-${i}`);
    promises[i].then((value) => refilled.push(value));
    await settle();
    assert.equal(window.inFlight(), Math.min(3, 10 - i - 1) > 0 ? Math.min(3, 9 - i) : 0, `第 ${i} 路结算后水位收敛`);
  }
  const values = await Promise.all(promises);
  assert.deepEqual(values, Array.from({ length: 10 }, (_, i) => `done-${i}`), '每路拿到自己的结果，位置不错位');
  assert.deepEqual(started, Array.from({ length: 10 }, (_, i) => i), '补位序 = admission 序');
  assert.equal(window.inFlight(), 0);
  assert.equal(window.queued(), 0);
});

test('窗口：槽位在结算时归还且只归还一次（长跑不漏槽，失败路径也归还）', async () => {
  const window = createDispatchWindow(1);
  const values = [];
  for (let i = 0; i < 8; i++) values.push(await window.run(async () => i));
  assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6, 7], '窗口 1 下八路串行收敛');
  assert.equal(window.inFlight(), 0);
  assert.equal(window.queued(), 0);
  await assert.rejects(() => window.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(window.inFlight(), 0, '失败路径同样归还槽位');
  assert.equal(await window.run(async () => 'still works'), 'still works', '漏槽会把窗口卡死，这条即那层的保险');
});

test('窗口：已 abort 时 run() 立即拒且 thunk 不执行；排队项拒且不占槽', async () => {
  const window = createDispatchWindow(1);
  const gate = deferred();
  let secondThunkRan = false;
  const first = window.run(() => gate.promise);
  const second = window.run(async () => { secondThunkRan = true; return 'never'; });
  await settle();
  assert.equal(window.inFlight(), 1);
  window.abort();
  await assert.rejects(() => second, (error) => error.name === 'AbortError');
  assert.equal(secondThunkRan, false, '被拒的排队项绝不执行');
  assert.equal(window.queued(), 0, '排空队列不占槽');
  gate.resolve('in-flight 自己收尾');
  assert.equal(await first, 'in-flight 自己收尾', 'abort 不重写已在飞的结果');
  await assert.rejects(() => window.run(async () => 'late'), (error) => error.name === 'AbortError');
});

test('窗口：外部 AbortSignal 到期即等价于 abort', async () => {
  const controller = new AbortController();
  const window = createDispatchWindow(1, { signal: controller.signal });
  const gate = deferred();
  const running = window.run(() => gate.promise);
  const queued = window.run(async () => 'x');
  await settle();
  assert.equal(window.inFlight(), 1, '第二路确实排在门外');
  controller.abort();
  await assert.rejects(() => queued, (error) => error.name === 'AbortError');
  gate.resolve('ok');
  assert.equal(await running, 'ok');
  assert.equal(window.aborted, true);
});

test('窗口默认值：max(2, min(16, 核数−2))，采样钉死；硬顶 64', () => {
  const samples = [[0, 2], [1, 2], [3, 2], [6, 4], [18, 16], [64, 16], [128, 16]];
  for (const [cpus, expected] of samples) {
    assert.equal(defaultConcurrencyWindow(cpus), expected, `${cpus} 核 → ${expected}`);
  }
  assert.equal(MIN_CONCURRENCY, 2, '下限 2：窗口 1 会把 parallel 静默串行化');
  assert.equal(MAX_DEFAULT_CONCURRENCY, 16);
  assert.equal(HARD_CONCURRENCY_CEILING, 64);
});

// ═══════════════════════════════════════════════════════════════
// 五、账本归位——完成顺序不影响 journal 与键序
// ═══════════════════════════════════════════════════════════════

test('journal：乱序结算仍按 admission 序归位', async () => {
  const file = tempFile('ordered.jsonl');
  const journal = Journal.open(file);
  await journal.append({ type: 'launched', runId: 'wf_a', at: 't0' });
  const late = journal.appendOrdered(3, { type: 'result', seq: 3, value: 'third', at: 't3' });
  await settle();
  assert.equal((await readSeqs(file)).join(','), 'launched', '第三路先完成也不许抢跑');
  const middle = journal.appendOrdered(2, { type: 'result', seq: 2, value: 'second', at: 't2' });
  await settle();
  assert.equal((await readSeqs(file)).join(','), 'launched', '缺口仍在，第二路也得等');
  const first = journal.appendOrdered(1, { type: 'failed', seq: 1, error: { kind: 'error', message: 'boom' }, at: 't1' });
  await Promise.all([first, middle, late]);
  assert.deepEqual(await readSeqs(file), ['launched', 1, 2, 3], '一次补齐即按序连续落盘');
  assert.deepEqual(await readValues(file), ['boom-or-failed', 'second', 'third']);
  await journal.drain();
  assert.equal(journal.pendingCount(), 0);
});

test('journal：空洞不静默丢，flushPending 按升序补齐', async () => {
  const file = tempFile('holes.jsonl');
  const journal = Journal.open(file);
  journal.appendOrdered(5, { type: 'result', seq: 5, value: 'five', at: 't' });
  journal.appendOrdered(3, { type: 'result', seq: 3, value: 'three', at: 't' });
  await settle();
  assert.equal(journal.pendingCount(), 2, '两行都卡在 1、2 未到的口子上');
  await journal.flushPending();
  assert.deepEqual(await readSeqs(file), [5 - 2, 5], '升序补齐（第三路先于第五路）');
  assert.equal(journal.pendingCount(), 0);
  await journal.drain();
});

test('journal：started 行即时落盘，不进缓冲（在飞即有账，认领才看得见）', async () => {
  const file = tempFile('started.jsonl');
  const journal = Journal.open(file);
  await journal.append({ type: 'started', seq: 1, key: 'v2:a', label: 'a', at: 't' });
  journal.appendOrdered(2, { type: 'result', seq: 2, value: 'x', at: 't' });
  await settle();
  assert.deepEqual(await readSeqs(file), ['started-row-shape'], '在飞那一路的账当场可见');
  assert.equal(journal.pendingCount(), 1, '结果行还在缓冲里等自己的序号');
  await journal.drain();
  assert.deepEqual(await readSeqs(file), ['started-row-shape', 2], '结算补齐');
});

// ═══════════════════════════════════════════════════════════════
// 六、三态结算的归类
// ═══════════════════════════════════════════════════════════════

test('agent 级失败五类齐备，标记与名字都认（跨 realm 不许 instanceof）', () => {
  assert.deepEqual([...AGENT_FAILURE_KINDS].sort(), ['error', 'max_turns', 'no_structured_output', 'stalled', 'timeout'].sort());
  for (const kind of AGENT_FAILURE_KINDS) {
    const error = agentFailure(kind, `msg-${kind}`);
    assert.equal(isAgentFailure(error), true);
    assert.equal(error.kind, kind);
    assert.equal(isRunLevelError(error), false, 'agent 级不得被判成 run 级');
  }
  // vm 里造的错误：host 侧 instanceof 恒 false，鸭子判定必须靠标记 / 名字成立。
  assert.equal(isAgentFailure({ name: 'WorkflowAgentFailedError', kind: 'stalled', message: 'x' }), true);
  assert.equal(isAgentFailure({ __wfAgentFailure: true, kind: 'timeout', message: 'x' }), true);
  assert.equal(isAgentFailure({ name: 'Error', message: 'x' }), false);
  assert.equal(isAgentFailure(undefined), false);
});

test('run 级终结：cap / 预算 / 具名标记三类都认，agent 级不算', () => {
  assert.equal(isRunLevelError(new WorkflowAgentCapExceededError(1000)), true);
  assert.equal(isRunLevelError(new WorkflowBudgetExceededError('wf_a', 9_000_000, 8_000_000)), true);
  assert.equal(isRunLevelError(runLevelError('cancelled', 'stop')), true);
  assert.equal(isRunLevelError({ __wfRunFailure: true, message: 'x' }), true, '鸭子标记即够');
  assert.equal(isRunLevelError({ name: 'WorkflowAgentCapExceededError', message: 'x' }), true, '跨 realm 只认名字');
  assert.equal(isRunLevelError(agentFailure('error', 'x')), false);
  assert.equal(isRunLevelError(new Error('plain')), false, '普通错误 = 该路失败，不是整 run');
  assert.match(new WorkflowAgentCapExceededError(1000).message, /1000/);
  assert.match(new WorkflowAgentCapExceededError(1000).message, /agent\(\)/);
});

test('沉默归类：一切未知沉默坍缩为该路失败，上下文上限具名记账', () => {
  assert.deepEqual(classifyAdapterError(new Error('socket hang up')), { kind: 'error', message: 'socket hang up' });
  const overflow = classifyAdapterError(new Error('prompt is too long: 900000 tokens > 200000 maximum'));
  assert.equal(overflow.kind, 'error', '上下文上限就是"模型错误"一类，不另造终态');
  assert.equal(overflow.reason, 'context-overflow', '但要具名，失败清单才说得出为什么');
  for (const text of ['Context length exceeded', 'maximum context length reached', 'too many tokens in prompt']) {
    assert.equal(classifyAdapterError(new Error(text)).reason, 'context-overflow', text);
  }
  assert.equal(classifyAdapterError(agentFailure('max_turns', 'turns')).kind, 'max_turns', '已归类的原样走');
  assert.equal(classifyAdapterError('not even an error').kind, 'error', '非 Error 也有账');
});

// ═══════════════════════════════════════════════════════════════
// 七、saved 脚本头部 meta：等长剥离，括号行走不被字符串与注释骗到
// ═══════════════════════════════════════════════════════════════

test('meta 剥离：等长等行，脚本首行行号不变（错误回显才对得上原脚本）', () => {
  const src = `export const meta = { name: 'a', phases: [{ title: 'x' }] };\nconst v = await agent('go');\nreturn v;`;
  const out = stripWorkflowMeta(src);
  assert.equal(out.length, src.length, '抹平不改变长度');
  assert.equal(out.split('\n').length, src.split('\n').length, '不改变行数');
  assert.equal(out.split('\n')[1], "const v = await agent('go');");
  assert.equal(out.split('\n')[0].trim(), '', 'meta 整段变空白');
  assert.equal(stripWorkflowMeta('return 1;'), 'return 1;', '没有 meta 原样返回');
});

test('meta 剥离：字符串、注释与模板插值里的括号都不计数', () => {
  const tricky = `export const meta = {\n  name: 'a}b',\n  // } 不在数内\n  d: "c{x",\n  t: \`tmpl { } ${'{'} inside\`,\n  /* } */ e: 'end',\n};\nreturn 1;`;
  const out = stripWorkflowMeta(tricky);
  assert.equal(out.length, tricky.length);
  assert.equal(out.split('\n')[7], 'return 1;', '跨行 meta 之后行号仍对齐');
  assert.ok(tricky.split('\n').slice(0, 7).every((_, n) => out.split('\n')[n].trim() === ''), 'meta 整段（含注释）全部抹平');
  assert.equal(out.includes('}b'), false, "字符串里的 } 没被当成块尾（否则正文会被截走一半）");
});

test('meta 剥离：块外多出的收尾括号原样留给编译器拒（不吞脚本代码）', async () => {
  const src = 'export const meta = { a: 1 }};\nreturn 1;';
  const out = stripWorkflowMeta(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n')[1], 'return 1;', '脚本正文一个字都不动');
  const compiled = await runInSandbox({ source: src, host: { agent: async () => 'ok' } });
  assert.equal(compiled.ok, false, '多余的收尾括号由编译面拒，不是靠剥离器兜');
  assert.equal(compiled.kind, 'compile');
});

test('meta 剥离：不平衡即抛，绝不静默截断一半', () => {
  assert.throws(() => stripWorkflowMeta(`export const meta = { name: 'oops', phases: [{ title: 'x' }\nreturn 1;`), /unbalanced/i);
  assert.throws(() => stripWorkflowMeta(`export const meta = { name: 'unterminated`), /unbalanced/i);
  assert.throws(() => stripWorkflowMeta(`export const meta = { a: 'x}`), /unbalanced/i, '字符串未闭合也拒');
});

// ═══════════════════════════════════════════════════════════════
// 八、扇出的边角（批处理规则本身的行为锁）
// ═══════════════════════════════════════════════════════════════

test('parallel：非数组与元素非函数即整批形状错；undefined 结果坍缩为 null', async () => {
  assert.throws(() => assertThunks('nope'), AgentCallShapeError);
  assert.throws(() => assertThunks([async () => 1, 'started-promise']), /element 1/);
  assert.deepEqual(await runParallel([]), [], '空批合法且返回空数组');
  assert.deepEqual(await runParallel([async () => undefined, () => 0, async () => '']), [null, 0, ''], '只有 undefined 变 null，0 与空串是合法值');
  const rejected = await runParallel([async () => { throw new Error('boom'); }, async () => 'ok']);
  assert.deepEqual(rejected, [null, 'ok'], '批内失败坍缩为 null，兄弟不受连坐');
});

test('parallel：run 级错误整批拒（不许被降成 null）', async () => {
  for (const error of [new WorkflowAgentCapExceededError(1000), runLevelError('token-budget', 'x')]) {
    await assert.rejects(() => runParallel([async () => 'fine', async () => { throw error; }]), (caught) => caught === error, '原样上抛');
  }
});

test('pipeline：段抛普通错丢该 item，抛 run 级即整批拒', async () => {
  assert.throws(() => assertItemsAndStages('nope', [() => 1]), AgentCallShapeError);
  assert.throws(() => assertItemsAndStages([1], []), /at least one stage/);
  assert.throws(() => assertItemsAndStages([1], ['not-a-stage']), /stage 0/);

  const dropped = await runPipeline([0, 1], [
    async (prev, item) => { if (item === 1) throw new Error('stage blew up'); return 'x'; },
    async (prev) => `${prev}-second`,
  ]);
  assert.deepEqual(dropped, ['x-second', null], '该 item 止步，另一条照跑');

  const undefinedPrev = await runPipeline([0], [() => undefined, async () => 'never']);
  assert.deepEqual(undefinedPrev, [null], '段返回 undefined 即 null 哨兵，后续段不再跑');

  const cap = new WorkflowAgentCapExceededError(3);
  await assert.rejects(() => runPipeline([0], [async () => { throw cap; }]), (caught) => caught === cap);
  assert.deepEqual(await runPipeline([], [async () => 1]), [], '空 items 收敛为空批');
});

// ═══════════════════════════════════════════════════════════════
// 九、机器件的 additive 字段（#225 新入的键位与失败清单）
// ═══════════════════════════════════════════════════════════════

test('run-index：新字段逐条清洗，老产物缺 failures 按空清单（additive 兼容）', () => {
  const index = normalizeIndex({
    schemaVersion: 1,
    runId: 'wf_a',
    status: 'failed',
    reason: 'failed',
    ownerSessionId: 's',
    scriptPath: 'p.js',
    sourceRef: { id: 'p.js', revision: 'r' },
    argsRecorded: false,
    startedAt: 't',
    dispatches: [
      { id: 'd0001', seq: 1, key: 'v2:a', label: 'A', status: 'failed', attempts: 1, startedAt: 't', outputTokens: 0, isolation: 'worktree', phase: 'P', model: 'm', effort: 'high', schema: true, error: { kind: 'stalled', message: 'no progress' } },
      { id: 'd0002', seq: 'garbage', label: 'B', status: 'completed', startedAt: 't', outputTokens: 2 },
    ],
    failures: [
      { seq: 1, label: 'A', kind: 'stalled', message: 'no progress', reason: 'stalled-exhausted' },
      { label: 42, kind: null, message: '' },
      'garbage',
      null,
    ],
    scriptError: { kind: 'runtime', message: 'boom' },
    tokens: { spent: 2 },
  });
  assert.equal(index.dispatches[0].seq, 1);
  assert.equal(index.dispatches[0].key, 'v2:a');
  assert.equal(index.dispatches[0].isolation, 'worktree');
  assert.equal(index.dispatches[0].phase, 'P');
  assert.equal(index.dispatches[0].model, 'm');
  assert.equal(index.dispatches[0].effort, 'high');
  assert.equal(index.dispatches[0].schema, true);
  assert.equal('seq' in index.dispatches[1], false, '脏 seq 不凭空造');
  assert.equal(index.failures.length, 2, '非对象条目丢弃，脏字段按缺省清洗');
  assert.equal(index.failures[0].reason, 'stalled-exhausted');
  assert.equal(index.failures[1].label, 'workflow-agent');
  assert.equal(index.failures[1].kind, 'error');
  assert.equal(index.failures[1].message, 'dispatch failed');
  assert.deepEqual(index.scriptError, { kind: 'runtime', message: 'boom' });

  const legacy = normalizeIndex({
    schemaVersion: 1, runId: 'wf_old', status: 'completed', ownerSessionId: 's', scriptPath: 'o.js',
    sourceRef: { id: 'o.js', revision: 'r' }, argsRecorded: false, startedAt: 't', dispatches: [], tokens: { spent: 0 },
  });
  assert.deepEqual(legacy.failures, [], '老产物没有 failures 字段 → 空清单，绝不拒读');
  assert.equal('scriptError' in legacy, false);
});

// ═══════════════════════════════════════════════════════════════
// 十、args 种子与沙箱缺省接线
// ═══════════════════════════════════════════════════════════════

test('args 序列化失败（BigInt）与循环引用同走一个回退种子，不抛', () => {
  const circular = {};
  circular.self = circular;
  assert.equal(argsChainSeed(10n), argsChainSeed(circular), '序列化不了的 args 一律同一颗回退种子');
  assert.match(argsChainSeed(10n), /^v2:[0-9a-f]{64}$/);
  assert.notEqual(argsChainSeed(10n), argsChainSeed(10), '能序列化的 args 不吃回退');
});

test('沙箱缺省接线：未注入 workflow / budget 时各自明确拒或空账', async () => {
  const noWorkflow = await runInSandbox({ source: "await workflow('x');return 1;", host: { agent: async () => 'ok' } });
  assert.equal(noWorkflow.ok, false);
  assert.equal(noWorkflow.kind, 'runtime');
  assert.match(noWorkflow.message, /nesting is limited to one level/);

  const noBudget = await runInSandbox({ source: 'return budget.total;', host: { agent: async () => 'ok' } });
  assert.equal(noBudget.value, null, '未接预算时 total 为 null（无上限哨兵）');
  const spentThrows = await runInSandbox({ source: 'return budget.spent();', host: { agent: async () => 'ok' } });
  assert.equal(spentThrows.ok, false);
  assert.match(spentThrows.message, /budget is not wired/);

  const circularArgs = {};
  circularArgs.self = circularArgs;
  const argsFallback = await runInSandbox({ source: 'return args;', args: circularArgs, host: { agent: async () => 'ok' } });
  assert.equal(argsFallback.value, null, '不可序列化的 args 落回 null，不抛');
});

test('出向值逐槽复活：交回不可序列化的东西只有那一槽变 null', async () => {
  const outcome = await runInSandbox({
    source: "const v = await agent('x'); return { isNull: v === null };",
    host: { agent: async () => 10n },
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.value, { isNull: true });
  assert.ok(outcome.logs.some((l) => l.includes('unserializable')), '复活失败要留一行日志，不许静默');

  const batch = await runInSandbox({
    source: "const out = await parallel([async () => 10n, async () => 'kept']); return out;",
    host: { agent: async () => 'unused' },
  });
  assert.deepEqual(batch.value, [null, 'kept'], '单槽不可序列化不连坐兄弟槽');
});


// ── helpers ────────────────────────────────────────────────

async function readSeqs(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map((line) => {
    const record = JSON.parse(line);
    if (record.type === 'launched') return 'launched';
    if (record.type === 'started') return 'started-row-shape';
    return record.seq;
  });
}

async function readValues(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .map((line) => JSON.parse(line))
    .filter((record) => record.type === 'result' || record.type === 'failed')
    .map((record) => (record.type === 'failed' ? 'boom-or-failed' : record.value));
}
