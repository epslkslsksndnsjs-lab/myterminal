import os from 'node:os';
import { HARD_CONCURRENCY_CEILING, MIN_CONCURRENCY, defaultConcurrencyWindow } from './scheduler.js';
import { MAX_RETAINED_SNAPSHOTS, MAX_RETAINED_TERMINAL_RUNS } from './schema.js';
import type { WorkflowsSettings } from '../types.js';

export { HARD_CONCURRENCY_CEILING, MIN_CONCURRENCY } from './scheduler.js';

/**
 * 四重自限闸门与设置节——"默认即上限"的算术全在这里，别处只消费。
 *
 * 四条纪律：
 *   1. 默认值就是上限，模型面一个参数都传不进来（ADR-0052 §4 / §8）；调参唯一入口
 *      是本机设置面：设置文件 → env → 默认，env 与文件越硬顶都只到硬顶为止；
 *   2. "不限制"是显式开关、默认关，只解 token 闸（墙钟 / agent 数 / 并发窗口照旧有值），
 *      开与关都留得下账——关掉不等于没发生；
 *   3. env 只认纯十进制正整数与仓库那几种布尔写法；非法值落回默认并留告警，
 *      绝不静默当成"用户没调过"；
 *   4. 时钟嵌套不变量由启动校验强制（内层 ≤ 外层 − reduceSlack），违例 fail-closed；
 *      reduceSlack 是规则不是旋钮，所以它根本不在可调集里。
 */

/** agent 数硬顶（ADR-0052 §6）。 */
export const HARD_AGENT_CAP_CEILING = 10_000;
/** 逐路时间界硬顶（§16：clamp 100 分钟）。 */
export const HARD_DISPATCH_WINDOW_CEILING_MINUTES = 100;
/** 逐路轮数硬顶（§16：clamp 500 轮）。 */
export const HARD_DISPATCH_TURNS_CEILING = 500;
/** 每层必须留出的余量；它是嵌套规则的常量，不是设置项。 */
export const REDUCE_SLACK_MS = 5 * 60 * 1000;

/** 端点三元组的字段名：workflows 设置节一个都不接受（与 subagent 同键同校验、单源不另开）。 */
export const ENDPOINT_FIELD_NAMES = ['baseUrl', 'apiKey', 'model', 'endpoint'] as const;

export type WorkflowGates = {
  /** 单 run 输出 token 顶；null = 无顶（仅"不限制"开关能到这里）。 */
  tokenCap: number | null;
  runGateMs: number;
  agentCap: number;
  concurrencyWindow: number;
  dispatchWindowMs: number;
  dispatchTurns: number;
  stallMs: number;
  waitChunkMs: number;
  reducerBudgetMs: number;
  reducerTimeoutMs: number;
  /**
   * 嵌套校验要求的最小余量。值是常量：设置面没有键能改它（不在登记表里），
   * 放进闸门集只为让"整钟栈一起缩放"的虚拟钟测试可构造（ADR §13 时钟注入前提）。
   */
  reduceSlackMs: number;
  keepQuotaCount: number;
  keepQuotaBytes: number;
  archiveAfterDays: number;
  autoArchive: boolean;
  snapshotRetain: number;
  terminalRunRetain: number;
  reducerQuota: number;
};

type SettingGroup = 'gate' | 'window' | 'dispatch' | 'reducer' | 'worktree-quota' | 'retention';

/** 登记表两型：数值键带下限/硬顶，开关键只有 on/off——按 unit 判别，不靠运行时兜不可能状态。 */
type SettingBase = {
  /** 设置文件里的键名（集中登记，唯一出处）。 */
  name: keyof WorkflowsSettings;
  /** 换算后进哪个运行时闸门。 */
  gate: keyof WorkflowGates;
  env: string;
  /** TUI Settings 屏的字段标识。 */
  field: string;
  group: SettingGroup;
};

export type NumericWorkflowSettingKey = SettingBase & {
  unit: 'tokens' | 'minutes' | 'seconds' | 'bytes' | 'days' | 'count';
  floor: number;
  /** null = 无硬顶（钉死条款没给顶的键不臆造）。 */
  ceiling: number | null;
  /** 设置面口径的默认值（分钟 / 秒 / 个）；'auto' = 由核数公式决定。 */
  default: number | 'auto';
};

