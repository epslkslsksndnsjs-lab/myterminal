/**
 * Extensions — 自定义扩展页（ADR-0004 决策 7）。
 * 卡片列表 + handler 类型徽标 + 俏皮空状态 + Mascot。
 */
import type { StoredState } from '../../types.js';
import type { Theme } from '../state.js';
import type { Copy } from '../copy/index.js';
import { Mascot } from '../components/Mascot.js';
import { Heading, Line } from './shared.js';
import { useI18n } from '../copy/context.js';

export function Extensions({ state, selected, theme, onSelect }: {
  state: StoredState;
  selected: number;
  theme: Theme;
  onSelect: (index: number) => void;
}) {
  const { t, copy } = useI18n();
  if (!state.extensions.length) {
    return (
      <box flexDirection="column" padding={1} gap={1} alignItems="center">
        <Mascot mood="happy" theme={theme} />
        <Heading theme={theme}>{t('Custom extensions', '自定义扩展')}</Heading>
        <Line color={theme.muted}>{copy.emptyStates.extensions}</Line>
      </box>
    );
  }

  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      {state.extensions.map((extension, index) => {
        const active = index === selected;
        return (
          <box
            key={extension.name}
            id={`extension-${extension.name}`}
            flexDirection="column"
            border borderColor={active ? theme.accent : theme.border}
            backgroundColor={active ? theme.selected : theme.panel}
            padding={1}
            onMouseDown={() => onSelect(index)}
          >
            <box flexDirection="row" justifyContent="space-between" flexWrap="wrap" alignItems="center">
              <text fg={active ? theme.selectedText : theme.text}><b>{extension.name}</b></text>
              <box paddingLeft={1} paddingRight={1} backgroundColor={theme.panelAlt}>
                <text fg={theme.accent} wrapMode="none">{extension.handler.kind}</text>
              </box>
            </box>
            <Line color={active ? theme.selectedText : theme.text}>{extension.title}</Line>
            <Line color={active ? theme.selectedText : theme.muted}>{extension.description}</Line>
          </box>
        );
      })}
    </box>
  );
}
