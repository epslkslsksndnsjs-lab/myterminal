// ADR-0051 P2-03 (#99)：D16.3 聚合字段按工具 opt-in 声明（0050 H5）
//
// 验收覆盖（对应 #99 Acceptance criteria，含 REJECT 整合面修正 ②③）：
//   AC1  git_log L1-only：commitCount === commits 数组长度（恒补——git_log 已豁免 L3
//        （增补-04 #103），reduceGitLogAggregates 是 L1 主路径唯一出口，无回落概念）；
//        adapter 就绪 + 结构化返回合法对象 → 仍不调模型（callCount 0，L3 永不进入）
//   AC2  git_log：真实 CommandResult raw（无 commits）→ 不伪造 commitCount（D11）
//   AC3  session_history：toolBreakdown（按 entry.data.tool 分组计数）/
//        errorCount（ok:false 条目数）；嵌套 ToolResponse 摘要条目 tool 仍参与分组
//   AC4  session_history 畸形（无 history / entries 非数组）→ fail-open，不注入聚合字段
//   AC5  search_text：fileCount（不同文件数）/ uniqueFiles（去重路径列表，多行同文件
//        只算一个）；find_files 不声明这两个字段（D16.3 按工具 opt-in）
//   AC6  session_list：activeCount（非终态）/ completedCount（phase==='completed'，
//        对齐 store.ts TERMINAL_PHASES）；cancelled 两者皆不计
//   AC7  grep L3 schema 无聚合字段（D-10 原则4：派生一律代码后置补）——#103 后 dual
//        仅 execute_cli + run_checks 两个（git_* 已豁免回 L1），逐个断言无聚合字段；
//        subagent_status 旁挂 schema 源文本 grep
//   D17  静默（各路径递归扫描无层标记）
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js）+ 注入 fake adapter
// （registry，issue-38/issue-45/W2 系列手法）。注：任何 src 改动后必须先 bun run build
// 再跑测试（#43）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter, resetL3AdapterInstance } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';

// D16.3 聚合字段全名单（代码后置补、严禁进任何 L3 schema）
const AGGREGATE_KEYS = ['commitCount', 'toolBreakdown', 'errorCount', 'fileCount', 'uniqueFiles', 'activeCount', 'completedCount'];

// D17 静默契约：任何层都不插自标识标记（复用 issue-31 / W2 系列手法）
const MARKER_KEYS = ['_shapedBy', '_l1Applied', '_l2Applied', '_l3Applied'];

function assertNoMarkers(value, at = 'root') {
  if (Array.isArray(value)) { for (const item of value) assertNoMarkers(item, `${at}[]`); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assertNoMarkers(item, `${at}.${key}`);
  }
}

// ── fake adapter（issue-38/45/W2 系列手法）──────────────────────────────────

function injectFake({ ready = true, object = null, finishReason = 'stop', pending = false, throwing = false } = {}) {
  resetL3Adapter();
  let lastReq = null;
  const adapter = {
    id: 'fake',
    supportsStructuredOutput: ready,
    isReady: async () => ready,
    complete: async (req) => {
      lastReq = req;
      if (pending) return new Promise(() => {});
      if (throwing) throw new Error('fake adapter explosion');
      return { object, finishReason, latencyMs: 1, modelId: 'fake' };
    },
  };
  registerAdapterFactory(() => adapter);
  return { getLastReq: () => lastReq };
}

function makeResponse(tool, result) {
  return { ok: true, data: { tool, result } };
}

