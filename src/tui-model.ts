import type { MyTerminalMessage, MyTerminalSession } from './types.js';

export type LogicalSessionGroup = { id: string; title: string; sessions: MyTerminalSession[]; children: MyTerminalSession[]; current: MyTerminalSession };
export type ConversationGroup = { id: string; sessionIds: [string, string]; messages: MyTerminalMessage[]; lastMessage: MyTerminalMessage };

export function logicalSessionGroups(sessions: MyTerminalSession[]): LogicalSessionGroup[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = sessions.filter((session) => !session.parentSessionId);
  const originCache = new Map<string, string>();
  const originId = (session: MyTerminalSession): string => {
    const traversed: string[] = [];
    const seen = new Set<string>();
    let current = session;
    let cached: string | undefined;
    while (!seen.has(current.id)) {
      cached = originCache.get(current.id);
      if (cached) break;
      seen.add(current.id);
      traversed.push(current.id);
      if (!current.continuesSessionId) break;
      const predecessor = byId.get(current.continuesSessionId);
      if (!predecessor || predecessor.parentSessionId) break;
      current = predecessor;
    }
    const origin = cached || current.id;
    for (const id of traversed) originCache.set(id, origin);
    return origin;
  };
  const childrenByParent = new Map<string, MyTerminalSession[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    const children = childrenByParent.get(session.parentSessionId);
    if (children) children.push(session); else childrenByParent.set(session.parentSessionId, [session]);
  }
  const grouped = new Map<string, MyTerminalSession[]>();
  for (const session of roots) {
    const origin = originId(session);
    const chain = grouped.get(origin);
    if (chain) chain.push(session); else grouped.set(origin, [session]);
  }
  return [...grouped.entries()].map(([id, chain]) => {
    const ordered = chain.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const children = ordered.flatMap((item) => childrenByParent.get(item.id) || []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { id, title: ordered[0]?.name || id, sessions: ordered, children, current: ordered.at(-1)! };
  }).sort((a, b) => b.current.updatedAt.localeCompare(a.current.updatedAt));
}

export function conversationGroups(messages: MyTerminalMessage[]): ConversationGroup[] {
  const groups = new Map<string, MyTerminalMessage[]>();
  for (const message of messages) {
    const pair = [message.from, message.to].sort() as [string, string]; const id = pair.join('::');
    const group = groups.get(id);
    if (group) group.push(message); else groups.set(id, [message]);
  }
  return [...groups.entries()].map(([id, items]) => {
    const ordered = items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { id, sessionIds: id.split('::') as [string, string], messages: ordered, lastMessage: ordered.at(-1)! };
  }).sort((a, b) => b.lastMessage.createdAt.localeCompare(a.lastMessage.createdAt));
}

export function selectedViewport<T>(items: T[], selected: number, height: number): { selected: number; start: number; visible: T[] } {
  const index = Math.max(0, Math.min(Math.max(0, items.length - 1), selected)); const size = Math.max(1, height);
  const start = Math.max(0, Math.min(index - Math.floor(size / 2), Math.max(0, items.length - size)));
  return { selected: index, start, visible: items.slice(start, start + size) };
}
