# 任务 3：core-tools.ts — 删 skill_list/skill_load，新建 skill 工具（决策 1/3/7/8/15/17/18）

> 你是执行本任务的开发模型。**严格按步骤来，每步做完验证再继续。禁止跳步、禁止猜测。**
> 前置：任务 1、2 已完成并提交（`git log --oneline -2` 应看到 runner 与 skills 两个 commit）。如果没有，停止并报告。

## 第 0 步：分支检查（必须先做，失败立即停止）

```bash
cd 
git branch --show-current
```

- 输出必须**正好是** `feat/skills`。否则 🛑 停止并报告，绝对禁止继续。

## 第 1 步：先理解（必读清单）

1. `docs/adr/0010-skill-invoke-tool-v2.md` 决策 1（fork 重新引入）、3（无参/有参区分）、7（API 表面）、8（annotations 非 readOnly）、15（fork task 加前缀）、17（权限：list/inline 不要 identity，fork 要）、18（错误码表）
2. `src/core-tools.ts` 第 536-660 行——现有 skill_list/skill_load（要删）+ subagent 三工具（风格参照）
3. `src/skills.ts` 的 `SkillManifest`/`SkillForkOptions`/`listSkills`/`loadSkill`（任务 1 已改好，fork 路径依赖它们）
4. `src/subagent/runner.ts` 的 `SubagentStartInput`/`SubagentOrigin`/`start()` 签名（任务 2 已改好）
5. `src/types.ts` 第 225-231 行 `InvocationContext` 类型

**理解自查**（答不上就重读）：
- `skill()` 无参和 `skill(name="x")` 怎么区分？（答：`input.name` 是否为非空字符串——用现有的 `asOptionalString` helper）
- fork 的 objective 格式？（答：决策 15——`` `执行技能 "${skillName}" 的指令：\n\n${skillContent}` ``）
- fork 错误码表？（答：NOT_FOUND=skill 不存在；FORBIDDEN=maxParallel 超限；EXTENSION_ERROR=其他启动失败；IDENTITY_REQUIRED=fork 无 identity，由 `actor()` 抛出）
- 为什么 fork 路径要检查 `context.transport === 'subagent'`？（答：递归防护防线 A，与 `subagent_start`（core-tools.ts:584-586）完全一致——即使 subagent 工具集不含 skill，纵深防御）

## 第 2 步：改 src/core-tools.ts

### 2.1 删除 skill_list + skill_load，原位新建 skill 工具

位置：第 536-555 行（两个 `add({...})` 块，`skill_list` 和 `skill_load`）。**整体删除这两个块**，在原位置插入下面这一个工具（**逐字使用**）：

```typescript
  add({
    name: 'skill', title: 'Run skill',
    description: 'List installed skills when called without arguments, or run one by name. Inline skills return their instructions; fork skills start a subagent and return a taskId to poll with subagent_status.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, additionalProperties: false },
    // ADR-0010 决策 8：fork 会启动 subagent（有副作用），整体标非 readOnly
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    invoke: async (input, context) => {
      const configDir = path.dirname(config.settingsPath);
      const name = asOptionalString(input.name);
      // 决策 3：无参 = list
      if (!name) {
        return { skills: listSkills(configDir, config.workspaceDir) } as unknown as JsonObject;
      }
      const record = loadSkill(configDir, config.workspaceDir, name);
      if (!record) throw new MyTerminalError('NOT_FOUND', `Skill not found: ${name}`);
      // 决策 1/3：inline 直接返回内容（决策 17：不要求 identity）
      if (record.mode !== 'fork') {
        return { name: record.name, description: record.description, mode: 'inline', content: record.content };
      }
      // fork 模式——决策 17：要求 identity；防线 A 与 subagent_start 一致（递归防护）
      if (context.transport === 'subagent') {
        throw new MyTerminalError('FORBIDDEN', 'Subagents cannot start sub-subagents.');
      }
      const session = actor(context);
      const runner = getSubagentRunner();
      try {
        // 决策 15：objective 加 skill 前缀；决策 6：forkOptions 覆盖默认配置；决策 14：origin 传入
        const started = runner.start(session.id, {
          objective: `执行技能 "${name}" 的指令：\n\n${record.content}`,
          background: record.description,
          ...record.forkOptions,
        }, { type: 'skill', skillName: name });
        return { name: record.name, description: record.description, mode: 'fork', taskId: started.taskId, sessionId: started.sessionId, status: started.status };
      } catch (err) {
        // 决策 18：maxParallel 超限 → FORBIDDEN；其他启动失败 → EXTENSION_ERROR
        const message = err instanceof Error ? err.message : String(err);
        const code = message.includes('Max parallel') ? 'FORBIDDEN' : 'EXTENSION_ERROR';
        throw new MyTerminalError(code, message);
      }
    },
  });
```

