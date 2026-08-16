import type { ToolReducer } from './tool-parse.js';

export type JsonObject = Record<string, unknown>;

export type SessionPhase = 'pending' | 'working' | 'waiting' | 'blocked' | 'completed' | 'cancelled';
export type SessionPresence = 'unclaimed' | 'claimed' | 'stale';
export type ActionsContinuationMode = 'off' | 'adaptive' | 'next-call' | 'lookahead-3';

export type SessionIdentity = { sessionId: string; sessionToken: string };

/**
 * ADR-0047：整形审计（D7/D11/D17）。`{ applied, reason? }` 只进审计、永不进模型上下文。
 * reason 的权威枚举（ShapingReason）在 tool-parse.ts，此处为审计持久化的宽松形态。
 */
export type ShapingAudit = {
  applied: boolean;
  reason?: string;
  /** D15/T07 主动精简审计（可选，仅 active-trim reducer 产）：精简详情，只进审计、永不进模型上下文（D17） */
  reduced?: boolean;
  fieldsReduced?: number;
  entriesTruncated?: number;
  originalSize?: number;
  reducedSize?: number;
};

export type ToolAuditStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'policy_rejected';
export type ToolAuditSource = 'apps' | 'actions' | 'tui' | 'test' | 'subagent' | 'mcp'; // ADR-0009 决策 3；ADR-0029 新增 'mcp'
export type ToolAuditEvent = {
  id: string;
  /** Stable invocation start time. Completion updates keep this value unchanged. */
  timestamp: string;
  completedAt?: string;
  source: ToolAuditSource;
  action: string;
  status: ToolAuditStatus;
  durationMs: number;
  error?: { code: string; message?: string };
  workspace: string;
  session: string;
  args?: unknown;
  result?: unknown;
  /** ADR-0047：整形审计（T01 #29 起）。`{ applied, reason? }` 只进审计、永不进模型上下文（D17）。 */
  shaping?: ShapingAudit;
  /** ADR-0051 W1-09 (#82) / 0050 F1：D7 双版本审计——整形前原始版与整形后版。
   *  rawResult 含完整未截断 error（D12 诊断保全）；只进审计链（JSONL），模型可见通道
   *  （session_history / session_context）读取时剥除，绝不进模型上下文（D17）。 */
  rawResult?: unknown;
  shapedResult?: unknown;
};

export type TaskPackage = {
  objective: string;
  background: string;
  deliverables: string[];
  acceptanceCriteria: string[];
  constraints: string[];
};

export type PlannedToolCall = {
  tool: string;
  input: JsonObject;
  purpose?: string;
};

export type ContinuationPlan = {
  createdAt: string;
  completedCalls: PlannedToolCall[];
  remainingCalls: PlannedToolCall[];
};

export type SessionCheckpoint = {
  at: string;
  phase: SessionPhase;
  summary: string;
  nextSteps?: string[];
  blockers?: string[];
  artifacts?: string[];
  milestone?: string;
  tags?: string[];
  nextCalls?: PlannedToolCall[];
  replanReason?: string;
};

export type SessionController = {
  id: string;
  tokenHash: string;
  claimedAt: string;
  lastActivityAt: string;
};

export type MyTerminalSession = {
  id: string;
  name: string;
  role: string;
  phase: SessionPhase;
  presence: SessionPresence;
  parentSessionId?: string;
  continuesSessionId?: string;
  predecessorDeleted?: boolean;
  task?: TaskPackage;
  controller?: SessionController;
  claimCodeHash?: string;
  claimCodeIssuedAt?: string;
  checkpointStartedAt?: string;
  checkpointReminderEmittedAt?: string;
  latestCheckpoint?: SessionCheckpoint;
  continuationPlan?: ContinuationPlan;
  finalSummary?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type MyTerminalMessage = {
  id: string;
  from: string;
  to: string;
  source?: 'session' | 'user';
  body: string;
  createdAt: string;
  readAt?: string;
};

export type SessionEventKind =
  | 'message' | 'child_created' | 'milestone' | 'phase_changed' | 'blocked'
  | 'completed' | 'stale' | 'checkpoint_due' | 'claimed' | 'revoked' | 'released' | 'cancelled'
  | 'requirements_changed';

export type SessionEvent = {
  id: string;
  recipientSessionId: string;
  sourceSessionId: string;
  kind: SessionEventKind;
  payload: JsonObject;
  createdAt: string;
  acknowledgedAt?: string;
};

export type SessionSubscription = {
  subscriberSessionId: string;
  targetSessionId: string;
  createdAt: string;
};

export type AppSessionBinding = {
  clientSessionKey: string;
  sessionId: string;
  controllerId: string;
  boundAt: string;
};

/** ADR-0029: ephemeral MCP-session → MyTerminal session identity binding. Kept in-memory only (never persisted) so a process crash leaves no zombie bindings. */
export type McpSessionBinding = {
  mcpSessionId: string;
  sessionId: string;
  controllerId: string;
  boundAt: string;
};

export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
};

