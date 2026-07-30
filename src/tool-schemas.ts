import type { JsonSchema } from './types.js';
import { SUBAGENT_PROVIDERS } from './types.js';

/**
 * ADR-0032（#41）：工具输入 schema 的**唯一来源**。
 *
 * 在这之前每个 direct tool 的输入形状被写了两遍——`core-tools.ts` 里的 JSON Schema
 * （`invokeTool` 运行期真正校验的那份）和 `mcp.ts` 里手抄的 zod（MCP 客户端看到的那份）。
 * 两份靠人肉保持同步，于是漂了：29 个 direct tool 里 29 个存在差异（default 全丢、
 * subagent_start 的长度/条数上限全缺、session_inherit 的 minLength 全缺……）。
 * 客户端据以构造调用的 schema 和运行期拒绝它的 schema 不是同一份，这类 bug 只会在
 * 真实调用失败时才暴露。
 *
 * 现在形状只在这里声明一次：
 *   · `core-tools.ts` 直接引用它作为 `ToolDefinition.inputSchema`（运行期校验）
 *   · `mcp.ts` 经 `mcp-schema.ts` 的派生器把它转成 zod（协议层暴露）
 *   · `extensions.ts` 的 `extension_discover` 目录直接公布它
 *
 * 铁律：这里只放**形状**。title/description/annotations 不进来——MCP 侧那套措辞是面向
 * Apps/MCP 审核刻意写的（强调"只动本地会话元数据、不联网"），与 core-tools 面向内部
 * 的描述是两个受众，合并会改变客户端可见文案。
 */

// ── 复用片段（保持与原 core-tools 内联字面量逐字一致）──

const STRING_LIST: JsonSchema = { type: 'array', items: { type: 'string' }, maxItems: 100 };

const TASK_PROPERTIES: Record<string, JsonSchema> = {
  objective: { type: 'string', minLength: 1, maxLength: 4000 },
  background: { type: 'string', minLength: 1, maxLength: 4000 },
  deliverables: { ...STRING_LIST, minItems: 1 },
  acceptanceCriteria: { ...STRING_LIST, minItems: 1 },
  constraints: { ...STRING_LIST, minItems: 1 },
};

const PLANNED_CALL: JsonSchema = {
  type: 'object',
  properties: { tool: { type: 'string', minLength: 3, maxLength: 64 }, input: { type: 'object', additionalProperties: true }, purpose: { type: 'string', minLength: 1, maxLength: 500 } },
  required: ['tool', 'input'],
  additionalProperties: false,
};

/** git_status / git_diff / git_log 共用同一形状，共享同一个对象以免再次分叉。 */
const GIT_CWD_SCHEMA: JsonSchema = { type: 'object', properties: { cwd: { type: 'string' } }, additionalProperties: false };

const NO_INPUT: () => JsonSchema = () => ({ type: 'object', properties: {}, additionalProperties: false });

