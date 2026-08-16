import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkWriteTargetsInsideCwd } from '../dist/subagent/permissions.js';

// #172：执行层守卫补漏四条（粘连 token / symlink / in-place 动词 / workingDir）

test('AC1：无空格重定向粘连 deny', () => {
  assert.equal(checkWriteTargetsInsideCwd('echo hi >/etc/passwd', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('cat x 2>/tmp/log', '/workspace'), 'deny');
});

test('AC1b：独立形态重定向不回归（echo hi > /etc/passwd 仍 deny）', () => {
  assert.equal(checkWriteTargetsInsideCwd('echo hi > /etc/passwd', '/workspace'), 'deny');
});

test('AC2：symlink 逃逸 deny（真实种链后判包含）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-172-'));
  const evil = path.join(root, 'evil');
  fs.symlinkSync('/etc', evil);
  try {
    assert.equal(checkWriteTargetsInsideCwd('rm evil/passwd', root), 'deny');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC3：in-place 动词绝对路径 deny；读形态放行', () => {
  assert.equal(checkWriteTargetsInsideCwd('sed -i s/x/y/ /etc/hosts', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('awk -i inplace /tmp/x', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('install /tmp/a /etc/b', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('truncate -s 0 /tmp/x', '/workspace'), 'deny');
  // 读形态不受影响
  assert.equal(checkWriteTargetsInsideCwd('sed -n p /etc/hosts', '/workspace'), 'allow');
});

test('AC4：子目录合法 ../ 写 allow（workingDir 口径）', () => {
  assert.equal(checkWriteTargetsInsideCwd('rm ../x', '/workspace/sub'), 'allow');
});

test('AC5：既有 #170 语义不回归（抽查）', () => {
  assert.equal(checkWriteTargetsInsideCwd('rm src/old.ts', '/workspace'), 'allow');
  assert.equal(checkWriteTargetsInsideCwd('rm /etc/hosts', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('VAR=1 rm /etc/hosts', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('touch /tmp/ok', '/workspace'), 'allow');
  assert.equal(checkWriteTargetsInsideCwd('cat /etc/passwd', '/workspace'), 'allow');
});
