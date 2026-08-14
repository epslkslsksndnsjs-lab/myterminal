import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { MyTerminalConfig } from './types.js';
import { MyTerminalError, type MyTerminalStore } from './store.js';
import { renderTemplate, resolveWorkspacePath, validateJsonSchema } from './security.js';
import { listSkills } from './skills.js';
import { runCommand } from './core-tools.js';
import { TASK_POLL_TOOL } from './tool-schemas.js';
import type { CustomExtensionSpec, InvocationContext, JsonObject, SessionIdentity, ToolAuditEvent, ToolDefinition, ToolResponse } from './types.js';
import { continuationPolicy, HARNESS_CONTRACT_REVISION, harnessContract, harnessRequirement } from './continuation.js';
import { clearOperationCache, seedOperationCache, shapeToolResponse, type ShapingAudit, type ShapingAuditRecord } from './tool-parse.js';
import { clearL3Quota } from './l3/engine.js';

const EXTENSION_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const RESERVED_NAMES = new Set(['extension_discover', 'extension_register', 'extension_call']);
const CONTROL_TOOLS = new Set(['session_checkpoint', 'session_release', 'session_unregister', 'session_events_ack', 'session_inherit', 'task_poll', 'subagent_start', 'subagent_status', 'subagent_abort']);
const FAST_RETURN_MS = 200;
const BACKGROUND_TASK_RETENTION_MS = 30 * 60_000;
const BACKGROUND_TASK_MAX_COUNT = 100;
const BACKGROUND_TASK_MAX_BYTES = 24 * 1024 * 1024;

function loadAgentMd(settingsPath: string): string | undefined {
  try {
    const file = path.join(path.dirname(settingsPath), 'AGENT.md');
    if (!existsSync(file)) return undefined;
    const content = readFileSync(file, 'utf8').trim();
    return content || undefined;
  } catch { return undefined; }
}

type BackgroundTask = {
  id: string;
  sessionId: string;
  tool: string;
  input: JsonObject;
  source: InvocationContext['transport'];
  startedAt: number;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  completedAt?: string;
  response?: ToolResponse;
};

type ResultProblem = { code: string; message: string; retryable: boolean };

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MyTerminalError('INVALID_INPUT', `${label} must be an object.`);
  return value as JsonObject;
}

function jsonObjectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== 'string') return objectValue(value, label);
  try { return objectValue(JSON.parse(value), label); }
  catch (error) { if (error instanceof SyntaxError) throw new MyTerminalError('INVALID_INPUT', `${label} must contain a valid JSON object.`); throw error; }
}

function callArguments(input: JsonObject): JsonObject {
  const legacy = input.arguments === undefined ? {} : jsonObjectValue(input.arguments, 'arguments');
  const fallback = input.inputJson === undefined ? {} : jsonObjectValue(input.inputJson, 'inputJson');
  const preferred = input.input === undefined ? {} : jsonObjectValue(input.input, 'input');
  return { ...legacy, ...fallback, ...preferred };
}

function validateSpec(value: unknown, builtins: Map<string, ToolDefinition>): CustomExtensionSpec {
  const spec = objectValue(value, 'spec') as unknown as CustomExtensionSpec;
  if (typeof spec.name !== 'string' || !EXTENSION_NAME.test(spec.name) || RESERVED_NAMES.has(spec.name)) throw new MyTerminalError('INVALID_INPUT', 'Extension name must match [a-z][a-z0-9_]{2,63} and cannot use a facade name.');
  if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 100) throw new MyTerminalError('INVALID_INPUT', 'Extension title must contain 1-100 characters.');
  if (typeof spec.description !== 'string' || spec.description.length < 10 || spec.description.length > 800) throw new MyTerminalError('INVALID_INPUT', 'Extension description must contain 10-800 characters.');
  if (!spec.inputSchema || spec.inputSchema.type !== 'object' || spec.inputSchema.additionalProperties !== false) throw new MyTerminalError('INVALID_INPUT', 'inputSchema must be an object schema with additionalProperties=false.');
  if (!spec.annotations || typeof spec.annotations.readOnlyHint !== 'boolean' || typeof spec.annotations.destructiveHint !== 'boolean' || typeof spec.annotations.openWorldHint !== 'boolean') throw new MyTerminalError('INVALID_INPUT', 'annotations must declare readOnlyHint, destructiveHint, and openWorldHint.');
  if (!spec.handler || (spec.handler.kind !== 'builtin' && spec.handler.kind !== 'command')) throw new MyTerminalError('INVALID_INPUT', 'handler.kind must be builtin or command.');
  if (spec.handler.kind === 'builtin') {
    if (!builtins.has(spec.handler.target)) throw new MyTerminalError('INVALID_INPUT', `Unknown builtin target: ${spec.handler.target}`);
  } else {
    if (typeof spec.handler.executable !== 'string' || !spec.handler.executable.trim() || spec.handler.executable.includes('\0') || spec.handler.executable.includes('{{')) throw new MyTerminalError('INVALID_INPUT', 'Command extension requires a fixed executable name without templates.');
    if (spec.handler.args && (!Array.isArray(spec.handler.args) || spec.handler.args.length > 100 || spec.handler.args.some((item) => typeof item !== 'string' || item.length > 10_000))) throw new MyTerminalError('INVALID_INPUT', 'Command args must be an array of at most 100 strings.');
    if (spec.handler.timeoutSec !== undefined && (!Number.isInteger(spec.handler.timeoutSec) || spec.handler.timeoutSec < 1 || spec.handler.timeoutSec > 3600)) throw new MyTerminalError('INVALID_INPUT', 'timeoutSec must be an integer from 1 to 3600.');
  }
  return structuredClone(spec);
}

function failure(error: unknown): ToolResponse {
  if (error instanceof MyTerminalError) return { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details } };
  // ADR-0028: never guess an error code by scanning the message text. Unknown
  // errors surface as a generic INTERNAL error to the caller. The original
  // detail is captured by the audit trail, which is redacted at the sink
  // (ADR-0026), so it can never leak into the protocol response.
  return { ok: false, error: { code: 'INTERNAL', message: 'An internal error occurred.', retryable: false } };
}

