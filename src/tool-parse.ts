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
 * T05（#33）：D13 task_poll 递归整形（嵌套 operation.data.result 走 L2 路由 + operation.error
 * 走 D12 帽，保全 operation.ok / data.tool）+ Q7 嵌套预算门（超 RAW_BUDGET_TOKENS fail-open 回
 * 原始 operation）+ Q6 递归 fail-open（异常整层回退原始 operation，绝不半成品）+ Q8 operation
 * 缓存（key = taskId + raw 哈希，命中免重整形 / 免重复 L3 配额；clearOperationCache 清理）+ Q10
 * 嵌套审计（递归调用自身产嵌套 raw/shaped + 外层全量 response 快照）。
 */

/** 整形介入原因（D7/D11 权威枚举；T03/T04 实际产生 passthrough / over-budget / non-object / reducer-threw / cap-threw / 成功 applied） */
export type ShapingReason =
  | 'reducer-threw'
  | 'l3-unavailable-timeout'
  | 'non-object'
  | 'over-budget'
  | 'nested-over-budget'
  | 'nested-recursion-threw'
  | 'quota'
  | 'passthrough'
  | 'cap-threw';

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

// ── D15 主动精简（T07）：session_list 长文本截断 + 限条目 + 分页 ────────────────
//
// 字段分级白名单（D15 控制护栏三件套之一）：protected 答案本身（身份 / 状态 / 时间戳 /
// 结构）绝不截断；reducible 长文本元数据摘要可精简。仅下列点路径上的 string 值参与截断。
export const REDUCIBLE_TEXT_MAX_CHARS = 500; // 触发截断阈值：字段长度超过即截断（保留头尾 + 标记）
const REDUCIBLE_TEXT_HEAD_CHARS = 420; // 截断后保留的头部长度
const REDUCIBLE_TEXT_TAIL_CHARS = 60; // 截断后保留的尾部长度（head+tail=480 < MAX 500，标记另占 ~20，故输出约 500）
const SESSION_REDUCIBLE_TEXT_FIELDS: string[][] = [
  ['finalSummary'],
  ['task', 'objective'],
  ['task', 'background'],
  ['latestCheckpoint', 'summary'],
];

/** 取嵌套路径值（只读）。 */
function getPathValue(obj: JsonObject, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as JsonObject)[key];
  }
  return cur;
}

/**
 * 对单条 session 条目截断 reducible 长文本字段（默认 500 chars，保留头尾 + 标记），
 * protected 字段原样。返回截断后条目与截断字段数。不可变：逐路径浅拷贝受影响子树。
 */
function truncateReducibleText(entry: JsonObject): { entry: JsonObject; truncatedFields: number } {
  let truncatedFields = 0;
  const out: JsonObject = { ...entry };
  for (const path of SESSION_REDUCIBLE_TEXT_FIELDS) {
    const value = getPathValue(out, path);
    if (typeof value === 'string' && value.length > REDUCIBLE_TEXT_MAX_CHARS) {
      const head = REDUCIBLE_TEXT_HEAD_CHARS;
      const tail = REDUCIBLE_TEXT_TAIL_CHARS;
      const omitted = value.length - (head + tail);
      const kept = value.slice(0, head) + `...[truncated ${omitted} chars]` + value.slice(value.length - tail);
      // 写回嵌套路径（逐层浅拷贝，保全其余字段）
      let cur: JsonObject = out;
      for (let i = 0; i < path.length - 1; i++) {
        const k = path[i];
        cur[k] = { ...(cur[k] as JsonObject) };
        cur = cur[k] as JsonObject;
      }
      cur[path[path.length - 1]] = kept;
      truncatedFields++;
    }
  }
  return { entry: out, truncatedFields };
}

/**
 * D15/T07 主动精简 reducer（session_list）：限条目 + 长文本截断 + count/totalCount +
 * 分页提示。输入 data.result = { sessions, total, page:{offset,limit} }（handler 已按
 * offset/limit 切片并上报 total/page）。protected 字段原样；reducible 长文本截到 500
 * chars 头尾保留 + 标记。返回内部提示 pagination（L2 剥离后发射 data.continuation.
 * pagination）与 __reduction（L2 剥离后写入审计，绝不进模型上下文，D17）。
 */
