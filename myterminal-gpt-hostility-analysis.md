# MyTerminal 工具面为何对 GPT 不友好（OpenAI 官方文档对照）

> 用户原话："他的工具欠套在欠套一层包一层，再加一个 http 工具参数返回全部包起来，让模型自己去找。你们是一点都不友好…… 对 GPT 我不知道，所以你要去查一下。"
> 本文用 OpenAI 官方文档（Function Calling 指南 + GPT Actions 文档）逐条核对，证明上述抱怨成立，且是**结构性的 agent-hostile**，对 GPT 尤甚。

---

## 一、GPT 到底怎么"用工具"——OpenAI 的真实机制

### 1. GPT Actions：每个 API operation = 一个原生工具
OpenAI 官方说明（help.openai.com / developers.openai.com）：
- GPT Action 的 schema 告诉 ChatGPT：**有哪些端点可用、各自接受什么参数、用 operationId 标识**。
- "ChatGPT uses those names and descriptions to understand (a) which API action should be called and (b) which parameter should be used."
- 即：**每个 path+operation 在 ChatGPT 里是一个独立、可见、自带 schema 的工具**，模型原生选择、可并行调用。

### 2. Function Calling 最佳实践（developers.openai.com/api/docs/guides/function-calling）
- 写**清晰详细的函数名、参数描述、用途说明**；让函数"obvious and intuitive"（最小惊讶原则）。
- 用 **enum 让非法状态不可表示**（如 `toggle_light(on, off)` 这种双布尔是被点名的反例）。
- **初始可用工具控制在 ~20 个以内**；工具太多模型会懵——大工具面用 **tool search 延迟加载**，而不是全量铺开。
- **别让模型替你编排/路由**：总连着调用的工具应合并成一个；把决策交给代码。
- **错误用结构化 200 body 返回 `status: success/not_found/error`**，让模型能可靠分支恢复；不要靠 HTTP 状态码表达业务语义。
- 函数定义注入 system message，**每个都占上下文、按 input token 计费**。
- 模型一次可返回**多个 tool_calls（并行）**，每个带 id + name + JSON 参数。

---

## 二、MyTerminal 实际怎么做的（逐条对照，证明它反着来）

### ❌ 反例 1：37 个真工具被藏进 1 个 `extensionCall` 路由函数
- OpenAPI spec 里 MyTerminal 只暴露 **3 个 operation**：`extensionDiscover` / `extensionRegister` / `extensionCall`（`src/openapi.ts`）。
- 真正能干的 37 个 builtin 工具**不在 spec 里**，全部塞进 `extensionCall` 的 `tool: string` 字段后面。
- 这是教科书级的 **"god-function / router anti-pattern"**：OpenAI 明确建议"别让模型路由/编排"，应把每个能力做成独立函数。MyTerminal 恰恰把所有能力压成一个字符串选择器。

### ❌ 反例 2：schema 不在 spec 里，要运行时 discover 才拿到 → "让模型自己去找"
- OpenAI 要求"把 schema 写清楚、最小惊讶、别让模型猜"。
- MyTerminal 默认 `extensionDiscover`（不带 `includeSchemas`）只返回工具**名字列表**，不含参数形状；要 `includeSchemas:true` 才返回 schema。
- 即模型必须**先发一次 discover、再解析一大坨 JSON、自己挑工具、自己猜参数结构**——这正是用户说的"包起来让模型自己去找"。
- 更糟：37 个工具的 schema 全挤在一个 discover 响应里，直接炸上下文/ token（OpenAI 明说函数定义占上下文并计费）。

### ❌ 反例 3：`tool` 的合法值根本不在 OpenAPI schema 中（动态）
- OpenAI 强调用 enum 让非法状态不可表示，且 GPT Actions 靠 schema 知道"有哪些 action 可选"。
- MyTerminal 的 `extensionCall.tool` 是个自由字符串（`pattern` 校验格式，但**没有 enum 列出 37 个合法名**），合法工具名只有运行时 discover 才知道。
- 后果：GPT **在 schema 层面连"有哪些工具"都不知道**，必须先 discover 才能填 `tool`——把"工具发现"的负担整个推给模型。

