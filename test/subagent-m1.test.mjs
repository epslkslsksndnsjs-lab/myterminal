import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultSettings, validateSettings } from '../dist/config.js';

// ── 用例 1：默认值 ──
test('createDefaultSettings includes complete subagent defaults', () => {
  const settings = createDefaultSettings();
  assert.ok(settings.subagent, 'subagent section should exist');
  const sub = settings.subagent;

  assert.equal(sub.enabled, true);
  assert.equal(sub.provider, 'openai');
  assert.equal(sub.model, 'gpt-4o');
  assert.equal(sub.maxTurns, 50);
  assert.equal(sub.timeoutSec, 300);
  assert.equal(sub.maxParallel, 2);
  assert.equal(sub.fallbackModel, undefined);
});

// ── 用例 2：合法配置不报错 ──
test('validateSettings accepts legal subagent config', () => {
  const settings = {
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
    subagent: {
      enabled: true,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      maxTurns: 30,
      timeoutSec: 600,
      maxParallel: 1,
    },
  };
  const errors = validateSettings(settings);
  assert.equal(errors.length, 0, 'no errors expected');
  assert.equal(settings.subagent.provider, 'anthropic');
  assert.equal(settings.subagent.model, 'claude-sonnet-4-20250514');
  assert.equal(settings.subagent.maxTurns, 30);
  assert.equal(settings.subagent.timeoutSec, 600);
  assert.equal(settings.subagent.maxParallel, 1);
});

// ── 用例 3：非法 provider ──
test('validateSettings falls back to openai for illegal provider', () => {
  const settings = {
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
    subagent: {
      enabled: true,
      provider: 'kimi',
      model: 'gpt-4o',
      maxTurns: 50,
      timeoutSec: 300,
      maxParallel: 2,
    },
  };
  const errors = validateSettings(settings);
  assert.ok(errors.length > 0, 'should report error for illegal provider');
  assert.ok(errors.some((e) => e.includes('provider')), 'error should mention provider');
  // provider should be normalized to 'openai'
  assert.equal(settings.subagent.provider, 'openai');
});

// ── 用例 3b：deepseek 是合法 provider ──
test('validateSettings accepts deepseek as legal provider', () => {
  const settings = {
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
    subagent: {
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTurns: 50,
      timeoutSec: 300,
      maxParallel: 2,
    },
  };
  const errors = validateSettings(settings);
  assert.equal(errors.length, 0, 'deepseek should be accepted');
  assert.equal(settings.subagent.provider, 'deepseek');
});

// ── 用例 4：越界数值被钳制 ──
test('validateSettings clamps out-of-range numeric values', () => {
  const settings = {
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
    subagent: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-4o',
      maxTurns: 0,       // below min → should clamp to 1
      timeoutSec: 5,      // below min → should clamp to 30
      maxParallel: 99,    // above max → should clamp to 4
    },
  };
  const errors = validateSettings(settings);
  // BoundedInteger silently clamps — no errors for out-of-range
  assert.equal(errors.length, 0, 'clamping should not produce errors');

  assert.equal(settings.subagent.maxTurns, 1, 'maxTurns 0 should clamp to 1');
  assert.equal(settings.subagent.timeoutSec, 30, 'timeoutSec 5 should clamp to 30');
  assert.equal(settings.subagent.maxParallel, 4, 'maxParallel 99 should clamp to 4');
});

// ── 用例 4b：大值被钳制到上限 ──
test('validateSettings clamps large values to upper bound', () => {
  const settings = {
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
    subagent: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-4o',
      maxTurns: 9999,
      timeoutSec: 3600,
      maxParallel: 2,
    },
  };
  validateSettings(settings);
  assert.equal(settings.subagent.maxTurns, 200, 'maxTurns 9999 should clamp to 200');
  assert.equal(settings.subagent.timeoutSec, 3600, 'timeoutSec 3600 is at upper bound');
});

// ── 用例 5：缺失 subagent 段（向后兼容）─
test('validateSettings accepts settings without subagent section', () => {
  const settings = {
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
    // no subagent field
  };
  const errors = validateSettings(settings);
  assert.equal(errors.length, 0, 'missing subagent should not cause errors');
  assert.equal(settings.subagent, undefined, 'subagent should remain undefined');
});

// ── 用例 6：fallbackModel 非法被丢弃 ──
test('validateSettings discards illegal fallbackModel', () => {
  const settings = {
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
    subagent: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-4o',
      maxTurns: 50,
      timeoutSec: 300,
      maxParallel: 2,
      fallbackModel: 123, // non-string
    },
  };
  const errors = validateSettings(settings);
  // fallbackModel being discarded does not produce an error
  assert.ok(!('fallbackModel' in settings.subagent), 'fallbackModel should be deleted');
});

// ── 用例 6b：合法 fallbackModel 保留 ──
test('validateSettings retains legal fallbackModel', () => {
  const settings = {
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
    subagent: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-4o',
      maxTurns: 50,
      timeoutSec: 300,
      maxParallel: 2,
      fallbackModel: 'gpt-4o-mini',
    },
  };
  const errors = validateSettings(settings);
  assert.equal(errors.length, 0);
  assert.equal(settings.subagent.fallbackModel, 'gpt-4o-mini');
});

// ── 用例 7：集成——模拟完整加载流程 ──
test('integration: full settings round-trip with subagent', () => {
  // Simulate parseMyTerminalSettings flow: spread defaults + parsed + validate
  const defaults = createDefaultSettings();
  const parsed = {
    subagent: {
      enabled: false,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      maxTurns: 10,
      timeoutSec: 120,
      maxParallel: 1,
    },
  };
  const settings = { ...defaults, ...parsed };
  const errors = validateSettings(settings);
  assert.equal(errors.length, 0);

  assert.equal(settings.subagent.enabled, false);
  assert.equal(settings.subagent.provider, 'anthropic');
  assert.equal(settings.subagent.model, 'claude-sonnet-4-20250514');
  assert.equal(settings.subagent.maxTurns, 10);
  assert.equal(settings.subagent.timeoutSec, 120);
  assert.equal(settings.subagent.maxParallel, 1);
});

// ── 用例 7b：集成——部分字段由默认值补齐 ──
test('integration: missing subagent fields get defaults', () => {
  const defaults = createDefaultSettings();
  const parsed = {
    subagent: {
      model: 'gpt-4-turbo',
      // provider, enabled, maxTurns, etc. missing
    },
  };
  const settings = { ...defaults, ...parsed };
  const errors = validateSettings(settings);
  assert.equal(errors.length, 0);

  assert.equal(settings.subagent.model, 'gpt-4-turbo');
  assert.equal(settings.subagent.provider, 'openai');
  assert.equal(settings.subagent.enabled, true);
  assert.equal(settings.subagent.maxTurns, 50);
  assert.equal(settings.subagent.timeoutSec, 300);
  assert.equal(settings.subagent.maxParallel, 2);
});
