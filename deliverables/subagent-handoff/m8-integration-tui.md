# M8：接入层 + TUI 页面 + 端到端（runner / core-tools / extensions / mcp / openapi / TUI）

> ⚠️ **开始前先执行 `git branch --show-current`，确认当前在 `feat/skills` 分支，不要在 `main`（主分支）上开发。** 输出不是 `feat/skills` 就立即停止报告。确认 M1-M7 全部验收通过——本任务是收官任务，把 subagent 接入 MyTerminal 的三条通道（Actions / MCP / TUI）。

- **任务目标**：新建 `SubagentRunner`（start/status/abort 三操作 + delegate session 复用 + 通知链路）；在 `core-tools.ts` 注册 3 个 builtin；`extensions.ts` 新增 `callSubagent()`；`mcp.ts` / `openapi.ts` 暴露 schema；TUI 新增 Subagents tab（列表页 + 详情页）；端到端集成测试。
- **ADR 依据**：ADR-0009 全部 14 项决策；ADR-0008 决策 3 / 4（TUI 渲染 + 列表详情 + 最多 2 并发）。
- **前置依赖**：M1-M7。
- **产出**：新建 `src/subagent/runner.ts`、`src/tui/screens/Subagents.tsx`、`src/tui/screens/Subagent.tsx`；修改 `src/core-tools.ts`、`src/extensions.ts`、`src/mcp.ts`、`src/openapi.ts`、`src/tui/App.tsx`（+ BottomNav 若需要）；新建 `test/subagent-m8.test.mjs`。预估 ~600 行。
- **覆盖率门槛**：组件级 ≥ 70%；**端到端集成测试必须通过**。

---

## 一、必读材料

1. `deliverables/subagent-handoff/README.md`
2. `docs/adr/0009-subagent-integration.md` 全文（408 行，本任务的主依据，含接入流程图）
3. `docs/adr/0008-subagent-tui-bridge.md` 决策 3 / 4
4. 现有源码（**改之前先读，照抄模式**）：
   - `src/core-tools.ts`：`add()` 注册模式（约 line 199）+ `session_register` 的 delegate 分支（约 line 432）+ `message_send` 实现
   - `src/extensions.ts`：`CONTROL_TOOLS`（line 14）+ `call()` 全方法（约 line 355-450，理解 authenticate → beginAudit → assertContinuation → beforeOrdinaryCall → trackOperation → fast-return → decorateContinuation/attachEvents 的完整步骤，才能正确做 trimmed 版）
   - `src/store.ts`：`registerDelegate`（line 226）+ `claimFresh`（line 206/258）+ `checkpoint`
   - `src/mcp.ts`：`registerDirect` 签名（line 166）与既有注册风格（zod schema）
   - `src/tui/App.tsx`：tab 索引体系 + `switchTab` + BottomNav；`src/tui/screens/Sessions.tsx`（列表+详情模式的对照样板）
   - `test/myterminal.test.mjs`：ExtensionService 的测试构造 harness（端到端测试复用）
5. M7 交付总结（`runSubagent` 签名 / finish 三态 / `subagentEvents`）

## 二、铁律

- 既有文件**只增不改**：不改任何已有工具的行为、不改已有 call() 步骤顺序、不改 mcp.ts 既有注册、不改 TUI 既有页面。
- `store.ts` **一行都不许动**（delegate session 机制原样复用）。
- **递归防护双线**（决策 8）：① `subagent_start` 的 invoke 里检查 `context.transport === 'subagent'` → 抛 `FORBIDDEN`；② subagent 的 LLM 只见 8 个工具 schema（M4 已保证，本任务验证）。
- **不阻塞**（决策 2）：`subagent_start` 必须立即返回，`runSubagent` 在后台跑（`void promise`，不许 await）。
- TUI tab 索引：**采用方案 A——Subagents 追加到现有 tab 尾部**（新索引 = 现有最大索引 + 1），禁止插入中间重排（`switchTab` 里有 `index !== 7` / `index !== 3` 等硬编码，重排会引入回归）。ADR-0009 写的"Home / Sessions / Subagents / Settings"顺序只是功能示意，不作索引要求。BottomNav 与键盘切换数字键同步追加。

## 三、ADR 交叉裁决（主理人已裁定，照做即可）

ADR-0007 决策 3（subagent 工具进程内自建）与 ADR-0009 流程图（`callSubagent({ tool: 'read_file' })`）存在表述张力。裁定：

