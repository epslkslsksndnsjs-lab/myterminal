// Issue #65：从 executor.ts 抽取的 LLM 弹性策略模块（决策 21）
// 封装 CircuitBreaker + 分类重试决策 + 每类错误计数
// 行为与原始 executor.ts 闭包内逻辑完全等价

import { LlmError } from './llm-adapter.js';

// ════════════════════════════════════════════════════════════════
// 常量（决策 21）
// ════════════════════════════════════════════════════════════════

/** Circuit Breaker——连续 5 次 LLM API 失败 → 熔断 */
const CB_FAILURE_THRESHOLD = 5;

/** Circuit Breaker——熔断 30 秒后允许半开探测 */
const CB_COOLDOWN_MS = 30_000;

/** 指数退避基础延迟 500ms */
const BASE_RETRY_DELAY_MS = 500;

/** 指数退避上限 32s */
const MAX_RETRY_DELAY_MS = 32_000;

/** server_overload / connection 最大重试次数 */
export const MAX_SERVER_RETRIES = 3;

// ════════════════════════════════════════════════════════════════
// 导出类型
// ════════════════════════════════════════════════════════════════

export type RetryDecision = {
  retry: boolean;
  delayMs: number;
  action?: 'compact' | 'fallbackModel';
};

// ════════════════════════════════════════════════════════════════
// 内部：Circuit Breaker（决策 21）
// ════════════════════════════════════════════════════════════════

/**
 * Circuit Breaker——防 subagent 在 API 不稳定时无限重试。
 * - 连续 5 次 LLM API 失败 → 熔断 30s
 * - 熔断期间直接拒绝，不调 API
 * - 30s 后允许一次半开探测
 * - 探测成功 → 关闭（恢复）
 * - 探测失败 → 重新熔断
 */
class CircuitBreaker {
  private failureCount = 0;
  private trippedAt: number = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.failureCount = 0;
    } else if (this.state === 'closed') {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    if (this.state === 'half-open') {
      // 半开探测失败 → 重新熔断
      this.state = 'open';
      this.trippedAt = Date.now();
      return;
    }

    this.failureCount++;
    if (this.failureCount >= CB_FAILURE_THRESHOLD) {
      this.state = 'open';
      this.trippedAt = Date.now();
    }
  }

  /** 如果熔断则抛错，否则正常返回 */
  assertClosed(): void {
    if (this.state === 'closed') return;

    if (this.state === 'open') {
      // 检查是否过了冷却期
      if (Date.now() - this.trippedAt >= CB_COOLDOWN_MS) {
        this.state = 'half-open';
        // 半开——允许一次探测
        return;
      }
      throw new Error(`Circuit breaker is open. Cooldown: ${Math.ceil((CB_COOLDOWN_MS - (Date.now() - this.trippedAt)) / 1000)}s remaining.`);
    }

    // half-open——允许通过（探测）
  }

  /** 测试辅助：读取当前状态 */
  getState(): 'closed' | 'open' | 'half-open' {
    return this.state;
  }
}

// ════════════════════════════════════════════════════════════════
// 内部：分类重试决策（决策 21 表）
// ════════════════════════════════════════════════════════════════

/**
 * 6 种错误分类 + 分类策略（决策 21 表）。
 * 返回是否可重试、重试延迟、推荐动作。
 */
function classifyAndShouldRetry(err: LlmError, retryCount: number): RetryDecision {
  switch (err.kind) {
    case 'rate_limit': {
      // 指数退避：500ms × 2^n + jitter(0-100ms)，上限 32s
      // err.retryAfterMs 优先（Retry-After 头）
      const base = err.retryAfterMs ?? BASE_RETRY_DELAY_MS * Math.pow(2, retryCount);
      const jitter = Math.floor(Math.random() * 100);
      const delayMs = Math.min(base + jitter, MAX_RETRY_DELAY_MS);
      return { retry: true, delayMs };
    }

    case 'server_overload': {
      if (retryCount < MAX_SERVER_RETRIES) {
        const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, retryCount);
        return { retry: true, delayMs };
      }
      // 3 次重试后降级到 fallbackModel
      return { retry: true, delayMs: BASE_RETRY_DELAY_MS, action: 'fallbackModel' };
    }

    case 'auth':
      // 不重试——直接失败
      return { retry: false, delayMs: 0 };

    case 'prompt_too_long':
      // 不重试——触发响应式压缩（决策 20 第 3 层）
      return { retry: false, delayMs: 0, action: 'compact' };

    case 'connection': {
      if (retryCount < MAX_SERVER_RETRIES) {
        const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, retryCount);
        return { retry: true, delayMs };
      }
      return { retry: false, delayMs: 0 };
    }

    case 'system':
    default:
      // 直接失败
      return { retry: false, delayMs: 0 };
  }
}

// ════════════════════════════════════════════════════════════════
// 导出：ResiliencePolicy（深模块——issue #65）
// ════════════════════════════════════════════════════════════════

/**
 * LLM 弹性策略——封装熔断器 + 分类重试 + 每类错误计数。
 * 从 executor.ts runSubagent 闭包中抽出，可独立单测。
 */
export class ResiliencePolicy {
  private readonly breaker = new CircuitBreaker();
  private readonly errorRetryCount = new Map<string, number>();

  // ── 公开代理 ──

  /** 调 LLM 前调用——熔断时抛错 */
  assertBreakerClosed(): void {
    this.breaker.assertClosed();
  }

  /** LLM 调用成功 */
  recordSuccess(): void {
    this.breaker.recordSuccess();
    this.resetRetryCount('rate_limit');
    this.resetRetryCount('server_overload');
    this.resetRetryCount('connection');
  }

  /** LLM 调用失败——记录并返回决策 */
  decideOnFailure(err: LlmError): RetryDecision {
    this.breaker.recordFailure();
    const kind = err.kind;
    this.incRetryCount(kind);
    const retryCount = this.getRetryCount(kind);
    return classifyAndShouldRetry(err, retryCount - 1); // 已计数过，传当前次数-1
  }

  /** 手动重置某类错误计数（如 compact 成功后） */
  resetRetryCount(kind: string): void {
    this.errorRetryCount.delete(kind);
  }

  // ── 内部辅助 ──

  private getRetryCount(kind: string): number {
    return this.errorRetryCount.get(kind) ?? 0;
  }

  private incRetryCount(kind: string): void {
    this.errorRetryCount.set(kind, this.getRetryCount(kind) + 1);
  }
}
