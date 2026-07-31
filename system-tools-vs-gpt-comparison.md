# MyTerminal 系统工具 vs WorkBuddy(GPT) 工具 —— 对比与替换影响分析

> 分析对象：MyTerminal 通过 GPT Actions 暴露给远程 GPT（ChatGPT）的工具面。
> 对比对象：本机直接运行的 GPT Agent（WorkBuddy / 同类本地 agent）的原生工具。
> 结论速览：**能力层能 1:1 甚至更强接管；编排层（身份/审计/handoff/异步任务/远程桥）不能直接替换，要么丢失、要么要在我之上重建。**

---

## 一、MyTerminal 的“系统工具”到底是什么

MyTerminal 不是把本地能力直接交给 GPT，而是套了一层 **HTTP facade + 强制身份 + schema 校验** 的工具总线。结构上分三层：

### 1. Facade 三操作（`src/openapi.ts`）
| 操作 | 作用 |
|---|---|
| `extensionDiscover` | 无 identity 只返回引导；带 identity 返回全量工具目录（+ schema） |
| `extensionRegister` | 运行时注册/校验/删除扩展工具（validate / upsert / remove） |
| `extensionCall` | 真正调用某个具体工具；GPT 在 `tool` 字段填名字，在 `input` 填参数 |

### 2. 实际 builtin 工具（`src/core-tools.ts` + `src/extensions.ts`，约 37 个）
| 分类 | 工具 | 数量 |
|---|---|---|
| 文件系统 | `workspace_info` `list_dir` `find_files` `search_text` `read_file` `read_file_range` `write_file` `apply_patch` `blob_create` `blob_read` `blob_write_file` | 11 |
| Shell / Git | `execute_cli` `git_status` `git_diff` `git_log` `git_show` `run_checks` | 6 |
| 会话 / 身份 | `session_register`(root/delegate) `session_inherit` `session_list` `session_checkpoint` `session_context` `session_history` `session_release` `session_unregister` `session_tag` `session_subscribe` `session_events_ack` | 11 |
| 消息 / 协作 | `message_send` `message_inbox` `message_list` `message_conversation` | 4 |
| Skill | `skill`（无参=list / 有参=inline 或 fork subagent） | 1 |
| Subagent | `subagent_start` `subagent_status` `subagent_abort` | 3 |
| 异步任务 | `task_poll`（>200ms 返回 taskId，轮询至终态） | 1 |

### 3. 设计特征（这是它的“灵魂”，不是工具本身）
- **Bearer 身份**：每个 mutating 调用必须带 `identity={sessionId, sessionToken}`，否则 `IDENTITY_REQUIRED`。
- **Schema 强校验**：每个工具 input 严格 JSON Schema；文件有 `maxBytes`、命令有 `timeoutSec`、搜索有正则/大小上限。
- **四注解治理**：`readOnlyHint / destructiveHint / openWorldHint / idempotentHint`。
- **SHA 文件保护**：`write_file`/`apply_patch` 支持 `expectedSha256`，文件被改过就拒绝写，防止远程模型覆盖。
- **Workspace 沙箱**：`resolveWorkspacePath` 把所有路径锁在授权目录内。
- **审计与 handoff**：每次调用落审计事件；`session_release` 发一次性 `claimCode`，`session_inherit` 用 claimCode 或 sessionToken 恢复中断的会话。
- **Continuation 强制**：`actionsContinuationMode`（off / adaptive / next-call / lookahead）配合 `session_checkpoint` 的 `nextCalls`，强制远程模型“必须继续、不能停”。
- **多模型 subagent**：`subagent_start` 的 `provider` 可切 `openai/anthropic/deepseek/glm/qwen`。

---

## 二、与“我这种 GPT”的工具对比（能力映射表）

| MyTerminal 工具 | 我的等价工具 | 覆盖度 | 说明 |
|---|---|---|---|
| 11 个文件/搜索工具 | `Read` `Write` `Edit` `Glob` `Grep` `Bash` | ✅ 更强 | 我还有目录树、多文件并行、图片/PDF 读取 |
| 6 个 Shell/Git 工具 | `Bash` | ✅ 更强 | 我直接跑 shell，不受“单条命令 + 200ms 预算”限制 |
| `skill` | `Skill` | ✅ 等价 | 我也能 list / 加载 / fork subagent |
| `subagent_start/status/abort` | `Agent` + `TeamCreate`/`SendMessage` | ⚠️ 部分 | 我能起子代理、轮询、中止；但**子代理和我同模型**，不能切 provider；消息是团队内通信而非持久化跨会话信箱 |
| `session_register/inherit/checkpoint/release/...` | 无直接等价 | ❌ 缺失 | 我的“连续性”= 单进程对话历史，无身份/审计/handoff 码 |
| `message_send/inbox/list/conversation` | 无（团队内 `SendMessage` 近似） | ❌ 缺失 | 我没有持久化、可跨会话认领的协作信箱 |
| `task_poll` | 无（用 background agent 近似） | ❌ 缺失 | 我同步 await 或用后台 agent 通知，没有“200ms 预算 + 轮询”契约 |
| `extensionDiscover/Register/Call` | 无 | ❌ 缺失 | 我原生函数调用，没有“运行时注册动态扩展”的目录总线 |

