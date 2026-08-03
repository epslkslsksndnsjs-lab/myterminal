import type { Detail, Theme } from '../../state.js';
import { useI18n } from '../../copy/context.js';
import type { Translate } from '../../copy/i18n.js';

/**
 * 按页面生成快捷键提示（复刻 Footer.hints，但用新 8 页索引）。
 * 追加输入栏提示：Normal 时显示 `i 输入`。
 */
export function hints(tab: number, detail: Detail | undefined, t: Translate, mouseEnabled: boolean, inputEditing: boolean): string {
  const scroll = mouseEnabled ? (t('wheel/↑↓ scroll', '滚轮/↑↓ 滚动')) : (t('↑↓ scroll', '↑↓ 滚动'));
  const inputHint = inputEditing ? '' : (t(' i input', ' i 输入'));

  if (detail) return t(`${scroll}   PgUp/PgDn page   Esc back   q quit${inputHint}`, `${scroll}   PgUp/PgDn 翻页   Esc 返回   q 退出${inputHint}`);
  if (tab === 0) return t(`Tab page   ${scroll}   c configure   hold v for credentials   q quit${inputHint}`, `Tab 页面   ${scroll}   c 配置   按住 v 显示凭据   q 退出${inputHint}`);
  if (tab === 1) return t(`↑↓/j k select   PgUp/PgDn jump   Enter open   n new/delegate   u actions   q quit${inputHint}`, `↑↓/j k 选择   PgUp/PgDn 跳转   Enter 打开   n 新建/委派   u 操作   q 退出${inputHint}`);
  if (tab === 2) return t(`↑↓/j k select   PgUp/PgDn jump   Enter conversation   m send   q quit${inputHint}`, `↑↓/j k 选择   PgUp/PgDn 跳转   Enter 完整对话   m 发送   q 退出${inputHint}`);
  if (tab === 3) return t(`${scroll}   r timeline   q quit${inputHint}`, `${scroll}   r 时间线   q 退出${inputHint}`);
  if (tab === 4) return t(`${scroll}   PgUp/PgDn page   r refresh   q quit${inputHint}`, `${scroll}   PgUp/PgDn 翻页   r 刷新   q 退出${inputHint}`);
  if (tab === 5) return t('↑↓/j k select   PgUp/PgDn jump   e add   x remove   q quit' + inputHint, '↑↓/j k 选择   PgUp/PgDn 跳转   e 新增   x 删除   q 退出' + inputHint);
  if (tab === 6) return t(`${scroll}   c configure   hold v to reveal   k rotate   u update   q quit${inputHint}`, `${scroll}   c 修改配置   按住 v 显示凭据   k 轮换凭据   u 更新   q 退出${inputHint}`);
  // tab === 7 (Logs) 走下方默认分支；#89 修复：tab === 8 (Subagents) 须提前拦截，否则误显示 Logs 提示
  if (tab === 8) return t(`${scroll}   Tab page   q quit${inputHint}`, `${scroll}   Tab 翻页   q 退出${inputHint}`);
  // tab === 7 (Logs) 默认分支
  return t(`${scroll}   PgUp/PgDn page   a call details on/off   q quit${inputHint}`, `${scroll}   PgUp/PgDn 翻页   a 调用详情 开/关   q 退出${inputHint}`);
}

/**
 * StatusLine — 底栏状态行（ADR-0004 决策 2，Footer 重构）。
 * 左侧快捷键提示 + 右侧 notice（good 色）。
 */
export function StatusLine({ tab, detail, theme, mouseEnabled = true, notice, inputEditing = false }: {
  tab: number;
  detail?: Detail;
  theme: Theme;
  mouseEnabled?: boolean;
  notice?: string;
  inputEditing?: boolean;
}) {
  const { t } = useI18n();
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={theme.background}>
      {notice ? <box paddingLeft={1} paddingRight={1}><text fg={theme.good} wrapMode="word">{notice}</text></box> : null}
      <box backgroundColor={theme.panelAlt} paddingLeft={1} paddingRight={1}>
        <text fg={theme.text} wrapMode="word"><b>{hints(tab, detail, t, mouseEnabled, inputEditing)}</b></text>
      </box>
    </box>
  );
}
