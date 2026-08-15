// ADR-0048 票B（#130）：subagent_status.result 超门可恢复分页（D11 三件套 B）
//
// 契约（票文 + Q12 定案）：
//   触发线：RAW_BUDGET_TOKENS 24K 门（tool-parse.ts:81，与 L3 门同源，一个数字两处用）
//   分页单位：字符 offset（string.length/slice，UTF-16 code unit，runner 与 reducer 同侧记账）
//   页大小：首页按 24K 门 token 感知截断封顶；续页固定 ~8K tokens 等价字符（32000 chars，默认）
//   超门不再 fail-open 原样灌父：L1 reducer 截断 + truncated:true + 总量诚实字段 +
//   pagination.nextCall = {tool:'subagent_status', input:{taskId, offset}}
//   extracted 四字段照挂（与分页不冲突）；正常小 result 零影响；store 保留全量
//
// 测试方式：shaper 层直接驱动 shapeToolResponse（../dist/tool-parse.js，issue-45 手法）；
//   runner 层用真实 store（createSubagent/updateSubagentStatus）+ fake deps（m8 手法）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { shapeToolResponse, estimateTokens } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter, resetL3AdapterInstance } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';
import { createSubagentRunner } from '../dist/subagent/runner.js';
import { createSubagent, updateSubagentStatus, clearAllSubagents } from '../dist/subagent/store.js';
import { BUILTIN_INPUT_SCHEMAS } from '../dist/tool-schemas.js';

const MARKER_KEYS = ['_shapedBy', '_l1Applied', '_l2Applied', '_l3Applied'];

function assertNoMarkers(value, at = 'root') {
  if (Array.isArray(value)) { for (const item of value) assertNoMarkers(item, `${at}[]`); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assertNoMarkers(item, `${at}.${key}`);
  }
}

/** 注入 fake adapter；返回 lastReq 读取器。 */
function injectFake({ ready = true, object = null, finishReason = 'stop' } = {}) {
  resetL3Adapter();
  let lastReq = null;
  const adapter = {
    id: 'fake',
    supportsStructuredOutput: ready,
    isReady: async () => ready,
    complete: async (req) => {
      lastReq = req;
      return { object, finishReason, latencyMs: 1, modelId: 'fake' };
    },
  };
  registerAdapterFactory(() => adapter);
  return { getLastReq: () => lastReq };
}

