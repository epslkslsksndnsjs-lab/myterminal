# 任务 2：runner.ts — origin 参数 + status idempotent + notify 带 taskId（决策 13/14）

> 你是执行本任务的开发模型。**严格按步骤来，每步做完验证再继续。禁止跳步、禁止猜测。**
> 前置：任务 1 已完成并提交（`git log --oneline -1` 应看到 `feat(skills): ADR-0010 数据层...`）。如果没有，停止并报告。

## 第 0 步：分支检查（必须先做，失败立即停止）

```bash
cd 
git branch --show-current
```

- 输出必须**正好是** `feat/skills`。否则 🛑 停止并报告，绝对禁止继续。

## 第 1 步：先理解（必读清单）

1. `docs/adr/0010-skill-invoke-tool-v2.md` 决策 13（subagent_status 改 idempotent，修订 ADR-0007 决策 7）和决策 14（message 通知带 taskId + origin）
2. `src/subagent/runner.ts` **全文**（266 行）——你要改的文件
3. `src/subagent/store.ts` 第 100-120 行——确认 1 小时超时清理定时器已存在（决策 13 说"清理只靠 1 小时超时定时器"，这个机制**已有**，你不需要实现，只需要理解）
4. `test/subagent-m8.test.mjs` 第 215-244 行（M8-runner-05）和第 660-742 行（M8-e2e-14）——你要适配的两个现有用例

**理解自查**（答不上就重读）：
- 现在 `status()` 在 completed 时做了什么"破坏性"操作？（答：调 `collectSubagentResult(taskId)` 把记录从 Map 删掉，第二次查抛 NOT_FOUND）
- `finalize()` 在哪里被调用？（答：`start()` 里 `runSubagentImpl(...).then((result) => finalize(...))`）
- origin 信息怎么从 `start()` 传到 `finalize()`？（答：靠闭包——`start` 的 `.then` 回调在 `start` 作用域内，能拿到 `start` 的参数）

## 第 2 步：改 src/subagent/runner.ts

### 2.1 删 import 里的 collectSubagentResult

位置：第 8-11 行。把：

```typescript
import {
  createSubagent, getSubagent, updateSubagentStatus, updateSubagentCost,
  collectSubagentResult, countRunning, getRecentAuditLogs, listAllSubagents,
} from './store.js';
```

改为：

```typescript
import {
  createSubagent, getSubagent, updateSubagentStatus, updateSubagentCost,
  countRunning, getRecentAuditLogs, listAllSubagents,
} from './store.js';
```

**注意**：`store.ts` 里的 `collectSubagentResult` 导出函数**保留不删**（ADR 未要求，保持最小 diff；它变成无人调用的导出，无害）。

### 2.2 加 SubagentOrigin 类型

位置：第 28 行 `};`（`SubagentStartInput` 类型结束）之后。加：

```typescript
/** ADR-0010 决策 14：subagent 来源——skill(fork) 启动时传入，notify 消息据此区分格式 */
export type SubagentOrigin = { type: 'skill'; skillName: string };
```

### 2.3 finalize() 加 origin 参数 + notify 新格式

位置：第 94-121 行，整个 `finalize` 函数。把：

```typescript
  async function finalize(
    agentId: string,
    childSessionId: string,
    parentSessionId: string,
    result: SubagentRunResult,
  ): Promise<void> {
    const childIdentity = childIdentities.get(agentId);
    // 决策 7/10：更新 subagent store 状态 + checkpoint + message_send
    if (result.status === 'completed') {
      const summary = result.result.slice(0, 200) || 'Subagent completed.';
      updateSubagentStatus(agentId, 'completed', { result: result.result });
      if (childIdentity) {
        await checkpoint(childSessionId, childIdentity, 'completed', result.result.length > 500
          ? `${result.result.slice(0, 500)}...`
          : result.result);
        await notify(childSessionId, childIdentity, parentSessionId, `subagent completed: ${summary}`);
      }
    } else {
      const reason = result.error || 'unknown error';
      updateSubagentStatus(agentId, 'failed', { error: reason });
      if (childIdentity) {
        await checkpoint(childSessionId, childIdentity, 'cancelled', reason);
        await notify(childSessionId, childIdentity, parentSessionId, `subagent failed: ${reason}`);
      }
    }
    // 清理 identity
    childIdentities.delete(agentId);
  }
```

