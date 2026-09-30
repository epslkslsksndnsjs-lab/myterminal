import { MODULE_FLOOR_TOOLS, canonicalAgentToolName } from './agent-opts.js';
import { READ_ONLY_TOOLS } from './tool-readonly.js';
import { EXECUTE_TOOLS } from './tool-execute.js';
import { WRITE_TOOLS } from './tool-write.js';
import type { RunPaths } from './paths.js';
import type { StallProgress } from './stall.js';
import type { ToolMode } from './tool-command.js';
import type { ToolPayload } from './tool-output.js';

export type { ToolMode };

/**
 * 这一跑的工具面——模块自足的一张小表。
 *
 * 四条纪律：
 *   1. 粒度 = 单动词、单目标、原子：一个工具只做一件事、只作用于一个对象，
 *      没有"读完顺手写"的复合工具，也没有 task_* 这类自管理工具；
 *   2. 工具 floor：扇出面（再起一路 / 起 run）、消息面（向人说话、读写信箱）、
 *      控制面（问人、进-plan、碰父 run）一律不可见——递归防线里"工具面闸"这一层就是它；
 *   3. 面随模式变：默认只读面没有任何写工具，写工具只发给隔离面；
 *   4. 收窄只减不增：agent({tools}) 与 agent({disallowedTools}) 只能把面缩小，
 *      不能把 floor 禁掉的工具放回来；schema 模式的 structured_output 是出口，
 *      不在可减之列（减掉它这一路就只能靠裸文本交结构化结果，那是假开放）。
 *
 * 名字口径与缓存键同源：展示名 / 拼写名互认由 agent-opts 的归一化承担。
 */

export type ToolContext = {
  runId: string;
  dispatchId: string;
  /** 这一跑的归属边界：只读面是工作区，隔离面是那一跑的 worktree。 */
  cwd: string;
  mode: ToolMode;
  signal: AbortSignal;
  run: RunPaths;
  /** 无进展计时的挂起 / 恢复：工具在飞时不算 stall。 */
  progress?: StallProgress;
};

export type AgentTool = {
  name: string;
  /** 写类工具：只随隔离面出现（写必隔离，随边界交付一起放开）。 */
  write: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>, context: ToolContext): Promise<ToolPayload>;
};

/** 全部可执行面：只读集 + 执行集 + 写集。表只有一张，面随模式收窄。 */
export const TOOL_CATALOGUE: readonly AgentTool[] = [...READ_ONLY_TOOLS, ...EXECUTE_TOOLS, ...WRITE_TOOLS];

/** 名字 → 工具；面与表同源，查不到即"面与表不一致"的程序错，不是运行期形态。 */
const CATALOGUE_BY_NAME = new Map(TOOL_CATALOGUE.map((tool) => [tool.name, tool]));

/** 结构化出口的出口名（schema 模式由工具面自动补上，脚本不能点名要它）。 */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output';

/** 写类工具名：默认只读面上一条都不许出现，隔离面才可见（与表同源，按 write 标记派生）。 */
export const WRITE_ONLY_TOOL_NAMES: readonly string[] = TOOL_CATALOGUE.filter((tool) => tool.write).map((tool) => tool.name);

/**
 * 脚本这次请求里点名要了哪些写工具（展示名 / 拼写名互认，与缓存键同一口径）。
 * 写必隔离的判定吃这个：请求写而不标 isolation:'worktree' 的路在烧 token 前就该判败。
 */
export function requestedWriteToolNames(tools: readonly string[] | undefined): string[] {
  if (!tools) return [];
  const writes = new Set(WRITE_ONLY_TOOL_NAMES);
  return [...new Set(tools.map((name) => canonicalAgentToolName(name)).filter((name) => writes.has(name)))];
}

/** floor 禁令：这些名字出现在工具面上即结构性违规。 */
export const FLOOR_FORBIDDEN_TOOL_NAMES: readonly string[] = [
  // 扇出面：这一跑不得再起一路、再起一个 run。
  'workflow_start',
  'workflow_cancel',
  'subagent_start',
  'subagent_status',
  'subagent_abort',
  'subagent_wait',
  'wait_for_path',
  'agent',
  'parallel',
  // 消息面：不向任何人说话，也不读信箱。
  'message_send',
  'message_inbox',
  'session_context',
  'session_checkpoint',
  'session_inherit',
  // 控制面：不能问人、不能碰父 run、不能改宿主会话的玩法。
  'ask_user_question',
  'enter_plan_mode',
  'exit_plan_mode',
  'control_send',
  'skill',
  // 自管理面：任务台账属脚本与宿主，不属这一跑。
  'task_create',
  'task_update',
  'task_list',
  'task_get',
];

/** 自管理类的前缀禁令（task_* 一律不在面上，不止列出的那四个）。 */
export const FLOOR_FORBIDDEN_PREFIXES: readonly string[] = ['task_', 'workflow_', 'subagent_', 'session_', 'message_'];

