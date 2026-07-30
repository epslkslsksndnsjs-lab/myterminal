// M7：核心执行器 + TUI 桥——agent loop 心脏（决策 5/8/9/12/15-16/20-22/24-25/29/37）
// ADR-0007 决策 5：退出策略——content 检测/maxTurns/timeout/abort 四路
// ADR-0007 决策 8：生命周期 finally——4 步清理顺序固定
// ADR-0007 决策 9：subagent 无上下文——初始消息只有任务
// ADR-0007 决策 12：system prompt 硬编码 + 动态拼接
// ADR-0007 决策 15-16：错误处理——tool 错误不算 subagent 失败、禁止嵌套
// ADR-0007 决策 20：3 层 compact——微压缩 + autocompact + 响应式 + 熔断器
// ADR-0007 决策 21：6 种错误分类 + 分类策略 + Circuit Breaker
// ADR-0007 决策 22：成本追踪——CostTracker + 只记账不限制（0009 决策 14）
// ADR-0007 决策 24：content 检测退出 + 配对保证
// ADR-0007 决策 25：异步独立 AbortController + AbortSignal.any
// ADR-0007 决策 29：token 校准——精确值校准 CostTracker
// ADR-0007 决策 37：任何路径下 tool_use 必须有配对 tool_result

import type { SubagentSettings } from '../types.js';
import type { LlmAdapter, ChatParams, StreamChunk } from './llm-adapter.js';
import { LlmError, collectStream, createAdapter, normalizeMessages, STREAM_IDLE_TIMEOUT_MS, withReliability } from './llm-adapter.js';
import { ResiliencePolicy, MAX_SERVER_RETRIES } from './resilience-policy.js';
import type { NormalizedMessage, TokenUsage } from './token-counter.js';
import { estimateMessageTokens, getAutoCompactThreshold, getModelContextWindow } from './token-counter.js';
import { CostTracker } from './cost-tracker.js';
import { getSubagent, updateSubagentStatus, updateSubagentCost, createSubagent, countRunning } from './store.js';
import { clearFileState } from './file-state.js';
import { executeToolCalls } from './tool-executor.js';
import type { ToolCall } from './tool-executor.js';
import { getToolNames, getAllToolSchemas } from './tools.js';
import type { SubagentToolContext } from './tools.js';
import { emitAgUi } from './tui-bridge.js';
import { sessionResourceManager } from '../session-resource-manager.js';
import type { AgUiEvent } from './tui-bridge.js';

// ════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════

/** 决策 20：微压缩时保留的最近 tool_result 数量（不压缩 write_file/edit_file/task_* 结果） */
const KEEP_RECENT_TOOL_RESULTS = 5;

/** 决策 20：可压缩的工具——大结果工具（只读/执行）可以被微压缩清洗 */
const COMPACTABLE_TOOLS = new Set(['execute_cli', 'read_file', 'grep', 'glob']);

/** 决策 20：compact 熔断器——连续 3 次 compact 失败后停止 */
export const MAX_COMPACT_FAILURES = 3;


// ════════════════════════════════════════════════════════════════
// 导出类型
// ════════════════════════════════════════════════════════════════

export type RunSubagentOptions = {
  agentId: string;
  task: string;                       // 任务描述（M8 从 objective+background+deliverables 组装）
  cwd: string;
  settings: SubagentSettings;         // M1 类型
  readOnly?: boolean;                 // 决策 17：只读模式
  adapter?: LlmAdapter;               // 可注入（测试/M8 用），缺省 createAdapter(settings)
  onEvent?: (event: AgUiEvent) => void; // 缺省走 emitAgUi
};

export type SubagentRunResult =
  | { status: 'completed'; result: string }
  | { status: 'failed'; error: string }
  | { status: 'aborted'; error: string };

// ════════════════════════════════════════════════════════════════
// Step 1：system prompt（决策 12）
// ════════════════════════════════════════════════════════════════

