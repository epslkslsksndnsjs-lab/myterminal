# MyTerminal 工具系统核心问题全景（三角度收口）

> 日期：2026-07-27 · 性质：前四份报告的收口。证据：代码定位 + 本地实例实测 + OpenAI 官方文档
> **一句话总纲**：工具系统是按"无限预算的私有 API agent"设计的，但主战场是"有限预算、无缓存、有人工确认层、官方监管的网页端 + 水平参差的通用 agent"。下面所有核心问题都是这一个错位的投影。

---

## 角度一：会不会干扰 GPT 网页端使用？（会，6 处）

| # | 核心问题 | 证据 | 对网页端的干扰 |
|---|---|---|---|
| **K1** | **确认疲劳：extension_call 标了 consequential=true** | `openapi.ts:92`；OpenAI 官方：consequential=true = 每次必须人工确认且**不显示 "Always allow" 按钮** | **10-15 轮循环 = 用户手点 30-45 次确认**。这是网页端体验的第一杀手，此前所有报告都漏了它 |
| **K2** | **spec 描述超限：extension_call description = 302 字符** | 实测 /openapi.json；官方上限 300 字符/端点描述 | 开启 continuation 模式时更长 → GPT 导入 schema 可能报错或被截断 |
| **K3** | **上下文预算错位** | 实测：boot 12K tokens（匿名 discover 12KB + 全量 34.4KB）；GPTs with Actions 模型选择受限（官方：仅支持 actions 的非 Pro 模型），**Actions 通道应按 32K Instant 规划** | 32K 窗口下仅 7-9 轮，达不到 10-15 轮 |
| **K4** | **输出炸弹撞官方 100K 字符硬顶** | 官方：请求/响应各 <100,000 字符；`read_file` 默认上限 256KB | 一次读大文件直接违反协议级上限，结果报错/截断 |
| **K5** | **45 秒硬超时 vs 默认 60 秒命令超时 + 非阻塞默认关** | 官方：45s round trip；`config.ts:95,100` commandTimeoutSec=60、nonBlockingTasksEnabled=false | 跑 46-60 秒的命令：ChatGPT 断开，**结果丢失**（server 还在白跑） |
| **K6** | **5 分钟 checkpoint 硬门** | `store.ts:16,301` 零预警 + 被拒调用意图丢失 | 每次硬门浪费 1-2 轮，心流被斩断（实战 E5×4） |

另：写文件/heredoc `$` 引导缺失、大文件无 append（E3/E4/E6/E8）同为此角度，见错误分析报告。

## 角度二：会不会被 OpenAI 官方发现并限制？（定性 + 4 个真实风险点）

**定性判断**：MyTerminal 走的是 OpenAI **官方提供的集成通道**（custom GPT Actions / MCP connector），不逆向、不抓 cookie、不共享凭据、不提取数据——**不属于"违规检测"的高危对象**。真实风险集中在「异常流量模式」和「政策单方面变动」：

| # | 风险 | 等级 | 说明与对策 |
|---|---|---|---|
| R1 | **高频轮询模式**（task_poll 200ms 快速循环） | 中 | 这是与正常 Actions 流量最不一样的特征。**官方给了正解：ChatGPT 尊重 429 并动态退避**——server 主动对过密轮询返回 429+Retry-After，把"可疑模式"变成"教科书式节流" |
| R2 | **不停机 continuation**（强制 nextCalls 让模型无法停下） | 中 | 定价页明确 "Unlimited subject to abuse guardrails"。长时间无人监督的连续调用是护栏敏感模式。当前实例 continuation=off，**建议在 Actions 通道保持 off**，增强模式只留给自有 client |
| R3 | **消息配额墙**（Plus 160 条/3 小时） | 低 | 不是封号问题，是体验问题。工具循环在一条用户消息内完成多轮调用即可绕开——恰好与"别打断模型"的设计一致 |
| R4 | **政策单方面变动** | 不可控 | OpenAI 可随时调整 GPTs/Actions/MCP 政策。**对冲 = 通道冗余**：Claude 网页版 MCP connector 已是成熟第二通道，别把鸡蛋全放 GPT |