1. **工具循环不动**：subagent 的 8 个工具走 M4/M5 进程内执行（ADR-0007 主体），**不接** extensions。
2. **`callSubagent()` 的真实用途 = runner 的通知路径**：subagent 完成/失败时，runner 以 child session 身份通过 `callSubagent()` 调 `message_send` 与 `session_checkpoint`（决策 7 / 10 的三层通知）。trimmed 语义（跳过 continuation/fast-return/attachEvents）在通知路径上同样是刚需——通知必须同步落库，不许被 200ms detach。
3. v1 不把 callSubagent 接入工具循环（该场景留待未来"subagent 调 builtin"需求）。

## 四、分步实施

### Step 1：`src/subagent/runner.ts`（决策 1 / 2 / 7 / 10 / 11 / 12）

```typescript
// 依赖：M2 store / M7 executor / 主 store 的 delegate 机制 / extensions 的 callSubagent（Step 3）
export type SubagentStartInput = {
  objective: string;
  background?: string;
  deliverables?: string[];
  acceptanceCriteria?: string[];
  constraints?: string[];
  provider?: 'openai' | 'anthropic' | 'deepseek';
  model?: string;
  maxTurns?: number;
  timeoutSec?: number;
  readOnly?: boolean;
};

export type SubagentRunnerDeps = {
  // 全部可注入——端到端测试用 fake，不许真调 LLM
  runSubagentImpl?: typeof runSubagent;
  settings: SubagentSettings;          // M1：来自 runtime settings
  workspaceDir: string;                // subagent 的 cwd（默认 = 主 workspace）
  notify: (childSessionId: string, parentSessionId: string, body: string) => Promise<void>;   // 内部走 callSubagent(message_send)
  checkpoint: (childSessionId: string, phase: string, summary: string) => Promise<void>;       // 内部走 callSubagent(session_checkpoint)
  registerDelegate: (parentId: string, args: { name: string; task: TaskPackage }) => { session: MyTerminalSession };
  claimFresh: (session: MyTerminalSession) => unknown;
};
```

`createSubagentRunner(deps)` 返回 `{ start, status, abort }`：

**start(parentSessionId, input)**：
1. `countRunning() >= settings.maxParallel` → 抛错 `"Max parallel subagents reached (N). Wait for existing subagents to complete or abort one."`（决策 11）。
2. 组装任务文本：`objective` + background/deliverables/acceptanceCriteria/constraints 拼成完整 task 文本（格式参考 TaskPackage 的既有序列化风格）。
3. `registerDelegate(parentId, { name: 'subagent-XXXX', task })` → child session（决策 1：复用 delegate）。
4. `claimFresh(child)`（runtime 接管，不走 claimCode）。
5. `createSubagent(subagentId, { sessionId: child.id, ... })`（M2 store；`subagentId = 'sa_' + randomUUID().slice(0, 8)`，作为对外的 taskId）。
6. 合并运行时配置：`{ ...settings, provider: input.provider ?? settings.provider, model: input.model ?? settings.model, ... }`。
7. **后台启动**（决策 2）：`void runSubagentImpl({ agentId: subagentId, task, cwd: workspaceDir, settings: merged, readOnly: input.readOnly }).then(result => finalize(...))`——finalize 里：按 finish 三态 checkpoint（completed/cancelled）+ notify（`"subagent completed: {summary前200字}"` / `"subagent failed: {reason}"`）（决策 7 / 10）；异常兜底 `.catch` 也要走 failed 路径。
8. 立即返回 `{ sessionId: child.id, taskId: subagentId, status: 'running' }`。

**status(taskId)**：`getSubagent(taskId)` 不存在 → 抛 `NOT_FOUND`；返回决策 9 的结构 `{ status, sessionId, tasks, cost, error?, result?, auditLogs: 最近20条 }`；若 status='completed' 且 result 未被取走过 → 用 `collectSubagentResult` 语义（决策 7：父 AI 拿走即清理——**注意与 status 幂等性的取舍**：completed 后第一次 status 返回 result 并清理，之后返回 NOT_FOUND + 提示已清理。在代码注释写明此语义）。

**abort(taskId)**：记录不存在 → `NOT_FOUND`；已终态 → 返回当前状态（幂等）；running → `abortController.abort()`（executor 的 loop 检测点会收尾）+ 返回 `{ status: 'aborting' }`。