export type SwitchWorkflowSettingKey = SettingBase & {
  unit: 'switch';
  /** 开关默认值——"不限制"与自动归档都是默认关。 */
  default: 'on' | 'off';
};

export type WorkflowSettingKey = NumericWorkflowSettingKey | SwitchWorkflowSettingKey;

const MINUTE = 60_000;

/**
 * 键名登记表——票面要求的"口径覆盖闸门 / 并发窗口 / worktree 配额 / 保留数 /
 * 汇总体并发配额"就是这张表；新增键只在这里加一行，校验、env、TUI 都跟着走。
 */
export const WORKFLOW_SETTING_KEYS: readonly WorkflowSettingKey[] = [
  { name: 'tokenCap', gate: 'tokenCap', env: 'MYTERMINAL_WORKFLOW_TOKEN_CAP', field: 'wf-token-cap', unit: 'tokens', floor: 1, ceiling: null, default: 8_000_000, group: 'gate' },
  { name: 'unlimited', gate: 'tokenCap', env: 'MYTERMINAL_WORKFLOW_UNLIMITED', field: 'wf-unlimited', unit: 'switch', default: 'off', group: 'gate' },
  { name: 'runGateMinutes', gate: 'runGateMs', env: 'MYTERMINAL_WORKFLOW_RUN_GATE_MINUTES', field: 'wf-run-gate', unit: 'minutes', floor: 1, ceiling: null, default: 30, group: 'gate' },
  { name: 'agentCap', gate: 'agentCap', env: 'MYTERMINAL_WORKFLOW_AGENT_CAP', field: 'wf-agent-cap', unit: 'count', floor: 1, ceiling: HARD_AGENT_CAP_CEILING, default: 1000, group: 'gate' },
  { name: 'concurrencyWindow', gate: 'concurrencyWindow', env: 'MYTERMINAL_WORKFLOW_CONCURRENCY', field: 'wf-concurrency-window', unit: 'count', floor: MIN_CONCURRENCY, ceiling: HARD_CONCURRENCY_CEILING, default: 'auto', group: 'window' },
  { name: 'dispatchWindowMinutes', gate: 'dispatchWindowMs', env: 'MYTERMINAL_WORKFLOW_DISPATCH_WINDOW_MINUTES', field: 'wf-dispatch-window', unit: 'minutes', floor: 1, ceiling: HARD_DISPATCH_WINDOW_CEILING_MINUTES, default: 10, group: 'dispatch' },
  { name: 'dispatchTurns', gate: 'dispatchTurns', env: 'MYTERMINAL_WORKFLOW_DISPATCH_TURNS', field: 'wf-dispatch-turns', unit: 'count', floor: 1, ceiling: HARD_DISPATCH_TURNS_CEILING, default: 50, group: 'dispatch' },
  { name: 'stallSeconds', gate: 'stallMs', env: 'MYTERMINAL_WORKFLOW_STALL_SECONDS', field: 'wf-stall-seconds', unit: 'seconds', floor: 1, ceiling: null, default: 180, group: 'dispatch' },
  { name: 'waitChunkSeconds', gate: 'waitChunkMs', env: 'MYTERMINAL_WORKFLOW_WAIT_CHUNK_SECONDS', field: 'wf-wait-chunk-seconds', unit: 'seconds', floor: 1, ceiling: null, default: 600, group: 'reducer' },
  { name: 'reducerBudgetMinutes', gate: 'reducerBudgetMs', env: 'MYTERMINAL_WORKFLOW_REDUCER_BUDGET_MINUTES', field: 'wf-reducer-budget', unit: 'minutes', floor: 1, ceiling: null, default: 35, group: 'reducer' },
  { name: 'reducerTimeoutMinutes', gate: 'reducerTimeoutMs', env: 'MYTERMINAL_WORKFLOW_REDUCER_TIMEOUT_MINUTES', field: 'wf-reducer-timeout', unit: 'minutes', floor: 1, ceiling: null, default: 40, group: 'reducer' },
  { name: 'keepQuotaCount', gate: 'keepQuotaCount', env: 'MYTERMINAL_WORKFLOW_KEEP_QUOTA_COUNT', field: 'wf-keep-quota-count', unit: 'count', floor: 1, ceiling: null, default: 50, group: 'worktree-quota' },
  { name: 'keepQuotaBytes', gate: 'keepQuotaBytes', env: 'MYTERMINAL_WORKFLOW_KEEP_QUOTA_BYTES', field: 'wf-keep-quota-bytes', unit: 'bytes', floor: 1, ceiling: null, default: 5 * 1024 * 1024 * 1024, group: 'worktree-quota' },
  { name: 'archiveAfterDays', gate: 'archiveAfterDays', env: 'MYTERMINAL_WORKFLOW_ARCHIVE_AFTER_DAYS', field: 'wf-archive-after-days', unit: 'days', floor: 1, ceiling: null, default: 30, group: 'worktree-quota' },
  { name: 'autoArchive', gate: 'autoArchive', env: 'MYTERMINAL_WORKFLOW_AUTO_ARCHIVE', field: 'wf-auto-archive', unit: 'switch', default: 'off', group: 'worktree-quota' },
  { name: 'snapshotRetain', gate: 'snapshotRetain', env: 'MYTERMINAL_WORKFLOW_SNAPSHOT_RETAIN', field: 'wf-snapshot-retain', unit: 'count', floor: 1, ceiling: null, default: MAX_RETAINED_SNAPSHOTS, group: 'retention' },
  { name: 'terminalRunRetain', gate: 'terminalRunRetain', env: 'MYTERMINAL_WORKFLOW_TERMINAL_RUN_RETAIN', field: 'wf-terminal-run-retain', unit: 'count', floor: 1, ceiling: null, default: MAX_RETAINED_TERMINAL_RUNS, group: 'retention' },
  { name: 'reducerQuota', gate: 'reducerQuota', env: 'MYTERMINAL_WORKFLOW_REDUCER_QUOTA', field: 'wf-reducer-quota', unit: 'count', floor: 1, ceiling: null, default: 3, group: 'reducer' },
] as const;

