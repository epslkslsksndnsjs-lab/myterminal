// ADR-0048 A48-W1 M3 (#147)：builtin-target 扩展裸包噪声键泄漏（A2 F3 残留面）
//
// 验收断言：
//   AC1  内层按 target 名套 TOOL_SHAPES L1 reduce（denoise 起步）——5 噪声键
//        （command/cwd/signal/timedOut/cancelled）剥除，答案字段（stdout/stderr/
//        exitCode/truncated/durationMs）逐字保全（与 #108 R5 command-kind 同政策）
//   AC2  git_log 派生（commits/commitCount/count）不绕过；截断态不派生（D16.2 绝不伪造）
//   AC3  未注册 target → denoise 兜底；答案字段保全
//   AC4  注册的非命令 target（read_file）套其自身 reducer（lineCount 派生）
//   AC5  运行时：builtin-target 扩展（execute_cli）响应内层无噪声键，wrapper {target,result} 保全
//   AC6  运行时：builtin-target 扩展（git_log）commits/commitCount 派生可达模型上下文
//   AC7  运行时：内层 exitCode≠0 → NON_ZERO_EXIT 判定不回归（fail-fast 保全）
//
// 测试方式：单测直接驱动 reduceBuiltinTargetResult（../dist/tool-parse.js，遵循 issue-108
// seam）；运行时探测走 MyTerminalRuntime actions 通道（myterminal.test.mjs 手法）。
// 注：任何 src 改动后必须先 bun run build 再跑测试（测试全部从 dist 导入，历史教训见 #43）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { reduceBuiltinTargetResult } from '../dist/tool-parse.js';
import { resetL3AdapterInstance } from '../dist/l3/registry.js';
import { clearL3Quota } from '../dist/l3/engine.js';
import { MyTerminalRuntime } from '../dist/server.js';

const COMMAND_RESULT_NOISE = ['command', 'cwd', 'signal', 'timedOut', 'cancelled'];

function rawCommand(overrides = {}) {
  return {
    command: 'git log --oneline -n 30', cwd: '/tmp/ws', exitCode: 0, signal: null,
    timedOut: false, stdout: 'abc123 first commit\ndef456 second commit\n', stderr: '',
    truncated: false, durationMs: 4, cancelled: false, ...overrides,
  };
}

// ── 运行时帮手（myterminal.test.mjs 手法）─────────────────────────────────────

const ACTIONS_TOKEN = 'test-actions-token-12345678901234567890';
const CONNECTOR_KEY = 'test-connector-key-1234567890';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'hello myterminal\n');
  return { workspaceDir, stateDir };
}

async function createRuntime(overrides = {}) {
  const dirs = tempWorkspace();
  const runtime = new MyTerminalRuntime({ ...dirs, settingsPath: path.join(dirs.stateDir, 'test-settings.json'), host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: 'http://127.0.0.1:0', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false, actionsContinuationMode: 'next-call', ...overrides });
  await runtime.start();
  return { runtime, dirs, baseUrl: `http://127.0.0.1:${runtime.port}`, async close() { await runtime.close(); fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); } };
}