**设计说明（不许偏离的理由）：**
- `...record.forkOptions` 展开合法且类型安全：`SkillForkOptions` 的字段是 `SubagentStartInput` 的子集（任务 1 的类型设计保证了这一点）。
- fork 返回值的 `status` 直接用 `started.status`（runner 返回 `'running'`）。
- inline 走 `record.mode !== 'fork'` 而不是 `=== 'inline'`：`SkillManifest.mode` 类型已被 validate 收敛为 `'inline' | 'fork'`，`!== 'fork'` 等价但更防御。

### 2.2 修复 provider cast 缺 'glm'（隐藏不一致）

位置：第 595 行附近，`subagent_start` 的 invoke 里。把：

```typescript
        provider: asOptionalString(input.provider) as 'openai' | 'anthropic' | 'deepseek' | undefined,
```

改为：

```typescript
        provider: asOptionalString(input.provider) as 'openai' | 'anthropic' | 'deepseek' | 'glm' | undefined,
```

（背景：`PROVIDER_ENUM` 在 GLM 接入时已含 `'glm'`，`SubagentStartInput.provider` 也已含 `'glm'`，但这处 cast 被落下了。运行时无害（cast 只是类型层），但类型层必须一致。）

### 2.3 确认 import 无需改

第 11 行 `import { listSkills, loadSkill } from './skills.js';` 和第 12 行 `import { getSubagentRunner } from './subagent/runner.js';` 都已存在，**不需要动**。

### 2.4 typecheck + build

```bash
bun run typecheck && bun run build
```

必须全绿。

## 第 3 步：新建测试 test/skill-v2-tool.test.mjs

**逐字创建以下文件**：

```javascript
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

import test from 'node:test';
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
```

## 第 4 步：跑测试 + 覆盖率

```bash
bun run build && bun test --timeout 120000 test/skill-v2-tool.test.mjs
```

13 个用例必须全绿。然后：

```bash
bun test --timeout 120000 --coverage test/skill-v2-tool.test.mjs
```

看 `core-tools.ts` 的覆盖率——本任务只要求 **skill 工具 invoke 路径 100% 覆盖**（core-tools.ts 整体很大，其余部分由 myterminal.test.mjs 等覆盖）。验证方式：把 skill invoke 里每一行对照——list 分支、NOT_FOUND 分支、inline 分支、防线 A 分支、fork 成功分支、FORBIDDEN 分支、EXTENSION_ERROR 分支，每个分支都有对应用例（01/03/02/05/06-08/09/10）。

**变异体自查**：7 个变异体逐个确认（文件头注释已列，验证成立）。

## 第 5 步：全量回归

```bash
bun run test
```

全量套件必须全绿。特别注意 `test/myterminal.test.mjs`——它可能间接枚举工具目录；如果有用例断言工具总数或 skill_list/skill_load 存在，那是合法适配点：按"29 工具时代 → 现状"更新断言，并在 commit message 里说明。除此之外的挂掉都是你的 bug，修好再提交。

## 第 6 步：提交

```bash
git add src/core-tools.ts test/skill-v2-tool.test.mjs
# 如果第 5 步适配了 myterminal.test.mjs，一并 add：
# git add test/myterminal.test.mjs
git commit -m "feat(skills): ADR-0010 skill 工具——删 skill_list/skill_load，无参=list 有参=run

- 决策 3/7：schema 无 action 字段，name 可选；skill_list+skill_load 删除
- 决策 1：inline 返回 content；fork 调 SubagentRunner.start 异步返回 taskId
- 决策 8：annotations 非 readOnly（fork 有副作用）
- 决策 15：fork objective 加 '执行技能 \"name\" 的指令：' 前缀
- 决策 6：forkOptions 展开覆盖 subagent 默认配置
- 决策 17：list/inline 不要 identity；fork 调 actor + 递归防线 A
- 决策 18：NOT_FOUND/FORBIDDEN(maxParallel)/EXTENSION_ERROR 错误码
- 顺手修复 subagent_start provider cast 缺 'glm'（类型层不一致）
- test/skill-v2-tool.test.mjs：13 用例，7 变异体全杀"
```

## 验收清单

- [ ] 分支检查通过，全程 `feat/skills`
- [ ] skill_list + skill_load 已删，skill 工具按 2.1 逐字落地
- [ ] provider cast 加 'glm'
- [ ] 13 用例全绿，fork 路径 7 分支全覆盖
- [ ] `bun run test` 全量回归全绿
- [ ] commit 已提交

## 禁止事项

- 🚫 禁止给 skill 工具加 `action` 字段（决策 3 明确推翻）
- 🚫 禁止给 subagent 的 8 工具集加 skill（决策 4）
- 🚫 禁止改 `subagent_start` 的既有行为（只允许 2.2 的 cast 修复）
- 🚫 禁止把 fork 做成同步等待（决策 1：异步返回 taskId）
- 🚫 禁止 `git add -A` / `git add .`
- 🚫 禁止在 main 分支做任何事
