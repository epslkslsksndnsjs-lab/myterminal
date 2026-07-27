# 任务 4：集成收尾 — mcp 提示语 / ADR-0006 superseded / AGENT.md / 全量验证（决策 5/7/12）

> 你是执行本任务的开发模型。**严格按步骤来，每步做完验证再继续。禁止跳步、禁止猜测。**
> 前置：任务 1、2、3 已完成并提交（`git log --oneline -3` 应看到 skill 工具、runner、skills 数据层三个 commit）。如果没有，停止并报告。

## 第 0 步：分支检查（必须先做，失败立即停止）

```bash
cd 
git branch --show-current
```

- 输出必须**正好是** `feat/skills`。否则 🛑 停止并报告，绝对禁止继续。

## 第 1 步：先理解（必读清单）

1. `docs/adr/0010-skill-invoke-tool-v2.md` 决策 5（list 暴露 mode）、7（API 表面收尾表）、12（ADR-0006 标 superseded）
2. `src/mcp.ts` 第 119-136 行——MCP instructions 数组（你要改第 134 行那一句）
3. `src/extensions.ts` 第 239 行和第 261 行——discover 注入 skills 的两处。**注意：这两处不需要改代码**——`listSkills()` 返回值自任务 1 起自动带 `mode` 字段。本任务用集成测试**验证**这一事实，而不是改它。
4. `docs/adr/0006-skill-invoke-tool.md` 开头 15 行——你要加 superseded 标记
5. `AGENT.md` 第 28-32 行——"29个工具"的说法出现的位置

**理解自查**：
- 为什么 extensions.ts 一行都不用改？（答：决策 5 要求 discover 的 skills 带 mode；`SkillManifest` 类型自任务 1 起含 mode，`listSkills` 原样返回，JSON 序列化自动带出。）
- AGENT.md 的"29个工具"为什么必须更新？（答：删 2 加 1，工具总数变了；文档与实现不一致会误导下一个开发者。）

## 第 2 步：改 src/mcp.ts（1 行）

位置：第 134 行。把：

```typescript
      'Use skill_list to discover available skills, then skill_load(name) for full instructions.',
```

改为（**逐字，与 ADR-0010 决策 7 原文一致**）：

```typescript
      'Use skill() to list available skills, skill(name) to run one.',
```

```bash
bun run typecheck && bun run build
```

必须全绿。

## 第 3 步：ADR-0006 标 superseded（决策 12）

位置：`docs/adr/0006-skill-invoke-tool.md` 文件头部的状态行（前 10 行内，找到类似 `- 状态：**已定**` 的一行——先读文件确认实际格式）。

在该状态行**下方插入一行**（不动原有行）：

```markdown
- 状态补充（2026-07-27）：**已被 ADR-0010 superseded**——决策 1（只做 inline）与决策 3（action 字段）被推翻；决策 2（不做 args）保持有效。
```

（先读文件确认格式再插。如果状态行格式与预期不同，以实际为准，保持同样式。）

## 第 4 步：AGENT.md 工具数更新（先查实际数，禁止瞎写）

### 4.1 数出真实工具数

```bash
cd 
bun run build
bun -e "
const { createBuiltinTools } = await import('./dist/core-tools.js');
const { MyTerminalStore } = await import('./dist/store.js');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const dir = mkdtempSync(join(tmpdir(), 'count-'));
const store = new MyTerminalStore(dir);
const config = { settingsPath: join(dir, 'settings.json'), workspaceDir: dir, stateDir: dir, host: '127.0.0.1', port: 0, connectorKey: 'k', actionsToken: 't', publicBaseUrl: '', maxOutputChars: 1000, commandTimeoutSec: 10, uiLanguage: 'en', uiTheme: 'dark', passiveLockEnabled: false, actionsContinuationMode: 'off', nonBlockingTasksEnabled: false };
const tools = createBuiltinTools(config, store);
console.log('builtin count:', tools.size);
console.log('has skill:', tools.has('skill'), '| has skill_list:', tools.has('skill_list'), '| has skill_load:', tools.has('skill_load'));
"
```

预期输出：`builtin count: 36`、`has skill: true | has skill_list: false | has skill_load: false`。

**如果数字不是 36**：停止，把实际输出报告给主理人（说明有别的任务改了工具集，AGENT.md 的更新要以实际数字为准）。

### 4.2 更新 AGENT.md 两处

读 `AGENT.md`，找到两处 "29"：
- 第 30 行附近：`→ 返回29个工具+参数schema`
- 第 33 行附近：`### 3. 干活 — 29个工具速查`

把两处 `29` 都改为 `36`（以 4.1 实测为准）。

