/**
 * BlinkingDot — 活跃会话的黑白闪烁圆点。
 * active=true 时 500ms 在 theme.text / theme.background 间切换；
 * active=false 时保持 accent 色。判定逻辑由调用方决定。
 */
import { useEffect, useState } from 'react';
import type { Theme } from '../state.js';

export function BlinkingDot({ active, theme }: { active: boolean; theme: Theme }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setOn((v) => !v), 500);
    return () => clearInterval(timer);
  }, [active]);
  const fg = !active ? theme.accent : on ? theme.text : theme.background;
  return <text fg={fg} wrapMode="none">●</text>;
}
