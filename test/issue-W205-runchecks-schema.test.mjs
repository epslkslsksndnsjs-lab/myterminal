// ADR-0051 W2-05 (#88)：run_checks schema 注册（dual，0050 B2 + 0051 D-11）
//
// 验收覆盖（对应 #88 Acceptance criteria）：
//   AC1  TOOL_SHAPES 注册 run_checks 双条目：reduce=#79（W1-06）逐项去噪版 +
//        schema 与 D-11 全文一致（deepEqual 逐字；D-11 无顶层 required）
//   AC2  fake adapter 结构化返回（Q5 verbatim 值）→ L3 输出替换 data.result
//        （白名单即丢弃：truncated/durationMs 等 schema 外字段被 Q5 剥），审计 applied:true
//   AC3  Q5 全路径（嵌套逐项校验）：results[] 项内逐字段白名单 + 值存在性——幻觉
//        字段/值 → 该项对应字段被丢；全丢 → q5-rejected 回落 L1 逐项去噪
//        （#79 修复版，不是旧顶层 no-op 版——内层 command/cwd 必须被剥）
//   AC4  失败矩阵全路径回落 L1（#79 reducer）：l3-unavailable / l3-unavailable-timeout /
//        l3-parse-error / q5-rejected / quota / over-budget（预算门）/ engine-error /
//        env 关 L3 —— 审计 applied:true + reason=l3-fallback，回落结果仍逐项去噪（C1 不回退）
//   AC5  成功态语义等价：results[].name/exitCode/stdout/stderr 与 raw 逐字对应（fixture）
//   AC6  运行时探测：transport=actions 真实 run_checks 小脚本（fake adapter）→ 断言字段
//   D17  静默：结果内无任何层标记（复用 assertNoShapingMarkers 手法）
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js）+ 注入 fake adapter
// （registry），与 issue-45 / issue-38 同法。任何 src 改动后必须先 bun run build 再跑测试。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import { registerAdapterFactory, resetL3Adapter } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';

// D-11 拍板全文（0051-adr47-remediation-decisions.md，逐字抄录；无顶层 required）
const D11_RUN_CHECKS_SCHEMA = {
  type: 'object',
  properties: {
    scripts: { type: 'array', items: { type: 'string' } },
    passed: { type: 'boolean' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          exitCode: { type: 'number' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
        required: ['name', 'exitCode'],
      },
    },
  },
};

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

// 0050 #10 场景 fixture：run_checks handler（core-tools.ts）真实响应形状 —
// 顶层 { scripts, results, passed }；results[] 每项 { name, ...CommandResult(10 字段) }。
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

/** 成功 fake：结构化返回（Q5 verbatim 子串 + 白名单外字段一并返回，验证白名单即丢弃）。 */
function structuredReturn() {
  return {
    scripts: ['typecheck', 'build', 'test'],
    passed: false,
    results: [
      {
        name: 'typecheck', exitCode: 0, stdout: 'tsc: no errors', stderr: '',
        truncated: false, durationMs: 1250, // schema 外（白名单即丢弃）
      },
      {
        name: 'build', exitCode: 1, stdout: '', stderr: 'error TS2322: type mismatch',
        truncated: true, durationMs: 3120, // schema 外（白名单即丢弃）
      },
    ],
  };
}

/** 注入 fake adapter；返回 lastReq 读取器。ready=false → l3-unavailable 路径。 */
function injectFake({ ready = true, object = null, finishReason = 'stop', throwOnComplete = false } = {}) {
  resetL3Adapter();
  let lastReq = null;
  const adapter = {
    id: 'fake',
    supportsStructuredOutput: ready,
    isReady: async () => ready,
    complete: async (req) => {
      lastReq = req;
      if (throwOnComplete) throw new Error('fake complete crashed');
      return { object, finishReason, latencyMs: 1, modelId: 'fake' };
    },
  };
  registerAdapterFactory(() => adapter);
  return { getLastReq: () => lastReq };
}

