import { conversationGroups } from '../../tui-model.js';
import type { StoredState } from '../../types.js';
import type { Theme } from '../state.js';
import { Heading, Line } from './shared.js';

export function Messages({ state, selected, theme, zh, onSelect }: { state: StoredState; selected: number; theme: Theme; zh: boolean; onSelect: (index: number) => void }) {
  const groups = conversationGroups(state.messages);
  const names = new Map(state.sessions.map((session) => [session.id, session.name]));
  names.set('user', zh ? '用户' : 'User');
  if (!groups.length) return <box padding={1}><Line color={theme.muted}>{zh ? '暂无对话，按 m 发送消息。' : 'No conversations. Press m to send a message.'}</Line></box>;
  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      {groups.map((group, index) => {
        const [a, b] = group.sessionIds;
        const active = index === selected;
        return (
          <box key={group.id} id={`conversation-${group.id}`} flexDirection="column" border borderColor={active ? theme.accent : theme.border} backgroundColor={active ? theme.selected : theme.panel} padding={1} onMouseDown={() => onSelect(index)}>
            <box flexDirection="row" justifyContent="space-between" flexWrap="wrap">
              <text fg={active ? theme.selectedText : theme.text} wrapMode="word"><b>{names.get(a) || a} ↔ {names.get(b) || b}</b></text>
              <text fg={active ? theme.selectedText : theme.accent}>{group.messages.length} {zh ? '条消息' : 'messages'}</text>
            </box>
            <Line color={active ? theme.selectedText : theme.muted}>{group.lastMessage.body}</Line>
          </box>
        );
      })}
    </box>
  );
}

export function ConversationDetail({ state, id, theme, zh }: { state: StoredState; id: string; theme: Theme; zh: boolean }) {
  const group = conversationGroups(state.messages).find((item) => item.id === id);
  if (!group) return <box padding={1}><Line color={theme.bad}>{zh ? '对话已不存在，按 Esc 返回。' : 'Conversation no longer exists. Press Esc.'}</Line></box>;
  const names = new Map(state.sessions.map((session) => [session.id, session.name]));
  names.set('user', zh ? '用户' : 'User');
  const [a, b] = group.sessionIds;
  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      <Heading theme={theme}>{`${names.get(a) || a} ↔ ${names.get(b) || b}`}</Heading>
      <Line color={theme.muted}>{`${zh ? '完整永久对话' : 'Complete durable conversation'} · ${group.messages.length} ${zh ? '条消息' : 'messages'}`}</Line>
      {group.messages.map((message) => (
        <box key={message.id} flexDirection="column" border={['left']} borderColor={message.from === a ? theme.accent : theme.good} backgroundColor={theme.panel} padding={1}>
          <text fg={message.from === a ? theme.accent : theme.good} wrapMode="word"><b>{names.get(message.from) || message.from}</b> <span style={{ fg: theme.muted }}>{message.createdAt}{message.readAt ? ` · ${zh ? '已读' : 'read'}` : ''}</span></text>
          <text fg={theme.text} wrapMode="word">{message.body}</text>
        </box>
      ))}
    </box>
  );
}
