/**
 * i18n 单一来源（#31 / ADR-0032 批5 第 10 刀）。
 *
 * 重构前 TUI 有三套并存的文案机制：组件内联 `zh ? … : …` 三元、TuiController.text(en, zh)、
 * copy/ 字典。三者各自从 `uiLanguage` 推导语言，`zh: boolean` 再逐层 prop-drilling 穿过
 * 每个组件。本模块把「语言判定」收敛为唯一入口 `i18nFor(lang)`，其余三处统一改为
 * 引用它产出的 `I18n`。
 *
 * 注意：本刀只收敛「语言来源」，不做字典化——字符串仍以 `t(en, zh)` 的形式留在调用点
 * （主理人 2026-07-31 裁定方案 A）。因此新增第三种语言仍需改调用点；全量字典化另行开票。
 *
 * 记忆化是硬要求：`i18nFor` 每次返回同一实例，React context value 才不会每帧变化，
 * 否则整棵组件树的 memo 会被击穿。
 */
import type { Copy } from './types.js';
import { zhCN } from './zh-CN.js';
import { en } from './en.js';

/** 与 MyTerminalSettings.uiLanguage 对齐。 */
export type Lang = 'en' | 'zh-CN';

/** 就地二选一：与原 TuiController.text(en, zh) 的参数顺序逐字一致，不得调换。 */
export type Translate = (en: string, zh: string) => string;

export type I18n = {
  readonly lang: Lang;
  /** 兼容位：等价于 lang === 'zh-CN'，供尚未字典化的判定逻辑使用。 */
  readonly zh: boolean;
  readonly t: Translate;
  readonly copy: Copy;
};

function build(lang: Lang, copy: Copy): I18n {
  const isZh = lang === 'zh-CN';
  return Object.freeze({
    lang,
    zh: isZh,
    t: (english: string, chinese: string) => (isZh ? chinese : english),
    copy,
  });
}

const EN = build('en', en);
const ZH_CN = build('zh-CN', zhCN);

/**
 * 语言 → i18n 实例。未知语言回落 en，与 config.ts 的
 * `['en', 'zh-CN'].includes(uiLanguage)` 校验保持同一口径。
 */
export function i18nFor(lang: string | undefined): I18n {
  return lang === 'zh-CN' ? ZH_CN : EN;
}
