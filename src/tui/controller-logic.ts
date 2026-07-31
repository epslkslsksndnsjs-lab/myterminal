// #29（批5 第 9 刀 / ADR-0032）：TuiController 对话流/字段解析纯函数层。
// 本模块零 I/O —— 不 import spawn/fs/net，全部函数可直接单测。
// 逻辑与 state.ts 原内联块逐字等价（行为不变铁律）；I/O 收敛见 host-io.ts。
import type { MyTerminalSession, MyTerminalSettings, TaskPackage } from '../types.js';
import type { FormQuestion } from './contracts.js';
import { isValidPublicBaseUrl } from '../config.js';
import { isAddWorkspaceSelection, selectedWorkspace, type WorkspaceSelectionItem } from '../workspace-selection.js';
import type { Translate } from './copy/i18n.js';

/** @deprecated #31 起单源为 copy/i18n.ts 的 `Translate`；此别名仅为既有导入保留。 */
export type TranslateText = Translate;
export type PassiveLockChoice = 'off' | 'arm' | 'standby';

function integer(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** editSettings :342 —— 字段多选串解析（split/trim/lower/去重）。 */
export function parseSelectedFields(raw: string): string[] {
  return [...new Set(raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

/** editSettings :330-334 —— 被动锁屏问题的默认选项推导。 */
export function passiveLockFallback(enabled: boolean, lockState: string): PassiveLockChoice {
  if (!enabled) return 'off';
  return /armed|arming|visible_waiting_for_arm/.test(lockState) ? 'arm' : 'standby';
}

export type SettingsQuestionContext = {
  current: MyTerminalSettings;
  /** workspace 目录可用时传入选择器问题；undefined = 目录不可用（对应原 log+return 中止路径）。 */
  workspaceQuestion?: FormQuestion;
  passiveFallback: PassiveLockChoice;
  text: TranslateText;
};

export type SettingsQuestionsResult =
  | { ok: true; questions: FormQuestion[] }
  | { ok: false; error: 'workspace-unavailable' };

type SettingsApplyContext = {
  next: MyTerminalSettings;
  current: MyTerminalSettings;
  workspace: WorkspaceResolution;
  setPassiveAction: (choice: PassiveLockChoice) => void;
};

/**
 * 设置字段注册表——question（字段 → 表单问题）与 apply（答案 → settings 写回）
 * 成对收敛于此。此前两者是两份独立的 11 分支 if/else 级联（:47/:84），加一个
 * 字段要改两处且容易漏半边；现在加字段 = 在这里加一个条目。
 * 每个条目与原级联分支逐字等价（行为不变铁律，锁测试 tui-controller-logic-issue29）。
 */
const SETTINGS_FIELDS: Record<string, {
  question: (ctx: SettingsQuestionContext) => FormQuestion | 'workspace-unavailable';
  apply: (value: string, ctx: SettingsApplyContext) => void;
}> = {
  'language': {
    question: ({ current }) => ({ label: 'UI language', fallback: current.uiLanguage, options: ['zh-CN', 'en'] }),
    apply: (value, { next }) => { next.uiLanguage = value as MyTerminalSettings['uiLanguage']; },
  },
  'theme': {
    question: ({ current }) => ({ label: 'UI theme', fallback: current.uiTheme, options: ['dark', 'light'] }),
    apply: (value, { next }) => { next.uiTheme = value as MyTerminalSettings['uiTheme']; },
  },
  'workspace': {
    question: (ctx) => ctx.workspaceQuestion ?? 'workspace-unavailable',
    apply: (value, { next, workspace }) => {
      const selected = selectedWorkspace(workspace.items, value);
      if (!selected) throw new Error('Workspace selection did not resolve to a catalog entry.');
      next.workspaceDir = isAddWorkspaceSelection(selected) ? workspace.addedWorkspaceDir! : selected.workspaceDir;
    },
  },
  'host': {
    question: ({ current, text }) => ({ label: text('Listen host', '监听地址'), fallback: current.host, validate: (value) => value.trim() ? undefined : text('Host cannot be empty.', '监听地址不能为空。') }),
    apply: (value, { next }) => { next.host = value; },
  },
  'port': {
    question: ({ current, text }) => ({ label: text('Listen port', '监听端口'), fallback: String(current.port), validate: (value) => { const port = Number(value); return Number.isInteger(port) && port >= 0 && port <= 65535 ? undefined : text('Port must be an integer from 0 to 65535.', '端口必须是 0 到 65535 的整数。'); } }),
    apply: (value, { next, current }) => { next.port = integer(value, current.port); },
  },
  'public-url': {
    question: ({ current, text }) => ({ label: text('Public HTTPS URL (local clears)', '公网 HTTPS URL（local 清空）'), fallback: current.publicBaseUrl || 'local', validate: (value) => value.toLowerCase() === 'local' || isValidPublicBaseUrl(value.replace(/\/$/, '')) ? undefined : text('Use HTTPS; localhost may use HTTP.', '请使用 HTTPS；localhost 可使用 HTTP。') }),
    apply: (value, { next }) => { next.publicBaseUrl = value.toLowerCase() === 'local' ? '' : value.replace(/\/$/, ''); },
  },
  'max-output': {
    question: ({ current, text }) => ({ label: text('Maximum output characters', '最大输出字符'), fallback: String(current.maxOutputChars), validate: (value) => { const number = Number(value); return Number.isInteger(number) && number >= 4000 && number <= 1000000 ? undefined : text('Use an integer from 4000 to 1000000.', '请输入 4000 到 1000000 的整数。'); } }),
    apply: (value, { next, current }) => { next.maxOutputChars = integer(value, current.maxOutputChars); },
  },
  'timeout': {
    question: ({ current, text }) => ({ label: text('Command timeout seconds', '命令超时秒数'), fallback: String(current.commandTimeoutSec), validate: (value) => { const number = Number(value); return Number.isInteger(number) && number >= 1 && number <= 3600 ? undefined : text('Use an integer from 1 to 3600.', '请输入 1 到 3600 的整数。'); } }),
    apply: (value, { next, current }) => { next.commandTimeoutSec = integer(value, current.commandTimeoutSec); },
  },
  'actions-continuation': {
    question: ({ current, text }) => ({ label: text('Long-task harness', '长任务 Harness'), fallback: current.actionsContinuationMode, options: ['off', 'adaptive', 'next-call', 'lookahead-3'] }),
    apply: (value, { next }) => { next.actionsContinuationMode = value as MyTerminalSettings['actionsContinuationMode']; },
  },
  'non-blocking-tasks': {
    question: ({ current, text }) => ({ label: text('Non-blocking tasks', '非阻塞任务'), fallback: current.nonBlockingTasksEnabled ? 'on' : 'off', options: ['off', 'on'] }),
    apply: (value, { next }) => { next.nonBlockingTasksEnabled = value === 'on'; },
  },
  'passive-lock': {
    question: (ctx) => ({ label: ctx.text('macOS passive lock', 'macOS 被动锁屏'), fallback: ctx.passiveFallback, options: ['off', 'arm', 'standby'] }),
    apply: (value, { next, setPassiveAction }) => {
      const choice = value.toLowerCase() as PassiveLockChoice;
      setPassiveAction(choice);
      next.passiveLockEnabled = choice !== 'off';
    },
  },
};

/** editSettings :344-362 —— 已选字段 → 表单问题（含校验器）。 */
export function buildSettingsQuestions(fields: string[], ctx: SettingsQuestionContext): SettingsQuestionsResult {
  const questions: FormQuestion[] = [];
  for (const field of fields) {
    const spec = SETTINGS_FIELDS[field];
    if (!spec) continue; // 未知字段静默跳过（与原级联无 else 分支等价）
    const question = spec.question(ctx);
    if (question === 'workspace-unavailable') return { ok: false, error: 'workspace-unavailable' };
    questions.push(question);
  }
  return { ok: true, questions };
}

export type WorkspaceResolution = {
  items: WorkspaceSelectionItem[];
  /** 用户经"添加新工作区"子流输入的目录（isAddWorkspaceSelection 命中时使用）。 */
  addedWorkspaceDir?: string;
};

export type ResolvedSettings = { next: MyTerminalSettings; passiveAction?: PassiveLockChoice };

/** editSettings :382-401 —— 票面点名的 (fields, answers, current) 纯解析块；workspace 未解析时 throw（与原行为一致）。 */
export function resolveSettingsAnswers(
  fields: string[],
  answers: string[],
  current: MyTerminalSettings,
  workspace: WorkspaceResolution,
): ResolvedSettings {
  const next: MyTerminalSettings = { ...current };
  let passiveAction: PassiveLockChoice | undefined;
  const applyCtx: SettingsApplyContext = { next, current, workspace, setPassiveAction: (choice) => { passiveAction = choice; } };
  fields.forEach((field, index) => {
    SETTINGS_FIELDS[field]?.apply(answers[index], applyCtx);
  });
  return { next, passiveAction };
}

/** createSession :204 —— 分号分隔列表解析。 */
export function splitList(value: string): string[] {
  return value.split(';').map((item) => item.trim()).filter(Boolean);
}

/** createSession :205 —— 子 session 表单答案 → TaskPackage 组装。 */
export function buildChildTaskPackage(answers: string[]): TaskPackage {
  return { objective: answers[3], background: answers[4], deliverables: splitList(answers[5]), acceptanceCriteria: splitList(answers[6]), constraints: splitList(answers[7]) };
}

/** sessionAction :231-232 —— session 终态判定与可用操作列表。 */
export function sessionActionOptions(session: Pick<MyTerminalSession, 'phase'>): { terminal: boolean; actions: string[] } {
  const terminal = ['completed', 'cancelled'].includes(session.phase);
  return { terminal, actions: terminal ? ['context', 'delete', 'continue'] : ['copy', 'revoke', 'cancel', 'context', 'delete'] };
}
