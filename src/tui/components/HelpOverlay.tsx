import { useBindings } from '@opentui/keymap/react';
import type { Theme } from '../state.js';

/**
 * HelpOverlay — 命令与快捷键帮助浮层（ADR-0004 决策 4 附录 A.7）。
 * 全屏半透明遮罩 + 居中面板，列出全部 / 命令 + 别名 + 页面快捷键。
 * priority 300，Esc 关闭。
 */
const COMMAND_LIST: { cmd: string; alias?: string; descZh: string; descEn: string }[] = [
  { cmd: '/home', alias: '/overview /概览', descZh: '概览页', descEn: 'Overview page' },
  { cmd: '/sessions', alias: '/会话', descZh: '会话页', descEn: 'Sessions page' },
  { cmd: '/messages', alias: '/消息', descZh: '消息页', descEn: 'Messages page' },
  { cmd: '/timeline', alias: '/时间线', descZh: '时间线页', descEn: 'Timeline page' },
  { cmd: '/diff', descZh: 'Diff 页', descEn: 'Diff page' },
  { cmd: '/extensions', alias: '/扩展', descZh: '扩展页', descEn: 'Extensions page' },
  { cmd: '/settings', alias: '/设置', descZh: '设置页', descEn: 'Settings page' },
  { cmd: '/logs', alias: '/日志', descZh: '日志页', descEn: 'Logs page' },
  { cmd: '/new', descZh: '创建新 session', descEn: 'Create new session' },
  { cmd: '/send', descZh: '发送消息', descEn: 'Send message' },
  { cmd: '/refresh', descZh: '刷新 Diff', descEn: 'Refresh diff' },
];

const SHORTCUTS: { key: string; descZh: string; descEn: string }[] = [
  { key: '1-8', descZh: '切换页面', descEn: 'Switch page' },
  { key: 'Tab / Shift+Tab', descZh: '上一页/下一页', descEn: 'Previous/next page' },
  { key: '↑↓ / j k', descZh: '列表选择移动', descEn: 'Move list selection' },
  { key: 'i', descZh: '进入输入模式', descEn: 'Enter input mode' },
  { key: '/', descZh: '输入 / 命令', descEn: 'Type / command' },
  { key: '?', descZh: '打开帮助（本页）', descEn: 'Open help (this page)' },
  { key: 'v (按住)', descZh: '显示凭据', descEn: 'Reveal credentials' },
  { key: 'q / Ctrl+C', descZh: '退出', descEn: 'Quit' },
  { key: 'Esc', descZh: '返回 / 关闭输入', descEn: 'Back / close input' },
];

export function HelpOverlay({ theme, zh, width, height, onClose }: {
  theme: Theme;
  zh: boolean;
  width: number;
  height: number;
  onClose: () => void;
}) {
  useBindings(() => ({
    priority: 300,
    bindings: [
      { key: 'escape', cmd: () => { onClose(); return true; } },
    ],
  }), [onClose]);

  const panelWidth = Math.max(1, Math.min(80, width - 4));
  const panelHeight = Math.max(1, Math.min(24, height - 4));

  return (
    <box position="absolute" left={0} top={0} width={width} height={height} alignItems="center" justifyContent="center" backgroundColor={`${theme.background}cc`}>
      <box width={panelWidth} height={panelHeight} border borderColor={theme.accent} backgroundColor={theme.panel} flexDirection="column" padding={1}>
        <box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <text fg={theme.accent}><b>{zh ? '帮助' : 'Help'}</b></text>
          <text fg={theme.muted} wrapMode="none">Esc {zh ? '关闭' : 'close'}</text>
        </box>
        <scrollbox flexGrow={1} minHeight={0} viewportCulling>
          <text fg={theme.text}><b>{zh ? '命令（输入栏以 / 开头）' : 'Commands (start with / in InputBar)'}</b></text>
          <text> </text>
          {COMMAND_LIST.map((item) => (
            <box key={item.cmd} flexDirection="row" gap={2}>
              <text fg={theme.accent} wrapMode="none">{item.cmd}</text>
              {item.alias ? <text fg={theme.muted} wrapMode="none">{item.alias}</text> : null}
              <text fg={theme.text} wrapMode="none">— {zh ? item.descZh : item.descEn}</text>
            </box>
          ))}
          <text> </text>
          <text fg={theme.text}><b>{zh ? '快捷键' : 'Shortcuts'}</b></text>
          <text> </text>
          {SHORTCUTS.map((item) => (
            <box key={item.key} flexDirection="row" gap={2}>
              <text fg={theme.accent} wrapMode="none">{item.key}</text>
              <text fg={theme.text} wrapMode="none">— {zh ? item.descZh : item.descEn}</text>
            </box>
          ))}
        </scrollbox>
      </box>
    </box>
  );
}