function resultProblem(value: unknown): ResultProblem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as JsonObject;
  const commandResult = typeof record.command === 'string'
    && typeof record.cwd === 'string'
    && Object.prototype.hasOwnProperty.call(record, 'exitCode')
    && typeof record.durationMs === 'number';
  if (commandResult && record.cancelled === true) return { code: 'ACTION_CANCELLED', message: 'The action was cancelled because the runtime is shutting down.', retryable: true };
  if (commandResult && record.timedOut === true) return { code: 'ACTION_TIMEOUT', message: 'The action exceeded its configured timeout.', retryable: true };
  if (record.passed === false) return { code: 'CHECKS_FAILED', message: 'One or more project checks failed.', retryable: false };
  if (Object.prototype.hasOwnProperty.call(record, 'exitCode') && record.exitCode !== 0) {
    return { code: 'NON_ZERO_EXIT', message: `The command exited with code ${String(record.exitCode)}.`, retryable: false };
  }
  return record.result === undefined ? undefined : resultProblem(record.result);
}

/**
 * 归一化 error.details，消除 decorateContinuation 对 string 型 details 的 `{ ...string }` 炸键
 * （展开成字符索引键、原文丢失，#30 / L567 已确证 shipped bug）。
 * - string → { text }
 * - object → 原样拷贝（不与原对象共享引用）
 * - undefined / null → {}
 */
export function normalizeErrorDetails(details?: JsonObject | string | null): JsonObject {
  if (typeof details === 'string') return { text: details };
  return { ...(details ?? {}) };
}

function explicitIdentity(input: JsonObject): SessionIdentity | undefined {
  if (input.identity === undefined || input.identity === null) return undefined;
  const identity = objectValue(input.identity, 'identity');
  if (typeof identity.sessionId !== 'string' || typeof identity.sessionToken !== 'string') throw new MyTerminalError('INVALID_INPUT', 'identity requires sessionId and sessionToken.');
  return { sessionId: identity.sessionId, sessionToken: identity.sessionToken };
}

export class ExtensionService {
  private readonly activeActions = new Map<string, { sessionId: string; action: string; source: InvocationContext['transport']; args: JsonObject; startedAt: number }>();
  private readonly backgroundTasks = new Map<string, BackgroundTask>();
  // ADR-0051 增补-01（#100）：在飞后台任务完成链（completeBackgroundTask / failBackgroundTask
  // 的 promise）。close 排空时与 operation 一起等待；settler 落定即从集合移除。
  private readonly backgroundSettlers = new Set<Promise<void>>();
  private readonly closedActionIds = new Set<string>();
  private readonly operationControllers = new Map<string, AbortController>();
  private readonly operationPromises = new Map<string, Promise<JsonObject>>();
  private readonly maintenanceTimer: ReturnType<typeof setInterval>;
  private accepting = true;
  private shutdownPromise?: Promise<void>;

  constructor(
    private readonly config: MyTerminalConfig,
    private readonly store: MyTerminalStore,
    private readonly builtins: Map<string, ToolDefinition>,
    private readonly onAudit?: (event: ToolAuditEvent) => void,
  ) {
    this.store.activateHarnessContract({ mode: config.actionsContinuationMode ?? 'off', revision: HARNESS_CONTRACT_REVISION, updatedAt: new Date().toISOString() });
    this.maintenanceTimer = setInterval(() => this.trimBackgroundTasks(), 60_000);
    this.maintenanceTimer.unref();
  }

  activeActionCount(): number { return this.activeActions.size; }

