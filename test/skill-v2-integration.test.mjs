// ADR-0010 集成测试——discover 注入 mode / MCP 提示语 / e2e 全链路
// 覆盖决策：5（discover skills 带 mode）、7（API 表面：tools 含 skill 不含旧工具；MCP 提示语）、12（文档一致性）
// 目标：集成路径全覆盖；变异体 4/4 被杀死
//
// 变异体清单：
//   M1 discover 的 skills 丢 mode 字段          → 用例 01/02 杀
//   M2 tools 目录仍含 skill_list/skill_load     → 用例 03 杀
//   M3 mcp.ts 提示语仍指向旧工具名              → 用例 04 杀
//   M4 fork e2e 链路某环断裂（start→status）    → 用例 05 杀

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { createBuiltinTools } from '../dist/core-tools.js';
import { ExtensionService } from '../dist/extensions.js';
import { MyTerminalStore } from '../dist/store.js';
import { setRunnerDepsForTesting, resetSubagentRunner } from '../dist/subagent/runner.js';
import { clearAllSubagents } from '../dist/subagent/store.js';

// ── 测试辅助 ──

function tempDir() {
  const dir = join(tmpdir(), 'skill-e2e-' + randomBytes(4).toString('hex'));
  mkdirSync(join(dir, 'config', 'skills'), { recursive: true });
  mkdirSync(join(dir, 'workspace', '.myterminal', 'skills'), { recursive: true });
  return dir;
}

function makeConfig(dir) {
  return {
    settingsPath: join(dir, 'config', 'settings.json'),
    workspaceDir: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'ck_test_' + randomBytes(4).toString('hex'),
    actionsToken: 'at_test_' + randomBytes(4).toString('hex'),
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 10000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };
}

function writeSkill(dir, name, markdown) {
  const base = join(dir, 'workspace', '.myterminal', 'skills', name);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'SKILL.md'), markdown, 'utf8');
}

const INLINE_SKILL = `---
name: e2e-inline
description: Inline skill for integration tests.
when_to_use: Use in integration tests.
---

Inline instructions body.
`;

const FORK_SKILL = `---
name: e2e-fork
description: Fork skill for integration tests.
when_to_use: Use in integration tests.
mode: fork
---

Fork work body.
`;

function setupExt(dir) {
  const store = new MyTerminalStore(join(dir, 'state'));
  const config = makeConfig(dir);
  const builtins = createBuiltinTools(config, store);
  const ext = new ExtensionService(config, store, builtins, () => {});
  const rootResult = store.registerRoot({ name: 'root', role: 'lead' });
  return { store, config, ext, rootIdentity: rootResult.identity };
}

