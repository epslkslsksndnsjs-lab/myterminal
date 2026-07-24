import type { Detail, Theme } from '../state.js';

function hints(tab: number, detail: Detail | undefined, zh: boolean, mouseEnabled: boolean): string {
  const scroll = mouseEnabled ? (zh ? '滚轮/↑↓ 滚动' : 'wheel/↑↓ scroll') : (zh ? '↑↓ 滚动' : '↑↓ scroll');
  if (detail) return zh ? `${scroll}   PgUp/PgDn 翻页   Esc 返回   q 退出` : `${scroll}   PgUp/PgDn page   Esc back   q quit`;
  if (tab === 0) return zh ? `1–7/Tab 页面   ${scroll}   c 配置   按住 v 显示凭据   q 退出` : `1–7/Tab page   ${scroll}   c configure   hold v for credentials   q quit`;
  if (tab === 1) return zh ? '↑↓/j k 选择   PgUp/PgDn 跳转   Enter 打开   n 新建/委派   u 操作   q 退出' : '↑↓/j k select   PgUp/PgDn jump   Enter open   n new/delegate   u actions   q quit';
  if (tab === 2) return zh ? '↑↓/j k 选择   PgUp/PgDn 跳转   Enter 完整对话   m 发送   q 退出' : '↑↓/j k select   PgUp/PgDn jump   Enter conversation   m send   q quit';
  if (tab === 3) return zh ? `${scroll}   PgUp/PgDn 翻页   r 刷新   q 退出` : `${scroll}   PgUp/PgDn page   r refresh   q quit`;
  if (tab === 4) return zh ? '↑↓/j k 选择   PgUp/PgDn 跳转   e 新增   x 删除   q 退出' : '↑↓/j k select   PgUp/PgDn jump   e add   x remove   q quit';
  if (tab === 5) return zh ? `${scroll}   c 修改配置   按住 v 显示凭据   k 轮换凭据   q 退出` : `${scroll}   c configure   hold v to reveal   k rotate   q quit`;
  return zh ? `${scroll}   PgUp/PgDn 翻页   a 调用详情 开/关   q 退出` : `${scroll}   PgUp/PgDn page   a call details on/off   q quit`;
}

export function Footer({ tab, detail, theme, zh, mouseEnabled = true, notice }: { tab: number; detail?: Detail; theme: Theme; zh: boolean; mouseEnabled?: boolean; notice?: string }) {
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={theme.background}>
      {notice ? <box paddingLeft={1} paddingRight={1}><text fg={theme.good} wrapMode="word">{notice}</text></box> : null}
      <box backgroundColor={theme.panelAlt} paddingLeft={1} paddingRight={1}>
        <text fg={theme.text} wrapMode="word"><b>{hints(tab, detail, zh, mouseEnabled)}</b></text>
      </box>
    </box>
  );
}
