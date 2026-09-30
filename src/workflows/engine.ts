import { Clock, systemClock } from './clock.js';
import { dispatchId, isRunId, newRunId } from './ids.js';
import { Journal } from './journal.js';
import { scanDeterminism } from './lint.js';
import { loadScript, persistScript, SCRIPT_NAME_PATTERN } from './saved.js';
import { agentFile, managedRootFor, runPaths, workflowPaths, type RunPaths, type WorkflowPaths } from './paths.js';
import { readIndex, writeIndex } from './run-index.js';
import { upsertRegistry } from './registry.js';
import { runInSandbox, type SandboxHost } from './sandbox.js';
import { isTerminal, SCHEMA_VERSION, type DispatchRecord, type FailureEntry, type RunIndex, type TerminalReason, type WorkflowStatus } from './schema.js';
import { writeSnapshot } from './snapshot.js';
import { buildSettledNotice, markNoticeDelivered, putNotice, sha256File, type OutboxItem } from './notice.js';
import { concludeReducer, decideReducerAdmission, resolveReducerBudget, type ReducerAdmit, type ReducerVerdict } from './reducer.js';
import { ensureDir, createExclusive, exists, removeFile, writeJsonAtomic } from './atomic.js';
import { WorkflowEvents } from './events.js';
import { resolveCrashPlan, type CrashPlan, type CrashPoint } from './crash.js';
import { createDispatchWindow, HARD_CONCURRENCY_CEILING, type DispatchWindow } from './scheduler.js';
import { DEFAULT_GATES, HARD_AGENT_CAP_CEILING, describeClockNesting, validateClockNesting, type WorkflowGates } from './gates.js';
import { canonicalAgentOpts, gateAgentOpts, type GatedAgentOpts } from './agent-opts.js';
import { requestedWriteToolNames, resolveToolFace, type ToolContext, type ToolMode } from './tool-face.js';
import { WorktreeService, type Released, type WorktreeAuditEvent } from './worktree-service.js';
import { deriveAgentKey } from './keys.js';
import { buildReplayCache, replayChainSeed, type ReplayCache } from './cache.js';
import { acquireResumeLock, releaseResumeLock, type LockProbe } from './lock.js';
import {
  AgentCallShapeError,
  WorkflowAgentCapExceededError,
  WorkflowBudgetExceededError,
  classifyAdapterError,
  isRunLevelError,
  runLevelError,
  silenceFailure,
  type RunTerminationReason,
  type SettledFailure,
} from './failures.js';
import type { AdapterFactory } from './adapter.js';
import { resolveStallMs, runStallResilient } from './stall.js';
import { runAgentPath } from './agent-loop.js';
import { buildAgentSystemPrompt } from './agent-prompt.js';
import { collectOwnerCommands, collectRunCommands, resumeAcceptingCommands } from './command-tree.js';

/**
 * run 生命周期：建 run → 脚本在窗口里 fan-out（每路一个独立 adapter 实例）→ 结算。
 *
 * 三处纪律：
 *   1. admission 是同步的一段：校验 → 键滚动 → 计数 → 记账，全部在任何 await 之前。
 *      N 路并发扇出时微任务爆发也只按调用序进键，完成顺序改不了账本；
 *   2. 每路结算三态各归各位：该路失败 = null 并具名记账（run 继续），调用形状错 =
 *      reject（不 admission、不进失败清单），run 级 = throw（整批拒、在飞中止、队列丢弃）；
 *   3. 结算只有一处（settle），终态标记最后写、独占创建——后到者读到已有标记即退让。
 * 一切时间经注入时钟，一切模型调用经注入工厂，state 根与并发窗口可整体重定向。
 */


/** 单路一次调用的输出上限（本票不表达为脚本可传的旋钮）。 */
export const DEFAULT_OUTPUT_TOKENS = 32_000;

/** 一路结算的原料：settlePath 的唯一入参形状（成功带值，失败带具名归类）。 */
type SettledOutcome = { ok: true; value: unknown; outputTokens: number } | { ok: false; failure: SettledFailure };

/** 这一路的边界从哪来：worktree = 模块新建并负责收；pinned = 借一块已注册的现成件，不建不删。 */
type PathBoundary = 'worktree' | 'pinned';

type OpenedBoundary = { cwd: string; managedId?: string } | { failure: SettledFailure };

/**
 * 声明 isolation:'worktree' 走新建，声明 workingDir 走 pin（两者由选项闸互斥）。
 * 都没声明即共享工作区——那一跑只能读，写工具不在面上、工具自己也再拒一遍。
 */
function dispatchBoundary(gated: GatedAgentOpts): PathBoundary | undefined {
  if (gated.isolation === 'worktree') return 'worktree';
  if (gated.workingDir !== undefined) return 'pinned';
  return undefined;
}

export type WorkflowAuditEntry = {
  runId: string;
  action:
    | 'workflow_start'
    | 'workflow_settle'
    | 'workflow_cancel'
    | 'workflow_pause'
    | 'workflow_resume'
    | 'workflow_paused_resume'
    // 隔离面的三条（#231）：配额两档由 ADR §12 I17 点名，丢弃与归档是"唯一减法 = 人"的留痕。
    | 'worktree-quota-warn'
    | 'worktree-quota-blocked'
    | 'worktree_discard'
    | 'worktree_archive';
  actor: string;
  status: string;
  reason?: string;
  at: string;
  /** 仅结算阶段终止异常带：原样留下出错文本，审计才说得出死在哪一步。 */
  detail?: string;
};

export type EngineDeps = {
  workspaceDir: string;
  /** state 根可重定向（测试整棵树搬进临时目录）。 */
  managedRoot?: string;
  clock?: Clock;
  adapterFactory?: AdapterFactory;
  events?: WorkflowEvents;
  audit?: (entry: WorkflowAuditEntry) => void;
  /** 自限闸门（默认即上限；本机设置面经 gates.ts 解析后注入这里）。 */
  gates?: Partial<WorkflowGates>;
  /** 并发窗口的直接断言缝：给了就以它为准（滚动补位的水位用例用它）。 */
  concurrencyWindow?: number;
  /** 终态消息投递缝：outbox 项落盘之后才试投一次；返回 true 才算投到（据此标 delivered）。 */
  deliverNotice?: (notice: { runId: string; ownerSessionId: string; body: string; sha256: string }) => Promise<boolean> | boolean;
  /** 结算阶段故障注入缝：抛出即视为本进程在此终止（见 crash.ts 的三帧）。 */
  crash?: (point: CrashPoint) => void;
  /** env 路线（真 SIGKILL）的取值来源；缺省读本进程环境。 */
  crashEnv?: Record<string, string | undefined>;
  /** 动手动作本身，测试里注入它就能断"命中了几次"而不必真杀进程。 */
  crashKill?: (pid: number, signal: 'SIGKILL') => void;
  /** resume 排他锁的本机身份探针：pid + epoch + 存活判定 + 时钟；缺省走本进程，测试整体替换。 */
  lockProbe?: LockProbe;
  /**
   * 写必隔离的执行体（ADR-0052 §11）。缺省由本引擎按 managed 根 + 配额闸自建；
   * 注入它即可整体假化 git 调用——引擎级用例不必真起 git。
   */
  worktrees?: WorktreeService;
};

export type StartRequest = {
  script?: string;
  scriptPath?: string;
  resumeFromRunId?: string;
  args?: unknown;
  ownerSessionId: string;
  /**
   * 归属确权候选（自 + continuesSessionId 祖先链）：resume 的"是不是本 root 名下"用它判，
   * 缺省退回 [ownerSessionId]。三场景（重启 / 换凭证 / session_inherit）由接线方把链算好传进来。
   */
  ownerCandidates?: readonly string[];
};

export type StartResult = {
  runId: string;
  status: WorkflowStatus;
  scriptPath: string;
  /** 续跑账：journal 被截断时丢弃了多少行（0 表示账本完整）。 */
  journalDropped?: number;
  /** 后台跑完后的终态索引；工具面只取前三个字段，不等它。 */
  completion: Promise<RunIndex>;
};

export class WorkflowStartError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'NOT_FOUND' | 'FORBIDDEN',
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowStartError';
  }
}