function makeCtx(sessionId = 's-130', transport = 'actions') {
  let record;
  const ctx = {
    transport,
    sessionId,
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

/** 构造 subagent_status 的完整 SubagentStatusResult（含全部内部上下文字段）。 */
function makeStatusResult({ status = 'completed', result = 'final report: all tests passed', taskId = 't-130' } = {}) {
  return {
    status,
    sessionId: 'child-1',
    tasks: [{ id: 't1', status: 'completed', description: 'do the thing' }],
    usage: { inputTokens: 100, outputTokens: 50 },
    ...(status === 'completed' && result !== undefined ? { result } : {}),
    origin: { type: 'skill', skillName: 'demo' },
    auditLogs: [{ type: 'tool_audit', tool: 'execute_cli' }],
    taskId,
  };
}

function shapeStatus(result, ctx) {
  return shapeToolResponse({ ok: true, data: { tool: 'subagent_status', result } }, ctx);
}

/** fake runner deps（m8 手法）：status() 不用这些，占位即可。 */
function fakeRunnerDeps() {
  return {
    runSubagentImpl: async () => ({ status: 'completed', result: 'x' }),
    settings: { enabled: true, provider: 'openai', model: 'gpt-4o', maxTurns: 50, timeoutSec: 300, maxParallel: 2 },
    workspaceDir: '/tmp/test-workspace',
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: () => {
      throw new Error('not used in status-only tests');
    },
  };
}

afterEach(() => {
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）
  clearL3Quota();
  clearAllSubagents();
});

// ═══════════════════════════════════════════════════════════════
// shaper 层：超门首页截断 + 分页提示
// ═══════════════════════════════════════════════════════════════

test('130-首页超门: >24K tokens → L1 截断封顶 + truncated + 诚实字段 + nextCall，不调 L3', async () => {
  const { getLastReq } = injectFake({ object: { conclusion: 'x' } });
  const { ctx, getRecord } = makeCtx();
  const big = 'x'.repeat(120000); // 120000 拉丁 ≈30000 tokens > 24000
  const raw = makeStatusResult({ result: big });
  const shaped = await shapeStatus(raw, ctx);
  const out = shaped.data.result;

  // 首页截断封顶：token 感知 ≤24K 门（RAW_BUDGET_TOKENS），且非整段灌入
  assert.ok(estimateTokens(out.result) <= 24000, '首页 result 不超过 24K token 门');
  assert.ok(out.result.length > 0 && out.result.length < big.length, '确实截断（非原样灌父）');
  // 总量诚实字段（字符 offset 记账，UTF-16 code unit）
  assert.equal(out.resultOffset, 0, '首页 offset=0 诚实字段');
  assert.equal(out.resultTotalChars, big.length, 'resultTotalChars = 全量字符总数（诚实）');
  assert.equal(out.truncated, true, 'truncated=true');
  assert.equal(out.taskId, 't-130', 'taskId 保留（诚实字段）');
  // 分页提示经 L2 合并发射（D15/T07：data.continuation.pagination）
  assert.equal(shaped.data.continuation.pagination.truncated, true);
  const nextCall = shaped.data.continuation.pagination.nextCall;
  assert.deepEqual(nextCall, {
    tool: 'subagent_status',
    input: { taskId: 't-130', offset: out.result.length },
    purpose: 'fetch next page of subagent result',
  }, 'nextCall 续页指针（offset = 首页已给字符数）');
  // 超门不调 L3（D6 护栏2），审计 applied（L1 reducer 生效）
  assert.equal(getLastReq(), null, '超门不调 L3 模型');
  assert.equal(getRecord().shaping.applied, true);
  assertNoMarkers(shaped);
});

test('130-首页超门 CJK: token 感知截断（CJK≈chars×1.5，截断点更短）', async () => {
  injectFake({ object: { conclusion: 'x' } });
  const { ctx } = makeCtx();
  const big = '汉'.repeat(30000); // 30000 CJK ≈45000 tokens > 24000
  const shaped = await shapeStatus(makeStatusResult({ result: big }), ctx);
  const out = shaped.data.result;
  assert.ok(estimateTokens(out.result) <= 24000, 'CJK 首页同样封顶 24K 门');
  assert.ok(out.result.length < big.length, '确实截断');
  assert.equal(out.resultTotalChars, big.length);
  assert.equal(out.truncated, true);
  assert.equal(shaped.data.continuation.pagination.nextCall.input.offset, out.result.length, 'offset 与截断后字符数一致');
});

// ═══════════════════════════════════════════════════════════════
// shaper 层：续页 / 末页
// ═══════════════════════════════════════════════════════════════

test('130-续页: 切片页原样透传（不再截断）+ 诚实字段 + 剩余 nextCall，不调 L3', async () => {
  const { getLastReq } = injectFake({ object: { conclusion: 'x' } });
  const { ctx } = makeCtx();
  const slice = 'y'.repeat(32000); // 续页默认 ~8K tokens 等价字符
  const raw = { ...makeStatusResult({ result: slice }), resultOffset: 32000, resultTotalChars: 120000 };
  const shaped = await shapeStatus(raw, ctx);
  const out = shaped.data.result;

  assert.equal(out.result, slice, '续页内容原样（runner 已切好）');
  assert.equal(out.resultOffset, 32000, 'resultOffset 诚实保留');
  assert.equal(out.resultTotalChars, 120000, 'resultTotalChars 诚实保留');
  assert.equal(out.truncated, true, '还有剩余 → truncated=true');
  assert.deepEqual(shaped.data.continuation.pagination.nextCall, {
    tool: 'subagent_status',
    input: { taskId: 't-130', offset: 64000 },
    purpose: 'fetch next page of subagent result',
  }, 'nextCall offset = 32000 + 32000');
  assert.equal(getLastReq(), null, '切片页不调 L3（抽取只对门内全量做一次）');
  assertNoMarkers(shaped);
});

test('130-末页: 无剩余 → truncated=false，无 nextCall', async () => {
  injectFake({ object: { conclusion: 'x' } });
  const { ctx } = makeCtx();
  const tail = 'z'.repeat(24000);
  const raw = { ...makeStatusResult({ result: tail }), resultOffset: 96000, resultTotalChars: 120000 };
  const shaped = await shapeStatus(raw, ctx);
  const out = shaped.data.result;

  assert.equal(out.result, tail);
  assert.equal(out.truncated, false, '末页 truncated=false');
  assert.equal(shaped.data.continuation, undefined, '无剩余 → 不发射分页 continuation');
  assertNoMarkers(shaped);
});

test('130-切片病理 CJK: 续页超 24K 门 → 该页再截断，offset 记账不漂移', async () => {
  injectFake({ object: { conclusion: 'x' } });
  const { ctx } = makeCtx();
  const slice = '汉'.repeat(20000); // 20000 CJK ≈30000 tokens > 24000（显式超大续页）
  const raw = { ...makeStatusResult({ result: slice }), resultOffset: 32000, resultTotalChars: 100000 };
  const shaped = await shapeStatus(raw, ctx);
  const out = shaped.data.result;

  assert.ok(estimateTokens(out.result) <= 24000, '病理切片同样封顶 24K 门');
  assert.ok(out.result.length < slice.length, '切片再截断');
  const nextOffset = 32000 + out.result.length;
  assert.equal(shaped.data.continuation.pagination.nextCall.input.offset, nextOffset, 'offset 记账 = 页起点 + 本页实发字符数（不漂移不丢数据）');
  assert.equal(out.resultTotalChars, 100000);
  assert.equal(out.truncated, true);
});

// ═══════════════════════════════════════════════════════════════
// shaper 层：零影响 + extracted 照挂 + 防御 fail-open
// ═══════════════════════════════════════════════════════════════

test('130-零影响: 门内小 result → 与旧契约逐字段一致（无分页字段、无 continuation），extracted 照挂', async () => {
  injectFake({ object: { conclusion: 'final report: all tests passed' } });
  const { ctx } = makeCtx();
  const text = 'final report: all tests passed';
  const shaped = await shapeStatus(makeStatusResult({ result: text }), ctx);
  const out = shaped.data.result;

  assert.equal(out.result, text, 'result 原文原样');
  assert.deepEqual(out.extracted, { conclusion: text }, 'extracted 四字段照挂（与分页不冲突）');
  // 零影响：runner 内部记账字段绝不泄漏进小结果输出
  assert.equal('resultOffset' in out, false, '无 resultOffset');
  assert.equal('resultTotalChars' in out, false, '无 resultTotalChars');
  assert.equal('taskId' in out, false, '无 taskId（内部记账字段剥除）');
  assert.equal('truncated' in out, false, '无 truncated');
  assert.equal(shaped.data.continuation, undefined, '无分页 continuation');
  assert.equal(out.status, 'completed');
  assert.deepEqual(out.tasks, [{ id: 't1', status: 'completed', description: 'do the thing' }]);
  assert.deepEqual(out.usage, { inputTokens: 100, outputTokens: 50 });
  assert.deepEqual(out.origin, { type: 'skill', skillName: 'demo' });
  assert.deepEqual(out.auditLogs, [{ type: 'tool_audit', tool: 'execute_cli' }]);
  assertNoMarkers(shaped);
});

test('130-防御: 非 completed → 输出原样（同引用），不调 L3', async () => {
  const { getLastReq } = injectFake({ object: { conclusion: 'x' } });
  const { ctx } = makeCtx();
  const raw = makeStatusResult({ status: 'running' });
  const shaped = await shapeStatus(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, '非 completed 原样');
  assert.equal(getLastReq(), null, '非 completed 不调 L3');
  assertNoMarkers(shaped);
});

test('130-防御: result 非 string → 输出原样', async () => {
  injectFake({ object: { conclusion: 'x' } });
  const { ctx } = makeCtx();
  const raw = { status: 'completed', result: { structured: true }, taskId: 't-130' };
  const shaped = await shapeStatus(raw, ctx);
  assert.strictEqual(shaped.data.result, raw, 'result 非 string 原样');
  assertNoMarkers(shaped);
});

// ═══════════════════════════════════════════════════════════════
// runner 层：真实 store 切片 + 全量保留
// ═══════════════════════════════════════════════════════════════

test('130-runner: 首查全量 + 内部记账字段（store 保留全量不变）', () => {
  const big = 'x'.repeat(120000);
  createSubagent('t-130-run', { subject: 'probe' });
  updateSubagentStatus('t-130-run', 'completed', { result: big });
  const runner = createSubagentRunner(fakeRunnerDeps());
  const st = runner.status('t-130-run');

  assert.equal(st.status, 'completed');
  assert.equal(st.result, big, '首查返回全量（store 全量保留）');
  assert.equal(st.taskId, 't-130-run', 'taskId 内部记账');
  assert.equal(st.resultOffset, 0, 'offset 默认 0');
  assert.equal(st.resultTotalChars, big.length, 'resultTotalChars = 全量字符数');
  assert.equal(st.truncated, false, '全量返回无截断');
});

test('130-runner: offset 切片精确（UTF-16 code unit 同侧记账，续页往返不漂移）', () => {
  const big = 'x'.repeat(120000);
  createSubagent('t-130-run', { subject: 'probe' });
  updateSubagentStatus('t-130-run', 'completed', { result: big });
  const runner = createSubagentRunner(fakeRunnerDeps());

  const page1 = runner.status('t-130-run', 32000);
  assert.equal(page1.result, big.slice(32000, 64000), '默认续页 32000 chars（~8K tokens 等价）');
  assert.equal(page1.resultOffset, 32000);
  assert.equal(page1.resultTotalChars, big.length);
  assert.equal(page1.truncated, true);

  const page2 = runner.status('t-130-run', 64000, 10000); // 显式 limit
  assert.equal(page2.result, big.slice(64000, 74000), '显式 limit 生效');
  assert.equal(page2.resultOffset, 64000);
  assert.equal(page2.truncated, true);

  const tail = runner.status('t-130-run', 110000);
  assert.equal(tail.result, big.slice(110000), '末段不足一页 → 给到末尾');
  assert.equal(tail.truncated, false);

  const beyond = runner.status('t-130-run', 130000);
  assert.equal(beyond.result, '', 'offset 越界 → 空串');
  assert.equal(beyond.truncated, false);
});

test('130-runner: running / 非 string result → 无记账字段', () => {
  createSubagent('t-130-run2', { subject: 'probe' });
  const runner = createSubagentRunner(fakeRunnerDeps());
  const st = runner.status('t-130-run2');
  assert.equal(st.status, 'running');
  assert.equal(st.result, undefined, 'running 无 result');
  assert.equal('resultOffset' in st, false, 'running 无记账字段');
  assert.equal('taskId' in st, false, 'running 无 taskId');
  assert.equal('resultTotalChars' in st, false);
  assert.equal('truncated' in st, false);
});

test('130-runner: 未知 taskId → NOT_FOUND（语义不变）', () => {
  const runner = createSubagentRunner(fakeRunnerDeps());
  assert.throws(() => runner.status('t-130-nope'), (err) => err.code === 'NOT_FOUND');
});

// ═══════════════════════════════════════════════════════════════
// 输入 schema：offset/limit
// ═══════════════════════════════════════════════════════════════

test('130-schema: subagent_status 输入加 offset/limit（字符分页参数）', () => {
  const schema = BUILTIN_INPUT_SCHEMAS.subagent_status;
  assert.deepEqual(schema.properties.taskId, { type: 'string', minLength: 1 });
  assert.deepEqual(schema.properties.offset, { type: 'integer', minimum: 0 }, 'offset ≥0 字符偏移');
  assert.equal(schema.properties.limit.type, 'integer');
  assert.equal(schema.properties.limit.minimum, 1);
  assert.ok(schema.properties.limit.maximum > 0, 'limit 有上界');
  assert.deepEqual(schema.required, ['taskId'], '仅 taskId 必填（offset/limit 可选，向后兼容）');
});