改为（**逐字使用**）：

```typescript
  async function finalize(
    agentId: string,
    childSessionId: string,
    parentSessionId: string,
    result: SubagentRunResult,
    origin?: SubagentOrigin,
  ): Promise<void> {
    const childIdentity = childIdentities.get(agentId);
    // 决策 7/10：更新 subagent store 状态 + checkpoint + message_send
    // ADR-0010 决策 14：notify 带 taskId + origin——skill fork 与直接启动格式不同
    if (result.status === 'completed') {
      const summary = result.result.slice(0, 200) || 'Subagent completed.';
      updateSubagentStatus(agentId, 'completed', { result: result.result });
      if (childIdentity) {
        await checkpoint(childSessionId, childIdentity, 'completed', result.result.length > 500
          ? `${result.result.slice(0, 500)}...`
          : result.result);
        const body = origin?.type === 'skill'
          ? `skill '${origin.skillName}' fork completed (taskId=${agentId}): ${summary}`
          : `subagent completed (taskId=${agentId}): ${summary}`;
        await notify(childSessionId, childIdentity, parentSessionId, body);
      }
    } else {
      const reason = result.error || 'unknown error';
      updateSubagentStatus(agentId, 'failed', { error: reason });
      if (childIdentity) {
        await checkpoint(childSessionId, childIdentity, 'cancelled', reason);
        const body = origin?.type === 'skill'
          ? `skill '${origin.skillName}' fork failed (taskId=${agentId}): ${reason}`
          : `subagent failed (taskId=${agentId}): ${reason}`;
        await notify(childSessionId, childIdentity, parentSessionId, body);
      }
    }
    // 清理 identity
    childIdentities.delete(agentId);
  }
```

### 2.4 start() 加 origin 参数并传给 finalize + catch 块对齐

位置：第 125 行 `start` 方法签名。把：

```typescript
    start(parentSessionId: string, input: SubagentStartInput): SubagentStartResult {
```

改为：

```typescript
    start(parentSessionId: string, input: SubagentStartInput, origin?: SubagentOrigin): SubagentStartResult {
```

位置：第 173 行 `.then` 回调。把：

```typescript
      }).then((result) => finalize(subagentId, child.id, parentSessionId, result))
```

改为：

```typescript
      }).then((result) => finalize(subagentId, child.id, parentSessionId, result, origin))
```

位置：第 174-181 行 catch 块。把：

```typescript
        .catch((err: unknown) => {
          const error = err instanceof Error ? err.message : String(err);
          const storedIdentity = childIdentities.get(subagentId);
          if (storedIdentity) {
            void notify(child.id, storedIdentity, parentSessionId, `subagent failed: ${error}`).catch(() => { /* best effort */ });
          }
          childIdentities.delete(subagentId);
        });
```

改为（notify 格式与 finalize 对齐，带 taskId + origin）：

```typescript
        .catch((err: unknown) => {
          const error = err instanceof Error ? err.message : String(err);
          const storedIdentity = childIdentities.get(subagentId);
          if (storedIdentity) {
            const body = origin?.type === 'skill'
              ? `skill '${origin.skillName}' fork failed (taskId=${subagentId}): ${error}`
              : `subagent failed (taskId=${subagentId}): ${error}`;
            void notify(child.id, storedIdentity, parentSessionId, body).catch(() => { /* best effort */ });
          }
          childIdentities.delete(subagentId);
        });
```

