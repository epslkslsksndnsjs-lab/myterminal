# MyTerminal 工具系统体验优化研究（GPT × WorkBuddy 双侧）

> ⚠️ **已被 v2 修正（2026-07-27）**：本文"拆除 facade / 增加 direct 工具暴露"的方向不适用于 Actions 网页端通道——3 工具 facade 是为网页端稳定性做的有意设计。网页端真问题是上下文预算，见 `deliverables/tool-system-context-budget-2026-07-27.md`（含实测数据）。本文仍有效的部分：MCP 通道 identity 缓存修复（P0-①）、MCP direct 工具精确 schema（对 Claude 网页版/本地 client 适用）。

> 日期：2026-07-27 · 范围：src/core-tools.ts / extensions.ts / mcp.ts / server.ts + 外部机制调研
> 结论先行：**优化完全发生在 server 侧的"工具定义层 + 传输层"，不改统一入口、不改持久化格式，GPT 与 WorkBuddy 同时受益，且对 GPT 现有用法 100% 向后兼容（只加不改）。**

---

## 1. 现状：工具系统实际长什么样

### 1.1 架构（四通道汇聚，设计本身是对的）

```
ChatGPT 网页版 ──MCP connector──┐
ChatGPT Actions ──HTTP POST────┤
WorkBuddy/其他 MCP client ─────┼──► ExtensionService.call() ──► invokeTool() ──► 36 个 builtin
本地 TUI ──────────────────────┤      （audit / auth / continuation）
Subagent（fork skill 等）──────┘
```

- `core-tools.ts`：36 个 builtin 工具定义（文件/git/blob/session/message/skill/subagent）
- `extensions.ts`：统一入口，负责鉴权、审计、continuation harness、200ms fast-return 后台任务
- `mcp.ts`：MCP 通道，暴露 **3 个 facade 工具 + 29 个 direct 工具 = 32 个**
- 所有通道最终走同一个 `invokeTool()` —— 这个汇聚设计是好的，问题不在架构，在**暴露层**

### 1.2 复杂难用的四个真实来源（代码级证据）

| # | 问题 | 证据 | 影响 |
|---|------|------|------|
| P0 | **MCP direct 工具拿不到 identity** | `mcp.ts` 29 个 `registerDirect` 的 zod schema 全都没有 `identity` 字段；MCP SDK 会 strip 未定义字段，模型想传也传不进；兜底依赖 `openai/session` meta（ChatGPT 通用 connector 不发这个） | ChatGPT connector 下 29 个 direct 工具**全部 IDENTITY_REQUIRED**，只有 `extension_call` 能用 |
| P1 | **最核心的写工具恰恰 schema 最虚** | `write_file` / `apply_patch` / `execute_cli` / `run_checks` / `skill` 这 5 个最常用的工具**没有 direct 版本**，只能走 `extension_call` | 模型最常用的操作被迫用最难用的路径 |
| P1 | **`extension_call` 是万能 schema** | `extensionToolInput`（mcp.ts L25-70）：40+ 可选字段 + `.catchall(z.unknown())`，所有工具的参数揉成一团 | 模型面对 any 型参数容易幻觉式乱传（外部研究证实这是失败主因之一） |
| P2 | **facade/direct 双轨认知负担** | 模型要先判断"这个能力有没有 direct 工具"，没有才走 facade；规则写在 server instructions 里，权重低 | 选择路径本身消耗模型注意力，弱模型直接懵 |

另外：每次 `extension_discover` 全量返回 37 个工具的完整 schema + instructions + harness contract，是一比不小的固定上下文税（但每次调用都重新拉，无法缓存）。

---

## 2. GPT（ChatGPT）到底是怎么调工具的？和我们一样吗？

**机制同构，痛点也同构。** 调研结论（来源见 References）：

1. **发现**：用户在 ChatGPT 开启 Developer Mode → 填 MCP server URL → ChatGPT 拉取全部 `tools/list`（name + description + inputSchema）。
2. **冻结快照**：ChatGPT 会把工具定义**冻结在批准时刻**。server 端改了 schema，必须用户手动 Refresh，否则调用报错。→ 教训：**schema 变更只能"加"不能"改"，且要分批**。
3. **注入上下文**：全部工具定义在**每一次模型推理**时都进入输入上下文。32 个工具 ≈ 每轮固定几千 token 的税，且工具越多、schema 越虚，模型选错工具/组错参数的概率越高（AWS 与 Neptune 的工程指南均明确这一点）。
4. **调用**：模型生成时决定调工具 → 输出结构化 tool_call（工具名 + JSON 参数）→ ChatGPT 客户端 POST 到 MCP server → 结果回注对话 → 模型继续。模型对工具的全部认知**只有 name/description/inputSchema 三个字段**（Anthropic 工具设计指南原话）。
5. **Agent mode 不用自定义 MCP app**；deep research 只读。所以 MyTerminal 的主战场就是普通对话 + Developer Mode connector。

**所以答案是：GPT 调工具和 WorkBuddy 调工具是同一套机制**（工具列表 + JSON Schema + 模型自选自组参）。它觉得难用的地方和我们觉得难用的地方是同一批：工具太多、万能 schema、身份样板。修好一份，两边同时受益——不存在"迁就 GPT 就委屈本地"的trade-off。

---

## 3. 优化方案（按优先级，全部向后兼容）

### P0-① 修 MCP identity：session 缓存自动注入【最重要，工作量小】