  async shutdown(graceMs = 5_000): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.accepting = false;
    clearInterval(this.maintenanceTimer);
    this.shutdownPromise = (async () => {
      for (const controller of this.operationControllers.values()) controller.abort();
      // ADR-0051 增补-01（#100）：close 排空——在飞 operation 与其后台任务完成链
      // （completeBackgroundTask / failBackgroundTask，含 applyShape → finishAudit 落盘）
      // 一起等，窗口上限 graceMs（默认 5s）；超限后由下方强制收尾兜底，不阻塞关闭。
      const operations = [...this.operationPromises.values()];
      const settlers = [...this.backgroundSettlers];
      if (operations.length || settlers.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled([...operations, ...settlers]),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); }),
        ]);
        if (timer) clearTimeout(timer);
      }
      const error = { code: 'RUNTIME_SHUTTING_DOWN', message: 'The runtime stopped before the action reached a terminal result.' };
      for (const task of this.backgroundTasks.values()) {
        if (task.status !== 'running') continue;
        task.status = 'failed';
        task.completedAt = new Date().toISOString();
        task.response = { ok: false, error: { ...error, retryable: true } };
      }
      for (const [id, action] of [...this.activeActions]) {
        this.finishAudit(action.sessionId, id, action.source, action.action, action.args, action.startedAt, 'failed', { ok: false, error }, error);
      }
    })();
    return this.shutdownPromise;
  }

  pendingActions(): Array<{ id: string; sessionId: string; action: string; startedAt: string }> {
    return [...this.activeActions.entries()].map(([id, action]) => ({
      id, sessionId: action.sessionId, action: action.action, startedAt: new Date(action.startedAt).toISOString(),
    }));
  }

  expirePendingActions(maxAgeMs: number, reason = 'Pending action expired during runtime recovery.'): number {
    const now = Date.now();
    let cleared = 0;
    for (const [id, action] of this.activeActions) {
      if (now - action.startedAt < maxAgeMs) continue;
      const error = { code: 'PENDING_ACTION_CLEARED', message: reason };
      this.finishAudit(action.sessionId, id, action.source, action.action, action.args, action.startedAt, 'failed', { ok: false, error }, error);
      cleared += 1;
    }
    return cleared;
  }

  private beginAudit(sessionId: string, actionId: string, source: InvocationContext['transport'], action: string, args: JsonObject, started: number): void {
    this.activeActions.set(actionId, { sessionId, action, source, args: structuredClone(args), startedAt: started });
    const event: ToolAuditEvent = {
      id: actionId, timestamp: new Date(started).toISOString(), source, action, status: 'running', durationMs: 0,
      workspace: this.config.workspaceDir, session: sessionId, args,
    };
    const persisted = this.store.auditEvent(sessionId, event);
    this.onAudit?.(persisted);
  }

  private finishAudit(
    sessionId: string,
    actionId: string,
    source: InvocationContext['transport'],
    action: string,
    args: JsonObject,
    started: number,
    status: Exclude<ToolAuditEvent['status'], 'running'>,
    result: unknown,
    error?: { code: string; message?: string },
    shaping?: ShapingAudit,
    auditRecord?: ShapingAuditRecord,
  ): void {
    if (this.closedActionIds.has(actionId)) return;
    let finalError = error;
    if ((status === 'failed' || status === 'timeout') && (!finalError || !finalError.code)) {
      finalError = { code: 'UNKNOWN_ERROR', message: 'Tool call failed without a recorded error code.' };
    }
    const completedAt = new Date().toISOString();
    const event: ToolAuditEvent = {
      id: actionId, timestamp: new Date(started).toISOString(), completedAt, source, action, status, durationMs: Date.now() - started, error: finalError,
      workspace: this.config.workspaceDir, session: sessionId, args, result,
      ...(shaping ? { shaping } : {}),
      // D7 双版本审计（0050 F1 / W1-09）：raw/shaped 只进审计链（JSONL），
      // 模型可见通道（session_history / session_context）读取时剥除（D17）。
      ...(auditRecord ? { rawResult: auditRecord.rawResult, shapedResult: auditRecord.shapedResult } : {}),
    };
    const persisted = this.store.auditEvent(sessionId, event);
    this.onAudit?.(persisted);
    this.activeActions.delete(actionId);
    this.closedActionIds.add(actionId);
    if (this.closedActionIds.size > 2000) this.closedActionIds.delete(this.closedActionIds.values().next().value!);
  }

  // ─── withAudit: shared audit scaffolding (ADR-0032 #30) ─────────────────────

  /**
   * ADR-0047（#29）：工具响应整形出口——包住最终装饰响应（含 decorateContinuation 后的
   * 长任务结构，D13）。T01 骨架阶段全量 passthrough（零行为变化回归基线）；shaper 自身
   * 任何失败 → fail-open 返回原始响应（D11），失败原因只进审计、绝不进结果（D17）。
   * subagent 通道（D2）不整形，原样返回。
   */
  private async applyShape(
    response: ToolResponse,
    sessionId: string | undefined,
    transport: InvocationContext['transport'],
  ): Promise<{ response: ToolResponse; shaping: ShapingAudit | undefined; auditRecord?: ShapingAuditRecord }> {
    if (transport === 'subagent') return { response, shaping: undefined };
    let shaping: ShapingAudit | undefined;
    let auditRecord: ShapingAuditRecord | undefined;
    try {
      const shaped = await shapeToolResponse(response, {
        transport,
        sessionId,
        resolveTool: (name) => this.resolveTool(name),
        audit: (record) => { shaping = record.shaping; auditRecord = record; },
      });
      return { response: shaped, shaping, auditRecord };
    } catch {
      // 逃逸级 fail-open（D11）：shaper 内部失败（reducer-threw / cap-threw / l3-* / nested-*）
      // 已就地分类并随 audit 记录带出（tool-parse.ts 各 catch）；能逃逸到此的只剩意外引擎错误，
      // 如实记 engine-error——不再一律误标 reducer-threw（0050 F1 附带 a）。
      return { response, shaping: { applied: false, reason: 'engine-error' } };
    }
  }

  /** 按工具名解析 ToolDefinition（builtin + custom，D5 路由用）；未注册 → undefined。 */
  private resolveTool(name: string): ToolDefinition | undefined {
    const builtin = this.builtins.get(name);
    if (builtin) return builtin;
    const custom = this.store.listExtensions().find((item) => item.name === name);
    if (!custom) return undefined;
    // custom extension 无 invoke 实现（handler 驱动），shaper 只读其形状声明
    return {
      name: custom.name, title: custom.title, description: custom.description,
      inputSchema: custom.inputSchema, annotations: custom.annotations,
      invoke: async () => ({}),
    };
  }

  private deriveAuditError(error: unknown): { code: string; message: string } {
    return { code: error instanceof MyTerminalError ? error.code : 'EXTENSION_ERROR', message: error instanceof Error ? error.message : String(error) };
  }

  private resultToAuditStatus(problem: ResultProblem | undefined): 'completed' | 'failed' | 'timeout' {
    return problem?.code === 'ACTION_TIMEOUT' ? 'timeout' : problem ? 'failed' : 'completed';
  }

  /**
   * ADR-0032 #30: converge the try/beginAudit/finishAudit/catch/finally scaffold
   * shared by discover, register, call, and callSubagent. Each caller supplies
   * only its unique body logic; the audit lifecycle is handled here.
   */
  private async withAudit(
    sessionId: string,
    source: InvocationContext['transport'],
    action: string,
    args: JsonObject,
    handlers: {
      onSuccess: (meta: { actionId: string; started: number }) => Promise<ToolResponse> | ToolResponse;
      onError: (meta: { actionId: string; started: number; auditError: { code: string; message: string } }, error: unknown) => Promise<ToolResponse> | ToolResponse;
      errorStatus?: (auditError: { code: string; message: string }) => Exclude<ToolAuditEvent['status'], 'running'>;
      begin?: boolean;
    },
  ): Promise<ToolResponse> {
    const actionId = `act_${randomUUID()}`;
    const started = Date.now();
    try {
      if (handlers.begin !== false) this.beginAudit(sessionId, actionId, source, action, args, started);
      const response = await handlers.onSuccess({ actionId, started });
      // ADR-0047（#29）：withAudit 出口统一过 shaper（subagent 通道除外，D2 不整形），
      // 审计记录整形后响应 + shaping 原因（D7）。
      const shaped = await this.applyShape(response, sessionId, source);
      this.finishAudit(sessionId, actionId, source, action, args, started, 'completed', shaped.response, undefined, shaped.shaping, shaped.auditRecord);
      return shaped.response;
    } catch (error) {
      const auditError = this.deriveAuditError(error);
      const response = await handlers.onError({ actionId, started, auditError }, error);
      const status = handlers.errorStatus?.(auditError) ?? 'failed';
      const shaped = await this.applyShape(response, sessionId, source);
      this.finishAudit(sessionId, actionId, source, action, args, started, status, shaped.response, auditError, shaped.shaping, shaped.auditRecord);
      return shaped.response;
    } finally {
      if (!this.closedActionIds.has(actionId)) this.activeActions.delete(actionId);
    }
  }

  async discover(input: JsonObject = {}, context: InvocationContext = { transport: 'test' }): Promise<ToolResponse> {
    // ADR-0047（#29）：守卫路径也经 shaper 出口（“所有工具响应经 shaper”）；shutdown 窗口无会话无审计，shaping 不落盘
    if (!this.accepting) return (await this.applyShape({ ok: false, error: { code: 'RUNTIME_SHUTTING_DOWN', message: 'The runtime is shutting down.', retryable: true } }, undefined, context.transport)).response;
    let authenticated: { id: string } | undefined;
    try {
      authenticated = this.authenticate(input, context, true) ?? undefined;
      if (authenticated) {
        this.store.acknowledgeHarnessRequirements(authenticated.id);
        this.store.touchControl(authenticated.id);
      }
    } catch (error) {
      const failed = failure(error);
      const sessionId = authenticated?.id;
      return (await this.applyShape(this.attachEvents(sessionId ? this.decorateContinuation(failed, sessionId, undefined, context.transport) : failed, sessionId), sessionId, context.transport)).response;
    }
    if (!authenticated) {
      return (await this.applyShape({ ok: true, data: {
        agentMd: loadAgentMd(this.config.settingsPath),
        identityRequired: true,
        instructions: {
          root: 'First call extension_discover with the identity key omitted. Never generate identity:null or identity:{}. If it lists multiple workspaces, ask the user to choose one and pass its workspaceId to session_register(mode=root), again with the identity key omitted. Never choose a workspace silently. Save the returned sessionId + sessionToken.',
          inherit: 'Claim handed-off/released/revoked unfinished work with session_inherit(sessionId,claimCode), or reclaim the same stale session after interruption with session_inherit(sessionId,sessionToken=<previous token>). It does not continue a completed session.',
          continue: 'Continue immutable completed work by creating session_register(mode=root,continuesSessionId), or a delegated same-level continuation.',
          handoff: 'Handoff a live session with session_release; give its one-time claimCode to the next controller, which then calls session_inherit.',
          next: 'After identity is established, pass identity={sessionId,sessionToken} on every Actions facade call. Apps may omit it only after a verified openai/session binding exists.',
          actionsContinuation: harnessRequirement(this.config.actionsContinuationMode),
          apps: 'Apps exposes both narrow direct tools and the full extension_call/extension_register facade. Use direct tools when their schema fits; use the facade for arbitrary commands, overwriting writes, patches, and custom extensions.',
        },
        bootstrapTools: ['extension_discover()', 'session_register(mode=root,workspaceId)', 'session_inherit(sessionId,claimCode)', 'session_inherit(sessionId,sessionToken=<previous token>)'],
        skills: listSkills(path.dirname(this.config.settingsPath), this.config.workspaceDir),
      } }, undefined, context.transport)).response;
    }
    return this.withAudit(authenticated.id, context.transport, 'extension_discover', input, {
      onSuccess: () => {
        const query = typeof input.query === 'string' ? input.query.toLowerCase() : '';
        const includeSchemas = input.includeSchemas !== false;
        const builtins = [...this.builtins.values()].map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, kind: 'builtin', annotations: tool.annotations, ...(includeSchemas ? { inputSchema: tool.inputSchema } : {}) }));
        // ADR-0032（#41）：task_poll 条目改引用 TASK_POLL_TOOL 单源，不再手抄第三份
        builtins.push({
          name: TASK_POLL_TOOL.name, title: TASK_POLL_TOOL.title, description: TASK_POLL_TOOL.description, kind: 'builtin',
          annotations: TASK_POLL_TOOL.annotations,
          ...(includeSchemas ? { inputSchema: TASK_POLL_TOOL.inputSchema } : {}),
        });
        const custom = this.store.listExtensions().map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, kind: 'custom', annotations: tool.annotations, handlerKind: tool.handler.kind, ...(includeSchemas ? { inputSchema: tool.inputSchema } : {}) }));
        const catalog = [...builtins, ...custom];
        const matches = catalog.filter((tool) => !query || `${tool.name} ${tool.title} ${tool.description}`.toLowerCase().includes(query));
        const tools = query && matches.length === 0 ? catalog : matches;
        const response: ToolResponse = { ok: true, data: {
          agentMd: loadAgentMd(this.config.settingsPath),
          skills: listSkills(path.dirname(this.config.settingsPath), this.config.workspaceDir),
          tools, total: tools.length,
          instructions: {
            identity: 'Every concrete call and registry change belongs to the authenticated MyTerminal session. Never use openai/session as MyTerminal identity.',
            discover: 'Call extension_discover when you need the exact capability or input schema.',
            register: 'Call extension_register with action=validate before action=upsert.',
            call: `Actions calls extension_call with an exact concrete tool name, identity, and input. Facade operation names do not belong in nextCalls. ${harnessRequirement(this.config.actionsContinuationMode)}`,
            collaboration: 'Delegate by domain and parallel workload rather than assigning an entire large objective to one child. Sessions must keep working until their acceptance criteria are complete, explicitly blocked, or waiting on external input. Collaboration is active, not one-way supervision: safely complete non-conflicting work and hand results to the responsible session. Before completion, coordinate via message_send and checkpoints; do not emit a completion-style user report.',
            completion: 'A root cannot complete until every direct child is terminal and all child messages/events are reviewed. CHILD_REVIEW_REQUIRED returns current time, child status, recent operations, message timing, and mustContinue=true; continue work and do not end with a user-facing final summary.',
            history: 'Continuation context is bounded by design. Use paginated session_history for permanent structured history. Message responses include sent/observed timestamps, age, audited operations since send, and possible delay notices.',
            background: this.config.nonBlockingTasksEnabled
              ? 'Non-blocking tasks are enabled. Calls that exceed 200ms return status=running and taskId; call task_poll until terminal, then follow the returned continuation nextCall.'
              : 'Non-blocking tasks are disabled. Tool calls remain attached to the request until completion or timeout.',
          },
          harness: harnessContract(this.config.actionsContinuationMode) as unknown as JsonObject,
          registrationSchema: {
            name: 'lower_snake_case, 3-64 characters', title: 'human-readable title', description: 'when to use the tool and what it changes',
            inputSchema: 'JSON Schema object with additionalProperties=false',
            annotations: { readOnlyHint: 'boolean', destructiveHint: 'boolean', openWorldHint: 'boolean', idempotentHint: 'optional boolean' },
            handlers: [{ kind: 'builtin', target: 'existing builtin name', defaults: 'optional object' }, { kind: 'command', executable: 'binary name', args: ['literal', '{{input.field}}'], cwd: 'optional workspace-relative directory', timeoutSec: '1-3600' }],
          },
          query: query ? { value: query, matched: matches.length, usedFullCatalogFallback: matches.length === 0 } : undefined,
        } };
        const completed = this.attachEvents(response, authenticated.id);
        return completed;
      },
      onError: (_meta, error) => {
        const failed = failure(error);
        return this.attachEvents(this.decorateContinuation(failed, authenticated.id, undefined, context.transport), authenticated.id);
      },
    });
  }

  /** ADR-0029: drop the ephemeral MCP identity binding for a closed MCP session so no zombie binding survives. */
  mcpSessionClosed(mcpSessionId: string): void {
    this.store.unbindMcp(mcpSessionId);
  }

  async register(input: JsonObject, context: InvocationContext = { transport: 'test' }): Promise<ToolResponse> {
    if (!this.accepting) return (await this.applyShape({ ok: false, error: { code: 'RUNTIME_SHUTTING_DOWN', message: 'The runtime is shutting down.', retryable: true } }, undefined, context.transport)).response;
    // ADR-0032 #30 修复：main 基线中 authenticate + beforeOrdinaryCall 同在方法级 try 内，
    // beginAudit 在其后（auditStarted=false）→ 两者抛错都不写 audit，只返回
    // attachEvents(failure(error), sessionId)。authenticate 抛时 sessionId 未赋值。
    let authenticated: { id: string } | undefined;
    try {
      authenticated = this.authenticate(input, context, false)!;
      this.store.beforeOrdinaryCall(authenticated.id);
    } catch (error) {
      return (await this.applyShape(this.attachEvents(failure(error), authenticated?.id), authenticated?.id, context.transport)).response;
    }
    const session = authenticated;
    return this.withAudit(session.id, context.transport, 'extension_register', input, {
      onSuccess: () => {
        const action = typeof input.action === 'string' ? input.action : '';
        let data: JsonObject;
        if (action === 'remove') {
          if (typeof input.name !== 'string') throw new MyTerminalError('INVALID_INPUT', 'name is required for remove.');
          this.store.removeExtension(input.name); data = { action, name: input.name, removed: true };
        } else {
          if (action !== 'validate' && action !== 'upsert') throw new MyTerminalError('INVALID_INPUT', 'action must be validate, upsert, or remove.');
          const rawSpec = input.spec ?? input.specJson;
          const spec = validateSpec(typeof rawSpec === 'string' ? jsonObjectValue(rawSpec, 'specJson') : rawSpec, this.builtins);
          if (action === 'upsert') this.store.upsertExtension(spec);
          data = { action, valid: true, registered: action === 'upsert', spec };
        }
        return this.attachEvents({ ok: true, data }, session.id);
      },
      onError: (_meta, error) => this.attachEvents(failure(error), session.id),
    });
  }

  async registerFromTui(input: JsonObject): Promise<ToolResponse> {
    try {
      const action = typeof input.action === 'string' ? input.action : '';
      if (action === 'remove') {
        if (typeof input.name !== 'string') throw new MyTerminalError('INVALID_INPUT', 'name is required for remove.');
        this.store.removeExtension(input.name);
        return { ok: true, data: { action, name: input.name, removed: true } };
      }
      if (action !== 'validate' && action !== 'upsert') throw new MyTerminalError('INVALID_INPUT', 'action must be validate, upsert, or remove.');
      const rawSpec = input.spec ?? input.specJson;
      const spec = validateSpec(typeof rawSpec === 'string' ? jsonObjectValue(rawSpec, 'specJson') : rawSpec, this.builtins);
      if (action === 'upsert') this.store.upsertExtension(spec);
      return { ok: true, data: { action, valid: true, registered: action === 'upsert', spec } };
    } catch (error) { return failure(error); }
  }

  async call(input: JsonObject, context: InvocationContext): Promise<ToolResponse> {
    if (!this.accepting) return (await this.applyShape({ ok: false, error: { code: 'RUNTIME_SHUTTING_DOWN', message: 'The runtime is shutting down.', retryable: true } }, undefined, context.transport)).response;
    this.trimBackgroundTasks();
    let sessionId: string | undefined;
    const started = Date.now();
    const actionId = `act_${randomUUID()}`;
    const action = typeof input.tool === 'string' ? input.tool : 'extension_call';
    let args: JsonObject = {};
    let auditStarted = false;
    let detached = false;
    try {
      if (typeof input.tool !== 'string') throw new MyTerminalError('INVALID_INPUT', 'tool is required.');
      args = callArguments(input);
      const bootstrapRoot = input.tool === 'session_register' && args.mode !== 'delegate';
      const bootstrapInherit = input.tool === 'session_inherit';
      const authenticated = bootstrapRoot || bootstrapInherit ? undefined : this.authenticate(input, context, false)!;
      sessionId = authenticated?.id;
      const controller = new AbortController();
      const invocationContext: InvocationContext = { ...context, identity: explicitIdentity(input), authenticatedSession: authenticated, signal: controller.signal };
      if (authenticated) {
        this.beginAudit(authenticated.id, actionId, context.transport, input.tool, args, started);
        auditStarted = true;
        this.assertContinuation(authenticated.id, input.tool, args, context.transport);
        if (!CONTROL_TOOLS.has(input.tool)) this.store.beforeOrdinaryCall(authenticated.id); else this.store.touchControl(authenticated.id);
      }
      if (input.tool === 'task_poll') {
        if (!authenticated) throw new MyTerminalError('IDENTITY_REQUIRED', 'task_poll requires an authenticated session.');
        const shaped = await this.applyShape(this.attachEvents(this.pollBackgroundTask(authenticated.id, args, context.transport), authenticated.id), authenticated.id, context.transport);
        this.finishAudit(authenticated.id, actionId, context.transport, input.tool, args, started, shaped.response.ok ? 'completed' : 'failed', shaped.response, shaped.response.error, shaped.shaping, shaped.auditRecord);
        return shaped.response;
      }
      const operation = this.trackOperation(actionId, controller, this.invokeTool(input.tool, args, invocationContext));
      if (authenticated && !CONTROL_TOOLS.has(input.tool) && this.config.nonBlockingTasksEnabled) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          operation.then((result) => ({ kind: 'result' as const, result }), (error: unknown) => ({ kind: 'error' as const, error })),
          new Promise<{ kind: 'detach' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'detach' }), FAST_RETURN_MS); }),
        ]);
        if (timer) clearTimeout(timer);
        if (outcome.kind === 'detach') {
          detached = true;
          const task: BackgroundTask = { id: actionId, sessionId: authenticated.id, tool: input.tool, input: structuredClone(args), source: context.transport, startedAt: started, status: 'running' };
          this.backgroundTasks.set(task.id, task);
          // ADR-0051 增补-01（#100）：完成链入排空集合，落定即移除。rejection 由
          // shutdown 的 allSettled 兜底；非关闭路径下显式吞掉，避免 unhandled 噪音。
          const settler = operation.then(
            (result) => this.completeBackgroundTask(task, result),
            (error: unknown) => this.failBackgroundTask(task, error),
          );
          this.backgroundSettlers.add(settler);
          void settler.then(
            () => this.backgroundSettlers.delete(settler),
            () => this.backgroundSettlers.delete(settler),
          );
          return (await this.applyShape(this.attachEvents(this.decorateContinuation({ ok: true, data: { tool: input.tool, result: { status: 'running', taskId: task.id, startedAt: new Date(started).toISOString(), fastReturnMs: FAST_RETURN_MS } } }, authenticated.id, {
            reason: 'background_task_running',
            nextCall: { tool: 'task_poll', input: { taskId: task.id }, purpose: 'Confirm the detached operation completed before advancing the continuation plan.' },
          }, context.transport), authenticated.id), authenticated.id, context.transport)).response;
        }
        if (outcome.kind === 'error') throw outcome.error;
        const result = outcome.result;
        const problem = resultProblem(result);
        if (!problem) this.store.completeContinuationCall(authenticated.id, input.tool, args);
        const base: ToolResponse = problem ? { ok: false, data: { tool: input.tool, result }, error: problem } : { ok: true, data: { tool: input.tool, result } };
        const shaped = await this.applyShape(this.attachEvents(this.decorateContinuation(base, authenticated.id, problem ? { reason: 'planned_call_failed' } : undefined, context.transport), authenticated.id), authenticated.id, context.transport);
        this.finishAudit(authenticated.id, actionId, context.transport, input.tool, args, started, this.resultToAuditStatus(problem), shaped.response, problem, shaped.shaping, shaped.auditRecord);
        return shaped.response;
      }
      const result = await operation;
      if (!sessionId && result.identity && typeof result.identity === 'object') sessionId = String((result.identity as JsonObject).sessionId || '');
      if ((bootstrapRoot || bootstrapInherit) && sessionId && context.transport === 'apps' && context.clientSessionKey) this.store.bindApp(context.clientSessionKey, sessionId);
      if ((bootstrapRoot || bootstrapInherit) && sessionId && context.transport === 'mcp' && context.mcpSessionId) this.store.bindMcp(context.mcpSessionId, sessionId);
      if (sessionId && !auditStarted) {
        this.beginAudit(sessionId, actionId, context.transport, input.tool, args, started);
        auditStarted = true;
      }
      if (sessionId) {
        const problem = resultProblem(result);
        if (!problem) this.store.completeContinuationCall(sessionId, input.tool, args);
        const base: ToolResponse = problem ? { ok: false, data: { tool: input.tool, result }, error: problem } : { ok: true, data: { tool: input.tool, result } };
        const shaped = await this.applyShape(this.attachEvents(this.decorateContinuation(base, sessionId, problem ? { reason: 'planned_call_failed' } : undefined, context.transport), sessionId), sessionId, context.transport);
        this.finishAudit(sessionId, actionId, context.transport, input.tool, args, started, this.resultToAuditStatus(problem), shaped.response, problem, shaped.shaping, shaped.auditRecord);
        return shaped.response;
      }
      return (await this.applyShape(this.attachEvents({ ok: true, data: { tool: input.tool, result } }, sessionId), sessionId, context.transport)).response;
    } catch (error) {
      const auditError = this.deriveAuditError(error);
      const isPolicyRejection = auditError.code === 'NEXT_CALL_REQUIRED' || auditError.code === 'CONTINUATION_PLAN_REQUIRED';
      const failed = failure(error);
      const shaped = await this.applyShape(this.attachEvents(sessionId ? this.decorateContinuation(failed, sessionId, undefined, context.transport) : failed, sessionId), sessionId, context.transport);
      if (sessionId && auditStarted) this.finishAudit(sessionId, actionId, context.transport, action, args, started, isPolicyRejection ? 'policy_rejected' : 'failed', shaped.response, auditError, shaped.shaping, shaped.auditRecord);
      return shaped.response;
    } finally {
      if (!detached && !this.closedActionIds.has(actionId)) this.activeActions.delete(actionId);
    }
  }

  // ADR-0009 决策 4：trimmed 版 call——subagent child session 的通知通道
  // 保留 authenticate + beginAudit/finishAudit + beforeOrdinaryCall/touchControl + invokeTool
  // 跳过 assertContinuation / trackOperation+200ms detach / completeContinuationCall / decorateContinuation / attachEvents
  async callSubagent(input: JsonObject, context: InvocationContext): Promise<ToolResponse> {
    if (!this.accepting) return { ok: false, error: { code: 'RUNTIME_SHUTTING_DOWN', message: 'The runtime is shutting down.', retryable: true } };
    this.trimBackgroundTasks();
    const tool = typeof input.tool === 'string' ? input.tool : 'unknown';
    const args = callArguments(input);
    // ADR-0032 #30 修复：main 基线中 authenticate 位于方法级 try 内，抛错 → catch →
    // failure(error)（sessionId 未赋值、auditStarted=false，故不写 audit）。
    let authenticated: NonNullable<ReturnType<ExtensionService['authenticate']>>;
    try {
      authenticated = this.authenticate(input, context, false)!;
    } catch (error) {
      return failure(error);
    }
    return this.withAudit(authenticated.id, 'subagent', tool, args, {
      onSuccess: async () => {
        // main 基线顺序为 beginAudit → beforeOrdinaryCall/touchControl，故这两句必须留在
        // onSuccess 内（beginAudit 之后）：抛错时 auditStarted 已为 true，需落一条 failed 审计。
        // 按 CONTROL_TOOLS 判断走 beforeOrdinaryCall 还是 touchControl
        if (!CONTROL_TOOLS.has(tool)) this.store.beforeOrdinaryCall(authenticated.id);
        else this.store.touchControl(authenticated.id);
        // 同步 await，无 fast-return
        const invocationContext: InvocationContext = {
          ...context,
          transport: 'subagent',
          authenticatedSession: authenticated,
          identity: explicitIdentity(input),
        };
        const result = await this.invokeTool(tool, args, invocationContext);
        return { ok: true, data: { tool, result } };
      },
      onError: (_meta, error) => failure(error),
      errorStatus: (auditError) => auditError.code === 'ACTION_TIMEOUT' ? 'timeout' : 'failed',
    });
  }

  private assertContinuation(sessionId: string, tool: string, input: JsonObject, transport: InvocationContext['transport']): void {
    if (transport !== 'actions' || tool === 'task_poll' || !continuationPolicy(this.config.actionsContinuationMode).enabled) return;
    const expected = this.store.expectedContinuationCall(sessionId);
    if (!expected) return;
    if (tool === 'session_checkpoint') {
      const phase = input.phase;
      if (['waiting', 'blocked', 'cancelled'].includes(String(phase)) || (phase === 'working' && typeof input.replanReason === 'string' && input.replanReason.trim())) return;
    }
    this.store.assertContinuationCall(sessionId, tool, input);
  }

  private decorateContinuation(response: ToolResponse, sessionId: string, override?: { reason: string; nextCall?: { tool: string; input: JsonObject; purpose?: string } }, transport: InvocationContext['transport'] = 'actions'): ToolResponse {
    if (transport !== 'actions' && !override) return response;
    const policy = continuationPolicy(this.config.actionsContinuationMode);
    if (!policy.enabled && !override?.nextCall) return response;
    const session = this.store.session(sessionId);
    const expected = override?.nextCall || (policy.enabled ? this.store.expectedContinuationCall(sessionId) : undefined);
    const terminal = session.phase === 'completed' || session.phase === 'cancelled';
    const paused = session.phase === 'waiting' || session.phase === 'blocked';
    const continuationMode = this.config.actionsContinuationMode;
    const callRequirement = policy.exactCalls ? `exactly ${policy.exactCalls} nextCalls` : `${policy.minCalls}-${policy.maxCalls} exact concrete nextCalls`;
    const continuation: JsonObject = terminal
      ? { status: session.phase, mustContinue: false, taskComplete: session.phase === 'completed' }
      : paused
        ? { status: session.phase, mustContinue: false, taskComplete: false }
        : expected
          ? {
              status: 'working', mustContinue: true, taskComplete: false, continuationMode,
              reason: override?.reason || 'planned_call_pending', nextCall: expected as unknown as JsonObject,
              instruction: 'Immediately execute nextCall in this same assistant turn. Do not answer the user and do not stop after a working checkpoint or running task.',
            }
          : {
              status: 'working', mustContinue: true, taskComplete: false, continuationMode, reason: override?.reason || 'continuation_plan_exhausted',
              nextCallRequired: `Call session_checkpoint now with phase=working, an accurate summary, and ${callRequirement}; then immediately execute the returned nextCall.`,
              instruction: 'The task is not finished. Do not answer the user or stop.',
            };
    return {
      ...response,
      data: { ...(response.data ?? {}), continuation },
      ...(!response.ok && response.error ? { error: { ...response.error, details: { ...normalizeErrorDetails(response.error.details), continuation } } } : {}),
    };
  }

  private async completeBackgroundTask(task: BackgroundTask, result: JsonObject): Promise<void> {
    if (task.status !== 'running') return;
    const problem = resultProblem(result);
    if (!problem) this.store.completeContinuationCall(task.sessionId, task.tool, task.input);
    const status = this.resultToAuditStatus(problem);
    const base: ToolResponse = problem ? { ok: false, data: { tool: task.tool, result }, error: problem } : { ok: true, data: { tool: task.tool, result } };
    // ADR-0047（#29）：完成态在存储前整形（D18.2 执行点），完成审计记 shaping 原因（D7）
    const shaped = await this.applyShape(this.decorateContinuation(base, task.sessionId, problem ? { reason: 'planned_call_failed' } : undefined, task.source), task.sessionId, task.source);
    // ADR-0051 增补-01（#100）：先落审计、后翻终态——task_poll 观察到终态 ⟹ 审计已可读。
    // 消除观察方随即删 state 目录（或 close 后清理）时 appendHistory 的 ENOENT 竞态
    // （W1-08-E1a/E1b 全量并行必现根因）。
    this.finishAudit(task.sessionId, task.id, task.source, task.tool, task.input, task.startedAt, status, shaped.response, problem, shaped.shaping, shaped.auditRecord);
    if (task.status !== 'running') return; // shutdown 超限强制收尾（failed）→ 不覆盖其终态
    task.status = status;
    task.completedAt = new Date().toISOString();
    task.response = shaped.response;
    // ADR-0050 E1（#81 W1-08）：task 完成 → 清该 taskId 的 Q8 operation 缓存条目
    clearOperationCache(task.id);
    // ADR-0051 增补-07（#106）：完成态按 poll 同款 key 预填 Q8 缓存——首次 poll 命中，
    // 不再对「已整形内容」重跑 L3（A2 审计 F1：双烧 D6 配额 + 非确定性输出漂移）
    seedOperationCache(task.id, task.response);
    this.trimBackgroundTasks();
  }

  private async failBackgroundTask(task: BackgroundTask, error: unknown): Promise<void> {
    if (task.status !== 'running') return;
    const auditError = this.deriveAuditError(error);
    const shaped = await this.applyShape(this.decorateContinuation(failure(error), task.sessionId, { reason: 'planned_call_failed' }, task.source), task.sessionId, task.source);
    // ADR-0051 增补-01（#100）：先落审计、后翻终态（同 completeBackgroundTask，见上）
    this.finishAudit(task.sessionId, task.id, task.source, task.tool, task.input, task.startedAt, 'failed', shaped.response, auditError, shaped.shaping, shaped.auditRecord);
    if (task.status !== 'running') return; // shutdown 超限强制收尾（failed）→ 不覆盖其终态
    task.status = 'failed';
    task.completedAt = new Date().toISOString();
    task.response = shaped.response;
    // ADR-0050 E1（#81 W1-08）：task 失败（终态）同样清该 taskId 的缓存条目
    clearOperationCache(task.id);
    this.trimBackgroundTasks();
  }

  private pollBackgroundTask(sessionId: string, input: JsonObject, transport: InvocationContext['transport']): ToolResponse {
    if (typeof input.taskId !== 'string') throw new MyTerminalError('INVALID_INPUT', 'taskId is required.');
    const task = this.backgroundTasks.get(input.taskId);
    if (!task || task.sessionId !== sessionId) throw new MyTerminalError('NOT_FOUND', 'Background task not found for this session.');
    if (task.status === 'running') return this.decorateContinuation({ ok: true, data: { tool: 'task_poll', result: { taskId: task.id, status: task.status, startedAt: new Date(task.startedAt).toISOString(), elapsedMs: Date.now() - task.startedAt } } }, sessionId, {
      reason: 'background_task_running', nextCall: { tool: 'task_poll', input: { taskId: task.id }, purpose: 'Keep polling until the detached operation reaches a terminal status.' },
    }, transport);
    return this.decorateContinuation({ ok: true, data: { tool: 'task_poll', result: { taskId: task.id, status: task.status, startedAt: new Date(task.startedAt).toISOString(), completedAt: task.completedAt, operation: task.response } } }, sessionId, undefined, transport);
  }

  private trimBackgroundTasks(): void {
    const cutoff = Date.now() - BACKGROUND_TASK_RETENTION_MS;
    for (const task of this.backgroundTasks.values()) {
      if (task.status !== 'running' && task.completedAt && Date.parse(task.completedAt) < cutoff) {
        // ADR-0050 E1（#81 W1-08）：任务删除 → 顺带清该 taskId 的 Q8 缓存条目（删任务不清缓存的缺口）
        clearOperationCache(task.id);
        this.backgroundTasks.delete(task.id);
      }
    }
    const completed = [...this.backgroundTasks.values()]
      .filter((task) => task.status !== 'running')
      .sort((left, right) => Date.parse(left.completedAt || '') - Date.parse(right.completedAt || ''));
    const responseBytes = (task: BackgroundTask) => task.response ? Buffer.byteLength(JSON.stringify(task.response)) : 0;
    let retainedBytes = completed.reduce((sum, task) => sum + responseBytes(task), 0);
    for (const task of completed) {
      if (this.backgroundTasks.size <= BACKGROUND_TASK_MAX_COUNT && retainedBytes <= BACKGROUND_TASK_MAX_BYTES) break;
      retainedBytes -= responseBytes(task);
      // ADR-0050 E1（#81 W1-08）：计数/字节驱逐删除 → 同样清缓存条目
      clearOperationCache(task.id);
      this.backgroundTasks.delete(task.id);
    }
  }

  private trackOperation(id: string, controller: AbortController, operation: Promise<JsonObject>): Promise<JsonObject> {
    this.operationControllers.set(id, controller);
    this.operationPromises.set(id, operation);
    const cleanup = () => {
      this.operationControllers.delete(id);
      this.operationPromises.delete(id);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  private authenticate(input: JsonObject, context: InvocationContext, allowMissing: boolean) {
    const identity = explicitIdentity(input);
    if (identity) {
      const session = this.store.authenticate(identity);
      if (context.transport === 'apps' && context.clientSessionKey) this.store.bindApp(context.clientSessionKey, session.id);
      else if (context.transport === 'mcp' && context.mcpSessionId) this.store.bindMcp(context.mcpSessionId, session.id);
      return session;
    }
    if (context.transport === 'apps' && context.clientSessionKey) {
      const bound = this.store.resolveAppBinding(context.clientSessionKey);
      if (bound) return bound;
    }
    if (context.transport === 'mcp' && context.mcpSessionId) {
      const bound = this.store.resolveMcpBinding(context.mcpSessionId);
      if (bound) return bound;
    }
    if (allowMissing) return undefined;
    throw new MyTerminalError('IDENTITY_REQUIRED', 'This operation requires identity={sessionId,sessionToken}. Register or inherit a session first.');
  }

  private normalizeAliases(args: JsonObject, aliases?: Record<string, string>): JsonObject {
    if (!aliases) return args;
    const normalized: JsonObject = { ...args };
    for (const [alias, canonical] of Object.entries(aliases)) {
      if (normalized[alias] !== undefined && normalized[canonical] === undefined) {
        normalized[canonical] = normalized[alias];
      }
      delete normalized[alias];
    }
    return normalized;
  }

  private async invokeTool(name: string, args: JsonObject, context: InvocationContext): Promise<JsonObject> {
    const builtin = this.builtins.get(name);
    if (builtin) {
      const normalized = this.normalizeAliases(args, builtin.aliases);
      const errors = validateJsonSchema(builtin.inputSchema, normalized); if (errors.length) throw new MyTerminalError('INVALID_INPUT', errors.join('; '));
      const result = await builtin.invoke(normalized, context);
      // ADR-0050 E2（#81 W1-08）：会话结束（session_release / session_unregister 成功）
      // → 清该会话 L3 配额（D6 护栏3「会话结束从 Map 删除」）。仅接线，不改原语语义。
      if ((name === 'session_release' || name === 'session_unregister') && context.authenticatedSession) clearL3Quota(context.authenticatedSession.id);
      return result;
    }
    const custom = this.store.listExtensions().find((item) => item.name === name);
    if (!custom) throw new MyTerminalError('NOT_FOUND', `Extension not found: ${name}`);
    const errors = validateJsonSchema(custom.inputSchema, args); if (errors.length) throw new MyTerminalError('INVALID_INPUT', errors.join('; '));
    if (custom.handler.kind === 'builtin') {
      const target = this.builtins.get(custom.handler.target)!; const merged = { ...(custom.handler.defaults ?? {}), ...args };
      const targetErrors = validateJsonSchema(target.inputSchema, merged); if (targetErrors.length) throw new MyTerminalError('INVALID_INPUT', targetErrors.join('; '));
      return { target: target.name, result: await target.invoke(merged, context) };
    }
    const cwd = resolveWorkspacePath(this.config.workspaceDir, this.config.stateDir, custom.handler.cwd || '.');
    return await runCommand({ executable: renderTemplate(custom.handler.executable, args), argv: (custom.handler.args ?? []).map((arg) => renderTemplate(arg, args)), cwd, timeoutSec: custom.handler.timeoutSec ?? this.config.commandTimeoutSec, maxOutputChars: this.config.maxOutputChars, signal: context.signal }) as unknown as JsonObject;
  }

  private attachEvents(response: ToolResponse, sessionId?: string): ToolResponse {
    if (!sessionId) return response;
    const events = this.store.pendingEvents(sessionId, 5);
    return events.length ? { ...response, events } : response;
  }
}
