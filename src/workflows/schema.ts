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
  /**
   * 汇总体用量——累加记账的第三档（每路 usage + run 总计 + Reducer 用量，ADR-0052 §19）。
   * 汇总体在 run 结算之后才收场，所以这一档只回写索引、进不了终态快照那一刻；
   * additive 字段，旧产物缺省按 0 处理。取消不退、不重算。
   */
  reducerTokens?: { spent: number };
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

type Versioned = { schemaVersion?: unknown };

/**
 * 读一个机器件：先过版本闸，再交回原对象由调用方按缺省补齐缺字段。
 * 不合格（不是对象 / 版本缺失 / 版本超前）一律抛，绝不返回半读结果。
 */
export function readMachineRecord<T extends Versioned>(raw: unknown, current: number, label: string): T {
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

/**
 * 字段重命名的双写窗口（§20 的重命名过渡期）。
 *
 * 规则三条，跨一个发布版：
 *   1. 同一 schemaVersion 周期内新旧字段双写——写的时候新键为准，旧键跟着带一份同值，
 *      让上一版读者照常读得到；窗口不 bump 版本（bump 是"改语义 / 删除"那一路）。
 *   2. 读出优先新字段；只有旧键的产物把旧值抬升为新键后交给上层，不留双份。
 *   3. 下一版删旧字段，删的那一刻才升版本——不弱化 fail-closed：
 *      比读者更老的不兼容版本照旧拒读，窗口只管同版本周期内的改名。
 *
 * 今天没有任何字段要改名，所以表是空的：空表 = 这层等于不存在，读写形状逐字节不变。
 * 表一旦填了条目，必须同时补一条"这份产物在窗口结束后可以删旧键"的去处，否则双写永不出清。
 */
export type FieldRename = { readonly field: string; readonly previous: string };

/** 接线名 = 真正走这套窗口的机器件；加一张没有接线读者的表即红（防死表）。 */
export const WINDOW_WIRED_IN = ['index', 'registry', 'snapshot'] as const;

export const RENAMED_FIELDS: { readonly [K in (typeof WINDOW_WIRED_IN)[number]]: readonly FieldRename[] } = {
  index: [],
  registry: [],
  snapshot: [],
};

/** 写侧：新键有值才带旧键；缺位不造字段，重复条目不叠加，且不改动调用方的对象。 */
export function withDualWrite<T extends object>(record: T, renames: readonly FieldRename[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(record as Record<string, unknown>) };
  for (const { field, previous } of renames) {
    if (!(field in out) || out[field] === undefined) continue;
    out[previous] = out[field];
  }
  return out;
}

export type RenamedRead = {
  value: Record<string, unknown>;
  /** 从旧键抬升上来的字段名（新码读旧产物的证据）。 */
  lifted: string[];
  /** 新旧两键并存且值不同——以新键为准，但必须留名，不许静默挑一个。 */
  conflicts: string[];
};

/** 读侧：优先新字段，缺新键时抬升旧键，两缺不造。 */
export function readWithRenameWindow(raw: Record<string, unknown>, renames: readonly FieldRename[]): RenamedRead {
  const value: Record<string, unknown> = { ...raw };
  const lifted: string[] = [];
  const conflicts: string[] = [];
  for (const { field, previous } of renames) {
    const hasNew = field in value;
    const hasOld = previous in value;
    if (!hasNew && hasOld) {
      value[field] = value[previous];
      lifted.push(field);
    } else if (hasNew && hasOld && value[field] !== value[previous]) {
      conflicts.push(field);
    }
    if (hasOld) delete value[previous];
  }
  return { value, lifted, conflicts };
}
