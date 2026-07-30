// ADR-0007 决策 22：硬编码常见模型定价；未知模型按同 provider 估算
// ADR-0007 决策 29：定价 per 1M tokens，单位 USD
// G9（ADR-0031）：价格表单一来源为 src/models/registry.ts 的 MODELS

import { MODELS } from '../models/registry.js';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalUSD: number;
}

function resolvePricing(model: string): { input: number; output: number; cacheRead: number } {
  // 精确匹配
  const exact = MODELS[model];
  if (exact) return exact.pricing;

  // 前缀匹配——如 gpt-4o-2024-08-06 匹配 gpt-4o
  const prefixKey = Object.keys(MODELS).find(k => model.startsWith(k));
  if (prefixKey) return MODELS[prefixKey].pricing;

  // 未知模型——按 provider 保守估算
  if (model.startsWith('gpt-')) {
    console.warn(`[cost-tracker] Unknown OpenAI model "${model}", falling back to gpt-4o pricing`);
    return MODELS['gpt-4o'].pricing;
  }
  if (model.startsWith('claude-')) {
    console.warn(`[cost-tracker] Unknown Anthropic model "${model}", falling back to claude-sonnet-4 pricing`);
    return MODELS['claude-sonnet-4'].pricing;
  }
  if (model.startsWith('deepseek-')) {
    console.warn(`[cost-tracker] Unknown DeepSeek model "${model}", falling back to deepseek-chat pricing`);
    return MODELS['deepseek-chat'].pricing;
  }
  if (model.startsWith('glm-')) {
    console.warn(`[cost-tracker] Unknown GLM model "${model}", falling back to glm-4-flash pricing`);
    return MODELS['glm-4-flash'].pricing;
  }
  if (model.startsWith('qwen')) {
    console.warn(`[cost-tracker] Unknown Qwen model "${model}", falling back to qwen-max pricing`);
    return MODELS['qwen-max'].pricing;
  }

  // 完全未知——gpt-4o 作为最通用默认
  console.warn(`[cost-tracker] Completely unknown model "${model}", falling back to gpt-4o pricing`);
  return MODELS['gpt-4o'].pricing;
}

export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private pricing: { input: number; output: number; cacheRead: number };
  private settledUSD = 0; // ADR-0020 fix: 模型切换前已结算的固定金额

  constructor(model: string) {
    this.pricing = resolvePricing(model);
  }

  // ADR-0020: 降级模型切换时——先按旧定价结算已累积 token，再重置计数器
  setModel(model: string): void {
    this.settledUSD += this.getTotalCost();
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.pricing = resolvePricing(model);
  }

  addUsage(usage: TokenUsage): void {
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
    if (usage.cache_read_input_tokens) {
      this.cacheReadTokens += usage.cache_read_input_tokens;
    }
  }

  getTotalCost(): number {
    return this.settledUSD + (
      this.inputTokens * this.pricing.input +
      this.outputTokens * this.pricing.output +
      this.cacheReadTokens * this.pricing.cacheRead
    ) / 1_000_000;
  }

  getUsage(): UsageSummary {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      totalUSD: this.getTotalCost(),
    };
  }
}
