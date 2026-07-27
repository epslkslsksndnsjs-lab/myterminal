# M6：LLM 适配层（llm-adapter.ts + token-counter.ts）——多 provider 统一接入

> ⚠️ **开始前先执行 `git branch --show-current`，确认当前在 `feat/skills` 分支，不要在 `main`（主分支）上开发。** 输出不是 `feat/skills` 就立即停止报告。确认 M1 已验收（`SubagentSettings` 类型）。本任务与 M2-M5 无代码依赖，但按顺序在 M5 之后执行。

- **任务目标**：实现"上层 agent loop 与 LLM 无关"的适配层——三个 provider（OpenAI / Anthropic / DeepSeek）的流式 API 统一成标准 chunk 事件，消息格式归一化，token 估算与上下文窗口管理。**这是唯一跟外部 API 打交道的模块。**
- **ADR 依据**：ADR-0007 决策 1 / 2（适配层完整抽象）、决策 14（API key 环境变量）、决策 21（6 种错误分类）、决策 24（协议约束：归一化 + content 检测 + 配对）、决策 27（流式：增量 JSON + 60s Watchdog + 非流式回退）、决策 29（token 计数 + 窗口表）。
- **前置依赖**：M1。
- **产出**：新建 `src/subagent/token-counter.ts`、`src/subagent/llm-adapter.ts`；新建 `test/subagent-m6.test.mjs`。预估 ~550 行。
- **覆盖率门槛**：**核心级 ≥ 90%**。

---

## 一、必读材料

1. `deliverables/subagent-handoff/README.md`
2. `docs/adr/0007-subagent-executor.md`：决策 1 / 2 / 14 / 21 / 24 / 27（含 `streamTurn` 完整参考代码）/ 29（含 token-counter 与窗口表参考代码）
3. `src/types.ts`（M1）——`SubagentSettings`
4. OpenAI / Anthropic / DeepSeek 的 chat completions API 流式格式（凭你已有的知识实现即可；**测试一律 mock fetch，绝不真调 API**）

## 二、铁律

- **API key 只从环境变量读**（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY`），缺失时抛错消息必须写明"请在 shell profile 中 export XXX_API_KEY"——**绝不接受参数传 key，绝不写文件**。
- **测试中禁止真实网络调用**——所有 adapter 测试用注入的 fake fetch（adapter 构造接受可选 `fetchImpl` 参数，默认 `globalThis.fetch`）。
- HTTP 客户端直接用原生 `fetch`（Bun/Node 18+ 都有），**不引入 axios/node-fetch/SDK**。
- 流式解析 SSE（`data: {...}\n\n`）手写解析器（按行 split + `data: ` 前缀 + `[DONE]` 终止），不引库。
- 错误分类必须按决策 21 的 6 类表，**auth 错误绝不重试**（重试逻辑在 M7，本任务只负责把错误分好类抛出）。

## 三、分步实施

### Step 1：`token-counter.ts`（决策 29）

**严格按 ADR 决策 29 参考代码实现**：

1. `estimateTokens(text)`——`Math.ceil((text.length / 4) * (4 / 3))`（4 chars ≈ 1 token，4/3 安全余量）。
2. `estimateMessageTokens(messages)`——遍历 content block：text / tool_use（JSON.stringify input）/ tool_result / image（固定 2000）；每条消息 +4 overhead。
3. `MODEL_CONTEXT_WINDOWS` 表——照抄 ADR（OpenAI 4 款 / Anthropic 3 款 / DeepSeek 2 款）。
4. `getModelContextWindow(model)`——精确匹配 → 前缀匹配 → 未知默认 64K + `console.warn`。
5. `getAutoCompactThreshold(model)`——`window - Math.min(maxOutput, 20_000) - 13_000`。
6. 统一定义并导出消息类型（llm-adapter 与 M7 共用）：

```typescript
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonObject }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
  | { type: 'image'; /* v1 占位，不实际使用 */ source?: unknown };

