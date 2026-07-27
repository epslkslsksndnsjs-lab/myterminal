# M2：状态管理四模块（store / cost-tracker / file-state / shell-tracker）

> ⚠️ **开始前先执行 `git branch --show-current`，确认当前在 `feat/skills` 分支，不要在 `main`（主分支）上开发。** 输出不是 `feat/skills` 就立即停止报告。同时确认 M1 已验收通过（`src/types.ts` 已有 `SubagentSettings`）。

- **任务目标**：新建 `src/subagent/` 目录，实现四个**纯数据/纯逻辑**状态模块——subagent 状态存储、成本追踪、文件状态追踪、shell 进程追踪。它们不依赖 LLM、不依赖 TUI，是后续所有模块的地基。
- **ADR 依据**：ADR-0007 决策 6（subagentStore）、决策 7（结果保留 + 1 小时超时）、决策 22（CostTracker）、决策 26（readFileState）、决策 28（shell tracker）、决策 39（审计日志结构）、决策 29（定价表）。
- **前置依赖**：M1（`SubagentSettings` 类型）。
- **产出**：新建 `src/subagent/store.ts`、`src/subagent/cost-tracker.ts`、`src/subagent/file-state.ts`、`src/subagent/shell-tracker.ts`；新建 `test/subagent-m2.test.mjs`。预估 ~450 行。
- **覆盖率门槛**：组件级 ≥ 70%。

---

## 一、必读材料

1. `deliverables/subagent-handoff/README.md`（通用规范）
2. `docs/adr/0007-subagent-executor.md`：决策 6 / 7 / 22 / 26 / 28 / 39 + 「决策 28」节的 shell-tracker 参考代码 + 「决策 22」节的 CostTracker 参考代码
3. `src/skills.ts`——参考其"模块级常量 + Map 存储 + 纯函数导出"的组织风格
4. `src/types.ts`（M1 产物）——`SubagentSettings`

## 二、铁律

- 四个模块**互不 import**（cost-tracker / file-state / shell-tracker 被 store 或上层使用，但本任务内保持零耦合；store.ts 可以 import cost-tracker 的类型）。
- **不 import** `src/store.ts`（主 store）——subagentStore 是完全独立的内存存储（ADR-0007 决策 6：不碰主 store、不碰 ExtensionService）。
- 所有存储都是**进程内存 Map**，不落盘、不改 JSONL。
- 时间相关的清理（1 小时超时）用 `setTimeout` + `.unref()`，防止拖住进程退出（参考现有代码对 timer 的处理）。

## 三、分步实施

### Step 1：`src/subagent/cost-tracker.ts`（决策 22 + 29）

实现：

1. **定价表**（硬编码，per 1M tokens，单位 USD）：

```typescript
// ADR-0007 决策 22：硬编码常见模型定价；未知模型按同 provider 估算
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'gpt-4o':            { input: 2.5,  output: 10,   cacheRead: 1.25 },
  'gpt-4o-mini':       { input: 0.15, output: 0.6,  cacheRead: 0.075 },
  'gpt-4.1':           { input: 2,    output: 8,    cacheRead: 0.5 },
  'gpt-4.1-mini':      { input: 0.4,  output: 1.6,  cacheRead: 0.1 },
  'claude-sonnet-4':   { input: 3,    output: 15,   cacheRead: 0.3 },
  'claude-haiku-4':    { input: 0.8,  output: 4,    cacheRead: 0.08 },
  'claude-opus-4':     { input: 15,   output: 75,   cacheRead: 1.5 },
  'deepseek-chat':     { input: 0.27, output: 1.1,  cacheRead: 0.07 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14 },
};
```

2. **CostTracker 类**（按 ADR-0007 决策 22 的参考代码实现）：`addUsage({ input_tokens, output_tokens, cache_read_input_tokens? })` 累积；`getTotalCost()` 按定价表算 USD；`getUsage()` 返回 `{ inputTokens, outputTokens, cacheReadTokens, totalUSD }`。
3. **模型解析**：构造时接收 `model` 字符串；精确匹配 → 前缀匹配（如 `gpt-4o-2024-08-06` 匹配 `gpt-4o`）→ 未知模型按保守默认（用同 provider 最贵档或 `gpt-4o` 定价，加 `console.warn`）。前缀匹配逻辑与 M6 的 `getModelContextWindow` 保持一致（两边可各自实现，行为要对齐）。

**输出物**：`CostTracker` 可独立实例化使用。**验证**：`bun run build` 通过。

### Step 2：`src/subagent/file-state.ts`（决策 26 + 36）

实现：

