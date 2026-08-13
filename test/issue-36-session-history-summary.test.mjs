// ADR-0047 T08 (#36)：session_history 嵌套完整 ToolResponse → 摘要（D15 ⑨ 递归深度盲区解法）
//
// 验收断言：
//   AC1  嵌套完整 ToolResponse（entry.data.result = { ok, data:{tool,result} }）替换为摘要
//        { tool, ok, bytes? }；摘要不再含完整嵌套 result → 消除递归嵌套爆炸（原 247KB 单条压成几十字节）
//   AC2  非 ToolResponse 包裹的小结果（如 read_file 几行）保留原样（ADR：<500 chars 不丢）
//   AC3  audit 级 entry.data.tool / entry.data.ok 原样保全；仅 entry.data.result 被替换
//   AC4  entryCount?：嵌套 result 自身含 history/entries → 报条目数
//   AC5  errorCode?：嵌套 ok:false 附 error.code
//   AC6  D17 静默：data.result 无 pagination / __reduction 层标记
//   AC7  审计精简详情（fieldsReduced / originalSize / reducedSize）
//   AC8  防御：畸形 result（缺 history / 无 entries / entry 非对象 / 无 data.result）→ 不抛、fail-open
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js）；遵循 issue-31 seam。
// 注：read_file_range 的 maxBytes 截断（同属 T08）落在 handler（core-tools.ts），由 e2e T08 覆盖；
//     本文件只验 session_history reducer（L2 静态规则层）。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { shapeToolResponse } from '../dist/tool-parse.js';

const HUGE = 'y'.repeat(100_000); // 100KB 噪声串，模拟嵌套爆炸的单条体量

/** 构造 session_history 响应；entries 已是 handler 切片后的页。 */
function makeResponse(entries, { total, offset = 0, nextOffset } = {}) {
  const realTotal = typeof total === 'number' ? total : entries.length;
  const history = { total: realTotal, offset };
  if (nextOffset !== undefined) history.nextOffset = nextOffset;
  history.entries = entries;
  return { ok: true, data: { tool: 'session_history', result: { history } } };
}

/** 构造 tool_audit entry，其 data.result 为完整嵌套 ToolResponse。 */
function auditEntry(tool, ok, innerResult, { errorCode } = {}) {
  const nested = { ok, data: { tool, result: innerResult } };
  if (errorCode !== undefined) nested.error = { code: errorCode, message: 'boom' };
  return {
    sessionId: 's-x',
    sessionName: 'n',
    at: '2026-08-10T00:00:00Z',
    type: 'tool_audit',
    data: { id: 'a', timestamp: '2026-08-10T00:00:00Z', tool, ok, result: nested },
  };
}

/** 非 tool_audit 的简单 entry（如 session_created），无嵌套 result。 */
function createdEntry() {
  return {
    sessionId: 's-x',
    sessionName: 'n',
    at: '2026-08-10T00:00:00Z',
    type: 'session_created',
    data: { mode: 'root' },
  };
}

function ctx() {
  let lastRecord;
  const audit = (record) => { lastRecord = record; };
  return {
    ctx: { transport: 'actions', sessionId: 's-x', resolveTool: () => undefined, audit },
    getRecord: () => lastRecord,
  };
}

test('T08-AC1: 嵌套完整 ToolResponse → 摘要，消除递归嵌套爆炸', () => {
  const { ctx: c, getRecord } = ctx();
  const big = auditEntry('read_file', true, { session: { id: 's', name: HUGE, log: HUGE } });
  const resp = makeResponse([createdEntry(), big], { total: 2 });
  const shaped = shapeToolResponse(resp, c);

  const entries = shaped.data.result.history.entries;
  const bigShaped = entries[1];
  const summary = bigShaped.data.result;

  // 已是摘要：含 tool/ok/bytes，不再含 HUGE 噪声
  assert.equal(summary.tool, 'read_file', '摘要 tool 取自嵌套 data.tool');
  assert.equal(summary.ok, true);
  assert.ok(typeof summary.bytes === 'number' && summary.bytes > HUGE.length, 'bytes 给原嵌套量级');
  assert.equal('entryCount' in summary, false, '无嵌套 history 则无 entryCount');
  assert.equal('errorCode' in summary, false, '成功则无 errorCode');

  // 爆炸消除：序列化后的整条 history 不再含 HUGE 串
  const serialized = JSON.stringify(shaped.data.result.history);
  assert.ok(!serialized.includes(HUGE), '摘要后不得再含完整嵌套 result（爆炸消除）');

  // 审计
  const rec = getRecord();
  assert.equal(rec.shaping.applied, true);
  assert.equal(rec.shaping.fieldsReduced, 1, '应记录 1 条被摘要化的嵌套 result');
  assert.ok(rec.shaping.originalSize > rec.shaping.reducedSize + HUGE.length / 2, '精简幅度应巨大');
});

