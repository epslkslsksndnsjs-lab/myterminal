/**
 * i18n React context（#31 / ADR-0032 批5 第 10 刀）。
 *
 * 重构前 `zh: boolean` 与 `copy: Copy` 作为 prop 逐层穿过 22 个组件（52 个传递点）。
 * 本 context 让组件直接向单源取语言，prop 列表里不再出现语言参数。
 *
 * Provider 的放置有一条硬约束：**语言可在运行期被改变**（Settings → applySettings →
 * reconfigure 换 runtime）。因此 App 必须在自己内部提供 context，用每次渲染重算的
 * `i18nFor(runtime.config.uiLanguage)` 作为 value；若只在 index.tsx 的根上提供一次，
 * 改语言后界面不会跟着变——那是行为回归。
 *
 * value 直接用 `i18nFor()` 的记忆化实例，语言不变时引用恒定，不会每帧击穿下游 memo。
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { I18n } from './i18n.js';

export const I18nContext = createContext<I18n | undefined>(undefined);

export function I18nProvider({ value, children }: { value: I18n; children?: ReactNode }) {
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * 取当前语言上下文。缺 Provider 时直接抛错而不是静默回落某种语言——
 * 整屏渲染成错误语言比抛错更难发现，且 FatalErrorBoundary 会兜住渲染异常。
 */
export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n() used outside <I18nProvider>. Wrap the render root with I18nProvider.');
  return value;
}
