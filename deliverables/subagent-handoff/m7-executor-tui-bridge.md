# M7：核心执行器 + TUI 桥（executor.ts + tui-bridge.ts）——agent loop 心脏

> ⚠️ **开始前先执行 `git branch --show-current`，确认当前在 `feat/skills` 分支，不要在 `main`（主分支）上开发。** 输出不是 `feat/skills` 就立即停止报告。确认 M1-M6 全部验收通过（本任务是所有模块的集大成者）。

- **任务目标**：实现 subagent 的心脏——agent loop（LLM ↔ tool 循环），含 3 层 compact、6 类错误恢复、Circuit Breaker、tool_result 配对保证、成本聚合、AG-UI 事件发射；以及 TUI 通信桥（EventEmitter + 14 种事件）。
- **ADR 依据**：ADR-0007 决策 5（退出策略）、决策 8（生命周期 finally）、决策 9（无上下文）、决策 12（system prompt）、决策 15-16（错误处理/禁止嵌套）、决策 20（3 层 compact + 熔断）、决策 21（错误恢复 + Circuit Breaker）、决策 22（成本）、决策 24（content 检测退出）、决策 25（Abort 策略）、决策 29（token 校准）、决策 37（配对保证）；ADR-0008 决策 1 / 2（14 种事件 + EventEmitter）。
- **前置依赖**：M2（store/file-state/shell-tracker/cost-tracker）、M3（result-budget）、M4（tools）、M5（tool-executor）、M6（llm-adapter/token-counter）。
- **产出**：新建 `src/subagent/tui-bridge.ts`、`src/subagent/executor.ts`；新建 `test/subagent-m7.test.mjs`。预估 ~700 行。
- **覆盖率门槛**：**核心级 ≥ 90%**。

---

## 一、必读材料

1. `deliverables/subagent-handoff/README.md`
2. `docs/adr/0007-subagent-executor.md`：决策 5 / 8 / 9 / 12 / 20 / 21 / 25 / 29 / 37 + 「7. executor.ts 中的调用集成」节
3. `docs/adr/0008-subagent-tui-bridge.md`：决策 1（14 种事件映射表 + 事件流示例）/ 决策 2（EventEmitter 实现草图）
4. M2 / M5 / M6 交付总结（store 函数、`executeToolCalls` 签名、`collectStream` 签名、`LlmError.kind`）

## 二、铁律

- **subagent 无上下文**（决策 9）：初始消息 = system prompt + 任务描述，不携带任何父 AI 历史；执行完 messages 释放。
- **退出检测用 content 检测**（决策 24）：`collectStream` 返回的 `hadToolCalls === false` 才退出，不看 stop_reason。
- **任何路径下 tool_use 必须有配对 tool_result**（决策 37）：每轮 API 调用前跑 `ensureToolResultPairing`。
- **finally 清理顺序固定**（决策 8）：① `cleanupAgentShellTasks(agentId)` → ② `clearFileState(agentId)` → ③ 发 `RUN_FINISHED`/`RUN_ERROR` 事件 → ④ 更新 store 终态。缺一不可。
- **adapter 可注入**：`runSubagent(options)` 接受可选 `adapter` 参数（默认 `createAdapter(settings)`）——M8 集成测试与 M7 单测都靠它注入 fake，**这是硬性设计要求**。
- 本任务**不实现预算强制**（ADR-0009 决策 14：成本只追踪不限制）——CostTracker 只记账。
- 禁止嵌套（决策 16）：executor 不需要做任何事——8 个工具里没有 subagent_start，天然防递归（M8 还有 invoke 层防线）。

## 三、分步实施

### Step 1：`tui-bridge.ts`（ADR-0008 决策 1 + 2）