### 2.5 status() 删"取走即清理"（决策 13 核心）

位置：第 186-214 行 `status` 方法。把：

```typescript
    /** 查询 subagent 状态（决策 9） */
    status(taskId: string): SubagentStatusResult {
      const record = getSubagent(taskId);
      if (!record) throw Object.assign(new Error(`Subagent not found: ${taskId}`), { code: 'NOT_FOUND' });

      // 决策 7：completed 后取走即清理——第一次 status 返回 result 并清理
      if (record.status === 'completed' && record.result !== undefined) {
        const result: SubagentStatusResult = {
          status: record.status,
          sessionId: record.sessionId,
          tasks: record.tasks,
          cost: record.cost,
          result: record.result,
          auditLogs: getRecentAuditLogs(taskId),
        };
        collectSubagentResult(taskId); // 取走即清理
        return result;
      }

      return {
        status: record.status,
        sessionId: record.sessionId,
        tasks: record.tasks,
        cost: record.cost,
        error: record.error,
        result: record.status === 'completed' ? record.result : undefined,
        auditLogs: getRecentAuditLogs(taskId),
      };
    },
```

改为（**逐字使用**）：

```typescript
    /** 查询 subagent 状态（决策 9；ADR-0010 决策 13 修订：idempotent——completed 后可多次查，清理只靠 1 小时超时定时器 store.ts） */
    status(taskId: string): SubagentStatusResult {
      const record = getSubagent(taskId);
      if (!record) throw Object.assign(new Error(`Subagent not found: ${taskId}`), { code: 'NOT_FOUND' });

      return {
        status: record.status,
        sessionId: record.sessionId,
        tasks: record.tasks,
        cost: record.cost,
        error: record.error,
        result: record.status === 'completed' ? record.result : undefined,
        auditLogs: getRecentAuditLogs(taskId),
      };
    },
```

### 2.6 更新 core-tools.ts 里 subagent_status 的过时描述（仅 1 行）

位置：`src/core-tools.ts` 第 606 行附近。把：

```typescript
    description: 'Query subagent progress, tasks, cost, and result. On first call after completion, returns the result and cleans up; subsequent calls return NOT_FOUND.',
```

改为：

```typescript
    description: 'Query subagent progress, tasks, cost, and result. Idempotent: after completion the result stays available for repeated queries until the one-hour cleanup.',
```

（语义随代码同步更新，避免同一 commit 内代码与描述互相矛盾。）

### 2.7 typecheck + build

```bash
bun run typecheck && bun run build
```

必须全绿。

## 第 3 步：适配现有 m8 测试（2 处）

**先重新读一遍** `test/subagent-m8.test.mjs` 第 215-244 行和第 718-742 行确认当前内容（行号以你读到的为准）。

### 3.1 M8-runner-05（约 215-244 行）：改"取走即清理"断言为 idempotent

把用例标题行和结尾断言：

```javascript
test('M8-runner-05: status structure and take-and-clean', () => {
```

改为：

```javascript
test('M8-runner-05: status structure and idempotent completed queries (ADR-0010 决策 13)', () => {
```

把结尾：

```javascript
  // 第二次 status——取走即清理：应抛出 NOT_FOUND
  assert.throws(
    () => runner.status(result.taskId),
    /Subagent not found/,
  );
});
```

改为：

```javascript
  // ADR-0010 决策 13：第二次 status 仍返回 result（idempotent，不再取走即删）
  const status3 = runner.status(result.taskId);
  assert.equal(status3.status, 'completed');
  assert.equal(status3.result, 'Final summary');
});
```

### 3.2 M8-e2e-14（约 722-742 行）：第二次 status 从 NOT_FOUND 改为返回 result

把：

