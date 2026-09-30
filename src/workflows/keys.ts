import { createHash } from 'node:crypto';

/**
 * 缓存键——前缀哈希链，键序 = 脚本调用序（admission）。
 *
 *   key_0 = 种子（args 的哈希；args 是链的种子，改 args 即全量重跑）
 *   key_n = H(key_(n-1), H(prompt_n, 归一 opts_n))
 *
 * 两条性质是续跑正确性的地基：
 *   1. 第 n 路之后全部失效——改一个字符，从该路起链式换键，最长未变前缀才走缓存；
 *   2. 完成顺序与调度顺序不进键——键在 admission 那一刻算完，N 路并发乱序归来也不漂移。
 * 因此派生必须在任何 await 之前同步滚动（并发扇出的微任务爆发同样保序）。
 */

export const JOURNAL_KEY_VERSION = 'v2';
export const KEY_PATTERN = /^v2:[0-9a-f]{64}$/;
/** args 深度上限：超深按不可序列化处理，绝不让 JSON.stringify 栈溢出。 */
export const KEYS_MAX_DEPTH = 64;
/** 不可序列化 args 的固定回退——同一串输入永远得到同一颗种子。 */
export const NON_SERIALIZABLE_ARGS = 'non-serializable-args';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function depthOf(value: unknown, seen: Set<object>, depth: number): number {
  if (value === null || typeof value !== 'object') return depth;
  if (seen.has(value as object)) return Number.POSITIVE_INFINITY;
  seen.add(value as object);
  let max = depth;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    max = Math.max(max, depthOf(child, seen, depth + 1));
    if (max > KEYS_MAX_DEPTH) break;
  }
  seen.delete(value as object);
  return max;
}

function serializable(value: unknown): string | undefined {
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depthOf(value, new Set(), 0) > KEYS_MAX_DEPTH) return undefined;
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/** 链种子：args 的哈希。未提供与 null 同种子；不可序列化走固定回退。 */
export function argsChainSeed(args: unknown): string {
  const text = serializable(args ?? null) ?? NON_SERIALIZABLE_ARGS;
  return `${JOURNAL_KEY_VERSION}:${sha256(text)}`;
}

/**
 * 一路调用的键。canonicalOpts 必须是归一后的投影串（展示项已剔除），
 * prompt 逐字符进键——分隔符用 NUL，避免拼接歧义。
 */
export function deriveAgentKey(prefixHash: string, prompt: string, canonicalOpts: string): string {
  const inner = sha256(`${prompt}\u0000${canonicalOpts}`);
  return `${JOURNAL_KEY_VERSION}:${sha256(`${prefixHash}\u0000${inner}`)}`;
}
