// ADR-0010 skill 工具测试——core-tools.ts 无参=list / 有参=run，inline/fork 双模式
// 覆盖决策：1（fork 引入）、3（无参/有参）、7（API 表面）、8（annotations）、
//          15（objective 前缀）、17（identity 区分）、18（错误码）
// 目标：skill 工具 invoke 路径行覆盖率 100%；变异体 7/7 被杀死
//
// 变异体清单：
//   M1 无参/有参路由反转（无参去 load）      → 用例 01/02 杀
//   M2 fork 不调 actor（不要 identity）      → 用例 04 杀
//   M3 objective 忘加 '执行技能' 前缀        → 用例 06 杀
//   M4 forkOptions 不展开传给 runner         → 用例 07 杀
//   M5 origin 不传给 runner.start            → 用例 08 杀
//   M6 maxParallel 错误码不是 FORBIDDEN      → 用例 09 杀
//   M7 inline 分支忘返回 content             → 用例 02 杀

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { createBuiltinTools } from '../dist/core-tools.js';
import { MyTerminalStore, MyTerminalError } from '../dist/store.js';
import { setRunnerDepsForTesting, resetSubagentRunner } from '../dist/subagent/runner.js';
import { clearAllSubagents } from '../dist/subagent/store.js';

// ── 测试辅助 ──

function tempDir() {
  const dir = join(tmpdir(), 'skill-tool-' + randomBytes(4).toString('hex'));
  mkdirSync(join(dir, 'config', 'skills'), { recursive: true });
  mkdirSync(join(dir, 'workspace', '.myterminal', 'skills'), { recursive: true });
  return dir;
}

function writeSkill(dir, scope, name, markdown) {
  const base = scope === 'global'
    ? join(dir, 'config', 'skills', name)
    : join(dir, 'workspace', '.myterminal', 'skills', name);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'SKILL.md'), markdown, 'utf8');
}

const INLINE_SKILL = `---
name: inline-skill
description: An inline test skill for unit tests.
when_to_use: Use in tests.
---

Follow these inline steps.
`;

const FORK_SKILL = `---
name: fork-skill
description: A fork test skill for unit tests.
when_to_use: Use in tests.
mode: fork
forkOptions:
  provider: deepseek
  maxTurns: 30
  readOnly: true
---

Do the fork work autonomously.
`;

