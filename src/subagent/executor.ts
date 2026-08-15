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
import { estimateMessageTokens } from './token-counter.js';
import { CostTracker } from './cost-tracker.js';
import { getSubagent, updateSubagentStatus, updateSubagentCost, createSubagent, countRunning } from './store.js';
import { clearFileState } from './file-state.js';
import { executeToolCalls } from './tool-executor.js';
import type { ToolCall } from './tool-executor.js';
import { getToolNames, getAllToolSchemas } from './tools.js';
import type { SubagentToolContext } from './tools.js';
import { emitAgUi } from './tui-bridge.js';
import { sessionResourceManager } from '../session-resource-manager.js';
import { defaultContext } from './context.js';
import { getAgentOutputDir } from './output-dir.js';
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

export function getSubagentSystemPrompt(task: string, toolNames: string[], cwd: string): string {
  return [
    'You are a subagent — a stateless local executor for the MyTerminal workspace.',
    'Complete the task fully: don\'t gold-plate, but don\'t leave it half-done.',
    'Use the provided tools, then return a concise report. The caller relays your report to the user, so include only the essentials.',
    'You have no memory of prior runs and no direct conversation with the user.',
    '',
    '# Operating boundaries',
    '- Work only inside the working directory shown in # Environment. Do not read,',
    '  write, or execute against paths outside it, and do not touch other projects,',
    '  system directories, credentials, or host environment.',
    '- Never run destructive or irreversible commands (e.g. rm -rf /, disk format,',
    '  fork bombs, dropping databases). If an action is hard to reverse or affects',
    '  shared state, stop and report it rather than guessing.',
    '- If you were started without write tools (read-only mode), do not attempt to',
    '  create or modify files.',
    '',
    '# Doing tasks',
    '- Solve exactly what was asked. Do not add features, refactors, config, or',
    '  "improvements" beyond the task. A bug fix does not need surrounding cleanup.',
    '- Read a file before editing it. Understand existing code before changing it.',
    '  Prefer editing an existing file over creating a new one.',
    '- If an approach fails, diagnose why before switching tactics: read the error,',
    '  check your assumptions, try a focused fix. A single tool error is not failure —',
    '  analyze, fix, retry. Do not blindly repeat the identical failing call.',
    '- Fail fast: if you cannot do the work (a needed tool is unavailable, permission',
    '  is denied, or the task conflicts with the parameters given), set the task to',
    '  blocked with a blockedReason stating which parameter mismatches the task, and',
    '  immediately produce the final report — stop rotating through other tasks,',
    '  do not spin, do not burn turns.',
    '- Never proactively create documentation files (*.md, README*) unless the task',
    '  explicitly requires them.',
    '- Verify your work before declaring done: if you changed code, run the relevant',
    '  tests / typecheck; if you cannot verify, say so explicitly instead of implying',
    '  success.',
    '',
    '# Using your tools',
    '- Use absolute paths for all file operations (cwd resets on every call, so',
    '  relative paths would break across calls).',
    '- Prefer dedicated tools over raw shell: read_file (not cat), write_file /',
    '  edit_file (not sed / awk), glob (not find / ls), grep (not grep / rg).',
    '  Reserve execute_cli for commands that truly need a shell.',
    '- Call independent tools in the same turn in parallel to save round-trips.',
    '  Run dependent calls sequentially.',
    '- Track progress with task_create / task_update. Mark a task complete as soon as',
    '  you finish it; do not batch completions.',
    '',
    '# Reporting',
    '- When all work is done, reply with a concise final report and no further tool',
    '  calls. State what changed and how it was verified.',
    '- Keep the final report under 2000 tokens. If the details matter, write them to',
    '  a file instead of the report; share absolute file paths for everything you',
    '  changed or verified, and include code snippets only when load-bearing.',
    '- If you cannot complete the task or lack required information, report the',
    '  blocker and what you tried — never fabricate results or claim success falsely.',
    '- Keep output lean: no filler, no restating the task, no recap of code you only',
    '  read, no emojis.',
    '',
    '# Environment',
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}`,
    'Tools available:',
    ...toolNames.map(t => `- ${t}`),
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
    toolUseId: string;
  }
  const resultSlots: ResultSlot[] = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg.role !== 'user') continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi];
      if (block.type === 'tool_result') {
        resultSlots.push({ msgIndex: mi, blockIndex: bi, toolUseId: block.tool_use_id });
      }
    }
  }

  if (resultSlots.length <= KEEP_RECENT_TOOL_RESULTS) return messages;

  // ADR-0032 #63: 预建 tool_use_id → 工具名 映射（一次遍历，first-wins 语义），
  // 把原 O(n²) 的"每个 tool_result 全量扫描 assistant 消息"降为 O(n) 构建 + O(1) 查表。
  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id && !toolNames.has(block.id)) toolNames.set(block.id, block.name);
    }
  }
  const resolve = (toolUseId: string): string => (toolNames.has(toolUseId) ? (toolNames.get(toolUseId) as string) : '');

  const compactCount = resultSlots.length - KEEP_RECENT_TOOL_RESULTS;

  // 前 compactCount 个（更早的）如果属于 COMPACTABLE_TOOLS 则替换
  for (let i = 0; i < compactCount; i++) {
    const slot = resultSlots[i];
    const toolName = resolve(slot.toolUseId);
    if (COMPACTABLE_TOOLS.has(toolName)) {
      const msg = messages[slot.msgIndex];
      const block = msg.content[slot.blockIndex];
      if (block.type === 'tool_result') {
        block.content = '[此工具结果已被微压缩清理]';
      }
    }
  }

  return messages;
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
  // ADR-0048 D8（第四轮修订）：后台输出落盘目录 = <cwd>/.myterminal/subagent-outputs/<agentId>
  // （workspace 内状态目录先例 .myterminal/skills；IGNORE_DIRECTORIES 含 .myterminal → glob/grep 忽略；
  // git 侧由输出层自忽略 .gitignore 兜住（R6/#157））
  // D8 中（#152）：同步登记 outputDirs——agent 收尸（disposeAgent）按此删除目录
  const outputDir = getAgentOutputDir(cwd, agentId);
  defaultContext.outputDirs.set(agentId, outputDir);
  const ctx: SubagentToolContext = {
    cwd,
    signal,
    agentId,
    readOnly: options.readOnly ?? false,
    outputDir,
  };

  // token 追踪（ADR-0046 D1：纯 token 累加器，不再核算成本）
  const costTracker = new CostTracker();

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
    const usage = costTracker.getUsage();
    updateSubagentStatus(agentId, 'completed', { result });
    updateSubagentCost(agentId, usage);
    emit({
      subagentId: agentId,
      type: 'RUN_FINISHED',
      data: { result: result.slice(0, 500), usage },
      timestamp: Date.now(),
    });
    return { status: 'completed', result };
  };

  const finishFailed = (error: string): SubagentRunResult => {
    const usage = costTracker.getUsage();
    updateSubagentStatus(agentId, 'failed', { error });
    updateSubagentCost(agentId, usage);
    emit({
      subagentId: agentId,
      type: 'RUN_ERROR',
      data: { error, usage },
      timestamp: Date.now(),
    });
    return { status: 'failed', error };
  };

  const finishAborted = (): SubagentRunResult => {
    const reason = timeoutSignal.aborted
      ? `Timeout after ${settings.timeoutSec}s`
      : 'Aborted by parent';
    const usage = costTracker.getUsage();
    const status = timeoutSignal.aborted ? 'failed' : 'aborted';
    updateSubagentStatus(agentId, status, { error: reason });
    updateSubagentCost(agentId, usage);
    emit({
      subagentId: agentId,
      type: 'RUN_ERROR',
      data: { error: reason, usage, reason: timeoutSignal.aborted ? 'timeout' : 'user_abort' },
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
      // ADR-0045 D5：阈值由 settings 直供（默认 80000），不再按模型名查表
      const threshold = settings.compactThreshold ?? 80_000;
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
            // ADR-0045 D5：maxTokens 由 settings 直供（默认 32000），不再按模型名查表
            maxTokens: settings.maxOutput ?? 32_000,
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
            return finishFailed('API key is invalid or expired.');
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
          }
        }

        // 等待重试延迟
        await sleep(decision.delayMs);
        continue; // turns 不额外扣——注释说明
      }

      // ── token 聚合（决策 29：精确值校准）──
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
    // 注册顺序即现状 ①②③④：agent-shell-tasks / file-state / replacement-decisions / subagent-outputs（#152）
    sessionResourceManager.disposeAgent(agentId);
    messages.length = 0;               // ⑤ 释放 messages（决策 9）
    // ⑥ 终态事件与 store 更新在 finishXxx 里已做
  }
}