function actionsHeaders() { return { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' }; }
async function action(server, endpoint, body) {
  const response = await fetch(`${server.baseUrl}/actions/extensions/${endpoint}`, { method: 'POST', headers: actionsHeaders(), body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function call(server, tool, input = {}, identity) { return action(server, 'call', { tool, input, ...(identity ? { identity } : {}) }); }
async function root(server, name = 'main') {
  const response = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(response.body.ok, true, JSON.stringify(response.body));
  return response.body.data.result;
}

function builtinSpec(name, target, defaults = {}, description = 'Wrap a builtin through a builtin-target extension.') {
  return {
    name, title: `${name} title`, description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    handler: { kind: 'builtin', target, defaults },
  };
}

async function registerSpec(server, identity, spec) {
  for (const actionName of ['validate', 'upsert']) {
    const response = await action(server, 'register', { action: actionName, spec, identity });
    assert.equal(response.body.ok, true, JSON.stringify(response.body));
  }
}

afterEach(() => {
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）
  clearL3Quota();
});

// ── AC1：execute_cli 内层剥 5 噪声键，答案字段逐字保全 ─────────────────────────

test('147-AC1: execute_cli 内层剥 5 噪声键，答案字段逐字保全', () => {
  const raw = rawCommand({ command: 'echo hi', stdout: 'hi\n' });
  const out = reduceBuiltinTargetResult('execute_cli', raw);
  assert.deepEqual(out, { exitCode: 0, stdout: 'hi\n', stderr: '', truncated: false, durationMs: 4 });
  for (const key of COMMAND_RESULT_NOISE) {
    assert.equal(key in out, false, `噪声键 ${key} 应剥除`);
  }
  assert.equal(raw.command, 'echo hi', '原始 raw 不被就地修改（拷贝输出）');
});

// ── AC2：git_log 派生 commits/commitCount/count；截断态不派生 ──────────────────

test('147-AC2: git_log 派生 commits+commitCount+count；截断态不派生', () => {
  const out = reduceBuiltinTargetResult('git_log', rawCommand());
  assert.deepEqual(out.commits, [
    { hash: 'abc123', subject: 'first commit' },
    { hash: 'def456', subject: 'second commit' },
  ]);
  assert.equal(out.commitCount, 2, 'D16.3 commitCount === commits 行数');
  assert.equal(out.count, 2, 'D16.1 count 与 commitCount 并存');
  assert.equal(out.stdout, 'abc123 first commit\ndef456 second commit\n', 'stdout 保全（派生后置，不删原字段）');
  for (const key of COMMAND_RESULT_NOISE) {
    assert.equal(key in out, false, `噪声键 ${key} 应剥除`);
  }
  const truncated = reduceBuiltinTargetResult('git_log', rawCommand({ truncated: true, stdout: 'abc123 first\n' }));
  assert.equal('commits' in truncated, false, '截断态不派生（D16.2 绝不伪造）');
  assert.equal('commitCount' in truncated, false, '截断态无 commitCount');
  assert.equal('count' in truncated, false, '无派生数组无 count');
});

// ── AC3：未注册 target → denoise 兜底 ─────────────────────────────────────────

test('147-AC3: 未注册 target → denoise 兜底，答案字段保全', () => {
  const out = reduceBuiltinTargetResult('unknown_tool_147', rawCommand());
  assert.deepEqual(out, { exitCode: 0, stdout: 'abc123 first commit\ndef456 second commit\n', stderr: '', truncated: false, durationMs: 4 });
});

// ── AC4：注册的非命令 target（read_file）套其自身 reducer ─────────────────────

test('147-AC4: read_file 内层套自身 reducer（lineCount 派生）', () => {
  const out = reduceBuiltinTargetResult('read_file', { path: 'a.txt', content: 'l1\nl2\nl3', sha256: 'x', bytes: 9, truncated: false });
  assert.equal(out.lineCount, 3, 'lineCount 派生');
  assert.equal(out.content, 'l1\nl2\nl3', '内容保全');
  assert.equal(out.sha256, 'x', '其余字段保全');
});

// ── AC5：运行时 builtin-target（execute_cli）响应内层剥噪声键 ──────────────────

// #176 CI 修复：本文件用例依赖 POSIX shell 语义（bash 链 / & 后台 / exec / sleep / seq 与引号规则），
// Windows cmd.exe 无对应语义——win32 仅 AC5 跳过；实现侧 win32 降级路径由既有适配用例覆盖。
const skipOnWin = process.platform === 'win32';
test.skipIf(skipOnWin)('147-AC5: builtin-target 扩展（execute_cli）响应内层无噪声键，wrapper 保全', async () => {
  const server = await createRuntime();
  try {
    const main = await root(server);
    await registerSpec(server, main.identity, builtinSpec('echo_builtin_147', 'execute_cli', { command: 'echo builtin-target-ok' }));
    const custom = await call(server, 'echo_builtin_147', {}, main.identity);
    assert.equal(custom.body.ok, true, JSON.stringify(custom.body));
    assert.equal(custom.body.data.result.target, 'execute_cli', 'wrapper target 保全');
    const inner = custom.body.data.result.result;
    assert.equal(inner.stdout, 'builtin-target-ok\n', '内层 stdout 逐字保全');
    for (const key of COMMAND_RESULT_NOISE) {
      assert.equal(key in inner, false, `内层噪声键 ${key} 应剥除（M3）`);
    }
    assert.equal(typeof inner.exitCode, 'number', 'exitCode 保全');
    assert.equal('stderr' in inner, true, 'stderr 保全');
    assert.equal('truncated' in inner, true, 'truncated 保全');
    assert.equal('durationMs' in inner, true, 'durationMs 保全');
  } finally { await server.close(); }
});

// ── AC6：运行时 builtin-target（git_log）派生可达模型上下文 ───────────────────

test('147-AC6: builtin-target 扩展（git_log）commits/commitCount 派生不绕过', async () => {
  const server = await createRuntime();
  try {
    const main = await root(server);
    const ws = server.dirs.workspaceDir;
    execSync('git init -q', { cwd: ws, stdio: 'pipe' });
    execSync('git config user.email test@example.com && git config user.name test', { cwd: ws, stdio: 'pipe' });
    execSync('git add hello.txt && git commit -qm c1', { cwd: ws, stdio: 'pipe' });
    fs.writeFileSync(path.join(ws, 'second.txt'), 'second\n');
    execSync('git add second.txt && git commit -qm c2', { cwd: ws, stdio: 'pipe' });
    await registerSpec(server, main.identity, builtinSpec('gitlog_builtin_147', 'git_log'));
    const custom = await call(server, 'gitlog_builtin_147', {}, main.identity);
    assert.equal(custom.body.ok, true, JSON.stringify(custom.body));
    const inner = custom.body.data.result.result;
    assert.equal(inner.commits.length, 2, 'commits 派生（--oneline 逐行）');
    assert.equal(inner.commitCount, 2, 'commitCount 派生不绕过');
    assert.equal(inner.count, 2, 'D16.1 count 并存');
    assert.ok(inner.commits.every((c) => typeof c.hash === 'string' && typeof c.subject === 'string'), 'commits 条目形如 {hash, subject}');
    for (const key of COMMAND_RESULT_NOISE) {
      assert.equal(key in inner, false, `内层噪声键 ${key} 应剥除`);
    }
  } finally { await server.close(); }
});

// ── AC7：内层 exitCode≠0 → NON_ZERO_EXIT 判定不回归（fail-fast 保全）───────────

test('147-AC7: 内层 exitCode≠0 → NON_ZERO_EXIT 判定不回归', async () => {
  const server = await createRuntime();
  try {
    const main = await root(server);
    await registerSpec(server, main.identity, builtinSpec('fail_builtin_147', 'execute_cli', { command: 'exit 3' }));
    const custom = await call(server, 'fail_builtin_147', {}, main.identity);
    assert.equal(custom.body.ok, false, JSON.stringify(custom.body));
    assert.equal(custom.body.error.code, 'NON_ZERO_EXIT', 'exitCode 判定不受源处整形影响');
  } finally { await server.close(); }
});