type RunContext = {
  runId: string;
  run: RunPaths;
  journal: Journal;
  index: RunIndex;
  seq: number;
  spent: number;
  settled: boolean;
  /** 整 run 的中止信号：墙钟到期或 run 级终结即 abort，在飞的路随之止损。 */
  controller: AbortController;
  /** 共享并发窗口：嵌套的 workflow() 用的就是这一个窗口，不另开。 */
  window: DispatchWindow;
  /** 前缀哈希链的游标（键序 = 调用序的地基）。 */
  chainPrefix: string;
  /** admission 计数（increment-then-check）。 */
  agentCount: number;
  /** run 级终结后账就封口：之后的调用一律拒。 */
  open: boolean;
  termination?: { reason: RunTerminationReason; message: string };
  /**
   * 索引写串：admission 与结算都不排队等写盘（否则键链的同步段被打断），
   * 但落盘按排队顺序进行——并发路各写全量快照，乱了序就会让旧版后落。
   */
  indexWrites: Promise<unknown>;
  gateHandle?: { id: unknown };
  completion?: Promise<RunIndex>;
  /**
   * 结算触发信号：墙钟到期或 run 级终结（含取消）时由 terminate() 打断执行段，
   * 与脚本赛跑——在飞的路随信号止损、结算照走，绝不等一个永不归来的模型调用。
   */
  stop?: () => void;
  /** 续跑重放的缓存视图：只在 resumeFromRunId 时为非空；首跑恒 null（无跨 run 记忆）。 */
  replay: ReplayCache | null;
  /** 重放命中要复用的前记录（key → 已完成的那一路），命中的调用把它接回账本、不重跑。 */
  replayRecords: Map<string, DispatchRecord>;
  /** 前缀屏障：第一个未命中的调用起，其后一律 live（哪怕脚本后面没改）。 */
  replayBarrierBroken: boolean;
  /** 续跑排他锁的持有身份；非 resume 或未取到锁时为空。结算/异常出口按它释放。 */
  lock?: LockProbe;
  /** 暂停标志：墙钟冻结、新调用在 admission 处原地等待，恢复即放行。 */
  paused: boolean;
  /** 暂停时墙钟已用毫秒（冻结在暂停那一刻，恢复后按剩余量续跑）。 */
  gateRemainingMs: number;
  /** 本段计时器武装的时刻，用于暂停时结算已走时长。 */
  gateArmedAt: number;
  /** 协作式暂停的放行闸：暂停时挂起、resume 时兑现，新调用在此排队。 */
  pauseHold?: { promise: Promise<void>; release: () => void };
};

/** 墙钟到期的内部信号：只用于把 race 拉出执行段，不对外暴露。 */
class RunGateReached extends Error {
  constructor() {
    super('The run reached its wall-clock gate.');
    this.name = 'RunGateReached';
  }
}

/** pid 存活判定：ESRCH = 没这个进程；EPERM = 有但无权信号（照算活着）。 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 缺省锁探针：本进程 pid + 以构造时刻当 epoch（重启必得更晚的 epoch，兜住 pid 复用窗口）。 */
function defaultLockProbe(clock: Clock): LockProbe {
  const epoch = clock.now();
  return { pid: process.pid, epoch, isAlive: isPidAlive, now: () => clock.now(), iso: () => clock.iso() };
}

export class WorkflowEngine {
  private readonly clock: Clock;
  private readonly paths: WorkflowPaths;
  private readonly gates: WorkflowGates;
  private readonly events: WorkflowEvents;
  private readonly factory: AdapterFactory | undefined;
  private readonly windowSize: number;
  private readonly crash: CrashPlan;
  private readonly lockProbe: LockProbe;
  private readonly runs = new Map<string, RunContext>();
  private worktreeService?: WorktreeService;

  constructor(private readonly deps: EngineDeps) {
    this.clock = deps.clock ?? systemClock();
    this.paths = workflowPaths(deps.managedRoot ?? managedRootFor(deps.workspaceDir));
    // 硬顶在构造期也成立：并发值不得越过 64、agent 数不得越过 10,000，无论它来自
    // 设置文件、env 还是直接注入本构造器的调用方。
    // 下限这里刻意是 1 而不是设置面的 2：构造器是水位断言的注入缝（"窗口 1 会静默
    // 串行化 parallel"这类用例要用它），本机设置面则由 gates.ts 钉住公式下限 2。
    const requested = { ...DEFAULT_GATES, ...(deps.gates ?? {}) };
    const window = deps.concurrencyWindow ?? requested.concurrencyWindow;
    this.gates = {
      ...requested,
      concurrencyWindow: Math.min(HARD_CONCURRENCY_CEILING, Math.max(1, Math.floor(window))),
      agentCap: Math.min(HARD_AGENT_CAP_CEILING, Math.max(1, Math.floor(requested.agentCap))),
    };
    this.events = deps.events ?? new WorkflowEvents();
    this.factory = deps.adapterFactory;
    this.crash = deps.crash ?? resolveCrashPlan({ env: deps.crashEnv ?? process.env, kill: deps.crashKill });
    this.lockProbe = deps.lockProbe ?? defaultLockProbe(this.clock);
    this.windowSize = this.gates.concurrencyWindow;
    // 有引擎在跑 = 宿主愿意接单：关机流程把进程级的"停接单"置下去之后，
    // 同一进程里重建引擎（重启 runtime、测试换宿主）就是重新开闸的唯一去处，
    // 否则一次关机会把闸门永久留在关着的状态。
    resumeAcceptingCommands();
  }

  /** 本引擎的并发窗口大小（观测面：滚动补位的上限水位）。 */
  get windowLimit(): number {
    return this.windowSize;
  }

  /** 本引擎实际生效的 agent 数上限（观测面：硬顶压回后的最终值）。 */
  get agentLimit(): number {
    return this.gates.agentCap;
  }

