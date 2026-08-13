// ADR-0046 D1：成本/美元概念已彻底移除——CostTracker 降级为纯 token 累加器。
// 只累计 input/output/cacheRead token，不持有任何定价表、不换算货币金额。

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;

  constructor() {}

  addUsage(usage: TokenUsage): void {
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
    if (usage.cache_read_input_tokens) {
      this.cacheReadTokens += usage.cache_read_input_tokens;
    }
  }

  getUsage(): UsageSummary {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
    };
  }
}
