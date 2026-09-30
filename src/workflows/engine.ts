import { Clock, systemClock } from './clock.js';
import { dispatchId, newRunId } from './ids.js';
import { Journal } from './journal.js';
import { scanDeterminism } from './lint.js';
import { loadScript, persistScript, SCRIPT_NAME_PATTERN } from './saved.js';
import { agentFile, managedRootFor, runPaths, workflowPaths, type RunPaths, type WorkflowPaths } from './paths.js';
import { readIndex, writeIndex } from './run-index.js';
import { upsertRegistry } from './registry.js';
import { runInSandbox, type SandboxHost } from './sandbox.js';
import { isTerminal, SCHEMA_VERSION, type DispatchRecord, type FailureEntry, type RunIndex, type TerminalReason, type WorkflowStatus } from './schema.js';
import { writeSnapshot } from './snapshot.js';
import { ensureDir, createExclusive, exists, writeJsonAtomic } from './atomic.js';
import { WorkflowEvents } from './events.js';
import { resolveCrashPlan, type CrashPlan, type CrashPoint } from './crash.js';
import { createDispatchWindow, HARD_CONCURRENCY_CEILING, type DispatchWindow } from './scheduler.js';
import { DEFAULT_GATES, HARD_AGENT_CAP_CEILING, describeClockNesting, validateClockNesting, type WorkflowGates } from './gates.js';
import { canonicalAgentOpts, gateAgentOpts, type GatedAgentOpts } from './agent-opts.js';
import { argsChainSeed, deriveAgentKey } from './keys.js';
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
import { resolveToolFace, type ToolContext, type ToolMode } from './tool-face.js';
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

export type WorkflowAuditEntry = {
  runId: string;
  action: 'workflow_start' | 'workflow_settle';
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
  /** 终态通知缝：回传管线接线前为空实现，结算纪律不受影响。 */
  notifier?: (settled: { runId: string; status: WorkflowStatus; reason?: TerminalReason; indexPath: string }) => void;
  /** 结算阶段故障注入缝：抛出即视为本进程在此终止（见 crash.ts 的三帧）。 */
  crash?: (point: CrashPoint) => void;
  /** env 路线（真 SIGKILL）的取值来源；缺省读本进程环境。 */
  crashEnv?: Record<string, string | undefined>;
  /** 动手动作本身，测试里注入它就能断"命中了几次"而不必真杀进程。 */
  crashKill?: (pid: number, signal: 'SIGKILL') => void;
};

export type StartRequest = {
  script?: string;
  scriptPath?: string;
  resumeFromRunId?: string;
  args?: unknown;
  ownerSessionId: string;
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
};

/** 墙钟到期的内部信号：只用于把 race 拉出执行段，不对外暴露。 */
class RunGateReached extends Error {
  constructor() {
    super('The run reached its wall-clock gate.');
    this.name = 'RunGateReached';
  }
}

export class WorkflowEngine {
  private readonly clock: Clock;
  private readonly paths: WorkflowPaths;
  private readonly gates: WorkflowGates;
  private readonly events: WorkflowEvents;
  private readonly factory: AdapterFactory | undefined;
  private readonly windowSize: number;
  private readonly crash: CrashPlan;
  private readonly runs = new Map<string, RunContext>();

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
    if (request.resumeFromRunId) {
      previous = await readIndex(run.indexFile);
      if (!previous) throw new WorkflowStartError('NOT_FOUND', 'run-not-found', `Workflow run not found: ${request.resumeFromRunId}.`);
      if (previous.ownerSessionId !== request.ownerSessionId) throw new WorkflowStartError('FORBIDDEN', 'run-not-owned', `Workflow run ${runId} belongs to another session.`);
      if (previous.sourceRef.id !== script.sourceRef.id) throw new WorkflowStartError('VALIDATION', 'source-mismatch', `Resuming a run requires the same script reference (${previous.sourceRef.id}); got ${script.sourceRef.id}.`);
      if (await exists(run.terminalFile)) throw new WorkflowStartError('VALIDATION', 'run-already-terminal', `Workflow run ${runId} already settled as ${previous.status}; reopening a terminal run is not allowed.`);
      // 账本卫生：截断至最长良前缀，丢弃段显式记账（不静默丢）。
      const report = await this.journalFor(run).truncateToGoodPrefix();
      journalDropped = report.dropped;
    }

