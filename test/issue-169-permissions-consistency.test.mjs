import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { splitCommands, checkCommandSafety } from '../dist/subagent/permissions.js';

// #169（P3）：权限解析三处一致性。

test('P3-1a：引号外反斜杠转义的分号不拆段', () => {
  const result = splitCommands('echo \\; rm -rf /');
  assert.deepEqual(result, ['echo \\; rm -rf /']);
});

test('P3-1b：引号外反斜杠转义的管道不拆段', () => {
  const result = splitCommands('echo \\| x');
  assert.deepEqual(result, ['echo \\| x']);
});

test('P3-1c：未转义分隔符照常拆分（行为不回归）', () => {
  const result = splitCommands('echo a; rm b');
  assert.deepEqual(result, ['echo a', 'rm b']);
});

test('P3-2：npm run 形状放行的现状锁定（注释已认账=形状非语义）', () => {
  assert.equal(checkCommandSafety('npm run any-script', false), 'allow');
});

test('P3-3：interpretExitCode 首命令语义现状锁定', async () => {
  const { interpretExitCode } = await import('../dist/subagent/permissions.js');
  const r = interpretExitCode('cd missing && important', 1);
  // cd 是 unknown 首命令 → 通用分支 exit != 0 → isError true（如实上报，非语义解释）
  assert.equal(r.isError, true);
});
