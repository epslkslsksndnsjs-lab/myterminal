// ADR-0047 T07 (#35)：session_list 主动精简（D15 前半）
//
// 验收断言：
//   AC1  reducible 长文本字段截断（默认 500 chars，保留头尾 + `...[truncated N chars]`），protected 字段不动
//   AC2  限条目（默认 20）+ truncated:true + count/totalCount（真实总量）
//   AC3  单页（total ≤ limit）：不截断、无 nextCall、不发射 pagination continuation
//   AC4  翻页（offset）：服务端切片后 count = 本页条目，totalCount 仍为真实总量
//   AC5  D17 静默：data.result 中无 pagination / __reduction 层标记
//   AC6  审计精简详情（fieldsReduced / entriesTruncated / originalSize / reducedSize）
//   AC7  data.continuation 合并：不覆盖 decorateContinuation 控制流 continuation，叠加 pagination 子键
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js）；遵循 issue-31 seam。
// 注：服务端切片（offset/limit）由 handler 负责，unit 测试传入的 sessions 已是切片后的页，
//     reducer 只做长文本截断 + 计数/分页报告（与 D15 "reducer 限条目" 语义一致：handler 切片、
//     reducer 据 page 推导 truncated/totalCount/nextCall）。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { shapeToolResponse } from '../dist/tool-parse.js';

const LONG = 'x'.repeat(600);
const SHORT = 'short';