export type NormalizedMessage = { role: 'user' | 'assistant'; content: ContentBlock[] };
export type TokenUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
```

### Step 2：`llm-adapter.ts`——统一 chunk 与错误类型（决策 24 + 27 + 21）

```typescript
// 适配器输出的标准流式事件（屏蔽 provider 差异）
export type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; jsonFragment: string }
  | { type: 'tool_call_end'; index: number; id: string }
  | { type: 'message_end'; usage: TokenUsage; stopReason?: string };

// 决策 21：6 种错误分类
export type LlmErrorKind = 'rate_limit' | 'server_overload' | 'auth' | 'prompt_too_long' | 'connection' | 'system';

export class LlmError extends Error {
  constructor(
    public kind: LlmErrorKind,
    message: string,
    public status?: number,        // HTTP 状态码（如有）
    public retryAfterMs?: number,  // 决策 21：优先用 Retry-After 头
  ) { super(message); this.name = 'LlmError'; }
}

export type ChatParams = {
  model: string;
  system: string;
  messages: NormalizedMessage[];
  tools: Array<{ name: string; description: string; input_schema: JsonSchema }>;
  maxTokens: number;
};

export interface LlmAdapter {
  readonly provider: string;
  stream(params: ChatParams, signal: AbortSignal): AsyncGenerator<StreamChunk, void, unknown>;
  create(params: ChatParams, signal: AbortSignal): Promise<{ message: NormalizedMessage; usage: TokenUsage }>;  // 非流式回退
}
```

### Step 3：`llm-adapter.ts`——消息归一化（决策 24）

实现 `normalizeMessages(messages: NormalizedMessage[]): NormalizedMessage[]`：
1. 合并连续同 role 消息（content 数组拼接）。
2. 保证 user/assistant 交替（tool_result 包在 user 消息里，天然满足；若出现两条连续 assistant，中间插一条空 user？——**不要**，合并即可）。
3. **tool_use/tool_result 配对检查**：收集所有 tool_use id 与 tool_result id，孤儿 tool_use 自动补 `{ type: 'tool_result', tool_use_id, content: 'Tool execution was interrupted. The tool may or may not have completed.', is_error: true }` 追加到末尾 user 消息（决策 24 + 37——**这是发送前的最后一道防线**，M7 循环内还有一道）。
4. 导出供 M7 复用。

### Step 4：三个 provider 适配器

每个适配器是一个 class/factory，实现 `LlmAdapter` 接口：

**OpenAIAdapter**（也复用于 DeepSeek，见下）：
- 端点 `https://api.openai.com/v1/chat/completions`，`stream: true`。
- 请求转换：NormalizedMessage → OpenAI messages（system 单独字段；tool_use → `tool_calls`；tool_result → `role: 'tool'` + `tool_call_id`）；tools → OpenAI `tools: [{ type: 'function', function: { name, description, parameters } }]`。
- 响应解析：SSE 逐 chunk——`choices[0].delta.content` → `text_delta`；`delta.tool_calls[i]`（`function.name` 首次出现 → `tool_call_start`；`function.arguments` 片段 → `tool_call_delta`；finish_reason=`tool_calls` 时把累积的 index 关闭发 `tool_call_end`）；`usage`（需请求里带 `stream_options: { include_usage: true }`）→ `message_end`。
- **content 检测**（决策 24）：解析完成后，判定"是否含 tool_call"看累积的 tool_call buffer 数量 > 0，**不看 stop_reason**（把 stopReason 仅作信息透传）。

**AnthropicAdapter**：
- 端点 `https://api.anthropic.com/v1/messages`，headers `x-api-key` + `anthropic-version: 2023-06-01`，`stream: true`。
- 请求转换：system 顶层字段；messages（tool_result 在 user 消息的 content block）；tools → `tools: [{ name, description, input_schema }]`。
- 响应解析：`content_block_start`（`tool_use` → tool_call_start）/ `content_block_delta`（`text_delta` → text_delta；`input_json_delta` → tool_call_delta）/ `content_block_stop` → tool_call_end / `message_delta`（usage）+ `message_stop` → message_end。

**DeepSeekAdapter**：OpenAI 兼容协议——直接继承/复用 OpenAIAdapter，只换 baseURL（`https://api.deepseek.com/v1`）与环境变量名（`DEEPSEEK_API_KEY`）。

