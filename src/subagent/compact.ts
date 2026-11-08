// Shared history compaction (M2): extracted from src/subagent/executor.ts so the
// native agent loop and the subagent executor use one implementation.
// ADR-0007 决策 20：3 层 compact——微压缩（零成本）+ autocompact（LLM 摘要）
// + 响应式压缩（由调用方在 prompt_too_long 时触发）。

import type { LlmAdapter } from './llm-adapter.js';
import { withReliability, STREAM_IDLE_TIMEOUT_MS } from './llm-adapter.js';
import type { NormalizedMessage } from './token-counter.js';

/** 决策 20：微压缩时保留的最近 tool_result 数量（不压缩 write_file/edit_file/task_* 结果） */
const KEEP_RECENT_TOOL_RESULTS = 5;

/** 决策 20：可压缩的工具——大结果工具（只读/执行）可以被微压缩清洗 */
const COMPACTABLE_TOOLS = new Set(['execute_cli', 'read_file', 'grep', 'glob']);

/** 决策 20：compact 熔断器——连续 3 次 compact 失败后停止 */
export const MAX_COMPACT_FAILURES = 3;

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
