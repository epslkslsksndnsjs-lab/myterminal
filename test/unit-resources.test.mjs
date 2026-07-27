import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isNewerVersion, installationRoot, snapshotUpdateData } from '../dist/update.js';
import { disarmSessionResources, disarmAllSessionResources, reapSessionResources, verifyRuntimeResources } from '../dist/session-resources.js';

// ═══════════════════════════════════════════════════════════
// update.ts: isNewerVersion 版本比较
// ═══════════════════════════════════════════════════════════

describe('isNewerVersion', () => {
  test('major bump is newer', () => {
    assert.equal(isNewerVersion('v2.0.0', '1.0.0'), true);
  });

  test('minor bump is newer', () => {
    assert.equal(isNewerVersion('v1.1.0', '1.0.0'), true);
  });

  test('patch bump is newer', () => {
    assert.equal(isNewerVersion('v1.0.2', '1.0.1'), true);
  });

  test('same version is not newer', () => {
    assert.equal(isNewerVersion('v1.0.0', '1.0.0'), false);
  });

  test('older version is not newer', () => {
    assert.equal(isNewerVersion('v0.9.0', '1.0.0'), false);
  });

  test('handles missing parts as zero', () => {
    assert.equal(isNewerVersion('v1.1', '1.0.1'), true);
    assert.equal(isNewerVersion('v1.0', '1.0.0'), false);
  });

  test('handles v prefix on both sides', () => {
    assert.equal(isNewerVersion('v2.0.0', 'v1.9.9'), true);
  });
});

// ═══════════════════════════════════════════════════════════
// update.ts: installationRoot
// ═══════════════════════════════════════════════════════════

describe('installationRoot', () => {
  test('respects MYTERMINAL_HOME env', () => {
    const original = process.env.MYTERMINAL_HOME;
    try {
      process.env.MYTERMINAL_HOME = '/custom/install/path';
      assert.equal(installationRoot(), '/custom/install/path');
    } finally {
      if (original === undefined) delete process.env.MYTERMINAL_HOME;
      else process.env.MYTERMINAL_HOME = original;
    }
  });

  test('returns a string path when no env set', () => {
    const original = process.env.MYTERMINAL_HOME;
    try {
      delete process.env.MYTERMINAL_HOME;
      const result = installationRoot();
      assert.equal(typeof result, 'string');
      assert.ok(result.length > 0);
    } finally {
      if (original !== undefined) process.env.MYTERMINAL_HOME = original;
    }
  });
});

// ═══════════════════════════════════════════════════════════
// update.ts: snapshotUpdateData
// ═══════════════════════════════════════════════════════════

describe('snapshotUpdateData', () => {
  test('creates backup directory and captures files', () => {
    const root = mkdtempSync(join(tmpdir(), 'update-snap-'));
    try {
      writeFileSync(join(root, 'config.json'), '{"test": true}');
      mkdirSync(join(root, 'subdir'));
      writeFileSync(join(root, 'subdir', 'data.txt'), 'hello');
      const snapshot = snapshotUpdateData(root);
      assert.ok(existsSync(snapshot.backupDir));
      assert.ok(snapshot.files.length >= 2);
      assert.ok(snapshot.files.some((f) => f.includes('config.json')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('excludes update-backups from snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'update-excl-'));
    try {
      writeFileSync(join(root, 'config.json'), '{}');
      mkdirSync(join(root, 'update-backups'));
      writeFileSync(join(root, 'update-backups', 'old.json'), 'old');
      const snapshot = snapshotUpdateData(root);
      assert.ok(!snapshot.files.some((f) => f.includes('update-backups')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════
// session-resources.ts: disarm/reap PID 文件管理
// ═══════════════════════════════════════════════════════════

describe('session-resources PID management', () => {
  function fakeConfig() {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'sr-ws-'));
    const stateDir = join(workspaceDir, '.myterminal');
    const settingsPath = join(stateDir, 'config.json');
    mkdirSync(stateDir, { recursive: true });
    return { workspaceDir, stateDir, settingsPath, host: '127.0.0.1', port: 3210, connectorKey: 'a'.repeat(24), actionsToken: 'b'.repeat(24), publicBaseUrl: '', maxOutputChars: 120000, commandTimeoutSec: 60, uiLanguage: 'en', uiTheme: 'dark', passiveLockEnabled: false };
  }

  test('disarmSessionResources removes stale PID file', () => {
    const config = fakeConfig();
    try {
      const resDir = join(config.stateDir, 'session-resources');
      mkdirSync(resDir, { recursive: true });
      writeFileSync(join(resDir, 'ses_test.pid'), '99999999\n');
      const result = disarmSessionResources(config, 'ses_test');
      assert.equal(result.disarmed, false);
      assert.equal(existsSync(join(resDir, 'ses_test.pid')), false);
    } finally {
      rmSync(config.workspaceDir, { recursive: true, force: true });
    }
  });

  test('disarmAllSessionResources cleans all stale PIDs', () => {
    const config = fakeConfig();
    try {
      const resDir = join(config.stateDir, 'session-resources');
      mkdirSync(resDir, { recursive: true });
      writeFileSync(join(resDir, 'ses_a.pid'), '99999991\n');
      writeFileSync(join(resDir, 'ses_b.pid'), '99999992\n');
      writeFileSync(join(resDir, 'not-a-pid.txt'), 'ignore');
      const result = disarmAllSessionResources(config);
      assert.equal(result.disarmed, 0);
      assert.equal(existsSync(join(resDir, 'ses_a.pid')), false);
      assert.equal(existsSync(join(resDir, 'ses_b.pid')), false);
      assert.equal(existsSync(join(resDir, 'not-a-pid.txt')), true);
    } finally {
      rmSync(config.workspaceDir, { recursive: true, force: true });
    }
  });

  test('reapSessionResources removes stale entries silently', () => {
    const config = fakeConfig();
    try {
      const resDir = join(config.stateDir, 'session-resources');
      mkdirSync(resDir, { recursive: true });
      writeFileSync(join(resDir, 'ses_dead.pid'), '99999993\n');
      reapSessionResources(config);
      assert.equal(existsSync(join(resDir, 'ses_dead.pid')), false);
    } finally {
      rmSync(config.workspaceDir, { recursive: true, force: true });
    }
  });

  test('verifyRuntimeResources returns ok on current platform', () => {
    const result = verifyRuntimeResources();
    assert.equal(result.ok, true);
    assert.equal(result.platform, process.platform);
  });
});
