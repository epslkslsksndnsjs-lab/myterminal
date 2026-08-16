import type { MyTerminalConfig } from './types.js';
import { BUILTIN_INPUT_SCHEMAS } from './tool-schemas.js';
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

// ── #146（ADR-0048 A48-W1 M2）：ExtensionToolInput 共享属性池从单源程序化聚合 ──
//
// 池字段 = BUILTIN_INPUT_SCHEMAS 全部 properties 的并集；同一字段被多个工具声明时
// 按 union-widest 合并：边界只保留「全部来源都声明」的关键字并取最宽端（min 取最小、
// max 取最大）、enum 取并集、default 仅全体一致才保留——池是 catchall 文档层，
// 永不比任一工具的单源更严（锁定测试：test/issue-146-extension-tool-input-pool.test.mjs）。
//
// 三个 facade 覆盖层不进聚合、保持手写：
//   · workspaceId —— 传输层专属（cluster-router 消费后剥离），对齐 mcp.ts extraShape 先例
//   · nextCalls —— 策略感知（continuationPolicy），单源表达不了运行模式分支
//   · task —— $ref TaskPackage；TaskPackage 本身由 session_register.task 单源派生
// PlannedToolCall 保持手写 pattern：facade 命名规则与 extensionSpec.name/callRequest.tool
// 同源，单源 PLANNED_CALL 的 minLength/maxLength 是 MCP 层近似。

const TOOL_INPUT_OVERLAYS = new Set(['workspaceId', 'nextCalls', 'task']);

/** union-widest 合并：多来源声明同一字段时逐关键字取最宽值，永不比任一工具更严。 */
function unionField(fields: unknown[]): Record<string, unknown> {
  const sources = fields.filter((f): f is Record<string, unknown> => !!f && typeof f === 'object');
  const first = sources[0];
  if (first === undefined) return {};
  const merged: Record<string, unknown> = {};
  const type = first.type;
  if (sources.every((s) => s.type === type)) merged.type = type;
  // 数值/长度/条数边界：仅当全部来源都声明才保留，取最宽端
  const minKeyword = (kw: string) => {
    if (sources.every((s) => typeof s[kw] === 'number')) merged[kw] = Math.min(...sources.map((s) => s[kw] as number));
  };
  const maxKeyword = (kw: string) => {
    if (sources.every((s) => typeof s[kw] === 'number')) merged[kw] = Math.max(...sources.map((s) => s[kw] as number));
  };
  minKeyword('minimum'); maxKeyword('maximum');
  minKeyword('minLength'); maxKeyword('maxLength');
  minKeyword('minItems'); maxKeyword('maxItems');
  // enum：仅当全部来源都声明才保留，取并集（保持首现顺序）
  if (sources.every((s) => Array.isArray(s.enum))) {
    const values: unknown[] = [];
    for (const s of sources) for (const v of s.enum as unknown[]) if (!values.includes(v)) values.push(v);
    merged.enum = values;
  }
  // default：仅当全体来源声明同一值才保留（池是文档层，不允许二义默认）
  if (sources.every((s) => 'default' in s)) {
    const firstDefault = sources[0].default;
    if (sources.every((s) => JSON.stringify(s.default) === JSON.stringify(firstDefault))) merged.default = firstDefault;
  }
  // 数组 items / 对象 properties 递归合并；required 取交集（全部声明时），additionalProperties 全 false 才 false
  if (type === 'array' && sources.every((s) => s.items !== undefined)) {
    merged.items = unionField(sources.map((s) => s.items));
  }
  if (type === 'object' && sources.every((s) => typeof s.properties === 'object' && s.properties !== null)) {
    const keys = new Set<string>();
    for (const s of sources) for (const k of Object.keys(s.properties as Record<string, unknown>)) keys.add(k);
    const properties: Record<string, unknown> = {};
    for (const k of keys) properties[k] = unionField(sources.map((s) => (s.properties as Record<string, unknown>)[k]).filter((f) => f !== undefined));
    merged.properties = properties;
    const requireds = sources.filter((s) => Array.isArray(s.required));
    if (requireds.length === sources.length) {
      const common = (requireds[0].required as unknown[]).filter((r) => requireds.every((s) => (s.required as unknown[]).includes(r)));
      if (common.length) merged.required = common;
    } else if (requireds.length === 1) {
      merged.required = requireds[0].required;
    }
    if (sources.every((s) => s.additionalProperties === false)) merged.additionalProperties = false;
  }
  return merged;
}

