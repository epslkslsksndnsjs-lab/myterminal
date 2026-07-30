import type { Theme } from '../../state.js';
import { useI18n } from '../../copy/context.js';

/** 页面标签名：zh 用中文，en 用 TABS 原名 */
const LABELS_ZH = ['概览', '会话', '消息', '时间线', 'Diff', '扩展', '设置', '日志', '子代理'];
const LABELS_EN = ['Overview', 'Sessions', 'Messages', 'Timeline', 'Diff', 'Extensions', 'Settings', 'Logs', 'Subagents'];

/**
 * BottomNav — 底部轻量 pill 式页签导航（ADR-0004 决策 2.4）。
 * 当前页 accent 背景圆角 pill，其余 muted 文字。点击切换。
 */
export function BottomNav({ active, theme, onSelect }: {
  active: number;
  theme: Theme;
  onSelect: (index: number) => void;
}) {
  const { zh } = useI18n();
  const labels = zh ? LABELS_ZH : LABELS_EN;

  return (
    <box flexDirection="row" flexShrink={0} backgroundColor={theme.background} paddingLeft={1} paddingRight={1} gap={0}>
      {labels.map((label, index) => {
        const isActive = index === active;
        return (
          <box
            key={label}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={isActive ? theme.accent : undefined}
            onMouseDown={() => onSelect(index)}
          >
            <text fg={isActive ? theme.background : theme.muted} wrapMode="none">{label}</text>
          </box>
        );
      })}
    </box>
  );
}
