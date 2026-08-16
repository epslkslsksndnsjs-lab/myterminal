// ADR-0048 T2 #133 —— subagent_start 契约精简（D3 数值+兜底）
// 红绿切片：先红后绿。范围：schema 砍四字段 + 数值放宽（1600/86400）+ 默认值
// 单点（700/7200）+ toTaskPackage 兜底 objective 派生 + assembleTask objective-only 适配。
// 手法：schema 直查 + jsonSchemaToZod 派生往返 + applySubagentDefaults 单点 +
//       runner 级 fakeDeps（m8 手法）捕获 registerAndClaimChild 的 TaskPackage。

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { BUILTIN_INPUT_SCHEMAS } from '../dist/tool-schemas.js';
import { jsonSchemaToZod } from '../dist/mcp-schema.js';
import { validateJsonSchema } from '../dist/security.js';
import { applySubagentDefaults } from '../dist/config.js';
import { createSubagentRunner, setRunnerDepsForTesting, resetSubagentRunner } from '../dist/subagent/runner.js';
import { clearAllSubagents } from '../dist/subagent/store.js';

// ── 辅助（m8 手法：fakeDeps + runner 捕获）──

function fakeDeps(overrides = {}) {
  const callLog = [];
  const deps = {
    runSubagentImpl: overrides.runSubagentImpl ?? (async () => ({ status: 'completed', result: 'ok' })),
    settings: overrides.settings ?? { enabled: true, maxTurns: 700, timeoutSec: 7200, maxParallel: 4 },
    workspaceDir: '/tmp/test-workspace',
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: ((parentId, args) => {
      callLog.push({ registerAndClaimChild: { parentId, args } });
      return {
        session: { id: 'ses_child_x', name: args.name, role: 'worker', phase: 'working', presence: 'claimed', task: args.task },
        identity: { sessionId: 'ses_child_x', sessionToken: 'tok_x' },
      };
    }),
  };
  return { deps, callLog };
}

function setupRunner(overrides = {}) {
  const { deps, callLog } = fakeDeps(overrides);
  const runner = createSubagentRunner(deps);
  setRunnerDepsForTesting(deps);
  return { runner, callLog };
}

// ══════════════════════════════════════════════════════
// A. schema 契约：砍四字段 + 数值放宽
// ══════════════════════════════════════════════════════

describe('issue-133: subagent_start schema 精简（D3）', () => {
  test('A1: 四字段已砍、objective 必填、新增数值上限正确', () => {
    const props = BUILTIN_INPUT_SCHEMAS.subagent_start.properties ?? {};
    for (const cut of ['background', 'deliverables', 'acceptanceCriteria', 'constraints']) {
      assert.ok(!(cut in props), `subagent_start 不应再暴露 ${cut}`);
    }
    assert.ok('objective' in props, 'objective 必须保留');
    assert.deepEqual(BUILTIN_INPUT_SCHEMAS.subagent_start.required, ['objective']);
    assert.equal(props.maxTurns.maximum, 1600, 'maxTurns 上限应放宽到 1600');
    assert.equal(props.maxTurns.minimum, 1, 'maxTurns 下限不变');
    assert.equal(props.timeoutSec.maximum, 86400, 'timeoutSec 上限应放宽到 86400');
    assert.equal(props.timeoutSec.minimum, 30, 'timeoutSec 下限不变');
    assert.equal(props.readOnly.type, 'boolean', 'readOnly 保留');
  });

  test('A2: 运行期校验器拒绝已砍字段（invokeTool 用 validateJsonSchema，additionalProperties:false 生效）', () => {
    const errs = (v) => validateJsonSchema(BUILTIN_INPUT_SCHEMAS.subagent_start, v);
    assert.notEqual(errs({ objective: 'o', background: 'b' }).length, 0, 'background 应被拒');
    assert.notEqual(errs({ objective: 'o', deliverables: ['d'] }).length, 0, 'deliverables 应被拒');
    assert.notEqual(errs({ objective: 'o', acceptanceCriteria: ['a'] }).length, 0, 'acceptanceCriteria 应被拒');
    assert.notEqual(errs({ objective: 'o', constraints: ['c'] }).length, 0, 'constraints 应被拒');
    // 对照：MCP 派生 zod 走 main 基线 strip 语义（展示层放行、运行期拒绝——mcp-schema.ts 顶部说明）
    assert.equal(jsonSchemaToZod(BUILTIN_INPUT_SCHEMAS.subagent_start, 'subagent_start').safeParse({ objective: 'o', background: 'b' }).success, true, '派生 zod 应 strip 放行（基线语义）');
  });

  test('A3: 新上限边界——1600/86400 放行，越界拒绝', () => {
    const of = (v) => jsonSchemaToZod(BUILTIN_INPUT_SCHEMAS.subagent_start, 'subagent_start').safeParse(v);
    assert.equal(of({ objective: 'o', maxTurns: 1600 }).success, true, 'maxTurns=1600 应在界内');
    assert.equal(of({ objective: 'o', maxTurns: 1601 }).success, false, 'maxTurns=1601 应被拒');
    assert.equal(of({ objective: 'o', timeoutSec: 86400 }).success, true, 'timeoutSec=86400 应在界内');
    assert.equal(of({ objective: 'o', timeoutSec: 86401 }).success, false, 'timeoutSec=86401 应被拒');
  });
});

