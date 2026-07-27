import type { MyTerminalConfig } from './types.js';
import { CURRENT_VERSION } from './version.js';
import { continuationPolicy, harnessRequirement } from './continuation.js';

function objectSchema(properties: Record<string, unknown>, required: string[] = [], additionalProperties: boolean | Record<string, unknown> = false) {
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties };
}

function operation(args: { operationId: string; summary: string; description: string; requestSchemaRef: string; consequential: boolean; examples: Record<string, unknown> }) {
  return {
    operationId: args.operationId, summary: args.summary, description: args.description,
    'x-openai-isConsequential': args.consequential, security: [{ bearerAuth: [] }],
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: args.requestSchemaRef }, examples: args.examples } } },
    responses: {
      200: { description: 'Operation completed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ToolResponse' } } } },
      400: { description: 'Malformed or invalid input.' }, 401: { description: 'Transport or MyTerminal session identity required.' },
      404: { description: 'Extension or resource not found.' }, 500: { description: 'Unexpected server failure.' },
    },
  };
}

function optionalIdentitySchema(description: string) {
  return { anyOf: [{ $ref: '#/components/schemas/SessionIdentity' }, { type: 'null' }], description };
}

export function buildOpenApi(config: MyTerminalConfig) {
  const stringArray = { type: 'array', items: { type: 'string' }, maxItems: 100 };
  const continuationMode = config.actionsContinuationMode || 'off';
  const policy = continuationPolicy(continuationMode);
  const exampleNextCalls = policy.exactCalls ?? (policy.enabled ? policy.maxCalls : 0);
  const identity = objectSchema({ sessionId: { type: 'string', minLength: 1 }, sessionToken: { type: 'string', minLength: 1 } }, ['sessionId', 'sessionToken']);
  const task = objectSchema({
    objective: { type: 'string', minLength: 1, maxLength: 4000 }, background: { type: 'string', minLength: 1, maxLength: 4000 },
    deliverables: { ...stringArray, minItems: 1 }, acceptanceCriteria: { ...stringArray, minItems: 1 }, constraints: { ...stringArray, minItems: 1 },
  }, ['objective', 'background', 'deliverables', 'acceptanceCriteria', 'constraints']);
  const toolInput = objectSchema({
    mode: { type: 'string', enum: ['root', 'delegate'] }, name: { type: 'string' }, role: { type: 'string' }, session: { type: 'string' }, workspaceId: { type: 'string', minLength: 1, description: 'Workspace ID returned by extensionDiscover; required when registering a root if multiple workspaces share the public port.' },
    sessionId: { type: 'string' }, sessionToken: { type: 'string' }, claimCode: { type: 'string' }, continuesSessionId: { type: 'string' }, task: { $ref: '#/components/schemas/TaskPackage' },
    phase: { type: 'string', enum: ['pending', 'working', 'waiting', 'blocked', 'completed', 'cancelled'] }, summary: { type: 'string', minLength: 1, maxLength: 4000 },
    nextSteps: stringArray, blockers: stringArray, artifacts: stringArray, milestone: { type: 'string' }, tags: stringArray,
    nextCalls: { type: 'array', minItems: policy.enabled ? policy.minCalls : 1, maxItems: policy.enabled ? policy.maxCalls : 3, items: { $ref: '#/components/schemas/PlannedToolCall' }, description: `${policy.enabled ? 'Required' : 'Optional'} for phase=working in ${continuationMode} mode. Facade operation names are not valid planned tools.` },
    replanReason: { type: 'string', minLength: 1, maxLength: 1000 }, taskId: { type: 'string' }, sha256: { type: 'string' }, encoding: { type: 'string', enum: ['utf-8', 'base64'] },
    targetSessionId: { type: 'string' }, eventIds: stringArray, to: { type: 'string' }, body: { type: 'string' }, markRead: { type: 'boolean' }, limit: { type: 'integer' },
    path: { type: 'string' }, query: { type: 'string' }, pattern: { type: 'string' }, include: { type: 'string' }, exclude: { type: 'string' }, maxResults: { type: 'integer' },
    maxBytes: { type: 'integer' }, startLine: { type: 'integer' }, endLine: { type: 'integer' }, content: { type: 'string' }, expectedSha256: { type: 'string' }, createParents: { type: 'boolean' },
    replacements: { type: 'array', items: objectSchema({ oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, ['oldText', 'newText']) },
    command: { type: 'string' }, cwd: { type: 'string' }, timeoutSec: { type: 'integer' }, revision: { type: 'string' }, includeTest: { type: 'boolean' },
    offset: { type: 'integer', minimum: 0 }, includeAncestors: { type: 'boolean' }, with: { type: 'string', description: 'Other session name or ID.' },
    provider: { type: 'string', enum: ['openai', 'anthropic', 'deepseek', 'glm', 'qwen'], description: 'Subagent LLM provider.' },
    model: { type: 'string', description: 'Subagent model name.' },
    maxTurns: { type: 'integer', minimum: 1, maximum: 200, description: 'Max subagent agent-loop turns.' },
    readOnly: { type: 'boolean', description: 'Restrict subagent to read-only tools.' },
  }, [], true);
  const plannedToolCall = objectSchema({ tool: { type: 'string', pattern: '^[a-z][a-z0-9_]{2,63}$' }, input: { type: 'object', additionalProperties: true }, purpose: { type: 'string', minLength: 1, maxLength: 500 } }, ['tool', 'input']);
  const jsonSchemaProperty = objectSchema({
    type: { type: 'string', enum: ['object', 'array', 'string', 'number', 'integer', 'boolean'] }, description: { type: 'string' }, enum: { type: 'array', items: {} }, default: {},
    minLength: { type: 'integer' }, maxLength: { type: 'integer' }, minimum: { type: 'number' }, maximum: { type: 'number' }, minItems: { type: 'integer' }, maxItems: { type: 'integer' },
    items: { type: 'object', additionalProperties: true }, properties: { type: 'object', additionalProperties: true }, required: { type: 'array', items: { type: 'string' } }, additionalProperties: {},
  }, ['type'], true);
  const jsonObjectSchema = objectSchema({
    type: { type: 'string', enum: ['object'] }, properties: { type: 'object', additionalProperties: { $ref: '#/components/schemas/JsonSchemaProperty' } },
    required: { type: 'array', items: { type: 'string' } }, additionalProperties: { type: 'boolean', enum: [false] },
  }, ['type', 'properties', 'additionalProperties']);
  const annotations = objectSchema({ readOnlyHint: { type: 'boolean' }, destructiveHint: { type: 'boolean' }, openWorldHint: { type: 'boolean' }, idempotentHint: { type: 'boolean' } }, ['readOnlyHint', 'destructiveHint', 'openWorldHint']);
  const handler = objectSchema({
    kind: { type: 'string', enum: ['builtin', 'command'] }, target: { type: 'string' }, defaults: { $ref: '#/components/schemas/ExtensionToolInput' }, executable: { type: 'string' },
    args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeoutSec: { type: 'integer', minimum: 1, maximum: 3600 },
  }, ['kind']);
  const extensionSpec = objectSchema({
    name: { type: 'string', pattern: '^[a-z][a-z0-9_]{2,63}$' }, title: { type: 'string', minLength: 1, maxLength: 100 }, description: { type: 'string', minLength: 10, maxLength: 800 },
    inputSchema: { $ref: '#/components/schemas/JsonObjectSchema' }, annotations: { $ref: '#/components/schemas/ExtensionAnnotations' }, handler: { $ref: '#/components/schemas/ExtensionHandler' },
  }, ['name', 'title', 'description', 'inputSchema', 'annotations', 'handler']);
  const error = objectSchema({ code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' }, details: { type: 'object', additionalProperties: true } }, ['code', 'message', 'retryable']);
  const event = objectSchema({ id: { type: 'string' }, recipientSessionId: { type: 'string' }, sourceSessionId: { type: 'string' }, kind: { type: 'string' }, payload: { type: 'object', additionalProperties: true }, createdAt: { type: 'string', format: 'date-time' }, acknowledgedAt: { type: 'string', format: 'date-time' } }, ['id', 'recipientSessionId', 'sourceSessionId', 'kind', 'payload', 'createdAt']);
  const response = objectSchema({ ok: { type: 'boolean' }, data: { type: 'object', additionalProperties: true }, events: { type: 'array', items: { $ref: '#/components/schemas/SessionEvent' }, maxItems: 5 }, error: { $ref: '#/components/schemas/Error' } }, ['ok']);
  const discoverRequest = objectSchema({
    query: { type: 'string', minLength: 1, maxLength: 200 }, includeSchemas: { type: 'boolean' },
    identity: optionalIdentitySchema('Omit this field during bootstrap. Explicit null is tolerated as an absent identity; never use an empty object.'),
  });
  const registerRequest = objectSchema({ action: { type: 'string', enum: ['validate', 'upsert', 'remove'] }, name: { type: 'string' }, spec: { $ref: '#/components/schemas/ExtensionSpec' }, specJson: { type: 'string' }, identity: { $ref: '#/components/schemas/SessionIdentity' } }, ['action', 'identity']);
  const callRequest = objectSchema({
    tool: { type: 'string', pattern: '^[a-z][a-z0-9_]{2,63}$' }, input: { $ref: '#/components/schemas/ExtensionToolInput' }, arguments: { $ref: '#/components/schemas/ExtensionToolInput' }, inputJson: { type: 'string' },
    identity: optionalIdentitySchema('Required for authenticated calls. For session_register(mode=root) and session_inherit, omit this field; explicit null is tolerated as absent.'),
  }, ['tool']);
  return {
    openapi: '3.1.0',
    info: { title: 'MyTerminal Extensions', version: CURRENT_VERSION, description: 'Three-operation facade with explicit, auditable MyTerminal session identity.' },
    servers: [{ url: config.publicBaseUrl }], security: [{ bearerAuth: [] }],
    paths: {
      '/actions/extensions/discover': { post: operation({ operationId: 'extensionDiscover', summary: 'Discover extensions and identity workflow', description: 'Without identity returns only bootstrap guidance. With identity returns the full catalog.', requestSchemaRef: '#/components/schemas/ExtensionDiscoverRequest', consequential: false, examples: { bootstrap: { value: {} }, catalog: { value: { identity: { sessionId: 'ses_example', sessionToken: 'token-from-registration' }, includeSchemas: true } } } }) },
      '/actions/extensions/register': { post: operation({ operationId: 'extensionRegister', summary: 'Validate or edit an extension', description: 'Requires MyTerminal identity. Validate before upsert.', requestSchemaRef: '#/components/schemas/ExtensionRegisterRequest', consequential: true, examples: { validateBuiltinAlias: { value: { identity: { sessionId: 'ses_example', sessionToken: 'token-from-registration' }, action: 'validate', spec: { name: 'list_collaborators', title: 'List collaborators', description: 'List audited collaboration sessions through a builtin alias.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, handler: { kind: 'builtin', target: 'session_list' } } } } } }) },
      '/actions/extensions/call': { post: operation({ operationId: 'extensionCall', summary: 'Invoke one concrete extension', description: `Bootstrap a root or inherit a session without identity; all other calls require identity. Actions continuation mode: ${continuationMode}. ${harnessRequirement(continuationMode)} Non-blocking tasks: ${config.nonBlockingTasksEnabled ? 'enabled; operations exceeding 200ms return a taskId for task_poll' : 'disabled; calls wait for completion or timeout (the optional enabled threshold is 200ms)'}.`, requestSchemaRef: '#/components/schemas/ExtensionCallRequest', consequential: true, examples: {
        registerRoot: { value: { tool: 'session_register', input: { mode: 'root', workspaceId: 'workspace-id-from-extensionDiscover', name: 'main', role: 'lead' } } },
        inheritChild: { value: { tool: 'session_inherit', input: { sessionId: 'ses_child', claimCode: 'one-time-code' } } },
        reclaimStale: { value: { tool: 'session_inherit', input: { sessionId: 'ses_stale', sessionToken: 'previous-session-token' } } },
        sendMessage: { value: { tool: 'message_send', identity: { sessionId: 'ses_sender', sessionToken: 'token-from-registration' }, input: { to: 'ses_recipient', body: 'Please review this change.' } } },
        workingCheckpoint: { value: { tool: 'session_checkpoint', identity: { sessionId: 'ses_sender', sessionToken: 'token-from-registration' }, input: { phase: 'working', summary: 'Continuing analysis.', ...(exampleNextCalls ? { nextCalls: Array.from({ length: exampleNextCalls }, () => ({ tool: 'workspace_info', input: {}, purpose: 'Continue the active task.' })) } : {}) } } },
        pollTask: { value: { tool: 'task_poll', identity: { sessionId: 'ses_sender', sessionToken: 'token-from-registration' }, input: { taskId: 'act_background_task_id' } } },
      } }) },
    },
    components: {
      schemas: {
        ExtensionDiscoverRequest: discoverRequest, ExtensionRegisterRequest: registerRequest, ExtensionCallRequest: callRequest,
        ExtensionToolInput: toolInput, PlannedToolCall: plannedToolCall, SessionIdentity: identity, TaskPackage: task, SessionEvent: event,
        ExtensionSpec: extensionSpec, ExtensionAnnotations: annotations, ExtensionHandler: handler,
        JsonObjectSchema: jsonObjectSchema, JsonSchemaProperty: jsonSchemaProperty, ToolResponse: response, Error: error,
      },
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'MyTerminal-token' } },
    },
  };
}
