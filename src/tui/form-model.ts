import type { FormQuestion } from './contracts.js';

export type FormQuestionState = {
  value: string;
  pristine: boolean;
  optionIndex: number;
  selectedOptions: string[];
};

export function initialQuestionState(question: FormQuestion | undefined): FormQuestionState {
  const fallback = question?.fallback || '';
  const options = question?.options || [];
  const fallbackIndex = options.indexOf(fallback);
  return {
    value: fallback,
    pristine: true,
    optionIndex: Math.max(0, fallbackIndex),
    selectedOptions: question?.multiSelect && fallback
      ? fallback.split(',').map((item) => item.trim()).filter((item) => options.includes(item))
      : [],
  };
}

export function toggleSelectedOption(selected: string[], option: string): string[] {
  return selected.includes(option)
    ? selected.filter((item) => item !== option)
    : [...selected, option];
}

export function optionAnswer(question: FormQuestion, optionIndex: number, selected: string[]): string {
  const options = question.options || [];
  if (question.multiSelect) return selected.join(',');
  return options[optionIndex] || question.fallback || '';
}

export function nextTextValue(current: string, incoming: string, pristine: boolean): string {
  if (!pristine || !current) return incoming;
  return incoming.startsWith(current) ? incoming.slice(current.length) : incoming;
}

export function workspaceOptionLabel(title: string, workspaceDir: string, status: string): string {
  return `${title}\n${workspaceDir}\n${status}`;
}

export function workspaceChoiceQuestion(
  label: string,
  items: Array<{ title: string; workspaceDir: string; status: string; active?: boolean; disabled?: boolean }>,
  currentIndex = 0,
): FormQuestion {
  const options = items.map((_, index) => String(index + 1));
  return {
    label,
    fallback: options[Math.max(0, Math.min(currentIndex, options.length - 1))] || options[0],
    options,
    optionLabels: items.map((item) => item.title),
    optionDescriptions: items.map((item) => item.workspaceDir),
    optionBadges: items.map((item) => ({
      label: item.status,
      tone: item.disabled ? 'warn' : item.active ? 'good' : 'muted',
    })),
    optionDisabled: items.map((item) => Boolean(item.disabled)),
    optionsLayout: 'column',
  };
}