test('T08-AC2: 非 ToolResponse 包裹的小结果保留原样', () => {
  const { ctx: c } = ctx();
  // 模拟历史上的小结果输出（非 ToolResponse 形态，如 read_file 几行字符串）
  const smallEntry = { ...createdEntry(), type: 'tool_audit', data: { id: 'a', tool: 'read_file', ok: true, result: 'line1\nline2\nline3' } };
  const resp = makeResponse([smallEntry], { total: 1 });
  const shaped = shapeToolResponse(resp, c);

  // result 原样（字符串不被动），不摘要化
  assert.equal(shaped.data.result.history.entries[0].data.result, 'line1\nline2\nline3', '非 ToolResponse 小结果保留原样');
});

test('T08-AC3: audit 级 tool/ok 保全，仅 data.result 被替换', () => {
  const { ctx: c } = ctx();
  const big = auditEntry('session_register', false, { id: 's' }, { errorCode: 'E_PERM' });
  const resp = makeResponse([big], { total: 1 });
  const shaped = shapeToolResponse(resp, c);

  const entry = shaped.data.result.history.entries[0];
  // audit 级元信息原样
  assert.equal(entry.data.tool, 'session_register', 'audit 级 tool 保全');
  assert.equal(entry.data.ok, false, 'audit 级 ok 保全');
  // 仅 data.result 被替换为摘要
  assert.equal(entry.data.result.tool, 'session_register', '摘要 tool');
  assert.equal(entry.data.result.ok, false, '摘要 ok 取自嵌套 ToolResponse');
  assert.equal(entry.data.result.errorCode, 'E_PERM', '摘要 errorCode');
});

test('T08-AC4: entryCount? — 嵌套 result 自身含 history/entries 报条目数', () => {
  const { ctx: c } = ctx();
  // 嵌套一次 session_history 调用：inner result = { history: { entries: [5 条] } }
  const nestedHistory = { history: { total: 5, offset: 0, entries: [1, 2, 3, 4, 5].map((i) => ({ i })) } };
  const big = auditEntry('session_history', true, nestedHistory);
  const resp = makeResponse([big], { total: 1 });
  const shaped = shapeToolResponse(resp, c);

  const summary = shaped.data.result.history.entries[0].data.result;
  assert.equal(summary.entryCount, 5, '嵌套 history 条目数应上报');
  assert.equal(summary.tool, 'session_history');
  // 摘要本身不得再含完整嵌套 entries 数组（防爆栈）
  assert.ok(!JSON.stringify(summary).includes('"history"'), '摘要不得含完整嵌套 history');
});

test('T08-AC5: errorCode? — 嵌套 ok:false 附 error.code', () => {
  const { ctx: c } = ctx();
  const big = auditEntry('write_file', false, { id: 'f' }, { errorCode: 'E_NOENT' });
  const resp = makeResponse([big], { total: 1 });
  const shaped = shapeToolResponse(resp, c);

  const summary = shaped.data.result.history.entries[0].data.result;
  assert.equal(summary.ok, false);
  assert.equal(summary.errorCode, 'E_NOENT', '失败附 errorCode');
});

test('T08-AC6: D17 静默 — data.result / 摘要内无 pagination / __reduction 层标记', () => {
  const { ctx: c } = ctx();
  const big = auditEntry('read_file', true, { session: { id: 's', name: HUGE } });
  const resp = makeResponse([big, big], { total: 2 });
  const shaped = shapeToolResponse(resp, c);

  assert.equal('pagination' in shaped.data.result, false, 'data.result 不得含 pagination');
  assert.equal('__reduction' in shaped.data.result, false, 'data.result 不得含 __reduction');
  assert.equal('_shapedBy' in shaped.data.result, false, '不得含层标记');
  // 摘要对象本身也干净
  const summary = shaped.data.result.history.entries[0].data.result;
  assert.equal('pagination' in summary, false);
  assert.equal('__reduction' in summary, false);
});

test('T08-AC7: 审计精简详情（fieldsReduced / 体积差）', () => {
  const { ctx: c, getRecord } = ctx();
  const big = auditEntry('read_file', true, { session: { id: 's', name: HUGE } });
  const resp = makeResponse([createdEntry(), big, big], { total: 3 });
  shapeToolResponse(resp, c);

  const rec = getRecord();
  assert.equal(rec.shaping.fieldsReduced, 2, '2 条嵌套 result 被摘要化');
  assert.ok(rec.shaping.originalSize > rec.shaping.reducedSize, '原始体积应远大于精简后');
});

test('T08-AC8: 防御 — 畸形 result 不抛、fail-open', () => {
  const { ctx: c, getRecord } = ctx();
  // 缺 history
  const r1 = shapeToolResponse({ ok: true, data: { tool: 'session_history', result: { total: 0, entries: [] } } }, c);
  assert.equal('history' in r1.data.result, false, '无 history 时结构原样（不注入）');
  assert.equal(getRecord().shaping.applied, true);

  // entries 非数组
  const r2 = shapeToolResponse(makeResponse(null, { total: 0 }), c);
  assert.equal(r2.data.result.history.entries, null, '非数组 entries 原样');

  // entry 非对象 / 无 data.result
  const weird = makeResponse([null, createdEntry(), { type: 'x', data: { id: 1 } }], { total: 3 });
  const r3 = shapeToolResponse(weird, c);
  assert.equal(r3.data.result.history.entries.length, 3, '非对象/无 data.result 的 entry 原样保全');
});