function makeConfig(dir) {
  return {
    settingsPath: join(dir, 'config', 'settings.json'),
    workspaceDir: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'ck_test',
    actionsToken: 'at_test',
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

function mockSession(id) {
  return {
    id,
    name: 'root-test',
    role: 'lead',
    phase: 'working',
    presence: 'claimed',
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// 注意：本文件没有共享 setup 辅助——每个用例完全自建环境，无共享状态。
// 各用例重复出现的四行样板（store/tools/clearAllSubagents/resetSubagentRunner）是有意的：
// 独立 > DRY，和 test/subagent-m8.test.mjs 的风格一致。

// ══════════════════════════════════════════════════════
// 用例 01-03：list / inline / NOT_FOUND
// ══════════════════════════════════════════════════════

test('01: skill() 无参返回名单带 mode，且不需要 identity（决策 3/5/17）', async () => {
  const dir = tempDir();
  writeSkill(dir, 'project', 'inline-skill', INLINE_SKILL);
  writeSkill(dir, 'project', 'fork-skill', FORK_SKILL);
  const store = new MyTerminalStore(join(dir, 'state'));
  const tools = createBuiltinTools(makeConfig(dir), store);

  const result = await tools.get('skill').invoke({}, { transport: 'test' });
  assert.ok(Array.isArray(result.skills));
  const byName = Object.fromEntries(result.skills.map((s) => [s.name, s]));
  assert.equal(byName['inline-skill'].mode, 'inline');
  assert.equal(byName['fork-skill'].mode, 'fork');
  rmSync(dir, { recursive: true, force: true });
});

test('02: skill(name) inline 返回 content（决策 1/3，杀 M1/M7）', async () => {
  const dir = tempDir();
  writeSkill(dir, 'project', 'inline-skill', INLINE_SKILL);
  const store = new MyTerminalStore(join(dir, 'state'));
  const tools = createBuiltinTools(makeConfig(dir), store);

  const result = await tools.get('skill').invoke({ name: 'inline-skill' }, { transport: 'test' });
  assert.equal(result.name, 'inline-skill');
  assert.equal(result.mode, 'inline');
  assert.equal(typeof result.description, 'string');
  assert.match(result.content, /Follow these inline steps/);
  assert.equal(result.taskId, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('03: skill(name) 不存在 → NOT_FOUND（决策 18）', async () => {
  const dir = tempDir();
  const store = new MyTerminalStore(join(dir, 'state'));
  const tools = createBuiltinTools(makeConfig(dir), store);

  await assert.rejects(
    () => tools.get('skill').invoke({ name: 'ghost-skill' }, { transport: 'test' }),
    (err) => err instanceof MyTerminalError && err.code === 'NOT_FOUND',
  );
  rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════
// 用例 04-10：fork 路径
// ══════════════════════════════════════════════════════

test('04: fork 无 identity → IDENTITY_REQUIRED（决策 17，杀 M2）', async () => {
  const dir = tempDir();
  writeSkill(dir, 'project', 'fork-skill', FORK_SKILL);
  const store = new MyTerminalStore(join(dir, 'state'));
  const tools = createBuiltinTools(makeConfig(dir), store);
  clearAllSubagents();
  resetSubagentRunner();

  await assert.rejects(
    () => tools.get('skill').invoke({ name: 'fork-skill' }, { transport: 'test' }),
    (err) => err instanceof MyTerminalError && err.code === 'IDENTITY_REQUIRED',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('05: fork transport=subagent → FORBIDDEN（递归防线 A，与 subagent_start 一致）', async () => {
  const dir = tempDir();
  writeSkill(dir, 'project', 'fork-skill', FORK_SKILL);
  const store = new MyTerminalStore(join(dir, 'state'));
  const tools = createBuiltinTools(makeConfig(dir), store);

  await assert.rejects(
    () => tools.get('skill').invoke({ name: 'fork-skill' }, { transport: 'subagent', authenticatedSession: mockSession('ses_sub') }),
    (err) => err instanceof MyTerminalError && err.code === 'FORBIDDEN' && /sub-subagents/.test(err.message),
  );
  rmSync(dir, { recursive: true, force: true });
});

test('06-08: fork 成功——返回 taskId + objective 前缀 + forkOptions + origin（决策 6/14/15，杀 M3/M4/M5）', async () => {
  const dir = tempDir();
  writeSkill(dir, 'project', 'fork-skill', FORK_SKILL);
  const store = new MyTerminalStore(join(dir, 'state'));
  const tools = createBuiltinTools(makeConfig(dir), store);

  // 捕获 runner.start 的真实参数
  clearAllSubagents();
  resetSubagentRunner();
  const captured = [];
  setRunnerDepsForTesting({
    runSubagentImpl: async () => ({ status: 'completed', result: 'done' }),
    settings: { enabled: true, provider: 'openai', model: 'gpt-4o', maxTurns: 50, timeoutSec: 300, maxParallel: 2 },
    workspaceDir: join(dir, 'workspace'),
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: (parentId, args) => ({
      session: mockSession('ses_child_fork'),
      identity: { sessionId: 'ses_child_fork', sessionToken: 'tok' },
    }),
  });
  const { getSubagentRunner } = await import('../dist/subagent/runner.js');
  const realStart = getSubagentRunner().start.bind(getSubagentRunner());
  getSubagentRunner().start = (parentId, input, origin) => {
    captured.push({ parentId, input, origin });
    return realStart(parentId, input, origin);
  };

  const result = await tools.get('skill').invoke(
    { name: 'fork-skill' },
    { transport: 'test', authenticatedSession: mockSession('ses_root_1') },
  );

  // 返回值格式（决策 5）
  assert.equal(result.name, 'fork-skill');
  assert.equal(result.mode, 'fork');
  assert.ok(result.taskId.startsWith('sa_'));
  assert.equal(result.sessionId, 'ses_child_fork');
  assert.equal(result.status, 'running');

  // runner.start 收到的参数（决策 15/6/14）
  assert.equal(captured.length, 1);
  const { parentId, input, origin } = captured[0];
  assert.equal(parentId, 'ses_root_1');
  assert.match(input.objective, /^执行技能 "fork-skill" 的指令：\n\n/);
  assert.match(input.objective, /Do the fork work autonomously/);
  assert.equal(input.background, 'A fork test skill for unit tests.');
  assert.equal(input.provider, 'deepseek');   // forkOptions 展开（杀 M4）
  assert.equal(input.maxTurns, 30);
  assert.equal(input.readOnly, true);
  assert.deepEqual(origin, { type: 'skill', skillName: 'fork-skill' }); // 杀 M5
  rmSync(dir, { recursive: true, force: true });
});

test('09: fork maxParallel 超限 → FORBIDDEN（决策 18，杀 M6）', async () => {
  const dir = tempDir();
  writeSkill(dir, 'project', 'fork-skill', FORK_SKILL);
  const store = new MyTerminalStore(join(dir, 'state'));
  const tools = createBuiltinTools(makeConfig(dir), store);

  clearAllSubagents();
  resetSubagentRunner();
  // maxParallel = 0 → 任何 start 都超限
  setRunnerDepsForTesting({
    runSubagentImpl: async () => ({ status: 'completed', result: 'done' }),
    settings: { enabled: true, provider: 'openai', model: 'gpt-4o', maxTurns: 50, timeoutSec: 300, maxParallel: 0 },
    workspaceDir: join(dir, 'workspace'),
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: (parentId, args) => ({
      session: mockSession('ses_child_x'),
      identity: { sessionId: 'ses_child_x', sessionToken: 'tok' },
    }),
  });

  await assert.rejects(
    () => tools.get('skill').invoke({ name: 'fork-skill' }, { transport: 'test', authenticatedSession: mockSession('ses_root_2') }),
    (err) => err instanceof MyTerminalError && err.code === 'FORBIDDEN' && /Max parallel/.test(err.message),
  );
  rmSync(dir, { recursive: true, force: true });
});

test('10: fork 其他启动失败 → EXTENSION_ERROR（决策 18）', async () => {
  const dir = tempDir();
  writeSkill(dir, 'project', 'fork-skill', FORK_SKILL);
  const store = new MyTerminalStore(join(dir, 'state'));
  const tools = createBuiltinTools(makeConfig(dir), store);

  clearAllSubagents();
  resetSubagentRunner();
  setRunnerDepsForTesting({
    runSubagentImpl: async () => ({ status: 'completed', result: 'done' }),
    settings: { enabled: true, provider: 'openai', model: 'gpt-4o', maxTurns: 50, timeoutSec: 300, maxParallel: 2 },
    workspaceDir: join(dir, 'workspace'),
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: () => { throw new Error('delegate session store unavailable'); },
  });

  await assert.rejects(
    () => tools.get('skill').invoke({ name: 'fork-skill' }, { transport: 'test', authenticatedSession: mockSession('ses_root_3') }),
    (err) => err instanceof MyTerminalError && err.code === 'EXTENSION_ERROR',
  );
  rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════
// 用例 11-13：API 表面（决策 7/8）
// ══════════════════════════════════════════════════════

test('11: skill_list / skill_load 已删除（决策 7）', () => {
  const dir = tempDir();
  const store = new MyTerminalStore(join(dir, 'state'));
  const tools = createBuiltinTools(makeConfig(dir), store);
  assert.equal(tools.get('skill_list'), undefined);
  assert.equal(tools.get('skill_load'), undefined);
  assert.ok(tools.get('skill'));
  rmSync(dir, { recursive: true, force: true });
});

test('12: skill 工具 annotations 非 readOnly（决策 8）', () => {
  const dir = tempDir();
  const store = new MyTerminalStore(join(dir, 'state'));
  const tools = createBuiltinTools(makeConfig(dir), store);
  const ann = tools.get('skill').annotations;
  assert.equal(ann.readOnlyHint, false);
  assert.equal(ann.destructiveHint, false);
  assert.equal(ann.openWorldHint, false);
  assert.equal(ann.idempotentHint, false);
  rmSync(dir, { recursive: true, force: true });
});

test('13: skill 工具 inputSchema——name 可选、无额外字段', () => {
  const dir = tempDir();
  const store = new MyTerminalStore(join(dir, 'state'));
  const tools = createBuiltinTools(makeConfig(dir), store);
  const schema = tools.get('skill').inputSchema;
  assert.equal(schema.type, 'object');
  assert.ok(schema.properties.name);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.required, undefined); // name 可选——无参 = list
  rmSync(dir, { recursive: true, force: true });
});