/** 原子动词表：工具名的第一段必须是其中之一，出现第二段动词即复合工具。 */
export const ATOMIC_VERBS: readonly string[] = ['read', 'list', 'find', 'search', 'execute', 'write', 'apply', 'structured'];

export type FaceRefusal = { reason: string; message: string };
export type FaceResolution = { names: string[]; refusal?: undefined } | { names?: undefined; refusal: FaceRefusal };

/**
 * 模块自有的 agent 形态表：agentType 只能选这里登记过的名字，它给的是上界。
 * 上界含写工具不等于写工具可见——写类工具随模式收窄（只读面一条都不露），
 * 所以 reader 那份不含写工具的档案即使声明隔离也照样拿不到写权限。
 */
export const DEFAULT_AGENT_TYPE = 'workflow-agent';
export const AGENT_PROFILES: Readonly<Record<string, readonly string[]>> = {
  [DEFAULT_AGENT_TYPE]: ['read_file', 'read_file_range', 'list_dir', 'find_files', 'search_text', 'execute_cli', 'write_file', 'apply_patch'],
  reader: ['read_file', 'read_file_range', 'list_dir', 'find_files', 'search_text'],
};

export function toolByName(name: string): AgentTool | undefined {
  return CATALOGUE_BY_NAME.get(name);
}

/** 结构断言用：工具面是否守住 floor / 粒度 / 模式三条规矩，返回违例清单。 */
export function describeFaceViolations(names: readonly string[], mode: ToolMode): string[] {
  const violations: string[] = [];
  const floorNames = new Set(MODULE_FLOOR_TOOLS.map((tool) => tool.name));
  for (const name of names) {
    if (FLOOR_FORBIDDEN_TOOL_NAMES.includes(name) || FLOOR_FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      violations.push(`${name}: on the forbidden floor (fan-out / messaging / control / self-management)`);
    }
    if (!floorNames.has(name)) violations.push(`${name}: not a name the module publishes`);
    const segments = name.split('_');
    const verbs = segments.filter((segment) => ATOMIC_VERBS.includes(segment));
    if (verbs.length > 1) violations.push(`${name}: more than one verb in one tool`);
    if (verbs.length === 0) violations.push(`${name}: no atomic verb in the name`);
    if (mode === 'read-only' && WRITE_ONLY_TOOL_NAMES.includes(name)) violations.push(`${name}: a write tool on the read-only face`);
  }
  return violations;
}

/**
 * 这一跑能用哪些工具。
 * 任何一条不合即返回具名拒因——这些判定全在烧 token 之前跑完。
 */
export function resolveToolFace(options: {
  mode: ToolMode;
  tools?: string[];
  disallowedTools?: string[];
  agentType?: string;
  schema?: boolean;
}): FaceResolution {
  const agentType = options.agentType ?? DEFAULT_AGENT_TYPE;
  const profile = AGENT_PROFILES[agentType];
  if (!profile) {
    return { refusal: { reason: 'unknown-agent-type', message: `agent(): agentType ${JSON.stringify(agentType)} is not a type this module defines — allowed: ${Object.keys(AGENT_PROFILES).join(', ')}.` } };
  }
  const visible = TOOL_CATALOGUE.filter((tool) => options.mode === 'worktree' || !tool.write).map((tool) => tool.name);
  let names = visible.filter((name) => profile.includes(name));

  const requested = options.tools?.map((name) => canonicalAgentToolName(name)) ?? [];
  if (requested.length > 0) {
    const unavailable = requested.filter((name) => name !== STRUCTURED_OUTPUT_TOOL && !names.includes(name));
    if (unavailable.length > 0) {
      return { refusal: { reason: 'tool-unavailable-on-face', message: `agent(): ${unavailable.join(', ')} cannot run on this path's tool face (mode: ${options.mode}, agentType: ${agentType}).` } };
    }
    names = names.filter((name) => requested.includes(name));
  }
  const denied = options.disallowedTools?.map((name) => canonicalAgentToolName(name)) ?? [];
  names = names.filter((name) => !denied.includes(name) || name === STRUCTURED_OUTPUT_TOOL);
  if (options.schema) names = [...names, STRUCTURED_OUTPUT_TOOL];

  if (names.length === 0) {
    return { refusal: { reason: 'tools-narrowed-to-empty', message: 'agent(): the requested narrowing leaves this path with no tool at all.' } };
  }
  const violations = describeFaceViolations(names, options.mode);
  if (violations.length > 0) {
    return { refusal: { reason: 'floor-violation', message: `agent(): the resolved tool face breaks the module floor — ${violations.join('; ')}.` } };
  }
  return { names };
}

/**
 * 递给模型的工具声明表（名字 / 描述 / 入参形状）。
 * structured_output 不在表上——它的形状是这一路的 schema，由循环自己补。
 */
export function toolDeclarations(names: readonly string[]): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return names
    .map((name) => CATALOGUE_BY_NAME.get(name))
    .filter((tool): tool is AgentTool => tool !== undefined)
    .map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
}
