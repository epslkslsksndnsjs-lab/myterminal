// #29（批5 第 9 刀 / ADR-0032）：TuiController 对话流/字段解析纯函数层。
// 本模块零 I/O —— 不 import spawn/fs/net，全部函数可直接单测。
// 逻辑与 state.ts 原内联块逐字等价（行为不变铁律）；I/O 收敛见 host-io.ts。
import type { MyTerminalSession, MyTerminalSettings, TaskPackage, WorkflowsSettings } from '../types.js';
import type { FormQuestion } from './contracts.js';
import { isValidPublicBaseUrl } from '../config.js';
import { WORKFLOW_SETTING_KEYS, type WorkflowSettingKey } from '../workflows/gates.js';
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

/** 本机设置面里 workflows 那一段的字段名（选择清单与登记表同源，不留两份清单）。 */
export const WORKFLOW_SETTING_FIELDS: string[] = WORKFLOW_SETTING_KEYS.map((key) => key.field);

/**
 * workflows 设置节的字段文案。标签归本机设置面这一层，边界与默认仍从 gates.ts 的
 * 登记表取——TUI 里说的上限必须就是闸门钉的那个，不能再写一遍数字。
 */
const WORKFLOW_FIELD_COPY: Record<string, readonly [string, string]> = {
  'wf-token-cap': ['Workflow token cap (output tokens per run)', '工作流单 run token 上限（输出 token）'],
  'wf-unlimited': ['Workflow unlimited tokens (requires explicit user authorization)', '工作流不限制 token（需用户明确说明）'],
  'wf-run-gate': ['Workflow wall-clock gate (minutes per run)', '工作流墙钟闸（分钟 / run）'],
  'wf-agent-cap': ['Workflow agent cap (agent() calls per run)', '工作流 agent 数上限（单 run 调用数）'],
  'wf-concurrency-window': ['Workflow concurrency window', '工作流并发窗口'],
  'wf-dispatch-window': ['Workflow per-path dispatch window (minutes)', '工作流逐路派发窗（分钟）'],
  'wf-dispatch-turns': ['Workflow per-path turn cap', '工作流逐路轮数上限'],
  'wf-stall-seconds': ['Workflow stall window (seconds without progress)', '工作流 stall 窗（无进展秒数）'],
  'wf-wait-chunk-seconds': ['Workflow wait chunk (seconds per reducer wait)', '工作流单次等待窗（汇总体每次阻塞秒数）'],
  'wf-reducer-budget': ['Reducer wait budget (minutes)', '汇总体等待预算（分钟）'],
  'wf-reducer-timeout': ['Reducer hard timeout (minutes)', '汇总体硬超时（分钟）'],
  'wf-keep-quota-count': ['Worktree keep quota (count)', 'worktree 保留配额（个）'],
  'wf-keep-quota-bytes': ['Worktree keep quota (bytes)', 'worktree 保留配额（字节）'],
  'wf-archive-after-days': ['Worktree archive threshold (days)', 'worktree 归档阈值（天）'],
  'wf-auto-archive': ['Worktree auto-archive', 'worktree 自动归档'],
  'wf-snapshot-retain': ['Workflow snapshot retention (count)', '工作流快照保留份数'],
  'wf-terminal-run-retain': ['Terminal workflow run retention (count)', '终态 run 保留数'],
  'wf-reducer-quota': ['Reducer concurrency quota', '汇总体并发配额'],
};

function savedWorkflowValue(current: MyTerminalSettings, key: WorkflowSettingKey): number | boolean | undefined {
  const saved = (current.workflows as WorkflowsSettings | undefined)?.[key.name];
  return typeof saved === 'number' || typeof saved === 'boolean' ? saved : undefined;
}

/** 登记表 → SETTINGS_FIELDS 条目：question / apply 与上面 11 个字段走同一对契约。 */
function workflowSettingFields(): Record<string, { question: (ctx: SettingsQuestionContext) => FormQuestion; apply: (value: string, ctx: SettingsApplyContext) => void }> {
  const fields: Record<string, { question: (ctx: SettingsQuestionContext) => FormQuestion; apply: (value: string, ctx: SettingsApplyContext) => void }> = {};
  for (const key of WORKFLOW_SETTING_KEYS) {
    const copy = WORKFLOW_FIELD_COPY[key.field];
    if (!copy) throw new Error(`Workflows setting "${key.field}" has no field copy.`);
    fields[key.field] = {
      question: ({ current, text }) => {
        const label = text(copy[0], copy[1]);
        const saved = savedWorkflowValue(current, key);
        if (key.unit === 'switch') {
          const value = typeof saved === 'boolean' ? saved : key.default === 'on';
          return { label, fallback: value ? 'on' : 'off', options: ['off', 'on'] };
        }
        // 边界与默认都从登记表取数字——TUI 里说的上限必须就是闸门钉的那个，不再写第二遍。
        const range = () => key.ceiling === null
          ? text(`Use an integer of at least ${key.floor}.`, `请输入不小于 ${key.floor} 的整数。`)
          : text(`Use an integer from ${key.floor} to ${key.ceiling}.`, `请输入 ${key.floor} 到 ${key.ceiling} 的整数。`);
        // 本模块零 I/O（文件头契约）：'auto' 那一项要靠核数，这里不问机器，留空就是自动。
        const auto = key.default === 'auto';
        const fallback = typeof saved === 'number' ? String(saved) : auto ? '' : String(key.default);
        return {
          label: auto ? `${label} ${text('(blank = follow core count)', '（留空 = 按核数自动）')}` : label,
          fallback,
          validate: (input) => {
            if (auto && !input.trim()) return undefined;
            const parsed = Number(input);
            if (!Number.isInteger(parsed) || parsed < key.floor) return range();
            if (key.ceiling !== null && parsed > key.ceiling) return range();
            return undefined;
          },
        };
      },
      apply: (value, { next, current }) => {
        // 从 next 起抄：同一批答案里后面的字段不能把前面已写回的那格冲掉。
        const workflows: Record<string, number | boolean> = { ...(next.workflows ?? {}) };
        const saved = savedWorkflowValue(current, key);
        const trimmed = value.trim();
        if (key.unit === 'switch') {
          workflows[key.name] = trimmed.toLowerCase() === 'on';
        } else if (key.default === 'auto' && !trimmed) {
          delete workflows[key.name];
        } else {
          const keep = typeof saved === 'number' ? saved : typeof key.default === 'number' ? key.default : 0;
          workflows[key.name] = integer(value, keep);
        }
        next.workflows = workflows as WorkflowsSettings;
      },
    };
  }
  return fields;
}

