// ADR-0051 W1-06 (#79)：run_checks reducer 逐项去噪（0050 C1）
//
// 验收断言：
//   AC1  TOOL_SHAPES 注册 run_checks → { reduce }；行为上必须是逐项去噪版
//        （0050 #10：旧注册 denoiseCommandResult 只剥顶层，而 run_checks 的
//        CommandResult 噪声在 results[] 内层（core-tools.ts results.push({ name, ...result })）
//        → 顶层无噪声键，旧 reducer 实际 no-op）
//   AC2  results[] 每项剥 command/cwd/signal/timedOut/cancelled 5 噪声键；保留
//        name/exitCode/stdout/stderr/truncated/durationMs
//   AC3  fail-open：results 缺失/非数组 → 原样；顶层其余字段（scripts/passed 等）原样；
//        顶层剥键逻辑保留（顶层噪声键仍剥）
//   AC4  0050 #10 场景 fixture（真实 run_checks 响应形状）deepEqual 证明「实际剥了什么」
//   AC5  D17 静默：结果内无任何层标记（递归扫描，复用 assertNoShapingMarkers 手法）
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js，遵循 issue-31 seam）。
// 注：任何 src 改动后必须先 bun run build 再跑测试（测试全部从 dist 导入，历史教训见 #43）。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';

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

function makeResponse(tool, result) {
  return { ok: true, data: { tool, result } };
}

function makeCtx() {
  let record;
  const ctx = {
    transport: 'actions',
    sessionId: 's-w106',
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

// 0050 #10 场景 fixture：run_checks handler（core-tools.ts）真实响应形状 —
// 顶层 { scripts, results, passed }；results[] 每项 { name, ...CommandResult(10 字段) }。
// CommandResult 权威 10 字段（ADR-0047 补遗3 evidence-locked）：command / cwd / exitCode /
// signal / timedOut / stdout / stderr / truncated / durationMs / cancelled。
function runChecksFixture() {
  return {
    scripts: ['typecheck', 'build', 'test'],
    passed: false,
    results: [
      {
        name: 'typecheck', command: 'npm run typecheck', cwd: '/ws',
        exitCode: 0, signal: null, timedOut: false,
        stdout: 'tsc: no errors', stderr: '',
        truncated: false, durationMs: 1250, cancelled: false,
      },
      {
        name: 'build', command: 'npm run build', cwd: '/ws',
        exitCode: 1, signal: null, timedOut: false,
        stdout: '', stderr: 'error TS2322: type mismatch',
        truncated: true, durationMs: 3120, cancelled: false,
      },
    ],
  };
}

test('W1-06-AC1: TOOL_SHAPES 注册 run_checks，reducer 为逐项去噪版（旧顶层去噪对 run_checks 是 no-op）', async () => {
  assert.ok(TOOL_SHAPES.has('run_checks'), 'run_checks 应注册');
  assert.equal(typeof TOOL_SHAPES.get('run_checks').reduce, 'function', 'run_checks 应有 L1 reducer');

  // 行为断言：results[] 内层噪声必须被剥（旧 denoiseCommandResult 顶层去噪做不到）
  const { ctx: c } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('run_checks', runChecksFixture()), c);
  for (const item of shaped.data.result.results) {
    assert.equal('command' in item, false, '逐项剥 command');
    assert.equal('cwd' in item, false, '逐项剥 cwd');
    assert.equal('signal' in item, false, '逐项剥 signal');
    assert.equal('timedOut' in item, false, '逐项剥 timedOut');
    assert.equal('cancelled' in item, false, '逐项剥 cancelled');
  }
});

test('W1-06-AC2: results[] 每项剥 5 噪声键，保留 name/exitCode/stdout/stderr/truncated/durationMs', async () => {
  const { ctx: c } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('run_checks', runChecksFixture()), c);

  const [t, b] = shaped.data.result.results;
  assert.deepEqual(
    Object.keys(t).sort(),
    ['durationMs', 'exitCode', 'name', 'stdout', 'stderr', 'truncated'].sort(),
    'typecheck 项：只应剩真实数据字段',
  );
  assert.equal(t.name, 'typecheck');
  assert.equal(t.exitCode, 0);
  assert.equal(t.stdout, 'tsc: no errors');
  assert.equal(t.stderr, '');
  assert.equal(t.truncated, false);
  assert.equal(t.durationMs, 1250);

  assert.deepEqual(
    Object.keys(b).sort(),
    ['durationMs', 'exitCode', 'name', 'stdout', 'stderr', 'truncated'].sort(),
    'build 项：只应剩真实数据字段',
  );
  assert.equal(b.name, 'build');
  assert.equal(b.exitCode, 1, 'exitCode 保留（失败检测依赖它）');
  assert.equal(b.stderr, 'error TS2322: type mismatch', 'stderr 保留（错误详情依赖它）');
  assert.equal(b.truncated, true);
  assert.equal(b.durationMs, 3120);
});

