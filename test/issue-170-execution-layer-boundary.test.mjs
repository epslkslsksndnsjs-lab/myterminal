import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { checkWriteTargetsInsideCwd } from '../dist/subagent/permissions.js';

// #170（P2 回炉）：执行层工作区边界——写目标解析判包含。
// 测试口径：checkWriteTargetsInsideCwd(cmd, '/workspace')。

test('AC1：绝对路径越界写 deny', () => {
  assert.equal(checkWriteTargetsInsideCwd('rm ~/important', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('rm /etc/hosts', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('mv /tmp/a /etc/b', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('tee /tmp/log', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('chmod 755 /tmp/x', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('dd if=/dev/zero of=/tmp/out', '/workspace'), 'deny');
});

test('AC1b：前缀伪装与重定向绕过 deny', () => {
  assert.equal(checkWriteTargetsInsideCwd('VAR=1 rm /etc/hosts', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('echo hi > /etc/passwd', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('cp /dev/null /etc/hosts', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('ln -s /etc/passwd /tmp/link', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('mkdir -p /tmp/x', '/workspace'), 'deny');
});

test('AC2：误杀回归——含斜杠相对路径 allow（前版缺陷修复）', () => {
  assert.equal(checkWriteTargetsInsideCwd('rm src/old.ts', '/workspace'), 'allow');
  assert.equal(checkWriteTargetsInsideCwd('mv src/a.ts src/b.ts', '/workspace'), 'allow');
  assert.equal(checkWriteTargetsInsideCwd('tee build/log.txt', '/workspace'), 'allow');
  assert.equal(checkWriteTargetsInsideCwd('chmod +x scripts/run.sh', '/workspace'), 'allow');
  assert.equal(checkWriteTargetsInsideCwd('dd if=/dev/zero of=out.bin', '/workspace'), 'allow');
  assert.equal(checkWriteTargetsInsideCwd('mv a.txt a.txt~', '/workspace'), 'allow');
});

test('AC3：../ 逃逸 deny、区内裸名 allow', () => {
  assert.equal(checkWriteTargetsInsideCwd('rm ../outside-file', '/workspace'), 'deny');
  assert.equal(checkWriteTargetsInsideCwd('rm old-file.txt', '/workspace'), 'allow');
  assert.equal(checkWriteTargetsInsideCwd('mv a b', '/workspace'), 'allow');
});

test('AC4：读类不判（cat 绝对路径 allow）', () => {
  assert.equal(checkWriteTargetsInsideCwd('cat /etc/passwd', '/workspace'), 'allow');
  assert.equal(checkWriteTargetsInsideCwd('head -5 /etc/hosts', '/workspace'), 'allow');
});

test('AC5：touch 排除锁定（m3 语义：touch /tmp/ok 放行）', () => {
  assert.equal(checkWriteTargetsInsideCwd('touch /tmp/ok', '/workspace'), 'allow');
});

test('AC6：$ 变量目标不判（已知限制认账）', () => {
  assert.equal(checkWriteTargetsInsideCwd('rm $P', '/workspace'), 'allow');
});
