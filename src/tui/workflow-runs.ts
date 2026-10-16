import { access, readdir } from 'node:fs/promises';
import type { WorkflowEvent, WorkflowEventType } from '../workflows/events.js';
import { isRunId } from '../workflows/ids.js';
import { runPaths, type WorkflowPaths } from '../workflows/paths.js';
import { readIndex } from '../workflows/run-index.js';
import { isActive, isTerminal, type DispatchRecord, type RunIndex, type TerminalReason, type WorkflowStatus } from '../workflows/schema.js';
import type { StatusTone } from './status-color.js';

/**
 * Workflows 屏的装配层（ADR-0052 §21#5）：把两个数据源拼成人看得懂的一屏。
 *
 * 热 = 进程内进度事件带回来的活索引；冷 = 扫 run 目录读持久件。两源在此合一，
 * 判定规则只有这里一份——屏只渲染，不在渲染期猜状态。
 */

/** 这块屏对 run 能做的事，到此为止（v1 明确不做与子 agent 聊天 / 发提醒的页面）。 */
export const WORKFLOW_SCREEN_ACTIONS = ['open', 'cancel', 'pause', 'resume', 'copyResume'] as const;
export type WorkflowScreenAction = (typeof WORKFLOW_SCREEN_ACTIONS)[number];

export type RunBoardRow = {
  runId: string;
  status: WorkflowStatus;
  reason?: TerminalReason;
  ownerSessionId: string;
  scriptPath: string;
  startedAt: string;
  endedAt?: string;
  /** X/Y 的分子只数已完成的路。 */
  finished: number;
  total: number;
  running: number;
  failedPaths: number;
  /** 索引里 failures 清单的条数（一等字段，不靠遍历拼）。 */
  failures: number;
  tokens: number;
  reducerTokens: number;
  /** 本进程在跑它 = 热；只在盘上 = 冷。 */
  live: boolean;
  hasMarker: boolean;
  indexPath: string;
  index: RunIndex;
};

export type RunBoardUnreadable = { runId: string; message: string };
export type RunBoard = {
  rows: RunBoardRow[];
  unreadable: RunBoardUnreadable[];
  /** 整条读源失败（不是某一条 run 读不动）：目录级故障必须看得见，不能读成"一条 run 都没有"。 */
  sourceError?: string;
};