function setupFakeRunner(dir) {
  clearAllSubagents();
  resetSubagentRunner();
  setRunnerDepsForTesting({
    runSubagentImpl: async () => ({ status: 'completed', result: 'fork e2e result body' }),
    settings: { enabled: true, provider: 'openai', model: 'gpt-4o', maxTurns: 50, timeoutSec: 300, maxParallel: 2 },
    workspaceDir: join(dir, 'workspace'),
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: (parentId, args) => {
      const sid = 'ses_child_' + randomBytes(3).toString('hex');
      return {
        session: { id: sid, name: args.name, role: 'worker', phase: 'working', presence: 'claimed', parentSessionId: parentId, task: args.task, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        identity: { sessionId: sid, sessionToken: 'tok_' + randomBytes(4).toString('hex') },
      };
    },
  });
}

// ══════════════════════════════════════════════════════
// 用例 01-03：discover 集成（决策 5/7）
// ══════════════════════════════════════════════════════

test('01: 未认证 discover 的 skills 带 mode（决策 5，杀 M1）', async () => {
  const dir = tempDir();
  writeSkill(dir, 'e2e-inline', INLINE_SKILL);
  writeSkill(dir, 'e2e-fork', FORK_SKILL);
  const { ext } = setupExt(dir);

  const res = await ext.discover({}, { transport: 'test' });
  assert.equal(res.ok, true);
  const byName = Object.fromEntries(res.data.skills.map((s) => [s.name, s]));
  assert.equal(byName['e2e-inline'].mode, 'inline');
  assert.equal(byName['e2e-fork'].mode, 'fork');
  rmSync(dir, { recursive: true, force: true });
});

test('02: 认证 discover 的 skills 带 mode（决策 5）', async () => {
  const dir = tempDir();
  writeSkill(dir, 'e2e-inline', INLINE_SKILL);
  const { ext, rootIdentity } = setupExt(dir);

  const res = await ext.discover({ identity: rootIdentity }, { transport: 'test' });
  assert.equal(res.ok, true);
  const skill = res.data.skills.find((s) => s.name === 'e2e-inline');
  assert.ok(skill);
  assert.equal(skill.mode, 'inline');
  rmSync(dir, { recursive: true, force: true });
});

test('03: 认证 discover 的 tools 含 skill、不含 skill_list/skill_load（决策 7，杀 M2）', async () => {
  const dir = tempDir();
  const { ext, rootIdentity } = setupExt(dir);

  const res = await ext.discover({ identity: rootIdentity }, { transport: 'test' });
  assert.equal(res.ok, true);
  const names = res.data.tools.map((t) => t.name);
  assert.ok(names.includes('skill'), 'tools must include skill');
  assert.ok(!names.includes('skill_list'), 'skill_list must be gone');
  assert.ok(!names.includes('skill_load'), 'skill_load must be gone');
  rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════
// 用例 04：MCP 提示语（决策 7，杀 M3）
// ══════════════════════════════════════════════════════

test('04: mcp.ts 提示语指向新 skill 工具（决策 7 原文）', () => {
  // docs.test.mjs 同款模式：直接读源码文件验证用户面向文案
  const src = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('Use skill() to list available skills, skill(name) to run one.'), 'MCP instructions must point to the new skill tool');
  assert.ok(!src.includes('skill_load(name)'), 'old skill_load reference must be gone');
});

// ══════════════════════════════════════════════════════
// 用例 05：e2e 全链路——skill() list → skill(inline) → skill(fork) → status 多次查（杀 M4）
// ══════════════════════════════════════════════════════

test('05: e2e——list/inline/fork/status-idempotent 全链路', async () => {
  const dir = tempDir();
  writeSkill(dir, 'e2e-inline', INLINE_SKILL);
  writeSkill(dir, 'e2e-fork', FORK_SKILL);
  const { ext, rootIdentity } = setupExt(dir);
  setupFakeRunner(dir);

  // Step 1: skill() 无参 → 名单
  const listRes = await ext.call(
    { tool: 'skill', input: {}, identity: rootIdentity },
    { transport: 'actions' },
  );
  assert.equal(listRes.ok, true);
  const skills = listRes.data.result.skills;
  assert.equal(skills.length, 3); // 2 user skills + 1 built-in (adaptive-guard)

  // Step 2: skill(inline) → content
  const inlineRes = await ext.call(
    { tool: 'skill', input: { name: 'e2e-inline' }, identity: rootIdentity },
    { transport: 'actions' },
  );
  assert.equal(inlineRes.ok, true);
  assert.equal(inlineRes.data.result.mode, 'inline');
  assert.match(inlineRes.data.result.content, /Inline instructions body/);

  // Step 3: skill(fork) → taskId
  const forkRes = await ext.call(
    { tool: 'skill', input: { name: 'e2e-fork' }, identity: rootIdentity },
    { transport: 'actions' },
  );
  assert.equal(forkRes.ok, true);
  assert.equal(forkRes.data.result.mode, 'fork');
  assert.equal(forkRes.data.result.status, 'running');
  const taskId = forkRes.data.result.taskId;
  assert.ok(taskId.startsWith('sa_'));

  // Step 4: 等 subagent 完成 → subagent_status 查 result
  // 有界轮询替代固定 300ms（Windows runner 启动延迟，#176 CI 实测 300ms 不够）
  let status1;
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    status1 = await ext.call(
      { tool: 'subagent_status', input: { taskId }, identity: rootIdentity },
      { transport: 'actions' },
    );
    if (status1.ok && status1.data.result.status === 'completed') break;
  }
  assert.equal(status1.ok, true);
  assert.equal(status1.data.result.status, 'completed');
  assert.equal(status1.data.result.result, 'fork e2e result body');

  // Step 5: 决策 13——第二次查仍返回 result（idempotent）
  const status2 = await ext.call(
    { tool: 'subagent_status', input: { taskId }, identity: rootIdentity },
    { transport: 'actions' },
  );
  assert.equal(status2.ok, true);
  assert.equal(status2.data.result.result, 'fork e2e result body');

  rmSync(dir, { recursive: true, force: true });
});