function numericDefaultOf(key: NumericWorkflowSettingKey, availableParallelism: number): number {
  return key.default === 'auto' ? defaultConcurrencyWindow(availableParallelism) : key.default;
}

function toGateNumber(unit: 'minutes' | 'seconds' | 'tokens' | 'bytes' | 'days' | 'count', value: number): number {
  if (unit === 'minutes') return value * MINUTE;
  if (unit === 'seconds') return value * 1000;
  return value;
}

/** 默认闸——由登记表算出，本机核数决定并发窗口那一项。 */
/** 默认闸——一切键都不调时的形状；reduceSlack 恒为常量。 */
export function defaultWorkflowGates(availableParallelism: number = os.availableParallelism()): WorkflowGates {
  const numbers = {} as Record<Exclude<keyof WorkflowGates, 'autoArchive' | 'reduceSlackMs'>, number>;
  let autoArchive = false;
  let unlimited = false;
  for (const key of WORKFLOW_SETTING_KEYS) {
    if (key.unit === 'switch') {
      if (key.name === 'unlimited') unlimited = key.default === 'on';
      else if (key.name === 'autoArchive') autoArchive = key.default === 'on';
      continue;
    }
    numbers[key.gate as keyof typeof numbers] = toGateNumber(key.unit, numericDefaultOf(key, availableParallelism));
  }
  return { ...numbers, reduceSlackMs: REDUCE_SLACK_MS, autoArchive, tokenCap: unlimited ? null : numbers.tokenCap };
}

/** 默认闸（按本机核数）；测试要固定核数口径时用 defaultWorkflowGates(n)。 */
export const DEFAULT_GATES: WorkflowGates = defaultWorkflowGates();

/** 某个登记键的默认值（设置面单位）——TUI 回显与"默认即上限"的展示口径同源。 */
export function workflowSettingDefault(key: WorkflowSettingKey, availableParallelism: number = os.availableParallelism()): number | boolean {
  return key.unit === 'switch' ? key.default === 'on' : numericDefaultOf(key, availableParallelism);
}