```typescript
import { EventEmitter } from 'node:events';

// ADR-0008 决策 1：14 种事件（不发 MESSAGES_SNAPSHOT）
export type AgUiEventType =
  | 'RUN_STARTED' | 'RUN_FINISHED' | 'RUN_ERROR'
  | 'TEXT_MESSAGE_START' | 'TEXT_MESSAGE_CONTENT' | 'TEXT_MESSAGE_END'
  | 'TOOL_CALL_START' | 'TOOL_CALL_ARGS' | 'TOOL_CALL_END' | 'TOOL_CALL_RESULT'
  | 'STATE_SNAPSHOT' | 'STATE_DELTA'
  | 'STEP_STARTED' | 'STEP_FINISHED';

export type AgUiEvent = {
  subagentId: string;
  type: AgUiEventType;
  data?: Record<string, unknown>;
  timestamp: number;
};

// ADR-0008 决策 2：进程内 EventEmitter（同进程，不用 SSE/WebSocket）
export const subagentEvents = new EventEmitter();
subagentEvents.setMaxListeners(50);  // TUI 多组件监听，注释说明

export function emitAgUi(subagentId: string, type: AgUiEventType, data?: Record<string, unknown>): void {
  subagentEvents.emit('ag-ui', { subagentId, type, data, timestamp: Date.now() } satisfies AgUiEvent);
}
```

**可选**：若主理人批准安装 `@ag-ui/core`，可用其类型替代本地声明；默认**不装依赖**，用上面的本地声明（README 已说明）。

### Step 2：`executor.ts`——system prompt（决策 12）

```typescript
function getSubagentSystemPrompt(task: string, toolNames: string[], cwd: string): string {
  // 照 ADR 决策 12 参考代码组装：角色定义 + 工具清单 + 环境（cwd/platform）+ 任务
  // 追加两段硬编码行为规范：
  //  - "Always read a file before editing it. Use task_create/task_update to track progress."
  //  - "When all work is done, reply with a concise final summary and no tool calls."
}
```

### Step 3：`executor.ts`——compact 三层（决策 20）

```typescript
const COMPACTABLE_TOOLS = new Set(['execute_cli', 'read_file', 'grep', 'glob']);
const KEEP_RECENT_TOOL_RESULTS = 5;      // 微压缩保留最近 5 个
const MAX_COMPACT_FAILURES = 3;          // 熔断器

function microCompact(messages: NormalizedMessage[]): NormalizedMessage[] {
  // 从后往前数，保留最近 5 个 tool_result 原样；
  // 更早的、且工具名 ∈ COMPACTABLE_TOOLS 的 tool_result.content 替换为 '[此工具结果已被微压缩清理]'
  // write_file/edit_file/task_* 的结果不压缩（小且重要）
}

async function autoCompact(messages, adapter, model, onEvent): Promise<NormalizedMessage[]> {
  // 调 LLM 摘要（非流式 adapter.create，system 用摘要专用 prompt：
  //   "Summarize the conversation so far, preserving: task goal, files modified, key decisions, current progress.")
  // 返回新 messages：[summaryUserMessage] + 最近 2 轮原文
  // summary 格式（Compact Boundary，决策 20）：
  //   [对话摘要]\n{summary}\n[摘要结束]
}
```

### Step 4：`executor.ts`——错误恢复（决策 21）

```typescript
function classifyAndShouldRetry(err: LlmError): { retry: boolean; delayMs: number; action?: 'compact' | 'fallbackModel' } {
  // rate_limit → retry，指数退避 500ms × 2^n + jitter(0-100ms)，上限 32s；err.retryAfterMs 优先
  // server_overload → retry 3 次后 action: 'fallbackModel'（若 adapter 配了 fallbackModel）
  // auth → 不 retry，直接失败（"API key 无效或过期"）
  // prompt_too_long → 不 retry，action: 'compact'（响应式压缩后重试 1 次）
  // connection → retry 3 次，指数退避
  // system → 不 retry，直接失败
}

// Circuit Breaker（决策 21）：连续 5 次 LLM API 失败 → 熔断 30s（直接抛错），之后允许一次半开探测
class CircuitBreaker { /* recordSuccess / recordFailure / assertClosed */ }
```

### Step 5：`executor.ts`——主循环 `runSubagent`（决策 5 + 8 + 20 + 21 + 24 + 29 + 37）

