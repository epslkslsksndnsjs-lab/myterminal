/**
 * history-entry — 历史条目语义化视图（ADR-0004 决策 7 / A.4 类型分发）。
 * 将持久化历史条目转为"类型图标 + 语义摘要"的渲染就绪数据，禁止完整 JSON 裸输出。
 * 纯函数，无副作用，可单测。
 */

/**
 * 历史条目渲染视图。
 * icon — 单字符图形（非 emoji），从 type 映射
 * tone — 映射到 theme 角色（accent/good/warn/bad/muted）
 * title — 一行语义摘要（从 data 提取关键字段）
 * detail — 次要信息（可选，截断 120 字符）
 */
export type HistoryEntryView = {
  type: string;
  icon: string;
  tone: 'accent' | 'good' | 'warn' | 'bad' | 'muted';
  title: string;
  detail?: string;
};

/** 安全截断文本（按字符数，不是字节）。 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

/** 防御式读取字符串字段。 */
function str(data: unknown, key: string, fallback = ''): string {
  if (typeof data !== 'object' || data === null) return fallback;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : fallback;
}

/** 防御式读取字符串数组字段。 */
function strs(data: unknown, key: string): string[] {
  if (typeof data !== 'object' || data === null) return [];
  const value = (data as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * 将单条持久化历史条目转为语义化视图。
 * 覆盖 11 种实测类型（按 src/store.ts SessionHistoryEntry 格式），未知类型走 fallback。
 * @param entry — { at, type, data } 来自 historiesForTui
 * @param zh — 是否中文
 */
export function viewForHistoryEntry(
  entry: { at: string; type: string; data: unknown },
  zh: boolean,
): HistoryEntryView {
  const { type, data } = entry;

  // ── session_created ──
  if (type === 'session_created') {
    const mode = str(data, 'mode');
    return {
      type,
      icon: '◆',
      tone: 'accent',
      title: zh ? '创建会话' : 'Session created',
      detail: mode ? `${zh ? '模式' : 'mode'}: ${mode}` : undefined,
    };
  }

  // ── tool_audit ──
  if (type === 'tool_audit') {
    const action = str(data, 'action');
    const status = str(data, 'status');
    const durationMs = typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).durationMs === 'number'
      ? (data as Record<string, unknown>).durationMs as number
      : 0;
    const tool = str(data, 'tool') || action;

    let tone: HistoryEntryView['tone'] = 'muted';
    if (status === 'completed') tone = 'good';
    else if (status === 'running') tone = 'accent';
    else if (status === 'failed' || status === 'timeout') tone = 'bad';
    else if (status === 'policy_rejected') tone = 'warn';

    const title = tool || (zh ? '工具调用' : 'Tool call');
    const detailParts: string[] = [];
    if (status) detailParts.push(status);
    if (status === 'completed' && durationMs > 0) detailParts.push(`${durationMs}ms`);
    return { type, icon: '⚙', tone, title, detail: detailParts.length ? clip(detailParts.join(' · '), 120) : undefined };
  }

  // ── checkpoint ──
  if (type === 'checkpoint') {
    const summary = str(data, 'summary');
    const phase = str(data, 'phase');
    const tags = strs(data, 'tags');
    return {
      type,
      icon: '⏺',
      tone: 'accent',
      title: summary || (zh ? '检查点' : 'Checkpoint'),
      detail: [phase, tags.length ? `#${tags.join(' #')}` : ''].filter(Boolean).join(' ') || undefined,
    };
  }

  // ── event ──
  if (type === 'event') {
    const kind = str(data, 'kind');
    const sourceSessionId = str(data, 'sourceSessionId');
    return {
      type,
      icon: '▸',
      tone: 'muted',
      title: kind || (zh ? '事件' : 'Event'),
      detail: sourceSessionId ? `${zh ? '来源' : 'from'}: ${clip(sourceSessionId, 40)}` : undefined,
    };
  }

  // ── message_received / message_sent ──
  if (type === 'message_received' || type === 'message_sent') {
    const body = str(data, 'body');
    const from = str(data, 'from');
    const to = str(data, 'to');
    const direction = type === 'message_received'
      ? (zh ? '收到' : 'Received')
      : (zh ? '发送' : 'Sent');
    return {
      type,
      icon: '✉',
      tone: 'accent',
      title: clip(body || (zh ? '(空消息)' : '(empty)'), 100),
      detail: `${direction}${from ? ` ${zh ? '来自' : 'from'} ${clip(from, 30)}` : ''}${to ? ` → ${clip(to, 30)}` : ''}`,
    };
  }

  // ── claimed ──
  if (type === 'claimed') {
    const controllerId = str(data, 'controllerId');
    return {
      type,
      icon: '◆',
      tone: 'good',
      title: zh ? '已接管' : 'Claimed',
      detail: controllerId ? clip(controllerId, 40) : undefined,
    };
  }

  // ── released ──
  if (type === 'released') {
    const phase = str(data, 'phase');
    const presence = str(data, 'presence');
    return {
      type,
      icon: '◆',
      tone: 'muted',
      title: zh ? '已释放' : 'Released',
      detail: [phase, presence].filter(Boolean).join(' / ') || undefined,
    };
  }

  // ── stale ──
  if (type === 'stale') {
    return { type, icon: '◆', tone: 'warn', title: zh ? '已过期' : 'Stale' };
  }

  // ── tags_updated ──
  if (type === 'tags_updated') {
    const tags = strs(data, 'tags');
    return {
      type,
      icon: '◆',
      tone: 'muted',
      title: tags.length ? tags.join(', ') : (zh ? '(无标签)' : '(no tags)'),
      detail: zh ? '标签已更新' : 'Tags updated',
    };
  }

  // ── task_package ──
  if (type === 'task_package') {
    const objective = str(data, 'objective');
    const background = str(data, 'background');
    const deliverables = strs(data, 'deliverables');
    return {
      type,
      icon: '◆',
      tone: 'accent',
      title: clip(objective || (zh ? '(无目标)' : '(no objective)'), 100),
      detail: [background, deliverables.length ? `${zh ? '交付' : 'dels'}: ${deliverables.length}` : '']
        .filter(Boolean).join(' · ') || undefined,
    };
  }

  // ── fallback：未知类型 ──
  const detail = clip(JSON.stringify(data), 120);
  return { type, icon: '▸', tone: 'muted', title: type, detail };
}