**公共部分抽成内部辅助**：SSE 行解析器、HTTP 错误分类函数：

```typescript
function classifyHttpError(status: number, body: string): LlmError {
  // 429 → rate_limit（解析 Retry-After 头/体）
  // 529 → server_overload
  // 401/403 → auth（"API key 无效或过期，请检查环境变量"）
  // 400 且 body 含 'prompt is too long' / 'context_length' → prompt_too_long
  // 其他 5xx → server_overload；其他 → system
}
function classifyNetworkError(err: unknown): LlmError {
  // fetch reject（TypeError/ECONNRESET/ETIMEDOUT/AbortError 非用户触发）→ connection
  // 用户 signal.aborted 触发 → 原样抛出 AbortError（不包装！M7 靠它识别 abort）
}
```

### Step 5：流式 Watchdog + 非流式回退（决策 27）

在适配层导出高阶函数（M7 executor 直接用它，而不是裸调 `adapter.stream`）：

```typescript
export const STREAM_IDLE_TIMEOUT_MS = 60_000;  // 决策 27：60s 无事件 → 超时

export async function collectStream(params: {
  adapter: LlmAdapter;
  chatParams: ChatParams;
  signal: AbortSignal;                        // 外层 subagent 总信号
  onChunk: (chunk: StreamChunk) => void;      // M7 注入，转 AG-UI 事件
  idleTimeoutMs?: number;                     // 测试可注入短超时
}): Promise<{ message: NormalizedMessage; usage: TokenUsage; hadToolCalls: boolean }> {
  // ① Watchdog：每收到 chunk 重置计时器；超时 → 内部 controller abort 流 + 抛 LlmError('connection', 'Stream idle timeout')
  // ② text_delta → textBuffer 累积；tool_call_* → Map<index, {id, name, json}> 累积（不 partialParse）
  // ③ message_end → 组装 NormalizedMessage（text + tool_use blocks，tool_use.input = JSON.parse(累积json)，解析失败 → is_error 文本降级 + 注释说明）
  // ④ 流式中途抛错（网络断/JSON 坏）且"尚未产出任何完整 tool_call"→ 回退 adapter.create() 重试一次（决策 27 防双重执行：executedToolUseIds 语义在本层简化为"tool_call_end 是否发生过"，发生过则不回退直接抛）
  // ⑤ finally clearTimeout(watchdog)
  // 返回 hadToolCalls = tool_use blocks.length > 0（content 检测，决策 24）
}
```

### Step 6：工厂 + 配置解析（决策 14）

```typescript
export function createAdapter(settings: SubagentSettings, env: NodeJS.ProcessEnv = process.env): LlmAdapter {
  // provider → 对应适配器；API key 从 env 读，缺失抛错（消息写明 export 哪个变量）
  // model 用 settings.model；fallbackModel 存到 adapter 上供 M7 决策 21 的 529 降级使用
}
```

### Step 7：编写测试 `test/subagent-m6.test.mjs`

**全部 mock fetch**（构造 `fetchImpl` 返回 `new Response(sseText)` / 抛网络错误）。**≥ 20 用例**：

**token-counter**：
1. `estimateTokens('abcd')` = `Math.ceil(1 * 4/3)` = 2；空串 = 0。
2. `estimateMessageTokens` 含 tool_use/tool_result/image 的混合消息计数正确（手算对照）。
3. 窗口表精确/前缀/未知三档；`getAutoCompactThreshold('gpt-4o')` = 128000 − 16384 − 13000 = 92616（按表验算）。

**归一化**：
4. 连续同 role 合并；tool_result 留在 user 消息。
5. 孤儿 tool_use 自动补 interrupted tool_result。

