import { Clock, systemClock } from './clock.js';
import { dispatchId, newRunId } from './ids.js';
import { Journal } from './journal.js';
import { scanDeterminism } from './lint.js';
import { loadScript, persistScript } from './saved.js';
import { agentFile, managedRootFor, runPaths, workflowPaths, type RunPaths, type WorkflowPaths } from './paths.js';
import { readIndex, writeIndex } from './run-index.js';
import { upsertRegistry } from './registry.js';
import { runInSandbox } from './sandbox.js';
import { isTerminal, SCHEMA_VERSION, type DispatchRecord, type RunIndex, type TerminalReason, type WorkflowStatus } from './schema.js';
import { writeSnapshot } from './snapshot.js';
import { ensureDir, createExclusive, exists, writeJsonAtomic } from './atomic.js';
import { WorkflowEvents } from './events.js';
import type { AdapterFactory } from './adapter.js';

/**
 * run 生命周期：建 run → 跑脚本（每路一个独立 adapter 实例）→ 结算。
 *
 * 结算只有一处（settle），且终态标记最后写、独占创建——后到者读到已有标记即退让。
 * 一切时间经注入时钟，一切模型调用经注入工厂，state 根可整体重定向。
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
};

export const DEFAULT_THRESHOLDS: EngineThresholds = {
  runGateMs: 30 * 60 * 1000,
  stallMs: 180_000,
  waitMs: 600_000,
  tokenCap: 8_000_000,
};

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
  /** 整 run 的中止信号：墙钟到期即 abort，在飞的路随之中止（燃烧停止）。 */
  controller: AbortController;
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
  private readonly runs = new Map<string, RunContext>();

  constructor(private readonly deps: EngineDeps) {
    this.clock = deps.clock ?? systemClock();
    this.paths = workflowPaths(deps.managedRoot ?? managedRootFor(deps.workspaceDir));
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(deps.thresholds ?? {}) };
    this.events = deps.events ?? new WorkflowEvents();
    this.factory = deps.adapterFactory;
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
      tokens: { spent: previous?.tokens.spent ?? 0 },
    };
    await writeIndex(run.indexFile, index);
    await upsertRegistry(this.paths.registryFile, { runId, status: 'running', ownerSessionId: request.ownerSessionId, startedAt: index.startedAt });

    const context: RunContext = {
      runId,
      run,
      journal,
      index,
      seq: index.dispatches.length,
      spent: index.tokens.spent,
      settled: false,
      controller: new AbortController(),
    };
    this.runs.set(runId, context);

    if (!request.resumeFromRunId) await journal.append({ type: 'launched', runId, at: startedAt });
    this.deps.audit?.({ runId, action: 'workflow_start', actor: request.ownerSessionId, status: 'running', at: startedAt });
    this.events.emit({ runId, type: 'run_started', at: startedAt, data: { scriptPath: script.path, resumed: Boolean(request.resumeFromRunId) } });

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
        context.controller.abort();
        reject(new RunGateReached());
      }, this.thresholds.runGateMs);
    });

    try {
      const outcome = await Promise.race([
        runInSandbox({
          source,
          args: context.index.args,
          timeoutMs: 30_000,
          host: {
            agent: async (prompt, opts) => await this.dispatch(context, prompt, opts),
          },
        }),
        gate,
      ]);
      if (!outcome.ok) {
        await this.settle(context, 'failed', outcome.kind === 'timeout' ? 'run-gate' : 'script-failed');
        return context.index;
      }
      await this.settle(context, 'completed', 'completed');
      return context.index;
    } catch (error) {
      const reason = error instanceof RunGateReached ? 'run-gate' : 'script-failed';
      await this.settle(context, 'failed', reason);
      return context.index;
    } finally {
      if (context.gateHandle) this.clock.clearTimeout(context.gateHandle);
    }
  }

  /** 一路 agent：独立 adapter 实例、独立槽位、独立账。 */
  private async dispatch(context: RunContext, prompt: string, opts?: Record<string, unknown>): Promise<unknown> {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new Error('agent() requires a non-empty prompt.');
    const sequence = context.seq + 1;
    context.seq = sequence;
    const slot = dispatchId(sequence);
    const label = typeof opts?.label === 'string' && opts.label.trim() ? opts.label : `agent-${sequence}`;
    const startedAt = this.clock.iso();
    const record: DispatchRecord = { id: slot, label, status: 'running', attempts: 1, startedAt, outputTokens: 0 };
    context.index.dispatches = [...context.index.dispatches, record];
    await writeIndex(context.run.indexFile, context.index);
    await context.journal.append({ type: 'started', seq: sequence, label, at: startedAt });

    const factory = this.factory;
    if (!factory) {
      const error = { kind: 'no-adapter', message: 'No model adapter is wired for this run.' };
      return await this.finishDispatch(context, record, { ok: false as const, error });
    }
    try {
      const adapter = factory({ runId: context.runId, dispatchId: slot });
      const result = await adapter.complete({
        system: typeof opts?.system === 'string' ? opts.system : '',
        prompt,
        maxTokens: typeof opts?.maxTokens === 'number' ? opts.maxTokens : 32_000,
        ...(typeof opts?.model === 'string' ? { model: opts.model } : {}),
        signal: context.controller.signal,
      });
      context.spent += result.outputTokens;
      return await this.finishDispatch(context, record, { ok: true as const, text: result.text, outputTokens: result.outputTokens });
    } catch (error) {
      const kind = (error as { name?: string }).name === 'AbortError' ? 'aborted' : 'error';
      return await this.finishDispatch(context, record, { ok: false as const, error: { kind, message: (error as Error).message } });
    }
  }

  private async finishDispatch(
    context: RunContext,
    record: DispatchRecord,
    outcome: { ok: true; text: string; outputTokens: number } | { ok: false; error: { kind: string; message: string } },
  ): Promise<unknown> {
    const endedAt = this.clock.iso();
    const next: DispatchRecord = outcome.ok
      ? { ...record, status: 'completed', endedAt, outputTokens: outcome.outputTokens }
      : { ...record, status: 'failed', endedAt, error: outcome.error };
    context.index.dispatches = context.index.dispatches.map((item) => (item.id === record.id ? next : item));
    context.index.tokens = { spent: context.spent };
    await writeJsonAtomic(agentFile(context.run, record.id), { schemaVersion: SCHEMA_VERSION, ...next, ...(outcome.ok ? { result: outcome.text } : {}) });
    await writeIndex(context.run.indexFile, context.index);
    await context.journal.append(
      outcome.ok
        ? { type: 'result', seq: Number(record.id.slice(1)), value: outcome.text, at: endedAt }
        : { type: 'failed', seq: Number(record.id.slice(1)), error: outcome.error, at: endedAt },
    );
    this.events.emit({ runId: context.runId, type: 'dispatch_settled', at: endedAt, data: { dispatchId: record.id, status: next.status } });
    // 该路自身失败 = null（脚本侧与批量槽位同值），run 继续。
    return outcome.ok ? outcome.text : null;
  }

  /** 结算唯一出口：一切终态路径都收敛到这里，终态标记最后写且独占创建。 */
  private async settle(context: RunContext, status: WorkflowStatus, reason: TerminalReason): Promise<RunIndex> {
    if (context.settled) return context.index;
    context.settled = true;
    if (context.gateHandle) this.clock.clearTimeout(context.gateHandle);
    const endedAt = this.clock.iso();
    context.index = { ...context.index, status, reason, endedAt, tokens: { spent: context.spent } };
    await context.journal.drain();
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
