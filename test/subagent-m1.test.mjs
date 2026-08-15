import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { applySubagentDefaults, createDefaultSettings, validateSettings } from '../dist/config.js';

// 最小合法的新契约 subagent 段（三必填齐全，三可选交给默认值）
function newShapeSubagent(overrides = {}) {
  return {
    enabled: true,
    model: 'claude-sonnet-4-20250514',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-test-1234567890',
    ...overrides,
  };
}

function baseSettings(subagent) {
  return {
    schemaVersion: 1,
    workspaceDir: '/tmp/test',
    host: '127.0.0.1',
    port: 3210,
    connectorKey: 'a'.repeat(24),
    actionsToken: 'b'.repeat(24),
    publicBaseUrl: '',
    maxOutputChars: 120_000,
    commandTimeoutSec: 60,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
    ...(subagent ? { subagent } : {}),
  };
}

// ── 用例 1：零默认——装机 createDefaultSettings 不再带 subagent 段 ──
test('createDefaultSettings omits subagent (zero-default)', () => {
  const settings = createDefaultSettings();
  assert.equal(settings.subagent, undefined, 'fresh install must not enable subagent');
});

// ── 用例 2：合法的新契约配置不报错，三可选补默认 ──
test('validateSettings accepts legal subagent config (new contract)', () => {
  const settings = baseSettings(newShapeSubagent());
  const errors = validateSettings(settings);
  assert.equal(errors.length, 0, `no errors expected, got: ${errors.join('; ')}`);

  const sub = settings.subagent;
  assert.equal(sub.model, 'claude-sonnet-4-20250514');
  assert.equal(sub.baseUrl, 'https://api.anthropic.com/v1');
  assert.equal(sub.apiKey, 'sk-ant-test-1234567890');
  // 三可选默认值（D3 数值定案：700/7200）
  assert.equal(sub.maxTurns, 700);
  assert.equal(sub.timeoutSec, 7200);
  assert.equal(sub.maxParallel, 2);
  assert.equal(sub.contextWindow, 120_000);
  assert.equal(sub.maxOutput, 32_000);
  assert.equal(sub.compactThreshold, 80_000);
  assert.equal(sub.fallbackModel, undefined);
});

// ── 用例 3：三必填缺失即报错（零默认铁律）──
test('validateSettings rejects missing required subagent fields', () => {
  // 缺 model
  let s = baseSettings(newShapeSubagent({ model: '' }));
  assert.ok(validateSettings(s).some((e) => e.includes('Subagent model is required.')), 'model required');

  // 缺 baseUrl
  s = baseSettings(newShapeSubagent({ baseUrl: '' }));
  assert.ok(validateSettings(s).some((e) => e.includes('Subagent baseUrl is required.')), 'baseUrl required');

  // 缺 apiKey
  s = baseSettings(newShapeSubagent({ apiKey: '' }));
  assert.ok(validateSettings(s).some((e) => e.includes('Subagent apiKey is required.')), 'apiKey required');
});

// ── 用例 4：越界数值被钳制（新契约）──
test('validateSettings clamps out-of-range numeric values', () => {
  const settings = baseSettings(newShapeSubagent({ maxTurns: 0, timeoutSec: 5, maxParallel: 99 }));
  const errors = validateSettings(settings);
  assert.equal(errors.length, 0, 'clamping should not produce errors');
  assert.equal(settings.subagent.maxTurns, 1, 'maxTurns 0 → 1');
  assert.equal(settings.subagent.timeoutSec, 30, 'timeoutSec 5 → 30');
  assert.equal(settings.subagent.maxParallel, 4, 'maxParallel 99 → 4');
});

// ── 用例 4b：大值被钳制到上限 ──
test('validateSettings clamps large values to upper bound', () => {
  const settings = baseSettings(newShapeSubagent({ maxTurns: 9999, timeoutSec: 999999, maxParallel: 2 }));
  validateSettings(settings);
  assert.equal(settings.subagent.maxTurns, 1600, 'maxTurns 9999 → 1600');
  assert.equal(settings.subagent.timeoutSec, 86400, 'timeoutSec 999999 → 86400');
});

// ── 用例 5：缺失 subagent 段（向后兼容）─
test('validateSettings accepts settings without subagent section', () => {
  const settings = baseSettings(null);
  const errors = validateSettings(settings);
  assert.equal(errors.length, 0, 'missing subagent should not cause errors');
  assert.equal(settings.subagent, undefined, 'subagent should remain undefined');
});

// ── 用例 6：fallbackModel 非法（非字符串）被丢弃 ──
test('validateSettings discards illegal fallbackModel', () => {
  const settings = baseSettings(newShapeSubagent({ fallbackModel: 123 }));
  const errors = validateSettings(settings);
  assert.ok(!('fallbackModel' in settings.subagent), 'fallbackModel should be deleted');
});

