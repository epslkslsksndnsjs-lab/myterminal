# M5：工具执行器（tool-executor.ts）——并行调度 + 两层校验 + 审计

> ⚠️ **开始前先执行 `git branch --show-current`，确认当前在 `feat/skills` 分支，不要在 `main`（主分支）上开发。** 输出不是 `feat/skills` 就立即停止报告。同时确认 M1-M4 已验收通过。

- **任务目标**：实现工具调用的"调度中枢"——把 LLM 一轮返回的多个 tool_use 按并发安全性分批执行，串行/并行自动判断，执行前后做两层输入校验、权限检查、hooks、审计日志，崩溃时包装成 tool_result 不炸 agent loop。
- **ADR 依据**：ADR-0007 决策 18（并行执行 + sibling abort）、决策 19（消息组预算）、决策 30 Bug 4（sibling abort 位置修正）、决策 31（isConcurrencySafe 函数求值）、决策 37（配对保证的执行端）、决策 38（两层校验）、决策 39（审计日志）、决策 40（hooks 执行点）。
- **前置依赖**：M3（`ToolResult` 类型 / `enforceMessageBudget` / `ensureNonEmpty`）、M4（`getTool` / `SubagentTool` / `SubagentToolContext`）、M2（store 的 `addAuditLog`）。
- **产出**：新建 `src/subagent/tool-executor.ts`；新建 `test/subagent-m5.test.mjs`。预估 ~300 行。
- **覆盖率门槛**：**核心级 ≥ 90%**（调度逻辑分支密集，必须全覆盖）。

---

## 一、必读材料

1. `deliverables/subagent-handoff/README.md`
2. `docs/adr/0007-subagent-executor.md`：「4. 工具并行执行器」整节参考代码 + 决策 18 / 30 Bug 4 / 38 / 39 / 40
3. M3 / M4 交付总结（`ToolResult` 导出路径、工具签名）
4. `src/types.ts` 的 `JsonObject` / `JsonSchema` 定义

## 二、铁律

- **Bug 4 修复**：sibling abort 在**并行批次**（一个失败取消正在跑的兄弟），串行批次保留"链中断"（写工具失败后跳过后续调用）——不许照抄 ADR「4. 工具并行执行器」参考代码里把 sibling abort 放串行批次的旧版。
- `isConcurrencySafe` 可能是函数——**求值时机在分区时**（用实际 input 调用函数）。
- **结果顺序必须等于调用顺序**（决策 18：不打乱）——并行批次的 `Promise.all` 结果要映射回原始 index。
- 校验顺序固定：schema → validateInput → checkPermissions → pre-hooks → 执行 → post-hooks → 审计。任何一步失败都要返回 `is_error: true` 的 ToolResult 并**写审计日志**，不许直接 throw。
- `ToolResult` 类型**必须 import 自 `result-budget.js`**（M3 定义），禁止重复定义。
- AG-UI 事件：本模块接受 `onEvent` 回调参数并发出 `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_RESULT`（ADR-0008 决策 1），但**不 import tui-bridge**——onEvent 由 M7 executor 注入（M5 测试里传 noop 或收集数组的 fake）。

## 三、分步实施

### Step 1：轻量 schema 校验器（决策 38）

在 `tool-executor.ts` 内实现（或拆 `src/subagent/schema-validator.ts`，二选一，注释说明选择）：

```typescript
type SchemaError = { path: string; message: string };

function validateSchema(input: JsonObject, schema: JsonSchema): { ok: boolean; errors: SchemaError[] } {
  // 只校验：required 缺失 / type 不匹配（string/number/boolean/object/array）/ enum 越界 / minLength
  // 不实现完整 JSON Schema——4 类校验足够（不许引入 ajv）
}

function formatSchemaError(errors: SchemaError[], toolName: string): string {
  // LLM 友好格式（决策 38）：
  // "The required parameter 'path' is missing"
  // "The parameter 'command' type is expected as 'string' but provided as 'number'"
  // 多个错误用换行连接
}
```

### Step 2：分批算法 `partitionToolCalls`（决策 18 + 31）

```typescript
export type ToolCall = { id: string; name: string; input: JsonObject };
type Batch = { isConcurrencySafe: boolean; calls: ToolCall[] };

const MAX_PARALLEL = 5;  // 决策 18：并行度上限

export function partitionToolCalls(calls: ToolCall[]): Batch[] {
  // 对每个 call：const tool = getTool(call.name)
  //   未知工具 → 单独一个非并发批次（执行时报 Unknown tool）
  //   isConcurrencySafe 是函数 → 用 call.input 求值；是布尔 → 直接用
  // 从队头扫描：连续并发安全的收进当前并发批次（满 MAX_PARALLEL 开新批）；
  //   遇到非并发 → 断批，该 call 单独成批（独占执行）
}
```