同时导出**模块级默认单例**与 `setRunnerDepsForTesting(deps)`（注释 `// test-only`）——core-tools 的 invoke 是无类上下文，用单例最简；`initSubagentRunner(deps)` 由 runtime 启动处调用装配（找到 extensions.ts 或 cli.ts 里 ExtensionService 的装配点，在旁边加一行初始化；**只加不改**）。

### Step 2：`src/core-tools.ts` 注册 3 个 builtin（决策 1 / 8 / 9 / 12）

照抄现有工具的 `add({ name, title, description, inputSchema, invoke })` 模式追加：

| 工具 | title | schema（决策 12） | invoke 要点 |
|------|-------|------|------|
| `subagent_start` | Start subagent | 决策 12 全字段（objective 必填；provider enum；其余可选） | ① `context.transport === 'subagent'` → `throw new MyTerminalError('FORBIDDEN', 'Subagents cannot start sub-subagents')`（决策 8 防线 A）② 需要 authenticatedSession（无 → IDENTITY_REQUIRED，与现有工具一致）③ settings.subagent.enabled === false → 抛错提示 ④ 调 runner.start，返回 `{ sessionId, taskId, status: 'running' }` |
| `subagent_status` | Subagent status | `{ taskId: string 必填 }` | 调 runner.status，返回决策 9 结构 |
| `subagent_abort` | Abort subagent | `{ taskId: string 必填 }` | 调 runner.abort |

description 文案写清"异步：start 立即返回 taskId，用 subagent_status 轮询；完成时会收到 message 通知"（教父 AI 正确使用姿势）。

### Step 3：`src/extensions.ts`——CONTROL_TOOLS + callSubagent()（决策 3 / 4）

1. `CONTROL_TOOLS` 追加 `'subagent_start'`、`'subagent_status'`、`'subagent_abort'`（防止被 200ms fast-return detach；走 touchControl 路径）。
2. 新增方法（对照 call() 实现，**严格按决策 4 表格裁剪**）：

```typescript
// ADR-0009 决策 4：trimmed 版 call——subagent child session 的通知通道
async callSubagent(input: JsonObject, context: InvocationContext): Promise<ToolResponse> {
  // 保留：accepting 检查 / authenticate（child identity）/ beginAudit + finishAudit
  //       beforeOrdinaryCall 或 touchControl（按 CONTROL_TOOLS 同一判断）
  //       invokeTool（同步 await，无 fast-return）
  // 跳过：assertContinuation / trackOperation + 200ms detach / completeContinuationCall
  //       decorateContinuation / attachEvents
  // transport 固定 'subagent'（M1 已加枚举），invocationContext 组装与 call() 同款
}
```

### Step 4：`src/mcp.ts` registerDirect ×3（决策：MCP 通道暴露）

在既有 registerDirect 区块尾部**追加**（zod schema 风格与邻居一致）：

```typescript
registerDirect('subagent_start', 'Start Subagent', 'Start a subagent for a sub-task. Asynchronous: returns taskId immediately; poll with subagent_status; completion arrives via message.', {
  objective: z.string().min(1),
  background: z.string().optional(),
  deliverables: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  provider: z.enum(['openai', 'anthropic', 'deepseek']).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
  timeoutSec: z.number().int().min(30).max(3600).optional(),
  readOnly: z.boolean().optional(),
}, safeLocalMutation);
registerDirect('subagent_status', 'Subagent Status', 'Query subagent progress, tasks, cost, and result.', { taskId: z.string().min(1) }, safeRead);
registerDirect('subagent_abort', 'Abort Subagent', 'Abort a running subagent.', { taskId: z.string().min(1) }, safeLocalMutation);
```

（`safeLocalMutation` / `safeRead` 用 mcp.ts 里既有常量名，若实际名字不同以现有代码为准。）

### Step 5：`src/openapi.ts`——toolInput properties 追加

找到 `ExtensionToolInput` / `toolInput` 的 properties 定义，**追加** subagent_start 的字段（objective/background/deliverables/acceptanceCriteria/constraints/provider/model/maxTurns/timeoutSec/readOnly）——风格照抄现有字段。`additionalProperties: true` 已存在，不破坏旧客户端。

### Step 6：`src/tui/screens/Subagents.tsx`——列表页（ADR-0008 决策 4）