1. **readFileState**：`Map<string, { content: string; timestamp: number }>`，按 agentId 隔离——`Map<agentId, Map<filePath, state>>`（外层按 agent 隔离，防止两个 subagent 互相污染）。
2. 导出函数：
   - `recordFileRead(agentId, filePath, content)`——read_file/write_file 后记录。
   - `validateEdit(agentId, filePath, oldString, replaceAll)`——返回 `{ ok: true } | { ok: false; message: string }`：
     - 未读过 → `{ ok: false, message: 'File has not been read yet. Use read_file first.' }`
     - 0 匹配 → 附前 5 行带行号预览（ADR-0007 决策 36）：`String to replace not found in file.\n\nFile preview (first 5 lines):\n1\t...`
     - >1 匹配且 `!replaceAll` → `Found N matches. Provide more context or set replace_all=true.`
   - `applyEdit(agentId, filePath, oldString, newString, replaceAll)`——执行替换并返回新内容（`replaceAll` 时用 `split(old).join(new)`，否则 `replace` 单次），同步更新缓存。
   - `clearFileState(agentId)`——compact 后或 finally 清理时调用（决策 26：compact 后清空）。
3. **验证**：`bun run build` 通过。

### Step 3：`src/subagent/shell-tracker.ts`（决策 28）

**严格按 ADR-0007 决策 28 的参考代码实现**（它在 2426 行文档的「决策 28」节，含完整代码），要点：

1. `agentShellTasks: Map<string, Set<ChildProcess>>`。
2. `trackShellTask(agentId, child)`——注册 + `child.on('exit')` 自动从 Set 移除。
3. `cleanupAgentShellTasks(agentId)`——遍历 Set，跳过已退出（`child.killed || child.exitCode !== null`），先 `process.kill(-child.pid, 'SIGTERM')` 杀进程组（`detached: true` 的子进程是新进程组 leader），失败降级 `child.kill('SIGTERM')`，最后 `agentShellTasks.delete(agentId)`。
4. 可选增强：SIGTERM 后 2 秒未退出的进程再发 SIGKILL（硬兜底）。若实现，必须配套测试。
5. **验证**：`bun run build` 通过。

### Step 4：`src/subagent/store.ts`（决策 6 + 7 + 39）

实现独立的 subagent 状态存储：

```typescript
// ADR-0007 决策 6：完全独立的内存 Map，不碰主 store / ExtensionService
export type SubagentStatus = 'running' | 'completed' | 'failed' | 'aborted';

export type SubagentTask = {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type ToolAuditLog = {  // 决策 39
  toolName: string;
  toolUseId: string;
  input: string;          // JSON 序列化后截断到 1000 字符
  startTime: number;
  endTime: number;
  durationMs: number;
  success: boolean;
  errorType?: 'schema_validation' | 'permission_denied' | 'execution_error' | 'timeout';
  errorMessage?: string;  // 截断到 500 字符
  resultSizeChars: number;
};

export type SubagentRecord = {
  id: string;
  sessionId?: string;         // M8 接入 delegate session 后回填
  status: SubagentStatus;
  tasks: SubagentTask[];
  result?: string;            // completed 时的最终摘要
  error?: string;             // failed/aborted 时的原因
  abortController: AbortController;
  cost: { inputTokens: number; outputTokens: number; cacheReadTokens: number; totalUSD: number };
  auditLogs: ToolAuditLog[];  // 决策 39：status 返回最近 20 条
  createdAt: number;
  completedAt?: number;
};
```

导出操作函数（模块级 Map + 函数式 API，不用 class）：

- `createSubagent(id, fields): SubagentRecord`——新建记录（status='running'，自带新 AbortController）。
- `getSubagent(id): SubagentRecord | undefined`。
- `updateSubagentStatus(id, status, extra?: { result?, error? })`——终态时写 `completedAt` 并启动**1 小时清理定时器**（决策 7：父 AI 拿走前结果保留；1 小时兜底防泄漏，timer 必须 `.unref()`）。
- `getSubagentResult(id)`——返回后可**选择**立即清理（决策 7："父 AI 拿走结果后清理"）。实现为：`collectSubagentResult(id)` 返回 record 并删除记录。两个函数都导出，由上层（M5/M7/M8）决定何时用哪个。
- `syncTasks(id, tasks)` / `addAuditLog(id, log)`（auditLogs 只保留最近 50 条，查询时返回最近 20 条）。
- `countRunning(): number`——M8 并发限制（maxParallel）要用。
- `clearAllSubagents()`——**仅供测试**调用（注释标注 `// test-only`）。

**验证**：`bun run typecheck && bun run build` 通过。

