import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ExtensionService } from './extensions.js';
import { jsonSchemaToZod } from './mcp-schema.js';
import { BUILTIN_INPUT_SCHEMAS, type BuiltinToolName } from './tool-schemas.js';
import type { InvocationContext, JsonObject, ToolResponse } from './types.js';
import { CURRENT_VERSION } from './version.js';

type LiveSession = { server: McpServer; transport: StreamableHTTPServerTransport };

export type ExtensionFacade = Pick<ExtensionService, 'discover' | 'register' | 'call' | 'mcpSessionClosed'>;

const responseSchema = {
  ok: z.boolean(),
  data: z.record(z.string(), z.unknown()).optional(),
  events: z.array(z.record(z.string(), z.unknown())).optional(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), details: z.record(z.string(), z.unknown()).optional() }).optional(),
};

const identitySchema = z.object({ sessionId: z.string().min(1), sessionToken: z.string().min(1) });
const optionalIdentitySchema = identitySchema.nullish();

/**
 * extension_call/extension_register 入参的协议层 schema —— **main 09f2246 基线逐字还原**。
 *
 * 语义（#70 门禁探针实证，见 scripts/probe-41-baseline-vs-seams.mjs）：
 *   · 44 个**已声明**字段的类型校验在协议层生效（`limit:"abc"`、`mode:"wildcard"` 等即拒）；
 *   · `.catchall(z.unknown())` 只放行**未声明**的额外键（面向任意 custom extension 的开放性）。
 * #41 曾把它退化为 `z.record`（全通），使 6 类类型错误从「协议层即拒」变「放行」——
 * 那是真实行为放宽，违反批5「纯重构行为不变」铁律，已还原。
 * 「防第三份副本腐烂」的诉求由锁测试 PROTO-LOCK-3（基线字段快照）承担；
 * 若要改为从单源派生/收紧约束，属显式行为变更，须单独开票走流程。
 */
export const extensionToolInput = z.object({
  name: z.string().optional(),
  role: z.string().optional(),
  session: z.string().optional(),
  workspaceId: z.string().optional(),
  mode: z.enum(['root', 'delegate']).optional(),
  phase: z.enum(['pending', 'working', 'waiting', 'blocked', 'completed', 'cancelled']).optional(),
  note: z.string().optional(),
  sessionId: z.string().optional(),
  sessionToken: z.string().optional(),
  claimCode: z.string().optional(),
  continuesSessionId: z.string().optional(),
  summary: z.string().optional(),
  objective: z.string().optional(),
  background: z.string().optional(),
  deliverables: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  task: z.record(z.string(), z.unknown()).optional(),
  nextSteps: z.array(z.string()).optional(),
  nextCalls: z.array(z.record(z.string(), z.unknown())).optional(),
  replanReason: z.string().optional(),
  blockers: z.array(z.string()).optional(),
  artifacts: z.array(z.string()).optional(),
  milestone: z.string().optional(),
  tags: z.array(z.string()).optional(),
  targetSessionId: z.string().optional(),
  eventIds: z.array(z.string()).optional(),
  to: z.string().optional(),
  body: z.string().optional(),
  markRead: z.boolean().optional(),
  limit: z.number().int().optional(),
  offset: z.number().int().optional(),
  includeAncestors: z.boolean().optional(),
  with: z.string().optional(),
  path: z.string().optional(),
  content: z.string().optional(),
  patch: z.string().optional(),
  encoding: z.string().optional(),
  sha256: z.string().optional(),
  createParents: z.boolean().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  timeoutSec: z.number().int().optional(),
  taskId: z.string().optional(),
}).catchall(z.unknown());

const extensionSpec = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).optional(),
    additionalProperties: z.literal(false),
  }),
  annotations: z.object({
    readOnlyHint: z.boolean(),
    destructiveHint: z.boolean(),
    openWorldHint: z.boolean(),
    idempotentHint: z.boolean().optional(),
  }),
  handler: z.object({
    kind: z.enum(['builtin', 'command']),
    target: z.string().optional(),
    defaults: extensionToolInput.optional(),
    executable: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    timeoutSec: z.number().int().optional(),
  }),
});

function toToolResult(response: ToolResponse, summary: string) {
  const continuation = response.data?.continuation as Record<string, unknown> | undefined;
  const continuationText = continuation?.mustContinue === true
    ? ` Task is still working. ${String(continuation.instruction || continuation.nextCallRequired || 'Immediately execute the returned next call.')}`
    : '';
  return {
    structuredContent: response as unknown as Record<string, unknown>,
    content: [{ type: 'text' as const, text: response.ok ? `${summary}${continuationText}` : `${response.error?.code}: ${response.error?.message}${continuationText}` }],
    isError: !response.ok,
  };
}

