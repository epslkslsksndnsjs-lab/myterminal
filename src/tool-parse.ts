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

// ── D12 失败双帽（#32 / Q4）────────────────────────────────────────────────────
//
// error.message / error.details 通用长度帽（D12：「通用截断」，全通道通用）。
// - message → 截到 ERROR_MESSAGE_MAX_CHARS
// - details: string → 截到 ERROR_DETAILS_MAX_CHARS（Q4 双分支一；防御性：框架内
//   details 恒为 object，但自定义/扩展工具或历史路径可能传 string）
// - details: object → 逐顶层 string 值截到 ERROR_DETAILS_MAX_CHARS；保留
//   continuation 子键整体原样（D12/Q4 + D13 控制流保全）；键顺序保全
// - code / retryable 原样不动（D9/D11）；绝不插层标记（D17 静默）
// 纯函数零副作用；截断前完整 error 由 D7 审计 rawResult 保留（诊断保全）。
export const ERROR_MESSAGE_MAX_CHARS = 2000;
export const ERROR_DETAILS_MAX_CHARS = 6000;

function truncateChars(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

type ErrorShape = NonNullable<ToolResponse['error']>;

/** D12 capError：对 error.message / error.details 施加长度帽（Q4 双分支）。 */
export function capError(error: ErrorShape): ErrorShape {
  let changed = false;

  const message = truncateChars(error.message, ERROR_MESSAGE_MAX_CHARS);
  if (message !== error.message) changed = true;

  const rawDetails: unknown = error.details;
  let details: unknown = error.details;

  if (typeof rawDetails === 'string') {
    // Q4 双分支一：string details → 直接截
    const capped = truncateChars(rawDetails, ERROR_DETAILS_MAX_CHARS);
    if (capped !== rawDetails) { details = capped; changed = true; }
  } else if (Array.isArray(rawDetails)) {
    // 数组 details（非标准；扩展/历史路径可能传）：逐顶层 string 元素截，其余原样（P4：不再静默漏帽）
    const src = rawDetails as unknown[];
    const out: unknown[] = [];
    let arrChanged = false;
    for (const v of src) {
      if (typeof v === 'string') {
        const c = truncateChars(v, ERROR_DETAILS_MAX_CHARS);
        out.push(c);
        if (c !== v) arrChanged = true;
      } else {
        out.push(v);
      }
    }
    if (arrChanged) { details = out; changed = true; }
  } else if (rawDetails !== null && rawDetails !== undefined && typeof rawDetails === 'object') {
    // Q4 双分支二：object details → 逐顶层 string 值截；保留 continuation 子键
    const src = rawDetails as JsonObject;
    const out: JsonObject = {};
    let detailsChanged = false;
    for (const [k, v] of Object.entries(src)) {
      if (k === 'continuation') { out[k] = v; continue; } // 控制流子键整体原样保全（D12/Q4/D13）
      if (typeof v === 'string') {
        const c = truncateChars(v, ERROR_DETAILS_MAX_CHARS);
        out[k] = c;
        if (c !== v) detailsChanged = true;
      } else {
        out[k] = v; // 非 string 值（number/boolean/array/嵌套 object）原样
      }
    }
    if (detailsChanged) {
      details = out;
      changed = true;
    }
  }

  if (!changed) return error; // 无截断 → 返回同一引用（无副作用，保全回归基线）
  return { ...error, message, details } as ErrorShape;
}

/** 对整条响应套 D12 帽（仅 error 受影响；无 error 时返回同一引用）。 */
function capErrorResponse(response: ToolResponse): ToolResponse {
  if (!response.error) return response;
  const cappedError = capError(response.error);
  if (cappedError === response.error) return response; // 无变化 → 同引用
  return { ...response, error: cappedError };
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
 * 执行顺序（T03 + T04 #32）：
 *  - 路由判定（resolveShape）→ L1 reducer / L3(预算门) / passthrough
 *  - L1 被动/主动 reducer（零模型）→ D16 count 规则 → 重建 response（只动 data.result）
 *  - D12 失败双帽（#32）：全通道通用套用 error.message / error.details 长度帽，
 *    continuation 子键保全（Q4）；ok / error.code / error.retryable / events /
 *    data.tool / data.continuation 原样不动（D9/D11）
 *  - D7 双版本审计：rawResult 保留未截断完整 error（诊断保全）、shapedResult 为截断版 + shaping.reason
 *  - D17 静默：结果中绝不插入层标记
 *  - D11 fail-open：reducer 抛错 / 非对象 / 超预算 → 原样 passthrough，原因只进审计
 */
export function shapeToolResponse(response: ToolResponse, ctx: ShapeContext): ToolResponse {
  const toolName = typeof response.data?.tool === 'string' ? response.data.tool : '';
  const rawResult = response.data?.result;

  // 结果整形（仅 data.result / 路由）：base 为整形后响应（error 仍原样），shaping 记录结果路径决策
  let base: ToolResponse;
  let shaping: ShapingAudit;

  // 非对象 result（D11 non-object）→ 不整形 data.result
  if (rawResult === null || rawResult === undefined || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
    base = response;
    shaping = { applied: false, reason: 'non-object' };
  } else {
    const resolved = resolveShape(toolName, ctx.resolveTool(toolName));

    if (resolved.kind === 'passthrough') {
      base = response;
      shaping = { applied: false, reason: 'passthrough' };
    } else if (resolved.kind === 'l3') {
      // 预算门（D6 护栏2 / Q3）：超门直接 passthrough，记 over-budget，绝不进 L3
      if (estimateTokens(JSON.stringify(rawResult)) > RAW_BUDGET_TOKENS) {
        base = response;
        shaping = { applied: false, reason: 'over-budget' };
      } else {
        // L3 引擎在 T10 落地；T03/T04 阶段 schema 工具 fail-open passthrough（零模型底线，绝不伪造）
        base = response;
        shaping = { applied: false, reason: 'passthrough' };
      }
    } else {
      // L1 被动/主动 reducer（零模型）
      try {
        const reduced = applyCountRule(resolved.reduce(rawResult as JsonObject, ctx));
        base = { ...response, data: { ...(response.data ?? {}), result: reduced } };
        shaping = { applied: true };
      } catch {
        // D11 fail-open：reducer 抛错 → 原样 passthrough，记 reducer-threw
        base = response;
        shaping = { applied: false, reason: 'reducer-threw' };
      }
    }
  }

  // D12 失败双帽（#32）：全通道通用套用 error.message / error.details 长度帽（continuation 子键保全）。
  // D7 审计：rawResult 保留未截断完整 error（诊断保全），shapedResult 为截断版。
  // D11 fail-open：帽步骤自身异常 → 原样 passthrough（base），绝不阻断（与 L1 reducer 同形态）。
  let shaped: ToolResponse;
  try {
    shaped = capErrorResponse(base);
  } catch {
    shaped = base;
    shaping = { applied: false, reason: 'cap-threw' };
  }
  ctx.audit({ rawResult: response, shapedResult: shaped, shaping });
  return shaped;
}