function getSubagentSystemPrompt(task: string, toolNames: string[], cwd: string): string {
  return [
    'You are a subagent — a stateless local executor.',
    'Execute the task using the provided tools. Return a concise result when done.',
    '',
    '# Tools',
    ...toolNames.map(t => `- ${t}`),
    '',
    '# Environment',
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}`,
    '',
    '# Task',
    task,
    '',
    '# Rules',
    'Always read a file before editing it. Use task_create/task_update to track progress.',
    'When all work is done, reply with a concise final summary and no tool calls.',
  ].join('\n');
}

// ════════════════════════════════════════════════════════════════
// Step 2：compact——微压缩（决策 20 第 1 层，零 API 成本）
// ════════════════════════════════════════════════════════════════

/**
 * 微压缩：保留最近 KEEP_RECENT_TOOL_RESULTS 个 tool_result 原样，
 * 更早的、且工具名 ∈ COMPACTABLE_TOOLS 的结果替换为占位文本。
 *
 * write_file/edit_file/task_create/task_update 的结果**不压缩**（小且重要）。
 * 决策 20：从后往前计数，保证最近 5 个保留。
 */
export function microCompact(messages: NormalizedMessage[]): NormalizedMessage[] {
  // 展平所有 tool_result block，标记它们的位置
  interface ResultSlot {
    msgIndex: number;
    blockIndex: number;
    toolName: string;
  }
  const resultSlots: ResultSlot[] = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg.role !== 'user') continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi];
      if (block.type === 'tool_result') {
        // 从 tool_use_id 近似提取工具名——格式通常是 tool_use 的 id 中有名称前缀
        // 实际上 tool_result 本身不存工具名。我们遍历所有 assistant 消息中的 tool_use，
        // 通过 tool_use_id 匹配来确定工具名。
        resultSlots.push({ msgIndex: mi, blockIndex: bi, toolName: resolveToolName(block.tool_use_id, messages) });
      }
    }
  }

  if (resultSlots.length <= KEEP_RECENT_TOOL_RESULTS) return messages;

  const compactCount = resultSlots.length - KEEP_RECENT_TOOL_RESULTS;

  // 前 compactCount 个（更早的）如果属于 COMPACTABLE_TOOLS 则替换
  for (let i = 0; i < compactCount; i++) {
    const slot = resultSlots[i];
    if (COMPACTABLE_TOOLS.has(slot.toolName)) {
      const msg = messages[slot.msgIndex];
      const block = msg.content[slot.blockIndex];
      if (block.type === 'tool_result') {
        block.content = '[此工具结果已被微压缩清理]';
      }
    }
  }

  return messages;
}

/** 根据 tool_use_id 反向查找对应的 tool_use block 拿到工具名 */
function resolveToolName(toolUseId: string, messages: NormalizedMessage[]): string {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id === toolUseId) {
        return block.name;
      }
    }
  }
  return ''; // 找不到对应的 tool_use——罕见但可能
}

// ════════════════════════════════════════════════════════════════
// Step 3：compact——autocompact（决策 20 第 2 层，调 LLM 摘要）
// ════════════════════════════════════════════════════════════════

/**
 * autocompact：调 LLM 摘要对话历史。
 * 返回新 messages：[summaryUserMessage] + 最近 2 轮原文。
 *
 * 决策 20：Compact Boundary 格式
 * ```
 * [对话摘要]
 * {summary}
 * [摘要结束]
 * ```
 */
export async function autoCompact(
  messages: NormalizedMessage[],
  adapter: LlmAdapter,
  model: string,
  onEvent: (event: AgUiEvent) => void,
  idleTimeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
): Promise<NormalizedMessage[]> {
  const summaryPrompt = [
    'Summarize the conversation so far, preserving:',
    '- The original task goal',
    '- Files modified and their current state',
    '- Key decisions made',
    '- Current progress and remaining work',
    '',
    'Be concise. This summary replaces the full conversation history.',
  ].join('\n');

  // 用可靠性装饰器包裹——继承 watchdog + 失败降级（决策 27 提升，#48）
  // provider 卡死时不再无限挂起主循环：watchdog 超时 → 抛 connection → 调用方降级
  const reliable = withReliability(adapter, { idleTimeoutMs, label: 'Compaction call idle timeout' });

  // 非流式调 LLM 摘要（走装饰后适配器）
  const result = await reliable.create(
    {
      model,
      system: summaryPrompt,
      messages,
      tools: [], // 摘要不需要工具
      maxTokens: 4096,
    },
    new AbortController().signal, // autocompact 不应被外部 abort 取消（但 watchdog 仍可中断）
  );

  const summaryText = result.message.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  // Compact Boundary 格式
  const summaryMessage: NormalizedMessage = {
    role: 'user',
    content: [{
      type: 'text',
      text: `[对话摘要]\n${summaryText}\n[摘要结束]`,
    }],
  };

  // 保留最近 2 轮 user-assistant 对
  const recentRounds: NormalizedMessage[] = [];
  let assistantCount = 0;
  for (let i = messages.length - 1; i >= 0 && assistantCount < 2; i--) {
    const msg = messages[i];
    recentRounds.unshift(msg);
    if (msg.role === 'assistant') assistantCount++;
  }

  // 摘要在前，最近的原文在后
  return [summaryMessage, ...recentRounds];
}


// ════════════════════════════════════════════════════════════════
// Step 6：主循环 runSubagent（决策 5 + 8 + 20 + 21 + 24 + 29 + 37）
// ════════════════════════════════════════════════════════════════

/** sleep 辅助——指数退避延迟 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runSubagent(options: RunSubagentOptions): Promise<SubagentRunResult> {
  const { agentId, task, cwd, settings } = options;
  const adapter = options.adapter ?? createAdapter(settings);
  const emit = (event: AgUiEvent) => {
    if (options.onEvent) {
      options.onEvent(event);
    } else {
      emitAgUi(event.subagentId, event.type, event.data);
    }
  };

  // 决策 5/25：获取或创建 record + AbortController
  // M8 通常已调 createSubagent；测试可能未调 → 自建
  let record = getSubagent(agentId);
  if (!record) {
    record = createSubagent(agentId, { subject: task.slice(0, 200) });
  }
  const abortController = record.abortController;

  // 组合信号：timeout + 用户 abort（决策 5/25）
  const timeoutSignal = AbortSignal.timeout(settings.timeoutSec * 1000);
  const signal = AbortSignal.any([abortController.signal, timeoutSignal]);

  // 工具上下文（决策 23）
  const ctx: SubagentToolContext = {
    cwd,
    signal,
    agentId,
    readOnly: options.readOnly ?? false,
  };

  // 成本追踪（决策 22：只记账不限制——ADR-0009 决策 14）
  const costTracker = new CostTracker(settings.model);

  // 弹性策略（决策 21，issue #65 抽离）
  const resilience = new ResiliencePolicy();

  // 工具集（决策 17 第 1 层：readOnly 过滤）
  const toolNames = getToolNames({ readOnly: options.readOnly ?? false });
  const toolSchemas = getAllToolSchemas().filter(s => toolNames.includes(s.name));

  // 决策 9：无上下文——初始消息只有任务
  let messages: NormalizedMessage[] = [
    { role: 'user', content: [{ type: 'text', text: task }] },
  ];
  const system = getSubagentSystemPrompt(task, toolNames, cwd);

  // 决策 20/21：compact 状态
  let compactFailures = 0;
  let reactiveCompactUsed = false;


  // 发射 RUN_STARTED
  emit({
    subagentId: agentId,
    type: 'RUN_STARTED',
    data: { task: task.slice(0, 200) },
    timestamp: Date.now(),
  });

  // ── 局部辅助：三态完成函数 ──

  const finishCompleted = (result: string): SubagentRunResult => {
    const cost = costTracker.getUsage();
    updateSubagentStatus(agentId, 'completed', { result });
    updateSubagentCost(agentId, cost);
    emit({
      subagentId: agentId,
      type: 'RUN_FINISHED',
      data: { result: result.slice(0, 500), cost },
      timestamp: Date.now(),
    });
    return { status: 'completed', result };
  };

  const finishFailed = (error: string): SubagentRunResult => {
    const cost = costTracker.getUsage();
    updateSubagentStatus(agentId, 'failed', { error });
    updateSubagentCost(agentId, cost);
    emit({
      subagentId: agentId,
      type: 'RUN_ERROR',
      data: { error, cost },
      timestamp: Date.now(),
    });
    return { status: 'failed', error };
  };

  const finishAborted = (): SubagentRunResult => {
    const reason = timeoutSignal.aborted
      ? `Timeout after ${settings.timeoutSec}s`
      : 'Aborted by parent';
    const cost = costTracker.getUsage();
    const status = timeoutSignal.aborted ? 'failed' : 'aborted';
    updateSubagentStatus(agentId, status, { error: reason });
    updateSubagentCost(agentId, cost);
    emit({
      subagentId: agentId,
      type: 'RUN_ERROR',
      data: { error: reason, cost, reason: timeoutSignal.aborted ? 'timeout' : 'user_abort' },
      timestamp: Date.now(),
    });
    return { status: status === 'aborted' ? 'aborted' : 'failed', error: reason };
  };

  try {
    let turns = 0;
    let currentModel = settings.model;

    while (turns < settings.maxTurns) {   // 决策 5：maxTurns 兜底
      // 决策 5/25：abort/timeout 检查点
      if (signal.aborted) return finishAborted();

      turns++;
      emit({
        subagentId: agentId,
        type: 'STEP_STARTED',
        data: { turn: turns },
        timestamp: Date.now(),
      });

      // ── compact 第 1 层：微压缩（零成本）──
      messages = microCompact(messages);

      // ── compact 第 2 层：autocompact（估算超阈值）──
      const threshold = getAutoCompactThreshold(currentModel);
      if (estimateMessageTokens(messages) > threshold) {
        try {
          messages = await autoCompact(messages, adapter, currentModel, (e) => emit(e));
          clearFileState(agentId);  // 决策 26：compact 后清文件状态
          compactFailures = 0;
        } catch {
          compactFailures++;
          if (compactFailures >= MAX_COMPACT_FAILURES) {
            return finishFailed('Compact circuit breaker: 3 consecutive failures');
          }
        }
      }

      // ── 决策 37：发送前配对检查（最后一道防线）──
      messages = normalizeMessages(messages);

      // ── 调 LLM（含错误恢复 + Circuit Breaker）──
      let streamResult;
      let llmError: LlmError | undefined;

      try {
        resilience.assertBreakerClosed();

        streamResult = await collectStream({
          adapter,
          chatParams: {
            model: currentModel,
            system,
            messages,
            tools: toolSchemas,
            maxTokens: getModelContextWindow(currentModel).maxOutput,
          },
          signal,
          onChunk: (chunk: StreamChunk) => {
            // AG-UI 流式事件（ADR-0008 决策 1）
            if (chunk.type === 'text_delta') {
              emit({ subagentId: agentId, type: 'TEXT_MESSAGE_CONTENT', data: { delta: chunk.text }, timestamp: Date.now() });
            }
            if (chunk.type === 'tool_call_start') {
              emit({ subagentId: agentId, type: 'TOOL_CALL_START', data: { name: chunk.name }, timestamp: Date.now() });
            }
            if (chunk.type === 'tool_call_delta') {
              emit({ subagentId: agentId, type: 'TOOL_CALL_ARGS', data: { delta: chunk.jsonFragment }, timestamp: Date.now() });
            }
          },
        });

        // 成功——重置相关计数
        resilience.recordSuccess();

      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return finishAborted();
        }

        if (!(err instanceof LlmError)) {
          return finishFailed((err as Error).message);
        }

        llmError = err;

        const decision = resilience.decideOnFailure(llmError);

        if (!decision.retry) {
          // 不可重试
          if (decision.action === 'compact') {
            // 决策 20 第 3 层 + 决策 21：prompt_too_long → 响应式压缩重试 1 次
            if (!reactiveCompactUsed) {
              reactiveCompactUsed = true;
              messages = microCompact(messages);
              try {
                messages = await autoCompact(messages, adapter, currentModel, (e) => emit(e));
                clearFileState(agentId);
              } catch {
                // compact 本身失败 → 不可恢复
              }
              continue; // 重试（turns 不额外扣——注释说明）
            }
            return finishFailed('Context too long: prompt exceeds model window. Compacting did not resolve the issue.');
          }

          // auth / system / connection 耗尽 → 直接失败
          if (llmError.kind === 'auth') {
            return finishFailed(`API key is invalid or expired (${settings.provider})`);
          }
          if (llmError.kind === 'connection') {
            return finishFailed(`Network error after ${MAX_SERVER_RETRIES} retries: ${llmError.message}`);
          }
          return finishFailed(llmError.message);
        }

        // 可重试——根据 action 调整策略
        if (decision.action === 'fallbackModel') {
          // server_overload 降级——换 fallback model
          if (settings.fallbackModel) {
            currentModel = settings.fallbackModel;
            // ADR-0020: 同步更新 costTracker 定价
            costTracker.setModel(currentModel);
          }
        }

        // 等待重试延迟
        await sleep(decision.delayMs);
        continue; // turns 不额外扣——注释说明
      }

      // ── 成本聚合（决策 22 + 29：精确值校准）──
      costTracker.addUsage(streamResult!.usage);
      updateSubagentCost(agentId, costTracker.getUsage());

      // ── 决策 24：content 检测退出 ──
      const assistantMsg = streamResult!.message;
      messages.push(assistantMsg);

      if (!streamResult!.hadToolCalls) {
        emit({
          subagentId: agentId,
          type: 'STEP_FINISHED',
          data: { turn: turns },
          timestamp: Date.now(),
        });
        const resultText = assistantMsg.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n');
        return finishCompleted(resultText);
      }

      // ── 执行工具（M5）──
      const toolCalls: ToolCall[] = assistantMsg.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ id: b.id, name: b.name, input: b.input }));

      const toolResults = await executeToolCalls(toolCalls, ctx, (e) => {
        // M5 事件 → AG-UI 映射
        emit({
          subagentId: agentId,
          type: e.type as AgUiEvent['type'],
          data: e.data as Record<string, unknown>,
          timestamp: Date.now(),
        });
      });

      messages.push({
        role: 'user',
        content: toolResults.map(r => ({
          type: 'tool_result' as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
          is_error: r.is_error,
        })),
      });

      // task 状态同步事件（简化实现：每轮发 STATE_SNAPSHOT）
      const updatedRecord = getSubagent(agentId);
      if (updatedRecord && updatedRecord.tasks.length > 0) {
        emit({
          subagentId: agentId,
          type: 'STATE_SNAPSHOT',
          data: { tasks: updatedRecord.tasks },
          timestamp: Date.now(),
        });
      }

      emit({
        subagentId: agentId,
        type: 'STEP_FINISHED',
        data: { turn: turns },
        timestamp: Date.now(),
      });
    }

    // 决策 5：maxTurns 上限
    return finishFailed(`Max turns reached (${settings.maxTurns})`);

  } catch (err) {
    if (signal.aborted) return finishAborted();
    return finishFailed((err as Error).message);

  } finally {
    // 决策 8：清理顺序固定——统一收口到 SessionResourceManager（ADR-0032 #38）
    // 注册顺序即现状 ①②③：agent-shell-tasks / file-state / replacement-decisions
    sessionResourceManager.disposeAgent(agentId);
    messages.length = 0;               // ⑤ 释放 messages（决策 9）
    // ⑥ 终态事件与 store 更新在 finishXxx 里已做
  }
}
