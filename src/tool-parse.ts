import type { InvocationContext, JsonObject, JsonSchema, ShapingAudit, ToolDefinition, ToolResponse } from './types.js';
export type { ShapingAudit } from './types.js';

/**
 * ADR-0047 — 工具结果整形系统（L1 静态规则 / L2 执行 / L3 模型）。
 *
 * T01（#29）：整形系统骨架 + 接线。`TOOL_SHAPES` 空注册表 + `shapeToolResponse(response, ctx)`
 * 签名改造，所有工具响应经 shaper 后与未接线时逐字段一致（passthrough），建立零行为变化
 * 回归基线。
 * T03（#31）：L2 引擎核心 + 被动去噪成功路径——路由（内联 shapeResult → 中心表
 * TOOL_SHAPES[reduce→L1 / schema→L3] → passthrough）、6 工具 CommandResult 被动去噪
 * （复用同一 reducer，剥 command/cwd/signal/timedOut/cancelled）、预算门（estimateTokens +
 * RAW_BUDGET_TOKENS）、D16 count 引擎规则、D7 双版本审计（raw + shaped + shaping.reason）、
 * D17 静默（结果中无任何层标记）。L1/L2 零模型；L3 引擎在 T10 落地，T03 阶段 schema 工具
 * fail-open passthrough（不伪造）。
 */

/** 整形介入原因（D7/D11 权威枚举；T03 实际产生 passthrough / over-budget / non-object / reducer-threw / 成功 applied） */
export type ShapingReason =
  | 'reducer-threw'
  | 'l3-unavailable-timeout'
  | 'non-object'
  | 'over-budget'
  | 'nested-over-budget'
  | 'quota'
  | 'passthrough';

/** 整形审计记录（D7）：`{ applied, reason? }`，只进审计、永不进模型上下文（D17）。类型单源在 types.ts。 */
export type ShapingAuditRecord = {
  rawResult: ToolResponse;
  shapedResult: ToolResponse;
  shaping: ShapingAudit;
};

/**
 * L1 reducer：输入工具原始 `data.result`，返回去噪/精简后结果（零模型）。
 * 第二参 `ctx` 供主动精简型 reducer（D15/T07+）读取 transport/sessionId。
 */
export type ToolReducer = (result: JsonObject, ctx: ShapeContext) => JsonObject;

/**
 * L1 中心注册表条目（D5/D10：主注册表）。
 * - `reduce` → L1 静态规则层（被动去噪 / 主动精简，零模型）
 * - `schema` → L3 模型层（脏乱/嵌套结果走本地小模型；引擎在 T10 落地，T03 阶段 fail-open）
 * 未声明（无 reduce 无 schema）→ passthrough（绝不套壳）。
 */
export type ToolShape = {
  reduce?: ToolReducer;
  schema?: JsonSchema;
};

// ── 预算门（D6 护栏2 / Q3）─────────────────────────────────────────────────────
//
// 进 L3 前量 estimateTokens(safeRaw) ≤ RAW_BUDGET_TOKENS，超限 → 直接 passthrough
// （不调模型），审计记 reason `over-budget`。
// 阈值公式 RAW_BUDGET_TOKENS = min(24000, L3_ctx − 2048)；T11 实测 L3 ctx 回标前，
// L3 ctx 未知，用公式默认值 24000（ctx≥26048 时门槛维持 24K，因 26048−2048=24000）。
export const RAW_BUDGET_TOKENS = 24000;

