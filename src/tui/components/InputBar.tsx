import type { InputRenderable } from '@opentui/core';
import { useBindings } from '@opentui/keymap/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Theme } from '../state.js';
import type { Copy } from '../copy/types.js';
import { useInputHistory } from '../hooks/useInputHistory.js';

/**
 * InputBar — 底部常显输入栏（ADR-0004 决策 4）。
 * Normal/Editing 双模式状态机；Editing 时 priority 350 keymap（仅 Esc/Enter/↑/↓/Tab 有效）。
 * Normal：❯ muted + placeholder + hint；点击 → Editing。
 * Editing：accent 边框 + ❯ accent + OpenTUI input + hint。
 */
export function InputBar({ theme, copy, editing, onEditingChange, onSubmitText, completions }: {
  theme: Theme;
  copy: Copy;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onSubmitText: (text: string) => void;
  completions: (prefix: string) => string[];
}) {
  const [value, setValue] = useState('');
  const [completionIndex, setCompletionIndex] = useState(-1);
  const inputRef = useRef<InputRenderable>(null);
  const valueRef = useRef('');

  const { push, prev, next } = useInputHistory();

  // 聚焦输入框
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const enterEditing = useCallback(() => {
    onEditingChange(true);
  }, [onEditingChange]);

  const exitEditing = useCallback(() => {
    setValue('');
    valueRef.current = '';
    setCompletionIndex(-1);
    onEditingChange(false);
  }, [onEditingChange]);

  const submit = useCallback(() => {
    const text = valueRef.current.trim();
    if (!text) return;
    push(text);
    onSubmitText(text);
    setValue('');
    valueRef.current = '';
    setCompletionIndex(-1);
  }, [push, onSubmitText]);

  const handleTabCompletion = useCallback(() => {
    const current = valueRef.current;
    if (!current.startsWith('/')) return;
    const candidates = completions(current);
    if (candidates.length === 0) return;
    // 循环填充候选
    const nextIndex = (completionIndex + 1) % candidates.length;
    setCompletionIndex(nextIndex);
    const nextValue = candidates[nextIndex];
    valueRef.current = nextValue;
    setValue(nextValue);
  }, [completionIndex, completions]);

  const handlePrev = useCallback(() => {
    const previous = prev(valueRef.current);
    valueRef.current = previous;
    setValue(previous);
    setCompletionIndex(-1);
  }, [prev]);

  const handleNext = useCallback(() => {
    const nextValue = next();
    valueRef.current = nextValue;
    setValue(nextValue);
    setCompletionIndex(-1);
  }, [next]);

  // Editing 键位：priority 350，escape/return/up/down/tab
  useBindings(() => ({
    priority: 350,
    enabled: editing,
    bindings: [
      { key: 'escape', cmd: () => { exitEditing(); return true; } },
      { key: 'return', cmd: () => { submit(); return true; } },
      { key: 'enter', cmd: () => { submit(); return true; } },
      { key: 'up', cmd: () => { handlePrev(); return true; } },
      { key: 'down', cmd: () => { handleNext(); return true; } },
      { key: 'tab', cmd: () => { handleTabCompletion(); return true; } },
    ],
  }), [editing, exitEditing, submit, handlePrev, handleNext, handleTabCompletion]);

  if (!editing) {
    return (
      <box flexDirection="column" flexShrink={0} backgroundColor={theme.background} paddingLeft={1} paddingRight={1}>
        <box flexDirection="row" justifyContent="space-between" onMouseDown={enterEditing}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.muted} wrapMode="none">❯</text>
            <text fg={theme.muted} wrapMode="word">{copy.inputPlaceholder}</text>
          </box>
          <text fg={theme.muted} wrapMode="none">{copy.inputHintNormal}</text>
        </box>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={theme.background} paddingLeft={1} paddingRight={1}>
      <box border borderColor={theme.accent} paddingLeft={1} paddingRight={1} flexDirection="column">
        <box flexDirection="row" gap={1}>
          <text fg={theme.accent} wrapMode="none">❯</text>
          <input
            ref={inputRef}
            value={value}
            placeholder={copy.inputPlaceholder}
            backgroundColor={theme.background}
            focusedBackgroundColor={theme.panelAlt}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.accent}
            onInput={(incoming) => {
              valueRef.current = incoming;
              setValue(incoming);
              setCompletionIndex(-1);
            }}
            focused
          />
        </box>
        <text fg={theme.muted} wrapMode="word">{copy.inputHintEditing}</text>
      </box>
    </box>
  );
}