export type RunBoardSource = {
  listRunIds(): Promise<string[]>;
  readRun(runId: string): Promise<RunIndex | undefined>;
  hasMarker(runId: string): Promise<boolean>;
  isLive(runId: string): boolean;
  /** 索引的绝对路径——布局归 paths.ts，装配层不自己拼路径。 */
  indexPath(runId: string): string;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 两个桶各按各的时间倒序：活跃的置顶（含 paused——暂停不是终态），终态随后。
 * 同刻没有真值可排，就取一个确定的序（runId 字典倒序），不留给插入顺序决定。
 */
function sortRunBoard(rows: readonly RunBoardRow[]): RunBoardRow[] {
  const key = (row: RunBoardRow): number => {
    const stamp = Date.parse(isRunUiActive(row) ? row.startedAt : (row.endedAt ?? row.startedAt));
    return Number.isFinite(stamp) ? stamp : 0;
  };
  return [...rows].sort((a, b) => {
    const activeRank = Number(isRunUiActive(b)) - Number(isRunUiActive(a));
    if (activeRank !== 0) return activeRank;
    const timeRank = key(b) - key(a);
    if (timeRank !== 0) return timeRank;
    return b.runId.localeCompare(a.runId);
  });
}

export async function buildRunBoard(source: RunBoardSource): Promise<RunBoard> {
  const rows: RunBoardRow[] = [];
  const unreadable: RunBoardUnreadable[] = [];
  let ids: string[];
  try {
    ids = await source.listRunIds();
  } catch (error) {
    return { rows: [], unreadable, sourceError: messageOf(error) };
  }
  for (const runId of ids) {
    // 目录名是唯一被拼进路径的模型可控字符串：不合形态的兄弟目录直接跳过，不试读。
    if (!isRunId(runId)) continue;
    let index: RunIndex | undefined;
    try {
      index = await source.readRun(runId);
    } catch (error) {
      unreadable.push({ runId, message: messageOf(error) });
      continue;
    }
    if (!index || !index.runId) {
      unreadable.push({ runId, message: 'index.json is missing or carries no runId' });
      continue;
    }
    rows.push(toRow(runId, index, source.isLive(runId), await source.hasMarker(runId), source.indexPath(runId)));
  }
  return { rows: sortRunBoard(rows), unreadable };
}

function toRow(runId: string, index: RunIndex, live: boolean, hasMarker: boolean, indexPath: string): RunBoardRow {
  const counts = countPaths(index);
  return {
    runId,
    status: index.status,
    ...(index.reason ? { reason: index.reason } : {}),
    ownerSessionId: index.ownerSessionId,
    scriptPath: index.scriptPath,
    startedAt: index.startedAt,
    ...(index.endedAt ? { endedAt: index.endedAt } : {}),
    ...counts,
    failures: index.failures.length,
    tokens: index.tokens.spent,
    reducerTokens: index.reducerTokens?.spent ?? 0,
    live,
    hasMarker,
    indexPath,
    index: snapshotIndex(index),
  };
}

function countPaths(index: RunIndex): { finished: number; total: number; running: number; failedPaths: number } {
  let finished = 0;
  let running = 0;
  let failedPaths = 0;
  for (const dispatch of index.dispatches) {
    if (dispatch.status === 'completed') finished += 1;
    else if (dispatch.status === 'failed') failedPaths += 1;
    else running += 1;
  }
  return { finished, total: index.dispatches.length, running, failedPaths };
}

/** UI 算活跃：running / pausing / paused 三个都算（详情页要继续计时）。 */
export function isRunUiActive(row: Pick<RunBoardRow, 'status'>): boolean {
  return isActive(row.status);
}

/**
 * 账没定但本进程没在跑它——这是"被打断"的判据，与"UI 活跃"刻意分开：
 * 前者决定要不要提醒人去续跑，后者决定这一行还跳不跳。
 */
export function isRunAbandoned(row: Pick<RunBoardRow, 'status' | 'live' | 'hasMarker'>): boolean {
  if (row.live || row.hasMarker) return false;
  return isRunUiActive(row);
}

export function interruptedRuns(board: RunBoard): RunBoardRow[] {
  return board.rows.filter((row) => isRunAbandoned(row) || (row.status === 'failed' && row.reason === 'interrupted'));
}

export type RunDetailRow = {
  seq: number | undefined;
  id: string;
  label: string;
  status: DispatchRecord['status'];
  attempts: number;
  tokens: number;
  phase?: string;
  model?: string;
  effort?: string;
  isolation?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  preserved: boolean;
  errorKind?: string;
  errorMessage?: string;
};

/** 逐路一行，顺序 = admission 序（索引里怎么记就怎么排）。 */
export function renderRunDetailRows(index: RunIndex): RunDetailRow[] {
  return index.dispatches.map((dispatch) => ({
    seq: dispatch.seq ?? slotOf(dispatch.id),
    id: dispatch.id,
    label: dispatch.label,
    status: dispatch.status,
    attempts: dispatch.attempts,
    tokens: dispatch.outputTokens,
    ...(dispatch.phase ? { phase: dispatch.phase } : {}),
    ...(dispatch.model ? { model: dispatch.model } : {}),
    ...(dispatch.effort ? { effort: dispatch.effort } : {}),
    ...(dispatch.isolation ? { isolation: dispatch.isolation } : {}),
    ...(dispatch.worktree ? { worktreePath: dispatch.worktree.path, worktreeBranch: dispatch.worktree.branch } : {}),
    preserved: dispatch.worktree?.preserved === true,
    ...(dispatch.error ? { errorKind: dispatch.error.kind, errorMessage: dispatch.error.message } : {}),
  }));
}

function slotOf(id: string): number | undefined {
  const slot = /^d(\d{4})$/.exec(id);
  return slot ? Number(slot[1]) : undefined;
}

export type ResumeCallOptions = { annotate?: boolean };

/**
 * 可复制的 resume 调用文本。resume 只有 scriptPath + resumeFromRunId 这一种合法形状，
 * 脚本引用丢了就没有可给的调用——宁可不给，也不给一条必然被拒的。
 * args 只有当初记进索引才敢带回去：它是缓存链的种子，缺了就是全量重跑。
 */
export function resumeCallText(row: Pick<RunBoardRow, 'runId' | 'scriptPath' | 'index'>, options: ResumeCallOptions = {}): string | undefined {
  if (!row.scriptPath) return undefined;
  const call: Record<string, unknown> = { scriptPath: row.scriptPath, resumeFromRunId: row.runId };
  if (row.index.argsRecorded && row.index.args !== undefined) {
    return `workflow_start ${JSON.stringify({ ...call, args: row.index.args })}`;
  }
  const plain = `workflow_start ${JSON.stringify(call)}`;
  return options.annotate
    ? `${plain}  (pass its original args too — args seed the replay chain; without them every path runs again)`
    : plain;
}

export type InterruptedItem = { runId: string; line: string; call?: string };
export type InterruptedNotice = { head: string; items: InterruptedItem[]; lines: string[]; more?: string; hint: string; resume(runId: string): string | undefined };

/**
 * 启动提示（ADR-0052 §12）：一条提示不值得把启动搭进去，所以整段永不抛——
 * 命不中判据的条目直接丢掉，全丢光就等于没有提示。
 */
export function describeInterruptedRuns(
  rows: readonly RunBoardRow[],
  t: (en: string, zh: string) => string,
  options: { now: number; maxListed?: number },
): InterruptedNotice | undefined {
  try {
    const usable = rows.filter((row) => Boolean(row) && isRunId(row.runId));
    if (usable.length === 0) return undefined;
    const maxListed = options.maxListed ?? 3;
    const listed = usable.slice(0, maxListed);
    const items: InterruptedItem[] = listed.map((row) => {
      const progress = row.total > 0 ? ` · ${row.finished}/${row.total} agents finished` : '';
      return {
        runId: row.runId,
        line: `${stripControlChars(row.runId)}${progress} · ${runElapsed(row.startedAt, row.endedAt, options.now)}`,
        call: resumeCallText(row, { annotate: true }),
      };
    });
    const lines = items.map((item) => item.line);
    const more = usable.length > listed.length
      ? t(`…and ${usable.length - listed.length} more.`, `…还有 ${usable.length - listed.length} 条。`)
      : undefined;
    if (more) lines.push(`  ${more}`);
    const head = usable.length === 1
      ? t('1 interrupted workflow run from a previous process:', '上次进程被打断的工作流 run（1 条）：')
      : t(`${usable.length} interrupted workflow runs from a previous process:`, `上次进程被打断的工作流 run（${usable.length} 条）：`);
    const byId = new Map(usable.map((row) => [row.runId, row]));
    return {
      head,
      items,
      lines,
      ...(more ? { more } : {}),
      hint: t(
        'Open the Workflows tab to act on them. Paste a line below into ChatGPT to continue — paths that already finished replay from the journal cache with zero tokens.',
        '在 Workflows 页可以处置它们。把下面这行粘给 ChatGPT 即可续跑——已经跑完的路直接从 journal 缓存重放，零 token。',
      ),
      resume: (runId: string) => {
        const row = byId.get(runId);
        return row ? resumeCallText(row, { annotate: true }) : undefined;
      },
    };
  } catch {
    return undefined;
  }
}

/** 时长：< 1 分钟给秒，< 1 小时给 m:ss，再长给 h:mm。认不出的时间戳回破折号，绝不排出 NaN。 */
export function runElapsed(startedAt: string | undefined, endedAt: string | undefined, now: number): string {
  const start = Date.parse(startedAt ?? '');
  const end = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '-';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * run 状态 → 色带。与 status-color.ts 那张表刻意分开：这里的 cancelled 是人按下的
 * 正常终态（归中性），而并入那张表会把 cancelled 的染色规则渗到工具调用行上去。
 */
const RUN_TONES: Record<WorkflowStatus, StatusTone> = {
  running: 'accent',
  pausing: 'warn',
  paused: 'warn',
  completed: 'good',
  failed: 'bad',
  cancelled: 'muted',
};

export function runStatusTone(status: WorkflowStatus): StatusTone {
  return RUN_TONES[status] ?? 'muted';
}

export const EMPTY_RUN_BOARD: RunBoard = { rows: [], unreadable: [] };

export type WorkflowEventPatch = {
  /** 事件只带身份不带全账；活索引在进程里时由接线方按 runId 递过来。 */
  liveIndex?(runId: string): RunIndex | undefined;
  /** 索引路径出自模块的布局，装配层不自己拼。 */
  indexPath?(runId: string): string;
};

const EVENT_STATUS: Partial<Record<WorkflowEventType, WorkflowStatus>> = {
  run_pausing: 'pausing',
  run_paused: 'paused',
  run_resumed: 'running',
};

/**
 * 事件到达即在投影上落地——不等下一次扫盘（票面"下一渲染帧内可见"）。
 * 优先用本进程那份活索引（引擎在发事件前已把账改好），拿不到才照事件数据补。
 * 事件是观测面不是关键路径：认不出的类型、投影里没有的 run 一律原样返回，
 * 新出现的 run 只由 run_started 带活索引时建行，别处不凭事件造一条半截账。
 */
export function applyWorkflowEvent(board: RunBoard, event: WorkflowEvent, patch: WorkflowEventPatch = {}): RunBoard {
  const live = patch.liveIndex?.(event.runId);
  const current = board.rows.find((row) => row.runId === event.runId);
  if (!current) {
    if (event.type !== 'run_started' || !live) return board;
    const added = toRow(event.runId, live, !isTerminal(live.status), false, patch.indexPath?.(event.runId) ?? '');
    return { ...board, rows: sortRunBoard([...board.rows, added]) };
  }
  const patched = live ? withIndex(current, live) : patchRow(current, event);
  if (!live && patched === current) return board;
  const next: RunBoardRow = {
    ...patched,
    ...(isTerminal(patched.status) ? { live: false } : {}),
    ...(event.type === 'run_settled' ? { hasMarker: event.data?.markerWritten === true } : {}),
  };
  return { ...board, rows: sortRunBoard(board.rows.map((row) => (row.runId === current.runId ? next : row))) };
}

function patchRow(row: RunBoardRow, event: WorkflowEvent): RunBoardRow {
  if (event.type === 'dispatch_settled') {
    const dispatchId = event.data?.dispatchId;
    const reported = event.data?.status as DispatchRecord['status'] | undefined;
    const status = reported === 'completed' || reported === 'failed' ? reported : undefined;
    if (typeof dispatchId !== 'string' || !status) return row;
    const dispatches = row.index.dispatches.map((dispatch) => (dispatch.id === dispatchId ? { ...dispatch, status } : dispatch));
    return withIndex(row, { ...row.index, dispatches });
  }
  const status = EVENT_STATUS[event.type];
  if (status) return withIndex(row, { ...row.index, status });
  if (event.type === 'run_settled') {
    const settled = event.data?.status as WorkflowStatus | undefined;
    if (settled !== 'completed' && settled !== 'failed' && settled !== 'cancelled') return row;
    const reason = typeof event.data?.reason === 'string' ? event.data.reason as TerminalReason : undefined;
    return withIndex(row, { ...row.index, status: settled, ...(reason ? { reason } : {}), endedAt: event.at });
  }
  return row;
}

function withIndex(row: RunBoardRow, index: RunIndex): RunBoardRow {
  const held = snapshotIndex(index);
  return {
    ...row,
    index: held,
    status: held.status,
    ...(held.reason ? { reason: held.reason } : {}),
    ...(held.endedAt ? { endedAt: held.endedAt } : {}),
    ...countPaths(held),
  };
}

/**
 * 投影存的是"取到的那一拍"：引擎的活索引是原地改的，直接握着就等于屏上的账会自己动。
 * 每路正文刻意不留在这里——这块屏是索引视图，全文在 run 目录的每路文件里（§10 路径布局），
 * 几十路各揣一份结构化输出进渲染树，是把观测面变成第二个内存大户。
 */
function snapshotIndex(index: RunIndex): RunIndex {
  return {
    ...index,
    dispatches: index.dispatches.map(({ result: _result, ...record }) => record),
    failures: [...index.failures],
    tokens: { ...index.tokens },
  };
}

/** CSI 转义序整条剥掉（只去掉转义符会留下 "31m" 这种残文，一样是注入面），其余 C0/C1 控制字符一并去掉。 */
const ANSI_CSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const OTHER_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * 剥掉 ANSI 序与其余控制字符。runId 出自目录名、路径出自索引，都不是可信文本：
 * 它们要上屏、要当选择锚，带一条转义序就能自己染色。
 */
export function stripControlChars(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  return value.replace(ANSI_CSI, '').replace(OTHER_CONTROLS, '');
}

export type DiskRunBoardInput = {
  paths: WorkflowPaths;
  /** 本进程在跑的那条 run 的最新索引（热路径的权威；没有就给 undefined）。 */
  liveIndex(runId: string): RunIndex | undefined;
  /**
   * 本进程在跑的 run。它同时管两件事：这些 run 一定出现在列表里（哪怕目录还没落盘），
   * 以及"live"位的真值——两件事必须出自同一本账，否则屏上会出现"活着却看不见"。
   */
  liveRunIds(): string[];
};

/**
 * 真源：先问内存（在跑的比盘面新一拍），再读 index.json（跑完的、重启前起的都在这儿）。
 * runs/ 还没被建出来 = 一条 run 都没有，不是故障。
 */
export function diskRunBoardSource(input: DiskRunBoardInput): RunBoardSource {
  const pathsFor = (runId: string) => runPaths(input.paths, runId);
  return {
    indexPath: (runId) => pathsFor(runId).indexFile,
    isLive: (runId) => input.liveRunIds().includes(runId),
    async listRunIds() {
      const live = input.liveRunIds();
      try {
        const entries = await readdir(input.paths.runsRoot, { withFileTypes: true });
        return [...new Set([...entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name), ...live])];
      } catch (error) {
        // runs/ 还没被建出来 = 一条 run 都没有；其余故障（权限、挂载点坏了）不是"没有"，
        // 原样抛给 buildRunBoard 记成 sourceError——读不动与空目录在屏上必须是两回事。
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return live;
        throw error;
      }
    },
    async readRun(runId) {
      return input.liveIndex(runId) ?? (await readIndex(pathsFor(runId).indexFile));
    },
    async hasMarker(runId) {
      try {
        await access(pathsFor(runId).terminalFile);
        return true;
      } catch {
        return false;
      }
    },
  };
}
