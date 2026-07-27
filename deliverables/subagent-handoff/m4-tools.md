# M4：工具系统（tools.ts + grep-utils.ts）——8 个 subagent 工具

> ⚠️ **开始前先执行 `git branch --show-current`，确认当前在 `feat/skills` 分支，不要在 `main`（主分支）上开发。** 输出不是 `feat/skills` 就立即停止报告。同时确认 M1-M3 已验收通过（M3 的 permissions/result-budget 是本任务的依赖）。

- **任务目标**：实现 subagent 的完整工具层——`SubagentTool` 接口（10 字段）、`buildTool` 工厂、注册表、8 个工具实现、grep 引擎。**这是 subagent 的"手"，LLM 通过这些工具干活。**
- **ADR 依据**：ADR-0007 决策 3 / 4（8 工具清单）、决策 13（接口 + 注册表）、决策 23（ToolContext）、决策 26（file-state 集成）、决策 30（Bug 2/3 修复）、决策 31（接口增强 10 字段）、决策 33（忽略模式）、决策 34（条数截断）、决策 35（二进制检测）、决策 36（edit_file 增强）、决策 40（hooks 预留）。
- **前置依赖**：M2（file-state / shell-tracker / store）、M3（permissions / result-budget）。
- **产出**：新建 `src/subagent/tools.ts`、`src/subagent/grep-utils.ts`；新建 `test/subagent-m4.test.mjs`。预估 ~700 行（最大模块）。
- **覆盖率门槛**：组件级 ≥ 70%（但 8 个工具的每个 `call` 主路径必须有测试）。

---

## 一、必读材料

1. `deliverables/subagent-handoff/README.md`
2. `docs/adr/0007-subagent-executor.md`：**「工具系统完整实现」整节**（接口/工厂/注册表/8 工具/路径安全的全部参考代码）+ 决策 30-36 的修正点
3. M2 交付总结（file-state / shell-tracker / store 的函数签名）
4. M3 交付总结（`checkCommandSafety` / `isCommandConcurrencySafe` / `interpretExitCode` / `truncateResult` 签名）
5. `src/core-tools.ts` 的 `IGNORED_DIRECTORIES`——**忽略目录清单与现有代码对齐**（`.git`、`.myterminal`、`node_modules`、`dist`、`coverage`、`.next`、`.turbo`），保持一致，不要自创清单

## 二、铁律

- 工具**不绑 session/transport/workspace**（决策 3）——`SubagentToolContext` 只有 `cwd` / `signal` / `agentId` / hooks。
- 返回值**不带** sha256/bytes/stateRevision 等内部字段（决策 3）。
- 所有路径必须过 `resolvePath`（防目录穿越，决策 4）。
- **Bug 2 修复**：`task_create` / `task_update` 的 `isReadOnly: true`（决策 30——任务存储不是文件系统）。
- **Bug 3 修复**：`edit_file` 的 inputSchema 必须含 `replace_all?: boolean`，错误消息里提到 replace_all 时 schema 必须真有这个参数。
- 不做 `session_*` / `message_*` / `skill_*` / `run_tests` 工具（决策 4「不包含」清单）。
- 本任务**不做并行执行**（那是 M5）——本任务只保证每个工具 `call` 单独正确。

## 三、分步实施

### Step 1：`tools.ts`——接口与上下文（决策 13 + 23 + 31 + 40）

