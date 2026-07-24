import type { StoredState } from '../../types.js';
import type { Theme } from '../state.js';
import { Heading, Line } from './shared.js';

export function Extensions({ state, selected, theme, zh, onSelect }: { state: StoredState; selected: number; theme: Theme; zh: boolean; onSelect: (index: number) => void }) {
  if (!state.extensions.length) return <box flexDirection="column" padding={1}><Heading theme={theme}>{zh ? '自定义扩展' : 'Custom extensions'}</Heading><Line color={theme.muted}>{zh ? '暂无自定义扩展，按 e 新增。' : 'No custom extensions. Press e to add one.'}</Line></box>;
  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      {state.extensions.map((extension, index) => {
        const active = index === selected;
        return (
          <box key={extension.name} id={`extension-${extension.name}`} flexDirection="column" border borderColor={active ? theme.accent : theme.border} backgroundColor={active ? theme.selected : theme.panel} padding={1} onMouseDown={() => onSelect(index)}>
            <box flexDirection="row" justifyContent="space-between" flexWrap="wrap"><text fg={active ? theme.selectedText : theme.text}><b>{extension.name}</b></text><text fg={active ? theme.selectedText : theme.accent}>{extension.handler.kind}</text></box>
            <Line color={active ? theme.selectedText : theme.text}>{extension.title}</Line>
            <Line color={active ? theme.selectedText : theme.muted}>{extension.description}</Line>
          </box>
        );
      })}
    </box>
  );
}