```typescript
export type RunSubagentOptions = {
  agentId: string;
  task: string;                       // 任务描述（M8 从 objective+background+deliverables 组装）
  cwd: string;
  settings: SubagentSettings;         // M1 类型
  readOnly?: boolean;                 // 决策 17：只读模式
  adapter?: LlmAdapter;               // ★ 可注入（测试/M8 用），缺省 createAdapter(settings)
  onEvent?: (event: AgUiEvent) => void; // 缺省走 emitAgUi
};

export type SubagentRunResult =
  | { status: 'completed'; result: string }
  | { status: 'failed'; error: string }
  | { status: 'aborted'; error: string };

export async function runSubagent(options: RunSubagentOptions): Promise<SubagentRunResult> {
  const { agentId, task, cwd, settings } = options;
  const adapter = options.adapter ?? createAdapter(settings);
  const emit = (type, data?) => (options.onEvent ?? emitAgUi)({ subagentId: agentId, type, data, timestamp: Date.now() });

  const record = getSubagent(agentId);  // M2 store（M8 已 create；不存在则本函数自建——注释说明两种入口）
  const abortController = record?.abortController ?? new AbortController();
  const costTracker = new CostTracker(settings.model);
  const breaker = new CircuitBreaker();
  const toolNames = getToolNames({ readOnly: options.readOnly ?? false });  // 决策 17 第 1 层
  const tools = getAllToolSchemas().filter(s => toolNames.includes(s.name));

  // 超时（决策 5：默认 settings.timeoutSec=300s）与 abort 组合（决策 25：AbortSignal.any）
  const timeoutSignal = AbortSignal.timeout(settings.timeoutSec * 1000);
  const signal = AbortSignal.any([abortController.signal, timeoutSignal]);
  const ctx: SubagentToolContext = { cwd, signal, agentId, readOnly: options.readOnly };

  // 决策 9：无上下文——初始消息只有任务
  let messages: NormalizedMessage[] = [
    { role: 'user', content: [{ type: 'text', text: task }] },
  ];
  const system = getSubagentSystemPrompt(task, toolNames, cwd);

  let compactFailures = 0;
  let reactiveCompactUsed = false;   // 决策 21：prompt_too_long 只压缩重试 1 次

  emit('RUN_STARTED', { task: task.slice(0, 200) });

  try {
    let turns = 0;
    while (turns < settings.maxTurns) {          // 决策 5：maxTurns 兜底
      if (signal.aborted) return finishAborted(); // abort/timeout 检查点
      turns++;
      emit('STEP_STARTED', { turn: turns });

      // ── compact 第 1 层：微压缩（零成本）──
      messages = microCompact(messages);
      // ── compact 第 2 层：autocompact（估算超阈值）──
      if (estimateMessageTokens(messages) > getAutoCompactThreshold(settings.model)) {
        try { messages = await autoCompact(messages, adapter, settings.model, emit); clearFileState(agentId); compactFailures = 0; }
        catch { if (++compactFailures >= MAX_COMPACT_FAILURES) return finishFailed('Compact circuit breaker: 3 consecutive failures'); }
      }
      // ── 决策 37：发送前配对检查（最后一道防线）──
      messages = normalizeMessages(messages);   // M6：含孤儿 tool_use 补齐

      // ── 调 LLM（含错误恢复）──
      let streamResult;
      try {
        breaker.assertClosed();
        streamResult = await collectStream({
          adapter,
          chatParams: { model: settings.model, system, messages, tools, maxTokens: getModelContextWindow(settings.model).maxOutput },
          signal,
          onChunk: chunk => {  // AG-UI 流式事件（ADR-0008 决策 1）
            if (chunk.type === 'text_delta') emit('TEXT_MESSAGE_CONTENT', { delta: chunk.text });
            if (chunk.type === 'tool_call_start') emit('TOOL_CALL_START', { name: chunk.name });
            if (chunk.type === 'tool_call_delta') emit('TOOL_CALL_ARGS', { delta: chunk.jsonFragment });
          },
        });
        breaker.recordSuccess();
      } catch (err) {
        breaker.recordFailure();
        const decision = classifyAndShouldRetry(err as LlmError);
        // prompt_too_long → 响应式压缩重试 1 次（决策 20 第 3 层 + 决策 21）
        // fallbackModel → 换 adapter.model 重试
        // retry → await sleep(decision.delayMs) 后 continue（turns 不额外扣——注释说明）
        // 不可恢复 → return finishFailed(...)
      }

      // ── 成本聚合（决策 22 + 29：精确值校准）──
      costTracker.addUsage(streamResult.usage);
      updateCost(agentId, costTracker.getUsage());  // M2 store

      // ── 决策 24：content 检测退出 ──
      const assistantMsg = streamResult.message;
      messages.push(assistantMsg);
      if (!streamResult.hadToolCalls) {
        emit('TEXT_MESSAGE_END', {});
        emit('STEP_FINISHED', { turn: turns });
        const resultText = assistantMsg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        return finishCompleted(resultText);   // 决策 5：正常完成
      }

      // ── 执行工具（M5）──
      const toolCalls = assistantMsg.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ id: b.id, name: b.name, input: b.input }));
      const toolResults = await executeToolCalls(toolCalls, ctx, (e) => {
        // M5 事件 → AG-UI 映射（TOOL_CALL_RESULT 等）
        emit(e.type as AgUiEventType, e.data as Record<string, unknown>);
      });
      messages.push({
        role: 'user',
        content: toolResults.map(r => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.content, is_error: r.is_error })),
      });

      // task 状态同步事件（ADR-0008：STATE_SNAPSHOT 在 task_create 后、STATE_DELTA 在 task_update 后）
      // 简化实现：每轮工具执行后，若本轮调用过 task_* → emit('STATE_SNAPSHOT', { tasks: getSubagent(agentId)?.tasks })
      emit('STEP_FINISHED', { turn: turns });
    }
    return finishFailed(`Max turns reached (${settings.maxTurns})`);  // 决策 5
  } catch (err) {
    if (signal.aborted) return finishAborted();
    return finishFailed((err as Error).message);
  } finally {
    // 决策 8：清理顺序固定
    cleanupAgentShellTasks(agentId);   // ① 杀 shell 进程组
    clearFileState(agentId);           // ② 清文件状态缓存
    messages.length = 0;               // ③ 释放 messages（决策 9）
    // ④ 终态事件与 store 更新在 finishCompleted/finishFailed/finishAborted 里做
  }
}
```

