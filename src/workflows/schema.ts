/**
 * 机器件（索引 / journal / 快照 / run 注册表）的形状与版本规则。
 *
 * 版本纪律三条：
 *   1. 只允许 additive 变更——加字段，旧产物读得动（缺字段按缺省处理）；
 *   2. 改语义 / 重命名 / 删除 = 升 schemaVersion；
 *   3. 不兼容版本 fail-closed 拒读——明确报版本不匹配，绝不半读半猜。
 *
 * 「旧码读新产物」由 readMachineRecord 的 current 参数承载：调用方传入自己
 * 认识的版本，产物更新即拒。同一函数两种方向都能测。
 */

export const SCHEMA_VERSION = 1;

export type WorkflowStatus =
  | 'running'
  | 'pausing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 终态用正向枚举：新增状态不得被静默归为活跃。 */
export const TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>(['completed', 'failed', 'cancelled']);
/** 活跃用白名单：paused 刻意计入活跃（暂停不是终态）。 */
export const ACTIVE_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>(['running', 'pausing', 'paused']);

export function isTerminal(status: WorkflowStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isActive(status: WorkflowStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/** 终态原因：中断认领与墙钟到期各有具名，不许用空串蒙混。 */
export type TerminalReason = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'settle-timeout' | 'run-gate' | (string & {});

/**
 * 一路失败的具名条目：模块不做语义判断，只把"哪一路、什么种类、为什么"逐条记全。
 * 失败清单是索引的一等字段，不靠遍历 dispatches 拼出来——汇总体与查询面都读它。
 */
export type FailureEntry = {
  seq?: number;
  label: string;
  kind: string;
  message: string;
  reason?: string;
};

export type DispatchRecord = {
  id: string;
  /** admission 序号（= 缓存键链的位置）。老产物可缺。 */
  seq?: number;
  /** 本路的前缀哈希链键；续跑重放按它对齐。 */
  key?: string;
  label: string;
  status: 'running' | 'completed' | 'failed';
  attempts: number;
  startedAt: string;
  endedAt?: string;
  outputTokens: number;
  error?: { kind: string; message: string; reason?: string };
  result?: unknown;
  /** 该路声明的隔离形态（标记而已，隔离执行属 T8）。 */
  isolation?: string;
  phase?: string;
  model?: string;
  effort?: string;
  schema?: boolean;
};

export type RunIndex = {
  schemaVersion: number;
  runId: string;
  status: WorkflowStatus;
  reason?: TerminalReason;
  ownerSessionId: string;
  scriptPath: string;
  /** 脚本引用：路径即身份，内容编辑不改引用。 */
  sourceRef: { id: string; revision: string };
  argsRecorded: boolean;
  args?: unknown;
  startedAt: string;
  endedAt?: string;
  dispatches: DispatchRecord[];
  /** 每路失败的具名清单（部分失败即带警告交付的依据）。 */
  failures: FailureEntry[];
  tokens: { spent: number };
  /** 脚本级失败的原因（run 级终结与脚本自身的错都记在这里，终态可查）。 */
  scriptError?: { kind: string; message: string };
};

export type RunSnapshot = RunIndex & { schemaVersion: number };

export type RegistryEntry = {
  runId: string;
  status: WorkflowStatus;
  ownerSessionId: string;
  startedAt: string;
  endedAt?: string;
};

export type RunRegistry = {
  schemaVersion: number;
  runs: RegistryEntry[];
};

/** 终态 run 保留数（注册表层面）。 */
export const MAX_RETAINED_TERMINAL_RUNS = 10;
/** 快照保留份数。 */
export const MAX_RETAINED_SNAPSHOTS = 30;

export class VersionMismatchError extends Error {
  constructor(readonly label: string, readonly found: unknown, readonly expected: number) {
    super(`${label}: schema version mismatch (found ${String(found)}, reader understands up to ${expected}); refusing to read.`);
    this.name = 'VersionMismatchError';
  }
}

type Record = { schemaVersion?: unknown };

/**
 * 读一个机器件：先过版本闸，再交回原对象由调用方按缺省补齐缺字段。
 * 不合格（不是对象 / 版本缺失 / 版本超前）一律抛，绝不返回半读结果。
 */
export function readMachineRecord<T extends Record>(raw: unknown, current: number, label: string): T {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new VersionMismatchError(label, undefined, current);
  const record = raw as T;
  const found = record.schemaVersion;
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) throw new VersionMismatchError(label, found, current);
  if (found > current) throw new VersionMismatchError(label, found, current);
  return record;
}

/** 序列化前补版本号，落盘统一由这里出门（防止漏写字段）。 */
export function withSchemaVersion<T extends object>(value: T, version: number = SCHEMA_VERSION): T & { schemaVersion: number } {
  return { ...value, schemaVersion: version };
}