    await ensureDir(run.dir);
    await ensureDir(run.agentsDir);
    await ensureDir(run.outboxDir);

    const journal = this.journalFor(run);
    const startedAt = this.clock.iso();
    const index: RunIndex = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      status: 'running',
      ownerSessionId: request.ownerSessionId,
      scriptPath: script.path,
      sourceRef: script.sourceRef,
      argsRecorded: request.args !== undefined,
      ...(request.args !== undefined ? { args: request.args } : {}),
      startedAt: previous?.startedAt ?? startedAt,
      dispatches: previous?.dispatches ?? [],
      failures: previous?.failures ?? [],
      tokens: { spent: previous?.tokens.spent ?? 0 },
    };
    await writeIndex(run.indexFile, index);
    await upsertRegistry(this.paths.registryFile, { runId, status: 'running', ownerSessionId: request.ownerSessionId, startedAt: index.startedAt });

    const sequence = index.dispatches.length;
    journal.prime(sequence + 1);
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
      chainPrefix: lastChainKey(index) ?? argsChainSeed(index.args),
      agentCount: sequence,
    };
    this.runs.set(runId, context);

    if (!request.resumeFromRunId) await journal.append({ type: 'launched', runId, at: startedAt });
    this.deps.audit?.({ runId, action: 'workflow_start', actor: request.ownerSessionId, status: 'running', at: startedAt });
    this.events.emit({ runId, type: 'run_started', at: startedAt, data: { scriptPath: script.path, resumed: Boolean(request.resumeFromRunId), concurrencyWindow: this.windowLimit } });

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

  private journalFor(run: RunPaths): Journal {
    return Journal.open(run.journalFile);
  }

  private async execute(context: RunContext, source: string): Promise<RunIndex> {
    // 墙钟与脚本赛跑：墙钟先到即中止在飞的路并结算，脚本先到按结果结算。
    // 计时与中止都走注入时钟与本 run 的 controller，不接受系统定时器。
    const gate = new Promise<never>((_resolve, reject) => {
      context.gateHandle = this.clock.setTimeout(() => {
        this.terminate(context, 'run-gate', 'The run reached its wall-clock gate.');
        reject(new RunGateReached());
      }, this.gates.runGateMs);
    });

    try {
      const outcome = await Promise.race([runInSandbox({ source, args: context.index.args, timeoutMs: 30_000, host: this.hostFor(context, false) }), gate]);
      if (context.termination) {
        await this.settle(context, 'failed', context.termination.reason);
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
        await this.settle(context, 'failed', context.termination.reason);
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

    // 工具面在派发之前算完：这一跑能用哪些工具、模式合不合闸，全在烧 token 前定死。
    // 不合面即形状错（脚本写错了，不是那一跑失败），且不消耗缓存键。
    // 模式口径：命令闸与写工具的可见性跟着**边界**走，而边界要等隔离交付（#231）才独立出去；
    // 本票所有路都跑在共享工作区里，所以一律按只读执法——写必隔离不因声明而提前放开。
    // 声明了 isolation:'worktree' 的那一路仍拿到"回报 path + branch"的义务（提示词面），
    // 因为那是它对人的交代，不是权限。
    const gatedMode: ToolMode = 'read-only';
    const face = resolveToolFace({
      mode: gatedMode,
      tools: gated.tools,
      disallowedTools: gated.disallowedTools,
      agentType: gated.agentType,
      schema: gated.schema !== undefined,
    });
    if (face.refusal) throw new AgentCallShapeError(`${face.refusal.message} (reason: ${face.refusal.reason})`);
    const toolNames = face.names;

    // 键先滚动，再过预算门与计数（ADR §17 顺序契约）：链是"调用序列"的函数，
    // 不能因为某一次被闸门拒掉就不计位——否则同一脚本在不同闸下会派生出不同的链。
    const sequence = ++context.seq;
    const key = deriveAgentKey(context.chainPrefix, prompt, canonicalAgentOpts(gated));
    context.chainPrefix = key;

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

    try {
      return await this.runPath(context, record, prompt, gated, toolNames, gatedMode);
    } catch (error) {
      // run 级终结把排队与在飞的等待打断：那不是这一路自己失败，
      // 绝不许在批里被降成 null（那会让非法扇出静默"完成"）。
      if (!context.open) throw runLevelError(context.termination?.reason ?? 'cancelled', context.termination?.message ?? 'The run is no longer accepting work.');
      throw error;
    }
  }

  /** 叶子任务才进窗口：排队不占键位，取槽时再过一次预算门。 */
  private runPath(context: RunContext, record: DispatchRecord, prompt: string, gated: GatedAgentOpts, toolNames: readonly string[], mode: ToolMode): Promise<unknown> {
    return context.window.run(async () => {
      this.assertOpen(context);
      this.assertBudget(context);
      const factory = this.factory;
      if (!factory) {
        return await this.settlePath(context, record, { ok: false, failure: { kind: 'error', message: 'No model adapter is wired for this run.', reason: 'no-adapter' } });
      }
      // 每路独立实例：缓存断点是实例态，共享实例会让一路撞到的 4xx 关掉全部并发路的断点。
      // 把本引擎的注入时钟交给工厂：传输层瞬态 backoff 与 stall 看门狗共用一只钟（§16）。
      const adapter = factory({ runId: context.runId, dispatchId: record.id, clock: this.clock });
      const stallMs = resolveStallMs(gated.stallMs, this.gates.stallMs);
      // 重试次数随每次尝试起跑即时落到 record（成功或耗尽判败都进该路终态记账）。
      const reportAttempt = (n: number): void => { record.attempts = n; };
      const run = runPaths(this.paths, context.runId);
      const cwd = this.deps.workspaceDir;
      const system = buildAgentSystemPrompt({
        label: record.label,
        cwd,
        platform: process.platform,
        toolNames,
        mode,
        isolated: gated.isolation === 'worktree',
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
        return await this.settlePath(context, record, { ok: false, failure: classifyAdapterError(error) });
      }
      context.spent += result.outputTokens;
      if (gated.schema) {
        // 结构化出口优先：经 structured_output 交回的对象就是该路结果。
        if (result.hasStructured) {
          return await this.settlePath(context, record, { ok: true, value: result.structured, outputTokens: result.outputTokens });
        }
        const structured = parseStructured(result.text);
        if (!structured.ok) {
          return await this.settlePath(context, record, { ok: false, failure: { kind: 'no_structured_output', message: structured.message } });
        }
        return await this.settlePath(context, record, { ok: true, value: structured.value, outputTokens: result.outputTokens });
      }
      if (!result.text || !result.text.trim()) {
        return await this.settlePath(context, record, { ok: false, failure: silenceFailure('this agent') });
      }
      return await this.settlePath(context, record, { ok: true, value: result.text, outputTokens: result.outputTokens });
    });
  }

  /**
   * 一路的结算唯一出口：写每路文件 → 写索引（按 admission 位归位）→ 具名记账 →
   * 归位序进账本 → 发事件。失败即返回 null（脚本槽位与裸 await 同值），成功即返回该路值。
   */
  private async settlePath(
    context: RunContext,
    record: DispatchRecord,
    outcome: { ok: true; value: unknown; outputTokens: number } | { ok: false; failure: SettledFailure },
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
    // 标记最后写：所有产物齐备后才宣告终态；已存在则静默退让（后到者不补发、不判更新版）。
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
    this.crash('before-notice');
    this.deps.notifier?.({ runId: context.runId, status, reason, indexPath: context.run.indexFile });
    return context.index;
  }

  /** 终态判定（供查询面使用）：终态一律正向枚举。 */
  static isTerminal(status: WorkflowStatus): boolean {
    return isTerminal(status);
  }
}

/** 续跑接链：从最后一条已 admission 的键接着滚，缺键的老产物退回 args 种子。 */
function lastChainKey(index: RunIndex): string | undefined {
  for (let i = index.dispatches.length - 1; i >= 0; i--) {
    const key = index.dispatches[i].key;
    if (typeof key === 'string' && key) return key;
  }
  return undefined;
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