必须诚实：**没有任何设计能"保证"不被限制**——能做的是把可检测的异常模式（高频、不停机、超大载荷）降到背景水平，并保留通道冗余。

## 角度三：通用 agent 能否更好用？（5 个缺口）

| # | 核心问题 | 证据 |
|---|---|---|
| A1 | **onboarding 断链**：匿名 discover 不提 /openapi.json；信封错误不教学；无最小调用示例 | 实测 discover 全文无 "openapi" |
| A2 | **失败黑洞**：subagent 失败无部分结果；overflow 识别只匹配 3 个英文短语，GLM/Qwen 中文报错漏判 → compact 不触发直接判死 | `llm-adapter.ts:176`、`executor.ts:450`、`runner.ts:120` |
| A3 | **身份样板**：MCP direct 工具 zod schema 无 identity 字段被 strip，connector 下 29 个工具全灭 | `mcp.ts` registerDirect |
| A4 | 硬门打断 agent 循环（同 K6） | `store.ts:301` |
| A5 | 大文件分轮创作无 append 语义 | `core-tools.ts` write_file |

---

## 收敛：核心问题 TOP 榜（修复即按此顺序）

| 排名 | 问题 | 改动量 | 备注 |
|---|---|---|---|
| 1 | **K1 确认疲劳** | openapi.ts consequential 改为可配置（~10 行） | ⚠️ 安全语义变化：false = 显示 Always allow，用户点一次后任意命令免确认执行。**需你拍板**，建议默认 true、文档里教用户如何自选 |
| 2 | **K2 spec 描述 302>300** | openapi.ts 压缩 call 描述（~5 行） | 立即修，合规 bug |
| 3 | **K5 45 秒 vs 60 秒** | Actions 通道钳 commandTimeoutSec≤40 或 nonBlocking 默认开（~15 行） | 结果丢失是真 bug |
| 4 | **K3/A1 discover 分片 + onboarding 三件套** | ~100 行 | 32K 达标 + agent 自助上手 |
| 5 | **K4 输出钳制** | ~40 行 | 官方 100K 硬顶背书 |
| 6 | **A2 subagent 失败打捞 + overflow 识别扩充** | ~50 行 | 实战 E1/E2/E7 |
| 7 | **K6/A4 checkpoint 软预警 + blockedCall 重放** | ~35 行 | 实战 E5 |
| 8 | **R1 429 节流** | ~20 行 | 把最可疑的流量模式变合规 |
| 9 | A3 MCP identity 缓存 / K6 文案 / A5 append | ~90 行 | 加固 |

**全部改动只加不改、向后兼容**；K1 是唯一需要你做的决策（安全 vs 免确认的权衡）。

---

## References

- [Production notes on GPT Actions — OpenAI Developers（45s 超时 / 100K 字符 / 429 退避 / consequential / 300 字符上限）](https://developers.openai.com/api/docs/actions/production)
- [Configuring actions in GPTs — OpenAI Help Center（Actions GPT 模型选择受限、Actions 不可用于 Pro mode）](https://help.openai.com/en/articles/9442513-gpt-actions-domain-settings-chatgpt-enterprise)
- [GPT-5.5 in ChatGPT — OpenAI Help Center（Thinking 256K 窗口，手动选择）](https://help.openai.com/en/articles/11909943)
- [Tips for developing custom actions in ChatGPT — MintMCP（45s/100K/分页实践佐证）](https://www.mintmcp.com/blog/tips-custom-actions-chatgpt)
- 实测数据：本地实例 127.0.0.1:3210（/openapi.json 描述长度、consequential 标志、discover/调用载荷，2026-07-27）
- 代码证据：`src/openapi.ts:90-99`、`src/config.ts:95,100`、`src/store.ts:16,296-313`、`src/subagent/llm-adapter.ts:173-177`、`src/subagent/executor.ts:450-460`、`src/mcp.ts`
- 前序报告：deliverables/ 下 tool-system-ux-optimization / tool-system-context-budget / tool-system-agent-onboarding / execution-error-analysis（均 2026-07-27）