```javascript
  // 注意：取走即清理语义——可能已经清理了
  // 如果清理了，status 会返回 NOT_FOUND
  if (statusResponse2.ok) {
    assert.equal(statusResponse2.data.result.status, 'completed');
  }
  // 第二次调用应该抛 NOT_FOUND（取走即清理）
  const statusResponse3 = await ext.call(
    { tool: 'subagent_status', input: { taskId }, identity: rootIdentity },
    { transport: 'tui' },
  );
  assert.equal(statusResponse3.ok, false);
  assert.match(statusResponse3.error?.code || '', /NOT_FOUND/);
```

改为：

```javascript
  // ADR-0010 决策 13：idempotent——completed 后可多次查
  assert.equal(statusResponse2.ok, true);
  assert.equal(statusResponse2.data.result.status, 'completed');
  assert.equal(statusResponse2.data.result.result, 'E2E test completed: all files processed.');
  // 第二次调用仍返回 result（不再 NOT_FOUND）
  const statusResponse3 = await ext.call(
    { tool: 'subagent_status', input: { taskId }, identity: rootIdentity },
    { transport: 'tui' },
  );
  assert.equal(statusResponse3.ok, true);
  assert.equal(statusResponse3.data.result.status, 'completed');
  assert.equal(statusResponse3.data.result.result, 'E2E test completed: all files processed.');
```

### 3.3 确认其他 m8 用例不受影响

M8-runner-03/04 的 `/subagent completed/`、`/subagent failed/` 正则——新格式 `subagent completed (taskId=sa_xxx): ...` 仍然 match，**不需要改**。跑一遍确认：

```bash
bun run build && bun test --timeout 120000 test/subagent-m8.test.mjs
```

16 个用例必须全绿。

## 第 4 步：新建测试 test/skill-v2-runner.test.mjs

**逐字创建以下文件**：

