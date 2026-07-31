/**
 * Timeline — 全量活动流页（ADR-0004 决策 7）。
 * 消息 + 工具审计按时间降序混合显示，⏺ 标记 + 类型色 + 分页。
 * j/k/↑↓ 选择、Enter 展开（页内自管选中索引，不与 App selected[] 冲突）。
 * M4b 交付。
 */
import { useState, useCallback } from 'react';
import { useBindings } from '@opentui/keymap/react';
import type { MyTerminalRuntime } from '../../server.js';
import type { StoredState } from '../../types.js';
import type { TuiSnapshot, Theme } from '../state.js';
import { useI18n } from '../copy/context.js';
import { useTimelineModel } from '../hooks/useTimelineModel.js';
import type { ActivityEntry } from '../model/timeline-merge.js';
import { ToolCallRow } from '../components/ToolCallRow.js';
import { Mascot } from '../components/Mascot.js';

const PAGE_SIZE = 100;

function timeOf(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleTimeString([], { hour12: false });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

export function Timeline({
  runtime,
  state,
  snapshot,
  theme,
  page,
  onPageChange,
  onExpandToggle,
  keyboardEnabled,
}: {
  runtime: MyTerminalRuntime;
  state: StoredState;
  snapshot: TuiSnapshot;
  theme: Theme;
  page: number;
  onPageChange: (page: number) => void;
  onExpandToggle: () => void;
  keyboardEnabled: boolean;
}) {
  const { t, copy } = useI18n();
  const entries = useTimelineModel(snapshot, 0); // limit=0 = 全量不截断
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const clampedPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIdx = clampedPage * PAGE_SIZE;
  const pageEntries = entries.slice(startIdx, startIdx + PAGE_SIZE);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 会话 id → 名称映射（用于消息条目 from/to 显示）
  const sessionNames = new Map<string, string>();
  for (const s of state.sessions) sessionNames.set(s.id, s.name);
  const fromToName = (id: string): string => {
    if (id === 'user') return t('You', '你');
    return sessionNames.get(id) || id;
  };

  const entryCount = pageEntries.length;
  const safeIdx = entryCount > 0 ? Math.max(0, Math.min(selectedIdx, entryCount - 1)) : 0;

  function entryKey(entry: ActivityEntry, _idx: number): string {
    // ADR-0023: 去掉 idx——at+id 已足够唯一，idx 导致新消息到达时全部 remount
    if (entry.kind === 'audit') return `audit-${entry.action}-${entry.at}`;
    return `msg-${entry.fromId}-${entry.toId}-${entry.at}`;
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // ADR-0023: 不调用 onExpandToggle()——避免 scrollKey 变化导致 remount 重置 expanded
  }

  const selectItem = useCallback((delta: number) => {
    setSelectedIdx((prev) => {
      if (entryCount === 0) return 0;
      return Math.max(0, Math.min(entryCount - 1, prev + delta));
    });
  }, [entryCount]);

  const selectGo = useCallback((index: number) => {
    if (entryCount === 0) return;
    setSelectedIdx(Math.max(0, Math.min(entryCount - 1, index)));
  }, [entryCount]);

  const expandSelected = useCallback(() => {
    if (entryCount === 0) return;
    const key = entryKey(pageEntries[safeIdx], safeIdx);
    toggleExpand(key);
  }, [entryCount, pageEntries, safeIdx]);

  // 页内键盘（优先级 250，与 App keymap 的 200/100 不冲突）
  useBindings(() => ({
    priority: 250,
    enabled: keyboardEnabled,
    bindings: [
      { key: 'j', cmd: () => { selectItem(1); return true; } },
      { key: 'k', cmd: () => { selectItem(-1); return true; } },
      { key: 'down', cmd: () => { selectItem(1); return true; } },
      { key: 'up', cmd: () => { selectItem(-1); return true; } },
      { key: 'return', cmd: () => { expandSelected(); return true; } },
      { key: 'home', cmd: () => { selectGo(0); return true; } },
      { key: 'end', cmd: () => { selectGo(Number.MAX_SAFE_INTEGER); return true; } },
    ],
  }), [keyboardEnabled, selectItem, selectGo, expandSelected]);

  return (
    <box flexDirection="column" width="100%" padding={1} gap={0}>
      {/* 头部行 */}
      <box flexDirection="row" gap={2} flexWrap="wrap" marginBottom={1}>
        <text fg={theme.accent}><b>{t('Activity Timeline', '活动时间线')}</b></text>
        <text fg={theme.muted}>
          {t(`Page ${clampedPage + 1}/${totalPages} · PgUp/PgDn · j/k select · Enter expand`, `第 ${clampedPage + 1}/${totalPages} 页 · PgUp/PgDn 翻页 · j/k 选择 · Enter 展开`)}
        </text>
      </box>

      {/* 条目列表 */}
      {entryCount === 0 ? (
        <box flexDirection="column" alignItems="center" paddingTop={4}>
          <Mascot mood="happy" theme={theme} />
          <text> </text>
          <text fg={theme.muted} wrapMode="word">{copy.emptyStates.timeline}</text>
        </box>
      ) : (
        pageEntries.map((entry, idx) => {
          const key = entryKey(entry, idx);
          const isSelected = idx === safeIdx;
          const isExpanded = expanded.has(key);

          if (entry.kind === 'audit') {
            return (
              <ToolCallRow
                key={key}
                audit={{
                  timestamp: entry.at,
                  source: entry.source,
                  action: entry.action,
                  status: entry.status,
                  durationMs: entry.durationMs ?? 0,
                  error: entry.errorCode ? { code: entry.errorCode } : undefined,
                  args: entry.args,
                  result: entry.result,
                  sessionName: entry.sessionName,
                }}
                theme={theme}
                expanded={isExpanded}
                onToggle={() => toggleExpand(key)}
                selected={isSelected}
              />
            );
          }

          // message 条目
          const fromName = fromToName(entry.fromId);
          const toName = fromToName(entry.toId);
          const body = truncate(entry.body, 80);
          return (
            <box key={key} flexDirection="row" gap={1} width="100%" backgroundColor={isSelected ? theme.selected : undefined}>
              <text fg={theme.user} wrapMode="none">⏺</text>
              <text fg={theme.muted} wrapMode="none">{timeOf(entry.at)}</text>
              <text fg={theme.text} flexGrow={1} wrapMode="word">{fromName} → {toName}：{body}</text>
              <text fg={theme.muted} wrapMode="none">{t('message', '消息')}</text>
            </box>
          );
        })
      )}
    </box>
  );
}
