import type { ReactNode } from 'react';
import type { Theme } from '../state.js';

export function Modal({ title, theme, width, height, children }: { title: string; theme: Theme; width: number; height: number; children: ReactNode }) {
  const panelWidth = Math.max(1, Math.min(92, width - 2));
  const panelHeight = Math.max(1, Math.min(28, height - 2));
  return (
    <box position="absolute" left={0} top={0} width={width} height={height} alignItems="center" justifyContent="center" backgroundColor="#000000bb">
      <box width={panelWidth} height={panelHeight} border borderColor={theme.accent} backgroundColor={theme.panel} flexDirection="column" padding={1} title={title} titleColor={theme.accent}>
        {children}
      </box>
    </box>
  );
}