function reduceSessionList(result: JsonObject, _ctx: ShapeContext): JsonObject {
  const sessionsIn = Array.isArray(result.sessions) ? (result.sessions as JsonObject[]) : [];
  const total = typeof result.total === 'number' ? result.total : sessionsIn.length;
  const page = isPlainObject(result.page) ? (result.page as JsonObject) : {};
  const offset = typeof page.offset === 'number' ? page.offset : 0;
  const limit = typeof page.limit === 'number' ? page.limit : sessionsIn.length;

  let fieldsReduced = 0;
  const visible = sessionsIn.map((s) => {
    if (!isPlainObject(s)) return s; // 非对象条目原样保全（防御）
    const { entry, truncatedFields } = truncateReducibleText(s);
    fieldsReduced += truncatedFields;
    return entry;
  });

  const truncated = total > offset + limit;
  const count = visible.length;
  const entriesTruncated = Math.max(0, total - count);

  const originalSize = JSON.stringify(sessionsIn).length;
  const reducedSize = JSON.stringify(visible).length;

  const pagination: JsonObject = {
    truncated,
    ...(truncated
      ? { nextCall: { tool: 'session_list', input: { offset: offset + limit, limit }, purpose: 'fetch next page of sessions' } }
      : {}),
  };

  return {
    sessions: visible,
    count,
    totalCount: total,
    truncated,
    pagination,
    __reduction: { fieldsReduced, entriesTruncated, originalSize, reducedSize },
  };
}