三个 finish 辅助函数语义：
- `finishCompleted(result)`：`updateSubagentStatus(agentId, 'completed', { result })` + `emit('RUN_FINISHED', { result: result.slice(0, 500), cost })` → 返回 `{ status: 'completed', result }`。
- `finishFailed(error)`：`updateSubagentStatus(agentId, 'failed', { error })` + `emit('RUN_ERROR', { error })` → `{ status: 'failed', error }`。
- `finishAborted()`：区分 abort 来源——`timeoutSignal.aborted` → `'failed', error: 'Timeout after Ns'`；用户 abort → `'aborted', error: 'Aborted by parent'`。事件发 `RUN_ERROR`（data 里带 reason）。

### Step 6：编写测试 `test/subagent-m7.test.mjs`

**核心手法：fake adapter**——构造脚本化 LLM（队列里预排响应：第 1 轮返回 tool_use(read_file)，第 2 轮返回纯文本……），真实走 M4/M5 的工具链（临时目录真文件）。**≥ 18 用例**：

**tui-bridge**：
1. `emitAgUi` 发出的事件 listener 收到且含 subagentId/type/timestamp；两个不同 subagentId 互不串台。

**正常路径**：
2. 一轮完成：fake adapter 直接返回纯文本 → status='completed'，result 文本正确，事件序 RUN_STARTED→STEP_STARTED→TEXT_MESSAGE_CONTENT→RUN_FINISHED。
3. 两轮带工具：第 1 轮 read_file（临时文件真实读取）→ 第 2 轮文本 → completed；断言 tool_result 已配对（normalizeMessages 后的 messages 无孤儿）。
4. **content 检测**：fake adapter 返回 stopReason='stop' 但含 tool_use → **不退出**，继续执行工具（决策 24 回归）。

**退出条件**：
5. maxTurns：fake adapter 永远返回 tool_use → 跑满 maxTurns（注入 maxTurns=3）→ failed + 错误含 `Max turns`。
6. abort：外部 `abortController.abort()` → status='aborted'；finally 清理执行（shell-tracker/file-state 断言）。
7. timeout：注入 timeoutSec=1 + fake adapter 卡 3s → failed + 含 `Timeout`。
8. shell 清理回归：任务中 execute_cli 起 `sleep 60` 后被 abort → finally 后进程已死（轮询验证）。