**边界必须正确处理**（全是变异点）：队首就是非并发 / 连续两个非并发 / 并发批恰好满 5 第 6 个并发开新批 / 未知工具插在并发段中间要断批。

### Step 3：单工具执行 `executeSingleTool`（决策 38 + 39 + 40）

```typescript
async function executeSingleTool(
  call: ToolCall,
  ctx: SubagentToolContext,
  onEvent: (event: { type: string; data?: unknown }) => void,
  siblingSignal?: AbortSignal,
): Promise<ToolResult> {
  // 审计骨架：startTime 先记
  // ① 未知工具 → is_error "Unknown tool: X"
  // ② validateSchema 失败 → is_error formatSchemaError(...)（errorType: 'schema_validation'）
  // ③ tool.validateInput?.(input, ctx) 失败 → is_error（errorType: 'schema_validation'）
  // ④ tool.checkPermissions?.(input, ctx) === 'deny' → is_error
  //    "Permission denied for tool \"X\" — command blocked by safety rules."（errorType: 'permission_denied'）
  // ⑤ preToolUseHooks 逐个执行：blockExecution → is_error；modifiedInput → 替换 call.input
  // ⑥ onEvent TOOL_CALL_START / TOOL_CALL_ARGS
  // ⑦ 执行：siblingSignal 存在时 execCtx.signal = AbortSignal.any([ctx.signal, siblingSignal])
  // ⑧ postToolUseHooks 逐个执行：modifiedResult → 替换结果
  // ⑨ onEvent TOOL_CALL_RESULT；结果 JSON.stringify；is_error = result.is_error === true
  // ⑩ catch 任何异常 → "Tool execution failed: {message}"（errorType: 'execution_error'）——不炸 loop
  // ⑪ 写审计日志 addAuditLog(ctx.agentId, log)（input 截 1000 字符、errorMessage 截 500、记 resultSizeChars）
}
```

### Step 4：批量执行 `executeToolCalls`（决策 18 + Bug 4 修复）

```typescript
export async function executeToolCalls(
  calls: ToolCall[],
  ctx: SubagentToolContext,
  onEvent: (event: { type: string; data?: unknown }) => void,
): Promise<ToolResult[]> {
  const batches = partitionToolCalls(calls);
  const results: ToolResult[] = new Array(calls.length);

  for (const batch of batches) {
    if (batch.isConcurrencySafe && batch.calls.length > 1) {
      // ── 并行批次（Bug 4 修复：sibling abort 在这里）──
      const siblingController = new AbortController();
      const batchResults = await Promise.all(
        batch.calls.map(call =>
          executeSingleTool(call, ctx, onEvent, siblingController.signal)
            .then(r => {
              // 并行兄弟失败 → 取消其余（已完成的自然完成，未开始的在 signal 检查点退出）
              if (r.is_error) siblingController.abort('sibling_error');
              return r;
            }),
        ),
      );
      // 映射回原始 index（结果顺序 = 调用顺序）
    } else {
      // ── 串行批次（含独占工具）──
      for (const call of batch.calls) {
        const result = await executeSingleTool(call, ctx, onEvent);
        results[calls.indexOf(call)] = result;
        // 串行链中断：写工具（isReadOnly=false）失败 → 后续调用不再执行
        // 被中断的 call 也要填结果：{ content: 'Skipped: previous tool failed', is_error: true }
        if (result.is_error && getTool(call.name)?.isReadOnly === false) {
          // 为剩余 calls 填 Skipped 结果后 break
        }
      }
    }
  }

  // 决策 19：消息组预算（enforceMessageBudget 已是 Bug 1 修复版）
  const budgeted = enforceMessageBudget(results);
  // 决策 19：空结果保护
  budgeted.forEach(r => { r.content = ensureNonEmpty(r.content, 'tool'); });
  return budgeted;
}
```

**注意 `calls.indexOf(call)` 的对象引用前提**：partition 不复制 call 对象（保持引用），indexOf 才可靠；若你在 partition 里复制了对象，改用显式 index 映射。注释写明选择。

### Step 5：编写测试 `test/subagent-m5.test.mjs`

用 M4 的真实注册表（8 个工具都在）+ 临时目录 ctx；onEvent 用数组收集。**≥ 18 用例**：

**schema 校验**：
1. 缺 required → `"The required parameter 'path' is missing"`。
2. 类型错（`{ command: 123 }`）→ `"type is expected as 'string' but provided as 'number'"`。
3. enum 越界（task_update 的 `status: 'done'`）→ 报错含 enum 信息。
4. edit_file `old_string: ''` → minLength 校验拦截。

