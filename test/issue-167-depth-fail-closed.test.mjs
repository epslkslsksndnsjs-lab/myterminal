import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { checkCommandSafety } from '../dist/subagent/permissions.js';

// #167（P1）：深度耗尽 fail-open → fail-closed。
// 4 层解释器壳 + 引号遮蔽的组合拳曾让 rm -rf 在内层逃过三层防线。
// 构造方式：逐层用 JSON.stringify 包引号，避免测试文件内手写嵌套引号。

function nestShell(depth, inner) {
  let cmd = inner;
  for (let i = 0; i < depth; i++) {
    cmd = `${i % 2 === 0 ? 'bash' : 'sh'} -c ${JSON.stringify(cmd)}`;
  }
  return cmd;
}

test('AC1：4 层解释器壳内藏 rm -rf 一律 deny（fail-closed）', () => {
  const cmd = nestShell(4, 'rm -rf ~');
  assert.equal(checkCommandSafety(cmd, false), 'deny');
  assert.equal(checkCommandSafety(cmd, true), 'deny');
});

test('AC1b：5 层壳内藏 mkfs 危险命令也 deny', () => {
  const cmd = nestShell(5, 'mkfs /dev/disk1');
  assert.equal(checkCommandSafety(cmd, false), 'deny');
});

test('AC2：2 层壳内安全命令不受影响（误杀成本约 0 的边界）', () => {
  const cmd = nestShell(2, 'echo hello');
  assert.equal(checkCommandSafety(cmd, false), 'allow');
});

test('AC3：3 层壳内危险命令仍被正常防线拦截（deny）', () => {
  const cmd = nestShell(3, 'rm -rf ~');
  assert.equal(checkCommandSafety(cmd, false), 'deny');
});

test('AC4：普通安全命令与单层壳行为不变', () => {
  assert.equal(checkCommandSafety('ls -la', false), 'allow');
  assert.equal(checkCommandSafety('bash -c "echo hi"', false), 'allow');
});