**compact**：
9. 微压缩：构造 8 个 tool_result 的消息历史，前 3 个被替换为 `[此工具结果已被微压缩清理]`，最近 5 个保留；task_* 结果不被压。
10. autocompact 触发：fake token 估算超阈值（注入小窗口 model 或构造大消息）→ adapter 收到摘要请求 → messages 含 `[对话摘要]`边界 + clearFileState 被调（edit_file 之后需重新 read）。
11. compact 熔断：fake adapter 摘要连续失败 3 次 → failed + 含 `Compact circuit breaker`。
12. 响应式压缩：第 1 次 collectStream 抛 prompt_too_long → 压缩后重试 1 次成功 → completed；第 2 次还抛 → failed。

**错误恢复**：
13. rate_limit ×2 后成功：重试间隔递增（fake timer 或断言 retryAfterMs 被使用）；最终 completed。
14. auth 错误 → **零重试**直接 failed + 含 `API key`。
15. connection ×3 → failed；Circuit Breaker：连续 5 次失败后第 6 次直接熔断（30s 内不再真调 adapter——fake adapter 调用次数断言）。
16. 529 ×3 → 切换 fallbackModel（fake adapter 断言第 4 次调用的 model 变了）。

**成本与配对**：
17. costTracker 聚合两轮 usage；`getSubagent(agentId).cost.totalUSD > 0`。
18. **决策 37 回归**：fake adapter 第 1 轮返回 2 个 tool_use，工具执行阶段人为 abort → 下一轮（若恢复）messages 里孤儿 tool_use 已补 interrupted tool_result（或直接在 abort 路径断言配对函数被调用）。
19. **集成用例**：完整任务——fake adapter 脚本（read → edit → task_create → task_update → execute_cli `echo done` → 文本总结），全程真文件真进程，断言：completed、result 含总结、store 终态 completed、审计日志 ≥ 5 条、事件流含 STATE_SNAPSHOT、成本 > 0、临时文件内容真的被改了。

### Step 7：覆盖率 + 变异测试

`bun test --coverage test/subagent-m7.test.mjs` **≥ 90%**。

**变异体清单**：

| # | 变异体 | 杀死它的测试 |
|---|--------|-------------|
| 1 | content 检测换成 stop_reason 检测 | 用例 4 |
| 2 | maxTurns 判断 `turns < maxTurns` 改 `<=` | 用例 5 |
| 3 | 微压缩保留 5 个改 4 个 | 用例 9 |
| 4 | auth 错误也重试 | 用例 14 |
| 5 | Circuit Breaker 阈值 5 改 6 | 用例 15 |
| 6 | finally 里删掉 cleanupAgentShellTasks | 用例 8 |
| 7 | compact 熔断 3 次改 4 次 | 用例 11 |
| 8 | abort 与 timeout 不分（都报 aborted） | 用例 7 |
| 9 | normalizeMessages（配对检查）从循环里删掉 | 用例 18 |

### Step 8：全量回归

`bun run test` 全量 0 fail。

## 四、验收清单（DoD）

- [ ] 在 `feat/skills` 分支；M1-M6 产物在位
- [ ] tui-bridge 14 种事件（无 MESSAGES_SNAPSHOT）+ EventEmitter
- [ ] agent loop：content 检测退出 / maxTurns / abort / timeout 四路全部正确
- [ ] 3 层 compact + 熔断 + COMPACTABLE_TOOLS + Compact Boundary 格式
- [ ] 6 类错误分派 + Circuit Breaker（5 次/30s/半开）+ fallbackModel 降级
- [ ] finally 清理 4 步顺序固定；`runSubagent` 支持 adapter 注入
- [ ] 测试 ≥ 19 用例全过；**覆盖率 ≥ 90%**；变异体 9/9 被杀死
- [ ] `bun run typecheck` 0 errors；`bun run test` 全量 0 fail
- [ ] 未提交 git commit

## 五、交接给 M8

1. `runSubagent(options)` 完整签名（M8 的 runner 调它，注入真实 adapter）。
2. finish 三态与 store 终态的对应关系（M8 的 runner 要在完成后 `message_send` 通知父 session + checkpoint）。
3. `emitAgUi` / `subagentEvents` 的用法（M8 TUI 页面订阅 `'ag-ui'`）。
4. STATE_SNAPSHOT 的发射时机（本任务的简化实现是"本轮调过 task_* 才发"，M8 如需更细粒度在 runner 层补）。