/** 设置面的默认形态：只有明确写死的键（并发窗口留空 = 走核数公式）。 */
export const DEFAULT_WORKFLOW_SETTINGS: WorkflowsSettings = Object.fromEntries(
  WORKFLOW_SETTING_KEYS
    .filter((key) => key.default !== 'auto')
    .map((key) => [key.name, key.unit === 'switch' ? key.default === 'on' : key.default]),
) as WorkflowsSettings;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseEnvInteger(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

const ENV_ON = /^(1|true|yes|on)$/i;
const ENV_OFF = /^(0|false|no|off)$/i;

function parseEnvSwitch(raw: string): boolean | undefined {
  const trimmed = raw.trim();
  if (ENV_ON.test(trimmed)) return true;
  if (ENV_OFF.test(trimmed)) return false;
  return undefined;
}

/** 越界取值压回 [floor, ceiling]；压过就留一条归因文案（告警与 clamped 清单共用同一份）。 */
function clampToRange(label: string, value: number, key: NumericWorkflowSettingKey): { value: number; notice?: string } {
  if (key.ceiling !== null && value > key.ceiling) {
    return { value: key.ceiling, notice: `${label}=${value} exceeds the hard ceiling ${key.ceiling}; running at ${key.ceiling}.` };
  }
  if (value < key.floor) {
    return { value: key.floor, notice: `${label}=${value} is below the floor ${key.floor}; running at ${key.floor}.` };
  }
  return { value };
}

export type ResolvedWorkflowGates = { gates: WorkflowGates; warnings: string[] };

/**
 * 设置文件 + env → 运行时闸门。优先级 env > 文件 > 默认。
 * 本模块不读进程环境与核数以外的一切外部来源：调用方显式传入，测试才有确定性。
 */
export function resolveWorkflowGates(
  settings: WorkflowsSettings | undefined,
  env: NodeJS.ProcessEnv = {},
  availableParallelism: number = os.availableParallelism(),
): ResolvedWorkflowGates {
  const warnings: string[] = [];
  const warn = (message: string): void => { warnings.push(message); };
  const section = settings ?? {};
  const numbers = {} as Record<Exclude<keyof WorkflowGates, 'autoArchive' | 'reduceSlackMs'>, number>;
  let autoArchive = false;
  let unlimited = false;

  const fileSwitch = (key: SwitchWorkflowSettingKey): boolean =>
    typeof section[key.name] === 'boolean' ? (section[key.name] as boolean) : key.default === 'on';

  for (const key of WORKFLOW_SETTING_KEYS) {
    const envRaw = env[key.env];

    if (key.unit === 'switch') {
      let value = fileSwitch(key);
      if (envRaw !== undefined) {
        const parsed = parseEnvSwitch(envRaw);
        if (parsed === undefined) warn(`env ${key.env}="${envRaw}" is not an on/off value; ignored.`);
        else value = parsed;
      }
      if (key.name === 'unlimited') unlimited = value;
      else if (key.name === 'autoArchive') autoArchive = value;
      continue;
    }

    const fallback = toGateNumber(key.unit, numericDefaultOf(key, availableParallelism));
    const fromFile = section[key.name];
    let candidate: { label: string; value: number } | undefined;

    if (envRaw !== undefined) {
      const parsed = parseEnvInteger(envRaw);
      if (parsed === undefined) warn(`env ${key.env}="${envRaw}" is not a positive integer; falling back to the default.`);
      else candidate = { label: key.env, value: parsed };
    }
    if (candidate === undefined && fromFile !== undefined) {
      if (isPositiveInteger(fromFile)) candidate = { label: key.name, value: fromFile };
      else warn(`${key.name}=${String(fromFile)} is not a positive integer; falling back to the default.`);
    }
    if (candidate === undefined) {
      numbers[key.gate as keyof typeof numbers] = fallback;
      continue;
    }
    const clamped = clampToRange(candidate.label, candidate.value, key);
    if (clamped.notice) warn(clamped.notice);
    numbers[key.gate as keyof typeof numbers] = toGateNumber(key.unit, clamped.value);
  }

  return {
    gates: {
      ...numbers,
      // 余量恒取常量：设置面与 env 都没有这个旋钮。
      reduceSlackMs: REDUCE_SLACK_MS,
      autoArchive,
      tokenCap: unlimited ? null : numbers.tokenCap,
    },
    warnings,
  };
}

export type ClockNestingViolation = {
  inner: string;
  outer: string;
  innerMs: number;
  outerMs: number;
  slackMs: number;
  maxAllowedMs: number;
};

export type ClockNestingCheck = { ok: true } | { ok: false; violations: ClockNestingViolation[] };

/** 嵌套对的唯一序列：逐路两钟 → 墙钟 → 汇总体预算 → 汇总体硬杀。 */
function nestingPairs(gates: WorkflowGates): Array<[string, number, string, number]> {
  return [
    ['dispatchWindow', gates.dispatchWindowMs, 'runGate', gates.runGateMs],
    ['stall', gates.stallMs, 'runGate', gates.runGateMs],
    ['runGate', gates.runGateMs, 'reducerBudget', gates.reducerBudgetMs],
    ['reducerBudget', gates.reducerBudgetMs, 'reducerTimeout', gates.reducerTimeoutMs],
  ];
}

/**
 * 时钟嵌套校验：内层 ≤ 外层 − reduceSlack。违例由启动方 fail-closed 拒启动（§16）。
 * 逐条列名，不合并、不静默挑一个——调参击穿嵌套时要知道击穿了哪几处。
 */
export function validateClockNesting(gates: WorkflowGates): ClockNestingCheck {
  const slackMs = gates.reduceSlackMs;
  const violations: ClockNestingViolation[] = [];
  for (const [inner, innerMs, outer, outerMs] of nestingPairs(gates)) {
    const maxAllowedMs = outerMs - slackMs;
    if (innerMs <= maxAllowedMs) continue;
    violations.push({ inner, outer, innerMs, outerMs, slackMs, maxAllowedMs });
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** 违例的可读归因（启动校验的 FORBIDDEN 消息用它，口径单源）。 */
export function describeClockNesting(violations: readonly ClockNestingViolation[]): string {
  return violations
    .map((v) => `${v.inner} (${v.innerMs}ms) must stay at least ${v.slackMs}ms below ${v.outer} (${v.outerMs}ms); allowed max ${v.maxAllowedMs}ms`)
    .join('; ');
}

/** 设置节里混进的端点字段名（单源纪律的探针；空数组 = 干净）。 */
export function endpointClashInWorkflowSection(section: Record<string, unknown>): string[] {
  return ENDPOINT_FIELD_NAMES.filter((field) => Object.hasOwn(section, field));
}

export type NormalizedWorkflowSettings = {
  value: WorkflowsSettings;
  errors: string[];
  clamped: Array<{ name: keyof WorkflowsSettings; from: number; to: number }>;
};

/**
 * 设置文件里 workflows 节的归一化：类型不符 / 未知键 / 端点字段一律报错（typo 静默失效
 * 比报错危险得多）；越硬顶与越下限照运行期同口径压回并留名，不当错误处理。
 */
export function normalizeWorkflowSettings(section: WorkflowsSettings): NormalizedWorkflowSettings {
  const errors: string[] = [];
  const clamped: Array<{ name: keyof WorkflowsSettings; from: number; to: number }> = [];
  const value: Record<string, number | boolean> = {};
  const byName = new Map(WORKFLOW_SETTING_KEYS.map((key) => [key.name as string, key]));

  for (const clash of endpointClashInWorkflowSection(section)) {
    errors.push(`Workflows settings must not carry endpoint field "${clash}" — baseUrl / apiKey / model live in the subagent section (single source).`);
  }
  for (const name of Object.keys(section)) {
    if (!byName.has(name) && !ENDPOINT_FIELD_NAMES.includes(name as (typeof ENDPOINT_FIELD_NAMES)[number])) {
      errors.push(`Unknown workflows setting "${name}"; known keys: ${WORKFLOW_SETTING_KEYS.map((k) => k.name).join(', ')}.`);
    }
  }

  for (const key of WORKFLOW_SETTING_KEYS) {
    const raw = section[key.name];
    if (raw === undefined) continue;
    if (key.unit === 'switch') {
      if (typeof raw !== 'boolean') errors.push(`Workflows ${key.name} must be boolean.`);
      else value[key.name] = raw;
      continue;
    }
    if (!isPositiveInteger(raw)) {
      errors.push(`Workflows ${key.name} must be a positive integer (got ${String(raw)}).`);
      continue;
    }
    const bounded = clampToRange(key.name, raw, key);
    if (bounded.notice) clamped.push({ name: key.name, from: raw, to: bounded.value });
    value[key.name] = bounded.value;
  }

  return { value: value as WorkflowsSettings, errors, clamped };
}
