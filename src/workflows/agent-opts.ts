import { AgentCallShapeError } from './failures.js';

/**
 * agent() 的选项面——闸门在派发之前。
 *
 * 三条纪律：
 *   1. 未知键（含拼错的键）一律拒。静默吞掉会让"以为传了、其实没传"的一路
 *      按默认形状跑到底，既错又烧钱；形状错属 reject，不消耗缓存键。
 *   2. 行为相关项与纯展示项分列：进键的八项决定这一路怎么跑；
 *      label / phase / stepId / stallMs 只影响观感与计时，换它们不换键。
 *   3. 归一化在这里一次做完（档位别名、工具名的展示名与拼写名、名单排序去重），
 *      键派生只吃归一后的形态——续跑重放才不会因书写差异而漂移。
 *
 * 本票（#225）的落地边界：十二项按 ADR §9 勘误 M1 的运行时白名单收全。`model` / `schema`
 * 与 `stallMs`（#227 看门狗）当场改变执行；`tools` / `disallowedTools` / `agentType` 由
 * #228 的模块自有工具面兑现（resolveToolFace 只减不增地收窄），`isolation` 决定工具面的
 * 模式（同票），`workingDir` 交给隔离执行（#231）。
 * 之所以现在就收全：键一旦变了，续跑就要重跑；选项表必须一次定全。
 */

export const KNOWN_AGENT_OPTS = [
  'stepId',
  'label',
  'phase',
  'schema',
  'model',
  'effort',
  'agentType',
  'isolation',
  'workingDir',
  'stallMs',
  'disallowedTools',
  'tools',
] as const;

export type AgentOptName = (typeof KNOWN_AGENT_OPTS)[number];

/** 进键：这八项任一变化都意味着这一路要重跑。 */
export const DISPATCH_AFFECTING_AGENT_OPTS = [
  'schema',
  'model',
  'effort',
  'isolation',
  'agentType',
  'workingDir',
  'disallowedTools',
  'tools',
] as const satisfies readonly AgentOptName[];

/** 不进键：纯展示与计时件。 */
export const DISPLAY_ONLY_AGENT_OPTS = ['label', 'phase', 'stepId', 'stallMs'] as const satisfies readonly AgentOptName[];

export const EFFORT_TIERS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortTier = (typeof EFFORT_TIERS)[number];

const EFFORT_ALIASES: Record<string, EffortTier> = {
  low: 'low',
  medium: 'medium',
  med: 'medium',
  mid: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  'x-high': 'xhigh',
  max: 'max',
};

export const ISOLATION_MODES = ['worktree', 'remote'] as const;
export const STEP_ID_MAX = 128;

/**
 * 模块自己的工具面（与既有 subagent 工具表无关，两份实现有意独立）。
 * 展示名与拼写名互认：同一工具的不同写法共享缓存键。
 */
export const MODULE_FLOOR_TOOLS: ReadonlyArray<{ name: string; title: string }> = [
  { name: 'read_file', title: 'Read file' },
  { name: 'read_file_range', title: 'Read file lines' },
  { name: 'list_dir', title: 'List directory' },
  { name: 'find_files', title: 'Find files' },
  { name: 'search_text', title: 'Search text' },
  { name: 'write_file', title: 'Write file' },
  { name: 'apply_patch', title: 'Apply exact patch' },
  { name: 'execute_cli', title: 'Execute command' },
  { name: 'structured_output', title: 'Structured output' },
];

const TOOL_LOOKUP = new Map<string, string>();
for (const tool of MODULE_FLOOR_TOOLS) {
  TOOL_LOOKUP.set(tool.name.toLowerCase(), tool.name);
  TOOL_LOOKUP.set(tool.title.toLowerCase(), tool.name);
}

/** 形状错：调用本身写错了，不是那一跑失败。 */
export { AgentCallShapeError } from './failures.js';

function shape(message: string): never {
  throw new AgentCallShapeError(message);
}

