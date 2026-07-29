export type JsonObject = Record<string, unknown>;

export type SessionPhase = 'pending' | 'working' | 'waiting' | 'blocked' | 'completed' | 'cancelled';
export type SessionPresence = 'unclaimed' | 'claimed' | 'stale';
export type ActionsContinuationMode = 'off' | 'adaptive' | 'next-call' | 'lookahead-3';

export type SessionIdentity = { sessionId: string; sessionToken: string };

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

// ADR-0009 决策 11/12/14 + ADR-0007 决策 21
export type SubagentSettings = {
  enabled: boolean;
  provider: 'openai' | 'anthropic' | 'deepseek' | 'glm' | 'qwen';
  model: string;
  maxTurns: number;       // agent loop 轮次上限，默认 50
  timeoutSec: number;     // 整体超时秒数，默认 300
  maxParallel: number;    // 并发 subagent 上限，默认 2
  fallbackModel?: string; // 529 过载降级模型（ADR-0007 决策 21），可选
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
};
