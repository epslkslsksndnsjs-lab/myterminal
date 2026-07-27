# 工具系统优化补充研究：GPT 思考模式上限 + Agent 直调上手实测

> 日期：2026-07-27 · 性质：对 `tool-system-context-budget-2026-07-27.md`（v2）的补充与最终合并
> 两个问题的答案：**① GPT 网页端思考模式上限确实高得多（官方数字已核实）；② "各种 agent 直接调系统、自己注册上手"这条路我已以 agent 第一视角实测——能走通，但有 3 个具体缺口，修复都是小改动。**

---

## 1. GPT 网页端上下文上限（OpenAI 官方帮助中心，2026-07 核实）

| 模式 | Free | **Plus / Business（$20 档）** | Pro |
|---|---|---|---|
| Instant | 16K | **32K** | 128K |
| **Thinking（手动选择）** | — | **256K（128K 输入 + 128K 输出）** | 400K（272K 输入 + 128K 输出） |

用户判断正确：**手动选 Thinking 后，$20 Plus 也有 128K 输入窗口**。按 v2 模型重算：boot 12K + 15 轮 × 2K ≈ 42K ≪ 128K，**现状在 Thinking 模式下即可达标**。

但有三个必须注意的坑：

1. **必须手动选择 Thinking** 才有 256K 窗口；Instant 自动路由到 Thinking 时 OpenAI 明确说明"published Thinking window 绑定手动选择"，自动切换的场景窗口不透明。
2. **自定义 GPT（Actions 通道的载体）能否手选 Thinking 需实机验证**——GPTs 历史上模型选择受限，这一点我没有实机条件确认，如实标注为待验证项。
3. Thinking 更慢，且 Plus 有 160 条/3 小时的消息配额（工具轮次不占用户消息数，但长任务体验受思考延迟影响）。

**结论修正：v2 的瘦身三件套（discover 分片 + 输出钳制 + 黄金路径）从"达标必需"降级为"体验必需"**——它决定的是 Instant 32K 也能流畅跑（用户不用记得切 Thinking）、以及每轮响应更快。仍然建议做，但优先级让位于下面的 agent 上手缺口。

---

## 2. Agent 直调系统：第一视角实测结果

模拟场景：一个只拿到 `Base URL + Token + 3 个端点` 的 agent（不看源码、不看文档），能否自己完成 discover→注册→干活？

### 已有资产（实测可用 ✅）

| 资产 | 实测 |
|---|---|
| `GET /health` | 200 JSON，含 product/version/workspaces ✅ |
| `GET /openapi.json`（还有 openapi-3.1.json） | 13KB，3 端点齐全；**envelope 字段完整**：call 的 `tool/input/arguments/inputJson/identity`、discover 的 `query/includeSchemas/identity` ✅ |
| 匿名 `POST discover` | 返回 bootstrap 流程说明 + bootstrapTools 签名 ✅ |
| 注册→调用→checkpoint→completed | 全部一次走通（本研究全程即实证）✅ |

### 三个缺口（agent 会卡住的地方 ❌）

1. **匿名 discover 不提 `/openapi.json`**。agent 拿到端点列表后不知道有机器可读 spec，`{"tool","input","identity"}` 的信封格式只能猜。实测：discover 全文无 "openapi" 字样。
2. **信封错误不教学**。agent 若把参数放顶层（`{"tool":"session_register","mode":"root"}`）而非嵌进 `input`，报错只说 "name must be a string"，不告诉它参数该放哪。按 agent 友好设计规范（help 即 API、错误必须可恢复），错误响应应直接给出正确示例。
3. **没有"3 行上手"极简示例**。spec 13KB 是完整契约，但 agent 上手只需要一个可照抄的最小调用序列。

### 修复方案（P0-C：agent onboarding 三件套，全是小改动）

- **C-1**（extensions.ts，1 行）匿名 discover 的 instructions 增加：
  `spec: 'Machine-readable contract: GET /openapi.json. Minimal start: POST /actions/extensions/call {"tool":"session_register","input":{"mode":"root","name":"<agent-name>"}} → then pass identity={sessionId,sessionToken} on every call.'`
- **C-2**（extensions.ts `failure()`，~10 行）`/call` 参数校验失败时在 error.details 附带 `hint` + 正确信封示例（区分"缺 tool"/"参数未嵌 input"/"缺 identity"三种典型错误）。
- **C-3**（openapi.ts，~5 行）`ExtensionCallRequest` schema 的 description 里嵌一个完整 JSON 调用示例，agent 读 spec 时照抄即可。

对 GPT 网页端影响：纯增量文案/字段，零破坏。

---

## 3. 最终合并方案（三份报告收敛为一张表）

| 优先级 | 事项 | 改动量 | 解决的问题 |
|---|---|---|---|
| **P0-C** | agent onboarding 三件套（spec 引用 + 错误教学 + envelope 示例） | ~16 行 | 各种 agent 直调系统自己注册上手 ✅ |
| **P0-A** | discover 响应分片（`sections`/`detail` 可选参数） | ~80 行 | Instant 32K 窗口跑 15 轮；每轮更快 |
| **P0-B** | web 输出钳制（read_file 24KB / cli 8K 字符，按 transport） | ~40 行 | 单次调用炸上下文的两个炸弹 |
| P1 | 黄金路径文案（instructions + description 下沉规则） | ~30 行 | 模型少绕路 |
| P2 | MCP identity session 缓存自动注入（v1 已定） | ~60 行 | MCP connector 下 direct 工具全通 |
| P2 | `scripts/context-budget.mjs` 回归脚本 | ~100 行 | 防越改越胖 |

达标判定（$20 档）：
- **GPT 网页端 Thinking（256K）**：现状已达标；P0-A/B 后余量更大、响应更快
- **GPT 网页端 Instant（32K）**：P0-A/B 后 15 轮 ≈ 24.3K ✓
- **Agent 直调（任意模型）**：P0-C 后零人类介入完成上手 ✓
- **Claude 网页版 MCP（200K）**：现状已顺，P2 identity 修复后 direct 工具全通 ✓

---

## References

- [GPT-5.5 in ChatGPT — OpenAI Help Center（上下文窗口官方数字）](https://help.openai.com/en/articles/11909943)
- [ChatGPT Context Window Sizes by Model — chatai.guide（交叉核对）](https://chatai.guide/limits/chatgpt-context-window)
- 实测数据：本地实例 127.0.0.1:3210（/health、/openapi.json、匿名 discover、注册→调用全流程，2026-07-27）
- 设计规范：本地技能 `~/.workbuddy/skills/agent-cli-design/SKILL.md`（help 即 API / 可恢复错误 / 非交互安全）
- 前序报告：`deliverables/tool-system-context-budget-2026-07-27.md`（v2 实测与预算模型）、`deliverables/tool-system-ux-optimization-2026-07-27.md`（v1，MCP identity 修复）
