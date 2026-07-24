import type { InputRenderable, ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import { useBindings } from '@opentui/keymap/react';
import { useEffect, useRef, useState } from 'react';
import type { FormQuestion, Theme } from '../state.js';
import { initialQuestionState, nextTextValue, optionAnswer, toggleSelectedOption } from '../form-model.js';
import { Modal } from './Modal.js';

export function FormDialog({ questions, preamble, theme, width, height, zh, mouseEnabled = true, onComplete, onCancel }: {
  questions: FormQuestion[];
  preamble: string[];
  theme: Theme;
  width: number;
  height: number;
  zh: boolean;
  mouseEnabled?: boolean;
  onComplete: (answers: string[]) => void;
  onCancel: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const initial = initialQuestionState(questions[0]);
  const [value, setValue] = useState(initial.value);
  const [pristine, setPristine] = useState(initial.pristine);
  const [optionIndex, setOptionIndex] = useState(initial.optionIndex);
  const [selectedOptions, setSelectedOptions] = useState(initial.selectedOptions);
  const [validation, setValidation] = useState<string>();
  const [validating, setValidating] = useState(false);
  const valueRef = useRef(initial.value);
  const optionIndexRef = useRef(initial.optionIndex);
  const selectedOptionsRef = useRef(initial.selectedOptions);
  const inputRef = useRef<InputRenderable>(null);
  const textareaRef = useRef<TextareaRenderable>(null);
  const optionsScrollRef = useRef<ScrollBoxRenderable>(null);
  const mouseArmedOptionRef = useRef<number | null>(null);
  const question = questions[index];
  const options = question?.options || [];
  const labels = question?.optionLabels || options;
  const descriptions = question?.optionDescriptions || [];
  const badges = question?.optionBadges || [];
  const disabled = question?.optionDisabled || [];

  const applyQuestionState = (nextIndex: number) => {
    const state = initialQuestionState(questions[nextIndex]);
    valueRef.current = state.value;
    optionIndexRef.current = state.optionIndex;
    selectedOptionsRef.current = state.selectedOptions;
    setValue(state.value);
    setPristine(state.pristine);
    setOptionIndex(state.optionIndex);
    setSelectedOptions(state.selectedOptions);
    mouseArmedOptionRef.current = null;
    setValidation(undefined);
  };

  const submit = async (raw: string) => {
    if (question?.options && disabled[optionIndexRef.current]) {
      setValidation(zh ? '该选项当前不可用。' : 'This option is currently unavailable.');
      return;
    }
    const answer = raw.trim() || question?.fallback || '';
    setValidation(undefined);
    if (question?.validate) {
      setValidating(true);
      const issue = await question.validate(answer, answers);
      setValidating(false);
      if (issue) { setValidation(issue); return; }
    }
    const next = [...answers, answer];
    if (index === questions.length - 1) { onComplete(next); return; }
    const nextIndex = index + 1;
    setAnswers(next);
    setIndex(nextIndex);
    applyQuestionState(nextIndex);
  };

  const moveOption = (delta: number) => {
    if (!options.length) return;
    let next = optionIndexRef.current;
    for (let attempts = 0; attempts < options.length; attempts += 1) {
      next = (next + options.length + delta) % options.length;
      if (!disabled[next]) break;
    }
    optionIndexRef.current = next;
    mouseArmedOptionRef.current = null;
    setValidation(undefined);
    setOptionIndex(next);
  };

  const toggleCurrent = () => {
    const option = options[optionIndexRef.current];
    if (!option || disabled[optionIndexRef.current]) return;
    const next = toggleSelectedOption(selectedOptionsRef.current, option);
    selectedOptionsRef.current = next;
    setSelectedOptions(next);
  };

  useBindings(() => ({
    priority: 400,
    bindings: [
      { key: 'escape', cmd: () => { onCancel(); return true; } },
      { key: 'ctrl+c', cmd: () => { onCancel(); return true; } },
      { key: 'ctrl+u', cmd: () => { if (!question?.options) { valueRef.current = ''; setValue(''); setPristine(false); } return true; } },
      ...(!question?.options ? [] : [
        { key: 'left', cmd: () => { moveOption(-1); return true; } },
        { key: 'up', cmd: () => { moveOption(-1); return true; } },
        { key: 'right', cmd: () => { moveOption(1); return true; } },
        { key: 'down', cmd: () => { moveOption(1); return true; } },
        ...(question.multiSelect ? [{ key: 'space', cmd: () => { toggleCurrent(); return true; } }] : []),
        { key: 'return', cmd: () => { void submit(optionAnswer(question, optionIndexRef.current, selectedOptionsRef.current)); return true; } },
      ]),
    ],
  }), [onCancel, question, answers, index, options]);

  useEffect(() => {
    // FormDialog may receive a new request in the same React batch that resolves
    // the previous request. Reset all request-local state defensively even
    // though App also keys the component by form request id.
    setIndex(0);
    setAnswers([]);
    applyQuestionState(0);
  }, [questions]);

  useEffect(() => {
    if (question?.multiline) textareaRef.current?.focus();
    else if (!question?.options) inputRef.current?.focus();
  }, [index, question?.multiline, question?.options]);

  useEffect(() => {
    if (question?.options && question.optionsLayout === 'column') {
      optionsScrollRef.current?.scrollChildIntoView(`form-option-${index}-${optionIndex}`);
    }
  }, [index, optionIndex, question?.options, question?.optionsLayout]);

  if (!question) return null;
  const questionLabel = typeof question.label === 'function' ? question.label(answers) : question.label;
  const columnOptions = question.optionsLayout === 'column';

  return (
    <Modal title={zh ? '输入' : 'Input'} theme={theme} width={width} height={height}>
      <box flexDirection="column" flexGrow={1} minHeight={0}>
        <scrollbox flexGrow={1} minHeight={0} viewportCulling>
          {preamble.map((line, lineIndex) => <text key={`pre-${lineIndex}`} fg={lineIndex === 0 ? theme.warn : theme.muted} wrapMode="word">{line}</text>)}
          {preamble.length ? <text> </text> : null}
          {answers.map((answer, answerIndex) => (
            <box key={`answer-${answerIndex}`} flexDirection="column" marginBottom={1}>
              <text fg={theme.muted} wrapMode="word">{typeof questions[answerIndex].label === 'function' ? questions[answerIndex].label(answers.slice(0, answerIndex)) : questions[answerIndex].label}</text>
              <text fg={theme.text} wrapMode="word">{questions[answerIndex].sensitive ? '••••••••' : answer}</text>
            </box>
          ))}
        </scrollbox>
        <box flexDirection="column" flexShrink={0} marginTop={1}>
          <text fg={theme.accent} wrapMode="word"><b>{index + 1}/{questions.length} · {questionLabel}</b></text>
          {question.options ? (
            <scrollbox ref={optionsScrollRef} height={Math.max(3, Math.min(16, height - 10))} viewportCulling scrollY={columnOptions}>
            <box flexDirection={columnOptions ? 'column' : 'row'} flexWrap={columnOptions ? 'no-wrap' : 'wrap'} gap={1} marginTop={1}>
              {options.map((option, position) => {
                const active = position === optionIndex;
                const unavailable = Boolean(disabled[position]);
                const selected = question.multiSelect ? selectedOptions.includes(option) : active;
                return (
                  <box id={`form-option-${index}-${position}`} key={option} flexDirection="column" width={columnOptions ? '100%' : undefined} paddingLeft={1} paddingRight={1} backgroundColor={active ? theme.selected : theme.panelAlt} onMouseDown={() => {
                    if (unavailable) { setValidation(zh ? '该选项当前不可用。' : 'This option is currently unavailable.'); return; }
                    const wasArmed = mouseArmedOptionRef.current === position;
                    optionIndexRef.current = position;
                    setOptionIndex(position);
                    if (question.multiSelect) {
                      const next = toggleSelectedOption(selectedOptionsRef.current, option);
                      selectedOptionsRef.current = next;
                      setSelectedOptions(next);
                      mouseArmedOptionRef.current = null;
                    } else if (wasArmed) {
                      mouseArmedOptionRef.current = null;
                      void submit(option);
                    } else {
                      mouseArmedOptionRef.current = position;
                    }
                  }}>
                    <box flexDirection="row" justifyContent="space-between" width="100%">
                      <text fg={unavailable ? theme.muted : active ? theme.selectedText : selected ? theme.good : theme.text} wrapMode="word">{question.multiSelect ? `${selected ? '✓' : '○'} ${labels[position] || option}` : `${unavailable ? '× ' : ''}${labels[position] || option}`}</text>
                      {badges[position] ? (
                        <box paddingLeft={1} paddingRight={1} backgroundColor={theme.panel}>
                          <text fg={badges[position].tone === 'good' ? theme.good : badges[position].tone === 'warn' ? theme.warn : theme.muted}>{badges[position].label}</text>
                        </box>
                      ) : null}
                    </box>
                    {descriptions[position] ? <text fg={active ? theme.selectedText : theme.muted} wrapMode="word">{descriptions[position]}</text> : null}
                  </box>
                );
              })}
            </box>
            </scrollbox>
          ) : question.multiline ? (
            <textarea
              key={`textarea-${index}`}
              ref={textareaRef}
              height={Math.max(4, Math.min(8, height - 14))}
              initialValue={value}
              placeholder={question.fallback || ''}
              wrapMode="word"
              backgroundColor={theme.panelAlt}
              focusedBackgroundColor={theme.selected}
              textColor={theme.text}
              focusedTextColor={theme.selectedText}
              cursorColor={theme.accent}
              keyBindings={[{ name: 'return', ctrl: true, action: 'submit' }]}
              onContentChange={() => { valueRef.current = textareaRef.current?.plainText || ''; setPristine(false); }}
              onSubmit={() => void submit(textareaRef.current?.plainText || valueRef.current)}
              focused
            />
          ) : (
            <input
              key={`input-${index}`}
              ref={inputRef}
              value={value}
              placeholder={question.fallback || ''}
              backgroundColor={theme.panelAlt}
              focusedBackgroundColor={theme.selected}
              textColor={theme.text}
              focusedTextColor={theme.selectedText}
              cursorColor={theme.accent}
              onInput={(incoming) => {
                const next = nextTextValue(valueRef.current, incoming, pristine);
                valueRef.current = next;
                setValue(next);
                setPristine(false);
              }}
              onSubmit={() => void submit(inputRef.current?.value || valueRef.current)}
              focused
            />
          )}
          {validation ? <text fg={theme.bad} wrapMode="word">{validation}</text> : null}
          {validating ? <text fg={theme.warn}>{zh ? '正在校验…' : 'Validating…'}</text> : null}
          <text fg={theme.muted}>{question.options
            ? (question.multiSelect
              ? (mouseEnabled ? (zh ? '方向键选择 · Space 勾选 · Enter 确认 · 鼠标点击切换' : 'Arrows choose · Space toggle · Enter confirm · click to toggle') : (zh ? '方向键选择 · Space 勾选 · Enter 确认' : 'Arrows choose · Space toggle · Enter confirm'))
              : (mouseEnabled ? (zh ? '方向键选择 · Enter 确认 · 鼠标第一次选中、第二次确认' : 'Arrows choose · Enter confirm · first click selects, second click confirms') : (zh ? '方向键选择 · Enter 确认' : 'Arrows choose · Enter confirm')))
            : question.multiline
              ? (zh ? 'Ctrl+Enter 下一步 · Ctrl+U 清空 · Esc 取消' : 'Ctrl+Enter next · Ctrl+U clear · Esc cancel')
              : (zh ? 'Enter 下一步 · Ctrl+U 清空 · Esc 取消' : 'Enter next · Ctrl+U clear · Esc cancel')}</text>
        </box>
      </box>
    </Modal>
  );
}
