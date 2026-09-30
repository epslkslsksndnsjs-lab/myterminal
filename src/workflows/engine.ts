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
import { createDispatchWindow, defaultConcurrencyWindow, type DispatchWindow } from './scheduler.js';
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
import { AGENT_SYSTEM_PROMPT, type AdapterFactory } from './adapter.js';

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

export type EngineThresholds = {
  /** run 总闸（墙钟）。 */
  runGateMs: number;
  /** 单路无进展判定窗。 */
  stallMs: number;
  /** 等待原语单次阻塞上限。 */
  waitMs: number;
  /** 单 run 输出 token 硬顶。 */
  tokenCap: number;
  /** 单 run 的 agent() 调用数硬顶。 */
  agentCap: number;
};

export const DEFAULT_THRESHOLDS: EngineThresholds = {
  runGateMs: 30 * 60 * 1000,
  stallMs: 180_000,
  waitMs: 600_000,
  tokenCap: 8_000_000,
  agentCap: 1000,
};

/** 单路一次调用的输出上限（本票不表达为脚本可传的旋钮）。 */
export const DEFAULT_OUTPUT_TOKENS = 32_000;

export type WorkflowAuditEntry = {
  runId: string;
  action: 'workflow_start' | 'workflow_settle';
  actor: string;
  status: string;
  reason?: string;
  at: string;
};

export type EngineDeps = {
  workspaceDir: string;
  /** state 根可重定向（测试整棵树搬进临时目录）。 */
  managedRoot?: string;
  clock?: Clock;
  adapterFactory?: AdapterFactory;
  events?: WorkflowEvents;
  audit?: (entry: WorkflowAuditEntry) => void;
  thresholds?: Partial<EngineThresholds>;
  /** 并发窗口：默认按核数公式；注入即所断言的窗口（闸门的设置面属 T3）。 */
  concurrencyWindow?: number;
  /** 终态通知缝：回传管线接线前为空实现，结算纪律不受影响。 */
  notifier?: (settled: { runId: string; status: WorkflowStatus; reason?: TerminalReason; indexPath: string }) => void;
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
  private readonly thresholds: EngineThresholds;
  private readonly events: WorkflowEvents;
  private readonly factory: AdapterFactory | undefined;
  private readonly windowSize: number;
  private readonly runs = new Map<string, RunContext>();

  constructor(private readonly deps: EngineDeps) {
    this.clock = deps.clock ?? systemClock();
    this.paths = workflowPaths(deps.managedRoot ?? managedRootFor(deps.workspaceDir));
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(deps.thresholds ?? {}) };
    this.events = deps.events ?? new WorkflowEvents();
    this.factory = deps.adapterFactory;
    const requested = deps.concurrencyWindow ?? defaultConcurrencyWindow();
    this.windowSize = Math.max(1, Math.floor(requested));
  }

  /** 本引擎的并发窗口大小（观测面：滚动补位的上限水位）。 */
  get windowLimit(): number {
    return this.windowSize;
  }

  /** 启动一条 run：做完所有"烧 token 前"的校验，立即返回，余下在后台跑。 */
  async start(request: StartRequest): Promise<StartResult> {
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
      chainPrefix: argsChainSeed(index.args),
      agentCount: sequence,
    };
    this.runs.set(runId, context);

    if (!request.resumeFromRunId) await journal.append({ type: 'launched', runId, at: startedAt });
    this.deps.audit?.({ runId, action: 'workflow_start', actor: request.ownerSessionId, status: 'running', at: startedAt });
    this.events.emit({ runId, type: 'run_started', at: startedAt, data: { scriptPath: script.path, resumed: Boolean(request.resumeFromRunId), concurrencyWindow: this.windowLimit } });

    const completion = this.execute(context, script.content);
    context.completion = completion;
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
      }, this.thresholds.runGateMs);
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
        total: this.thresholds.tokenCap,
        spent: () => context.spent,
        remaining: () => Math.max(0, this.thresholds.tokenCap - context.spent),
      },
    };
    if (!nested) host.workflow = async (ref, args, opts) => await this.runNested(context, ref, args, opts);
    return host;
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

    // 预算入口门（软检查）先于计数：超限即 run 级终结，多烧的那点由取槽二检兜。
    this.assertBudget(context);
    context.agentCount += 1;
    if (context.agentCount > this.thresholds.agentCap) {
      const error = new WorkflowAgentCapExceededError(this.thresholds.agentCap);
      this.terminate(context, 'agent-cap', error.message);
      throw error;
    }

    const sequence = ++context.seq;
    const key = deriveAgentKey(context.chainPrefix, prompt, canonicalAgentOpts(gated));
    context.chainPrefix = key;

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

    return await this.runPath(context, record, prompt, gated);
  }

  /** 叶子任务才进窗口：排队不占键位，取槽时再过一次预算门。 */
  private runPath(context: RunContext, record: DispatchRecord, prompt: string, gated: GatedAgentOpts): Promise<unknown> {
    return context.window.run(async () => {
      this.assertOpen(context);
      this.assertBudget(context);
      const factory = this.factory;
      if (!factory) {
        return await this.settlePath(context, record, { ok: false, failure: { kind: 'error', message: 'No model adapter is wired for this run.', reason: 'no-adapter' } });
      }
      // 每路独立实例：缓存断点是实例态，共享实例会让一路撞到的 4xx 关掉全部并发路的断点。
      const adapter = factory({ runId: context.runId, dispatchId: record.id });
      let result;
      try {
        result = await adapter.complete({
          system: AGENT_SYSTEM_PROMPT,
          prompt,
          maxTokens: DEFAULT_OUTPUT_TOKENS,
          ...(gated.model ? { model: gated.model } : {}),
          signal: context.controller.signal,
        });
      } catch (error) {
        if (isRunLevelError(error)) throw error;
        return await this.settlePath(context, record, { ok: false, failure: classifyAdapterError(error) });
      }
      context.spent += result.outputTokens;
      if (gated.schema) {
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
  }

  private assertOpen(context: RunContext): void {
    if (context.open) return;
    const termination = context.termination;
    throw runLevelError(termination?.reason ?? 'cancelled', termination?.message ?? 'The run is no longer accepting work.');
  }

  /** 两级软检查的第一级（入口）；第二级在取槽时。 */
  private assertBudget(context: RunContext): void {
    const cap = this.thresholds.tokenCap;
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
    // 标记最后写：所有产物齐备后才宣告终态；已存在则静默退让（后到者不补发、不判更新版）。
    const markerWritten = await createExclusive(context.run.terminalFile, JSON.stringify({ schemaVersion: SCHEMA_VERSION, runId: context.runId, status, reason, endedAt }) + '\n');
    await upsertRegistry(this.paths.registryFile, {
      runId: context.runId,
      status,
      ownerSessionId: context.index.ownerSessionId,
      startedAt: context.index.startedAt,
      endedAt,
    });
    this.deps.audit?.({ runId: context.runId, action: 'workflow_settle', actor: context.index.ownerSessionId, status, reason, at: endedAt });
    this.events.emit({ runId: context.runId, type: 'run_settled', at: endedAt, data: { status, reason, markerWritten } });
    this.deps.notifier?.({ runId: context.runId, status, reason, indexPath: context.run.indexFile });
    return context.index;
  }

  /** 终态判定（供查询面使用）：终态一律正向枚举。 */
  static isTerminal(status: WorkflowStatus): boolean {
    return isTerminal(status);
  }
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