**OpenAIAdapter**：
6. 请求体转换正确（system/messages/tools 格式；tool_result → role:'tool'）。
7. SSE 文本流：`data: {"choices":[{"delta":{"content":"你"}}]}` ×2 + `[DONE]` → text_delta ×2，最终 message 含完整文本。
8. tool_calls 流：name 首帧 → tool_call_start；arguments 分 3 帧 → tool_call_delta ×3；finish → tool_call_end；最终 input 是累积 JSON 的 parse 结果。
9. `include_usage` 请求带上了；usage 进入 message_end。
10. **content 检测**：stopReason='stop' 但有 tool_call 帧 → hadToolCalls=true（不看 stop_reason）。

**AnthropicAdapter**：
11. 请求头 `x-api-key` + `anthropic-version`；body 转换（tool_result content block）。
12. `content_block_start/delta/stop` 事件流转标准 chunk；`input_json_delta` 累积 parse。

**错误分类**：
13. 429 + `Retry-After: 3` → kind='rate_limit'，retryAfterMs=3000。
14. 401 → kind='auth'（消息含"API key"）；529 → 'server_overload'；400 含 'prompt is too long' → 'prompt_too_long'。
15. fetch reject（TypeError: fetch failed）→ kind='connection'。
16. **abort 不被包装**：signal.abort() 后流的 AbortError 原样抛出（kind 字段不存在）。

**Watchdog + 回退**：
17. mock fetch 返回一个"发一个 chunk 后永远挂起"的流 + idleTimeoutMs=50 → 抛 'Stream idle timeout'（connection）。
18. 流式中途网络断（已产出完整 tool_call_end）→ **不回退**，直接抛（防双重执行）。
19. 流式开头就失败（0 个 chunk）→ 自动回退 create() 一次成功（fake fetch 第一次 reject、第二次返回非流式 JSON）。
20. **集成用例**：构造完整两轮对话——第 1 轮 LLM 流式返回 tool_call（fake fetch #1）→ 组装 tool_use blocks → 第 2 轮带 tool_result 的消息归一化后再流式返回纯文本（fake fetch #2）→ hadToolCalls=false，message 文本完整，usage 两轮都拿到。

### Step 8：覆盖率 + 变异测试

`bun test --coverage test/subagent-m6.test.mjs` **≥ 90%**。

**变异体清单**：

| # | 变异体 | 杀死它的测试 |
|---|--------|-------------|
| 1 | `estimateTokens` 的 4/3 余量删掉 | 用例 1 |
| 2 | compact 阈值 13_000 改 12_999 | 用例 3 |
| 3 | 429 分类改成 server_overload | 用例 13 |
| 4 | auth 错误允许重试标记（kind 改 connection） | 用例 14 |
| 5 | Watchdog 不重置（只在启动时设一次） | 用例 17 的变体（多 chunk 后挂起） |
| 6 | 回退条件删掉"无完整 tool_call"判断（总会回退） | 用例 18 |
| 7 | 配对补齐删掉（孤儿 tool_use 直接发） | 用例 5 |
| 8 | OpenAI 的 `include_usage` 去掉 | 用例 9 |

### Step 9：全量回归

`bun run test` 全量 0 fail。

## 四、验收清单（DoD）

- [ ] 在 `feat/skills` 分支
- [ ] 三适配器实现 LlmAdapter 接口；API key 只走环境变量且缺失时报错消息含 export 指引
- [ ] 测试零真实网络（全部 fake fetch）；abort 原样透传不包装
- [ ] content 检测退出（不看 stop_reason）；Watchdog 60s；回退防双重执行
- [ ] 归一化含孤儿 tool_use 补齐；token 估算/窗口表/阈值与 ADR 一致
- [ ] 测试 ≥ 20 用例全过；**覆盖率 ≥ 90%**；变异体 8/8 被杀死
- [ ] `bun run typecheck` 0 errors；`bun run test` 全量 0 fail
- [ ] 未提交 git commit

## 五、交接给 M7

1. `collectStream` 的完整签名（M7 agent loop 每轮调它）+ `hadToolCalls` 语义。
2. `LlmError.kind` 的 6 类与 `retryAfterMs`——M7 的错误恢复按 kind 分派。
3. `createAdapter(settings, env)` 与 adapter 上的 `fallbackModel` 暴露方式。
4. `normalizeMessages` 的导出路径（M7 发送前最后一道配对防线复用它）。