function label(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** 归一内置工具名：已知展示名/拼写名互认，未知拼写原样归一（不判存在性）。 */
export function canonicalAgentToolName(value: unknown): string {
  if (typeof value !== 'string') return String(value);
  const collapsed = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return TOOL_LOOKUP.get(value.toLowerCase()) ?? TOOL_LOOKUP.get(collapsed) ?? collapsed;
}

/** 条目级问题（tools 白名单用；返回拒因，合法返回 undefined）。 */
export function describeToolEntryProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return `tool name must be a non-empty string (got ${label(value)})`;
  if (value !== value.trim()) return `tool name must not have surrounding spaces: ${JSON.stringify(value)}`;
  if (value.includes('*')) return `wildcard patterns are not allowed in tool names: ${value}`;
  const collapsed = canonicalAgentToolName(value);
  if (collapsed === 'exec') return 'exec is the code-mode surface, not a tool name';
  if (value.startsWith('mcp__')) {
    const segments = value.split('__');
    if (segments.length < 3) return `an MCP server as a whole cannot be allowed (${value}); name one tool`;
  }
  return undefined;
}

function gateToolList(value: unknown, field: 'tools' | 'disallowedTools'): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) shape(`agent(): ${field} must be an array of tool names (got ${label(value)})`);
  if (field === 'tools' && value.length === 0) shape('agent(): tools cannot be an empty array (that agent could do nothing)');
  const problems: string[] = [];
  for (const entry of value) {
    const problem = describeToolEntryProblem(entry);
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) shape(`agent(): ${field} rejected — ${problems.join('; ')}`);
  if (field === 'disallowedTools' && value.length === 0) return undefined;
  const canonical = value.map((entry) => canonicalAgentToolName(entry));
  return [...new Set(canonical)].sort();
}

function gateEffort(value: unknown): EffortTier | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') shape(`agent(): effort must be a string (got ${label(value)}) — allowed: ${EFFORT_TIERS.join(', ')}`);
  const tier = EFFORT_ALIASES[value.trim().toLowerCase()];
  if (!tier) shape(`agent(): effort ${JSON.stringify(value)} is not a tier — allowed: ${EFFORT_TIERS.join(', ')}`);
  return tier;
}

function gateWorkingDir(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    shape(`agent(): workingDir must be a non-empty string without surrounding spaces (got ${label(value)})`);
  }
  const segments = value.split('/');
  if (/[\\\n\r]/.test(value) || segments.some((segment) => segment === '.' || segment === '..')) {
    shape(`agent(): workingDir must be a plain absolute path with no relative segments: ${JSON.stringify(value)}`);
  }
  return value;
}

export type GatedAgentOpts = {
  stepId?: string;
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  model?: string;
  effort?: EffortTier;
  agentType?: string;
  isolation?: (typeof ISOLATION_MODES)[number];
  workingDir?: string;
  stallMs?: number;
  disallowedTools?: string[];
  tools?: string[];
};

