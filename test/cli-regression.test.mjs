import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('dist/cli.js');

function hostileConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-cli-regression-'));
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), '{ invalid json that must never be read');
  fs.writeFileSync(path.join(configDir, 'workspaces.json'), JSON.stringify({
    schemaVersion: 1,
    workspaces: [{
      id: 'locked',
      workspaceDir: path.join(root, 'missing-workspace'),
      stateDir: path.join(configDir, 'workspaces', 'locked'),
      lastPid: process.pid,
      lastSeenAt: new Date().toISOString(),
    }],
  }));
  return { root, configDir };
}

function run(args, configDir) {
  return spawnSync('node', [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MYTERMINAL_CONFIG_DIR: configDir },
    timeout: 15_000,
  });
}

test('stateless CLI commands bypass invalid settings, missing workspace, and active workspace locks', () => {
  const { root, configDir } = hostileConfig();
  try {
    const before = fs.readFileSync(path.join(configDir, 'config.json'), 'utf8');
    const version = run(['--version'], configDir);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), '0.1.2');

    const shortVersion = run(['-v'], configDir);
    assert.equal(shortVersion.status, 0, shortVersion.stderr);
    assert.equal(shortVersion.stdout.trim(), '0.1.2');

    for (const flag of ['--help', '-h']) {
      const help = run([flag], configDir);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /MyTerminal v0\.1\.2/);
      assert.match(help.stdout, /Usage:/);
      assert.doesNotMatch(help.stderr, /Workspace|lock|Invalid MyTerminal settings/);
    }

    const verify = run(['--verify-installation'], configDir);
    assert.equal(verify.status, 0, verify.stderr);
    assert.doesNotMatch(verify.stderr, /Workspace|lock|Invalid MyTerminal settings/);
    assert.doesNotThrow(() => JSON.parse(verify.stdout));

    assert.equal(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(configDir, 'workspaces', 'locked', 'state.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
