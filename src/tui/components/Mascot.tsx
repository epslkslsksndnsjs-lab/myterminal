import { useEffect, useState } from 'react';
import type { Theme } from '../theme/index.js';
import type { MascotMood } from '../model/mascot-mood.js';

/**
 * Mascot — ◔◔ 小生物（ADR-0004 决策 5）。
 * 固定 9 字符宽帧 + wrapMode="none"，表情切换/眨眼不会引起布局跳动。
 * 眨眼为组件内独立定时器（~0.4Hz 周期，140ms 闭眼），不进 renderRevision；
 * Windows 兼容 profile 下 animated 默认 false，静态表情。
 */
const FACES: Record<MascotMood, { eyes: string; mouth: string }> = {
  happy: { eyes: '◔ ◔', mouth: '◡' },
  expectant: { eyes: '◕ ◕', mouth: '◡' },
  worried: { eyes: '◔ ◔', mouth: '﹏' },
  sad: { eyes: '◔ ◔', mouth: '︿' },
  thinking: { eyes: '◔ ◔', mouth: '○' },
};

const BLINK_EYES = '− −';
const BLINK_CYCLE_MS = 2600;
const BLINK_CLOSED_MS = 140;

export function Mascot({ mood, theme, animated = process.platform !== 'win32' }: {
  mood: MascotMood;
  theme: Theme;
  animated?: boolean;
}) {
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (!animated) return;
    let closer: ReturnType<typeof setTimeout> | undefined;
    const cycle = setInterval(() => {
      setBlinking(true);
      closer = setTimeout(() => setBlinking(false), BLINK_CLOSED_MS);
    }, BLINK_CYCLE_MS);
    return () => { clearInterval(cycle); if (closer) clearTimeout(closer); };
  }, [animated]);

  const face = FACES[mood];
  const eyes = blinking ? BLINK_EYES : face.eyes;
  return (
    <box flexDirection="column" alignItems="center" flexShrink={0}>
      <text fg={theme.accent} wrapMode="none">╭───────╮</text>
      <text fg={theme.accent} wrapMode="none">{`╭╯ ${eyes} ╰╮`}</text>
      <text fg={theme.accent} wrapMode="none">{`╰╮  ${face.mouth}  ╭╯`}</text>
      <text fg={theme.accent} wrapMode="none">╰───────╯</text>
    </box>
  );
}
