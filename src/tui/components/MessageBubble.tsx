/**
 * MessageBubble — 消息气泡组件（ADR-0004 决策 7）。
 * user 侧（TUI owner）= theme.user 左边框；agent 侧（其他 session）= theme.agent 左边框。
 * 时间格式用 relativeTime，自动换行 body。
 */
import type { Theme } from '../theme/index.js';
import { useI18n } from '../copy/context.js';
import { relativeTime } from '../model/relative-time.js';

export function MessageBubble({ fromName, fromId, body, createdAt, readAt, selfSide, theme }: {
  fromName: string;
  fromId: string;
  body: string;
  createdAt: string;
  readAt?: string;
  selfSide: 'user' | 'agent';
  theme: Theme;
}) {
  const { t } = useI18n();
  const sideColor = selfSide === 'user' ? theme.user : theme.agent;
  const displayName = selfSide === 'user' ? (t('You', '你')) : fromName;
  const now = new Date();
  const time = relativeTime(createdAt, now, t);

  return (
    <box flexDirection="column" border={['left']} borderColor={sideColor} backgroundColor={theme.panel} padding={1} marginBottom={0}>
      <box flexDirection="row" gap={1} flexWrap="wrap" width="100%">
        <text fg={sideColor} wrapMode="none"><b>{displayName}</b></text>
        <text fg={theme.muted} wrapMode="none">{time}</text>
        {readAt ? <text fg={theme.muted} wrapMode="none">{t('read', '已读')}</text> : null}
      </box>
      <text fg={theme.text} wrapMode="word">{body}</text>
    </box>
  );
}