function makeCtx(sessionId = 's-w205', transport = 'actions') {
  let record;
  const ctx = {
    transport,
    sessionId,
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

function shapeRunChecks(result, ctx) {
  return shapeToolResponse({ ok: true, data: { tool: 'run_checks', result } }, ctx);
}

afterEach(() => {
  resetL3Adapter();
  clearL3Quota();
  delete process.env.MYTERMINAL_L3_ENABLED;
  delete process.env.MYTERMINAL_L3_MAX_PER_SESSION;
});

// ───────────────────────────────────────────────────────────
// AC1：双条目注册（reduce=#79 逐项去噪版 + schema=D-11 全文）
// ───────────────────────────────────────────────────────────

test('W2-05-AC1: run_checks 注册双条目 — schema 与 D-11 全文一致，reduce 为逐项去噪版', async () => {
  const entry = TOOL_SHAPES.get('run_checks');
  assert.ok(entry, 'run_checks 应注册');
  assert.ok(entry.schema, '应有 schema（D-11）');
  assert.deepEqual(entry.schema, D11_RUN_CHECKS_SCHEMA, 'schema 与 D-11 逐字一致（无顶层 required）');
  assert.equal(typeof entry.reduce, 'function', '应有 L1 reducer（#79 逐项去噪版）');

  // reduce 行为是逐项去噪版（旧顶层 no-op 版做不到）：L3 关掉后直接回落 L1，
  // results[] 内层 command/cwd 必须被剥
  const saved = process.env.MYTERMINAL_L3_ENABLED;
  process.env.MYTERMINAL_L3_ENABLED = 'false';
  try {
    const { ctx, getRecord } = makeCtx();
    const shaped = await shapeRunChecks(runChecksFixture(), ctx);
    for (const item of shaped.data.result.results) {
      assert.equal('command' in item, false, '逐项剥 command（#79 修复版）');
      assert.equal('cwd' in item, false, '逐项剥 cwd');
      assert.equal('timedOut' in item, false, '逐项剥 timedOut');
    }
    assert.equal(getRecord().shaping.applied, true, '回落 L1 applied:true');
    assert.equal(getRecord().shaping.reason, 'passthrough', 'env 关 L3 也回落 L1（引擎返回 passthrough，D-4 兜底）');
  } finally {
    if (saved === undefined) delete process.env.MYTERMINAL_L3_ENABLED;
    else process.env.MYTERMINAL_L3_ENABLED = saved;
  }
});

// ───────────────────────────────────────────────────────────
// AC2 + AC5：成功态 — L3 输出替换（Q5 后）+ 语义等价（逐字对应）
// ───────────────────────────────────────────────────────────

test('W2-05-AC2/AC5: 成功态 — L3 输出替换 data.result；results[].name/exitCode/stdout/stderr 与 raw 逐字对应；白名单即丢弃', async () => {
  injectFake({ object: structuredReturn() }); // 全部 verbatim 子串 → Q5 全过
  const { ctx, getRecord } = makeCtx();
  const raw = runChecksFixture();
  const shaped = await shapeRunChecks(raw, ctx);

  assert.deepEqual(shaped.data.result, {
    scripts: ['typecheck', 'build', 'test'],
    passed: false,
    results: [
      { name: 'typecheck', exitCode: 0, stdout: 'tsc: no errors', stderr: '' },
      { name: 'build', exitCode: 1, stdout: '', stderr: 'error TS2322: type mismatch' },
    ],
  }, 'L3 输出替换 data.result；schema 外字段（truncated/durationMs）被 Q5 白名单剥除');

  // 语义等价：4 字段与 raw 逐字对应（fixture）
  for (let i = 0; i < raw.results.length; i++) {
    const out = shaped.data.result.results[i];
    const src = raw.results[i];
    assert.equal(out.name, src.name, `results[${i}].name 逐字对应`);
    assert.equal(out.exitCode, src.exitCode, `results[${i}].exitCode 逐字对应`);
    assert.equal(out.stdout, src.stdout, `results[${i}].stdout 逐字对应`);
    assert.equal(out.stderr, src.stderr, `results[${i}].stderr 逐字对应`);
  }

  assert.equal(getRecord().shaping.applied, true, 'L3 成功 applied:true');
  assert.equal(getRecord().shaping.reason, undefined, '成功态无 reason');
  assertNoShapingMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC3：Q5 全路径（嵌套逐项校验）+ 全丢回落
// ───────────────────────────────────────────────────────────

test('W2-05-AC3a: Q5 全路径 — results[] 项内幻觉值被丢，其余 verbatim 字段保留', async () => {
  // fake 返回：stdout 为幻觉值（不在 raw 文本）→ 该字段被 Q5 剥；name/exitCode/stderr verbatim 保留
  injectFake({
    object: {
      scripts: ['typecheck'],
      passed: false,
      results: [
        { name: 'typecheck', exitCode: 0, stdout: 'HALLUCINATED OUTPUT', stderr: '' },
      ],
    },
  });
  const { ctx, getRecord } = makeCtx();
  const raw = {
    scripts: ['typecheck'],
    passed: false,
    results: [{ name: 'typecheck', command: 'x', cwd: '/ws', exitCode: 0, signal: null, timedOut: false, stdout: 'tsc: no errors', stderr: '', truncated: false, durationMs: 5, cancelled: false }],
  };
  const shaped = await shapeRunChecks(raw, ctx);

  assert.deepEqual(shaped.data.result.results[0], { name: 'typecheck', exitCode: 0, stderr: '' },
    '幻觉 stdout 被 Q5 丢；verbatim 字段保留（嵌套逐项校验，非整体拒识）');
  assert.equal(getRecord().shaping.applied, true, '部分保留 → applied:true');
});

test('W2-05-AC3b: Q5 全丢 → q5-rejected 回落 L1 逐项去噪（#79 修复版，非旧 no-op 版）', async () => {
  // fake 返回全部幻觉值（scripts/name 均不在 raw 文本）→ Q5 全字段丢 → q5-rejected。
  // 注：不返回 passed——'true'/'false' 是 raw 子串（truncated/passed 等），布尔存在性
  // 启发式会命中，避免干扰全丢场景。
  injectFake({
    object: {
      scripts: ['xyzzy'],
      results: [{ name: 'xyzzy', exitCode: 99, stdout: 'xyzzy', stderr: 'xyzzy' }],
    },
  });
  const { ctx, getRecord } = makeCtx();
  const shaped = await shapeRunChecks(runChecksFixture(), ctx);

  // 回落 reducer 是 #79 逐项去噪版：results[] 内层 5 噪声键必须剥（旧顶层 no-op 版做不到）
  assert.deepEqual(shaped.data.result, {
    scripts: ['typecheck', 'build', 'test'],
    passed: false,
    results: [
      { name: 'typecheck', exitCode: 0, stdout: 'tsc: no errors', stderr: '', truncated: false, durationMs: 1250 },
      { name: 'build', exitCode: 1, stdout: '', stderr: 'error TS2322: type mismatch', truncated: true, durationMs: 3120 },
    ],
  }, 'q5-rejected 回落 #79 逐项去噪：内层 command/cwd/signal/timedOut/cancelled 剥除，真实数据保留');
  assert.equal(getRecord().shaping.applied, true, '回落 L1 applied:true');
  assert.equal(getRecord().shaping.reason, 'q5-rejected', '审计记失败矩阵原因 q5-rejected');
  assertNoShapingMarkers(shaped);
});

// ───────────────────────────────────────────────────────────
// AC4：失败矩阵全路径回落 L1（#79 reducer），C1 不回退
// ───────────────────────────────────────────────────────────

// 每个失败单元格：断言回落输出 = 逐项去噪版 + 审计 applied:true + reason=失败矩阵具体原因
async function assertFallbackDenoised(name, setup, reason) {
  injectFake(setup);
  const { ctx, getRecord } = makeCtx(`s-${name}`);
  const shaped = await shapeRunChecks(runChecksFixture(), ctx);
  for (const item of shaped.data.result.results) {
    assert.equal('command' in item, false, `[${name}] 回落仍逐项剥 command（C1 不回退）`);
    assert.equal('cwd' in item, false, `[${name}] 回落仍逐项剥 cwd`);
  }
  assert.equal(shaped.data.result.results[1].exitCode, 1, `[${name}] 失败结果 exitCode 保留`);
  assert.equal(shaped.data.result.results[1].stderr, 'error TS2322: type mismatch', `[${name}] stderr 保留`);
  assert.equal(getRecord().shaping.applied, true, `[${name}] 回落 L1 applied:true`);
  assert.equal(getRecord().shaping.reason, reason, `[${name}] 审计 reason=${reason}`);
  assertNoShapingMarkers(shaped);
}

test('W2-05-AC4a: l3-unavailable（supportsStructuredOutput=false）→ 回落 L1 逐项去噪', async () => {
  await assertFallbackDenoised('unavailable', { ready: false }, 'l3-unavailable');
});

test('W2-05-AC4b: l3-parse-error（GBNF 失效，finishReason=error）→ 回落 L1 逐项去噪', async () => {
  await assertFallbackDenoised('parse-error', { object: null, finishReason: 'error' }, 'l3-parse-error');
});

test('W2-05-AC4c: q5-rejected（Q5 全丢）→ 回落 L1 逐项去噪', async () => {
  await assertFallbackDenoised('q5', { object: { scripts: ['nope'] } }, 'q5-rejected');
});

test('W2-05-AC4d: quota（会话配额烧穿）→ 回落 L1 逐项去噪', async () => {
  process.env.MYTERMINAL_L3_MAX_PER_SESSION = '1';
  // 第一次调用烧穿配额（成功消费 1 次），第二次 → quota
  injectFake({ object: structuredReturn() });
  const { ctx } = makeCtx('s-quota');
  await shapeRunChecks(runChecksFixture(), ctx);
  await assertFallbackDenoised('quota', { object: structuredReturn() }, 'quota');
});

test('W2-05-AC4e: over-budget（预算门拦截）→ 回落 L1 逐项去噪（不调模型）', async () => {
  const { getLastReq } = injectFake({ object: structuredReturn() });
  const big = runChecksFixture();
  big.results[1].stdout = 'x'.repeat(200000); // ≫ 24K tokens → 预算门
  const { ctx, getRecord } = makeCtx('s-big');
  const shaped = await shapeRunChecks(big, ctx);
  assert.equal(getLastReq(), null, '预算门拦截 → 不调模型');
  assert.equal(getRecord().shaping.applied, true, '超门回落 L1 applied:true');
  assert.equal(getRecord().shaping.reason, 'over-budget', '超门回落审计 over-budget');
  assert.equal('command' in shaped.data.result.results[0], false, '回落仍逐项去噪');
});

test('W2-05-AC4f: engine-error（complete 抛异常）→ 回落 L1 逐项去噪', async () => {
  await assertFallbackDenoised('engine', { object: structuredReturn(), throwOnComplete: true }, 'engine-error');
});

test('W2-05-AC4g: l3-unavailable-timeout（超时）→ 回落 L1 逐项去噪', async () => {
  // transport=actions → 8s 超时；fake complete 永不 resolve → 真竞速截断
  resetL3Adapter();
  const adapter = {
    id: 'fake-timeout',
    supportsStructuredOutput: true,
    isReady: async () => true,
    complete: () => new Promise(() => {}), // never settles
  };
  registerAdapterFactory(() => adapter);

  const { ctx, getRecord } = makeCtx('s-timeout');
  const shaped = await shapeRunChecks(runChecksFixture(), ctx);
  assert.equal(getRecord().shaping.applied, true, '超时回落 L1 applied:true');
  assert.equal(getRecord().shaping.reason, 'l3-unavailable-timeout', '超时回落审计 l3-unavailable-timeout');
  assert.equal('command' in shaped.data.result.results[0], false, '回落仍逐项去噪');
}, { timeout: 20000 });

// ───────────────────────────────────────────────────────────
// AC6：运行时探测 — actions 通道真实 run_checks 小脚本（fake adapter）
// ───────────────────────────────────────────────────────────

test('W2-05-AC6: 运行时探测 — actions 小脚本 run_checks 结构化返回，字段断言', async () => {
  injectFake({
    object: {
      scripts: ['lint'],
      passed: true,
      results: [{ name: 'lint', exitCode: 0, stdout: 'no lint errors', stderr: '' }],
    },
  });
  const { ctx, getRecord } = makeCtx('s-probe', 'actions');
  const raw = {
    scripts: ['lint'],
    passed: true,
    results: [{ name: 'lint', command: 'npm run lint', cwd: '/ws', exitCode: 0, signal: null, timedOut: false, stdout: 'no lint errors', stderr: '', truncated: false, durationMs: 90, cancelled: false }],
  };
  const shaped = await shapeRunChecks(raw, ctx);

  assert.deepEqual(shaped.data.result, {
    scripts: ['lint'],
    passed: true,
    results: [{ name: 'lint', exitCode: 0, stdout: 'no lint errors', stderr: '' }],
  }, 'actions 通道 L3 输出替换：schema 4 字段齐全，白名单外字段丢弃');
  assert.equal(getRecord().shaping.applied, true, '审计 applied:true');
  assertNoShapingMarkers(shaped);
});
