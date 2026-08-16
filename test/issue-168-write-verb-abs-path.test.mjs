import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { checkCommandSafety } from '../dist/subagent/permissions.js';

// #168（P2）：execute_cli 工作区边界的执行层守卫——写类动词+绝对路径 deny、读类放行。

test('AC1：rm 单文件绝对路径 deny（此前放行的漏洞面）', () => {
  assert.equal(checkCommandSafety('rm ~/important', false), 'deny');
  assert.equal(checkCommandSafety('rm /etc/hosts', false), 'deny');
});

test('AC1b：mv/dd/tee/chmod 绝对路径 deny', () => {
  assert.equal(checkCommandSafety('mv /tmp/a /etc/b', false), 'deny');
  assert.equal(checkCommandSafety('dd if=/dev/zero of=/tmp/out', false), 'deny');
  assert.equal(checkCommandSafety('tee /tmp/log', false), 'deny');
  assert.equal(checkCommandSafety('chmod 755 /tmp/x', false), 'deny');
});

test('AC1c：管道内的写类绝对路径同样 deny（逐段检查）', () => {
  assert.equal(checkCommandSafety('echo x | tee /tmp/f', false), 'deny');
});

test('AC2：读类绝对路径放行（子 agent 需要读全局配置）', () => {
  assert.equal(checkCommandSafety('cat /etc/passwd', false), 'allow');
  assert.equal(checkCommandSafety('head -5 /etc/hosts', false), 'allow');
});

test('AC3：相对路径写类行为不变', () => {
  assert.equal(checkCommandSafety('rm old-file.txt', false), 'allow');
  assert.equal(checkCommandSafety('mv a b', false), 'allow');
  assert.equal(checkCommandSafety('tee log', false), 'allow');
  assert.equal(checkCommandSafety('chmod +x script.sh', false), 'allow');
});

test('AC4：既有语义保留——touch 绝对路径仍放行（m3 锁定）', () => {
  assert.equal(checkCommandSafety('cat foo\ntouch /tmp/ok', false), 'allow');
});

test('AC5：readOnly 模式一致性（写类一律 deny）', () => {
  assert.equal(checkCommandSafety('rm ~/x', true), 'deny');
  assert.equal(checkCommandSafety('cat /etc/passwd', true), 'allow');
});