```typescript
import type { JsonObject, JsonSchema } from '../types.js';  // 复用现有类型，若 types.ts 没有则用结构等价定义

// ADR-0007 决策 23 + 40
export type SubagentToolContext = {
  cwd: string;
  signal: AbortSignal;
  agentId: string;
  preToolUseHooks?: ToolHook[];   // 决策 40：v1 空数组，接口预留
  postToolUseHooks?: ToolHook[];
};

export type ValidationResult = { ok: boolean; message?: string };

// ADR-0007 决策 31：10 字段接口
export type SubagentTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  call(input: JsonObject, ctx: SubagentToolContext): Promise<JsonObject>;
  isReadOnly: boolean;
  isConcurrencySafe: boolean | ((input: JsonObject) => boolean);  // 决策 31：函数化
  maxResultSizeChars: number;
  checkPermissions?(input: JsonObject, ctx: SubagentToolContext): 'allow' | 'deny';
  prompt?(ctx: SubagentToolContext): string;         // 详细使用指南（v1 可选，M7 system prompt 用）
  validateInput?(input: JsonObject, ctx: SubagentToolContext): ValidationResult;
  isDestructive?(input: JsonObject): boolean;
  isEnabled?(ctx: SubagentToolContext): boolean;
};

// 决策 40
export type ToolHook = {
  name: string;
  before?(input: JsonObject, ctx: SubagentToolContext): Promise<HookResult | void>;
  after?(result: JsonObject, ctx: SubagentToolContext): Promise<HookResult | void>;
};
export type HookResult = {
  modifiedInput?: JsonObject;
  blockExecution?: boolean;
  modifiedResult?: JsonObject;
  additionalContext?: string;
};
```

### Step 2：`tools.ts`——buildTool 工厂 + 注册表（决策 13 + 31）

按 ADR「2. buildTool 工厂 + 注册表」参考代码实现，补充：
- 校验：name/description/inputSchema 必填（缺失抛 `Error`）。
- 默认值：`maxResultSizeChars ?? 50_000`；`isConcurrencySafe ?? （跟随 isReadOnly）`（决策 31：未传函数时默认跟随 isReadOnly）。
- `toolRegistry: Map<string, SubagentTool>` + `getTool(name)` + `getAllToolSchemas()` + `getToolNames({ readOnly })`——**readOnly 模式过滤**（决策 17 第 1 层）：readOnly=true 时只返回 `isReadOnly: true` 的工具（read_file/glob/grep/task_create/task_update）。

### Step 3：`tools.ts`——路径安全（决策 4）

按 ADR「6. 路径安全」参考代码实现 `resolvePath(path, cwd)`：绝对路径直接用、相对路径 resolve 到 cwd；`relative(cwd, resolved)` 以 `..` 开头 → 抛 `Error('Path ... is outside working directory ...')`。另实现 `fileExists`、`generateDiffPreview`（ADR 有参考代码）。

### Step 4：`tools.ts`——8 个工具实现

**逐个对照 ADR「3.x」参考代码实现**，并叠加决策 30-36 的修正。每个工具的 inputSchema 的 `description` 文本照抄 ADR（LLM 友好）。要点清单：

| # | 工具 | 关键实现点（全部必须） |
|---|------|----------------------|
| 3.1 | `execute_cli` | `spawn(command, { cwd, shell: true, signal, detached: true, timeout })`；`trackShellTask(ctx.agentId, child)`；stdout/stderr 累积 + `truncateResult`；`interpretExitCode` 决定 `is_error`（决策 32）；`checkPermissions` 调 `checkCommandSafety(command, readOnlyFromCtx)`——readOnly 从哪来？见下方备注；`isConcurrencySafe` 为**函数**：`(input) => isCommandConcurrencySafe(input.command)` |
| 3.2 | `read_file` | 带行号格式（`N\t内容`）；offset/limit（默认 1/2000）；**二进制扩展名拒绝**（决策 35，BINARY_EXTENSIONS 清单照抄 ADR）；**目录/不存在错误区分**（决策 35 三种文案）；`recordFileRead`；`truncateResult` |
| 3.3 | `write_file` | `mkdir(dirname, { recursive: true })`；返回 `{ action: 'created'\|'overwritten', lines, path }`；写后 `recordFileRead` 同步缓存（决策 26） |
| 3.4 | `edit_file` | inputSchema 含 `old_string`（`minLength: 1`）+ `new_string` + `replace_all?: boolean`（Bug 3 修复）；`validateEdit` 三重检查（M2 实现）；replace_all 用 `split().join()`；返回 `{ success: true, diff }`（diff 用 `generateDiffPreview`） |
| 3.5 | `glob` | `IGNORE_PATTERNS`（与 `core-tools.ts` 的 IGNORED_DIRECTORIES 对齐 + `build/`、`.cache/`）；**返回相对路径**（决策 33）；**MAX_RESULTS = 200 + truncated 标记 + header**（决策 34：`Found N files (showing first 200). Refine your pattern...`）；排序稳定 |
| 3.6 | `grep` | 调 `createGrep`（Step 5）；返回 `file:line:text` 格式；`maxMatches = 200` 截断 + header 报告真实总数（决策 34："grep 同理"）；`truncateResult` 兜底 |
| 3.7 | `task_create` | id 生成 `task_${Date.now().toString(36)}${随机}`；任务存 M2 store 的 `syncTasks`；**`isReadOnly: true`（Bug 2 修复）**；返回 `{ task: { id, subject } }` |
| 3.8 | `task_update` | **状态机校验**（pending→in_progress→completed，非法转换报 `Invalid transition: A → B`）；**allDone 自动清空**（教程 s27：全部 completed 后清空列表并返回 `{ allDone: true, message: 'All tasks completed, list cleared' }`）；**`isReadOnly: true`（Bug 2 修复）** |

