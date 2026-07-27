# 工具系统上下文预算实测与优化方案 v2（网页端优先）

> 日期：2026-07-27 · 数据全部来自本地实例（127.0.0.1:3210）真实调用实测
> **对 v1 报告的修正**：Actions 通道只暴露 3 个 facade 工具（discover/register/call）是为网页端稳定性做的**有意设计，予以保留，不再建议拆除**。真正要解决的问题是：**无缓存、无强压缩的网页端上下文预算内，保证 $20 档会员完成 10–15 轮工具循环**。

---

## 1. 实测数据（2026-07-27，真实端点调用）

换算：英文 JSON ≈ 4 字符/token；中文 ≈ 1 字符/token（AGENT.md 为中文，实际 token 更高）。

### 1.1 单次调用成本

| 调用 | 字节 | ≈tokens | 备注 |
|---|---:|---:|---|
| discover（匿名） | 11,948 | ~3,000 | **85% 是 skills(5.4K)+agentMd(4.8K)** |
| session_register | 1,108 | ~280 | 返回 session+identity+context |
| discover（带身份·全量） | **34,430** | **~8,600** | 37 工具全 schema |
| discover（带身份·不要 schema） | 25,937 | ~6,500 | schema 只占 8.5K，固定开销才是大头 |
| discover（带身份·query 过滤） | 16,435 | ~4,100 | 固定开销 ~13KB 不随 query 减少 |
| workspace_info | 162 | ~40 | 轻 |
| list_dir src | 1,213 | ~300 | 轻 |
| execute_cli（小输出） | 562 | ~140 | 轻 |
| read_file_range 30 行 | 1,765 | ~440 | 轻 |
| session_checkpoint | 822 | ~200 | 轻 |
| session_context | 2,767 | ~690 | 16K 投影，当前为空所以小 |
| execute_cli（触发输出上限） | 24,482 | ~6,100 | maxOutputChars=20,000 字符 |
| read_file（28KB 文件） | 31,153 | ~7,800 | **默认上限 256KB → 单次可爆 ~64K tokens** |

### 1.2 discover 全量响应分解（31.6KB）

```
tools(37 个含 schema)  20.4KB  64%   ← query/detail 参数可压掉
skills(19 个)           5.4KB  17%   ← 与匿名 discover 重复发送
agentMd(中文)           4.8KB  15%   ← 与匿名 discover 重复发送
instructions            1.8KB   5%   ← 每次 discover 都重复
registrationSchema      0.6KB   1%   ← 只有注册时才需要
harness                 0.2KB   1%
```

**关键发现：按当前 instructions 教的标准流程（匿名 discover → register → 全量 discover），agentMd+skills 被发两遍，boot 阶段就烧掉 ~12K tokens，一行正经代码还没读。**

---

## 2. 预算模型：10–15 轮循环会不会爆？

约束设定：ChatGPT Plus 网页版窗口 ≈ 32K tokens（GPT-4o 网页版公开经验值，OpenAI 未公布精确数字）；Claude Pro 网页版 ≈ 200K。两边都不能依赖 prompt 缓存与强压缩，**工具结果全部沉淀在对话记录里累积**。$20 档的紧约束是 ChatGPT Plus 的 32K。

每轮成本 = 工具结果 + 模型 tool_call JSON(~0.25K) + 模型简述(~0.3K) + checkpoint 往返(~0.45K)。

### 现状推算（32K 窗口）

| 项目 | tokens |
|---|---:|
| GPT 固定开销（instructions + 3 Action 的 OpenAPI spec） | ~2,500 |
| 用户任务与对话文本 | ~2,000 |
| Bootstrap（discover→register→全量 discover） | ~12,000 |
| 剩余可用 | **~15,500** |
| ÷ 平均每轮 ~1.5–2K | **≈ 7–9 轮** ❌ |

再来一次大输出（6K）或大文件读取（7.8K），提前 2–3 轮爆。**现状达不到 10–15 轮。**
（Claude Pro 200K：总计 ~38K，轻松 ✓——这也解释了为什么目前 Claude 网页版是最顺的通道。）

### 优化后推算（见第 3 节方案）

| 项目 | tokens |
|---|---:|
| GPT 固定 + 用户文本 | ~4,500 |
| Bootstrap（瘦身 discover + register，agentMd/skills 只发一次） | ~1,800 |
| 15 轮 × 平均每轮 ~1.2K（经引导用小载荷工具 + 输出钳制） | ~18,000 |
| 合计 | **~24,300** ✓ 余量 ~7K |

**结论：不动 facade、不改协议，只靠"响应瘦身 + 输出钳制 + 调用路径引导"三件事，15 轮可达，且全部向后兼容。**

---

## 3. 优化方案（保留 3 工具 facade，全部向后兼容）

### P0-A：discover 响应分片（只改 server，协议不变）

给 `extension_discover` 增加两个**可选**参数（旧 GPT Action spec 不刷新也能用）：

- `sections`: `["tools","skills","agentMd","instructions","registration"]` —— 缺省全发（兼容），显式指定则只发所需
- `detail`: `"index" | "full"` —— index 时 tools 只给 name+一句话描述（37 个 ≈ 2KB）