**分批算法**（纯函数，直接构造 ToolCall 数组测）：
5. 3 个 read_file → 1 个并发批（3 个 call）。
6. 7 个 read_file → 2 个并发批（5+2，MAX_PARALLEL 边界）。
7. read→write→read → 3 批（并发段被独占工具断开）。
8. 未知工具插在两个 read 中间 → 并发段断开 + 未知工具单独成批。
9. execute_cli 的 `ls`（函数求值 true）和 read_file 同批并发；execute_cli 的 `rm x`（false）独占。

**执行语义**：
10. 并行批次结果顺序 = 调用顺序（构造 3 个耗时不同的 read_file，断言结果 index 对应）。
11. **Bug 4 回归**：并行批次中一个 read_file 指向不存在文件（is_error）→ sibling abort 触发（断言 siblingController 语义：已开始的兄弟收到 abort 信号或已完成——用两个慢文件 + 一个必失败文件，断言至少一个兄弟的结果含 aborted/skipped 或正常完成，核心是**不错误地把 abort 放串行批次**；注释说明断言策略）。
12. 串行链中断：write_file（成功）→ edit_file 未先读（失败）→ 后续 write_file 被 Skipped（结果含 `Skipped` 且 is_error）。
13. 权限拒绝：execute_cli `sudo rm x` → is_error + `Permission denied` + 审计日志 errorType='permission_denied'。
14. 工具崩溃包装：构造一个 call 会 throw 的场景（如 glob 传非法 pattern 触发内部异常，或临时注册一个 throw 工具到 registry）→ 返回 `Tool execution failed: ...` 不炸 `executeToolCalls`。
15. 审计日志完整字段：成功 + 失败各一条，断言 durationMs ≥ 0、success 布尔、resultSizeChars、input 截断。
16. hooks：注册 pre-hook `blockExecution` → 工具未执行且 is_error；`modifiedInput` → 实际执行用修改后 input；post-hook `modifiedResult` → 结果被替换。
17. `enforceMessageBudget` 集成：一轮 5 个大结果（各 60K）→ 总 300K 超 200K → 最大的被压缩 + 冻结标记。
18. `ensureNonEmpty` 集成：构造空输出工具（如 `execute_cli` 跑 `true` 命令无输出）→ content 非空。
19. **集成用例**：模拟 LLM 一轮混合调用（glob + read_file ×2 并行 → edit_file 独占 → task_update），断言全部结果按序返回、审计日志 5 条、事件流 TOOL_CALL_START/RESULT 成对出现。

### Step 6：覆盖率 + 变异测试

`bun test --coverage test/subagent-m5.test.mjs` **≥ 90%**。

**变异体清单**：

| # | 变异体 | 杀死它的测试 |
|---|--------|-------------|
| 1 | `MAX_PARALLEL` 5 改 6 | 用例 6 |
| 2 | 并行批次不映射回原始 index（按完成顺序填） | 用例 10 |
| 3 | sibling abort 移回串行批次（Bug 4 复现） | 用例 11 |
| 4 | 串行链中断删掉（失败后继续执行） | 用例 12 |
| 5 | 校验顺序颠倒（checkPermissions 在 schema 之前） | 用例 1+13 组合（sudo 且缺参数时应报 schema 错） |
| 6 | `AbortSignal.any` 换成只用 siblingSignal（丢父 signal） | 用例 11 的变体 + 人工审查 |
| 7 | 审计日志不写 | 用例 15 |
| 8 | isConcurrencySafe 函数不求值（直接当真值处理） | 用例 9 |

### Step 7：全量回归

`bun run test` 全量 0 fail。

## 四、验收清单（DoD）

- [ ] 在 `feat/skills` 分支；M1-M4 产物在位
- [ ] Bug 4 修复：sibling abort 在并行批次；串行链中断给后续 call 填 Skipped 结果
- [ ] 校验顺序 schema → validateInput → checkPermissions → hooks → 执行 → 审计，逐级短路
- [ ] 结果顺序 = 调用顺序；`ToolResult` import 自 result-budget
- [ ] onEvent 发 TOOL_CALL_START/ARGS/RESULT，不 import tui-bridge
- [ ] 测试 ≥ 19 用例全过；**覆盖率 ≥ 90%**；变异体 8/8 被杀死
- [ ] `bun run typecheck` 0 errors；`bun run test` 全量 0 fail
- [ ] 未提交 git commit

## 五、交接给 M7

1. `executeToolCalls(calls, ctx, onEvent)` 签名——M7 executor 的 agent loop 每轮调用它。
2. onEvent 的事件结构（`{ type, data }`）——M7 注入 tui-bridge 的 emit 时要做的字段映射。
3. 审计日志写入 M2 store 的确切函数——M7 executor 失败时也要写"系统级"审计条目（如 LLM API 错误）。