  /** 启动一条 run：做完所有"烧 token 前"的校验，立即返回，余下在后台跑。 */
  async start(request: StartRequest): Promise<StartResult> {
    // 时钟嵌套不变量先过：调参击穿嵌套就 fail-closed 拒启动（§16，违例码照 §8 = FORBIDDEN）。
    const nesting = validateClockNesting(this.gates);
    if (!nesting.ok) {
      throw new WorkflowStartError('FORBIDDEN', 'clock-nesting', `Workflow clock nesting violated: ${describeClockNesting(nesting.violations)}.`);
    }
    const runId = request.resumeFromRunId ?? newRunId();
    const run = runPaths(this.paths, runId);

    let script: { path: string; content: string; sourceRef: { id: string; revision: string } };
    if (typeof request.script === 'string') {
      const saved = await persistScript(this.paths, request.script, runId);
      script = { path: saved.path, content: saved.content, sourceRef: saved.sourceRef };
    } else if (typeof request.scriptPath === 'string') {
      const loaded = await loadScript(this.paths, request.scriptPath);
      if (!loaded.ok) throw new WorkflowStartError(loaded.reason === 'not-found' ? 'NOT_FOUND' : 'VALIDATION', `script-path-${loaded.reason}`, `Workflow script is not loadable: ${request.scriptPath} (${loaded.reason}).`);
      script = { path: loaded.path, content: loaded.content, sourceRef: loaded.sourceRef };
    } else {
      throw new WorkflowStartError('VALIDATION', 'script-missing', 'workflow_start requires script or scriptPath.');
    }

    // 确定性扫描：非确定性脚本在烧任何 token 前被拒。
    const violations = scanDeterminism(script.content);
    if (violations.length > 0) {
      const detail = violations.map((v) => `${v.literal} (line ${v.line})`).join(', ');
      throw new WorkflowStartError('VALIDATION', 'non-deterministic-script', `Workflow script uses non-deterministic calls: ${detail}.`);
    }

    let journalDropped = 0;
    let previous: RunIndex | undefined;
    let replay: ReplayCache | null = null;
    let replayRecords = new Map<string, DispatchRecord>();
    let lock: LockProbe | undefined;
    let priorSeq = 0;
    if (request.resumeFromRunId) {
      const ownerCandidates = request.ownerCandidates ?? [request.ownerSessionId];
      previous = await readIndex(run.indexFile);
      if (!previous) throw new WorkflowStartError('NOT_FOUND', 'run-not-found', `Workflow run not found: ${request.resumeFromRunId}.`);
      // 归属 = ownerSessionId 相等或其延续链包含（§3④）；换凭证不改归属，session_inherit 继承全部名下 run。
      if (!this.ownsRun(previous.ownerSessionId, ownerCandidates)) throw new WorkflowStartError('FORBIDDEN', 'run-not-owned', `Workflow run ${runId} belongs to another session.`);
      // 判据 = 脚本引用（路径 / 名）一致；内容编辑不改引用（改动按缓存语义从变更调用起重跑），引用不同 = 新 run。
      if (previous.sourceRef.id !== script.sourceRef.id) throw new WorkflowStartError('VALIDATION', 'source-mismatch', `Resuming a run requires the same script reference (${previous.sourceRef.id}); got ${script.sourceRef.id}.`);
      // 终态 run 里只有 cancelled 可被 resume 重开（§19：取消后想接着干 = 对同一 runId 续跑）；completed / failed 恒封口。
      if (previous.status !== 'cancelled') {
        if (await exists(run.terminalFile)) throw new WorkflowStartError('VALIDATION', 'run-already-terminal', `Workflow run ${runId} already settled as ${previous.status}; reopening a terminal run is not allowed.`);
      }
      // 缺一即拒：盘上脚本已由 scriptPath 闸门保证，journal 缺失就没有可重放的账，也不能当空跑（§17 数据安全边界）。
      if (!(await exists(run.journalFile))) throw new WorkflowStartError('NOT_FOUND', 'journal-missing', `Workflow run ${runId} has no journal on disk, so there is nothing to replay; start a new run instead.`);
      // 排他锁（owner pid + epoch）：第二个续跑者含另一会话一律拒，防共写目录 / 标记 / worktree 与双份全量重跑。
      const acquired = await acquireResumeLock(run.lockFile, request.ownerSessionId, this.lockProbe);
      if (!acquired.ok) {
        const why = acquired.reason === 'unreadable'
          ? 'the resume lock exists but is unreadable (refusing to double-resume on uncertain ground)'
          : `it is held by pid ${String(acquired.holder?.pid)} (epoch ${String(acquired.holder?.epoch)})`;
        throw new WorkflowStartError('FORBIDDEN', 'resume-locked', `Workflow run ${runId} cannot be resumed: ${why}.`);
      }
      lock = this.lockProbe;
      // 账本卫生：先截断至最长良前缀，丢弃段显式记账（不静默丢）；截断先行，预启动门据此放行。
      const journalForTruncate = this.journalFor(run);
      const report = await journalForTruncate.truncateToGoodPrefix();
      journalDropped = report.dropped;
      // 重放缓存 = 良前缀 journal 的 result 投影：未变前缀推回同键即零 token 复用，
      // 第一个变 / 缺的调用起其后全部 live（§17 最长未变前缀）。命中时把对应已完成记录接回账本。
      const records = await journalForTruncate.read();
      replay = buildReplayCache(records);
      for (const record of previous.dispatches) {
        if (record.status === 'completed' && record.key && replay.has(record.key)) replayRecords.set(record.key, record);
      }
      // 槽位游标接在断点之后：journal 已写到的最大 seq 之后才落新行（append-only 绝不覆写旧行，重跑记成新的 admission 序号）。
      priorSeq = records.reduce((max, record) => ('seq' in record && typeof record.seq === 'number' ? Math.max(max, record.seq) : max), 0);
    }

    await ensureDir(run.dir);
    await ensureDir(run.agentsDir);
    await ensureDir(run.outboxDir);
    // 取消后重开：清掉旧终态标记，让新的结算能独占创建自己的线性化点（§15 至少一次投递，
    // 消费侧按 (runId, sha256) 去重——旧 notice 与新 notice 是"更新版"关系，不重复计账）。
    if (request.resumeFromRunId && previous?.status === 'cancelled') await removeFile(run.terminalFile);

    const journal = this.journalFor(run);
    const startedAt = this.clock.iso();
    const index: RunIndex = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      status: 'running',
      ownerSessionId: previous?.ownerSessionId ?? request.ownerSessionId,
      scriptPath: script.path,
      sourceRef: script.sourceRef,
      argsRecorded: request.args !== undefined,
      ...(request.args !== undefined ? { args: request.args } : {}),
      startedAt: previous?.startedAt ?? startedAt,
      // 续跑账从空开始：命中的调用把对应已完成记录接回，未命中的 live 路重记——
      // 如此索引恰等于"这一跑真实跑过的调用"，改 args / 改 prompt 都不会留下被取代的旧记录。
      dispatches: [],
      failures: [],
      tokens: { spent: previous?.tokens.spent ?? 0 },
    };
    await writeIndex(run.indexFile, index);
    await upsertRegistry(this.paths.registryFile, { runId, status: 'running', ownerSessionId: index.ownerSessionId, startedAt: index.startedAt });

    // 续跑：seq / 槽位接在所有已 admission 之后（新 live 路不撞旧槽），键链从 args 种子重推（与首跑同串才谈得上重放），
    // agentCount 归零——缓存命中的调用不进预算门与计数，live 路 fresh 计一次。
    const resume = request.resumeFromRunId !== undefined;
    const sequence = resume ? priorSeq : 0;
    journal.prime(sequence + 1);
    const gateRemainingMs = this.gates.runGateMs;
    const context: RunContext = {
      runId,
      run,
      journal,
      index,
      seq: sequence,
      spent: index.tokens.spent,
      settled: false,
      open: true,
      controller: new AbortController(),
      window: createDispatchWindow(this.windowLimit),
      indexWrites: Promise.resolve(),
      chainPrefix: replayChainSeed(index.args),
      agentCount: 0,
      replay,
      replayRecords,
      replayBarrierBroken: false,
      lock,
      paused: false,
      gateRemainingMs,
      gateArmedAt: this.clock.now(),
    };
    this.runs.set(runId, context);

    if (!resume) await journal.append({ type: 'launched', runId, at: startedAt });
    this.deps.audit?.({ runId, action: resume ? 'workflow_resume' : 'workflow_start', actor: request.ownerSessionId, status: 'running', at: startedAt });
    this.events.emit({ runId, type: 'run_started', at: startedAt, data: { scriptPath: script.path, resumed: Boolean(request.resumeFromRunId), concurrencyWindow: this.windowLimit, replayHits: replay?.size ?? 0, journalDropped } });