export const BUILTIN_INPUT_SCHEMAS = {
  // ── 工作区与文件 ──
  workspace_info: NO_INPUT(),
  list_dir: { type: 'object', properties: { path: { type: 'string', default: '.' } }, additionalProperties: false },
  find_files: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, path: { type: 'string', default: '.' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['query'], additionalProperties: false },
  search_text: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, path: { type: 'string', default: '.' }, regex: { type: 'boolean', default: false }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['query'], additionalProperties: false },
  read_file: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, maxBytes: { type: 'integer', minimum: 1, maximum: 1_000_000 } }, required: ['path'], additionalProperties: false },
  read_file_range: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['path', 'startLine', 'endLine'], additionalProperties: false },
  write_file: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' }, expectedSha256: { type: 'string' }, createParents: { type: 'boolean' } }, required: ['path', 'content'], additionalProperties: false },
  apply_patch: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, expectedSha256: { type: 'string' }, replacements: { type: 'array', minItems: 1, items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['oldText', 'newText'], additionalProperties: false } } }, required: ['path', 'replacements'], additionalProperties: false },

  // ── 暂存 blob ──
  blob_create: { type: 'object', properties: { content: { type: 'string', maxLength: 1_400_000 }, encoding: { type: 'string', enum: ['utf-8', 'base64'], default: 'utf-8' } }, required: ['content'], additionalProperties: false },
  blob_read: { type: 'object', properties: { sha256: { type: 'string', minLength: 64, maxLength: 64 }, encoding: { type: 'string', enum: ['utf-8', 'base64'], default: 'utf-8' }, maxBytes: { type: 'integer', minimum: 1, maximum: 1_000_000 } }, required: ['sha256'], additionalProperties: false },
  blob_write_file: { type: 'object', properties: { sha256: { type: 'string', minLength: 64, maxLength: 64 }, path: { type: 'string', minLength: 1 }, createParents: { type: 'boolean', default: false } }, required: ['sha256', 'path'], additionalProperties: false },

  // ── 命令与 Git ──
  execute_cli: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 20_000 }, cwd: { type: 'string' }, timeoutSec: { type: 'integer', minimum: 1, maximum: 3600 } }, required: ['command'], additionalProperties: false },
  git_status: GIT_CWD_SCHEMA,
  git_diff: GIT_CWD_SCHEMA,
  git_log: GIT_CWD_SCHEMA,
  git_show: { type: 'object', properties: { revision: { type: 'string', minLength: 1 }, cwd: { type: 'string' } }, required: ['revision'], additionalProperties: false },
  run_checks: { type: 'object', properties: { includeTest: { type: 'boolean', default: true }, cwd: { type: 'string' } }, additionalProperties: false },

  // ── 会话 ──
  session_register: { type: 'object', properties: { mode: { type: 'string', enum: ['root', 'delegate'], default: 'root' }, name: { type: 'string', minLength: 1, maxLength: 80 }, role: { type: 'string', maxLength: 80 }, continuesSessionId: { type: 'string' }, task: { type: 'object', properties: TASK_PROPERTIES, required: ['objective', 'background', 'deliverables', 'acceptanceCriteria', 'constraints'], additionalProperties: false } }, required: ['mode', 'name'], additionalProperties: false },
  session_inherit: { type: 'object', properties: { sessionId: { type: 'string', minLength: 1 }, claimCode: { type: 'string', minLength: 1 }, sessionToken: { type: 'string', minLength: 1 } }, required: ['sessionId'], additionalProperties: false },
  session_list: NO_INPUT(),
  session_checkpoint: { type: 'object', properties: { phase: { type: 'string', enum: ['pending', 'working', 'waiting', 'blocked', 'completed', 'cancelled'] }, summary: { type: 'string', minLength: 1, maxLength: 4000 }, nextSteps: STRING_LIST, blockers: STRING_LIST, artifacts: STRING_LIST, milestone: { type: 'string', maxLength: 1000 }, tags: STRING_LIST, nextCalls: { type: 'array', minItems: 1, maxItems: 3, items: PLANNED_CALL }, replanReason: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['phase', 'summary'], additionalProperties: false },
  session_context: NO_INPUT(),
  session_history: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 }, includeAncestors: { type: 'boolean', default: true } }, additionalProperties: false },
  session_release: NO_INPUT(),
  session_unregister: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false },
  session_tag: { type: 'object', properties: { tags: { ...STRING_LIST, minItems: 1 } }, required: ['tags'], additionalProperties: false },
  session_subscribe: { type: 'object', properties: { targetSessionId: { type: 'string', minLength: 1 } }, required: ['targetSessionId'], additionalProperties: false },
  session_events_ack: { type: 'object', properties: { eventIds: { ...STRING_LIST, minItems: 1, maxItems: 100 } }, required: ['eventIds'], additionalProperties: false },

  // ── 消息 ──
  message_send: { type: 'object', properties: { to: { type: 'string', minLength: 1 }, body: { type: 'string', minLength: 1, maxLength: 20_000 } }, required: ['to', 'body'], additionalProperties: false },
  message_inbox: { type: 'object', properties: { markRead: { type: 'boolean', default: false }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }, additionalProperties: false },
  message_list: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 1000 } }, additionalProperties: false },
  message_conversation: { type: 'object', properties: { with: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 5000 } }, required: ['with'], additionalProperties: false },

  // ── Skill / Subagent ──
  skill: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, additionalProperties: false },
  subagent_start: { type: 'object', properties: { objective: { type: 'string', minLength: 1, maxLength: 4000 }, background: { type: 'string', maxLength: 4000 }, deliverables: { type: 'array', items: { type: 'string' }, maxItems: 20 }, acceptanceCriteria: { type: 'array', items: { type: 'string' }, maxItems: 20 }, constraints: { type: 'array', items: { type: 'string' }, maxItems: 20 }, provider: { type: 'string', enum: [...SUBAGENT_PROVIDERS] }, model: { type: 'string' }, maxTurns: { type: 'integer', minimum: 1, maximum: 200 }, timeoutSec: { type: 'integer', minimum: 30, maximum: 3600 }, readOnly: { type: 'boolean' } }, required: ['objective'], additionalProperties: false },
  subagent_status: { type: 'object', properties: { taskId: { type: 'string', minLength: 1 } }, required: ['taskId'], additionalProperties: false },
  subagent_abort: { type: 'object', properties: { taskId: { type: 'string', minLength: 1 } }, required: ['taskId'], additionalProperties: false },

  /**
   * task_poll 不是 builtin——它由 `ExtensionService.call` 直接拦截处理，不进 builtins map。
   * 但 `extension_discover` 的目录和 MCP 的 direct tool 都要公布它的形状，所以形状归这里。
   */
  task_poll: { type: 'object', properties: { taskId: { type: 'string', minLength: 1 } }, required: ['taskId'], additionalProperties: false },
} satisfies Record<string, JsonSchema>;

export type BuiltinToolName = keyof typeof BUILTIN_INPUT_SCHEMAS;

/**
 * task_poll 的完整目录条目。`extension_discover` 把它拼进 builtin 列表，
 * MCP 侧把它注册成 direct tool——两边引用同一份，不再各写一遍。
 */
export const TASK_POLL_TOOL = {
  name: 'task_poll',
  title: 'Poll background task',
  description: 'Poll a MyTerminal operation that exceeded the 200ms fast-return budget. Keep polling the returned taskId until status is completed, failed, or timeout.',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  inputSchema: BUILTIN_INPUT_SCHEMAS.task_poll,
} as const;