### Step 5：编写测试 `test/subagent-m2.test.mjs`

至少覆盖（import `../dist/subagent/*.js`）：

**cost-tracker**：
1. 单次/多次 `addUsage` 累积正确；含 cacheRead 的 `getTotalCost()` 数值正确（手工算一遍对照）。
2. 前缀匹配（`gpt-4o-2024-08-06` 按 `gpt-4o` 定价）；未知模型 fallback + 不抛错。

**file-state**：
3. 未读过就 `validateEdit` → 拒绝且消息含 `read_file first`。
4. 0 匹配 → 拒绝且消息含前 5 行预览（含行号格式 `1\t`）。
5. 2 处匹配无 replaceAll → 拒绝且消息含 `Found 2 matches`；带 replaceAll → `applyEdit` 全替换成功。
6. 单匹配 → `applyEdit` 单次替换成功，缓存更新（再次 validateEdit 旧串 0 匹配）。
7. agent 隔离：agent A 读过文件，agent B validateEdit 仍被拒绝。
8. `clearFileState` 后 validateEdit 回到"未读过"拒绝。

**shell-tracker**：
9. 用 `spawn('sleep 30')`（`detached: true`）track 后 `cleanupAgentShellTasks`，断言进程被杀死（exit 事件触发 / 轮询 `process.kill(pid, 0)` 抛 ESRCH）。
10. 已退出的 child（`spawn('echo hi')` 等 exit 后）track 再 cleanup——不抛错、Set 自动收缩。

**store**：
11. create/get/update 全流程；终态写 completedAt。
12. `collectSubagentResult` 返回 record 且记录被删除（再次 get 为 undefined）。
13. auditLogs 超过 50 条时只保留最近 50 条。
14. `countRunning` 只统计 status='running'。
15. **1 小时超时清理**：将清理间隔做成可注入参数（如 `updateSubagentStatus(id, status, extra, cleanupAfterMs?)` 或模块级 `setCleanupDelayMs()` 测试钩子），测试里设 50ms，断言到期后记录被清除。
16. **集成用例**：模拟一个 subagent 的完整生命周期——create → syncTasks ×3 → addAuditLog ×2 → updateStatus('completed', result) → collectSubagentResult 拿到完整 record（tasks/auditLogs/cost 齐全）。

### Step 6：覆盖率 + 变异测试

`bun test --coverage test/subagent-m2.test.mjs`，四个模块 ≥ 70%。

**变异体清单**：

| # | 变异体 | 杀死它的测试 |
|---|--------|-------------|
| 1 | `getTotalCost` 的 `/ 1_000_000` 删掉 | 用例 1 |
| 2 | `validateEdit` 的 `matches > 1` 改为 `matches > 0` | 用例 6 |
| 3 | `cleanupAgentShellTasks` 删掉 `process.kill(-pid)` 只留 `child.kill` | 用例 9（sleep 的子进程存活检测） |
| 4 | auditLogs 保留 50 条改为 51 条 | 用例 13 |
| 5 | 1 小时清理 timer 不 `.unref()` 或间隔 ×2 | 用例 15 |
| 6 | agent 隔离的外层 Map 去掉（全局共享 file state） | 用例 7 |

### Step 7：全量回归

`bun run test` 全量 0 fail。

## 四、验收清单（DoD）

- [ ] 在 `feat/skills` 分支；M1 产物已存在
- [ ] 四个新文件在 `src/subagent/` 下，互不耦合，未 import 主 store
- [ ] CostTracker 定价表 + 前缀匹配 + fallback warn
- [ ] file-state 按 agentId 双层隔离，三种校验消息与 ADR 文案一致（含前 5 行预览）
- [ ] shell-tracker 进程组 SIGTERM + 降级 + exit 自动清理
- [ ] store 1 小时超时清理（可注入间隔 + unref）+ auditLogs 截断 + countRunning
- [ ] 测试 ≥ 16 用例全过，覆盖率 ≥ 70%，变异体 6/6 被杀死
- [ ] `bun run typecheck` 0 errors；`bun run test` 全量 0 fail
- [ ] 未提交 git commit

## 五、交接给 M3-M8

在交付总结中给出：
1. 四个模块的导出函数签名清单（M4 的工具实现、M7 的 executor、M8 的 runner 都要用）。
2. 1 小时清理间隔的测试注入方式（M8 集成测试要复用）。
3. `SubagentRecord.cost` 的更新方式——是 store 内部聚合还是外部写入？（建议：M7 executor 每轮通过 `addAuditLog` 同款模式调用一个 `updateCost(id, usage)`，若本任务未实现请补上或说明。）
