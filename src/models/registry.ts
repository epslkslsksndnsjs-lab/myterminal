// G9（ADR-0031）单一来源：模型元数据合并注册表
// 同一批 13 个模型的价格 + 上下文窗口集中维护；新增模型只改这一处
// 价格按每 1M tokens（USD）计（ADR-0007 决策 22/29）
// 上下文窗口为估算/校准用（ADR-0007 决策 29）

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ModelContextWindow {
  window: number;
  maxOutput: number;
}

export interface ModelSpec {
  pricing: ModelPricing;
  contextWindow: ModelContextWindow;
}

export const MODELS: Record<string, ModelSpec> = {
  'gpt-4o': {
    pricing: { input: 2.5, output: 10, cacheRead: 1.25 },
    contextWindow: { window: 128_000, maxOutput: 16_384 },
  },
  'gpt-4o-mini': {
    pricing: { input: 0.15, output: 0.6, cacheRead: 0.075 },
    contextWindow: { window: 128_000, maxOutput: 16_384 },
  },
  'gpt-4.1': {
    pricing: { input: 2, output: 8, cacheRead: 0.5 },
    contextWindow: { window: 1_000_000, maxOutput: 32_768 },
  },
  'gpt-4.1-mini': {
    pricing: { input: 0.4, output: 1.6, cacheRead: 0.1 },
    contextWindow: { window: 1_000_000, maxOutput: 32_768 },
  },
  'claude-sonnet-4': {
    pricing: { input: 3, output: 15, cacheRead: 0.3 },
    contextWindow: { window: 200_000, maxOutput: 16_384 },
  },
  'claude-haiku-4': {
    pricing: { input: 0.8, output: 4, cacheRead: 0.08 },
    contextWindow: { window: 200_000, maxOutput: 8_192 },
  },
  'claude-opus-4': {
    pricing: { input: 15, output: 75, cacheRead: 1.5 },
    contextWindow: { window: 200_000, maxOutput: 32_000 },
  },
  'deepseek-chat': {
    pricing: { input: 0.27, output: 1.1, cacheRead: 0.07 },
    contextWindow: { window: 64_000, maxOutput: 8_192 },
  },
  'deepseek-reasoner': {
    pricing: { input: 0.55, output: 2.19, cacheRead: 0.14 },
    contextWindow: { window: 64_000, maxOutput: 8_192 },
  },
  // GLM（智谱开放平台）——per 1M tokens, USD
  'glm-4-flash': {
    pricing: { input: 0.014, output: 0.014, cacheRead: 0 },
    contextWindow: { window: 128_000, maxOutput: 4_096 },
  },
  'glm-4': {
    pricing: { input: 0.014, output: 0.014, cacheRead: 0 },
    contextWindow: { window: 128_000, maxOutput: 4_096 },
  },
  // Qwen（阿里云 DashScope）——per 1M tokens, USD（近似 qwen-max 定价）
  'qwen3.7-max': {
    pricing: { input: 2.8, output: 8.4, cacheRead: 0.7 },
    contextWindow: { window: 1_000_000, maxOutput: 65_536 },
  },
  'qwen-max': {
    pricing: { input: 2.8, output: 8.4, cacheRead: 0.7 },
    contextWindow: { window: 128_000, maxOutput: 8_192 },
  },
};
