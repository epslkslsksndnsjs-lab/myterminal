/**
 * Messages — 消息页（ADR-0004 决策 7）。
 * 对话卡片（Claude Code 风）+ 气泡对话流 ConversationDetail。
 * M4a 重做。
 */
import { conversationGroups } from '../../tui-model.js';
import type { StoredState } from '../../types.js';
import type { Theme } from '../state.js';
import type { Copy } from '../copy/index.js';
import { Heading, Line } from './shared.js';
import { MessageBubble } from '../components/MessageBubble.js';
import { useI18n } from '../copy/context.js';

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

export function Messages({ state, selected, theme, onSelect }: {
  state: StoredState;
  selected: number;
  theme: Theme;
  onSelect: (index: number) => void;
}) {
  const { t, copy } = useI18n();
  const groups = conversationGroups(state.messages);
  const names = new Map(state.sessions.map((s) => [s.id, s.name]));
  names.set('user', t('You', '你'));

  if (!groups.length) {
    return <box padding={1}><Line color={theme.muted}>{copy.emptyStates.messages}</Line></box>;
  }

  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      {groups.map((group, index) => {
        const [a, b] = group.sessionIds;
        const active = index === selected;
        const preview = truncate(group.lastMessage.body, 60);
        return (
          <box
            key={group.id}
            id={`conversation-${group.id}`}
            flexDirection="column"
            border
            borderColor={active ? theme.accent : theme.border}
            backgroundColor={active ? theme.selected : theme.panel}
            padding={1}
            onMouseDown={() => onSelect(index)}
          >
            <box flexDirection="row" justifyContent="space-between" flexWrap="wrap" width="100%">
              <text fg={active ? theme.selectedText : theme.text} wrapMode="word">
                <b>{names.get(a) || a} ↔ {names.get(b) || b}</b>
              </text>
              <text fg={active ? theme.selectedText : theme.accent} wrapMode="none">
                {group.messages.length} {t('msgs', '条消息')}
              </text>
            </box>
            <Line color={active ? theme.selectedText : theme.muted}>{preview}</Line>
          </box>
        );
      })}
    </box>
  );
}

export function ConversationDetail({ state, id, theme }: {
  state: StoredState;
  id: string;
  theme: Theme;
}) {
  const { t, copy } = useI18n();
  const group = conversationGroups(state.messages).find((item) => item.id === id);
  if (!group) {
    return <box padding={1}><Line color={theme.bad}>{t('Conversation no longer exists. Press Esc.', '对话已不存在，按 Esc 返回。')}</Line></box>;
  }
  const names = new Map(state.sessions.map((s) => [s.id, s.name]));
  names.set('user', t('You', '你'));
  const [a, b] = group.sessionIds;

  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      <Heading theme={theme}>{`${names.get(a) || a} ↔ ${names.get(b) || b}`}</Heading>
      <Line color={theme.muted}>
        {`${t('Complete durable conversation', '完整永久对话')} · ${group.messages.length} ${t('messages', '条消息')}`}
      </Line>
      {group.messages.map((message) => {
        const selfSide: 'user' | 'agent' = message.from === 'user' ? 'user' : 'agent';
        return (
          <MessageBubble
            key={message.id}
            fromName={names.get(message.from) || message.from}
            fromId={message.from}
            body={message.body}
            createdAt={message.createdAt}
            readAt={message.readAt}
            selfSide={selfSide}
            theme={theme}
          />
        );
      })}
    </box>
  );
}