### ❌ 反例 4：一个 HTTP 状态码被 overloaded 表达多种业务语义
- OpenAI 建议错误用 200 body 的结构化 `status` 字段，让模型干净恢复。
- MyTerminal 把 `CHECKPOINT_REQUIRED` 用 **HTTP 400** 返回给**任意** `extensionCall`（连只读的 discover / skill 列表都中招）。
- 400 同时承载三种含义：参数非法 / 该交 checkpoint / 非零退出。模型无法从状态码区分"我参数错了"还是"你先去 checkpoint"——恢复路径全靠猜。
- 还有 `NON_ZERO_EXIT` 这种含糊码；continuation 的 `mustContinue` 也塞进响应体强制模型续做，不是 function calling 的训练方式。

### ❌ 反例 5：身份/审计负担整个压到模型身上
- GPT Actions 原生支持 OAuth / API Key，认证由传输层处理，模型不必管 token。
- MyTerminal 要求**每次 mutating 调用都带 `identity={sessionId, sessionToken}`**，且 bootstrap 类调用（session_register/inherit）要"省略 identity 键、不能传 null/{}"——这种边界条件不在工具描述里声明，模型踩了才 400。
- 相当于把"会话身份、handoff 码、审计"这些本该是系统/传输层的事，全变成模型要记住的参数。

---

## 三、为什么这么设计（理解动机，但不等于合理）

MyTerminal 选 router 模式有它的理由，只是代价全由模型承担：
1. **spec 极小**：只 3 个 operation，GPT Actions 编辑器一眼通过校验。
2. **支持运行时 `extensionRegister` 动态增删工具**：固定铺 37 个 operation 就做不到热注册。
3. **统一身份/审计/continuation 总线**：所有调用走同一条带 bearer 的管道。

也就是说，它为了"小 spec + 动态扩展 + 统一编排"，把**工具可发现性、schema 可见性、错误可恢复性**全牺牲了——而这三点恰恰是 OpenAI 反复强调的 agent 友好底线。

---

## 四、怎么改才对 GPT 友好（具体建议）

### 方案 A（最对 GPT 友好）：把 37 工具直接铺成 37 个 GPT Action operation
- 每个工具一条 path + operationId，自带完整 JSON Schema。
- GPT 原生看见、原生选择、可并行；完全消除 discover 往返与 `tool` 字符串路由。
- 取舍：spec 变大、失去运行时热注册（可用"基础 37 个铺开 + 少量 extensionRegister 管理"混合）。

### 方案 B（保留动态，但补 agent 友好）：最小改动
- `extensionCall.tool` 改成 **enum，把当前所有合法工具名写死进 schema**（或 discover 返回的目录作为补充）。
- **默认 discover 就带 schema**（去掉 `includeSchemas` 这个额外开关，或默认 true）——别逼模型多猜一轮。
- `CHECKPOINT_REQUIRED` / continuation / 业务错误**放进 200 body 的 `status` 字段**，而非 HTTP 400；保留 400 只给真正的参数非法。
- 把"bootstrap 调用省略 identity"这类边界写进对应工具 description，别让模型踩坑才知道。

### 方案 C（官方推荐的延迟加载姿势）
- 若担心 >20 工具掉精度，用 OpenAI 的 **tool search / deferred load**：先暴露少量入口，模型需要时再拉取具体工具 schema——但实现为**原生 deferred 工具**，不是"运行时一大坨 JSON blob + 一个 router 调用"。

---

## 五、结论

用户的直觉完全正确，且有 OpenAI 文档背书：
- MyTerminal 把 **37 个能力 → 3 个 operation → 1 个 router 字符串 + 1 个 discover JSON blob**，把"工具发现、schema 解析、错误恢复、身份携带"四件事全推给模型自己搞定。
- 这违反了 OpenAI function calling 的每一条核心建议（清晰 schema、别让模型路由、enum 防错、结构化错误、认证走传输层）。
- 对 GPT 尤甚：GPT Actions 的整个设计前提就是"每个 operation 一个原生工具"，而 MyTerminal 恰恰把 operation 压没了。
- 本质：**为"小 spec + 动态注册"优化了系统侧，却把认知成本 100% 转嫁给模型**。改起来不难（方案 B 是最小改动且立竿见影）。

> 附：本分析可与 `system-tools-vs-gpt-comparison.md` 对照看——那篇讲"换成我这种本地 GPT 的影响"，这篇讲"即使不换、原样给 GPT 用也已经是 hostile 设计"。