/** 选项闸：一次把全部形状与互斥关系判完，任何一条不合即 reject。 */
export function gateAgentOpts(raw: unknown): GatedAgentOpts {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) shape(`agent(): options must be an object (got ${label(raw)})`);
  const input = raw as Record<string, unknown>;

  const unknown = Object.keys(input).filter((key) => !(KNOWN_AGENT_OPTS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    shape(`agent(): unknown option ${unknown.map((k) => JSON.stringify(k)).join(', ')} — allowed: ${KNOWN_AGENT_OPTS.join(', ')}`);
  }

  const gated: GatedAgentOpts = {};

  if (input.stepId !== undefined) {
    if (typeof input.stepId !== 'string' || input.stepId.length === 0) shape(`agent(): stepId must be a non-empty string (got ${label(input.stepId)})`);
    if (input.stepId.length > STEP_ID_MAX) shape(`agent(): stepId is limited to ${STEP_ID_MAX} characters (got ${input.stepId.length})`);
    gated.stepId = input.stepId;
  }
  for (const field of ['label', 'phase'] as const) {
    if (input[field] !== undefined) {
      if (typeof input[field] !== 'string') shape(`agent(): ${field} must be a string (got ${label(input[field])})`);
      (gated as Record<string, unknown>)[field] = input[field];
    }
  }
  if (input.schema !== undefined) {
    if (!input.schema || typeof input.schema !== 'object' || Array.isArray(input.schema) || Object.keys(input.schema as object).length === 0) {
      shape(`agent(): schema must be a non-empty JSON Schema object (got ${label(input.schema)})`);
    }
    // 脚本递过来的是沙箱 realm 的对象，留在宿主手里是隐患（getter / Proxy 会在宿主 realm 执行，
    // 跨 realm 联合类型判据也不稳）：一次 JSON 复活成宿主纯数据再往下走。
    let revived: unknown;
    try {
      revived = JSON.parse(JSON.stringify(input.schema));
    } catch {
      shape('agent(): schema must be JSON-serializable data (no functions, no cycles).');
    }
    if (!revived || typeof revived !== 'object' || Array.isArray(revived) || Object.keys(revived as object).length === 0) {
      shape(`agent(): schema must still be a non-empty JSON object after revival (got ${label(revived)})`);
    }
    gated.schema = revived as Record<string, unknown>;
  }
  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || !input.model.trim()) shape(`agent(): model must be a non-empty string (got ${label(input.model)})`);
    gated.model = input.model.trim();
  }
  if (input.agentType !== undefined) {
    if (typeof input.agentType !== 'string' || !input.agentType.trim()) shape(`agent(): agentType must be a non-empty string (got ${label(input.agentType)})`);
    gated.agentType = input.agentType.trim();
  }
  if (input.isolation !== undefined) {
    if (typeof input.isolation !== 'string' || !(ISOLATION_MODES as readonly string[]).includes(input.isolation)) {
      shape(`agent(): isolation must be one of ${ISOLATION_MODES.join(' | ')} (got ${label(input.isolation)})`);
    }
    gated.isolation = input.isolation as (typeof ISOLATION_MODES)[number];
  }
  const workingDir = gateWorkingDir(input.workingDir);
  if (workingDir !== undefined) {
    if (gated.isolation !== undefined) shape('agent(): workingDir and isolation are mutually exclusive (one pins an existing worktree, the other asks for a fresh one)');
    gated.workingDir = workingDir;
  }
  const effort = gateEffort(input.effort);
  if (effort !== undefined) gated.effort = effort;
  if (input.stallMs !== undefined) {
    if (typeof input.stallMs !== 'number' || !Number.isFinite(input.stallMs) || input.stallMs < 0) {
      shape(`agent(): stallMs must be a finite non-negative number (got ${label(input.stallMs)})`);
    }
    gated.stallMs = input.stallMs;
  }
  const tools = gateToolList(input.tools, 'tools');
  if (tools !== undefined) gated.tools = tools;
  const disallowed = gateToolList(input.disallowedTools, 'disallowedTools');
  if (disallowed !== undefined) gated.disallowedTools = disallowed;

  return gated;
}

/** 递归稳定序列化：对象键排序、undefined 与函数丢弃、原型键跳过。 */
function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item ?? null)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => key !== '__proto__').sort();
    const parts: string[] = [];
    for (const key of keys) {
      const item = record[key];
      if (item === undefined || typeof item === 'function') continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 键投影：只留行为相关项，输出稳定字符串。
 * 展示项与计时件在这里消失，因此改 label / phase / stepId / stallMs 不换键。
 */
export function canonicalAgentOpts(gated: GatedAgentOpts): string {
  const projected: Record<string, unknown> = {};
  for (const field of DISPATCH_AFFECTING_AGENT_OPTS) {
    const value = gated[field];
    if (value === undefined) continue;
    projected[field] = value;
  }
  return stableStringify(projected);
}