function makeSession(i, { long = false } = {}) {
  return {
    id: `s-${i}`,
    name: `session-${i}`,
    role: 'lead',
    phase: 'working',
    presence: 'active',
    parentSessionId: i === 0 ? undefined : `s-${i - 1}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    tags: ['t'],
    finalSummary: long ? LONG : SHORT,
    task: {
      objective: long ? LONG : SHORT,
      background: long ? LONG : SHORT,
      deliverables: ['d'],
      acceptanceCriteria: ['a'],
      constraints: ['c'],
    },
    latestCheckpoint: { at: '2026-01-01T00:00:00Z', phase: 'working', summary: long ? LONG : SHORT },
  };
}

function makeResponse(sessions, { total, offset = 0, limit = 20, continuation } = {}) {
  const realTotal = typeof total === 'number' ? total : sessions.length;
  const result = { sessions, total: realTotal, page: { offset, limit } };
  const data = { tool: 'session_list', result };
  if (continuation) data.continuation = continuation;
  return { ok: true, data };
}

function ctx() {
  let lastRecord;
  const audit = (record) => { lastRecord = record; };
  return {
    ctx: { transport: 'actions', sessionId: 's-0', resolveTool: () => undefined, audit },
    getRecord: () => lastRecord,
  };
}

test('T07-AC1: reducible 长文本截断（保留头尾 + 标记）+ protected 字段不动', () => {
  const { ctx: c, getRecord } = ctx();
  const resp = makeResponse([makeSession(0, { long: true })], { total: 1 });
  const shaped = shapeToolResponse(resp, c);
  const entry = shaped.data.result.sessions[0];

  // reducible 字段被截断并带标记，保留头尾
  assert.ok(entry.finalSummary.includes('...[truncated'), 'finalSummary 应含截断标记');
  assert.ok(entry.finalSummary.length < LONG.length, 'finalSummary 应短于原文');
  assert.ok(entry.finalSummary.startsWith('x'.repeat(420)), '保留头部');
  assert.ok(entry.finalSummary.endsWith('x'.repeat(60)), '保留尾部');
  assert.ok(entry.task.objective.includes('...[truncated'), 'task.objective 应含截断标记');
  assert.ok(entry.latestCheckpoint.summary.includes('...[truncated'), 'latestCheckpoint.summary 应含截断标记');

  // protected 字段原样
  assert.equal(entry.id, 's-0', 'id 不应被截断');
  assert.equal(entry.name, 'session-0', 'name 不应被截断');
  assert.equal(entry.phase, 'working', 'phase 不应被截断');
  assert.deepEqual(entry.tags, ['t'], 'tags 不应被截断');

  // count / totalCount
  assert.equal(shaped.data.result.count, 1);
  assert.equal(shaped.data.result.totalCount, 1);
  assert.equal(shaped.data.result.truncated, false);

  // 审计
  const rec = getRecord();
  assert.equal(rec.shaping.reduced, true, '审计应标记 reduced');
  assert.equal(rec.shaping.fieldsReduced, 4, '应截断 4 个长文本字段');
  assert.equal(rec.shaping.entriesTruncated, 0);
  assert.ok(rec.shaping.originalSize > rec.shaping.reducedSize, '原始体积应大于精简后');
});

test('T07-AC2: 限条目 20 + truncated:true + count/totalCount（真实总量）+ 分页 continuation', () => {
  const { ctx: c } = ctx();
  const all = Array.from({ length: 25 }, (_, i) => makeSession(i));
  const page1 = all.slice(0, 20); // handler 已切片
  const resp = makeResponse(page1, { total: 25 });
  const shaped = shapeToolResponse(resp, c);

  assert.equal(shaped.data.result.sessions.length, 20, '限条目默认 20');
  assert.equal(shaped.data.result.count, 20);
  assert.equal(shaped.data.result.totalCount, 25, 'totalCount 为真实总量');
  assert.equal(shaped.data.result.truncated, true);

  const cont = shaped.data.continuation;
  assert.ok(cont, '应发射 data.continuation');
  assert.equal(cont.pagination.truncated, true);
  assert.equal(cont.pagination.nextCall.tool, 'session_list');
  assert.deepEqual(cont.pagination.nextCall.input, { offset: 20, limit: 20 }, 'nextCall 指向下一页');
  assert.equal(cont.pagination.nextCall.purpose, 'fetch next page of sessions');
});

test('T07-AC3: 单页（total ≤ limit）不截断、无 nextCall、不发射 pagination', () => {
  const { ctx: c } = ctx();
  const sessions = Array.from({ length: 15 }, (_, i) => makeSession(i));
  const resp = makeResponse(sessions, { total: 15 });
  const shaped = shapeToolResponse(resp, c);

  assert.equal(shaped.data.result.sessions.length, 15);
  assert.equal(shaped.data.result.count, 15);
  assert.equal(shaped.data.result.totalCount, 15);
  assert.equal(shaped.data.result.truncated, false);
  assert.equal(shaped.data.continuation, undefined, '单页不应发射 pagination continuation');
});

test('T07-AC4: 翻页（offset=20）count=本页、totalCount 仍真实总量', () => {
  const { ctx: c } = ctx();
  const all = Array.from({ length: 25 }, (_, i) => makeSession(i));
  const page2 = all.slice(20, 40); // handler 已切片：5 条
  const resp = makeResponse(page2, { total: 25, offset: 20, limit: 20 });
  const shaped = shapeToolResponse(resp, c);

  assert.equal(shaped.data.result.sessions.length, 5, '第二页 5 条');
  assert.equal(shaped.data.result.count, 5);
  assert.equal(shaped.data.result.totalCount, 25, 'totalCount 跨页累计真实总量');
  assert.equal(shaped.data.result.truncated, false, '末页不再 truncated');
  assert.equal(shaped.data.continuation, undefined, '末页不发射 pagination');
});

test('T07-AC5: D17 静默 — data.result 无 pagination / __reduction 层标记', () => {
  const { ctx: c } = ctx();
  const all = Array.from({ length: 25 }, (_, i) => makeSession(i, { long: true }));
  const page1 = all.slice(0, 20);
  const resp = makeResponse(page1, { total: 25 });
  const shaped = shapeToolResponse(resp, c);

  assert.equal('pagination' in shaped.data.result, false, 'data.result 不得含 pagination');
  assert.equal('__reduction' in shaped.data.result, false, 'data.result 不得含 __reduction');
  assert.equal('_shapedBy' in shaped.data.result, false, '不得含层标记');
});

test('T07-AC6: 审计精简详情完整（entriesTruncated / 体积差）', () => {
  const { ctx: c, getRecord } = ctx();
  const all = Array.from({ length: 25 }, (_, i) => makeSession(i, { long: true }));
  const page1 = all.slice(0, 20);
  const resp = makeResponse(page1, { total: 25 });
  shapeToolResponse(resp, c);

  const rec = getRecord();
  assert.equal(rec.shaping.entriesTruncated, 5, '应记录被分页省略的 5 条');
  assert.equal(rec.shaping.fieldsReduced, 20 * 4, '20 条目 × 4 长文本字段');
  assert.ok(typeof rec.shaping.originalSize === 'number' && rec.shaping.originalSize > 0);
  assert.ok(typeof rec.shaping.reducedSize === 'number');
  assert.ok(rec.shaping.originalSize >= rec.shaping.reducedSize);
});

test('T07-AC7: data.continuation 合并 — 不覆盖控制流 continuation，叠加 pagination 子键', () => {
  const { ctx: c } = ctx();
  const all = Array.from({ length: 25 }, (_, i) => makeSession(i));
  const page1 = all.slice(0, 20);
  // 模拟 decorateContinuation 已注入的控制流 continuation
  const controlFlow = {
    status: 'working',
    mustContinue: true,
    continuationMode: 'adaptive',
    reason: 'planned_call_pending',
    nextCall: { tool: 'session_checkpoint', input: { phase: 'working', summary: 'x' }, purpose: 'checkpoint' },
    instruction: 'immediately execute nextCall',
  };
  const resp = makeResponse(page1, { total: 25, continuation: controlFlow });
  const shaped = shapeToolResponse(resp, c);

  const cont = shaped.data.continuation;
  assert.ok(cont, 'continuation 应存在');
  // 控制流字段保全
  assert.equal(cont.status, 'working', '控制流 status 保全');
  assert.equal(cont.mustContinue, true, '控制流 mustContinue 保全');
  assert.equal(cont.nextCall.tool, 'session_checkpoint', '控制流 nextCall 保全（不被分页覆盖）');
  // 分页子键叠加
  assert.equal(cont.pagination.truncated, true, '分页子键叠加');
  assert.equal(cont.pagination.nextCall.tool, 'session_list', '分页 nextCall 独立');
});

test('T07-AC8: 防御 — 畸形 result（缺 sessions / 非对象条目）不抛、fail-open', () => {
  const { ctx: c, getRecord } = ctx();
  // 缺 sessions
  const r1 = shapeToolResponse({ ok: true, data: { tool: 'session_list', result: { total: 0, page: { offset: 0, limit: 20 } } } }, c);
  assert.equal(r1.data.result.sessions.length, 0);
  assert.equal(r1.data.result.totalCount, 0);
  assert.equal(getRecord().shaping.applied, true);

  // 非对象条目
  const r2 = shapeToolResponse({ ok: true, data: { tool: 'session_list', result: { sessions: [null, 42, makeSession(0)], total: 3, page: { offset: 0, limit: 20 } } } }, c);
  assert.equal(r2.data.result.sessions.length, 3, '非对象条目原样保全');
  assert.equal(r2.data.result.count, 3);
});