test('W1-06-AC3: fail-open — results 缺失/非数组原样返回；顶层其余字段原样；顶层剥键逻辑保留', async () => {
  // 注：fail-open 断言按字段比较——D16 count 引擎（applyCountRule）会对单数组顶层补
  // count（T03 单数组场景），与 run_checks reducer 本身无关；生产形状恒为
  // { scripts, results, passed } 双数组，count 不介入（AC4 已验证）。
  const { ctx: c1 } = makeCtx();
  const noResults = { scripts: ['typecheck'], passed: true };
  const shaped1 = await shapeToolResponse(makeResponse('run_checks', noResults), c1);
  assert.equal('results' in shaped1.data.result, false, 'results 缺失 → 不新增 results（fail-open）');
  assert.deepEqual(shaped1.data.result.scripts, ['typecheck'], '顶层 scripts 原样');
  assert.equal(shaped1.data.result.passed, true, '顶层 passed 原样');

  const { ctx: c2, getRecord: getRecord2 } = makeCtx();
  const weirdResults = { scripts: ['typecheck'], results: 'not-an-array', passed: true };
  const shaped2 = await shapeToolResponse(makeResponse('run_checks', weirdResults), c2);
  assert.equal('results' in shaped2.data.result, true, 'results 键保留');
  assert.equal(shaped2.data.result.results, 'not-an-array', 'results 非数组 → 原样返回（不抛错）');
  assert.deepEqual(shaped2.data.result.scripts, ['typecheck'], '顶层 scripts 原样');
  assert.equal(shaped2.data.result.passed, true, '顶层 passed 原样');
  assert.equal(getRecord2().shaping.applied, true, 'L1 路径执行（fail-open 不抛，非 reducer-threw）');

  const { ctx: c3 } = makeCtx();
  // 顶层其余字段（scripts/passed）原样；顶层噪声键（command）仍剥（顶层剥键逻辑保留）
  const withTopNoise = {
    scripts: ['typecheck'],
    passed: true,
    command: 'npm run checks',
    results: [
      { name: 'typecheck', command: 'npm run typecheck', cwd: '/ws', exitCode: 0, signal: null, timedOut: false, stdout: 'ok', stderr: '', truncated: false, durationMs: 12, cancelled: false },
    ],
  };
  const shaped3 = await shapeToolResponse(makeResponse('run_checks', withTopNoise), c3);
  assert.deepEqual(shaped3.data.result.scripts, ['typecheck'], '顶层 scripts 原样');
  assert.equal(shaped3.data.result.passed, true, '顶层 passed 原样');
  assert.equal('command' in shaped3.data.result, false, '顶层噪声键 command 仍剥（保留顶层剥键逻辑）');
  assert.equal(shaped3.data.result.results[0].command, undefined, '内层噪声键也剥');
  assert.equal(shaped3.data.result.results[0].exitCode, 0, '内层真实数据保留');
});

test('W1-06-AC4: 0050 #10 场景回归 — 全 fixture deepEqual 证明「实际剥了什么」', async () => {
  const { ctx: c, getRecord } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('run_checks', runChecksFixture()), c);

  assert.deepEqual(shaped.data.result, {
    scripts: ['typecheck', 'build', 'test'],
    passed: false,
    results: [
      {
        name: 'typecheck', exitCode: 0,
        stdout: 'tsc: no errors', stderr: '',
        truncated: false, durationMs: 1250,
      },
      {
        name: 'build', exitCode: 1,
        stdout: '', stderr: 'error TS2322: type mismatch',
        truncated: true, durationMs: 3120,
      },
    ],
  }, '剥后形状：5 噪声键（command/cwd/signal/timedOut/cancelled）逐项剥除，真实数据全保留');
  assert.equal(getRecord().shaping.applied, true, 'L1 路径执行');
  // scripts + results 双数组 → D16 count 引擎不介入（T03 单数组场景）
  assert.equal('count' in shaped.data.result, false, '多数组不补 count');
});

test('W1-06-AC5: D17 静默 — 结果内无任何层标记（递归扫描）', async () => {
  const { ctx: c } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('run_checks', runChecksFixture()), c);
  assertNoShapingMarkers(shaped);
});