function makeCtx(sessionId = 's-wp203', transport = 'local') {
  let record;
  const ctx = {
    transport,
    sessionId,
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** 真实 CommandResult raw（L1 denoise 后无 commits 数组 → 不伪造 commitCount）。 */
function gitLogRaw() {
  return {
    command: 'git log --oneline -n 30', cwd: '/ws', exitCode: 0, signal: null, timedOut: false,
    stdout: 'a1b2c3d fix typo\nf6e5d4c feat: add thing', stderr: '', truncated: false, durationMs: 12, cancelled: false,
  };
}

/** 结构化 raw（含 commits 数组；W2-03 AC5 语义等价 fixture 同形）。 */
function gitLogStructuredRaw() {
  return {
    exitCode: 0,
    commits: [
      { hash: 'a1b2c3d', subject: 'fix typo' },
      { hash: 'f6e5d4c', subject: 'feat: add thing' },
    ],
    stderr: '',
  };
}

/** session_history result：混合 tool/ok 的 audit entries（含嵌套 ToolResponse 条目）。 */
function sessionHistoryResult() {
  return {
    history: {
      total: 4, offset: 0,
      entries: [
        { at: '2026-01-01T00:00:00Z', type: 'tool_audit', data: { tool: 'read_file', ok: true, result: { path: 'a.ts' } } },
        { at: '2026-01-01T00:00:01Z', type: 'tool_audit', data: { tool: 'read_file', ok: true, result: { path: 'b.ts' } } },
        { at: '2026-01-01T00:00:02Z', type: 'tool_audit', data: { tool: 'grep', ok: false, error: { code: 'X' }, result: { raw: 'x' } } },
        // 嵌套完整 ToolResponse → 摘要化，但 data.tool 保全 → 仍参与分组
        { at: '2026-01-01T00:00:03Z', type: 'tool_audit', data: { tool: 'session_history', ok: true, result: { ok: true, data: { tool: 'read_file', result: {} } } } },
      ],
    },
  };
}

/** search_text result：多行同文件（去重）、不同文件混合。 */
function searchTextResult() {
  return {
    matches: [
      { path: 'a.ts', line: 1, text: 'foo' },
      { path: 'a.ts', line: 5, text: 'foo' },
      { path: 'b.ts', line: 2, text: 'foo' },
    ],
    truncated: false,
  };
}

/** session_list result：混合 phase（working/completed/waiting/cancelled）。 */
function sessionListResult() {
  return {
    sessions: [
      { id: 's1', name: 'one', phase: 'working', presence: 'claimed' },
      { id: 's2', name: 'two', phase: 'completed', presence: 'released' },
      { id: 's3', name: 'three', phase: 'waiting', presence: 'claimed' },
      { id: 's4', name: 'four', phase: 'cancelled', presence: 'released' },
    ],
    total: 4,
    page: { offset: 0, limit: 20 },
  };
}

// ───────────────────────────────────────────────────────────
// AC1：git_log commitCount（L1-only 恒补 + L3 永不调用）
// ───────────────────────────────────────────────────────────

test('WP203-AC1: git_log L1-only — commitCount 恒补（=== commits 数组长度）+ L3 永不调用', async () => {
  // adapter 就绪且结构化返回合法对象 → 仍不调模型（L1-only：无 schema → L3 永不进入）
  const { getLastReq } = injectFake({ object: { exitCode: 0, commits: [{ hash: 'a1b2c3d', subject: 'fix typo' }], stderr: '' } });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_log', gitLogStructuredRaw()), ctx);

  const r = shaped.data.result;
  assert.deepEqual(r.commits, gitLogStructuredRaw().commits, 'commits 数组原样保全');
  assert.equal(r.commitCount, 2, 'D16.3：commitCount === commits 数组长度（L1-only 恒补）');
  assert.equal(getLastReq(), null, 'L3 永不调用（git_log 已豁免 L3，#103）');
  assert.equal(getRecord().shaping.applied, true);
  assert.equal(getRecord().shaping.reason, undefined, 'L1 主路径无失败原因');
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC2：git_log 真实 CommandResult raw（无 commits）不伪造
// ───────────────────────────────────────────────────────────

test('WP203-AC2: git_log — 真实 CommandResult raw（无 commits）不伪造 commitCount', async () => {
  const { ctx } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('git_log', gitLogRaw()), ctx);

  const r = shaped.data.result;
  assert.equal('commitCount' in r, false, '无 commits 数组 → 不伪造 commitCount（D11 绝不伪造纪律）');
  assert.equal(r.stdout, 'a1b2c3d fix typo\nf6e5d4c feat: add thing', 'stdout 保留');
  assert.equal('command' in r, false, '噪声键剥除');
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC3：session_history toolBreakdown / errorCount
// ───────────────────────────────────────────────────────────

test('WP203-AC3: session_history — toolBreakdown 按 tool 分组计数 + errorCount = ok:false 条目数', async () => {
  const { ctx } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('session_history', sessionHistoryResult()), ctx);

  const r = shaped.data.result;
  assert.deepEqual(r.toolBreakdown, { read_file: 2, grep: 1, session_history: 1 }, '按 entry.data.tool 分组计数（嵌套摘要条目 tool 保全仍参与）');
  assert.equal(r.errorCount, 1, 'ok:false 条目数');
  assert.equal(r.count, 4, '既有 D16.1 count 不受影响');
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC4：session_history 畸形 fail-open
// ───────────────────────────────────────────────────────────

test('WP203-AC4: session_history 畸形（entries 非数组）→ fail-open 不注入聚合字段', async () => {
  const malformed = { history: { total: 1, offset: 0, entries: 'oops' } };
  const { ctx } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('session_history', malformed), ctx);

  const r = shaped.data.result;
  assert.deepEqual(r.history, malformed.history, '值原样保全（fail-open；reducer 浅拷贝系既有行为）');
  assert.equal('toolBreakdown' in r, false, '不注入 toolBreakdown');
  assert.equal('errorCount' in r, false, '不注入 errorCount');
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC5：search_text fileCount / uniqueFiles（find_files 不声明）
// ───────────────────────────────────────────────────────────

test('WP203-AC5a: search_text — fileCount = 不同文件数 / uniqueFiles = 去重路径列表', async () => {
  const { ctx } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('search_text', searchTextResult()), ctx);

  const r = shaped.data.result;
  assert.equal(r.fileCount, 2, '多行同文件只算一个');
  assert.deepEqual(r.uniqueFiles, ['a.ts', 'b.ts'], '去重路径列表（保持 matches 出现序）');
  assert.equal(r.count, 3, '既有 D16.1 count 不受影响');
  assertNoMarkers(shaped);
});

test('WP203-AC5b: find_files 不声明聚合字段（D16.3 按工具 opt-in）', async () => {
  const { ctx } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('find_files', { matches: ['a.ts', 'b.ts'], truncated: false }), ctx);

  const r = shaped.data.result;
  assert.equal(r.count, 2, 'find_files 保留既有 count');
  assert.equal('fileCount' in r, false, 'find_files 无 fileCount');
  assert.equal('uniqueFiles' in r, false, 'find_files 无 uniqueFiles');
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC6：session_list activeCount / completedCount
// ───────────────────────────────────────────────────────────

test('WP203-AC6: session_list — activeCount 非终态 / completedCount = phase==="completed"；cancelled 两者皆不计', async () => {
  const { ctx } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('session_list', sessionListResult()), ctx);

  const r = shaped.data.result;
  assert.equal(r.activeCount, 2, 'working + waiting 为活跃（cancelled/completed 不计）');
  assert.equal(r.completedCount, 1, '仅 phase==="completed" 计入');
  assert.equal(r.count, 4, '既有 count 不受影响');
  assertNoMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC7：grep L3 schema 无聚合字段（D-10 原则4）
// ───────────────────────────────────────────────────────────

test('WP203-AC7a: dual schema 恰为 execute_cli + run_checks（#103 后 git_* 已豁免）且均无聚合字段', () => {
  const schemaTools = [...TOOL_SHAPES.entries()].filter(([, shape]) => shape.schema);
  const names = schemaTools.map(([name]) => name).sort();
  assert.deepEqual(names, ['execute_cli', 'run_checks'], `#103 豁免后 dual 应恰为 execute_cli + run_checks（实际 ${names.join(', ')}）`);
  for (const [, shape] of schemaTools) {
    const props = shape.schema.properties ?? {};
    for (const key of AGGREGATE_KEYS) {
      assert.equal(key in props, false, `schema 不得声明聚合字段 ${key}（派生一律代码后置补）`);
    }
  }
});

test('WP203-AC7b: subagent_status 旁挂 schema 无聚合字段（源文本 grep）', () => {
  const src = fs.readFileSync(new URL('../src/tool-parse.ts', import.meta.url), 'utf8');
  const marker = 'const SUBAGENT_STATUS_RESULT_SCHEMA: JsonSchema = {';
  const start = src.indexOf(marker);
  assert.ok(start >= 0, 'src/tool-parse.ts 应含 SUBAGENT_STATUS_RESULT_SCHEMA 定义');
  const end = src.indexOf('\n};', start);
  assert.ok(end >= 0, 'schema 块应有结束 };');
  const block = src.slice(start, end);
  for (const key of AGGREGATE_KEYS) {
    assert.equal(block.includes(`'${key}'`), false, `SUBAGENT_STATUS_RESULT_SCHEMA 不得声明聚合字段 ${key}`);
  }
});

afterEach(() => {
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）
  clearL3Quota();
});