// ── 用例 6b：合法 fallbackModel 保留 ──
test('validateSettings retains legal fallbackModel', () => {
  const settings = baseSettings(newShapeSubagent({ fallbackModel: 'gpt-4o-mini' }));
  const errors = validateSettings(settings);
  assert.equal(errors.length, 0);
  assert.equal(settings.subagent.fallbackModel, 'gpt-4o-mini');
});

// ── 用例 7：遗留 provider 配置静默忽略（不报错、不启用）──
test('validateSettings silently ignores legacy provider config (no error)', () => {
  const settings = baseSettings({
    enabled: true,
    provider: 'openai', // 遗留字段
    model: 'gpt-4o',
    maxTurns: 50,
    timeoutSec: 300,
    maxParallel: 2,
  });
  // 缺 baseUrl / apiKey 但含遗留 provider → 不报错（交由迁移工单转换）
  const errors = validateSettings(settings);
  assert.equal(errors.length, 0, `legacy config must load without error, got: ${errors.join('; ')}`);
  // provider 字段被原样保留（静默忽略，不报错、不生效）
  assert.equal(settings.subagent.provider, 'openai');
});

// ── 用例 8：集成——仅填三必填，三可选由默认值补齐 ──
test('integration: missing optional subagent fields get defaults', () => {
  const settings = baseSettings(newShapeSubagent()); // 只给了三必填 + enabled
  // 移除可选字段以模拟用户只填必填
  delete settings.subagent.maxTurns;
  delete settings.subagent.timeoutSec;
  delete settings.subagent.maxParallel;
  delete settings.subagent.contextWindow;
  delete settings.subagent.maxOutput;
  delete settings.subagent.compactThreshold;

  const errors = validateSettings(settings);
  assert.equal(errors.length, 0);
  assert.equal(settings.subagent.maxTurns, 700);
  assert.equal(settings.subagent.timeoutSec, 7200);
  assert.equal(settings.subagent.maxParallel, 2);
  assert.equal(settings.subagent.contextWindow, 120_000);
  assert.equal(settings.subagent.maxOutput, 32_000);
  assert.equal(settings.subagent.compactThreshold, 80_000);
});

// ── 用例 9（S#5 回归）：最小配置只填三必填，applySubagentDefaults 必须补齐可选默认值 ──
// 这是 server.ts 运行时重读路径（不经 validateSettings）所依赖的函数；此前漏施加默认值
// 会导致 executor 在 AbortSignal.timeout(undefined*1000) 抛 RangeError、while(turns<undefined)
// 永不循环——subagent 静默崩溃。本测试锁死"最小配置也能拿到完整默认值"。
test('applySubagentDefaults fills defaults for minimal config (S#5 regression)', () => {
  // 模拟用户只填三必填、完全不写可选字段
  const minimal = {
    model: 'claude-sonnet-4-20250514',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-test-1234567890',
  };
  const normalized = applySubagentDefaults(minimal);

  // 三必填原样保留
  assert.equal(normalized.model, 'claude-sonnet-4-20250514');
  assert.equal(normalized.baseUrl, 'https://api.anthropic.com/v1');
  assert.equal(normalized.apiKey, 'sk-ant-test-1234567890');

  // 可选字段不得为 undefined（这正是 S#5 崩溃根因）
  assert.equal(normalized.maxTurns, 700, 'maxTurns 必须非空，否则 executor while(turns<undefined) 死循环');
  assert.equal(normalized.timeoutSec, 7200, 'timeoutSec 必须非空，否则 AbortSignal.timeout(NaN) 抛 RangeError');
  assert.equal(normalized.maxParallel, 2);
  assert.equal(normalized.contextWindow, 120_000);
  assert.equal(normalized.maxOutput, 32_000);
  assert.equal(normalized.compactThreshold, 80_000);
});

// ── 用例 10（S#5 回归）：applySubagentDefaults 不应破坏已显式提供的可选值 ──
test('applySubagentDefaults preserves explicit optional values (S#5 regression)', () => {
  const withOpts = {
    model: 'm',
    baseUrl: 'b',
    apiKey: 'k',
    maxTurns: 10,
    timeoutSec: 120,
    maxParallel: 3,
    contextWindow: 200_000,
    maxOutput: 16_384,
    compactThreshold: 100_000,
  };
  const normalized = applySubagentDefaults(withOpts);
  assert.equal(normalized.maxTurns, 10);
  assert.equal(normalized.timeoutSec, 120);
  assert.equal(normalized.maxParallel, 3);
  assert.equal(normalized.contextWindow, 200_000);
  assert.equal(normalized.maxOutput, 16_384);
  assert.equal(normalized.compactThreshold, 100_000);
});