    const completion = this.execute(context, script.content);
    context.completion = completion;
    // 工具面拿到 runId 就走，没人接这个 promise：后台 run 在结算阶段终止时，
    // 绝不该升级成进程级 unhandledRejection（那会把同进程的消息库与 TUI 一起带走）。
    // 兜法不是吞：记一条 settle-failed 审计，盘面停在已写出的那一半，交由认领趟收敛。
    void completion.catch((error: unknown) => {
      const detail = error && typeof error === 'object' && typeof (error as Error).message === 'string' ? (error as Error).message : String(error);
      this.deps.audit?.({ runId, action: 'workflow_settle', actor: request.ownerSessionId, status: 'failed', reason: 'settle-failed', at: this.clock.iso(), detail });
    });
    return {
      runId,
      status: 'running',
      scriptPath: script.path,
      ...(journalDropped > 0 ? { journalDropped } : {}),
      completion,
    };
  }

  /** 已受理 run 的终态索引（结算后即返回）。 */
  async settled(runId: string): Promise<RunIndex | undefined> {
    const context = this.runs.get(runId);
    if (!context) return undefined;
    return await context.completion;
  }

  /**
   * reduce 校验缝（工具层在起 subagent 之前用）：run 在不在、归谁、三件路径在哪。
   * 读盘上的索引而非内存 Map——汇总体与 run 可以来自上一次进程留下的目录。
   */
  async lookupRun(runId: string): Promise<{ ownerSessionId: string; status: WorkflowStatus; indexPath: string; terminalPath: string; digestPath: string } | undefined> {
    if (!isRunId(runId)) return undefined;
    const run = runPaths(this.paths, runId);
    const index = await readIndex(run.indexFile);
    if (!index) return undefined;
    return { ownerSessionId: index.ownerSessionId, status: index.status, indexPath: run.indexFile, terminalPath: run.terminalFile, digestPath: run.digestFile };
  }

  /** 汇总体准入：等待位独占 + 并发配额；通过即附本次的等待约束（起时 = 本引擎时钟）。 */
  async admitReducer(input: { runId: string; agentId: string; ownerSessionId: string }): Promise<ReducerAdmit> {
    const admission = await decideReducerAdmission(this.paths, { ...input, at: this.clock.iso(), gates: this.gates });
    if (!admission.ok) return admission;
    const budget = resolveReducerBudget(this.gates, { startedAt: this.clock.now(), now: () => this.clock.now() });
    return { ...admission, timeoutSec: budget.timeoutSec, budgetEndsAt: budget.budgetEndsAt };
  }

  /** 汇总体收场判定：只认盘面证据，并释放等待位；顺带累加汇总体用量第三档。 */
  async concludeReducer(info: { runId: string; agentId: string; digestPath: string; reducerOutputTokens?: number }): Promise<ReducerVerdict> {
    return await concludeReducer(this.paths, info);
  }

  private journalFor(run: RunPaths): Journal {
    return Journal.open(run.journalFile);
  }

  private async execute(context: RunContext, source: string): Promise<RunIndex> {
    // 墙钟与脚本赛跑：墙钟先到即中止在飞的路并结算，脚本先到按结果结算。
    // 计时与中止都走注入时钟与本 run 的 controller，不接受系统定时器。
    // 取消也走同一条 break：terminate 兑现 stop，让一个挂在模型里的路不必等墙钟。
    const stop = new Promise<never>((_resolve, reject) => {
      context.stop = () => reject(new RunGateReached());
    });
    this.armGate(context);

    try {
      const outcome = await Promise.race([runInSandbox({ source, args: context.index.args, timeoutMs: 30_000, host: this.hostFor(context, false) }), stop]);
      if (context.termination) {
        await this.settle(context, statusForTermination(context.termination.reason), context.termination.reason);
        return context.index;
      }
      if (!outcome.ok) {
        context.index.scriptError = { kind: outcome.kind, message: outcome.message };
        await this.settle(context, 'failed', outcome.kind === 'timeout' ? 'run-gate' : 'script-failed');
        return context.index;
      }
      // run 级判定只有机器三态：全败即 failed，部分失败仍 completed（带警告交付）。
      const succeeded = context.index.dispatches.some((record) => record.status === 'completed');
      const admitted = context.index.dispatches.length > 0;
      if (admitted && !succeeded) {
        context.index.scriptError = { kind: 'all-paths-failed', message: `All ${context.index.dispatches.length} agent paths failed.` };
        await this.settle(context, 'failed', 'failed');
        return context.index;
      }
      await this.settle(context, 'completed', 'completed');
      return context.index;
    } catch (error) {
      // 终态已经开始宣告（哪怕只走到一半）就不再改判第二次：
      // 注入的终止必须原样冒出去，迟到的第二笔产物只会让盘面自相矛盾。
      if (context.settled) throw error;
      if (context.termination) {
        await this.settle(context, statusForTermination(context.termination.reason), context.termination.reason);
        return context.index;
      }
      const reason = error instanceof RunGateReached ? 'run-gate' : 'script-failed';
      context.index.scriptError = { kind: reason, message: (error as Error)?.message ?? String(error) };
      await this.settle(context, 'failed', reason);
      return context.index;
    } finally {
      if (context.gateHandle) this.clock.clearTimeout(context.gateHandle);
    }
  }

  /**
   * 武装墙钟闸：从剩余毫秒起一只表。暂停把剩余量冻结、恢复重新武装——
   * paused 期间墙钟不走（§19），恢复后接着跑那同一段余量，绝不重放已走时间。
   */
  private armGate(context: RunContext): void {
    if (context.gateHandle) this.clock.clearTimeout(context.gateHandle);
    context.gateArmedAt = this.clock.now();
    context.gateHandle = this.clock.setTimeout(() => {
      this.terminate(context, 'run-gate', 'The run reached its wall-clock gate.');
    }, Math.max(0, context.gateRemainingMs));
  }

  /** 暂停结算已走的墙钟时长，把余量冻在暂停这一刻；重复暂停不重复扣时。 */
  private freezeGate(context: RunContext): void {
    if (context.gateHandle) {
      this.clock.clearTimeout(context.gateHandle);
      context.gateHandle = undefined;
      const used = Math.max(0, this.clock.now() - context.gateArmedAt);
      context.gateRemainingMs = Math.max(0, context.gateRemainingMs - used);
    }
  }

  /**
   * 沙箱宿主面。nested = true 时不给 workflow()——单层嵌套的限制就是这么实现的：
   * 不是计数器，是第二层根本拿不到这个函数。
   */
  private hostFor(context: RunContext, nested: boolean): SandboxHost {
    const host: SandboxHost = {
      agent: async (prompt, opts) => await this.countedDispatch(context, prompt, opts),
      budget: {
        total: this.gates.tokenCap,
        spent: () => context.spent,
        remaining: () => (this.gates.tokenCap === null ? Number.POSITIVE_INFINITY : Math.max(0, this.gates.tokenCap - context.spent)),
      },
    };
    // 第二层拿不到再扇出的能力：限制靠"注入什么"表达，不靠计数器。
    // 拒因带 run 级标记——批里也不许被降成 null，否则非法嵌套会以"完成"收场（假完整红线）。
    host.workflow = nested ? () => this.nestingRefused(context) : async (ref, args, opts) => await this.runNested(context, ref, args, opts);
    return host;
  }

  private nestingRefused(context: RunContext): Promise<never> {
    const error = runLevelError('nesting-limit', 'workflow() nesting is limited to one level: a nested script cannot fan out again.');
    this.terminate(context, 'nesting-limit', error.message);
    throw error;
  }

  /** 嵌套复用已保存脚本：共享同一 run 的键链、窗口、预算与注册表。 */
  private async runNested(context: RunContext, ref: unknown, args?: unknown, opts?: unknown): Promise<unknown> {
    if (context.termination) throw runLevelError(context.termination.reason, context.termination.message);
    const loaded = await this.resolveSaved(ref);
    const nestedViolations = scanDeterminism(loaded.content);
    if (nestedViolations.length > 0) {
      throw new Error(`workflow() refused: the saved script uses non-deterministic calls (${nestedViolations.map((v) => v.literal).join(', ')}).`);
    }
    const outcome = await runInSandbox({ source: loaded.content, args, host: this.hostFor(context, true), timeoutMs: 30_000 });
    if (!outcome.ok) throw new Error(`workflow(${JSON.stringify(String(loaded.name))}) failed (${outcome.kind}): ${outcome.message}`);
    return outcome.value;
  }

  private async resolveSaved(ref: unknown): Promise<{ name: string; content: string }> {
    if (typeof ref === 'string') {
      // 名字面就限死在 saved 根内：路径形态当名字用即拒，不按字符串去读盘。
      if (!SCRIPT_NAME_PATTERN.test(ref)) {
        throw new AgentCallShapeError(`workflow() expects a saved script name (letters, digits and dashes); received: ${JSON.stringify(ref)}`);
      }
      const loaded = await loadScript(this.paths, `${this.paths.savedRoot}/${ref}.js`);
      if (!loaded.ok) throw new Error(`workflow() could not load the saved script ${ref}.js (${loaded.reason}).`);
      return { name: ref, content: loaded.content };
    }
    if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
      const record = ref as Record<string, unknown>;
      if (typeof record.scriptPath === 'string') {
        const loaded = await loadScript(this.paths, record.scriptPath);
        if (!loaded.ok) throw new Error(`workflow() could not load ${record.scriptPath} (${loaded.reason}).`);
        return { name: record.scriptPath, content: loaded.content };
      }
      if (typeof record.name === 'string') return await this.resolveSaved(record.name);
    }
    throw new AgentCallShapeError('workflow() expects a saved script name or { scriptPath }.');
  }

  /**
   * 一路 agent：同步走完 admission（校验 → 键滚动 → 闸门 → 记账），
   * 之后才进窗口排队。顺序即正确性，任何一步都不许挪到 await 之后。
   */
  private async countedDispatch(context: RunContext, prompt: string, rawOpts?: Record<string, unknown>): Promise<unknown> {
    this.assertOpen(context);
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new AgentCallShapeError('agent() requires a non-empty prompt.');
    }
    // 形状错在这一刻就拒：不占键位、不计数、不进失败清单。
    const gated = gateAgentOpts(rawOpts);

    // 这一路的边界从哪来，决定它能不能写：声明隔离 = 新建一件；pin 到已注册 worktree = 借那件；
    // 两者皆无 = 跑在共享工作区里，工具面按只读执法（ADR-0052 §11 写必隔离）。
    const boundary = dispatchBoundary(gated);
    const gatedMode: ToolMode = boundary ? 'worktree' : 'read-only';
    // 请求写而不标隔离排在工具面之前：这一路判败（记入索引、零 token、run 继续），不是形状错——
    // 脚本没写错到不可执行，是它要的能力这一路没有。面按写模式解析只为让请求的写工具不被
    // 认成"面上没有"而抛出去；解析结果不会派发任何东西。
    const unisolatedWrite = boundary === undefined && requestedWriteToolNames(gated.tools).length > 0;
    const face = resolveToolFace({
      mode: unisolatedWrite ? 'worktree' : gatedMode,
      tools: gated.tools,
      disallowedTools: gated.disallowedTools,
      agentType: gated.agentType,
      schema: gated.schema !== undefined,
    });
    if (face.refusal) throw new AgentCallShapeError(`${face.refusal.message} (reason: ${face.refusal.reason})`);
    const toolNames = face.names;

    // 协作式暂停：新调用在 admission 处原地等待，恢复即放行——暂停不派新活、不吃墙钟（§19）。
    await this.waitWhilePaused(context);

    // 键先滚动，再过预算门与计数（ADR §17 顺序契约）：链是"调用序列"的函数，
    // 不能因为某一次被闸门拒掉就不计位——否则同一脚本在不同闸下会派生出不同的链。
    const key = deriveAgentKey(context.chainPrefix, prompt, canonicalAgentOpts(gated));
    context.chainPrefix = key;

    // 缓存查询在预算门与计数之前（§17 顺序契约）：续跑命中未变前缀即零 token 复用，不占槽、不计 agent 数。
    // 前缀屏障：第一个未命中的调用起，其后一律 live（哪怕脚本后面没改）。
    if (context.replay && !context.replayBarrierBroken && context.replay.has(key)) {
      // 命中：把对应的已完成记录接回账本（每路 usage 与结果都在里面），token 不重算、不重复扣预算。
      // 与 live 路同一把写列（queueIndexWrite），别让命中路径和派发路径各写一套 index。
      const reused = context.replayRecords.get(key);
      if (reused) {
        context.index = { ...context.index, dispatches: [...context.index.dispatches, reused] };
        queueIndexWrite(context);
      }
      return context.replay.get(key);
    }
    if (context.replay) context.replayBarrierBroken = true;

    const sequence = ++context.seq;

    this.assertBudget(context);
    context.agentCount += 1;
    if (context.agentCount > this.gates.agentCap) {
      const error = new WorkflowAgentCapExceededError(this.gates.agentCap);
      this.terminate(context, 'agent-cap', error.message);
      throw error;
    }

    const slot = dispatchId(sequence);
    const label = typeof gated.label === 'string' && gated.label.trim() ? gated.label : `agent-${sequence}`;
    const startedAt = this.clock.iso();
    const record: DispatchRecord = {
      id: slot,
      seq: sequence,
      key,
      label,
      status: 'running',
      attempts: 1,
      startedAt,
      outputTokens: 0,
      ...(gated.isolation ? { isolation: gated.isolation } : {}),
      ...(gated.phase ? { phase: gated.phase } : {}),
      ...(gated.model ? { model: gated.model } : {}),
      ...(gated.effort ? { effort: gated.effort } : {}),
      ...(gated.schema ? { schema: true } : {}),
    };
    context.index = { ...context.index, dispatches: [...context.index.dispatches, record] };
    queueIndexWrite(context);
    void context.journal.append({ type: 'started', seq: sequence, key, label, at: startedAt }).catch(() => undefined);

    // 写必隔离在这里落地：账已记（该路具名判败），模型调用一次都没发起。
    if (unisolatedWrite) {
      const asked = requestedWriteToolNames(gated.tools).join(', ');
      return await this.settlePath(context, record, {
        ok: false,
        failure: { kind: 'error', message: `agent() asked for a write tool (${asked}) without isolation: "worktree" — this path was never started and spent no tokens.`, reason: 'isolation-required' },
      });
    }

    try {
      return await this.runPath(context, record, prompt, gated, toolNames, gatedMode, boundary);
    } catch (error) {
      // run 级终结把排队与在飞的等待打断：那不是这一路自己失败，
      // 绝不许在批里被降成 null（那会让非法扇出静默"完成"）。
      if (!context.open) throw runLevelError(context.termination?.reason ?? 'cancelled', context.termination?.message ?? 'The run is no longer accepting work.');
      throw error;
    }
  }

  /** 叶子任务才进窗口：排队不占键位，取槽时再过一次预算门。 */
  private runPath(context: RunContext, record: DispatchRecord, prompt: string, gated: GatedAgentOpts, toolNames: readonly string[], mode: ToolMode, boundary: PathBoundary | undefined): Promise<unknown> {
    return context.window.run(async () => {
      this.assertOpen(context);
      this.assertBudget(context);
      const factory = this.factory;
      if (!factory) {
        return await this.settlePath(context, record, { ok: false, failure: { kind: 'error', message: 'No model adapter is wired for this run.', reason: 'no-adapter' } });
      }
      // 边界先行：建不出隔离件就没有这一路——连模型通道都不必开，拒绝落在任何资源副作用之前。
      const opened = boundary ? await this.openBoundary(context, record, gated, boundary) : { cwd: this.deps.workspaceDir } as OpenedBoundary;
      if ('failure' in opened) {
        return await this.settlePath(context, record, { ok: false, failure: opened.failure });
      }
      // 每路独立实例：缓存断点是实例态，共享实例会让一路撞到的 4xx 关掉全部并发路的断点。
      // 把本引擎的注入时钟交给工厂：传输层瞬态 backoff 与 stall 看门狗共用一只钟（§16）。
      const adapter = factory({ runId: context.runId, dispatchId: record.id, clock: this.clock });
      let outcome: SettledOutcome;
      let kept: Released | undefined;
      try {
        outcome = await this.attemptPath(context, record, adapter, prompt, gated, toolNames, mode, opened.cwd);
      } finally {
        // 有改动的件在这里定性：保留就把 path + branch 报出去，clean 才自动删。
        if (opened.managedId) kept = await this.worktrees().release(opened.managedId).catch(() => undefined);
      }
      return await this.settlePath(context, record, this.withWorktreeNote(record, outcome, kept));
    });
  }

  /**
   * 拿到这一路的边界。worktree = 模块新建并负责收；pinned = 借一块已注册的现成件，
   * 只 rebind 不建不删（它的归属权在借出它的人手里，不在这里）。
   */
  private async openBoundary(context: RunContext, record: DispatchRecord, gated: GatedAgentOpts, boundary: PathBoundary): Promise<OpenedBoundary> {
    const service = this.worktrees();
    if (boundary === 'pinned') {
      const pinned = await service.pin({ runId: context.runId, dispatchId: record.id, workingDir: gated.workingDir as string });
      if (!pinned.ok) return { failure: { kind: 'error', message: pinned.message, reason: pinned.reason } };
      return { cwd: pinned.path };
    }
    const made = await service.provision({ runId: context.runId, dispatchId: record.id, label: record.label });
    if (!made.ok) return { failure: { kind: 'error', message: made.message, reason: made.reason } };
    return { cwd: made.path, managedId: made.id };
  }

  /**
   * 一路的执行段：看门狗与重试 → 结果归类。返回结算原料，不动任何机器件，
   * 结算唯一出口在 settlePath（隔离回报要先于结算定下来）。
   */
  private async attemptPath(context: RunContext, record: DispatchRecord, adapter: ReturnType<AdapterFactory>, prompt: string, gated: GatedAgentOpts, toolNames: readonly string[], mode: ToolMode, cwd: string): Promise<SettledOutcome> {
    const stallMs = resolveStallMs(gated.stallMs, this.gates.stallMs);
    // 重试次数随每次尝试起跑即时落到 record（成功或耗尽判败都进该路终态记账）。
    const reportAttempt = (n: number): void => { record.attempts = n; };
    const run = runPaths(this.paths, context.runId);
    const system = buildAgentSystemPrompt({
      label: record.label,
      cwd,
      platform: process.platform,
      toolNames,
      mode,
      isolated: mode === 'worktree',
      schema: gated.schema !== undefined,
    });
    let result;
    try {
      // dispatch 层：无进展 → 换控制器重试（≤3）；非 stall 失败不重试，直接抛回归类。
      const outcome = await runStallResilient(
        {
          clock: this.clock,
          stallMs,
          dispatchWindowMs: this.gates.dispatchWindowMs,
          dispatchTurns: this.gates.dispatchTurns,
          parentSignal: context.controller.signal,
          label: record.label,
          onAttempt: reportAttempt,
        },
        async (signal, progress) => {
          const toolContext: ToolContext = {
            runId: context.runId,
            dispatchId: record.id,
            cwd,
            mode,
            signal,
            run,
            progress,
          };
          try {
            // 这一跑的循环在模块自己手里：一轮一次模型往返，工具在飞挂起无进展计时。
            return await runAgentPath({
              adapter,
              system,
              prompt,
              maxTokens: DEFAULT_OUTPUT_TOKENS,
              ...(gated.model ? { model: gated.model } : {}),
              signal,
              progress,
              toolNames,
              context: toolContext,
              maxRounds: this.gates.dispatchTurns,
              ...(gated.schema ? { schema: gated.schema } : {}),
            });
          } finally {
            // 随路收尸：这一路起出去的命令树（含后台）不许活过这一路。
            await collectOwnerCommands({ runId: context.runId, dispatchId: record.id });
          }
        },
      );
      result = outcome.value;
    } catch (error) {
      // run 级终结打断在飞的等待：那不是这一路自己失败，绝不许在批里被降成 null。
      if (isRunLevelError(error)) throw error;
      return { ok: false, failure: classifyAdapterError(error) };
    }
    context.spent += result.outputTokens;
    if (gated.schema) {
      // 结构化出口优先：经 structured_output 交回的对象就是该路结果。
      if (result.hasStructured) return { ok: true, value: result.structured, outputTokens: result.outputTokens };
      const structured = parseStructured(result.text);
      if (!structured.ok) return { ok: false, failure: { kind: 'no_structured_output', message: structured.message } };
      return { ok: true, value: structured.value, outputTokens: result.outputTokens };
    }
    if (!result.text || !result.text.trim()) return { ok: false, failure: silenceFailure('this agent') };
    return { ok: true, value: result.text, outputTokens: result.outputTokens };
  }

  /**
   * 有改动保留时把 path + branch 报出去：机器件逐字段记（索引与该路文件都读得到），
   * 文本结果再补一行让脚本与汇总体看得见。schema 模式的对象一个字节都不动——
   * 往结构化结果里塞宿主侧的尾巴会造出第二个真相源。
   */
  private withWorktreeNote(record: DispatchRecord, outcome: SettledOutcome, kept?: Released): SettledOutcome {
    if (!kept) return outcome;
    record.worktree = { path: kept.path, branch: kept.branch, preserved: kept.kept, ...(kept.branchPreserved ? { branchPreserved: true } : {}) };
    if (!kept.kept || !outcome.ok || typeof outcome.value !== 'string') return outcome;
    return { ...outcome, value: `${outcome.value}\n[worktree preserved: ${kept.path} (branch ${kept.branch})]` };
  }

  /**
   * 一路的结算唯一出口：写每路文件 → 写索引（按 admission 位归位）→ 具名记账 →
   * 归位序进账本 → 发事件。失败即返回 null（脚本槽位与裸 await 同值），成功即返回该路值。
   */
  private async settlePath(
    context: RunContext,
    record: DispatchRecord,
    outcome: SettledOutcome,
  ): Promise<unknown> {
    // 终态已宣告（或 run 级已封口）：迟归的那一路不再动任何机器件——
    // 索引 / 快照 / 终态标记必须彼此一致，"此后任何证据不再改动终态"。
    if (context.settled || !context.open) return null;
    const endedAt = this.clock.iso();
    const next: DispatchRecord = outcome.ok
      ? { ...record, status: 'completed', endedAt, outputTokens: outcome.outputTokens }
      : { ...record, status: 'failed', endedAt, error: { kind: outcome.failure.kind, message: outcome.failure.message, ...(outcome.failure.reason ? { reason: outcome.failure.reason } : {}) } };
    context.index.dispatches = context.index.dispatches.map((item) => (item.id === record.id ? next : item));
    context.index.tokens = { spent: context.spent };
    if (!outcome.ok) {
      const entry: FailureEntry = {
        ...(record.seq !== undefined ? { seq: record.seq } : {}),
        label: record.label,
        kind: outcome.failure.kind,
        message: outcome.failure.message,
        ...(outcome.failure.reason ? { reason: outcome.failure.reason } : {}),
      };
      context.index.failures = [...context.index.failures, entry];
    }
    await writeJsonAtomic(agentFile(context.run, record.id), { schemaVersion: SCHEMA_VERSION, ...next, ...(outcome.ok ? { result: outcome.value } : {}) });
    queueIndexWrite(context);
    void context.journal
      .appendOrdered(record.seq as number, outcome.ok
        ? { type: 'result', seq: record.seq as number, key: record.key, value: outcome.value, at: endedAt }
        : { type: 'failed', seq: record.seq as number, key: record.key, error: { kind: outcome.failure.kind, message: outcome.failure.message }, at: endedAt })
      .catch(() => undefined);
    this.events.emit({ runId: context.runId, type: 'dispatch_settled', at: endedAt, data: { dispatchId: record.id, status: next.status } });
    return outcome.ok ? outcome.value : null;
  }

  /** run 级终结：一旦封口，后续调用一律拒，在飞的路随信号止损，队列丢弃。 */
  private terminate(context: RunContext, reason: RunTerminationReason, message: string): void {
    if (!context.open) return;
    context.open = false;
    context.termination = { reason, message };
    context.controller.abort();
    context.window.abort();
    // 整个 run 终结：在飞的命令树按进程组收（燃烧就地停，不留无主进程）。
    void collectRunCommands(context.runId).catch(() => undefined);
    // 打断执行段：取消与墙钟同走这条 break，绝不等一个挂在模型里永不归来的调用（§8 "快调用"）。
    // 若此刻没有活跃 execute（例如尚未起跑的续跑），stop 缺席即 no-op，由后续 execute 依 termination 结算。
    context.stop?.();
  }

  /**
   * 归属确权（§3④）：run 的 ownerSessionId 落在 actor 的候选链里即本 root 名下。
   * 候选链 = 自 sessionId + continuesSessionId 祖先，由工具层算好传入；引擎不碰会话存储。
   */
  private ownsRun(ownerSessionId: string, ownerCandidates: readonly string[]): boolean {
    return ownerCandidates.includes(ownerSessionId);
  }

  /**
   * 写必隔离的执行体——首次用到才建：全程只读的 run 不该碰一次 git。
   * 配额两档取本机设置面（§8-I4），审计走引擎同一条汇，actor 换成这条 run 的归属会话。
   */
  private worktrees(): WorktreeService {
    if (this.deps.worktrees) return this.deps.worktrees;
    if (!this.worktreeService) {
      this.worktreeService = new WorktreeService({
        worktreesRoot: this.paths.worktreesRoot,
        workspaceDir: this.deps.workspaceDir,
        gates: { keepQuotaCount: this.gates.keepQuotaCount, keepQuotaBytes: this.gates.keepQuotaBytes },
        clock: this.clock,
        audit: (event) => this.auditWorktree(event),
      });
    }
    return this.worktreeService;
  }

  private auditWorktree(event: WorktreeAuditEvent): void {
    const failed = event.result === 'blocked' || event.result === 'failed' || event.result === 'not-found';
    this.deps.audit?.({
      runId: event.runId,
      action: event.action,
      actor: this.runs.get(event.runId)?.index.ownerSessionId ?? event.actor,
      status: failed ? 'failed' : 'completed',
      reason: [...(event.reasons ?? []), event.result].filter(Boolean).join(':'),
      at: this.clock.iso(),
      ...(event.detail ? { detail: event.detail } : {}),
    });
  }

  /**
   * Worktrees 面板的读面（#231 AC8）：保留项清单。
   * 每次从登记簿重读——冷启动与重启后同一份真相，不看进程内存。
   */
  async preservedWorktrees() {
    const service = this.worktrees();
    await service.load();
    return service.preserved();
  }

  /** 配额档位：面板那一行告警与审计事件出自同一次判定。 */
  async worktreeQuota() {
    const service = this.worktrees();
    return await service.quotaSummary();
  }

  /**
   * 唯一减法 = 人：面板上的丢弃（合并是 git 的活，人在那儿做；这里只给显式删除，审计留痕）。
   * actor 是按下按钮的那个人（会话 id / 'tui'），不是 run 的归属。
   */
  async discardWorktree(id: string, actor: string): Promise<{ ok: true; path: string; branch: string } | { ok: false; reason: string; message: string }> {
    const service = this.worktrees();
    await service.load();
    return await service.discard(id, actor);
  }

  /** 可选自动归档（默认关）：接线方（定时器 / 面板）按设置调用；关着就一条都不动。 */
  async archiveWorktreesDue(): Promise<{ id: string; ok: boolean; message?: string }[]> {
    if (!this.gates.autoArchive) return [];
    const service = this.worktrees();
    await service.load();
    return await service.archiveDue({ autoArchive: true, archiveAfterDays: this.gates.archiveAfterDays });
  }

  /** 协作式暂停的等待闸：非暂停即空过；暂停则挂起，直到 resume 释放。 */
  private waitWhilePaused(context: RunContext): Promise<void> {
    if (!context.paused) return Promise.resolve();
    if (context.pauseHold) return context.pauseHold.promise;
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => { release = resolve; });
    context.pauseHold = { promise, release };
    return promise;
  }

  /**
   * 取消整 run（GPT 面第二个工具的引擎面，ADR-0052 §8 / §19）：
   *   仅本 root、幂等（终态返回当前状态）、粒度整 run；效果 = 在飞随 abort 中止、队列丢弃、
   *   结算 cancelled（三件套照发）→ 汇总体醒来报 cancelled partial。
   * 快调用语义靠 terminate 打断执行段兑现，不等墙钟；已结算的 run 原样回其当前状态。
   */
  async cancel(runId: string, ownerCandidates: readonly string[]): Promise<{ runId: string; status: WorkflowStatus }> {
    if (!isRunId(runId)) throw new WorkflowStartError('NOT_FOUND', 'run-not-found', `Workflow run not found: ${runId}.`);
    const context = this.runs.get(runId);
    if (context) {
      if (!this.ownsRun(context.index.ownerSessionId, ownerCandidates)) {
        throw new WorkflowStartError('FORBIDDEN', 'run-not-owned', `Workflow run ${runId} belongs to another session.`);
      }
      if (isTerminal(context.index.status)) return { runId, status: context.index.status };
      const at = this.clock.iso();
      this.terminate(context, 'cancelled', 'Workflow run cancelled by its owner.');
      let status: WorkflowStatus = 'cancelled';
      try {
        const final = context.completion ? await context.completion : undefined;
        status = final?.status ?? (await readIndex(context.run.indexFile))?.status ?? 'cancelled';
      } catch {
        // 结算在 execute 里已按 cancelled 落定；completion 的迟到拒绝只回读盘面终态，不改判。
        status = (await readIndex(context.run.indexFile))?.status ?? 'cancelled';
      }
      // settle 已发 run_settled 与 workflow_settle 审计；这里只补一条 cancel 归因，不重复发事件。
      this.deps.audit?.({ runId, action: 'workflow_cancel', actor: ownerCandidates[0] ?? context.index.ownerSessionId, status, reason: 'cancelled', at });
      return { runId, status };
    }
    // 不在本进程内存：读盘面。终态即幂等返回；活跃但非本进程所起（崩溃未扫）不改判、只回当前状态。
    const run = runPaths(this.paths, runId);
    const index = await readIndex(run.indexFile);
    if (!index) throw new WorkflowStartError('NOT_FOUND', 'run-not-found', `Workflow run not found: ${runId}.`);
    if (!this.ownsRun(index.ownerSessionId, ownerCandidates)) {
      throw new WorkflowStartError('FORBIDDEN', 'run-not-owned', `Workflow run ${runId} belongs to another session.`);
    }
    return { runId, status: index.status };
  }

  /**
   * 暂停整 run（仅 TUI 面；GPT 面无 pause，§19）：pausing→paused 状态与事件可观察受理，
   * 墙钟冻结、reducer 等待预算经 index.status 冻结（读侧见 T6），恢复原地继续。
   */
  async pause(runId: string, ownerCandidates: readonly string[]): Promise<{ runId: string; status: WorkflowStatus }> {
    const context = this.activeOwnedContext(runId, ownerCandidates, 'pause');
    if (isTerminal(context.index.status)) return { runId, status: context.index.status };
    if (context.paused) return { runId, status: context.index.status };
    const actor = ownerCandidates[0] ?? context.index.ownerSessionId;
    context.index = { ...context.index, status: 'pausing' };
    await this.persistStatus(context, 'pausing');
    this.events.emit({ runId, type: 'run_pausing', at: this.clock.iso(), data: { actor } });
    // 受理即冻结：墙钟把余量停在暂停那一刻，新调用挂到恢复闸上。
    context.paused = true;
    this.freezeGate(context);
    context.index = { ...context.index, status: 'paused' };
    await this.persistStatus(context, 'paused');
    this.deps.audit?.({ runId, action: 'workflow_pause', actor, status: 'paused', at: this.clock.iso() });
    this.events.emit({ runId, type: 'run_paused', at: this.clock.iso(), data: { actor, gateRemainingMs: context.gateRemainingMs } });
    return { runId, status: 'paused' };
  }

  /**
   * 原地恢复被暂停的 run（TUI 面）：解冻墙钟按剩余量续跑、放行挂起的新调用。
   * 非 paused（含续跑 resumeFromRunId 那条）不改状态——"paused-resume" 只服务暂停过的 run。
   */
  async resume(runId: string, ownerCandidates: readonly string[]): Promise<{ runId: string; status: WorkflowStatus }> {
    const context = this.activeOwnedContext(runId, ownerCandidates, 'resume');
    if (isTerminal(context.index.status)) return { runId, status: context.index.status };
    if (!context.paused) return { runId, status: context.index.status };
    const actor = ownerCandidates[0] ?? context.index.ownerSessionId;
    context.paused = false;
    context.pauseHold?.release();
    context.pauseHold = undefined;
    this.armGate(context);
    context.index = { ...context.index, status: 'running' };
    await this.persistStatus(context, 'running');
    this.deps.audit?.({ runId, action: 'workflow_paused_resume', actor, status: 'running', at: this.clock.iso() });
    this.events.emit({ runId, type: 'run_resumed', at: this.clock.iso(), data: { actor, gateRemainingMs: context.gateRemainingMs } });
    return { runId, status: 'running' };
  }

  /** pause / resume 共同的取上下文 + 归属闸：不在本进程 = NOT_FOUND（暂停/恢复只作用于活着的本地 run）。 */
  private activeOwnedContext(runId: string, ownerCandidates: readonly string[], op: 'pause' | 'resume'): RunContext {
    if (!isRunId(runId)) throw new WorkflowStartError('NOT_FOUND', 'run-not-found', `Workflow run not found: ${runId}.`);
    const context = this.runs.get(runId);
    if (!context) throw new WorkflowStartError('NOT_FOUND', 'run-not-found', `Workflow run ${runId} is not running in this process, so it cannot be ${op === 'pause' ? 'paused' : 'resumed'}.`);
    if (!this.ownsRun(context.index.ownerSessionId, ownerCandidates)) {
      throw new WorkflowStartError('FORBIDDEN', 'run-not-owned', `Workflow run ${runId} belongs to another session.`);
    }
    return context;
  }

  /**
   * 运行态 status 落盘——读侧契约（wait_for_path 冻结、查询面）都认这里的 index.status。
   * 必须走 context.indexWrites 那条串行列：否则在飞的 dispatch 索引写（status=running）可能在
   * 暂停写之后才 rename 落地，把 paused 抹回 running——正是要保护的那个冻结信号就丢了。
   * 调用方须已把新 status 写进 context.index。
   */
  private async persistStatus(context: RunContext, status: WorkflowStatus): Promise<void> {
    queueIndexWrite(context);
    await context.indexWrites;
    await upsertRegistry(this.paths.registryFile, {
      runId: context.runId,
      status,
      ownerSessionId: context.index.ownerSessionId,
      startedAt: context.index.startedAt,
    });
  }

  private assertOpen(context: RunContext): void {
    if (context.open) return;
    const termination = context.termination;
    throw runLevelError(termination?.reason ?? 'cancelled', termination?.message ?? 'The run is no longer accepting work.');
  }

  /** 两级软检查的第一级（入口）；第二级在取槽时。cap 为 null = 不限制开关已开。 */
  private assertBudget(context: RunContext): void {
    const cap = this.gates.tokenCap;
    if (cap === null) return;
    if (context.spent < cap) return;
    const error = new WorkflowBudgetExceededError(context.runId, context.spent, cap);
    this.terminate(context, 'token-budget', error.message);
    throw error;
  }

  /** 结算唯一出口：一切终态路径都收敛到这里，终态标记最后写且独占创建。 */
  private async settle(context: RunContext, status: WorkflowStatus, reason: TerminalReason): Promise<RunIndex> {
    if (context.settled) return context.index;
    context.settled = true;
    if (context.gateHandle) this.clock.clearTimeout(context.gateHandle);
    const endedAt = this.clock.iso();
    context.index = { ...context.index, status, reason, endedAt, tokens: { spent: context.spent } };
    await context.journal.drain();
    // 在飞的索引写先落干：终态那一版必须是最后一版。
    await context.indexWrites;
    await writeIndex(context.run.indexFile, context.index);
    await writeSnapshot(context.run.snapshotFile, context.index);
    // 第一帧：快照已落、标记未落——认领趟要认出这个放大帧。
    this.crash('after-snapshot');
    // 结算序（T10 钉住）：快照 → outbox 原子写 → 终态标记最后写。
    // 通知先于标记落盘，是为了让"标记后的任何帧"都可被排空趟补投——反序会造出
    // "有标记、无 outbox 项"的帧，两趟判据都够不着，通知就真丢了。
    const notice = await this.writeSettledNotice(context, endedAt);
    const markerWritten = await createExclusive(context.run.terminalFile, JSON.stringify({ schemaVersion: SCHEMA_VERSION, runId: context.runId, status, reason, endedAt }) + '\n');
    // 第二帧：唯一线性化点已落地，注册表尚未推进。
    this.crash('after-terminal');
    await upsertRegistry(this.paths.registryFile, {
      runId: context.runId,
      status,
      ownerSessionId: context.index.ownerSessionId,
      startedAt: context.index.startedAt,
      endedAt,
    });
    this.deps.audit?.({ runId: context.runId, action: 'workflow_settle', actor: context.index.ownerSessionId, status, reason, at: endedAt });
    this.events.emit({ runId: context.runId, type: 'run_settled', at: endedAt, data: { status, reason, markerWritten } });
    // 第三帧：盘面齐、通知未投递——outbox 排空趟要能补发。
    await this.deliverSettledNotice(context, notice);
    // 终态即让位：续跑取到的排他锁在此释放；崩溃留下的锁文件（进程已死）由下次 resume 依 pid+epoch 接管。
    if (context.lock) await releaseResumeLock(context.run.lockFile, context.lock).catch(() => undefined);
    // 可选自动归档（默认关）的触发位：结算之后、绝不影响终态。开着且确有超期保留项时才动 git，
    // 关着时这是一条空转；任何故障都只留审计痕，不改判、不阻塞结算（§12 执行者节律：结算路径实时那一档）。
    if (this.gates.autoArchive) void this.archiveWorktreesDue().catch(() => undefined);
    return context.index;
  }

  /**
   * 终态三件套的第三件（上半）：≤200 码元的 settled-notice 原子写进 outbox。
   * 落盘段的任何故障只记账、不改判终态（结算即将封口，通知不是关键路径）。
   */
  private async writeSettledNotice(context: RunContext, at: string): Promise<OutboxItem | undefined> {
    try {
      const sha256 = await sha256File(context.run.snapshotFile);
      const notice = buildSettledNotice({
        runId: context.runId,
        status: context.index.status,
        sha256,
        indexPath: context.run.indexFile,
        succeeded: context.index.dispatches.filter((record) => record.status === 'completed').length,
        total: context.index.dispatches.length,
      });
      if (!notice.ok) {
        this.deps.audit?.({ runId: context.runId, action: 'workflow_settle', actor: context.index.ownerSessionId, status: context.index.status, reason: 'notice-too-long', at, detail: notice.message });
        return undefined;
      }
      return (await putNotice(context.run, {
        kind: 'settled-notice',
        runId: context.runId,
        sha256,
        status: context.index.status,
        index: context.run.indexFile,
        body: notice.body,
        at,
      })).item;
    } catch (error) {
      const detail = error && typeof error === 'object' && typeof (error as Error).message === 'string' ? (error as Error).message : String(error);
      this.deps.audit?.({ runId: context.runId, action: 'workflow_settle', actor: context.index.ownerSessionId, status: context.index.status, reason: 'notice-failed', at, detail });
      return undefined;
    }
  }

  /**
   * 终态三件套的第三件（下半）：试投一次，投成功才标 delivered——至少一次投递，
   * 去重靠内容键 (runId, sha256)。崩溃注入点刻意留在 try 之外：注入必须真能终止这一帧，
   * 否则"已落盘、未投递"永远演不出来，排空趟也就无从验证。
   */
  private async deliverSettledNotice(context: RunContext, item: OutboxItem | undefined): Promise<void> {
    if (!item || item.delivered) return;
    this.crash('before-notice');
    const deliver = this.deps.deliverNotice;
    if (!deliver) return;
    const sent = await Promise.resolve(deliver({ runId: context.runId, ownerSessionId: context.index.ownerSessionId, body: item.body, sha256: item.sha256 })).catch(() => false);
    if (sent) await markNoticeDelivered(context.run, item, this.clock.iso()).catch(() => undefined);
  }

  /** 终态判定（供查询面使用）：终态一律正向枚举。 */
  static isTerminal(status: WorkflowStatus): boolean {
    return isTerminal(status);
  }
}

/**
 * run 级终结的终态：取消坍缩到 cancelled，其余（墙钟 / 预算 / cap / 嵌套）都是 failed。
 * 三态之外不设第四态——汇总体据 status 报 cancelled partial，据 reason 报具体击穿。
 */
function statusForTermination(reason: RunTerminationReason | string): WorkflowStatus {
  return reason === 'cancelled' ? 'cancelled' : 'failed';
}

/** 排一次索引写：入队顺序即落盘顺序，最后落盘的必是最新版。 */
function queueIndexWrite(context: RunContext): void {
  context.indexWrites = context.indexWrites.then(() => writeIndex(context.run.indexFile, context.index)).catch(() => undefined);
}

/** schema 模式下的出口：该路必须交回一个 JSON 对象，否则按缺结构化输出判败。 */
function parseStructured(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!text || !text.trim()) return { ok: false, message: 'The agent produced no structured submission.' };
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, message: 'The structured submission is not a JSON object.' };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: `The structured submission is not valid JSON: ${(error as Error).message}` };
  }
}