ChatGPT 的 direct 工具调用**物理上无法携带 identity**（zod strip），所以唯一正解是 server 侧缓存：

- `MyTerminalMcpTransport` 增加 `Map<mcpSessionId, SessionIdentity>`
- `session_register` / `session_inherit` 成功后（这两个本就不要求 identity），transport 层从返回结果捕获 identity → 缓存
- 之后同一 MCP session 的 direct 调用若未带 identity → **自动注入缓存值**；显式传入的 identity 永远优先（GPT 现有用法不变）
- `session_release` / MCP session close 时清除
- 改动集中在 `mcp.ts` 的 `registerDirect` 包装层，**不碰 extensions.ts 核心**

收益：ChatGPT connector 下 29 个 direct 工具从"全灭"变"全通"。WorkBuddy 作为 MCP client 同样免传 identity。

### P1-② 给 5 个核心工具补 direct 精确 schema

新增 `execute_cli` / `write_file` / `apply_patch` / `run_checks` / `skill` 的 `registerDirect` 版本（zod schema 照抄 core-tools 里的 JSON Schema 即可）：

- GPT 90% 的日常操作（读写文件、跑命令、跑检查）不再碰万能 `extension_call`
- `execute_cli` 标注 `destructiveHint + openWorldHint`，ChatGPT 会自然触发用户确认，安全语义不变
- `extension_call` 保留为"逃生舱"（custom extensions、罕见操作），description 里把分工规则写死（不只依赖 server instructions）

代价：MCP 工具数 32 → 37。但外部研究一致表明：**选择失败的主因是 schema 虚，不是数量多**；且 ChatGPT 支持逐工具开关 + WorkBuddy 侧无数量硬限制。精确化 >> 减少数量。

### P1-③ 错误信息可操作化

`extensions.ts` 的 `failure()` 目前用 `message.includes('not found')` 猜错误码，脆弱且对模型无指导。改进：

- 所有错误响应统一带 `code + message + retryable + hint`（hint 告诉模型下一步该怎么做，如 `IDENTITY_REQUIRED` → "先调 session_register(mode=root)"）
- Neptune 指南原则：错误信息要让模型**能自行恢复**，而不是只说"错了"

### P2-④ discover 瘦身 + 工具使用路径图

- `extension_discover` 响应里 `skills`/`agentMd` 改为按需（加 `include` 参数），默认只给工具目录
- server instructions 里加一段"黄金路径"（register → 直接用 direct 工具 → checkpoint），替代现在 13 条平铺规则。instructions 对模型权重低，**关键规则要重复写进相关工具的 description 里**

### P2-⑤ 建立工具可用性评测闭环（Anthropic 方法论）

用真实任务脚本（"读 X 文件改成 Y 并跑测试"）跑模型调用序列，统计：工具选择正确率 / 参数一次通过率 / IDENTITY_REQUIRED 出现次数。以后每次改 schema 跑一遍，防止"改得更难用"。

### 明确不做

- ❌ 不砍 direct 工具数量（倒退到 facade 只会更虚）
- ❌ 不改 `ExtensionService.call()` 统一入口与审计链
- ❌ 不改持久化格式（JSONL sessions/messages/history）
- ❌ 不动 Actions continuation harness（那是 Actions 通道的独立契约，GPT connector 不受影响）

### 兼容性声明（"不干扰 GPT"如何成立）

| 变更 | 对 GPT 的影响 |
|------|--------------|
| P0 identity 自动注入 | 纯增量兜底；显式传 identity 的旧对话行为完全一致 |
| P1 新增 5 个 direct 工具 | ChatGPT 侧 Refresh 一次即可见；旧 32 个工具定义一字未动 |
| P1 错误信息加 hint | 响应多一个字段，schema 向后兼容 |
| 全部 | 无删除、无字段语义变更、无需 GPT 侧改任何用法 |

---

## 4. 建议实施顺序

1. **P0-①**（mcp.ts 单文件，约 60 行）→ 立刻让 ChatGPT connector 全工具可用
2. **P1-②**（mcp.ts 追加 5 个 registerDirect）→ 日常使用脱离万能 schema
3. P1-③ → P2-④ → P2-⑤

每步独立可发布、独立可回滚。注意分批发布并在发版说明里提醒用户 Refresh connector（冻结快照机制）。

---

## References

- [Developer mode and MCP apps in ChatGPT — OpenAI Help Center](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
- [Connectors in ChatGPT — OpenAI Help Center](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt)
- [ChatGPT MCP: Setup, Plans, and Limits (2026) — coworker.ai](https://plg.coworker.ai/blog/chatgpt-mcp)
- [Writing effective tools for AI agents — Anthropic Engineering](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [MCP 工具设计最佳实践 — AWS Prescriptive Guidance](https://docs.aws.amazon.com/zh_cn/prescriptive-guidance/latest/mcp-strategies/mcp-strategies.pdf)
- [MCP tool design best practices — Neptune Software](https://docs.neptune-software.com/neptune-dxp-open-edition/24.15/cockpit-overview/sap-integration-hub-mcp-tool-design.html)
- [为 AI Agent 编写高质量工具的最佳实践 — Qubittool](https://qubittool.com/zh/blog/mcp-tools-best-practices-ai-agent)
- 项目代码：`src/core-tools.ts`、`src/extensions.ts`、`src/mcp.ts`、`src/server.ts`