// ── L1 中心注册表（D5/D10：主注册表）──────────────────────────────────────────
//
// T03：6 工具 CommandResult 被动去噪（复用同一 denoiseCommandResult reducer）。
// T07：session_list 主动精简（D15 前半）。其余工具未声明 → passthrough。
// L3（schema）条目在 T10 落地。
export const TOOL_SHAPES: Map<string, ToolShape> = new Map([
  ['session_list', { reduce: reduceSessionList }],
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

// ── D13 递归（task_poll 嵌套 operation 整形）+ Q6/Q7/Q8 护栏 ──────────────────
//
// D13：当 tool==='task_poll' 且 data.result.operation 是完整 ToolResponse 时，递归整形
//   operation.data.result（走 L2 执行层路由：L1 reducer / L3 / passthrough）与
//   operation.error（走 D12 双帽）。仅整形 operation 这一层，保全 operation.ok 与
//   operation.data.tool（长任务成败信号 / 嵌套工具身份），绝不整把递归。
// Q7：进 operation 整形前量嵌套 raw（estimateTokens(JSON.stringify(operation))），超
//   RAW_BUDGET_TOKENS → 该嵌套层 fail-open 回原始 operation（外层 task_poll 结构保留），
//   不让超大嵌套进 L3、也不绕过预算门。
// Q6：递归层整体 try/catch，任一异常 → 用原始 operation 整体替换，绝不返回半成品；
//   与 D11 fail-open 一致，审计记 nested-recursion-threw。
// Q8：按 operation 身份缓存已整形结果（key = taskId + raw 内容哈希）；同 key 再次 poll
//   直接返回缓存版，不重复触发 L3、不重复计 D6 配额；缓存随 task 完成/会话结束清理
//   （clearOperationCache）。
// Q10：D7 审计覆盖嵌套 operation——递归调用自身即产生嵌套 raw/shaped 审计；外层再抓
//   全量 response 前后快照，双层覆盖。

function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** task_poll result 是否含完整嵌套 operation（ToolResponse 形态：有 data 对象）。 */
function isNestedOperation(rawResult: unknown): rawResult is { operation: ToolResponse } & JsonObject {
  if (!isPlainObject(rawResult)) return false;
  const op = (rawResult as JsonObject).operation;
  return isPlainObject(op) && isPlainObject((op as JsonObject).data);
}

// Q8 缓存：key = `${taskId} ${hash}` 或 `${hash}`（无 taskId）；命中直接返回缓存版。
const operationCache = new Map<string, { op: ToolResponse; reason: ShapingReason | undefined }>();
const OPERATION_CACHE_MAX = 512;

/** FNV-1a 32-bit 哈希（确定性、跨进程稳定），用于 operation 内容指纹。 */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Q8 清理：不传 taskId → 清全量；传 taskId → 只清该 task 的缓存条目（task 完成/会话结束）。
 * 由调用方（server.ts / extensions.ts 接线处）在合适时机调用；本模块只暴露原语。
 */
export function clearOperationCache(taskId?: string): void {
  if (taskId === undefined) {
    operationCache.clear();
    return;
  }
  const prefix = `${taskId} `;
  for (const key of operationCache.keys()) {
    if (key.startsWith(prefix)) operationCache.delete(key);
  }
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
        const reducedRaw = resolved.reduce(rawResult as JsonObject, ctx);
        const reduced = applyCountRule(reducedRaw);
        // 剥离 active-trim reducer 返回的内部提示（绝不进模型上下文，D17）：
        //  - pagination → L2 合并发射 data.continuation.pagination
        //  - __reduction → 写入审计精简详情
        const pagination = (reduced as JsonObject).pagination;
        const reduction = (reduced as JsonObject).__reduction;
        delete (reduced as JsonObject).pagination;
        delete (reduced as JsonObject).__reduction;
        base = { ...response, data: { ...(response.data ?? {}), result: reduced } };
        shaping = { applied: true };
        // D15/T07：L2 是唯一发射方——把 reducer 的 pagination 提示合并进 data.continuation
        // （不覆盖 decorateContinuation 的控制流 continuation；控制流 continuation 在 extensions.ts 注入，
        //  此处只在其上叠加 pagination 子键）
        if (pagination && isPlainObject(pagination) && !!(pagination as JsonObject).truncated) {
          const p = pagination as JsonObject;
          const existing = (base.data as JsonObject | undefined)?.continuation;
          const paginationContinuation: JsonObject = {
            pagination: {
              truncated: true,
              ...(p.nextCall ? { nextCall: p.nextCall } : {}),
            },
          };
          (base.data as JsonObject).continuation = existing && isPlainObject(existing)
            ? { ...(existing as JsonObject), ...paginationContinuation }
            : paginationContinuation;
        }
        // D15/T07 审计：精简详情（raw 完整版已由 D7 保留）
        if (reduction && isPlainObject(reduction)) {
          const r = reduction as JsonObject;
          shaping = {
            ...shaping,
            reduced: true,
            fieldsReduced: typeof r.fieldsReduced === 'number' ? r.fieldsReduced : 0,
            entriesTruncated: typeof r.entriesTruncated === 'number' ? r.entriesTruncated : 0,
            originalSize: typeof r.originalSize === 'number' ? r.originalSize : 0,
            reducedSize: typeof r.reducedSize === 'number' ? r.reducedSize : 0,
          };
        }
      } catch {
        // D11 fail-open：reducer 抛错 → 原样 passthrough，记 reducer-threw
        base = response;
        shaping = { applied: false, reason: 'reducer-threw' };
      }
    }
  }

  // ── D13 递归（task_poll 嵌套 operation 整形）+ Q6/Q7/Q8 ──
  // 仅对 task_poll 的嵌套 operation 整形；其他控制工具（session_checkpoint 等）不在注册表
  // → 走下方 passthrough，无副作用（D13 关键坑）。
  if (toolName === 'task_poll' && isNestedOperation(rawResult)) {
    const result = rawResult as JsonObject;
    const op = result.operation as ToolResponse;
    const taskId = typeof result.taskId === 'string' ? (result.taskId as string) : undefined;
    const opJson = JSON.stringify(op);
    const cacheKey = taskId !== undefined ? `${taskId} ${hashString(opJson)}` : hashString(opJson);

    let shapedOperation: ToolResponse;
    let cacheReason: ShapingReason | undefined;

    const cached = operationCache.get(cacheKey);
    if (cached !== undefined) {
      // Q8 命中：直接返回缓存版，不重复触发 L3、不重复计 D6 配额
      shapedOperation = cached.op;
      cacheReason = cached.reason;
    } else {
      if (estimateTokens(opJson) > RAW_BUDGET_TOKENS) {
        // Q7 嵌套预算门：超大嵌套 fail-open 回原始 operation（外层 task_poll 结构保留），
        // 不让超大嵌套进 L3、也不绕过预算门
        shapedOperation = op;
        cacheReason = 'nested-over-budget';
      } else {
        try {
          // Q6 try/catch：递归整形嵌套 operation（L2 路由 operation.data.result + D12 帽
          // operation.error，保全 operation.ok / data.tool）；递归调用自身亦产嵌套审计（Q10）
          shapedOperation = shapeToolResponse(op, ctx);
        } catch {
          // Q6 fail-open：递归层任一异常 → 用原始 operation 整体替换，绝不返回半成品
          shapedOperation = op;
          cacheReason = 'nested-recursion-threw';
        }
      }
      // Q8 仅缓存「整形成功」结果（cacheReason === undefined）；fail-open 路径不消费 L3
      // 配额，缓存它零收益且会冻结瞬时失败（如 L3 冷加载超时 / audit 通道抖动），故不缓存。
      if (cacheReason === undefined) {
        if (operationCache.size >= OPERATION_CACHE_MAX) {
          const oldest = operationCache.keys().next().value;
          if (oldest !== undefined) operationCache.delete(oldest);
        }
        operationCache.set(cacheKey, { op: shapedOperation, reason: cacheReason });
      }
    }

    // 重建 response：仅替换 result.operation，保全其余字段（status / taskId / continuation 等）
    base = {
      ...base,
      data: { ...(base.data ?? {}), result: { ...result, operation: shapedOperation } },
    };
    // Q7/Q6 fail-open 原因记外层审计（递归未发生的情形，嵌套审计缺失，须由外层兜底）
    if (cacheReason === 'nested-over-budget') shaping = { applied: false, reason: 'nested-over-budget' };
    else if (cacheReason === 'nested-recursion-threw') shaping = { applied: false, reason: 'nested-recursion-threw' };
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
