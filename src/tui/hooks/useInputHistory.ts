import { useCallback, useRef } from 'react';

/**
 * useInputHistory — 输入栏内存历史栈（ADR-0004 决策 4）。
 * 会话内不落盘，↑/↓ 浏览。index=-1 表示不在浏览历史。
 * 返回 { push, prev, next }，next 越过栈顶时返回空字符串。
 *
 * 用 useRef 存储 history 数组与 index，保证 prev/next 返回值在同一个事件循环内同步可得；
 * InputBar 通过 setState 触发重渲染即可。
 */
export function useInputHistory(): {
  push: (text: string) => void;
  prev: (current: string) => string;
  next: () => string;
} {
  const historyRef = useRef<string[]>([]);
  const indexRef = useRef(-1);

  const push = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const current = historyRef.current;
    if (current.length > 0 && current[current.length - 1] === trimmed) return;
    historyRef.current = [...current, trimmed];
    indexRef.current = -1;
  }, []);

  const prev = useCallback((current: string): string => {
    const history = historyRef.current;
    if (history.length === 0) return current;

    if (indexRef.current === -1) {
      // 首次按 ↑：跳到栈底
      indexRef.current = history.length - 1;
      return history[history.length - 1];
    }

    indexRef.current = Math.max(0, indexRef.current - 1);
    return history[indexRef.current];
  }, []);

  const next = useCallback((): string => {
    const history = historyRef.current;
    if (indexRef.current === -1) return '';

    if (indexRef.current + 1 >= history.length) {
      indexRef.current = -1;
      return '';
    }

    indexRef.current += 1;
    return history[indexRef.current];
  }, []);

  return { push, prev, next };
}