```javascript
// ADR-0010 runner 修订测试——origin 参数 + status idempotent + notify 带 taskId+origin
// 覆盖决策：13（status idempotent）、14（notify 带 taskId+origin，含 catch 块）
// 目标：runner.ts 改动函数（start/status/finalize）行覆盖率 ≥ 90%；变异体 4/4 被杀死
//
// 变异体清单：
//   M1 status() 仍调 collectSubagentResult（旧行为复活） → 用例 01 杀
//   M2 finalize 的 notify 忘带 taskId                    → 用例 02/03 杀
//   M3 origin 判断反转（skill 消息发给直接启动）         → 用例 03 杀
//   M4 failed 分支忘带 origin 前缀                       → 用例 04 杀

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { createSubagentRunner, setRunnerDepsForTesting, resetSubagentRunner } from '../dist/subagent/runner.js';
import { clearAllSubagents, getSubagent } from '../dist/subagent/store.js';

// ── 测试辅助（与 test/subagent-m8.test.mjs 同款模式）──

function defaultSubagentSettings(overrides = {}) {
  return {
    enabled: true,
    provider: 'openai',
    model: 'gpt-4o',
    maxTurns: 50,
    timeoutSec: 300,
    maxParallel: 2,
    ...overrides,
  };
}

function mockSession(id, overrides = {}) {
  return {
    id,
    name: 'subagent-test',
    role: 'worker',
    phase: 'working',
    presence: 'claimed',
    parentSessionId: overrides.parentSessionId,
    task: overrides.task,
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeDeps(overrides = {}) {
  const callLog = [];
  const deps = {
    runSubagentImpl: overrides.runSubagentImpl ?? (async () => {
      callLog.push('runSubagentImpl');
      return { status: 'completed', result: 'Test completed successfully.' };
    }),
    settings: overrides.settings ?? defaultSubagentSettings(),
    workspaceDir: overrides.workspaceDir ?? '/tmp/test-workspace',
    notify: overrides.notify ?? (async (childId, childIdentity, parentId, body) => {
      callLog.push({ notify: { childId, parentId, body } });
    }),
    checkpoint: overrides.checkpoint ?? (async (childId, childIdentity, phase, summary) => {
      callLog.push({ checkpoint: { childId, phase, summary } });
    }),
    registerAndClaimChild: overrides.registerAndClaimChild ?? ((parentId, args) => {
      const sid = 'ses_child_' + randomBytes(3).toString('hex');
      callLog.push({ registerAndClaimChild: { parentId, args } });
      return {
        session: mockSession(sid, { parentSessionId: parentId, name: args.name, task: args.task }),
        identity: { sessionId: sid, sessionToken: 'tok_' + randomBytes(8).toString('hex') },
      };
    }),
  };
  return { deps, callLog };
}

function setupRunner(overrides = {}) {
  const { deps, callLog } = fakeDeps(overrides);
  const runner = createSubagentRunner(deps);
  setRunnerDepsForTesting(deps);
  return { runner, callLog };
}

function lastNotify(callLog) {
  const entries = callLog.filter((e) => e && e.notify);
  return entries.length ? entries[entries.length - 1].notify : null;
}

// ══════════════════════════════════════════════════════
// 用例 01：决策 13——status idempotent（杀 M1）
// ══════════════════════════════════════════════════════

test('01: completed 后 status 可多次查，result 不丢（杀 M1）', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner } = setupRunner();

  const started = runner.start('ses_parent_t2', { objective: 'Idempotent check' });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const first = runner.status(started.taskId);
  assert.equal(first.status, 'completed');
  assert.equal(first.result, 'Test completed successfully.');

  // 第二次、第三次仍返回 result——旧行为（取走即删）会在这里抛 NOT_FOUND
  const second = runner.status(started.taskId);
  assert.equal(second.status, 'completed');
  assert.equal(second.result, 'Test completed successfully.');
  const third = runner.status(started.taskId);
  assert.equal(third.result, 'Test completed successfully.');

  // 记录仍在 store（清理只靠 1 小时定时器，不归 status 管）
  assert.ok(getSubagent(started.taskId));
});

// ══════════════════════════════════════════════════════
// 用例 02-04：决策 14——notify 带 taskId + origin
// ══════════════════════════════════════════════════════

test('02: skill fork 完成——notify 带 skill 前缀 + taskId（杀 M2）', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner, callLog } = setupRunner();

  const started = runner.start('ses_parent_t2', { objective: 'Fork task' }, { type: 'skill', skillName: 'refactor-module' });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const notify = lastNotify(callLog);
  assert.ok(notify, 'notify must be called');
  assert.match(notify.body, new RegExp(`^skill 'refactor-module' fork completed \\(taskId=${started.taskId}\\): `));
  assert.match(notify.body, /Test completed successfully/);
});

test('03: 直接启动（无 origin）——notify 不带 skill 前缀但带 taskId（杀 M2/M3）', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner, callLog } = setupRunner();

  const started = runner.start('ses_parent_t2', { objective: 'Direct task' });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const notify = lastNotify(callLog);
  assert.ok(notify);
  assert.match(notify.body, new RegExp(`^subagent completed \\(taskId=${started.taskId}\\): `));
  assert.doesNotMatch(notify.body, /skill '/);
});

test('04: skill fork 失败——notify 带 skill 前缀 + failed + taskId（杀 M4）', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner, callLog } = setupRunner({
    runSubagentImpl: async () => ({ status: 'failed', error: 'provider quota exhausted' }),
  });

  const started = runner.start('ses_parent_t2', { objective: 'Failing fork' }, { type: 'skill', skillName: 'audit-code' });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const notify = lastNotify(callLog);
  assert.ok(notify);
  assert.match(notify.body, new RegExp(`^skill 'audit-code' fork failed \\(taskId=${started.taskId}\\): `));
  assert.match(notify.body, /quota exhausted/);
});

// ══════════════════════════════════════════════════════
// 用例 05：catch 块（runSubagentImpl reject）notify 也带 taskId + origin
// ══════════════════════════════════════════════════════

test('05: runSubagentImpl reject——catch 块 notify 带 taskId + skill 前缀', async () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner, callLog } = setupRunner({
    runSubagentImpl: async () => { throw new Error('network unreachable'); },
  });

  const started = runner.start('ses_parent_t2', { objective: 'Rejecting task' }, { type: 'skill', skillName: 'net-skill' });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const notify = lastNotify(callLog);
  assert.ok(notify, 'catch path must notify');
  assert.match(notify.body, new RegExp(`^skill 'net-skill' fork failed \\(taskId=${started.taskId}\\): `));
  assert.match(notify.body, /network unreachable/);
});

// ══════════════════════════════════════════════════════
// 用例 06：回归——NOT_FOUND 语义不变（不存在的 taskId 仍抛错）
// ══════════════════════════════════════════════════════

test('06: 不存在的 taskId 仍抛 NOT_FOUND（回归）', () => {
  clearAllSubagents();
  resetSubagentRunner();
  const { runner } = setupRunner();
  assert.throws(() => runner.status('sa_nonexist'), /Subagent not found/);
});
```