**关于 execute_cli 的 readOnly 来源**：`SubagentToolContext` 加一个可选字段 `readOnly?: boolean`（M7 executor 启动时按 subagent_start 参数注入；缺省 false）。`checkCommandSafety(command, ctx.readOnly ?? false)`。在 Step 1 的接口里补上这个字段并注释（这是 ADR 决策 17 的落地通道，ADR 参考代码漏了它，实现必须补上——这不是发挥，是决策 17 第 1 层的必要支撑）。

**工具注册**（文件底部）：8 个 `toolRegistry.set(...)` + `getAllToolSchemas()` 返回 `[{ name, description, input_schema }]`。

### Step 5：`grep-utils.ts`——grep 引擎（决策 33 + 34）

实现 `createGrep(pattern: string, searchDir: string, opts: { include?: string; maxMatches?: number }): Promise<{ results: Array<{ path, line, text }>; totalMatches: number; truncated: boolean }>`：
- 递归遍历 searchDir，跳过 `IGNORE_PATTERNS`（与 glob 同清单）；正则用 `new RegExp(pattern)`（非法正则抛错信息要友好：`Invalid regex pattern: ...`）。
- `include`（如 `*.ts`）用简单的 glob→regex 转换（`*` → `[^/]*`、`**` → `.*`、`?` → `.`），不许引库。
- 收集到 `maxMatches`（默认 200）即停止遍历，但**继续统计 totalMatches**（或标注 `totalMatches` 为已扫描范围内的精确值 + `truncated: true`——二选一，注释写明语义，测试对齐）。
- 返回**相对 searchDir 的路径**。

### Step 6：编写测试 `test/subagent-m4.test.mjs`

用临时目录（`fs.mkdtempSync`）造文件树，每个工具的真实文件操作都跑真文件（不 mock fs）。**≥ 24 用例**：

**接口/工厂/注册表**：
1. buildTool 缺 name/description/inputSchema 分别抛错。
2. 默认值推导：不传 isConcurrencySafe 时跟随 isReadOnly；传函数时保留函数。
3. `getToolNames({ readOnly: true })` 只含 5 个只读工具（Bug 2 回归：task_create/task_update 在列）。
4. `getAllToolSchemas()` 返回 8 个 schema，edit_file 的 schema 含 `replace_all`（Bug 3 回归）。

**execute_cli**（用真实 `spawn`，测试上下文 `ctx = { cwd: tmpDir, signal: new AbortController().signal, agentId: 'test-agent' }`）：
5. `echo hello` → stdout 含 hello、exitCode 0、非 is_error。
6. `grep nonexistent file`（造空文件）exit 1 → **非 is_error** + message 提示无匹配（决策 32）。
7. `ls; rm -rf /` → checkPermissions deny（M3 集成，真实走 `getTool('execute_cli').checkPermissions`）。
8. 大输出截断：`node -e "console.log('x'.repeat(60000))"` → stdout 被 truncateResult 截断 + 尾部标记。
9. `isConcurrencySafe` 函数：`ls` → true；`rm x` → false（决策 31 函数化）。

