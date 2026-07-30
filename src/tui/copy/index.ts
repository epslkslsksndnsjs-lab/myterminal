import type { Copy } from './types.js';
import { zhCN } from './zh-CN.js';
import { en } from './en.js';

export type { Copy, EmptyStateKey } from './types.js';
export { i18nFor, type I18n, type Lang, type Translate } from './i18n.js';

/** 遗留入口：语言判定的单源是 `i18nFor`，此函数仅为既有调用点与测试保留。 */
export function copyFor(zh: boolean): Copy {
  return zh ? zhCN : en;
}

/** L1 问候语：按当前小时取对应语言的问候。 */
export function greetingFor(copy: Copy, at: Date = new Date()): string {
  return copy.greetingFor(at.getHours());
}

/**
 * L1 状态动词：按操作 key 确定性锁定一词（ADR-0004 决策 6）。
 * 同一次操作期间词不变，避免轮换闪烁；不同操作各自随机。
 */
export function verbFor(copy: Copy, key: string): string {
  const verbs = copy.statusVerbs;
  if (!verbs.length) return '';
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return verbs[hash % verbs.length];
}

/** L1 状态动词完整展示形式（"正在捣鼓…" / "Tinkering…"）。 */
export function verbLabel(copy: Copy, key: string): string {
  const verb = verbFor(copy, key);
  return copy.verbPrefix ? `${copy.verbPrefix}${verb}…` : `${verb}…`;
}