**一句话**：文件/Shell/Skill/Subagent 这四块我**完全能接管且更强**；会话身份、跨会话消息、异步任务轮询、动态扩展注册这四块**我没有原生等价物**。

---

## 三、把他的工具“换成我这种 GPT”还能处理吗？

要分两种替换意图来谈，结论完全不同。

### 情形 A：目标是“让一个本地 agent 直接操作这台机器”
**能，而且更顺。** 文件读写、命令执行、搜索、git、跑测试、调用 skill、派子代理——这些 MyTerminal 工具本质上就是给我这种 agent 用的，我只是用 `Bash`/`Read`/`Write`/`Edit`/`Agent` 直接做，少了 HTTP + bearer + schema 的封装开销，反而更快更灵活。
- **会“多出来”的能力**：我可以直接读图片/PDF、跑任意长命令、并行多文件、跨语言生成。
- **会“少掉”的护栏**：MyTerminal 的 SHA 保护、workspace 沙箱、destructive/idempotent 注解在你身上是“软约束”。我用 `Bash` 是真 shell，权限比它那套受限工具大得多——**安全面变宽**。

### 情形 B：目标是“保留 MyTerminal 现在的远程桥 + 多用户 + 审计 + handoff”
**不能直接换，等于在我之上重建 MyTerminal 的编排层。** 我是一个本地 agent，默认没有：
1. **远程 HTTP 桥**：MyTerminal 的价值是“ChatGPT 网页版 → 本地机器”的桥。我本地就有机器访问权，桥对我多余；但如果你想**继续用 ChatGPT 网页版来驱动我**，就得把我自己的工具也套一层 `extensionDiscover/Call/Register` 服务。
2. **会话身份与审计**：每次调用带 token、落审计事件、可被合规审查——这是给“远程不受信模型碰本地机器”设的边界。本地 agent 不需要这层安全，但**多租户/合规场景全没了**。
3. **Handoff / 连续性**：`session_release` + claimCode 让工作能在一次 ChatGPT run 被中断后由另一个 run 认领继续。`session_inherit` 用 sessionToken  reclaim 卡死的会话。我的连续性依赖单进程对话，进程崩了状态就没了（除非外部持久化）。
4. **跨会话协作信箱**：`message_send/inbox` 是持久化、可追溯的 inter-session 通信，支撑“root 派 delegate、delegate 回消息”的多智能体编排。我的 `SendMessage` 只活在团队生命周期内，不做持久化认领。
5. **异步长任务 + continuation 强制**：`task_poll` + `nextCalls mustContinue` 是产品级契约，强制远程模型“不能停、要继续”。我的 agent loop 天然会续，但**没有这条外部强制线**，也没有“200ms 内必须返回否则给 taskId”的调度契约。
6. **动态扩展注册**：`extensionRegister` 允许运行时增删工具。我靠固定工具 + skill 文件，要“加工具”得改代码/写 skill。

---

## 四、影响评估（替换的代价 / 收益）

### 收益
- **能力更强更自由**：本地直连，无 200ms 预算、无单命令限制、无 schema 围栏。
- **架构更简单**：少一层 HTTP facade + 身份总线，调试和延迟都更好。
- **产品定位升级**：从“桥接 ChatGPT 订阅额度的本地工具”变成“自有本地 agent”，不依赖第三方订阅。

### 代价 / 风险
- **安全面扩大**：`Bash` 是真 shell，SHA 保护、workspace 沙箱、destructive 注解变成软约束，远程/自动化误用风险上升。
- **合规/审计缺失**：若场景需要“谁在何时动了哪台机器”的可追溯记录，要自己补。
- **远程桥消失**：想继续用 ChatGPT 网页版驱动本地机器？必须自己把我的工具包一层 facade。
- **任务连续性脆弱**：本地 agent 崩溃 = 状态丢失，除非引入外部持久化（JSONL/checkpoint 机制）。
- **多模型扇出丢失**：MyTerminal 能把子任务派给不同 provider；我只能派“和我同模型”的子代理。
- **产品逻辑改变**：原 thesis 是“免费”，换成我后变成付费/本地 agent，价值链重写。

---

## 五、建议

1. **如果只要“本地自动化的 agent”**：直接让我上，MyTerminal 那套 facade 对你是多余封装。文件/Shell/Skill/Subagent 我全包，且更强。注意补一层最小化的操作日志与命令白名单即可。
2. **如果要保留“远程 ChatGPT 驱动本地机器 + 多人审计 + 可 handoff 的长任务”**：不要“替换”，而是“复用”——把我的能力通过一套 `extensionDiscover/Call/Register` 风格的 HTTP 服务暴露出去，并补齐会话身份、审计、handoff、task_poll 这几块编排逻辑。本质上是在我之上重建 MyTerminal 的编排层，工具实现可以换成我来跑。
3. **折中路线**：保留 MyTerminal 的 facade 与身份/审计层不动，只把底层“执行器”从它内置实现换成调用我的 agent 接口——这样既不丢桥与合规，又拿到本地 agent 的灵活度。

---

## 附：核心差异一句话总结

> MyTerminal 卖的是**“受控通道 + 编排协议”**（让不受信的远程模型安全地碰本地机器，且任务可审计、可交接、可续）；
> 我卖的是**“直接执行力”**（本地代理直接干活，更快更自由，但不自带通道/审计/handoff）。
> 替换能不能“处理”，取决于你要的是哪一半。
