# MyTerminal × ChatGPT 网页端：工具消费机制核对与修正

> 修正说明：上一篇 `myterminal-gpt-hostility-analysis.md` 是基于 **OpenAI 开发者文档的 function calling（API 侧）** 得出的结论。本篇改用 **ChatGPT 网页端（chatgpt.com）GPT Actions 产品** 的官方行为重新核对，并修正前篇偏颇之处。
> 依据：help.openai.com 的「Configuring actions in GPTs」、developers.openai.com/api/docs/actions 的「Getting started」与「Production notes」。
> **核实更新（2026-07-30）**：以上 GPT Actions 产品机制与硬限制已对照 OpenAI 官方文档（2026-07 版）复核，结论仍成立；并对照 MyTerminal `src/` 源码核实了实现细节。修正两处事实：工具数 37→**34**（默认 33 内置 + task_poll，外加运行时注册的自定义扩展）；`extensionCall` 的 `identity` 位于**顶层**、首选参数字段是 `input` 而非 `arguments`。另：「30 endpoint 上限」与「复杂 JSON 处理差」属社区经验/最佳实践，**非 OpenAI 官方硬限制**。

---

## 一、ChatGPT 网页端到底怎么"吃"工具

这是网页端产品（不是 API）的真实机制，每条都有官方文档背书：

| 机制 | 网页端实际行为 | 文档依据 |
|---|---|---|
| 工具粒度 | **每个 OpenAPI operation = 一个 action = 一个工具**，模型原生选择、可并行 | help.openai.com/9442513：「schema tells ChatGPT: what endpoints are available / how each action is identified (operation IDs)」 |
| schema 解析时机 | **在 GPT 编辑器里配置/保存时解析一次**。"If the schema is valid, the editor shows detected actions." | help.openai.com/9442513 |
| 模型如何选工具 | 几乎**完全依赖 schema 里的静态文本**：`info.description`、每个 operation 的 `operationId`/`summary`、参数 `description`、`enum`。"ChatGPT uses those names and descriptions to understand which action to call" | developers.openai.com/api/docs/actions/getting-started |
| 复杂 JSON | 官方未明文规定，属社区与 Action 最佳实践共识：**GPT 处理复杂/深层嵌套 JSON 能力差**，response 应扁平、勿深嵌套。注意 lobehub 提到的「Limit to 30 endpoints（超过性能下降）」是**社区经验线、并非 OpenAI 官方硬限制**——官方 Production notes 只规定 description≤300、参数≤700、payload<100k 等字符/字节上限，**从未规定 endpoint 数量上限** | lobehub ChatGPT Apps 指南：「GPT handles complex JSON poorly / Response schemas should be flat / Limit to 30 endpoints（超过性能下降）」 |
| 硬限制（Production notes） | ① 每个 endpoint 的 description/summary ≤ 300 字符 ② 每个参数 description ≤ 700 字符 ③ 请求/响应 payload 各 < 100,000 字符 ④ **往返超时 45 秒** ⑤ 不支持自定义 header（除 Google/Microsoft/Adobe OAuth）⑥ 仅文本，无图片/视频 ⑦ 尊重 429 退避 | developers.openai.com/api/docs/actions/production/ |
| 强制确认 | `x-openai-isConsequential`：GET 默认 false（可"总是允许"），其余默认 true（**每次必须用户确认，无"总是允许"**） | developers.openai.com/api/docs/actions/production/ |
| 认证 | None / API Key（Basic / **Bearer** / Custom header）/ OAuth | help.openai.com/9442513 |
| 调试 | 编辑器每个 action 有 Test 按钮；但「debugging directly in ChatGPT can be a challenge」 | getting-started |

---

## 二、对我前一篇结论的修正（重点）

我前一篇的核心批评是"router / god-function 反模式（API 最佳实践说别让模型路由）"。**在网页端这个批评站不住，甚至结论要反过来看：**

- **网页端只有 3 个 operation = 只有 3 个工具，模型轻松选**。3 个工具根本不算"路由负担"。
- 反过来，我前一篇给的"方案 B：把 `extensionCall.tool` 改成 enum 写死 34 个真工具"——**在网页端会翻车**：
  - 触及社区经验线「endpoint 超过 30 个性能下降」（注：非 OpenAI 官方硬限制，官方只限字符/字节）；
  - config-time 要把 34 个工具的 schema 全塞进静态 spec，体积膨胀、嵌套加深，正中"复杂 JSON 处理差"的雷区；
  - 更不要说 `extensionRegister` 运行时注册的工具根本不会进静态 spec。
- **所以：3-operation 的 facade 在网页端其实是"数量友好"的正确选择。** 真正卡 MyTerminal 的不是"套一层"，而是下面第三节那几件事。

---

## 三、网页端真正卡住 MyTerminal 的地方（逐条对应源码）

### 1. config-time 解析 → 运行时 `extensionRegister` 注册的工具对网页模型"不可见"
网页端只在编辑器保存时读一次 schema。MyTerminal 用 `extensionRegister` 热注册新扩展（见 `myterminal-e2e`/extensions 设计），但那些工具**永远不会出现在网页模型看到的 3 个 operation 里**。模型只能靠运行时 `extensionDiscover` 拿回一个 JSON blob 才知道有这些工具——等于把"工具可发现性"完全推迟到对话运行时，且依赖模型自己解析。