/**
 * 语言感知 token 估算（D6/Q3）：中文≈chars×1.5、英文≈chars÷4（无 tokenizer 时用启发式）。
 * 与 subagent/token-counter.ts 的 compaction 估算（char/4×4/3，语言无关）用途不同，不复用。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let latin = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK 统一表意文字区（含扩展 A）粗略判定；其余按拉丁/符号计（÷4）
    if (code >= 0x2e80 && code <= 0x9fff) cjk++;
    else latin++;
  }
  return Math.ceil(cjk * 1.5 + latin / 4);
}

// ── 被动去噪（L1 reducer 变体一）──────────────────────────────────────────────
//
// CommandResult 权威 10 字段（core-tools.ts runCommand 返回，ADR-0047 补遗3
// evidence-locked）：command / cwd / exitCode / signal / timedOut / stdout /
// stderr / truncated / durationMs / cancelled。其中 command / cwd / signal /
// timedOut / cancelled 是噪声（执行痕迹，模型消费无需），剥除；其余 5 字段是
// 答案本身（stdout/stderr 等真实数据），保留。
const COMMAND_RESULT_NOISE = ['command', 'cwd', 'signal', 'timedOut', 'cancelled'];

/** 被动去噪 reducer：剥已知噪声字段（command/cwd/signal/timedOut/cancelled），不改数据内容。 */
function denoiseCommandResult(result: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(result)) {
    if (COMMAND_RESULT_NOISE.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

// ── D16 count 引擎规则 ────────────────────────────────────────────────────────
//
// reducer 产出数组自动补 count（数组实际长度）。单数组字段场景：直接加 `count`
// （与 D16 示例 matches→count / commits→count 一致）。多数组聚合 opt-in（D16.3）
// 留待 D15/T07 按工具声明，T03 不处理多数组。
function applyCountRule(result: JsonObject): JsonObject {
  const arrayKeys = Object.keys(result).filter((k) => Array.isArray(result[k]));
  if (arrayKeys.length === 1 && !('count' in result) && !('totalCount' in result)) {
    result.count = (result[arrayKeys[0]] as unknown[]).length;
  }
  return result;
}

// ── L1 中心注册表（D5/D10：主注册表）──────────────────────────────────────────
//
// T03：6 工具 CommandResult 被动去噪（复用同一 denoiseCommandResult reducer）。
// 其余工具未声明 → passthrough。L3（schema）条目在 T10 落地。
export const TOOL_SHAPES: Map<string, ToolShape> = new Map([
  ['execute_cli', { reduce: denoiseCommandResult }],
  ['git_status', { reduce: denoiseCommandResult }],
  ['git_diff', { reduce: denoiseCommandResult }],
  ['git_log', { reduce: denoiseCommandResult }],
  ['git_show', { reduce: denoiseCommandResult }],
  ['run_checks', { reduce: denoiseCommandResult }],
]);

/** shapeToolResponse 上下文（ADR「实现前置」签名：transport / sessionId / resolveTool / audit） */
export type ShapeContext = {
  transport: InvocationContext['transport'];
  /** 会话标识；bootstrap（session_register / session_inherit 无 identity）时缺省 */
  sessionId?: string;
  /** 按工具名解析 ToolDefinition（builtin + custom），未注册 → undefined */
  resolveTool: (name: string) => ToolDefinition | undefined;
  /** 审计接收器：整形记录只进审计、永不进模型上下文（D7/D11/D17） */
  audit: (record: ShapingAuditRecord) => void;
};

// ── L2 执行层：路由判定（解析顺序，D5/D3）─────────────────────────────────────
//
// 1) 内联 ToolDefinition.shapeResult → L1
// 2) 中心表 TOOL_SHAPES：reduce → L1 / schema → L3
// 3) 都无 → passthrough（D3 未声明工具原样放行）
// 零额外运行时判断（D3/D18.1 mode-agnostic）；L1/L2 零模型。
type ResolvedShape =
  | { kind: 'l1'; reduce: ToolReducer }
  | { kind: 'l3'; schema: JsonSchema }
  | { kind: 'passthrough' };

function resolveShape(toolName: string, toolDef: ToolDefinition | undefined): ResolvedShape {
  if (toolDef?.shapeResult) return { kind: 'l1', reduce: toolDef.shapeResult };
  const shape = TOOL_SHAPES.get(toolName);
  if (shape?.reduce) return { kind: 'l1', reduce: shape.reduce };
  if (shape?.schema) return { kind: 'l3', schema: shape.schema };
  return { kind: 'passthrough' };
}

/**
 * 工具响应整形入口（D13：包住最终装饰响应，含 decorateContinuation 后的长任务结构）。
 *
 * 执行顺序（T03）：
 *  - 路由判定（resolveShape）→ L1 reducer / L3(预算门) / passthrough
 *  - L1 被动/主动 reducer（零模型）→ D16 count 规则 → 重建 response（只动 data.result，
 *    ok/error/events/data.tool/data.continuation 原样不动，D9）
 *  - D7 双版本审计：整形前记 rawResult、整形后记 shapedResult + shaping.reason
 *  - D17 静默：结果中绝不插入层标记
 *  - D11 fail-open：reducer 抛错 / 非对象 / 超预算 → 原样 passthrough，原因只进审计
 */
export function shapeToolResponse(response: ToolResponse, ctx: ShapeContext): ToolResponse {
  const toolName = typeof response.data?.tool === 'string' ? response.data.tool : '';
  const rawResult = response.data?.result;

  // 非对象 result（D11 non-object）→ 原样 passthrough，记原因
  if (rawResult === null || rawResult === undefined || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
    ctx.audit({ rawResult: response, shapedResult: response, shaping: { applied: false, reason: 'non-object' } });
    return response;
  }

  const resolved = resolveShape(toolName, ctx.resolveTool(toolName));

  if (resolved.kind === 'passthrough') {
    ctx.audit({ rawResult: response, shapedResult: response, shaping: { applied: false, reason: 'passthrough' } });
    return response;
  }

  if (resolved.kind === 'l3') {
    // 预算门（D6 护栏2 / Q3）：超门直接 passthrough，记 over-budget，绝不进 L3
    if (estimateTokens(JSON.stringify(rawResult)) > RAW_BUDGET_TOKENS) {
      ctx.audit({ rawResult: response, shapedResult: response, shaping: { applied: false, reason: 'over-budget' } });
      return response;
    }
    // L3 引擎在 T10 落地；T03 阶段 schema 工具 fail-open passthrough（零模型底线，绝不伪造）
    ctx.audit({ rawResult: response, shapedResult: response, shaping: { applied: false, reason: 'passthrough' } });
    return response;
  }

  // L1 被动/主动 reducer（零模型）
  try {
    const reduced = applyCountRule(resolved.reduce(rawResult as JsonObject, ctx));
    const shaped: ToolResponse = { ...response, data: { ...(response.data ?? {}), result: reduced } };
    ctx.audit({ rawResult: response, shapedResult: shaped, shaping: { applied: true } });
    return shaped;
  } catch {
    // D11 fail-open：reducer 抛错 → 原样 passthrough，记 reducer-threw
    ctx.audit({ rawResult: response, shapedResult: response, shaping: { applied: false, reason: 'reducer-threw' } });
    return response;
  }
}