- 参考 `Sessions.tsx` 的结构（列表 + 选中 + onSelect 进详情）。
- 数据源：**轮询**——subagent 状态在主进程内存（M2 store），TUI 与 executor 同进程，但 screens 组件不直接 import subagent store（保持 TUI 分层）——**方案**：通过 `runtime` 对象暴露的查询通道（在 TuiController 或 runtime facade 加一个 `listSubagents()` 只读方法，App.tsx 传入；**只加不改**），每 2s 轮询刷新 + 监听 `subagentEvents` 的 RUN_*/STATE_* 事件即时刷新。
- 卡片内容（ADR-0008 布局）：`subagentId + status`、`任务摘要（前 40 字）`、`进度：x/y 完成`、cost（USD）。status 着色复用 theme（running=进行中色 / completed=成功色 / failed=错误色 / aborted=警告色）。
- **遵守 TUI 避坑规则**（README 与记忆里的三条铁律）：可变长文本 `wrapMode="none"`；对齐用 flex；动态高度状态纳入 scrollKey。

### Step 7：`src/tui/screens/Subagent.tsx`——详情页（ADR-0008 决策 3）

- `useEffect` 订阅 `subagentEvents.on('ag-ui', handler)`，按 `subagentId` 过滤；**16ms 批量 flush**（ADR-0008 参考代码的 bufferRef 模式）防流式高频重渲染。
- 事件 → 渲染映射（ADR-0008 决策 3 表）：TEXT_MESSAGE_CONTENT 流式追加到消息气泡；TOOL_CALL_* 渲染工具面板（名称 + 参数摘要 + 结果截断 500 字符）；STATE_SNAPSHOT/DELTA 渲染任务进度；STEP_* 渲染轮次指示；RUN_* 渲染顶/底部状态条。
- 组件卸载必须 `subagentEvents.off('ag-ui', handler)`（防 listener 泄漏——50 个上限不是摆设）。

### Step 8：`src/tui/App.tsx`（+ BottomNav）接入 tab

1. import 两个新 screen；tab 索引尾部追加（如现有最大为 7，则 Subagents = 8）。
2. 渲染链追加 `tab === 8 ? <Subagents ... /> : ...`，详情态（`detail` 模式）渲染 `<Subagent subagentId={...} />`——**复用现有 detail 模式**（看 Sessions 详情怎么做的就怎么做）。
3. BottomNav 追加项（读 BottomNav 组件确认项定义方式）；键盘数字键/tab 循环若涉及索引上限，同步更新。
4. `switchTab` 里的硬编码索引（`index !== 7` 等）**不动**——新 tab 不需要那些特殊清理逻辑时就不加分支。

### Step 9：编写测试 `test/subagent-m8.test.mjs`

**Harness**：参考 `test/myterminal.test.mjs` 构造 ExtensionService + 主 store 的方式（临时 config 目录 + 临时 workspace）；`setRunnerDepsForTesting` 注入 fake `runSubagentImpl`（脚本化：可控制"立即完成 / 挂起直到手动 resolve / 立即失败"）。**≥ 14 用例**：

**runner 单测**：
1. start 成功：返回 `{ sessionId, taskId, status: 'running' }`；主 store 里 child session 存在且 parent 正确；M2 store record 为 running。
2. 并发限制（决策 11）：maxParallel=2，两个挂起中的 subagent 后第 3 个 start → 错误含 `Max parallel subagents reached (2)`。
3. 完成通知链（决策 7）：fake 立即完成 → 等一个 tick → child checkpoint(phase='completed') 被调 + parent 收到 message（用主 store 的 message_inbox 验证）。
4. 失败通知链（决策 10）：fake 立即失败 → checkpoint(cancelled) + parent message 含 `failed`。
5. status 结构（决策 9）：running 时 `{ status, tasks, cost }`；completed 后含 result；**取走即清理**——第二次 status → NOT_FOUND。
6. abort：挂起的 subagent → abort 返回 aborting → fake 收到 signal abort → 终态 aborted + parent 收到通知。
7. 配置合并：input.model 覆盖 settings.model；未传用 settings 默认（fake 断言收到的 settings）。