/** 单源全量属性并集（跳过 facade 覆盖层）。 */
function aggregateToolInputProperties(): Record<string, unknown> {
  const byField = new Map<string, unknown[]>();
  for (const schema of Object.values(BUILTIN_INPUT_SCHEMAS)) {
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    for (const [field, def] of Object.entries(properties)) {
      if (TOOL_INPUT_OVERLAYS.has(field)) continue;
      if (!byField.has(field)) byField.set(field, []);
      byField.get(field)!.push(def);
    }
  }
  const pool: Record<string, unknown> = {};
  for (const [field, defs] of byField) pool[field] = unionField(defs);
  return pool;
}

export function buildOpenApi(config: MyTerminalConfig) {
  const continuationMode = config.actionsContinuationMode || 'off';
  const policy = continuationPolicy(continuationMode);
  const exampleNextCalls = policy.exactCalls ?? (policy.enabled ? policy.maxCalls : 0);
  const identity = objectSchema({ sessionId: { type: 'string', minLength: 1 }, sessionToken: { type: 'string', minLength: 1 } }, ['sessionId', 'sessionToken']);
  // TaskPackage 由 session_register.task 单源派生（#146）——基线输出与手写版逐字一致
  const taskSource = BUILTIN_INPUT_SCHEMAS.session_register.properties!.task as { properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean | Record<string, unknown> };
  const taskPackage = objectSchema(taskSource.properties, taskSource.required ?? [], taskSource.additionalProperties);
  const pooledInput = aggregateToolInputProperties();
  const toolInput = objectSchema({
    ...pooledInput,
    // facade 覆盖层（见 #146 聚合注释）
    workspaceId: { type: 'string', minLength: 1, description: 'Workspace ID returned by extensionDiscover; required when registering a root if multiple workspaces share the public port.' },
    nextCalls: { type: 'array', minItems: policy.enabled ? policy.minCalls : 1, maxItems: policy.enabled ? policy.maxCalls : 3, items: { $ref: '#/components/schemas/PlannedToolCall' }, description: `${policy.enabled ? 'Required' : 'Optional'} for phase=working in ${continuationMode} mode. Facade operation names are not valid planned tools.` },
    task: { $ref: '#/components/schemas/TaskPackage' },
    // 池字段描述（单源不承载描述；沿用基线已公布文案，防文档回归）
    ...(pooledInput.maxTurns ? { maxTurns: { ...pooledInput.maxTurns, description: 'Max subagent agent-loop turns.' } } : {}),
    ...(pooledInput.readOnly ? { readOnly: { ...pooledInput.readOnly, description: 'Restrict subagent to read-only tools.' } } : {}),
    ...(pooledInput.with ? { with: { ...pooledInput.with, description: 'Other session name or ID.' } } : {}),
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
        ExtensionToolInput: toolInput, PlannedToolCall: plannedToolCall, SessionIdentity: identity, TaskPackage: taskPackage, SessionEvent: event,
        ExtensionSpec: extensionSpec, ExtensionAnnotations: annotations, ExtensionHandler: handler,
        JsonObjectSchema: jsonObjectSchema, JsonSchemaProperty: jsonSchemaProperty, ToolResponse: response, Error: error,
      },
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'MyTerminal-token' } },
    },
  };
}
