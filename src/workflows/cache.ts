import { argsChainSeed } from './keys.js';
import type { JournalRecord } from './journal.js';

/**
 * 缓存 = 同一 run 的 journal 重放（ADR-0052 §17）。
 *
 * 三条纪律：
 *   1. 键单位 = 单次 agent() 调用，键 = 前缀哈希链上的一点；续跑从 args 种子重推整条链，
 *      未变前缀推回同一颗键，因此"键命中即前缀命中"——链式换键天然实现最长未变前缀；
 *   2. 存储单位 = 每条调用结果：只有 result 行进缓存，失败路（failed）与在飞被打断
 *      （只有 started 无 result）都不进缓存；同名键后到的 started / failed 把旧结果作废；
 *   3. 新 run（新 runId）永远全跑，无跨 run 记忆——这里只在 resume 时被构造。
 */

export type ReplayCache = {
  /** 可重放的键数（观测面）。 */
  readonly size: number;
  /** 这颗键有没有可复用的结果——命中即零 token、不进窗口、不计 agent 数。 */
  has(key: string): boolean;
  /** 该键上次结算出来的值；缺键返回 undefined。 */
  get(key: string): unknown;
};

/**
 * 按 journal 记录顺序折叠成"键 → 最新 result"。
 * result 覆盖并生效；started / failed 一律作废同名字段，于是失败路与被断路都不进缓存。
 */
export function buildReplayCache(records: readonly JournalRecord[]): ReplayCache {
  const cache = new Map<string, unknown>();
  for (const record of records) {
    const key = 'key' in record ? record.key : undefined;
    if (typeof key !== 'string' || key.length === 0) continue;
    if (record.type === 'result') cache.set(key, record.value);
    else if (record.type === 'started' || record.type === 'failed') cache.delete(key);
  }
  return {
    get size(): number {
      return cache.size;
    },
    has: (key: string): boolean => cache.has(key),
    get: (key: string): unknown => cache.get(key),
  };
}

/**
 * 续跑链的起点 = args 种子（与首跑同一个入口）。
 *
 * 刻意从种子重推、不接上一跑最后一条键：接旧键会让第二次运行的键整体偏移，
 * 与前缀对不上，缓存全部落空——重放的前提就是"同一段脚本、同一个 args、同一串键"。
 * args 变了种子就变，其后每一路都推不出缓存里的键，等价于全量重跑（§17 改 args 矩阵）。
 */
export function replayChainSeed(args: unknown): string {
  return argsChainSeed(args);
}
