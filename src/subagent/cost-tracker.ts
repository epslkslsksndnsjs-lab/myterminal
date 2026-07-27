// ADR-0007 决策 22：硬编码常见模型定价；未知模型按同 provider 估算
// ADR-0007 决策 29：定价 per 1M tokens，单位 USD

const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'gpt-4o':            { input: 2.5,  output: 10,   cacheRead: 1.25 },
  'gpt-4o-mini':       { input: 0.15, output: 0.6,  cacheRead: 0.075 },
  'gpt-4.1':           { input: 2,    output: 8,    cacheRead: 0.5 },
  'gpt-4.1-mini':      { input: 0.4,  output: 1.6,  cacheRead: 0.1 },
  'claude-sonnet-4':   { input: 3,    output: 15,   cacheRead: 0.3 },
  'claude-haiku-4':    { input: 0.8,  output: 4,    cacheRead: 0.08 },
  'claude-opus-4':     { input: 15,   output: 75,   cacheRead: 1.5 },
  'deepseek-chat':     { input: 0.27, output: 1.1,  cacheRead: 0.07 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14 },
  // GLM（智谱开放平台）——per 1M tokens, USD
  'glm-4-flash':       { input: 0.014, output: 0.014, cacheRead: 0 },
  'glm-4':             { input: 0.014, output: 0.014, cacheRead: 0 },
  // Qwen（阿里云 DashScope）——per 1M tokens, USD（近似 qwen-max 定价）
  'qwen3.7-max':       { input: 2.8,  output: 8.4,  cacheRead: 0.7 },
  'qwen-max':          { input: 2.8,  output: 8.4,  cacheRead: 0.7 },
};

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
  const exact = MODEL_PRICING[model];
  if (exact) return exact;

  // 前缀匹配——如 gpt-4o-2024-08-06 匹配 gpt-4o
  const prefixKey = Object.keys(MODEL_PRICING).find(k => model.startsWith(k));
  if (prefixKey) return MODEL_PRICING[prefixKey];

  // 未知模型——按 provider 保守估算
  if (model.startsWith('gpt-')) {
    console.warn(`[cost-tracker] Unknown OpenAI model "${model}", falling back to gpt-4o pricing`);
    return MODEL_PRICING['gpt-4o'];
  }
  if (model.startsWith('claude-')) {
    console.warn(`[cost-tracker] Unknown Anthropic model "${model}", falling back to claude-sonnet-4 pricing`);
    return MODEL_PRICING['claude-sonnet-4'];
  }
  if (model.startsWith('deepseek-')) {
    console.warn(`[cost-tracker] Unknown DeepSeek model "${model}", falling back to deepseek-chat pricing`);
    return MODEL_PRICING['deepseek-chat'];
  }
  if (model.startsWith('glm-')) {
    console.warn(`[cost-tracker] Unknown GLM model "${model}", falling back to glm-4-flash pricing`);
    return MODEL_PRICING['glm-4-flash'];
  }
  if (model.startsWith('qwen')) {
    console.warn(`[cost-tracker] Unknown Qwen model "${model}", falling back to qwen-max pricing`);
    return MODEL_PRICING['qwen-max'];
  }

  // 完全未知——gpt-4o 作为最通用默认
  console.warn(`[cost-tracker] Completely unknown model "${model}", falling back to gpt-4o pricing`);
  return MODEL_PRICING['gpt-4o'];
}

export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private pricing: { input: number; output: number; cacheRead: number };

  constructor(model: string) {
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
    return (
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
