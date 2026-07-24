import type { MyTerminalSession } from '../../types.js';
import { phaseColor, presenceColor, type Theme } from '../state.js';

export function Heading({ children, theme }: { children: string; theme: Theme }) {
  return <text fg={theme.text} wrapMode="word"><b>{children}</b></text>;
}

export function Line({ children, color, bold = false }: { children: string; color: string; bold?: boolean }) {
  return <text fg={color} wrapMode="word">{bold ? <b>{children}</b> : children}</text>;
}

export function SessionStatus({ session, theme }: { session: MyTerminalSession; theme: Theme }) {
  return (
    <box flexDirection="row" gap={1} flexWrap="wrap">
      <text fg={phaseColor(theme, session.phase)}>● {session.phase}</text>
      <text fg={presenceColor(theme, session)}>○ {session.presence}</text>
    </box>
  );
}
