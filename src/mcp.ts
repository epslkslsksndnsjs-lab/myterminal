import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ExtensionService } from './extensions.js';
import type { InvocationContext, JsonObject, ToolResponse } from './types.js';
import { CURRENT_VERSION } from './version.js';

type LiveSession = { server: McpServer; transport: StreamableHTTPServerTransport };

export type ExtensionFacade = Pick<ExtensionService, 'discover' | 'register' | 'call'>;

const responseSchema = {
  ok: z.boolean(),
  data: z.record(z.string(), z.unknown()).optional(),
  events: z.array(z.record(z.string(), z.unknown())).optional(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), details: z.record(z.string(), z.unknown()).optional() }).optional(),
};

const identitySchema = z.object({ sessionId: z.string().min(1), sessionToken: z.string().min(1) });
const optionalIdentitySchema = identitySchema.nullish();

const extensionToolInput = z.object({
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
  const meta = (callContext as { _meta?: Record<string, unknown> } | undefined)?._meta;
  return {
    transport: 'apps',
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
  const registerDirect = (name: string, title: string, description: string, inputSchema: Record<string, z.ZodType>, annotations = safeRead) => {
    server.registerTool(name, {
      title, description, inputSchema, outputSchema: responseSchema, annotations,
      _meta: { 'openai/toolInvocation/invoking': `Running ${title}…`, 'openai/toolInvocation/invoked': `${title} ready` },
    }, async (input, callContext) => toToolResult(await service.call({ tool: name, input: input as JsonObject }, contextFromCall(callContext)), `${title} completed.`));
  };
  const stringList = z.array(z.string()).max(100);
  const plannedCall = z.object({ tool: z.string().min(3).max(64), input: z.record(z.string(), z.unknown()), purpose: z.string().min(1).max(500).optional() });
  const taskPackage = z.object({
    objective: z.string().min(1).max(4000), background: z.string().min(1).max(4000),
    deliverables: stringList.min(1), acceptanceCriteria: stringList.min(1), constraints: stringList.min(1),
  });

  registerDirect('session_register', 'Start local session', 'Create a local audit session or delegate a local child session. This only changes MyTerminal session metadata and does not contact external services or modify workspace files.', {
    mode: z.enum(['root', 'delegate']), name: z.string().min(1).max(80), role: z.string().max(80).optional(), continuesSessionId: z.string().optional(), task: taskPackage.optional(), workspaceId: z.string().optional(),
  }, safeLocalMutation);
  registerDirect('session_inherit', 'Claim local session', 'Claim an existing MyTerminal session. This only changes local controller metadata.', { sessionId: z.string().min(1), claimCode: z.string().optional(), sessionToken: z.string().optional() }, safeLocalMutation);
  registerDirect('session_checkpoint', 'Update local session', 'Record local session progress. A working checkpoint is not a stopping point; follow any returned continuation instruction immediately.', {
    phase: z.enum(['pending', 'working', 'waiting', 'blocked', 'completed', 'cancelled']), summary: z.string().min(1).max(4000), nextSteps: stringList.optional(), blockers: stringList.optional(), artifacts: stringList.optional(), milestone: z.string().max(1000).optional(), tags: stringList.optional(), nextCalls: z.array(plannedCall).min(1).max(3).optional(), replanReason: z.string().max(1000).optional(),
  }, safeLocalMutation);
  registerDirect('session_list', 'List local sessions', 'Read local session metadata without changing files or contacting external services.', {}, safeRead);
  registerDirect('session_context', 'Read local session context', 'Read bounded local continuation context without changing files.', {}, safeRead);
  registerDirect('session_history', 'Read local session history', 'Read paginated local audit history without changing files.', { offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional(), includeAncestors: z.boolean().optional() }, safeRead);
  registerDirect('session_release', 'Release local session', 'Release a local session controller for handoff. This does not delete session history or workspace data.', {}, safeLocalMutation);
  registerDirect('session_events_ack', 'Acknowledge local events', 'Mark delivered local session events acknowledged while retaining permanent history.', { eventIds: stringList.min(1) }, { ...safeLocalMutation, idempotentHint: true });
  registerDirect('message_send', 'Send local session message', 'Send a message between MyTerminal sessions in the same local workspace. It does not contact people or services outside MyTerminal.', { to: z.string().min(1), body: z.string().min(1).max(20_000) }, safeLocalMutation);
  registerDirect('message_inbox', 'Read local session inbox', 'Read a bounded page of MyTerminal session messages and optionally mark that page read.', { markRead: z.boolean().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() }, { ...safeRead, readOnlyHint: false });
  registerDirect('message_list', 'List local session messages', 'Read recent local collaboration messages.', { limit: z.number().int().min(1).max(1000).optional() }, safeRead);
  registerDirect('message_conversation', 'Read local session conversation', 'Read a two-way MyTerminal session conversation.', { with: z.string().min(1), limit: z.number().int().min(1).max(5000).optional() }, safeRead);
  registerDirect('workspace_info', 'Inspect local workspace', 'Read basic metadata for the user-authorized local workspace.', {}, safeRead);
  registerDirect('list_dir', 'List local directory', 'List one directory inside the user-authorized local workspace without modifying it.', { path: z.string().optional() }, safeRead);
  registerDirect('find_files', 'Find local files', 'Find file paths inside the user-authorized local workspace without modifying them.', { query: z.string().min(1), path: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }, safeRead);
  registerDirect('search_text', 'Search local text', 'Search bounded text files inside the user-authorized local workspace without modifying them.', { query: z.string().min(1), path: z.string().optional(), regex: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() }, safeRead);
  registerDirect('read_file', 'Read local file', 'Read one bounded file inside the user-authorized local workspace without modifying it.', { path: z.string().min(1), maxBytes: z.number().int().min(1).max(1_000_000).optional() }, safeRead);
  registerDirect('read_file_range', 'Read local file lines', 'Read a bounded line range inside the user-authorized local workspace without modifying it.', { path: z.string().min(1), startLine: z.number().int().min(1), endLine: z.number().int().min(1) }, safeRead);
  registerDirect('git_status', 'Read Git status', 'Read Git status in the local workspace without changing the repository.', { cwd: z.string().optional() }, safeRead);
  registerDirect('git_diff', 'Read Git diff', 'Read the local Git diff without changing the repository.', { cwd: z.string().optional() }, safeRead);
  registerDirect('git_log', 'Read Git log', 'Read recent local Git history without changing the repository.', { cwd: z.string().optional() }, safeRead);
  registerDirect('git_show', 'Read Git object', 'Read one bounded Git object without changing the repository.', { revision: z.string().min(1), cwd: z.string().optional() }, safeRead);
  registerDirect('blob_create', 'Stage local blob', 'Stage content in MyTerminal content-addressed storage without modifying workspace files or contacting external services.', { content: z.string().max(1_400_000), encoding: z.enum(['utf-8', 'base64']).optional() }, { ...safeLocalMutation, idempotentHint: true });
  registerDirect('blob_read', 'Read local blob', 'Read a bounded staged MyTerminal blob without modifying workspace files.', { sha256: z.string().length(64), encoding: z.enum(['utf-8', 'base64']).optional(), maxBytes: z.number().int().min(1).max(1_000_000).optional() }, safeRead);
  registerDirect('blob_write_file', 'Create local file from blob', 'Create a workspace file from a staged blob. Repeating identical content succeeds; different existing content is not overwritten.', { sha256: z.string().length(64), path: z.string().min(1), createParents: z.boolean().optional() }, { ...safeLocalMutation, idempotentHint: true });
  registerDirect('task_poll', 'Poll local task', 'Read progress for a MyTerminal task that continued in the background after the 200ms fast-return budget.', { taskId: z.string().min(1) }, safeRead);
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
        onsessionclosed: (id) => { this.sessions.delete(id); },
      });
      transport.onclose = () => { if (transport.sessionId) this.sessions.delete(transport.sessionId); };
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
    await Promise.all([...this.sessions.values()].map(async ({ server, transport }) => {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }));
    this.sessions.clear();
  }
}
