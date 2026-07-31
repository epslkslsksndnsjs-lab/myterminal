# 对 VERIFY-ALL-11.md 的复核裁决（#70 门禁）

复核方：#70 审查会话｜基准：main `09f2246` vs seams `0821a7d`｜方法：`git show` 基线对照 + 可执行探针

## 裁决总表

| 项 | 我的原判 | VERIFY-ALL-11 的反驳 | **复核裁决** |
|---|---|---|---|
| #1 白屏 | 真 | 真（严重性中低） | **维持：真**。分歧仅在严重性 |
| **#2a** extension_call 放宽 | **真** | **假（称 main 本就 z.record 全通）** | **反驳不成立 —— 我方维持。探针 6/8 用例行为不一致** |
| #2b claimCode minLength | 真 | 假（main 已有 minLength） | **我方撤回**，反驳成立 |
| #3 #34 只收 5/7 | 真 | 真 | 维持：真 |
| #4 #31 字面量锁 | 观察 | 有意为之非缺陷 | 接受：非缺陷，属公平观察 |
| #5 #66 夹带文档 | 5 份/337 行 | 实为 8 份/~709 行 | **接受并加重**：比我说的更严重 |
| #6 useTimelineModel 签名 | 真 | 假（签名未变） | **我方撤回**，反驳成立 |
| #7 codemod 永久提交 | 真 | 真 | 维持：真 |
| #8 缓存按引用返回 | 真 | 真（低风险） | 维持：真 |
| #9 注释与代码打架 | 真 | 真 | 维持：真 |
| #10 withAudit flag 参数化 | 真 | 假（ADR 否决的是 #44 god 方法） | **我方撤回**，反驳成立 |
| #11 三份级联含 state.ts | 真 | 部分（实为 2 份且都在 controller-logic） | **我方部分撤回**：重复属实，"三份/state.ts"不成立 |

## 关键分歧：#2a 的实证推翻

VERIFY-ALL-11.md §#2 称「main（`09f2246:src/mcp.ts:161`）extension_call 的 input 已是
`extensionToolInput = z.record(z.string(), z.unknown())`（mcp.ts:34），**main 本来就是全通**」。

**该陈述把 seams 的行号/代码当成了 main 的。** 实际基线：

- **main `09f2246:src/mcp.ts:25`**：`z.object({ ...44 个带类型字段... }).catchall(z.unknown())`
- **seams `0821a7d:src/mcp.ts:34`**：`z.record(z.string(), z.unknown())`

`.catchall(z.unknown())` 只放行**未声明**的额外键；44 个**已声明**字段（`limit: z.number().int()`、
`mode: z.enum(['root','delegate'])`、`markRead: z.boolean()`、`deliverables: z.array(z.string())` …）
的类型校验在 main 上**依然生效**。#41 注释「catchall 全通、约束不了什么」是对 zod 语义的误解。

### 探针实证（`scripts/probe-41-baseline-vs-seams.mjs`）

```
用例                              main      seams
limit 传字符串                     REJECT    accept   <<< 不一致
limit 传小数（int 约束）            REJECT    accept   <<< 不一致
mode 传非枚举值                    REJECT    accept   <<< 不一致
markRead 传字符串                  REJECT    accept   <<< 不一致
deliverables 传字符串而非数组       REJECT    accept   <<< 不一致
name 传数字                       REJECT    accept   <<< 不一致
未声明的额外字段                    accept    accept
合法输入                          accept    accept
行为不一致: 6 / 8
```

**结论**：#41 在 MCP 协议层把 6 类类型错误从「协议层即拒」放宽为「协议层放行」，
是**真实行为变更**，违反批5「纯重构行为不变无例外」铁律，且无 main 基线快照锁定。
门禁**应当**因此卡住，直到二选一：
- (A) 恢复 44 字段的类型校验（从单源 JSON Schema 派生 `extensionToolInput`，而非退化成 z.record）；
- (B) 主理人裁定接受此放宽，单独开票记为**显式行为变更**，并补协议层基线快照测试。

## 修正后的门禁清单

**阻塞（2）**
1. #1 FatalErrorBoundary 缺 i18n 时白屏，吞掉安全退出指引（行为回归）
2. #2a extension_call 协议层类型校验退化（行为放宽，探针 6/8 实证）