// ══════════════════════════════════════════════════════
// B. 数值单点：applySubagentDefaults（config.ts）
// ══════════════════════════════════════════════════════

describe('issue-133: applySubagentDefaults 数值单点（D3）', () => {
  test('B1: 新默认值 700/7200', () => {
    const sub = applySubagentDefaults({});
    assert.equal(sub.maxTurns, 700, 'maxTurns 默认应为 700');
    assert.equal(sub.timeoutSec, 7200, 'timeoutSec 默认应为 7200');
  });

  test('B2: 新上限夹取 1600/86400', () => {
    const sub = applySubagentDefaults({ maxTurns: 9999, timeoutSec: 999_999 });
    assert.equal(sub.maxTurns, 1600, 'maxTurns 9999 应夹到 1600');
    assert.equal(sub.timeoutSec, 86400, 'timeoutSec 999999 应夹到 86400');
  });

  test('B3: 下限不变（1/30）', () => {
    const sub = applySubagentDefaults({ maxTurns: 0, timeoutSec: 5 });
    assert.equal(sub.maxTurns, 1, 'maxTurns 0 → 1');
    assert.equal(sub.timeoutSec, 30, 'timeoutSec 5 → 30');
  });
});

// ══════════════════════════════════════════════════════
// C. toTaskPackage 兜底 objective 派生（重拷 Q2）+ assembleTask 适配
// ══════════════════════════════════════════════════════

describe('issue-133: toTaskPackage 兜底 + assembleTask（D3）', () => {
  const LONG_OBJECTIVE = '实现账单模块：把当前流水按日聚合，输出 CSV 到 output/ 目录；验收标准是每个文件头尾有汇总行，约束是不能动既有文件。'.repeat(3);

  test('C1: 四字段缺省 → 全部 objective 派生（无硬编码文案）', () => {
    clearAllSubagents();
    resetSubagentRunner();
    const { runner, callLog } = setupRunner();
    runner.start('ses_parent_01', { objective: LONG_OBJECTIVE });
    const calls = callLog.filter((c) => c.registerAndClaimChild);
    assert.equal(calls.length, 1);
    const taskPkg = calls[0].registerAndClaimChild.args.task;
    assert.equal(taskPkg.background, LONG_OBJECTIVE, 'background 兜底应为完整 objective（非前 100 字）');
    assert.deepEqual(taskPkg.deliverables, [LONG_OBJECTIVE], 'deliverables 兜底应为 objective 派生');
    assert.deepEqual(taskPkg.acceptanceCriteria, [LONG_OBJECTIVE], 'acceptanceCriteria 兜底应为 objective 派生');
    assert.deepEqual(taskPkg.constraints, [LONG_OBJECTIVE], 'constraints 兜底应为 objective 派生');
  });

  test('C2: 内部四字段显式传入 → 原样透传（SubagentStartInput 保留可选）', () => {
    clearAllSubagents();
    resetSubagentRunner();
    const { runner, callLog } = setupRunner();
    runner.start('ses_parent_01', {
      objective: 'o',
      background: '  bg  ',
      deliverables: ['d1'],
      acceptanceCriteria: ['a1'],
      constraints: ['c1'],
    });
    const calls = callLog.filter((c) => c.registerAndClaimChild);
    const taskPkg = calls[0].registerAndClaimChild.args.task;
    assert.equal(taskPkg.background, 'bg', '显式 background 应 trim 后透传');
    assert.deepEqual(taskPkg.deliverables, ['d1']);
    assert.deepEqual(taskPkg.acceptanceCriteria, ['a1']);
    assert.deepEqual(taskPkg.constraints, ['c1']);
  });

  test('C3: assembleTask objective-only 适配——无四字段段落渲染（经 runSubagentImpl 捕获）', async () => {
    clearAllSubagents();
    resetSubagentRunner();
    let capturedTask = null;
    const { runner } = setupRunner({
      runSubagentImpl: async (opts) => { capturedTask = opts.task; return { status: 'completed', result: 'ok' }; },
    });
    runner.start('ses_parent_01', { objective: '像交接给新同事一样写完整的一段话' });
    assert.ok(capturedTask.includes('## Objective\n像交接给新同事一样写完整的一段话'), 'objective 段必须渲染');
    assert.ok(!capturedTask.includes('## Deliverables'), '无 deliverables 时不得渲染该段');
    assert.ok(!capturedTask.includes('## Acceptance Criteria'), '无 acceptanceCriteria 时不得渲染该段');
    assert.ok(!capturedTask.includes('## Constraints'), '无 constraints 时不得渲染该段');
    assert.ok(!capturedTask.includes('## Background'), '无 background 时不得渲染该段');
  });
});

test('C4: 子 agent 覆盖接线——input.maxTurns/timeoutSec 覆盖 settings（mergedSettings）', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  let capturedSettings = null;
  const { runner } = setupRunner({
    runSubagentImpl: async (opts) => { capturedSettings = opts.settings; return { status: 'completed', result: 'ok' }; },
  });
  runner.start('ses_parent_01', { objective: 'o', maxTurns: 42, timeoutSec: 99 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(capturedSettings.maxTurns, 42, 'input.maxTurns 应覆盖 settings');
  assert.equal(capturedSettings.timeoutSec, 99, 'input.timeoutSec 应覆盖 settings');
});
