import type { Theme } from '../state.js';
import { copyFor } from '../copy/index.js';
import { Mascot } from '../components/Mascot.js';

/**
 * Timeline — 活动时间线占位页（ADR-0004 决策 7）。
 * M4b 填充完整内容（消息 + 工具审计归并的全量活动流）。
 */
export function Timeline({ theme, zh }: { theme: Theme; zh: boolean }) {
  const copy = copyFor(zh);
  return (
    <box flexDirection="column" alignItems="center" paddingTop={4} paddingLeft={2} paddingRight={2}>
      <Mascot mood="happy" theme={theme} />
      <text> </text>
      <text fg={theme.muted} wrapMode="word">{copy.emptyStates.timeline}</text>
      <text fg={theme.muted} wrapMode="word">
        {zh ? '完整时间线将在 M4b 到来。' : 'Full timeline arrives in M4b.'}
      </text>
    </box>
  );
}