**可收尾（5）**：#3 #5(8份/709行) #7 #8 #9
**非缺陷/已撤回（4）**：#4（设计边界）、#6 #10（我方误判，撤回）、#11（重复属实但仅 2 份同文件）

## 方法论备注
双方各有误判。我方 3 项撤回（#2b/#6/#10）+1 项部分撤回（#11），源于凭印象未回查基线；
对方 1 项关键误判（#2a），源于把 seams 的代码/行号当作 main 的基线。
**教训一致：任何"行为是否变化"的判定必须以 `git show <基线>:<文件>` 对照 + 可执行探针为准，不得凭记忆。**

---

# 第二轮复核补记（HEAD `89e12f2`）

## 更正：#2b 的撤回是错的，现予恢复

第一轮我以 `core-tools.ts:434` 已有 `minLength:1` 为由撤回 #2b。**该论据用错了层**——
`core-tools.ts` 是**运行期单源**，而争议在 **MCP 协议层**。基线实测：

- `main 09f2246:src/mcp.ts:188` → `claimCode: z.string().optional()`，**无 minLength**
- 当前派生 → `claimCode: { type:'string', minLength:1 }`，**空串被拒**

探针（`scripts/probe-mcp-schema-drift.mjs`）：`claimCode:''` / `sessionToken:''` 在 main 协议层
accept、在 seams 协议层 REJECT。**#2b 成立，撤回作废。**

## 新发现：协议层 schema 对 main 漂移 12/32 工具、共 19 处

`test/fixtures/mcp-tools-issue41.json` 是 main 基线全量快照且**含 inputSchema**，
但 `tool-schema-contract-issue41.test.mjs` 的 LOCK-1~5 **只比 title/description/annotations/_meta，
从不比 inputSchema** —— 这正是 #2a 一轮漏网、#2b 误判的结构性原因。

逐项归类（探针输出）：

**A. 展示层 `default` 新增（11 处，parse 行为不变）**
`session_register.mode="root"`、`session_history.includeAncestors=true`、
`message_inbox.markRead=false`/`limit=50`、`list_dir.path="."`、`find_files.path="."`、
`search_text.path="."`/`regex=false`、`blob_create.encoding="utf-8"`、
`blob_read.encoding="utf-8"`、`blob_write_file.createParents=false`

`mcp-schema.ts:23-25` 刻意用 `.meta({default})` 而非 `.default()`，实测 `parse({}) => {}`
——**不注入运行期，服务端行为零变化**。但**客户端可见契约变了**（客户端可能据此自动填值）。

**B. 约束收紧（8 处，协议层拒绝面扩大）**
`session_inherit.claimCode/sessionToken` +minLength:1；`session_checkpoint.replanReason` +minLength:1；
`subagent_start.objective/background` +maxLength:4000；`deliverables/acceptanceCriteria/constraints` +maxItems:20

**严重性定级**：`extensions.ts:666` 的 `invokeTool` 对每次调用都跑
`validateJsonSchema(builtin.inputSchema, ...)` 并抛 `INVALID_INPUT`。这 8 项收紧的来源
正是同一份单源 schema ⇒ **运行期本来就会拒**。故**判定结果（accept/reject）不变，
变的是错误通道**：从「结构化 `INVALID_INPUT` ToolResponse」变为「MCP 协议层校验错误」。
属真实但有界的行为变更，与 #41 strict→strip 同类。

**C. 约束放宽：0 处**（`extension_call` 已由 `64afc16` 修复）

## 处置建议（待主理人）

19 处漂移全部是「协议层向运行期靠拢」——**恰是 #41 的设计目标**，且判定结果不变。
但批5 铁律是「行为不变无例外」，不能因为方向正确就默许。二选一：

- **甲（推荐）**：**承认并锁死**。给 LOCK 系列补 `inputSchema` 基线断言 + 一份**显式 allowlist**
  列出这 19 处已审阅差异及理由；此后任何新漂移立即红灯。同时开票把这 19 处记为
  #41 的显式契约变更。成本低，且永久堵死"协议层静默漂移"这个盲区。
- **乙**：在派生器里剥掉 default/约束，让协议层与 main 逐字一致。协议层退回"广告不足"，
  #41「消灭展示层/运行期分歧」的目标基本落空。

注：`extension_call`（#2a）不适用甲案——它是**放宽**且涉及 custom extension
（运行期按自定义 schema 校验，无兜底），判定结果会真变，故必须逐字还原，已办。
