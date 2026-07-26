// M6 决策 29：Token 计数与 Context Window 检测
// 简单估算——不调 API，零成本；估算用于"预防"，精确值用于"校准"

import type { JsonObject } from '../types.js';

// ── 共享消息类型（llm-adapter 与 M7 共用）──

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonObject }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
  | { type: 'image'; source?: unknown };

export type NormalizedMessage = { role: 'user' | 'assistant'; content: ContentBlock[] };
export type TokenUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };

// ── Token 估算（决策 29）──

/**
 * 4 chars ≈ 1 token，×4/3 安全余量（宁可高估早 compact，不要低估被 API 拒绝）
 * 决策 29：4/3 安全余量确保不会因低估而过晚触发 compact
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  return Math.ceil((text.length / 4) * (4 / 3));
}

/**
 * 消息级 token 估算——遍历所有 content block（决策 29）
 * 每条消息 +4 overhead
 */
export function estimateMessageTokens(messages: NormalizedMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          total += estimateTokens(block.text);
          break;
        case 'tool_use':
          total += estimateTokens(JSON.stringify(block.input));
          break;
        case 'tool_result':
          total += estimateTokens(block.content);
          break;
        case 'image':
          total += 2000; // 图片固定估算（Claude Code 同款，决策 29）
          break;
      }
    }
    total += 4; // 每条消息 overhead（role 标记等）
  }
  return total;
}

// ── Provider 上下文窗口表（决策 29）──

const MODEL_CONTEXT_WINDOWS: Record<string, { window: number; maxOutput: number }> = {
  // OpenAI（决策 29 表）
  'gpt-4o':           { window: 128_000, maxOutput: 16_384 },
  'gpt-4o-mini':      { window: 128_000, maxOutput: 16_384 },
  'gpt-4.1':          { window: 1_000_000, maxOutput: 32_768 },
  'gpt-4.1-mini':     { window: 1_000_000, maxOutput: 32_768 },
  // Anthropic（决策 29 表）
  'claude-sonnet-4':  { window: 200_000, maxOutput: 16_384 },
  'claude-haiku-4':   { window: 200_000, maxOutput: 8_192 },
  'claude-opus-4':    { window: 200_000, maxOutput: 32_000 },
  // DeepSeek（决策 29 表）
  'deepseek-chat':    { window: 64_000, maxOutput: 8_192 },
  'deepseek-reasoner':{ window: 64_000, maxOutput: 8_192 },
};

/**
 * 获取模型上下文窗口（决策 29）
 * 策略：精确匹配 → 前缀匹配（支持 gpt-4o-2024-08-06 等带日期后缀） → 未知默认 64K
 */
export function getModelContextWindow(model: string): { window: number; maxOutput: number } {
  // 精确匹配
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];

  // 前缀匹配（支持 gpt-4o-2024-08-06 等变体）
  const knownModels = Object.keys(MODEL_CONTEXT_WINDOWS);
  const prefix = knownModels.find(k => model.startsWith(k));
  if (prefix) return MODEL_CONTEXT_WINDOWS[prefix];

  // 未知模型——保守默认 64K
  console.warn(`Unknown model "${model}", defaulting to 64K context window`);
  return { window: 64_000, maxOutput: 8_192 };
}

/**
 * autocompact 触发阈值（决策 29）
 * effectiveWindow = contextWindow - min(maxOutput, 20_000)
 * threshold = effectiveWindow - 13_000（13K 缓冲留给 compact API 调用 + 新消息）
 */
export function getAutoCompactThreshold(model: string): number {
  const { window, maxOutput } = getModelContextWindow(model);
  const effectiveWindow = window - Math.min(maxOutput, 20_000);
  return effectiveWindow - 13_000;
}
