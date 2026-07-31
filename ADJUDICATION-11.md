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