function contextFromCall(callContext: unknown): InvocationContext {
  const extra = callContext as { sessionId?: string; _meta?: Record<string, unknown> } | undefined;
  const mcpSessionId = typeof extra?.sessionId === 'string' ? extra.sessionId : undefined;
  const meta = extra?._meta;
  return {
    transport: 'mcp',
    mcpSessionId,
    clientSessionKey: typeof meta?.['openai/session'] === 'string' ? meta['openai/session'] : undefined,
  };
}

export function createMcpServer(service: ExtensionFacade): McpServer {
  const server = new McpServer({ name: 'myterminal', version: CURRENT_VERSION }, {
    instructions: [
      'MyTerminal sessions are auditable work contexts, not ChatGPT conversation IDs.',
      'The extension_discover response may include an agentMd field with the user-authored instructions at ~/.config/myterminal/AGENT.md. Always read and follow these instructions; they override any conflicting defaults.',
      'For unauthenticated extension_discover, session_register(mode=root), and session_inherit calls, omit the identity key entirely. Never generate identity:null or identity:{}. Explicit null is tolerated only as an absent identity for client compatibility.',
      'Before new work, call extension_discover. If multiple workspaces are listed, ask the user to choose one; never choose silently. Then create a root with session_register(mode=root, workspaceId), claim handed-off unfinished work with session_inherit(sessionId, claimCode), or reclaim the same stale session after interruption with session_inherit(sessionId, sessionToken=<previous token>).',
      'Never create a new root for the same unfinished task merely because the old identity became stale. Reclaim that stale session with the previous sessionToken. Do not use session_inherit to continue completed work: completed sessions are immutable; create session_register(mode=root, continuesSessionId) or delegate a same-level continuation.',
      'For controller handoff, call session_release to obtain a one-time claimCode, then let the next controller call session_inherit.',
      'Apps exposes both the full extension_call/extension_register facade and narrow direct tools. Use direct tools when their schema fits; use extension_call for arbitrary commands, overwriting writes, patches, and custom extensions.',
      'If a response has continuation.mustContinue=true, immediately execute its nextCall in the same turn. When optional non-blocking tasks are enabled, status=running means call task_poll until terminal. Actions-only enhanced long-task enforcement and non-blocking scheduling are separate settings and neither removes Apps capabilities.',
      'Delegate by domain and parallel workload; do not assign an entire large objective to one child. Sessions must continue until acceptance criteria are complete, explicitly blocked, or waiting on external input. Collaboration is active: safely complete non-conflicting work and hand results to the responsible session.',
      'Before all work is complete, do not emit a completion-style user report. Use message_send, events, and session_checkpoint for progress. A root cannot complete until every direct child is terminal and all child messages/events are reviewed. On CHILD_REVIEW_REQUIRED, use the returned timestamps, child states, recent operations, and message timing, then continue working.',
      'message_list covers both sent and received messages; message_conversation returns a two-way thread. Message results include send/observation timestamps, age, audited operations since send, and possible delay notices.',
      'Automatic continuation context is intentionally bounded. Use paginated session_history for permanent structured summaries, messages, state events, and sanitized tool calls.',
      'Use skill() to list available skills, skill(name) to run one.',
    ].join('\n'),
  });
  server.registerTool('extension_discover', {
    title: 'Discover extension tools',
    description: 'Use first to learn all concrete tools available behind MyTerminal, how to call them, and how to validate/register custom tools.',
    inputSchema: { query: z.string().min(1).max(200).optional(), includeSchemas: z.boolean().optional(), identity: optionalIdentitySchema },
    outputSchema: responseSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { 'openai/toolInvocation/invoking': 'Inspecting extensions…', 'openai/toolInvocation/invoked': 'Extension catalog ready' },
  }, async (input, callContext) => toToolResult(await service.discover(input as JsonObject, contextFromCall(callContext)), 'Extension catalog and usage instructions are ready.'));

  server.registerTool('extension_register', {
    title: 'Register or edit extension tool',
    description: 'Validate, upsert, or remove one declarative extension. Validate before upsert. Use extension_discover for the exact registration format.',
    inputSchema: { action: z.enum(['validate', 'upsert', 'remove']), name: z.string().optional(), spec: extensionSpec.optional(), specJson: z.string().optional(), identity: optionalIdentitySchema },
    outputSchema: responseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    _meta: { 'openai/toolInvocation/invoking': 'Validating extension…', 'openai/toolInvocation/invoked': 'Extension registry updated' },
  }, async (input, callContext) => toToolResult(await service.register(input as JsonObject, contextFromCall(callContext)), 'Extension registration operation completed.'));

  server.registerTool('extension_call', {
    title: 'Call concrete extension tool',
    description: 'Invoke any builtin or custom extension by exact name, including arbitrary commands, overwriting writes, and patches. Put tool arguments in input (preferred) or arguments (legacy). Call extension_discover first for its schema.',
    inputSchema: { tool: z.string().min(3).max(64), input: extensionToolInput.optional(), arguments: extensionToolInput.optional(), inputJson: z.string().optional(), identity: optionalIdentitySchema },
    outputSchema: responseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    _meta: { 'openai/toolInvocation/invoking': 'Running extension…', 'openai/toolInvocation/invoked': 'Extension call complete' },
  }, async (input, callContext) => toToolResult(await service.call(input as JsonObject, contextFromCall(callContext)), 'Extension call completed.'));

  const safeRead = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
  const safeLocalMutation = { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false };
  /**
   * ADR-0032（#41）：direct tool 的输入形状不再手抄 zod——统一从
   * `BUILTIN_INPUT_SCHEMAS`（`invokeTool` 运行期校验的同一份 JSON Schema）派生，
   * 展示层与运行期从此不可能漂移。派生器遇到不支持的关键字会在 server 构造时
   * 直接抛错（UnsupportedSchemaError），绝不静默回退成全通 schema。
   *
   * `extraShape` 只用于**传输层专属**字段：所有工具都有的 `identity`，以及
   * session_register 的 `workspaceId`（cluster-router 消费后剥离，见
   * cluster-router.ts 的 call()——它不属于工具本身的形状，只属于 MCP 路由）。
   *
   * title/description/annotations 仍是这里的字面量：那套措辞面向 Apps/MCP 审核
   * 刻意撰写（强调"只动本地会话元数据、不联网"），与 core-tools 面向内部的
   * 描述是两个受众，不合并（详见 tool-schemas.ts 顶部说明）。
   */
  const registerDirect = (name: BuiltinToolName, title: string, description: string, annotations = safeRead, extraShape: Record<string, z.ZodType> = {}) => {
    const derived = jsonSchemaToZod(BUILTIN_INPUT_SCHEMAS[name], name) as z.ZodObject<z.ZodRawShape>;
    server.registerTool(name, {
      title, description, inputSchema: derived.extend({ ...extraShape, identity: optionalIdentitySchema }), outputSchema: responseSchema, annotations,
      _meta: { 'openai/toolInvocation/invoking': `Running ${title}…`, 'openai/toolInvocation/invoked': `${title} ready` },
    }, async (input, callContext) => {
      const { identity, ...rest } = input as JsonObject & { identity?: unknown };
      return toToolResult(await service.call({ tool: name, input: rest, ...(identity ? { identity } : {}) }, contextFromCall(callContext)), `${title} completed.`);
    });
  };

  registerDirect('session_register', 'Start local session', 'Create a local audit session or delegate a local child session. This only changes MyTerminal session metadata and does not contact external services or modify workspace files.', safeLocalMutation, { workspaceId: z.string().optional() });
  registerDirect('session_inherit', 'Claim local session', 'Claim an existing MyTerminal session. This only changes local controller metadata.', safeLocalMutation);
  registerDirect('session_checkpoint', 'Update local session', 'Record local session progress. A working checkpoint is not a stopping point; follow any returned continuation instruction immediately.', safeLocalMutation);
  registerDirect('session_list', 'List local sessions', 'Read local session metadata without changing files or contacting external services.');
  registerDirect('session_context', 'Read local session context', 'Read bounded local continuation context without changing files.');
  registerDirect('session_history', 'Read local session history', 'Read paginated local audit history without changing files.');
  registerDirect('session_release', 'Release local session', 'Release a local session controller for handoff. This does not delete session history or workspace data.', safeLocalMutation);
  registerDirect('session_events_ack', 'Acknowledge local events', 'Mark delivered local session events acknowledged while retaining permanent history.', { ...safeLocalMutation, idempotentHint: true });
  registerDirect('message_send', 'Send local session message', 'Send a message between MyTerminal sessions in the same local workspace. It does not contact people or services outside MyTerminal.', safeLocalMutation);
  registerDirect('message_inbox', 'Read local session inbox', 'Read a bounded page of MyTerminal session messages and optionally mark that page read.', { ...safeRead, readOnlyHint: false });
  registerDirect('message_list', 'List local session messages', 'Read recent local collaboration messages.');
  registerDirect('message_conversation', 'Read local session conversation', 'Read a two-way MyTerminal session conversation.');
  registerDirect('workspace_info', 'Inspect local workspace', 'Read basic metadata for the user-authorized local workspace.');
  registerDirect('list_dir', 'List local directory', 'List one directory inside the user-authorized local workspace without modifying it.');
  registerDirect('find_files', 'Find local files', 'Find file paths inside the user-authorized local workspace without modifying them.');
  registerDirect('search_text', 'Search local text', 'Search bounded text files inside the user-authorized local workspace without modifying them.');
  registerDirect('read_file', 'Read local file', 'Read one bounded file inside the user-authorized local workspace without modifying it.');
  registerDirect('read_file_range', 'Read local file lines', 'Read a bounded line range inside the user-authorized local workspace without modifying it.');
  registerDirect('git_status', 'Read Git status', 'Read Git status in the local workspace without changing the repository.');
  registerDirect('git_diff', 'Read Git diff', 'Read the local Git diff without changing the repository.');
  registerDirect('git_log', 'Read Git log', 'Read recent local Git history without changing the repository.');
  registerDirect('git_show', 'Read Git object', 'Read one bounded Git object without changing the repository.');
  registerDirect('blob_create', 'Stage local blob', 'Stage content in MyTerminal content-addressed storage without modifying workspace files or contacting external services.', { ...safeLocalMutation, idempotentHint: true });
  registerDirect('blob_read', 'Read local blob', 'Read a bounded staged MyTerminal blob without modifying workspace files.');
  registerDirect('blob_write_file', 'Create local file from blob', 'Create a workspace file from a staged blob. Repeating identical content succeeds; different existing content is not overwritten.', { ...safeLocalMutation, idempotentHint: true });
  registerDirect('task_poll', 'Poll local task', 'Read progress for a MyTerminal task that continued in the background after the 200ms fast-return budget.');

  // ── Subagent tools（ADR-0009 决策 1）──
  registerDirect('subagent_start', 'Start Subagent', 'Start a subagent for a sub-task. Asynchronous: returns taskId immediately; poll with subagent_status; completion arrives via message.', safeLocalMutation);
  registerDirect('subagent_status', 'Subagent Status', 'Query subagent progress, tasks, token usage, and result. On first call after completion, returns the result and cleans up.');
  registerDirect('subagent_abort', 'Abort Subagent', 'Abort a running subagent. Idempotent — terminal subagents return their current status.', safeLocalMutation);

  // ── Skill 工具（ADR-0037 #82：指令 mcp.ts:150 已承诺 skill() 直呼，须补齐 direct 注册）──
  // 1:1 镜像 core-tools.ts builtin `skill` 行为：无参列清单 / 有参运行（fork 走 subagent）。
  // inputSchema 由 BUILTIN_INPUT_SCHEMAS.skill 派生；注解对齐 core-tools.ts:526 四 hint。
  registerDirect('skill', 'Run skill', 'List installed skills when called without arguments, or run one by name. Inline skills return their instructions; fork skills start a subagent and return a taskId to poll with subagent_status.', safeLocalMutation);

  return server;
}

export class MyTerminalMcpTransport {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(private readonly service: ExtensionFacade) {}

  activeSessions(): number {
    return this.sessions.size;
  }

  async handle(req: Request, res: Response): Promise<void> {
    const sessionId = req.header('mcp-session-id') || undefined;
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session && req.method === 'POST' && isInitializeRequest(req.body)) {
      const server = createMcpServer(this.service);
      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { this.sessions.set(id, { server, transport }); },
        onsessionclosed: (id) => { this.service.mcpSessionClosed(id); this.sessions.delete(id); },
      });
      transport.onclose = () => { if (transport.sessionId) { this.service.mcpSessionClosed(transport.sessionId); this.sessions.delete(transport.sessionId); } };
      await server.connect(transport);
      session = { server, transport };
    }
    if (!session) {
      res.status(400).json({ error: 'Missing or invalid MCP session. Initialize with POST first.' });
      return;
    }
    await session.transport.handleRequest(req, res, req.body);
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.entries()].map(async ([id, { server, transport }]) => {
      this.service.mcpSessionClosed(id);
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }));
    this.sessions.clear();
  }
}