黄金路径变为：
1. `discover()`（匿名）→ 只回 agentMd + 极简指引 + bootstrapTools（~1.5K，**skills 移到按需**）
2. `session_register(mode=root)`（~0.3K）
3. 工作中**只在遇到陌生工具时** `discover(query="xxx", detail="full")`（~0.6K/次）
4. **任何流程都不再需要全量 34KB dump**

效果：bootstrap 12K → ~2K；循环中每次 schema 查询 4.1K → ~0.6K。

### P0-B：Web 传输输出钳制（按 transport 分流，不影响本地）

在 core-tools 按 `context.transport` 钳制（web = actions/apps 通道）：

| 工具 | 现默认 | web 钳制 | 理由 |
|---|---|---|---|
| read_file maxBytes | 256KB | 默认 24KB，硬顶 64KB | 单次 64K tokens 的炸弹；引导改用 read_file_range 分页 |
| execute_cli maxOutputChars | 20K 字符 | 8K 字符 | 单次 5K→2K tokens；截断提示里引导用 grep/head 收窄 |
| search_text limit | 100 | 50 | 行匹配通常前 50 条够用 |

截断时返回明确的 `truncated: true` + 下一步提示（如 "use read_file_range with startLine"）——错误/截断信息可操作化，模型能自愈。

### P1-C：调用路径引导（instructions 与 description 重写）

- 匿名 discover 的 instructions 改成黄金路径三段论：「注册 → 直接干活 → 陌生工具才 query discover」，**明确禁止拉全量目录**
- `read_file` description 加「大文件用 read_file_range 分段」；`execute_cli` description 写明输出上限与收窄技巧
- 关键规则从 server instructions 下沉到**工具 description**（模型对 description 的遵循度远高于 instructions）

### P1-D（可选）：solo 轻量会话模式

`session_register(mode=root, lightweight=true)`：单 agent 网页场景下 checkpoint/continuation 机制降级为可选，每轮省 ~0.45K，15 轮省 ~7K。这是产品决策，需你拍板；不做也能达标，做了余量更大。

### P2-E：MCP 通道（Claude 网页版/通用客户端/agent）

- 维持现有 direct 工具全集不动（Claude 200K 吃得下，direct 精确 schema 对 agent 调用更友好）
- 同步应用 P0-B 的输出钳制（对 WorkBuddy 等本地 MCP client 同样是减负）
- v1 报告的 P0（MCP identity session 缓存自动注入）依然独立成立，建议一并做——它决定 direct 工具在 connector 下能不能用

### 验证闭环

新增 `scripts/context-budget.mjs`：重放本次实测的调用序列（discover→register→12 轮混合调用），输出每步字节数与估算 token、累计曲线、32K/200K 两条红线。以后每次改 discover/工具响应格式必跑，防"越改越胖"。

### 兼容性清单

| 变更 | GPT 网页端 | Claude 网页端 | 本地 client/TUI |
|---|---|---|---|
| P0-A 分片参数 | 可选参数，旧 spec 不刷新照常工作 ✓ | 同左 ✓ | 默认行为不变 ✓ |
| P0-B 输出钳制 | 上限变低+截断提示，无格式变化 ✓ | 同左 ✓ | actions/apps 通道生效；TUI/subagent 通道不动 |
| P1-C 文案 | 纯文本变更，Refresh 后生效 ✓ | 同左 ✓ | ✓ |
| P1-D 轻量模式 | 新可选字段 ✓ | ✓ | 默认关 ✓ |

---

## 4. 实施顺序与工作量估算

1. **P0-A** discover 分片（extensions.ts，~80 行 + 测试）——收益最大，先做这个
2. **P0-B** 输出钳制（core-tools.ts + config，~40 行 + 测试）
3. **P1-C** 文案（mcp.ts instructions + core-tools descriptions，~30 行）
4. P2-E MCP identity 缓存（mcp.ts，~60 行，v1 已定方案）
5. `scripts/context-budget.mjs` 验证脚本（~100 行）
6. P1-D 轻量模式（可选，store/types 有改动，单独评审）

做完 1–3 即可重跑实测验证「15 轮 × 32K」达标；4–6 是加固。

---

## References

- 实测数据：本地实例 127.0.0.1:3210，2026-07-27（响应样本存于 /tmp/mt_*.json，本会话采集）
- [Developer mode and MCP apps in ChatGPT — OpenAI Help Center](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
- [Writing effective tools for AI agents — Anthropic Engineering](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [MCP tool design best practices — Neptune Software（上下文累积效应）](https://docs.neptune-software.com/neptune-dxp-open-edition/24.15/cockpit-overview/sap-integration-hub-mcp-tool-design.html)
- [MCP 工具设计策略 — AWS Prescriptive Guidance（渐进披露/工具数量权衡）](https://docs.aws.amazon.com/zh_cn/prescriptive-guidance/latest/mcp-strategies/mcp-strategies.pdf)
- 项目代码：`src/extensions.ts`（discover 组装）、`src/core-tools.ts`（输出上限）、`src/mcp.ts`、`src/server.ts`（路由）
- 前序报告：`deliverables/tool-system-ux-optimization-2026-07-27.md`（v1，facade 拆除建议已被本版修正）