### 2. `discover` 返回一大坨 JSON + `extensionCall` 嵌套 `arguments` → 正中"复杂嵌套 JSON"雷区
- `extensionDiscover(includeSchemas:true)` 一次性返回 34 个工具（默认 33 内置 + task_poll，外加运行时注册的自定义扩展）的完整 schema（嵌套 `properties`/`required`），体积可能逼近但易超网页端舒适区，且**模型要自己 parse 这个 blob 再拼出 `extensionCall`**。
- `extensionCall` 的请求体是 `{ tool, input, arguments, inputJson, identity }`——其中 `arguments`/`input` 是嵌套对象，而 `identity` 与 `tool` 同处**顶层（并非嵌套在 arguments 内）**；首选参数字段是 `input`，`arguments` 仅为兼容别名。网页模型对"先读一大坨、再生成正确形状的嵌套参数"这种两段式任务极易出错（漏字段、结构错）。
- 这正应了你说的"**再加一个 http 工具参数返回全部包起来，让模型自己去找**"——在网页端这是最痛的一点，因为网页模型**没有外部调试器**，只能靠 GPT Instructions 硬教。

### 3. 45 秒往返超时 vs continuation / CHECKPOINT 长任务机制直接撞车
MyTerminal 用 `continuation` + `CHECKPOINT_REQUIRED` 处理长任务（Shell 命令、subagent）。但网页端**硬限 45 秒往返超时**。一次 `extensionCall` 跑 shell/subagent 超过 45s，网页端直接超时失败，而 MyTerminal 的"CHECKPOINT 后继续"协议在网页产品里没有原生承载通道——模型拿到超时会怎么恢复是不确定的。这是架构级冲突，不是描述问题。

### 4. 每次 `extensionCall` 是 mutating → 默认"每次必须用户确认"
`x-openai-isConsequential` 默认：非 GET 一律 true。MyTerminal 的 `extensionCall` 是 POST/变更型，**网页端默认每次弹确认框、且不给"总是允许"**。对"远程 GPT 驱动本地机器干活"的体验是巨大摩擦——用户每步都要点确认。需在 spec 里对只读类调用显式标 `x-openai-isConsequential: false`（但 MyTerminal 是单 operation 包所有工具，无法按"是否只读"分别标，只能全标或全不标，又是个设计张力）。

### 5. 静态 Bearer 认证 vs "bootstrap 无 identity" 流程不匹配
网页端 API Key 认证是**配置时写死的一个静态 key，每次请求都带**。而 MyTerminal 的 `session bootstrap` 流程要求"新任务先无 identity discover，再建立 session"（你给的指令：「无 identity = 不传该键」）。网页端要么永远带那个静态 key（违反 bootstrap 无 identity），要么用 None 认证（不安全）。单用户本地桥可勉强把"静态 key = 桥的访问令牌"、identity 放 body 里绕过，但 bootstrap 的"先无身份探索"在网页端表达不自然。

### 6. 400 `CHECKPOINT_REQUIRED` 在网页端难恢复 + 网页端难调试
前一篇已指出 400 三义（参数错 / 该 checkpoint / 非零退出）。在网页端更糟：400 对模型是"action 出错"，模型没有 Postman 那种详细错误视图，**自助恢复 CHECKPOINT 不可靠**；而官方明说"debugging in ChatGPT is a challenge"。

---

## 四、修正后的结论

- **"套一层包一层让模型自己找"在网页端确实是真的、且尤其痛**——但痛因不是"router 反模式"（那是 API 侧视角），而是：**config-time 静态 schema 看不见运行时工具 + 模型要自助 parse 大 JSON blob + 45s 超时撞车长任务协议 + 每次确认摩擦**。
- **我前一篇的"方案 B（枚举 34 个工具）在网页端是错的**，反而更糟。网页端应保持 3-operation facade，改的是 discover 输出形态、超时与确认处理、Instructions 教学。
- 一句话修正：对 ChatGPT **网页端**而言，MyTerminal 的"不友好"来自**运行时可发现性缺失 + 复杂 JSON + 超时/确认产品约束**，而非工具数量或路由模式。

---

## 五、面向网页端的最小改造（对照官方 Production notes）

1. **保持 3-operation facade 不变**（数量友好），但给 `extensionDiscover` / `extensionCall` / `extensionRegister` 写**极具体、带 when-to-use 的 description**（≤300 字/endpoint，参数 ≤700 字），并在 GPT Instructions 里写明"先 discover 再 call"的舞步。
2. **压平 `discover` 输出**：不要一次吐 34 个完整嵌套 schema。改为摘要列表（name + 一句话用途 + 何时用），`includeSchemas` 仅对"即将调用的单个工具"返回扁平参数表，避免巨型嵌套 JSON。
3. **超时与长任务**：`extensionCall` 的服务端设置内部 40s 预算，超时即返回 202/200 的 `status:"running"` + `taskId`，让网页端 45s 内拿到响应；续跑走 `task_poll`。这把"CHECKPOINT/continuation"映射成网页端能消化的轮询契约。
4. **确认摩擦**：在 spec 里对只读型 discover/只读 call 标 `x-openai-isConsequential: false`；但因单 operation 包全部，可考虑把"只读 discover"拆成独立 GET operation（GET 默认不强制确认），只读与变更分离。
5. **错误可恢复**：`CHECKPOINT_REQUIRED` / 业务错误 / 非零退出一律走 **200 body 的 `status` 字段**，不要用 HTTP 400 砸；网页端模型对 200 body 里的结构化错误恢复远好于对 400 的盲猜。
6. **认证**：用 API Key(Bearer) 承载桥访问令牌，identity 走 body（无需自定义 header，符合"不支持自定义 header"限制）；bootstrap 无 identity 阶段用独立 None/可选路径或显式文档说明。

> 总结：比起"换成 34 个工具"或"换成我这种本地 GPT"，**网页端最划算的修法是：保留 facade、压平 discover、把 continuation 改成网页端友好的轮询契约、错误移入 200 body、确认标记显式化**。这样不动 MyTerminal 的"通道+编排"灵魂，却把"网页端不友好"的实打实痛点消掉大半。