## 第 5 步：跑测试 + 覆盖率

```bash
bun run build && bun test --timeout 120000 test/skill-v2-runner.test.mjs test/subagent-m8.test.mjs
```

全部（6 + 16 = 22 个用例）必须全绿。然后：

```bash
bun test --timeout 120000 --coverage test/skill-v2-runner.test.mjs
```

确认 `runner.ts` 行覆盖率。**注意**：单跑这一个文件覆盖率不代表全部——`abort`/`listSubagents` 等由 m8 覆盖。判断标准：`start`/`status`/`finalize` 三个改动函数的相关行必须 100% 覆盖（从覆盖率报告的 runner.ts 行看 ≥ 90% 即达标，因为 m8 还覆盖其余部分）。

**变异体自查**：4 个变异体逐个确认有对应用例能杀死（文件头注释已列，验证成立）。

## 第 6 步：全量回归

```bash
bun run test
```

全量测试套件（所有 18+ 个测试文件）必须全绿。任何挂掉的用例：读懂原因——如果是你改动语义导致的合法适配（只有"取走即清理"相关是合法的），按第 3 步模式适配；其他一律视为你的 bug，修好再提交。

## 第 7 步：提交

```bash
git add src/subagent/runner.ts src/core-tools.ts test/subagent-m8.test.mjs test/skill-v2-runner.test.mjs
git commit -m "feat(subagent): ADR-0010 决策 13/14——status idempotent + notify 带 taskId+origin

- runner.start() 加 origin 参数（SubagentOrigin 类型），透传 finalize/catch
- status() 删 collectSubagentResult——completed 后可多次查（修订 ADR-0007 决策 7）
  清理只靠 store.ts 已有 1 小时超时定时器
- finalize/catch 的 notify：skill fork 与直接启动两种格式，均带 taskId
- core-tools subagent_status 描述同步为 idempotent 语义
- 适配 m8 两个用例；新增 skill-v2-runner 6 用例，4 变异体全杀"
```

## 验收清单

- [ ] 分支检查通过，全程 `feat/skills`
- [ ] `runner.ts` 五处改动（import/类型/finalize/start/status）+ `core-tools.ts` 一行描述
- [ ] `store.ts` 的 `collectSubagentResult` 导出**未删除**
- [ ] m8 两处适配完成，16 用例全绿
- [ ] 新测试 6 用例全绿，覆盖率达标
- [ ] `bun run test` 全量回归全绿
- [ ] commit 已提交

## 禁止事项

- 🚫 禁止删 `store.ts` 的任何函数
- 🚫 禁止改 `SubagentStartInput` 的现有字段
- 🚫 禁止改 `abort()` 行为（它已经是 idempotent，与本任务无关）
- 🚫 禁止 `git add -A` / `git add .`
- 🚫 禁止在 main 分支做任何事
