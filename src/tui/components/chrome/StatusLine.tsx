import type { Detail, Theme } from '../../state.js';

/**
 * 按页面生成快捷键提示（复刻 Footer.hints，但用新 8 页索引）。
 * 追加输入栏提示：Normal 时显示 `i 输入`。
 */
function hints(tab: number, detail: Detail | undefined, zh: boolean, mouseEnabled: boolean, inputEditing: boolean): string {
  const scroll = mouseEnabled ? (zh ? '滚轮/↑↓ 滚动' : 'wheel/↑↓ scroll') : (zh ? '↑↓ 滚动' : '↑↓ scroll');
  const inputHint = inputEditing ? '' : (zh ? ' i 输入' : ' i input');

  if (detail) return zh ? `${scroll}   PgUp/PgDn 翻页   Esc 返回   q 退出${inputHint}` : `${scroll}   PgUp/PgDn page   Esc back   q quit${inputHint}`;
  if (tab === 0) return zh ? `Tab 页面   ${scroll}   c 配置   按住 v 显示凭据   q 退出${inputHint}` : `Tab page   ${scroll}   c configure   hold v for credentials   q quit${inputHint}`;
  if (tab === 1) return zh ? `↑↓/j k 选择   PgUp/PgDn 跳转   Enter 打开   n 新建/委派   u 操作   q 退出${inputHint}` : `↑↓/j k select   PgUp/PgDn jump   Enter open   n new/delegate   u actions   q quit${inputHint}`;
  if (tab === 2) return zh ? `↑↓/j k 选择   PgUp/PgDn 跳转   Enter 完整对话   m 发送   q 退出${inputHint}` : `↑↓/j k select   PgUp/PgDn jump   Enter conversation   m send   q quit${inputHint}`;
  if (tab === 3) return zh ? `${scroll}   r 时间线   q 退出${inputHint}` : `${scroll}   r timeline   q quit${inputHint}`;
  if (tab === 4) return zh ? `${scroll}   PgUp/PgDn 翻页   r 刷新   q 退出${inputHint}` : `${scroll}   PgUp/PgDn page   r refresh   q quit${inputHint}`;
  if (tab === 5) return zh ? '↑↓/j k 选择   PgUp/PgDn 跳转   e 新增   x 删除   q 退出' + inputHint : '↑↓/j k select   PgUp/PgDn jump   e add   x remove   q quit' + inputHint;
  if (tab === 6) return zh ? `${scroll}   c 修改配置   按住 v 显示凭据   k 轮换凭据   u 更新   q 退出${inputHint}` : `${scroll}   c configure   hold v to reveal   k rotate   u update   q quit${inputHint}`;
  // tab === 7 (Logs)
  return zh ? `${scroll}   PgUp/PgDn 翻页   a 调用详情 开/关   q 退出${inputHint}` : `${scroll}   PgUp/PgDn page   a call details on/off   q quit${inputHint}`;
}

/**
 * StatusLine — 底栏状态行（ADR-0004 决策 2，Footer 重构）。
 * 左侧快捷键提示 + 右侧 notice（good 色）。
 */
export function StatusLine({ tab, detail, theme, zh, mouseEnabled = true, notice, inputEditing = false }: {
  tab: number;
  detail?: Detail;
  theme: Theme;
  zh: boolean;
  mouseEnabled?: boolean;
  notice?: string;
  inputEditing?: boolean;
}) {
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={theme.background}>
      {notice ? <box paddingLeft={1} paddingRight={1}><text fg={theme.good} wrapMode="word">{notice}</text></box> : null}
      <box backgroundColor={theme.panelAlt} paddingLeft={1} paddingRight={1}>
        <text fg={theme.text} wrapMode="word"><b>{hints(tab, detail, zh, mouseEnabled, inputEditing)}</b></text>
      </box>
    </box>
  );
}