**core-tools / extensions 集成**：
8. 递归防护（决策 8 防线 A）：以 `transport: 'subagent'` 调 `subagent_start` → FORBIDDEN。
9. 防线 B 验证：`getAllToolSchemas()`（M4）中**不含** subagent_start/status/abort。
10. CONTROL_TOOLS 行为：`extension.call({ tool: 'subagent_status' })` 同步返回（不被 fast-return detach——返回值无 `taskId` 包装层，直接是 status 结构）。
11. **callSubagent trimmed 语义**（决策 4）：用 child identity 调 `callSubagent({ tool: 'message_send' })` → 同步完成、历史有审计记录、response **不带** continuation 装饰（无 mustContinue/nextCall）、**不触发** 200ms detach。
12. enabled=false：settings.subagent.enabled 关掉后 subagent_start 报错。

**MCP / OpenAPI schema**：
13. `dist/mcp.js` 的工具列表（或 schema 导出）含 3 个新工具名；`dist/openapi.js` 的 toolInput properties 含 objective 字段。

**端到端集成（本任务的毕业考）**：
14. **完整生命周期**：root session register → `extension.call(subagent_start)`（fake runner 挂起）→ status=running → fake 手动 resolve 完成 → 下一个任意 call 的 response events 里出现 message 通知（attachEvents 被动轮询，决策 7 第 2 层）→ `subagent_status` 拿到 completed + result + cost → root 调 `session_checkpoint(phase=completed)` 成功（child 已 terminal，CHILD_REVIEW_REQUIRED 通过，决策 7 第 3 层）。
15. **TUI 冒烟**：参考 `test/tui-redesign-m*.test.mjs` 的渲染测试手法，渲染 `<Subagents />`（注入 2 个 fake subagent 状态）断言列表文本出现；向 `subagentEvents` 发事件断言详情页出现对应文本。

### Step 10：覆盖率 + 变异测试

`bun test --coverage test/subagent-m8.test.mjs` ≥ 70%。

**变异体清单**：

| # | 变异体 | 杀死它的测试 |
|---|--------|-------------|
| 1 | 并发上限比较 `>=` 改 `>` | 用例 2 |
| 2 | 递归防护删掉 transport 检查 | 用例 8 |
| 3 | callSubagent 里加回 attachEvents | 用例 11 |
| 4 | 完成时不发 message_send | 用例 3 |
| 5 | status "取走即清理"删掉（completed 永远可查） | 用例 5 |
| 6 | CONTROL_TOOLS 不加 subagent_status（被 detach） | 用例 10 |
| 7 | enabled=false 不拦截 | 用例 12 |

### Step 11：全量回归 + 手工冒烟

1. `bun run test` 全量 0 fail（含 M1-M7 全部新增 + 现有 178 项）。
2. `bun run typecheck` 0 errors。
3. 手工冒烟（如有真实 API key）：`OPENAI_API_KEY=... bun run dev`，TUI 里确认 Subagents tab 出现；通过 Actions 通道 `session_register` + `subagent_start` 一个 readOnly 小任务（如"列出 src 下的文件"），观察 Subagents 页实时事件流。**无 key 则跳过并在交付说明中标注 REQUIRES-HUMAN。**

## 五、验收清单（DoD）

- [ ] 在 `feat/skills` 分支；M1-M7 产物在位
- [ ] runner 三操作 + delegate 复用 + 通知三层 + 并发限制 + 配置合并
- [ ] 3 个 builtin 注册（递归防护 FORBIDDEN）；CONTROL_TOOLS 追加；callSubagent trimmed 按决策 4 表格
- [ ] mcp.ts ×3 registerDirect；openapi.ts properties 追加；TUI tab 尾部追加不碰硬编码索引
- [ ] TUI 两页面符合避坑三规则；listener 卸载清理
- [ ] 测试 ≥ 15 用例全过（含用例 14 端到端）；覆盖率 ≥ 70%；变异体 7/7 被杀死
- [ ] `bun run typecheck` 0 errors；`bun run test` 全量 0 fail
- [ ] 未提交 git commit

## 六、最终交付说明（本任务是最后一棒）

交付总结中额外包含：
1. **全系统文件清单**：M1-M8 新建/修改的所有文件 + 行数汇总（对照 README 第四节总表）。
2. **ADR 决策落地核对表**：0007 的 40 项 / 0008 的 4 项 / 0009 的 14 项，逐项标注"已落地 / 偏差 + 理由 / REQUIRES-HUMAN"。
3. **已知限制清单**：如权限冒泡到父 UI 未做、磁盘持久化未做、TUI 真实终端渲染需人工验证等。
4. **REQUIRES-HUMAN 清单**：真实 API key 冒烟、真实终端渲染、Windows 平台验证。