**read_file / write_file / edit_file**：
10. read_file 带行号格式（`1\t` 开头）+ totalLines/startLine/endLine 正确。
11. read_file 二进制（造 `x.png` 写任意字节）→ 拒绝 + 文案含 `binary file`。
12. read_file 目录路径 → 拒绝 + 文案含 `is a directory`；不存在 → 文案含 `File not found`。
13. write_file 新文件 → `action: 'created'` + 自动建父目录；再写 → `'overwritten'`。
14. edit_file 未先读 → 拒绝（M2 file-state 集成）。
15. edit_file 先读后改成功，diff 预览含 `-`/`+` 行；replace_all 全替换（造 3 处匹配）。
16. edit_file `old_string: ''` → schema 层就有 `minLength: 1`（断言 schema）+ validateEdit 不崩。
17. resolvePath 防穿越：`read_file` 传 `../../etc/passwd` → 抛错/拒绝。

**glob / grep**：
18. glob `**/*.ts` 排除 node_modules/dist（造目录验证）+ 返回相对路径。
19. glob 超 200 个文件 → 只回 200 条 + `truncated: true` + header 含真实总数。
20. grep 命中返回 `file:line:text`；无命中 → matchCount 0（非 is_error）。
21. grep 非法正则 → 友好错误；include `*.ts` 过滤生效。

**task_create / task_update**：
22. create → 返回 id/subject；M2 store 里能查到。
23. update 状态机：pending→completed 直接跳 → `Invalid transition`；正常流转成功。
24. 全部 completed → 返回 `allDone: true` + 列表清空。
25. **集成用例**：模拟 LLM 一轮操作序列——glob 找文件 → read_file ×2 → edit_file → task_create → task_update → execute_cli 验证，全链路真文件真进程跑通。

### Step 7：覆盖率 + 变异测试

`bun test --coverage test/subagent-m4.test.mjs` ≥ 70%（8 个工具的 call 主路径必须全有测试）。

**变异体清单**：

| # | 变异体 | 杀死它的测试 |
|---|--------|-------------|
| 1 | `MAX_RESULTS` 200 改 201 | 用例 19 |
| 2 | glob 忽略清单删掉 `node_modules` | 用例 18 |
| 3 | task_update 状态机允许 pending→completed | 用例 23 |
| 4 | edit_file 的 replace_all 用 `replace`（单次）而非 `split().join()` | 用例 15 |
| 5 | read_file 二进制检测删掉 | 用例 11 |
| 6 | execute_cli 的 `detached: true` 删掉 | 用例 5 的进程组检查（或人工验证，说明方式） |
| 7 | resolvePath 删掉 `..` 检查 | 用例 17 |
| 8 | allDone 自动清空删掉 | 用例 24 |

### Step 8：全量回归

`bun run test` 全量 0 fail。

## 四、验收清单（DoD）

- [ ] 在 `feat/skills` 分支；M1-M3 产物在位
- [ ] `SubagentTool` 10 字段接口 + ctx 含 `readOnly?` + hooks 预留
- [ ] 8 工具全部实现，Bug 2（task isReadOnly）/ Bug 3（replace_all）修复落地
- [ ] 决策 33（忽略清单与 core-tools 对齐）/ 34（200 截断 + header）/ 35（二进制 + 错误区分）/ 36（minLength + 预览）全部落地
- [ ] 测试 ≥ 25 用例全过；覆盖率 ≥ 70%；变异体 8/8 被杀死
- [ ] `bun run typecheck` 0 errors；`bun run test` 全量 0 fail
- [ ] 未提交 git commit

## 五、交接给 M5 / M7

1. `getTool` / `getAllToolSchemas` / `getToolNames({ readOnly })` 签名——M5 执行器、M7 executor（readOnly 过滤 + system prompt 的 tools 清单）用。
2. 各工具 `call` 的返回结构（M5 包 tool_result 时按原样 JSON.stringify）。
3. `prompt()` 字段本任务是否为某些工具实现了使用指南？（v1 可不实现，但要在交接中明确，M7 组 system prompt 时决定兜底文案。）