/**
 * 设置字段注册表——question（字段 → 表单问题）与 apply（答案 → settings 写回）
 * 成对收敛于此。此前两者是两份独立的 11 分支 if/else 级联（:47/:84），加一个
 * 字段要改两处且容易漏半边；现在加字段 = 在这里加一个条目。
 * 上面 11 项与原级联分支逐字等价（行为不变铁律，锁测试 tui-controller-logic-issue29）；
 * 末尾 workflows 那一段是 #226 从登记表生成的，不走"逐字等价"这条锁——它的契约是
 * "边界与默认取自 gates.ts 的同一份登记"，由 issue-226 的用例锁住。
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
  ...workflowSettingFields(),
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

/**
 * Worktrees 面板（#231 / ADR-0052 §11④d）——保留项列表的装配与配额告警文案。
 *
 * 面板只做两件人才能做的事：看（runId / 路径 / 分支 / 大小 / 时间）与减（合并或丢弃）。
 * 这里刻意不产生任何动作，纯排版与判定——有改动的件永不自动删，删除的按钮在屏幕上，
 * 按下它的人是人。
 */

export type WorktreePanelEntry = {
  id: string;
  runId: string;
  path: string;
  branch: string;
  bytes?: number;
  at: string;
};

export type WorktreePanelRow = { id: string; runId: string; path: string; branch: string; size: string; at: string };

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 字节的人类可读口径：1024 进制逐级降档，最多一位小数，整数不带".0"。 */
export function formatWorktreeBytes(bytes: number | undefined): string {
  let scaled = Math.max(0, Math.floor(bytes ?? 0));
  let index = 0;
  while (scaled >= 1024 && index < SIZE_UNITS.length - 1) {
    scaled = Math.round((scaled / 1024) * 10) / 10;
    index += 1;
  }
  return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)} ${SIZE_UNITS[index]}`;
}

export function worktreePanelRows(entries: readonly WorktreePanelEntry[]): WorktreePanelRow[] {
  return entries.map((entry) => ({
    id: entry.id,
    runId: entry.runId,
    path: entry.path,
    branch: entry.branch,
    size: formatWorktreeBytes(entry.bytes),
    at: entry.at,
  }));
}

/** 配额档位是否需要在屏幕上说一句（ok 之外都说）。 */
export function isWorktreeQuotaWarning(level: string): boolean {
  return level === 'warn' || level === 'blocked';
}

export type WorktreeQuotaSummary = {
  level: 'ok' | 'warn' | 'blocked';
  reasons: readonly string[];
  preservedCount: number;
  preservedBytes: number;
  keepQuotaCount: number;
  keepQuotaBytes: number;
};

/**
 * 软阈值告警与硬上限拒建的屏上一句：带配额两个读数与具名理由，
 * 并且把"旧的绝不自动删、减由人来"这句写在同一行——看见告警的人要同时知道下一步做什么。
 */
export function describeQuotaWarning(summary: WorktreeQuotaSummary, t: Translate): string {
  const reasons = summary.reasons.join(', ');
  const counts = `${summary.preservedCount}/${summary.keepQuotaCount} · ${formatWorktreeBytes(summary.preservedBytes)}/${formatWorktreeBytes(summary.keepQuotaBytes)}`;
  if (summary.level === 'blocked') {
    return t(
      `Worktree quota reached (${reasons}) · ${counts} — new isolated paths are refused and nothing old is deleted automatically. Merge or discard a kept worktree in this panel.`,
      `worktree 配额到线（${reasons}）· ${counts} — 拒绝新建，且拒绝新建绝不删旧。请在本面板合并或丢弃保留项。`,
    );
  }
  return t(
    `Worktree quota approaching its ceiling (${reasons}) · ${counts} — new paths still open, but nothing old is ever deleted automatically: merge or discard in this panel.`,
    `worktree 配额接近上限（${reasons}）· ${counts} — 仍可新建，但旧的绝不自动删：请在本面板合并或丢弃保留项。`,
  );
}