export type ExtensionAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
};

export type BuiltinExtensionHandler = { kind: 'builtin'; target: string; defaults?: JsonObject };
export type CommandExtensionHandler = { kind: 'command'; executable: string; args?: string[]; cwd?: string; timeoutSec?: number };

export type CustomExtensionSpec = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ExtensionAnnotations;
  handler: BuiltinExtensionHandler | CommandExtensionHandler;
};

export type StoredState = {
  schemaVersion: 2;
  revision: number;
  sessions: MyTerminalSession[];
  messages: MyTerminalMessage[];
  events: SessionEvent[];
  subscriptions: SessionSubscription[];
  appBindings: AppSessionBinding[];
  extensions: CustomExtensionSpec[];
  harnessContract?: { mode: ActionsContinuationMode; revision: string; updatedAt: string };
};

// ADR-0045（spine）：零默认、显式、代码永不猜。收敛为单一 Anthropic 协议入口，
// 配置从"选 provider"改为"填端点"。provider 概念已由 ADR-0045 删除（含
// 原 SUBAGENT_PROVIDERS 常量及其派生类型，以及 onboarding 技能的 check-provider-sync 护栏）。
export type SubagentSettings = {
  enabled: boolean;
  model: string;          // 全局唯一模型（必填，零默认、缺配即拒）
  baseUrl: string;        // Anthropic 协议端点（必填，可指向兼容网关）
  apiKey: string;         // API 密钥（必填，落盘换取"填 3 项即用"）
  maxTurns: number;       // agent loop 轮次上限，默认 700（1-1600）
  timeoutSec: number;     // 整体超时秒数，默认 7200（30-86400）
  maxParallel: number;    // 并发 subagent 上限，默认 2
  contextWindow?: number; // 上下文窗口上限（可选，默认 120000；有配置用配置，代码不查表）
  maxOutput?: number;     // 单次最大输出 token（可选，默认 32000）
  compactThreshold?: number; // 压缩阈值（可选，默认 80000）
  fallbackModel?: string; // 529 过载降级模型（可选，默认无；env MYTERMINAL_SUBAGENT_FALLBACK_MODEL 可覆盖）
};

export type MyTerminalSettings = {
  schemaVersion: 1;
  workspaceDir: string;
  host: string;
  port: number;
  connectorKey: string;
  actionsToken: string;
  publicBaseUrl: string;
  maxOutputChars: number;
  commandTimeoutSec: number;
  uiLanguage: 'en' | 'zh-CN';
  uiTheme: 'dark' | 'light';
  passiveLockEnabled: boolean;
  actionsContinuationMode: ActionsContinuationMode;
  nonBlockingTasksEnabled: boolean;
  subagent?: SubagentSettings; // ADR-0009 决策 3：可选，向后兼容
};

export type MyTerminalConfig = {
  settingsPath: string;
  workspaceDir: string;
  stateDir: string;
  host: string;
  port: number;
  connectorKey: string;
  actionsToken: string;
  publicBaseUrl: string;
  maxOutputChars: number;
  commandTimeoutSec: number;
  uiLanguage: 'en' | 'zh-CN';
  uiTheme: 'dark' | 'light';
  passiveLockEnabled: boolean;
  actionsContinuationMode: ActionsContinuationMode;
  nonBlockingTasksEnabled: boolean;
};

export type SessionHistoryEntry = { at: string; type: string; data: JsonObject };

export type InvocationContext = {
  identity?: SessionIdentity;
  authenticatedSession?: MyTerminalSession;
  clientSessionKey?: string;
  /** ADR-0029: MCP session id (mcp-session-id header) used as the identity-binding key */
  mcpSessionId?: string;
  transport: 'apps' | 'actions' | 'tui' | 'test' | 'subagent' | 'mcp'; // ADR-0009 决策 3；ADR-0029 加 'mcp'
  signal?: AbortSignal;
};

export type ToolResponse = {
  ok: boolean;
  data?: JsonObject;
  events?: SessionEvent[];
  error?: { code: string; message: string; retryable: boolean; details?: JsonObject };
};

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ExtensionAnnotations;
  aliases?: Record<string, string>;
  invoke: (input: JsonObject, context: InvocationContext) => Promise<JsonObject>;
  /** ADR-0047（D5）：可选内联 L1 形状声明（工具自检），路由第一优先于中心表 TOOL_SHAPES。零模型 reducer；未声明走中心表/ passthrough。 */
  shapeResult?: ToolReducer;
};
