import { TABS, type Theme } from '../state.js';

const ZH = ['概览', '会话', '消息', '差异', '扩展', '设置', '日志'];

export function TabBar({ active, theme, zh, onSelect }: { active: number; theme: Theme; zh: boolean; onSelect: (index: number) => void }) {
  return (
    <box flexDirection="row" flexWrap="wrap" flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={theme.background}>
      {TABS.map((tab, index) => (
        <box key={tab} backgroundColor={index === active ? theme.selected : theme.background} paddingLeft={1} paddingRight={1} onMouseDown={() => onSelect(index)}>
          <text fg={index === active ? theme.selectedText : theme.muted}><b>{index + 1} {zh ? ZH[index] : tab}</b></text>
        </box>
      ))}
    </box>
  );
}
