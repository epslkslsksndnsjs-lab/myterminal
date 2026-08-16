import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { interpretExitCode } from '../dist/subagent/permissions.js';

// #174：信号与泄漏簇（可单元断言部分：退出码链语义；其余三修由既有整形/契约测试兜底）

test('174-4a: 链末命令语义——grep 成功 mv 失败不再误报「无匹配」', () => {
  const r = interpretExitCode('grep -q M f && mv f f.bak', 1);
  assert.equal(r.isError, true);
  assert.notEqual(r.message, 'No matches found');
});

test('174-4b: 链首 grep 失败仍按 grep 语义解释', () => {
  const r = interpretExitCode('grep -q M f && mv f f.bak', 1);
  // 末命令是 mv（unknown）→ 通用分支；grep 特例只在 grep 为末命令时适用
  assert.match(r.message ?? '', /exited with code 1/);
});

test('174-4c: 单命令 grep 语义不回归', () => {
  const r = interpretExitCode('grep needle haystack', 1);
  assert.equal(r.isError, false);
  assert.equal(r.message, 'No matches found');
});

test('174-4d: cd missing && important 边角按末命令解释', () => {
  const r = interpretExitCode('cd missing && important', 1);
  assert.equal(r.isError, true);
});
