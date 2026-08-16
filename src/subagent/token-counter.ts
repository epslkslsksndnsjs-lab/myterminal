// M6 决策 29：Token 估算（零成本、用于"预防"；精确值由 LLM 回传 usage 校准）
// 上下文窗口 / 压缩阈值不再按模型名查表——改由 SubagentSettings 直供（ADR-0045 D5）。

import type { JsonObject } from '../types.js';

// ── 共享消息类型（llm-adapter 与 M7 共用）──

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonObject }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
  | { type: 'image'; source?: unknown };

export type NormalizedMessage = { role: 'user' | 'assistant'; content: ContentBlock[] };
// ADR-0048 D10（#138）：cache_creation_input_tokens 补记——缓存创建那次是加价写入，
// 不读即成本盲区。与 cost-tracker.ts 的 TokenUsage 同改（两处重复定义纪律）。
export type TokenUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

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
          total += 2000; // 图片固定估算 2000（决策 29）
          break;
      }
    }
    total += 4; // 每条消息 overhead（role 标记等）
  }
  return total;
}

