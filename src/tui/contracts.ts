import type { MyTerminalRuntime } from '../server.js';
import type { MyTerminalSettings } from '../types.js';

/** Presentation-only navigation target. Domain state remains in MyTerminalStore. */
export type Detail = { kind: 'session'; id: string } | { kind: 'conversation'; id: string } | { kind: 'subagent'; id: string };

export type RuntimeReconfigureResult = { runtime: MyTerminalRuntime; error?: string };
export type RuntimeReconfigure = (settings: MyTerminalSettings) => Promise<RuntimeReconfigureResult>;

/** Declarative form contract shared by Setup, Settings, and modal forms. */
export type FormQuestion = {
  label: string | ((previous: string[]) => string);
  fallback?: string;
  multiline?: boolean;
  sensitive?: boolean;
  options?: string[];
  optionLabels?: string[];
  optionDescriptions?: string[];
  optionBadges?: Array<{ label: string; tone?: 'good' | 'warn' | 'muted' }>;
  optionDisabled?: boolean[];
  optionsLayout?: 'row' | 'column';
  multiSelect?: boolean;
  validate?: (value: string, previous: string[]) => string | undefined | Promise<string | undefined>;
};

export type Ask = (questions: FormQuestion[], preamble?: string[]) => Promise<string[] | undefined>;
