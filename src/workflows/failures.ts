/**
 * 三态结算的归类——每一路结算只有三种下场，沉默不是第四态。
 *
 *   null   该路自身失败：一切沉默都坍缩到这里（轮数上限 / 时间上限 /
 *          模型或启动错误 / 缺结构化输出 / stall 重试耗尽 / 首响应前什么都不返回），
 *          连同具名 error 记入索引与失败清单，run 继续。
 *   reject 调用形状错：闸门在 admission 之前，不消耗缓存键、不进失败清单。
 *   throw  run 级终结：预算越限、agent 数越限、取消——整批拒、在飞中止、队列丢弃。
 *
 * 判定一律鸭子读名字与标记，绝不 instanceof：错误要穿沙箱边界、看门狗包装与
 * 调度器，跨 realm 的 instanceof 恒 false，用它会把它当普通失败吞掉。
 */

export const AGENT_FAILURE_KINDS = ['max_turns', 'timeout', 'error', 'no_structured_output', 'stalled'] as const;
export type AgentFailureKind = (typeof AGENT_FAILURE_KINDS)[number];

/** 上下文上限的具名原因：第一版不做压缩，撞了就记这一条。 */
export const CONTEXT_OVERFLOW_REASON = 'context-overflow';
export const EMPTY_RESULT_REASON = 'empty-result';
const CONTEXT_OVERFLOW_PATTERN = /prompt is too long|context (?:length|window|limit)|maximum context|too many tokens|token limit exceeded/i;

export type SettledFailure = { kind: AgentFailureKind; message: string; reason?: string };

function marker<T extends object>(error: T, key: '__wfAgentFailure' | '__wfRunFailure'): T {
  Object.defineProperty(error, key, { value: true, enumerable: false, writable: false });
  return error;
}

/** 该路自身失败：带种类，进账本与失败清单。 */
export class WorkflowAgentFailedError extends Error {
  readonly kind: AgentFailureKind;

  constructor(kind: AgentFailureKind, message: string, readonly reason?: string) {
    super(message);
    this.name = 'WorkflowAgentFailedError';
    this.kind = kind;
    marker(this, '__wfAgentFailure');
  }
}

export function agentFailure(kind: AgentFailureKind, message: string, reason?: string): Error {
  return new WorkflowAgentFailedError(kind, message, reason);
}

/** 调用形状错：坏在写法，不在那一路本身。 */
export class AgentCallShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCallShapeError';
  }
}

/** run 级终结的具名原因。 */
export type RunTerminationReason = 'token-budget' | 'agent-cap' | 'cancelled' | 'run-gate' | (string & {});

export class WorkflowRunLevelError extends Error {
  constructor(readonly reason: RunTerminationReason, message: string) {
    super(message);
    this.name = 'WorkflowRunLevelError';
    marker(this, '__wfRunFailure');
  }
}

export function runLevelError(reason: RunTerminationReason, message: string): Error {
  return new WorkflowRunLevelError(reason, message);
}

/** agent 数越限：消息只说事实，不给"把上限调大"的暗示——调参权在本机设置面。 */
export class WorkflowAgentCapExceededError extends Error {
  constructor(readonly maxAgents: number) {
    super(`Workflow run exceeded the agent() cap of ${maxAgents} calls per run.`);
    this.name = 'WorkflowAgentCapExceededError';
    marker(this, '__wfRunFailure');
  }
}

/** token 预算越限：同样不附带任何抬升闸门的建议。 */
export class WorkflowBudgetExceededError extends Error {
  constructor(readonly runId: string, readonly spent: number, readonly budgetTotal: number) {
    super(`Workflow run ${runId} exceeded its token budget (${spent} / ${budgetTotal} output tokens). Further agent() calls are refused.`);
    this.name = 'WorkflowBudgetExceededError';
    marker(this, '__wfRunFailure');
  }
}

function duck(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readField(value: unknown, key: string): unknown {
  const record = duck(value);
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  // 只认数据属性：getter 可能是模型可控代码的入口，判定路径上绝不触发它。
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

export function isAgentFailure(error: unknown): boolean {
  const record = duck(error);
  return readField(error, '__wfAgentFailure') === true || readField(error, 'name') === 'WorkflowAgentFailedError';
}

export function isRunLevelError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (readField(error, '__wfRunFailure') === true) return true;
  const name = readField(error, 'name');
  return name === 'WorkflowAgentCapExceededError' || name === 'WorkflowBudgetExceededError' || name === 'WorkflowRunLevelError';
}

export function isCallShapeError(error: unknown): boolean {
  return readField(error, 'name') === 'AgentCallShapeError';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error || typeof error === 'object') {
    const message = readField(error, 'message');
    if (typeof message === 'string' && message.length > 0) return message;
    if (typeof error === 'object' && error !== null) {
      const name = readField(error, 'name');
      return typeof name === 'string' ? name : 'dispatch failed';
    }
  }
  return String(error);
}

function readKind(error: unknown): AgentFailureKind | undefined {
  const value = readField(error, 'kind');
  return typeof value === 'string' && (AGENT_FAILURE_KINDS as readonly string[]).includes(value) ? (value as AgentFailureKind) : undefined;
}

function readReason(error: unknown): string | undefined {
  const value = readField(error, 'reason');
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 模型/启动侧的沉默归类：已归类的原样走，未归类一律坍缩为该路失败（kind=error），
 * 上下文上限与空产出各带一个具名 reason，失败清单才说得出为什么。
 */
export function classifyAdapterError(error: unknown): SettledFailure {
  const message = errorMessage(error);
  const kind = readKind(error);
  const reason = readReason(error);
  if (kind) return reason ? { kind, message, reason } : { kind, message };
  if (CONTEXT_OVERFLOW_PATTERN.test(message)) return { kind: 'error', message, reason: CONTEXT_OVERFLOW_REASON };
  return { kind: 'error', message };
}

/** 什么都不返回 = 沉默 = 该路失败。 */
export function silenceFailure(field: string): SettledFailure {
  return { kind: 'error', message: `The agent returned nothing for ${field}.`, reason: EMPTY_RESULT_REASON };
}
