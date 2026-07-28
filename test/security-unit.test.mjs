import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { safeEqual, resolveWorkspacePath, validateJsonSchema } from '../dist/security.js';
import { validateSettings, createDefaultSettings } from '../dist/config.js';
import { MyTerminalStore } from '../dist/store.js';

// ═══════════════════════════════════════════════════════════
// SEC-1 杀手：safeEqual 必须对不同输入返回 false
// ═══════════════════════════════════════════════════════════

describe('safeEqual', () => {
  test('identical strings return true', () => {
    assert.equal(safeEqual('abc123', 'abc123'), true);
  });

  test('different strings return false', () => {
    assert.equal(safeEqual('correct-token', 'wrong-token'), false);
  });

  test('empty vs non-empty returns false', () => {
    assert.equal(safeEqual('', 'not-empty'), false);
  });

  test('case-sensitive comparison', () => {
    assert.equal(safeEqual('ABC', 'abc'), false);
  });
});

// ═══════════════════════════════════════════════════════════
// SEC-2 杀手：resolveWorkspacePath 必须拒绝路径穿越
// ═══════════════════════════════════════════════════════════

describe('resolveWorkspacePath', () => {
  let workspace;
  let stateDir;

  test('setup', () => {
    workspace = mkdtempSync(join(tmpdir(), 'sec-ws-'));
    stateDir = join(workspace, '.myterminal');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(workspace, 'hello.txt'), 'world');
  });

  test('valid relative path resolves', () => {
    const result = resolveWorkspacePath(workspace, stateDir, 'hello.txt');
    assert.equal(result, join(realpathSync(workspace), 'hello.txt'));
  });

  test('dot-dot traversal throws', () => {
    assert.throws(
      () => resolveWorkspacePath(workspace, stateDir, '../../etc/passwd'),
      /Path escapes workspace/,
    );
  });

  test('absolute path outside workspace throws', () => {
    assert.throws(
      () => resolveWorkspacePath(workspace, stateDir, '/etc/passwd'),
      /Path escapes workspace/,
    );
  });

  test('state directory is protected', () => {
    assert.throws(
      () => resolveWorkspacePath(workspace, stateDir, '.myterminal'),
      /Internal MyTerminal state is protected/,
    );
  });

  test('cleanup', () => {
    rmSync(workspace, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════
// SEC-3 杀手：validateJsonSchema 必须报告缺失 required 字段
// ═══════════════════════════════════════════════════════════

describe('validateJsonSchema', () => {
  test('missing required field produces error', () => {
    const schema = { type: 'object', required: ['name', 'age'], properties: { name: { type: 'string' }, age: { type: 'number' } } };
    const errors = validateJsonSchema(schema, { name: 'Alice' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /age.*required/);
  });

  test('all required present produces no error', () => {
    const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
    const errors = validateJsonSchema(schema, { name: 'Bob' });
    assert.equal(errors.length, 0);
  });

  test('type mismatch produces error', () => {
    const schema = { type: 'object', properties: { count: { type: 'number' } } };
    const errors = validateJsonSchema(schema, { count: 'not-a-number' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /count must be number/);
  });

  test('enum violation produces error', () => {
    const schema = { type: 'string', enum: ['a', 'b', 'c'] };
    const errors = validateJsonSchema(schema, 'z');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /enum/);
  });

  test('minLength violation produces error', () => {
    const schema = { type: 'string', minLength: 3 };
    const errors = validateJsonSchema(schema, 'ab');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /shorter than 3/);
  });
});

// ═══════════════════════════════════════════════════════════
// CFG-3 杀手：validateSettings 必须拒绝短凭据
// ═══════════════════════════════════════════════════════════

describe('validateSettings credential length', () => {
  test('short connectorKey is rejected', () => {
    const settings = { ...createDefaultSettings('/tmp'), connectorKey: 'short' };
    const errors = validateSettings(settings);
    assert.ok(errors.some((e) => e.includes('at least 24 characters')), `Expected credential error, got: ${errors}`);
  });

  test('short actionsToken is rejected', () => {
    const settings = { ...createDefaultSettings('/tmp'), actionsToken: 'tiny' };
    const errors = validateSettings(settings);
    assert.ok(errors.some((e) => e.includes('at least 24 characters')), `Expected credential error, got: ${errors}`);
  });

  test('valid length credentials pass', () => {
    const settings = { ...createDefaultSettings('/tmp'), connectorKey: 'a'.repeat(24), actionsToken: 'b'.repeat(24) };
    const errors = validateSettings(settings);
    assert.ok(!errors.some((e) => e.includes('24 characters')), `Should not have credential error: ${errors}`);
  });
});

// ═══════════════════════════════════════════════════════════
// STO-2 杀手：已完成 session 不可再 checkpoint
// ═══════════════════════════════════════════════════════════

describe('terminal session immutability', () => {
  test('checkpoint on completed session throws SESSION_TERMINAL', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sto2-ws-'));
    const stateDir = join(workspace, '.myterminal');
    mkdirSync(stateDir, { recursive: true });
    const store = new MyTerminalStore(stateDir);
    try {
      const { session } = store.registerRoot({ name: 'immutability-test' });
      store.checkpoint(session.id, { phase: 'completed', summary: 'done' });
      let threw = false;
      try {
        store.checkpoint(session.id, { phase: 'working', summary: 'should fail' });
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'SESSION_TERMINAL');
      }
      // Whether it threw or silently proceeded, phase MUST remain completed
      assert.equal(store.session(session.id).phase, 'completed', 'terminal session phase must not change');
      assert.equal(threw, true, 'checkpoint on terminal session must throw');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('checkpoint on cancelled session throws SESSION_TERMINAL', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sto2b-ws-'));
    const stateDir = join(workspace, '.myterminal');
    mkdirSync(stateDir, { recursive: true });
    const store = new MyTerminalStore(stateDir);
    try {
      const { session } = store.registerRoot({ name: 'cancel-test' });
      store.checkpoint(session.id, { phase: 'cancelled', summary: 'abandoned' });
      let threw = false;
      try {
        store.checkpoint(session.id, { phase: 'working', summary: 'should fail' });
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'SESSION_TERMINAL');
      }
      assert.equal(store.session(session.id).phase, 'cancelled', 'cancelled session phase must not change');
      assert.equal(threw, true, 'checkpoint on cancelled session must throw');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  // STO-2 真正目标：inherit() 的终态守卫（非 checkpoint）
  test('inherit on completed session throws SESSION_TERMINAL', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sto2c-ws-'));
    const stateDir = join(workspace, '.myterminal');
    mkdirSync(stateDir, { recursive: true });
    const store = new MyTerminalStore(stateDir);
    try {
      const { session, identity } = store.registerRoot({ name: 'inherit-terminal' });
      // 用已认证身份将会话置为 completed
      store.checkpoint(session.id, { phase: 'completed', summary: 'all done' });
      // 尝试 inherit 已完成的会话——终态守卫在凭据校验之前，必须抛 SESSION_TERMINAL
      let threw = false;
      try {
        store.inherit(session.id, { claimCode: 'any-code' });
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'SESSION_TERMINAL');
        assert.match(err.message, /create a continuation session/);
      }
      assert.equal(threw, true, 'inherit on terminal session must throw');
      assert.equal(store.session(session.id).phase, 'completed');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('inherit on cancelled session throws SESSION_TERMINAL', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sto2d-ws-'));
    const stateDir = join(workspace, '.myterminal');
    mkdirSync(stateDir, { recursive: true });
    const store = new MyTerminalStore(stateDir);
    try {
      const { session } = store.registerRoot({ name: 'inherit-cancelled' });
      store.checkpoint(session.id, { phase: 'cancelled', summary: 'abandoned' });
      let threw = false;
      try {
        store.inherit(session.id, { sessionToken: 'any-token' });
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'SESSION_TERMINAL');
      }
      assert.equal(threw, true, 'inherit on cancelled session must throw');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