**自查**：AGENT.md 工具速查表里**没有** skill_list/skill_load 条目（规划时已核实），所以速查表本体不用删行。如果你读 AGENT.md 时发现速查表里其实有这两个条目，删掉它们并在 skill 一节加一行 `| skill {name?} | 无参=列名单；有参=运行（inline 返回指令，fork 开 subagent 返回 taskId） |`。

## 第 5 步：新建集成测试 test/skill-v2-integration.test.mjs

**逐字创建以下文件**：

```javascript
// ADR-0010 集成测试——discover 注入 mode / MCP 提示语 / e2e 全链路
// 覆盖决策：5（discover skills 带 mode）、7（API 表面：tools 含 skill 不含旧工具；MCP 提示语）、12（文档一致性）
// 目标：集成路径全覆盖；变异体 4/4 被杀死
//
// 变异体清单：
//   M1 discover 的 skills 丢 mode 字段          → 用例 01/02 杀
//   M2 tools 目录仍含 skill_list/skill_load     → 用例 03 杀
//   M3 mcp.ts 提示语仍指向旧工具名              → 用例 04 杀
//   M4 fork e2e 链路某环断裂（start→status）    → 用例 05 杀

import test from 'node:test';
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
  assert.equal(skills.length, 2);

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
  await new Promise((resolve) => setTimeout(resolve, 300));
  const status1 = await ext.call(
    { tool: 'subagent_status', input: { taskId }, identity: rootIdentity },
    { transport: 'actions' },
  );
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
```

## 第 6 步：跑集成测试

```bash
bun run build && bun test --timeout 120000 test/skill-v2-integration.test.mjs
```

5 个用例必须全绿。**变异体自查**：4 个变异体逐个确认（文件头注释已列，验证成立）。

## 第 7 步：全量验证（最终守门，一项都不能少）

```bash
cd 
bun run typecheck
bun run test
```

`bun run test` 内部会先 build 再跑全部测试文件。必须**全绿零失败**。

然后总覆盖率：

```bash
bun test --timeout 120000 --coverage test/skills-v2.test.mjs test/skill-v2-runner.test.mjs test/skill-v2-tool.test.mjs test/skill-v2-integration.test.mjs test/subagent-m8.test.mjs
```

把输出中 `skills.ts`、`runner.ts`、`core-tools.ts` 三行抄进你的完成报告。达标线：
- `skills.ts` ≥ 90%
- `runner.ts` 改动函数（start/status/finalize）相关行 100%（整体 ≥ 80%）
- skill 工具 invoke 路径 100%（core-tools.ts 整体 ≥ 80% 由全量套件保证）

最后统计用例数：

```bash
grep -c "^test(" test/skills-v2.test.mjs test/skill-v2-runner.test.mjs test/skill-v2-tool.test.mjs test/skill-v2-integration.test.mjs
```

预期：14 + 6 + 13 + 5 = 38 个新用例。

## 第 8 步：提交

```bash
git add src/mcp.ts docs/adr/0006-skill-invoke-tool.md AGENT.md test/skill-v2-integration.test.mjs
git commit -m "feat(skills): ADR-0010 集成收尾——MCP 提示语 + discover 验证 + 文档同步

- mcp.ts 提示语改指 skill()/skill(name)（决策 7）
- discover 两处注入的 skills 自动带 mode（决策 5，集成测试验证）
- ADR-0006 标 superseded by ADR-0010（决策 12）
- AGENT.md 工具数 29 → 36
- test/skill-v2-integration.test.mjs：5 用例（含 e2e 全链路），4 变异体全杀"
```

## 第 9 步：完成报告（发给主理人）

报告必须包含：
1. `git log --oneline -6` 输出（本执行包全部 6 个 commit：基线 2 + 任务 1-4 各 1）
2. 全量测试套件结果摘要（通过数/失败数）
3. 三个核心文件覆盖率数字
4. 新用例总数（预期 38）
5. 任何与执行文件的偏差及理由

## 验收清单

- [ ] 分支检查通过，全程 `feat/skills`
- [ ] mcp.ts 一行提示语与 ADR 决策 7 原文逐字一致
- [ ] ADR-0006 superseded 标记已加
- [ ] AGENT.md 工具数为实测值（预期 36），无 skill_list/skill_load 残留引用
- [ ] 集成测试 5 用例全绿
- [ ] `bun run test` 全量全绿，覆盖率达标
- [ ] commit 已提交，完成报告已发

## 禁止事项

- 🚫 禁止改 extensions.ts（决策 5 由任务 1 的类型改动自动满足，本任务只验证）
- 🚫 禁止凭记忆写工具数（必须跑 4.1 的脚本实测）
- 🚫 禁止改 openapi.ts（决策 7：ExtensionToolInput 已有 name 字段，零影响）
- 🚫 禁止 `git add -A` / `git add .`
- 🚫 禁止在 main 分支做任何事
