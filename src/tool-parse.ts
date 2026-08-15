import type { InvocationContext, JsonObject, JsonSchema, ShapingAudit, ToolDefinition, ToolResponse } from './types.js';
import type { LocalModelAdapter } from './l3/adapter.js';
import { runL3 } from './l3/engine.js';
import { getL3Adapter, l3Enabled } from './l3/registry.js';
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

/** 整形介入原因（D7/D11 权威枚举；T03/T04 实际产生 passthrough / over-budget / non-object / reducer-threw / cap-threw / 成功 applied；L3 细分归 T14 #44） */
export type ShapingReason =
  | 'reducer-threw'
  | 'l3-unavailable'
  | 'l3-unavailable-timeout'
  | 'l3-parse-error'
  | 'q5-rejected'
  | 'engine-error'
  | 'non-object'
  | 'over-budget'
  | 'nested-over-budget'
  | 'nested-recursion-threw'
  | 'quota'
  | 'passthrough'
  | 'cap-threw'
  | 'l3-fallback';

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
 * - 同时含 reduce+schema → D-4 双条目（W2-01 #84）：schema 优先、reduce 兜底
 * - `admitL3` → L3 准入边界（D-11 execute_cli 等）：不满足 → 不进 L3，直接回落 L1 reduce
 *   （补遗3「stdout 仅在小时脏数据时才落 L3」；无 admitL3 = 不设边界）
 * 未声明（无 reduce 无 schema）→ passthrough（绝不套壳）。
 * 同时含 reduce+schema → dual（D-4）：先过预算门走 L3；超门/准入拒收/失败矩阵 → 回落 L1 reduce。
 */
export type ToolShape = {
  reduce?: ToolReducer;
  schema?: JsonSchema;
  admitL3?: (result: JsonObject) => boolean;
};

// ── 预算门（D6 护栏2 / Q3）─────────────────────────────────────────────────────
//
// 进 L3 前量 estimateTokens(safeRaw) ≤ 运行时预算门槛，超限 → 不调模型，审计记
// reason `over-budget`：纯 schema 条目直接 passthrough；D-4 双条目（W2-01 #84）回落 L1。
// 阈值公式（0050 H2 / P2-01 #97）：门槛 = min(RAW_BUDGET_TOKENS, L3_ctx − 2048)，L3_ctx
// 运行时取 L3 适配器 ctx（contextSize 优先，trainContextSize 兜底；均未知 → 默认 256K）。
// T12 实测 Qwen3.5-2B max ctx = 262144（256K）、运行时窗口 32768（32K）→ 两档均得
// min(24000, …) = 24000，门槛维持 24K 不变（当前模型零行为变化）；小 ctx 模型自动降门槛
// （证据 .scratch/adr0047-tickets/t12-probe/eval.mjs）。
export const RAW_BUDGET_TOKENS = 24000;

/** 门槛公式兜底 ctx：T12 实测 Qwen3.5-2B max ctx（256K；adapter 未暴露 ctx 时维持 24K）。 */
const L3_CTX_DEFAULT = 262144;

/** 门槛公式输出预留：L3 maxTokens 上限 2048（D6 护栏1），budget + reserve = ctx 硬约束。 */
const L3_CTX_OUTPUT_RESERVE = 2048;

/**
 * 运行时预算门槛（0050 H2 / P2-01 #97）：min(24000, L3_ctx − 2048)。
 * adapter 缺省 → 取 registry 当前单例（与 runL3 同一 adapter 源）；ctx 取 contextSize
 * （运行时窗口）优先、trainContextSize（模型 max）兜底、均未知 → 默认 256K（维持 24K）。
 */
export function l3BudgetTokens(adapter?: LocalModelAdapter): number {
  // 增补-10（#109 R2）：L3 禁用态（env 关 / cluster 参与者默认关）短路——直接返回常量门槛，
  // 零 adapter 构造、零 ctx 解析（禁用态预算门不再触碰 registry 单例）。
  if (!l3Enabled()) return RAW_BUDGET_TOKENS;
  const src = adapter ?? getL3Adapter();
  const ctx = src?.contextSize ?? src?.trainContextSize ?? L3_CTX_DEFAULT;
  return Math.min(RAW_BUDGET_TOKENS, ctx - L3_CTX_OUTPUT_RESERVE);
}

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

// ── D12 失败双帽（#32 / Q4；0051 P2-02 #98 env 旋钮）───────────────────────────
//
// error.message / error.details 通用长度帽（D12：「通用截断」，全通道通用）。
// - message → 截到 ERROR_MESSAGE_MAX_CHARS
// - details: string → 截到 ERROR_DETAILS_MAX_CHARS（Q4 双分支一；防御性：框架内
//   details 恒为 object，但自定义/扩展工具或历史路径可能传 string）
// - details: object → 逐顶层 string 值截到 ERROR_DETAILS_MAX_CHARS；保留
//   continuation 子键整体原样（D12/Q4 + D13 控制流保全）；键顺序保全
// - code / retryable 原样不动（D9/D11）；绝不插层标记（D17 静默）
// 纯函数零副作用；截断前完整 error 由 D7 审计 rawResult 保留（诊断保全）。
//
// env 旋钮（0050 H1 / 0051 D15 可配置落地）：MYTERMINAL_ERROR_MESSAGE_MAX_CHARS /
// MYTERMINAL_ERROR_DETAILS_MAX_CHARS，env 优先；未设置/空/非法（非数字/负）→ 回落
// 默认。与 D6 配额 l3MaxPerSession（engine.ts）同构；惰性解析（每次调用读 env），
// 测试可逐用例注入/删除（issue-WP202）。导出常量保持默认值字面（issue-32 T04-const
// 锁定 2000/6000，不随 env 变）。
export const ERROR_MESSAGE_MAX_CHARS = 2000;
export const ERROR_DETAILS_MAX_CHARS = 6000;

const ENV_ERROR_MESSAGE_MAX_CHARS = 'MYTERMINAL_ERROR_MESSAGE_MAX_CHARS';
const ENV_ERROR_DETAILS_MAX_CHARS = 'MYTERMINAL_ERROR_DETAILS_MAX_CHARS';

/** env 旋钮解析（D6 配额同构）：env 优先；未设置/空/非法（非数字/负）→ 回落 fallback。
 *  '0' 合法（#43-6 备案）：置 0 → 长度帽为 0 → 信息全清（空串），勿误配为「禁用」语义。 */
function capFromEnv(envName: string, fallback: number): number {
  const raw = process.env[envName]?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (n >= 0) return n;
  }
  return fallback;
}

function truncateChars(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

type ErrorShape = NonNullable<ToolResponse['error']>;

/** D12 capError：对 error.message / error.details 施加长度帽（Q4 双分支）。 */
export function capError(error: ErrorShape): ErrorShape {
  let changed = false;

  // env 旋钮惰性解析：每次调用读 env（issue-WP202；未设置/非法 → 默认 2000/6000）
  const messageMax = capFromEnv(ENV_ERROR_MESSAGE_MAX_CHARS, ERROR_MESSAGE_MAX_CHARS);
  const detailsMax = capFromEnv(ENV_ERROR_DETAILS_MAX_CHARS, ERROR_DETAILS_MAX_CHARS);

  const message = truncateChars(error.message, messageMax);
  if (message !== error.message) changed = true;

  const rawDetails: unknown = error.details;
  let details: unknown = error.details;

  if (typeof rawDetails === 'string') {
    // Q4 双分支一：string details → 直接截
    const capped = truncateChars(rawDetails, detailsMax);
    if (capped !== rawDetails) { details = capped; changed = true; }
  } else if (Array.isArray(rawDetails)) {
    // 数组 details（非标准；扩展/历史路径可能传）：逐顶层 string 元素截，其余原样（P4：不再静默漏帽）
    const src = rawDetails as unknown[];
    const out: unknown[] = [];
    let arrChanged = false;
    for (const v of src) {
      if (typeof v === 'string') {
        const c = truncateChars(v, detailsMax);
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
        const c = truncateChars(v, detailsMax);
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

/** 被动去噪 reducer：剥已知噪声字段（command/cwd/signal/timedOut/cancelled），不改数据内容。
 *  导出供 extensions.ts command-kind 扩展复用（增补-09 #108，R5：与 execute_cli 同政策）。 */
export function denoiseCommandResult(result: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(result)) {
    if (COMMAND_RESULT_NOISE.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

// ── P2-03（#99，0050 H5 / ADR-0047 D16.3）+ 增补-08（#107）：git_log 聚合字段 commitCount ──
//
// D-10 原则4：派生字段一律代码后置补、不进任何 L3 schema。git_log 已豁免 L3（增补-04
// #103，同 git_diff 先例回 L1 被动去噪）→ 本 reducer 是 L1 主路径唯一出口：denoise 超集。
// 增补-08（#107，A2 F2 / A5a F2 落地）：生产化——handler 裸 runCommand（--oneline 字符串，
// 永不产 commits 数组），旧实现 commitCount 在生产路径恒不出现。修法：
// - 已有 commits 数组（结构化/扩展路径）→ 恒补 commitCount（原契约保持）
// - 无 commits 数组 + stdout 为 string 且非空 + 非截断态 → 逐行派生 commits（{ hash, subject }，
//   行首 token=hash、其余=subject，对齐 W2-03 AC5 语义等价 fixture 同形）+ commitCount
// - count 与 commitCount 并存（A5b F6）：D16.1 count 由 applyCountRule 对派生数组自动补，
//   两者同值（=== commits 长度），口径由测试锁定
// - 截断态（truncated:true）→ 不派生：stdout 被输出帽截断时可见行数 ≠ 真实总量，
//   派生会伪造总量感（D16.2「截断必附真实总量」不可满足时不附，绝不伪造）
// - stdout 缺失/非 string/空/纯空白 → 原样 fail-open（D11，绝不伪造）；D17 静默：
//   只加派生数值，无任何层标记。
function reduceGitLogAggregates(result: JsonObject): JsonObject {
  const out = denoiseCommandResult(result);
  if (Array.isArray(out.commits)) {
    out.commitCount = out.commits.length; // D16.3：commitCount === commits 数组长度（原契约）
    return out;
  }
  // 生产路径：git log --oneline 逐行 `hash subject` → 派生 commits + commitCount。
  // 截断态/无 stdout/非 string/空白 → 不派生（fail-open，绝不伪造）。
  if (out.truncated !== true && typeof out.stdout === 'string' && out.stdout.trim() !== '') {
    const commits: JsonObject[] = [];
    for (const rawLine of out.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue; // 空行跳过（末尾换行不产生额外提交）
      const sp = line.indexOf(' ');
      commits.push(sp >= 0
        ? { hash: line.slice(0, sp), subject: line.slice(sp + 1).trim() }
        : { hash: line, subject: '' }); // 无空格行（如纯 hash 格式）→ subject 空串
    }
    out.commits = commits;
    out.commitCount = commits.length; // D16.3：commitCount === commits 行数（#107 生产化）
  }
  return out;
}

/**
 * run_checks 专属逐项去噪 reducer（0050 C1）：run_checks 的 CommandResult 噪声在
 * results[] 内层（core-tools.ts results.push({ name, ...result }），顶层只有
 * scripts/results/passed → 旧顶层去噪注册对 run_checks 实际 no-op。此处保留顶层剥键
 * 逻辑（复用 denoiseCommandResult），并对 results[] 每项逐项剥 COMMAND_RESULT_NOISE
 * 5 键；results 非数组 → 原样（fail-open，逐项剥只作用于数组内普通对象项）。
 */
function denoiseRunChecksResult(result: JsonObject): JsonObject {
  const out = denoiseCommandResult(result);
  if (Array.isArray(out.results)) {
    out.results = out.results.map((item) =>
      isPlainObject(item) ? denoiseCommandResult(item) : item,
    );
  }
  return out;
}

/**
 * D-11 拍板 schema（0051-adr47-remediation-decisions.md，逐字）：run_checks 结构化输出。
 * Q5 白名单即 properties（白名单外字段丢弃）；派生字段不进 schema（D-10 原则4）；
 * 无顶层 required（D-11 原文）。回落 reducer 必须用 #79 逐项去噪版（denoiseRunChecksResult，
 * 0050 C1——旧顶层去噪对 run_checks 实际 no-op）。
 */
const RUN_CHECKS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    scripts: { type: 'array', items: { type: 'string' } },
    passed: { type: 'boolean' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          exitCode: { type: 'number' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
        required: ['name', 'exitCode'],
      },
    },
  },
};

// ── D16 count 引擎规则 ────────────────────────────────────────────────────────
//
// reducer 产出数组自动补 count（数组实际长度）。单数组字段场景：直接加 `count`
// （与 D16 示例 matches→count / commits→count 一致）。多数组聚合 opt-in（D16.3）
// 留待 D15/T07 按工具声明，T03 不处理多数组。
// 增补-09（#108，R19）：拷贝后写——fail-open reducer 返回原 rawResult 引用时，绝不在
// 原始对象上就地写（D7 审计 rawResult 同引用，一旦污染「raw 保全」承诺被打破）。
function applyCountRule(result: JsonObject): JsonObject {
  const arrayKeys = Object.keys(result).filter((k) => Array.isArray(result[k]));
  if (arrayKeys.length === 1 && !('count' in result) && !('totalCount' in result)) {
    return { ...result, count: (result[arrayKeys[0]] as unknown[]).length };
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

  // P2-03（#99）：D16.3 聚合字段 activeCount / completedCount（对返回条目聚合，与
  // count=visible.length 同口径）。active = 非终态（phase ∉ completed/cancelled，对齐
  // store.ts TERMINAL_PHASES）；completed = phase === 'completed'。D-10 原则4：代码后置
  // 补、不进 schema；D17 静默：只加派生数值，无任何层标记。
  let activeCount = 0;
  let completedCount = 0;
  for (const s of visible) {
    if (!isPlainObject(s)) continue; // 非对象条目原样保全（防御），不参与计数
    const phase = (s as JsonObject).phase;
    if (phase === 'completed') completedCount++;
    else if (phase !== 'cancelled') activeCount++;
  }

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
    activeCount,
    completedCount,
    truncated,
    pagination,
    __reduction: { fieldsReduced, entriesTruncated, originalSize, reducedSize },
  };
}

// ── D15/T08 主动精简（session_history）：嵌套完整 ToolResponse → 摘要（⑨ 递归深度盲区解法）──
//
// 根因（L2 候选报告）：session_history 的 audit entry（`type:"tool_audit"`）的
// `data.result` 可能是**完整嵌套 ToolResponse**（历史 session_history 调用把自身完整
// result 嵌进来，最深 4 层、6 处嵌套、单条最大 247KB）。D13 只递归 `task_poll.operation`，
// 覆盖不到这种藏在 `result.history.entries[].data.result` 数组里的嵌套 ToolResponse。
//
// 解法（用户拍板 A）：默认把 audit entry 的 `data.result` 替换为摘要
//   `{ tool, ok, entryCount?, bytes?, errorCode? }`
// - `tool`：嵌套调用的工具名（取 `nr.data.tool`）
// - `ok`：嵌套 ToolResponse 的成败（`nr.ok`）
// - `entryCount?`：若嵌套 result 自身含 history/entries（嵌套 session_history），报条目数
// - `bytes?`：原嵌套 result 序列化字节数（量级感，始终给 ToolResponse 摘要）
// - `errorCode?`：`ok:false` 时附 `nr.error.code`
// 非 ToolResponse 包裹的小结果（如 `read_file` 几行）→ 保留原样（ADR：<500 chars 不丢）。
// 摘要里不再含完整嵌套 ToolResponse → 从根消除递归嵌套（不需 D13 式 ToolResponse 递归、
// 不需深度上限/防爆栈）。与 `reduceSessionList` 同构：返回内部 `__reduction`（L2 剥离后
// 写审计，绝不进模型上下文，D17）。
//
// 注：`read_file_range` 的 maxBytes 截断（同属 T08）落在 handler（core-tools.ts），因为
// 目标是"防全文件进内存"——必须在产生 result 前就流式截断，L2 reducer 截断已晚（整文件已
// 进内存）。故 `read_file_range` 不在此注册 reducer，走 passthrough（handler 已截断）。

/** 判定 `v` 是否为完整嵌套 ToolResponse 形态（`{ ok: boolean, data: object }`）。 */
function isNestedToolResponse(v: unknown): v is ToolResponse {
  return isPlainObject(v) && typeof (v as JsonObject).ok === 'boolean' && isPlainObject((v as JsonObject).data);
}

/** 把完整嵌套 ToolResponse 压成摘要（⑨ 解法核心）。返回新对象，零副作用。 */
function summarizeNestedResult(nr: ToolResponse): JsonObject {
  const data = (nr.data ?? {}) as JsonObject;
  const summary: JsonObject = {
    tool: typeof data.tool === 'string' ? data.tool : null,
    ok: nr.ok === true,
  };
  // entryCount?：嵌套 result 自身若含 history/entries（嵌套 session_history 等）→ 报条目数
  const nestedResult = data.result;
  if (isPlainObject(nestedResult)) {
    const nested = nestedResult as JsonObject;
    const hist = isPlainObject(nested.history) ? (nested.history as JsonObject) : undefined;
    const nestedEntries = Array.isArray(nested.entries)
      ? (nested.entries as unknown[])
      : hist && Array.isArray((hist as JsonObject).entries)
        ? ((hist as JsonObject).entries as unknown[])
        : undefined;
    if (nestedEntries) summary.entryCount = nestedEntries.length;
  }
  // bytes?：原嵌套 result 字节数（量级感）；始终给 ToolResponse 摘要
  summary.bytes = Buffer.byteLength(JSON.stringify(nr), 'utf8');
  // errorCode?：失败附错误码（D7/D9 error.code 原样取用）
  if (nr.ok !== true) {
    const err = nr.error;
    if (isPlainObject(err) && typeof (err as JsonObject).code === 'string') {
      summary.errorCode = (err as JsonObject).code;
    }
  }
  return summary;
}

// ── P2-03（#99，0050 H5 / ADR-0047 D16.3）：session_history 聚合字段 ───────────
//
// toolBreakdown（按 entry.data.tool 分组计数）/ errorCount（ok:false 条目数）。
// D-10 原则4：派生字段一律代码后置补、不进任何 L3 schema；D17 静默：只加派生数值，
// 无任何层标记。非对象条目 / 无 data 条目不计入（防御）；畸形 entries（非数组）由
// 调用方 fail-open（与 count/totalCount 同纪律，绝不伪造）。
function aggregateToolAudit(entries: JsonObject[]): { toolBreakdown: JsonObject; errorCount: number } {
  const toolBreakdown: JsonObject = {};
  let errorCount = 0;
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    const data = isPlainObject(entry.data) ? (entry.data as JsonObject) : undefined;
    if (!data) continue;
    const tool = data.tool;
    if (typeof tool === 'string' && tool !== '') {
      toolBreakdown[tool] = (typeof toolBreakdown[tool] === 'number' ? (toolBreakdown[tool] as number) : 0) + 1;
    }
    if (data.ok === false) errorCount++;
  }
  return { toolBreakdown, errorCount };
}

/**
 * D15/T08 + W1-07（#80，0050 D1/D2）主动精简 reducer（session_history）：把每条 audit entry 的
 * `data.result`（完整嵌套 ToolResponse）替换为摘要，消除递归嵌套爆炸；并补齐 count/totalCount/
 * truncated + 可恢复分页（与 reduceSessionList 同构）。输入
 * `data.result = { history: { total, offset, nextOffset?, entries: [...] } }`
 * （store.ts:606，非扁平）。结构不符（无 history）→ 原样 fail-open。
 * 仅替换 `entry.data.result`，保全 `entry.data.tool` / `entry.data.ok` 等审计元信息。
 * W1-07 规则（D16.1/16.2 + D15.2/③）：
 * - count === entries.length；totalCount === history.total（真实总量）
 * - entries 被截断（total > offset + count）→ truncated:true + 内部 pagination{nextCall}
 *   （L2 剥离后发射 data.continuation.pagination）；nextCall.offset 复用 history.nextOffset
 *   （可恢复翻页，不重算、不丢数据；缺失时防御性回退 offset + count）
 * - entries 非数组（畸形）→ 原样保全，不注入任何计数/分页字段（fail-open，绝不伪造）
 */
function reduceSessionHistory(result: JsonObject, _ctx: ShapeContext): JsonObject {
  const history = isPlainObject(result.history) ? (result.history as JsonObject) : undefined;
  if (!history) return result; // 结构不符 → 原样（防御）
  const entriesIn = Array.isArray(history.entries) ? (history.entries as JsonObject[]) : null;

  let summarized = 0;
  // 非数组 entries（畸形）→ 原样保全（fail-open，绝不把 null/非数组改写成 []）
  const mapped = entriesIn === null ? null : entriesIn.map((entry) => {
    if (!isPlainObject(entry)) return entry; // 非对象条目原样保全（防御）
    const entryData = isPlainObject(entry.data) ? (entry.data as JsonObject) : undefined;
    if (!entryData) return entry;
    // W1-09（0050 F1）：raw/shaped 双版本只进审计链（JSONL），模型可见的 session_history 出口剥除（D17）
    const strippedData = stripAuditRawFields(entryData);
    const nr = strippedData.result;
    if (nr === null || nr === undefined) return strippedData === entryData ? entry : { ...entry, data: strippedData }; // 无嵌套 result → 仅剥 raw
    if (isNestedToolResponse(nr)) {
      // 完整嵌套 ToolResponse → 替换为摘要（消除递归嵌套）
      summarized++;
      return { ...entry, data: { ...strippedData, result: summarizeNestedResult(nr) } };
    }
    // 非 ToolResponse 包裹（如 read_file 几行小结果）→ 保留原样（ADR：<500 chars 不丢）
    return strippedData === entryData ? entry : { ...entry, data: strippedData };
  });
  const entries = mapped === null ? history.entries : mapped;

  const reducedHistory = { ...history, entries };
  const reduced = { ...result, history: reducedHistory };

  const originalSize = JSON.stringify(result).length;
  const reducedSize = JSON.stringify(reduced).length;
  const reduction: JsonObject = { fieldsReduced: summarized, entriesTruncated: 0, originalSize, reducedSize };
  const out: JsonObject = { ...reduced, __reduction: reduction };

  if (mapped !== null) {
    const total = typeof history.total === 'number' ? history.total : mapped.length;
    const offset = typeof history.offset === 'number' ? history.offset : 0;
    const count = mapped.length;
    const truncated = total > offset + count;
    out.count = count; // D16.1：数组实际长度
    out.totalCount = total; // D16.2：真实总量（history.total）
    out.truncated = truncated;
    // P2-03（#99）：D16.3 聚合字段（对返回条目聚合，与 count 同口径）——toolBreakdown
    // 按 entry.data.tool 分组计数 / errorCount = ok:false 条目数；嵌套摘要条目 tool
    // 原样保全故仍参与分组（T08 只替换 result，不动 data.tool/data.ok）
    const { toolBreakdown, errorCount } = aggregateToolAudit(mapped);
    out.toolBreakdown = toolBreakdown;
    out.errorCount = errorCount;
    reduction.entriesTruncated = truncated ? Math.max(0, total - count) : 0;
    if (truncated) {
      // D15.2/③ 可恢复翻页：nextCall.offset 复用 history.nextOffset（store.ts:606），不丢数据
      const next = typeof history.nextOffset === 'number' && history.nextOffset > offset
        ? history.nextOffset
        : offset + count;
      out.pagination = {
        truncated,
        nextCall: { tool: 'session_history', input: { offset: next, limit: count }, purpose: 'fetch next page of session history' },
      };
    }
  }
  return out;
}

// ── D16 主动精简（find_files / search_text，0050 A1 / W1-01 #74）：count + 截断 totalCount ──
//
// 补遗3 权威矩阵要求这两个工具主动精简（count + truncated 时 totalCount）。handler 原生返回
// { matches, truncated }；find_files 额外上报 totalMatches（截断前真实匹配总量，core-tools.ts）。
// reducer 规则（D16.1/16.2 + D17 静默）：
// - matches 数组 → count（实际长度）
// - truncated === true 且 totalMatches 为 number → totalCount（真实总量）
// - totalMatches 为 handler 内部上报字段：一律剥除，统一为 totalCount（绝不泄漏进结果，D17）
// - 结构不符（无 matches 数组）→ 原样 fail-open，不抛错（D11）
// - search_text 超时截断（timedOut）总量未知 → 无 totalMatches，只附 count，绝不伪造 totalCount
// 不发射分页：这两个工具 handler 无 offset/limit 翻页语义（find_files limit 是帽非页），矩阵
// 亦只要求 count/totalCount（分页归属 message_* 等 A4 票）。
function reduceCollectionCount(result: JsonObject): JsonObject {
  const matches = result.matches;
  if (!Array.isArray(matches)) return result; // 结构不符 → 原样（防御）
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === 'totalMatches') continue; // handler 内部上报字段：剥除，统一 totalCount（D17 静默）
    out[key] = value;
  }
  out.count = matches.length; // D16.1：数组实际长度
  if (out.truncated === true && typeof result.totalMatches === 'number') {
    out.totalCount = result.totalMatches; // D16.2：截断且总量已知 → 真实总量
  }
  return out;
}

// ── P2-03（#99，0050 H5 / ADR-0047 D16.3）：search_text 聚合字段 ──────────────
//
// fileCount（命中涉及的不同文件数）/ uniqueFiles（去重后的文件路径列表，保持 matches
// 出现序）。matches 是逐行条目 { path, line, text } → 多行同文件只算一个。D-10 原则4：
// 派生字段一律代码后置补、不进任何 L3 schema；D17 静默：只加派生数值，无任何层标记。
// find_files 不声明这两个字段（其 matches 本身即路径字符串，聚合无增量信息）——
// D16.3 按工具 opt-in，仅 search_text 注册本 reducer。matches 非数组 → 原样 fail-open
// （D11，与 reduceCollectionCount 同纪律，绝不伪造）。
function reduceSearchTextAggregates(result: JsonObject): JsonObject {
  const out = reduceCollectionCount(result);
  if (!Array.isArray(out.matches)) return out; // 结构不符 → 原样（防御）
  const uniqueFiles: string[] = [];
  const seen = new Set<string>();
  for (const match of out.matches) {
    if (isPlainObject(match) && typeof (match as JsonObject).path === 'string') {
      const p = (match as JsonObject).path as string;
      if (!seen.has(p)) {
        seen.add(p);
        uniqueFiles.push(p);
      }
    }
  }
  out.fileCount = uniqueFiles.length; // D16.3：不同文件数
  out.uniqueFiles = uniqueFiles; // D16.3：去重路径列表
  return out;
}

// ── W1-02（#75）：read_file 派生 lineCount（0050 A2）────────────────────────────
//
// 补遗3 权威矩阵要求 read_file 加 lineCount。handler 原生返回
// { path, content, sha256, bytes, truncated }（core-tools.ts），缺派生行数。
// D-10 原则4：派生字段（count/lineCount/totalCount）一律代码后置补、不进 schema。
// reducer 规则：
// - lineCount === content 行数：空文件=0、无尾换行=1、N 行=N；尾随换行不产生额外空行
// - bytes / sha256 原样保留，绝不发明 totalBytes 等字段（票面命名约束）
// - 结构不符（content 非 string）→ 原样 fail-open，不抛错（D11）
// - D17 静默：只加派生数值，无任何层标记
function countContentLines(content: string): number {
  if (content === '') return 0; // 空文件 = 0 行
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop(); // 尾随换行不产生额外空行
  return lines.length;
}

function reduceReadFileLineCount(result: JsonObject): JsonObject {
  if (typeof result.content !== 'string') return result; // 结构不符 → 原样（防御）
  return { ...result, lineCount: countContentLines(result.content) };
}

// ── D16 主动精简（skill list 模式，0050 A5 / W1-05 #78）：skills → count ──────
//
// 补遗3 权威矩阵要求 skill（list 模式）count（skills 数组实际长度，缺口 5）。handler 无参
// 调用返回 { skills: [...] }（core-tools.ts 决策 3：无参 = list）。reducer 规则
// （D16.1 + D17 静默）：
// - skills 数组 → count（实际长度）
// - 结构不符（无 skills 数组）→ 原样 fail-open，不抛错（D11）；运行态结果（inline 读指令 /
//   fork 起子代理）同样无 skills 数组 → 原样，不伪造 count
// 不发射分页：skill list 无翻页语义，矩阵只要求 count。
// session_context 明示豁免（D-16，不注册）：handler 原生 16K 投影有界（CONTEXT_PROJECTION_LIMIT
// = 16000，context-projector.ts），矩阵要求的主动精简已在源头达成；投影结构异构，注册 count
// 无意义。锁定"现状为有意 passthrough"由测试 issue-W105-AC6 承担。
function reduceSkillsCount(result: JsonObject): JsonObject {
  const skills = result.skills;
  if (!Array.isArray(skills)) return result; // 结构不符 / 运行态 → 原样（防御，不伪造 count）
  return { ...result, count: skills.length }; // D16.1：数组实际长度
}

// ── D16 主动精简（list_dir，0050 A3 / W1-03 #76）：count + 截断 totalCount + 分页 ──
//
// 补遗3 权威矩阵要求 list_dir 截断 + count + 分页。handler 原生返回
// { path, entries, total, page:{offset,limit}, truncated }（core-tools.ts，W1-03 起按
// offset/limit 切片并上报 total/page，对齐 session_list T07 模式）。reducer 规则
// （D16.1/16.2 + D15 + D17 静默）：
// - entries 数组 → count（实际长度）
// - truncated === true 且 total 为 number → totalCount（真实总量）
// - total / page 为 handler 内部上报字段：一律剥除，统一为 count/totalCount
//   （绝不泄漏进结果，D17，对齐 totalMatches 处理）
// - 截断态发射 pagination 提示（D15）→ L2 合并 data.continuation.pagination，
//   nextCall 带 path + offset + limit，模型可翻页取全量
// - 结构不符（无 entries 数组）→ 原样 fail-open，不抛错（D11）
function reduceListDirCount(result: JsonObject): JsonObject {
  const entries = result.entries;
  if (!Array.isArray(entries)) return result; // 结构不符 → 原样（防御）
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === 'total' || key === 'page') continue; // handler 内部上报字段：剥除（D17 静默）
    out[key] = value;
  }
  out.count = entries.length; // D16.1：数组实际长度
  const total = typeof result.total === 'number' ? result.total : undefined;
  if (out.truncated === true && total !== undefined) {
    out.totalCount = total; // D16.2：截断且总量已知 → 真实总量
  }
  // D15 分页提示：截断态发射（L2 剥 pagination 并合并 data.continuation.pagination）；
  // 非截断 → { truncated:false }，L2 不发射 continuation
  const page = isPlainObject(result.page) ? (result.page as JsonObject) : {};
  const offset = typeof page.offset === 'number' ? page.offset : 0;
  const limit = typeof page.limit === 'number' ? page.limit : entries.length;
  out.pagination = {
    truncated: out.truncated === true,
    ...(out.truncated === true && total !== undefined
      ? {
          nextCall: {
            tool: 'list_dir',
            input: { ...(typeof out.path === 'string' ? { path: out.path } : {}), offset: offset + limit, limit },
            purpose: 'fetch next page of directory entries',
          },
        }
      : {}),
  };
  return out;
}

// ── D15/D16 主动精简（W1-04 #77）：message_inbox / message_list / message_conversation ──
//
// 0050 A4：三工具此前 passthrough（conversation limit 默认 1000 条无截断/分页保护）。矩阵要求
// 截断 + count + 分页。store 侧（inboxPage / messagesForSessionPage / conversation）已按
// offset/limit 切片并上报 total + offset + nextOffset；reducer 派生（D16.1/16.2 + D17 静默）：
// - count：本页 messages 实际长度（D16.1）
// - truncated：nextOffset 存在（尚有后续页）
// - totalCount：截断时附真实总量（D16.2）
// - pagination：L2 剥离后发射 data.continuation.pagination；nextCall 用 offset 翻页，可逐页
//   取回全部消息、不丢数据（limit 取本页条数：截断态页必满，store 语义保证 === 有效 limit）
// - __reduction：审计精简详情（D7；绝不进模型上下文，D17）
// 结构不符（messages 非数组）→ 返回 null，调用方原样 fail-open（D11）。
// message_conversation 键路径按真实结构（data.result.conversation.{sessions,messages} +
// observations，0047 D16 权威矩阵）：派生字段落在 conversation 内，绝不扁平化消息数据；
// nextCall 的 with 取对端 session name（回退 id，store.findSession 按 name/id 均可解析）。

/** 对单个消息页容器做主动精简；结构不符（无 messages 数组）→ null（fail-open）。 */
function trimMessageContainer(
  container: JsonObject,
  nextCallTool: string,
  nextCallInput: (offset: number, limit: number) => JsonObject,
  purpose: string,
): { shaped: JsonObject; pagination: JsonObject; reduction: JsonObject } | null {
  if (!Array.isArray(container.messages)) return null;
  const messages = container.messages as unknown[];
  const total = typeof container.total === 'number' ? container.total : messages.length;
  const offset = typeof container.offset === 'number' ? container.offset : 0;
  const nextOffset = typeof container.nextOffset === 'number' ? container.nextOffset : undefined;
  // 截断 = 本页不是全部消息（诚实性：默认最新页场景 offset 缺省 → 最旧段在页外，
  // nextOffset 反而不存在，故不能只靠 nextOffset 判定）。D16.2 截断必附真实总量。
  // 增补-09（#108，R18）：末页豁免——nextOffset 缺失且本页 offset>0 说明 store 已无后继页
  // （messages.length < total 只因起点 offset>0 而非本页不完整），恒 truncated=false、
  // 不发 nextCall（保守最小版：消除盲跟 nextCall 的模型 offset 0 回绕无限翻页）。
  const lastPage = nextOffset === undefined && offset > 0;
  const truncated = lastPage ? false : messages.length < total;
  const count = messages.length;
  const originalSize = JSON.stringify(container).length;

  const shaped: JsonObject = {};
  for (const [key, value] of Object.entries(container)) {
    if (key === 'total' || key === 'offset' || key === 'nextOffset') continue; // store 页元数据：剥除，统一派生字段（D17 静默）
    shaped[key] = value;
  }
  shaped.count = count; // D16.1
  shaped.truncated = truncated;
  if (truncated) shaped.totalCount = total; // D16.2

  const pagination: JsonObject = { truncated };
  if (truncated) {
    pagination.nextCall = {
      tool: nextCallTool,
      // 就近续读优先（nextOffset）；末页/缺省页已无后继 → 回 offset 0 取最旧段，保证并集覆盖全集、不丢数据
      input: nextCallInput(nextOffset ?? 0, count),
      purpose,
    };
  }
  const reducedSize = JSON.stringify(shaped).length;
  return {
    shaped,
    pagination,
    reduction: { fieldsReduced: 0, entriesTruncated: Math.max(0, total - count), originalSize, reducedSize },
  };
}

/**
 * message_inbox / message_list 平铺页 reducer 工厂：data.result 顶层即页容器
 * （{ session?, total, offset, nextOffset?, messages, observations }）。
 */
function makeMessagePageReducer(tool: string, purpose: string): ToolReducer {
  return (result: JsonObject, _ctx: ShapeContext): JsonObject => {
    const trimmed = trimMessageContainer(result, tool, (offset, limit) => ({ offset, limit }), purpose);
    if (trimmed === null) return result;
    return { ...trimmed.shaped, pagination: trimmed.pagination, __reduction: trimmed.reduction };
  };
}

/** message_conversation 嵌套页 reducer：容器在 data.result.conversation 内。 */
function reduceMessageConversation(result: JsonObject, _ctx: ShapeContext): JsonObject {
  const conversation = result.conversation;
  if (!isPlainObject(conversation)) return result; // 结构不符 → fail-open（D11）
  const sessions = conversation.sessions;
  const other = Array.isArray(sessions) && sessions.length >= 2 && isPlainObject(sessions[1]) ? (sessions[1] as JsonObject) : undefined;
  const withTarget = typeof other?.name === 'string' ? other.name : typeof other?.id === 'string' ? other.id : undefined;
  if (withTarget === undefined) return result; // 对端不可识别 → 无法安全翻页，fail-open（防御）
  const trimmed = trimMessageContainer(conversation, 'message_conversation', (offset, limit) => ({ with: withTarget, offset, limit }), 'fetch next page of conversation messages');
  if (trimmed === null) return result;
  return { ...result, conversation: trimmed.shaped, pagination: trimmed.pagination, __reduction: trimmed.reduction };
}

// ── L1 中心注册表（D5/D10：主注册表）──────────────────────────────────────────
//
// T03：6 工具 CommandResult 被动去噪。execute_cli / git_* 复用 denoiseCommandResult；
// run_checks 用逐项去噪变体 denoiseRunChecksResult（0050 C1：噪声在 results[] 内层，
// 旧顶层去噪对 run_checks 实际 no-op）。
// T07：session_list 主动精简（D15 前半）。T08：session_history 嵌套 ToolResponse → 摘要
// （D15 ⑨ 解法）；read_file_range 截断在 handler（core-tools.ts，防全文件进内存，不在此注册）。
// W1-01（#74）：find_files / search_text 主动精简（D16 count/totalCount，0050 A1）。
// W1-02（#75）：read_file 派生 lineCount（0050 A2 / D-10 原则4）。
// W1-05（#78）：skill list 模式 count（D16.1，0050 A5）；session_context 明示豁免不注册（D-16）。
// W1-03（#76）：list_dir 主动精简（D16 count/totalCount + D15 截断分页，0050 A3）。
// W1-04（#77）：message_inbox / message_list / message_conversation 主动精简 + 分页（0050 A4；
// store 侧分页支持见 core-tools.ts / store.ts）。
// W2-01（#84）：D-4 双条目路由（reduce+schema → schema 优先、reduce 兜底）；六真工具 schema
// 注册归后续波2 票，本票以测试 probe 条目保证 kind:'l3' 分支可达（0050 B1 销项）。
// 增补-04（#103）：git_status / git_log / git_show L3 豁免（#92 检查点裁决 A，用户拍板）——
// 真模型评测 Q5 全挂（答案字段被剥光，结构性退化比 L1 更差），同 git_diff 先例回 L1 被动
// 去噪（D-16 登记，覆盖矩阵 §2）；D-12 git_show 拼接 bug 修复（core-tools.ts）与 L3 无关，保留。
// 其余工具未声明 → passthrough。L3（schema）条目在 T10 落地。
// W2-05（#88）：run_checks 双条目注册（0050 B2 + 0051 D-11）——reduce=#79 逐项去噪版 +
// schema=D-11 全文。D-4 路由裁决：双条目先过预算门走 L3，失败（超门/配额/不可用/超时/
// Q5 拒识）回落本 reduce（#79 修复版，C1 不回退）；纯 schema（subagent_status 旁挂）失败
// → passthrough。其余工具未声明 → passthrough。
// W2-06（#89）：execute_cli dual 注册（0050 B3）——D-11 schema 全文 + stdout ≤8K L3 准入边界：
//   stdout ≤8K 字符走 L3；8K~96K 输出上限击穿回落 L1 denoise；>96K 预算门（≈24K tokens）挡掉回落 L1。
// 其余工具未声明 → passthrough。L3（schema）条目在 T10 落地。

/** D-11 execute_cli schema 全文（0051 拍板）：回显白名单，等价于去噪，价值≈0 但名单完整。 */
export const EXECUTE_CLI_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    exitCode: { type: 'number' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    truncated: { type: 'boolean' },
    durationMs: { type: 'number' },
  },
};

/** D-11 execute_cli L3 准入边界：stdout ≤8K 字符才走 L3（补遗3「仅在小时脏数据时才落 L3」）。 */
export const EXECUTE_CLI_L3_MAX_STDOUT_CHARS = 8192;

/** execute_cli 的 L3 准入判定：stdout 存在、非空且 ≤8K 字符 → 准进 L3；否则回落 L1 denoise。
 *  增补-09（#108，A5b F3）：空输出（stdout=""）是干净数据，不耗 L3 配额（补遗3「仅在小时
 *  脏数据时才落 L3」；runCommand 恒产 string，stdout 缺失仅理论路径）。 */
function admitExecuteCliL3(result: JsonObject): boolean {
  const stdout = result.stdout;
  return typeof stdout === 'string' && stdout.length > 0 && stdout.length <= EXECUTE_CLI_L3_MAX_STDOUT_CHARS;
}

export const TOOL_SHAPES: Map<string, ToolShape> = new Map([
  ['session_list', { reduce: reduceSessionList }],
  ['session_history', { reduce: reduceSessionHistory }],
  ['find_files', { reduce: reduceCollectionCount }],
  // P2-03（#99）：search_text 按工具 opt-in 聚合字段（D16.3）——fileCount/uniqueFiles
  ['search_text', { reduce: reduceSearchTextAggregates }],
  ['read_file', { reduce: reduceReadFileLineCount }],
  ['skill', { reduce: reduceSkillsCount }],
  ['list_dir', { reduce: reduceListDirCount }],
  ['message_inbox', { reduce: makeMessagePageReducer('message_inbox', 'fetch next page of inbox messages') }],
  ['message_list', { reduce: makeMessagePageReducer('message_list', 'fetch next page of collaboration messages') }],
  ['message_conversation', { reduce: reduceMessageConversation }],
  ['execute_cli', { reduce: denoiseCommandResult, schema: EXECUTE_CLI_SCHEMA, admitL3: admitExecuteCliL3 }],
  // 增补-04（#103）：git_status / git_log / git_show L3 豁免（#92 检查点裁决 A）——同 git_diff
  // 先例回 L1 被动去噪（无 schema → L3 永不进入，D-16 登记）
  ['git_status', { reduce: denoiseCommandResult }],
  ['git_diff', { reduce: denoiseCommandResult }],
  // 增补-04（#103）：git_log L3 豁免——同 git_diff 先例回 L1 被动去噪（无 schema → L3 永不
  // 进入）。P2-03（#99）：reduce 换 reduceGitLogAggregates（denoise 超集，补 D16.3 commitCount
  // ——派生字段代码后置补，L1-only 下恒补；无 schema 故无 L3 成功路径，不重复问题不存在）
  ['git_log', { reduce: reduceGitLogAggregates }],
  ['git_show', { reduce: denoiseCommandResult }],
  ['run_checks', { reduce: denoiseRunChecksResult, schema: RUN_CHECKS_SCHEMA }],
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

// ── L2 执行层：路由判定（解析顺序，D5/D3 + D-4 裁决）──────────────────────────
//
// 1) 内联 ToolDefinition.shapeResult → L1
// 2) 中心表 TOOL_SHAPES：双条目（reduce+schema）→ 先过预算门走 L3，失败回落 L1 reduce
//    （D-4：schema 优先、reduce 兜底；fallbackReduce 即兜底 reducer）；admitL3 准入边界
//    （D-11 execute_cli ≤8K）不满足 → 不进 L3 直接回落 L1；纯 reduce → L1；
//    纯 schema → L3（失败 passthrough，D11 原样）
// 3) 都无 → passthrough（D3 未声明工具原样放行）
// 零额外运行时判断（D3/D18.1 mode-agnostic）；L1/L2 零模型。
type ResolvedShape =
  | { kind: 'l1'; reduce: ToolReducer }
  | { kind: 'l3'; schema: JsonSchema; fallbackReduce?: ToolReducer; admitL3?: (result: JsonObject) => boolean }
  | { kind: 'passthrough' };

function resolveShape(toolName: string, toolDef: ToolDefinition | undefined): ResolvedShape {
  if (toolDef?.shapeResult) return { kind: 'l1', reduce: toolDef.shapeResult };
  const shape = TOOL_SHAPES.get(toolName);
  // D-4 路由裁决（Q9）：条目同时含 reduce+schema 时 schema 优先（走 L3），reduce 挂
  // fallbackReduce 作失败兜底——「fail-open 回 L1」的唯一自洽读法（0051 D-4）。
  // admitL3 准入边界（D-11 execute_cli ≤8K）随 l3 解析一并携带。
  if (shape?.schema) return { kind: 'l3', schema: shape.schema, fallbackReduce: shape.reduce, admitL3: shape.admitL3 };
  if (shape?.reduce) return { kind: 'l1', reduce: shape.reduce };
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
//   （clearOperationCache，extensions 按任务接线）+ 生命周期全清（shutdown/close，增补-10 R15）。
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
 * W1-09 (#82) / 0050 F1：模型可见通道剥除 D7 双版本审计的 raw/shaped 字段。
 * raw 只进审计链（JSONL）；session_history 出口（reduceSessionHistory）与
 * projectContext（context-projector recentToolCalls）读取历史时必须剥除，绝不进模型上下文（D17）。
 * 无 raw/shaped 字段 → 返回原对象（零拷贝）。
 */
export function stripAuditRawFields<T extends JsonObject>(data: T): T {
  if (!('rawResult' in data) && !('shapedResult' in data)) return data;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'rawResult' || key === 'shapedResult') continue;
    out[key] = value;
  }
  return out as T;
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

/** Q8 写入口：512 驱逐 + 写入。reason 语义由调用方决定（undefined = 整形成功）。
 *  D13 递归写与预填（seedOperationCache）共用此入口，驱逐通道唯一。 */
function cacheSetOperation(cacheKey: string, op: ToolResponse, reason: ShapingReason | undefined): void {
  if (operationCache.size >= OPERATION_CACHE_MAX) {
    const oldest = operationCache.keys().next().value;
    if (oldest !== undefined) operationCache.delete(oldest);
  }
  operationCache.set(cacheKey, { op, reason });
}

/**
 * Q8 预填（增补-07 #106）：completeBackgroundTask 完成态落盘 task.response 后，按 poll
 * 同款 key（taskId + 内容哈希，与 D13 递归分支逐字同公式）预写 operationCache——
 * 首次 poll 即命中，免去对「已整形内容」重跑 runL3（A2 审计 F1：双烧 D6 配额 + 二次模型
 * 输出非确定，poll 所见 ≠ 完成态落审计版本）。只缓存整形成功态（reason: undefined，
 * 与 D13 递归写入口同语义）；512 驱逐复用共享写入口；taskId 缺省（bootstrap）按纯哈希 key。
 */
export function seedOperationCache(taskId: string | undefined, op: ToolResponse): void {
  const opJson = JSON.stringify(op);
  const cacheKey = taskId !== undefined ? `${taskId} ${hashString(opJson)}` : hashString(opJson);
  if (operationCache.has(cacheKey)) return; // 已有条目不覆盖（完成时清空后预填，理论不可达）
  cacheSetOperation(cacheKey, op, undefined);
}

// ── D2 细化 / 补遗3 L3-if-small 例外路由（subagent_status.result，T11 #45）─────
//
// subagent_status 是控制工具、不在 TOOL_SHAPES → resolveShape 判 passthrough。此例外
// 只对 data.result.result 子字段做 L3-if-small 路由（仅 status==='completed' + 自由文本
// string + ≤24K tokens），其余内部上下文（status/sessionId/tasks/usage/error/origin，
// auditLogs 已随 D11 砍出 status 返回体）一律不整形（避免双重整形，D2）。预算门只量 result
// 子字段（非整对象），超门
// fail-open reason=over-budget；非 completed / result 非 string → 保持 passthrough。
// W2-07（#90）：D-13 旁挂式——L3 抽取结果挂 data.result.extracted，result 字段原文原样
// 不动（0048 D11「result 必留」+「轮询取全量结果再验收」两条铁律）。

/** subagent_status.result 是否命中 L3-if-small 例外（仅 completed + 自由文本 string）。 */
function isSubagentCompletedResult(rawResult: unknown): rawResult is { status: string; result: string } & JsonObject {
  if (!isPlainObject(rawResult)) return false;
  return (rawResult as JsonObject).status === 'completed' && typeof (rawResult as JsonObject).result === 'string';
}

// W2-07（#90）：0051 D-11 拍板真 schema（0050 H4 缺口消除）——deliverables/files/blockers/
// conclusion 四字段，逐字抽取（Q5 verbatim）；D-13 旁挂式：输出挂 data.result.extracted。
const SUBAGENT_STATUS_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    deliverables: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    conclusion: { type: 'string' },
  },
};

/**
 * D18.3.1.3 指针型 result（磁盘溢出引用）防御性识别。
 * 大响应在客户端 harness 溢出落盘后，data.result 可能变成引用（而非内联数据）。
 * 此为防御性场景——正常流程 shaper 在客户端溢出前于服务端见完整内联内容（D15 照常截断）。
 * 识别：result 是对象且带 `type` 字段、值为引用语义（reference/pointer）。
 */
function isPointerResult(result: unknown): boolean {
  if (!isPlainObject(result)) return false;
  const type = (result as JsonObject).type;
  return typeof type === 'string' && /reference|pointer/i.test(type);
}

/**
 * L1 静态整形管道（D5）：reduce → D16 count 规则 → 剥离内部提示（pagination/__reduction，
 * 绝不进模型上下文，D17）→ 重建 response + continuation 合并 + 精简审计。
 * 双条目（reduce+schema）L3 失败回落时复用同一管道（D-4「回落 L1 reduce」），
 * fallbackReason 标注审计 reason=l3-fallback；reducer 抛错 → fail-open passthrough
 * （D11，reason=reducer-threw，绝不阻断）。
 */
function applyL1Reducer(
  response: ToolResponse,
  rawResult: JsonObject,
  reduce: ToolReducer,
  ctx: ShapeContext,
  fallbackReason?: ShapingReason,
): { base: ToolResponse; shaping: ShapingAudit } {
  try {
    const reducedRaw = reduce(rawResult, ctx);
    const reduced = applyCountRule(reducedRaw);
    // 剥离 active-trim reducer 返回的内部提示（绝不进模型上下文，D17）：
    //  - pagination → L2 合并发射 data.continuation.pagination
    //  - __reduction → 写入审计精简详情
    const pagination = (reduced as JsonObject).pagination;
    const reduction = (reduced as JsonObject).__reduction;
    delete (reduced as JsonObject).pagination;
    delete (reduced as JsonObject).__reduction;
    let base: ToolResponse = { ...response, data: { ...(response.data ?? {}), result: reduced } };
    let shaping: ShapingAudit = fallbackReason ? { applied: true, reason: fallbackReason } : { applied: true };
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
    return { base, shaping };
  } catch {
    // D11 fail-open：reducer 抛错 → 原样 passthrough，记 reducer-threw
    return { base: response, shaping: { applied: false, reason: 'reducer-threw' } };
  }
}

/**
 * 工具响应整形入口（D13：包住最终装饰响应，含 decorateContinuation 后的长任务结构）。
 *
 * 执行顺序（T03 + T04 #32）：
 *  - 路由判定（resolveShape）→ L1 reducer / L3(预算门) / passthrough
 *  - L1 被动/主动 reducer（零模型）→ D16 count 规则 → 重建 response（只动 data.result）
 *  - D12 失败双帽（#32）：除 subagent 通道（D2 豁免——extensions.applyShape 早退原样返回，
 *    不套 D12，见 extensions.ts）外全通道通用套用 error.message / error.details 长度帽，
 *    continuation 子键保全（Q4）；ok / error.code / error.retryable / events /
 *    data.tool / data.continuation 原样不动（D9/D11）
 *  - D7 双版本审计：rawResult 保留未截断完整 error（诊断保全）、shapedResult 为截断版 + shaping.reason
 *  - D17 静默：结果中绝不插入层标记
 *  - D11 fail-open：reducer 抛错 / 非对象 / 超预算 → 原样 passthrough，原因只进审计
 */
export async function shapeToolResponse(response: ToolResponse, ctx: ShapeContext): Promise<ToolResponse> {
  const toolName = typeof response.data?.tool === 'string' ? response.data.tool : '';
  const rawResult = response.data?.result;

  // 结果整形（仅 data.result / 路由）：base 为整形后响应（error 仍原样），shaping 记录结果路径决策
  let base: ToolResponse;
  let shaping: ShapingAudit;

  // 非对象 result（D11 non-object）→ 不整形 data.result
  if (rawResult === null || rawResult === undefined || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
    base = response;
    shaping = { applied: false, reason: 'non-object' };
  } else if (isPointerResult(rawResult)) {
    // D18.3.1.3 指针型 result（磁盘溢出引用）→ 不透明 passthrough，不解析不 strip
    base = response;
    shaping = { applied: false, reason: 'passthrough' };
  } else {
    const resolved = resolveShape(toolName, ctx.resolveTool(toolName));

    if (resolved.kind === 'passthrough') {
      base = response;
      shaping = { applied: false, reason: 'passthrough' };
    } else if (resolved.kind === 'l3') {
      // 预算门（D6 护栏2 / Q3）：超门绝不进 L3。纯 schema 条目 → passthrough 记 over-budget；
      // 双条目（reduce+schema）→ D-4 超门回落 L1 reduce（「fail-open 回 L1」）
      if (estimateTokens(JSON.stringify(rawResult)) > l3BudgetTokens()) {
        if (resolved.fallbackReduce) {
          ({ base, shaping } = applyL1Reducer(response, rawResult as JsonObject, resolved.fallbackReduce, ctx, 'over-budget'));
        } else {
          base = response;
          shaping = { applied: false, reason: 'over-budget' };
        }
      } else if (resolved.admitL3 && !resolved.admitL3(rawResult as JsonObject)) {
        // D-11 准入拒收（execute_cli stdout 8K~96K）：不进 L3，直接回落 L1 reduce——
        // 正常 L1 结果，无失败原因（W2-06-AC3）
        if (resolved.fallbackReduce) {
          ({ base, shaping } = applyL1Reducer(response, rawResult as JsonObject, resolved.fallbackReduce, ctx));
        } else {
          base = response;
          shaping = { applied: false, reason: 'passthrough' };
        }
      } else {
        // T10：调 L3 引擎（护栏1 transport 感知超时 + 护栏3 会话配额 + Q5 字段白名单/值存在性
        // 校验 + 调模型，全路径 fail-open）。成功 → 用 Q5 后结果替换 data.result；失败 →
        // 双条目回落 L1 reduce（D-4：配额烧穿/模型不可用/超时/Q5 拒识全部回落），纯 schema
        // 条目原样 passthrough + reason（l3-unavailable-timeout / quota / passthrough）。
        const outcome = await runL3(rawResult as JsonObject, resolved.schema, ctx.transport, ctx.sessionId);
        if (outcome.shaped) {
          base = { ...response, data: { ...(response.data ?? {}), result: outcome.shaped } };
          shaping = { applied: true };
        } else if (resolved.fallbackReduce) {
          ({ base, shaping } = applyL1Reducer(response, rawResult as JsonObject, resolved.fallbackReduce, ctx, outcome.reason ?? 'l3-unavailable'));
        } else {
          base = response;
          shaping = { applied: false, reason: outcome.reason ?? 'passthrough' };
        }
      }
    } else {
      // L1 被动/主动 reducer（零模型）
      ({ base, shaping } = applyL1Reducer(response, rawResult as JsonObject, resolved.reduce, ctx));
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
      if (estimateTokens(opJson) > l3BudgetTokens()) {
        // Q7 嵌套预算门：超大嵌套 fail-open 回原始 operation（外层 task_poll 结构保留），
        // 不让超大嵌套进 L3、也不绕过预算门
        shapedOperation = op;
        cacheReason = 'nested-over-budget';
      } else {
        try {
          // Q6 try/catch：递归整形嵌套 operation（L2 路由 operation.data.result + D12 帽
          // operation.error，保全 operation.ok / data.tool）；递归调用自身亦产嵌套审计（Q10）
          shapedOperation = await shapeToolResponse(op, ctx);
        } catch {
          // Q6 fail-open：递归层任一异常 → 用原始 operation 整体替换，绝不返回半成品
          shapedOperation = op;
          cacheReason = 'nested-recursion-threw';
        }
      }
      // Q8 仅缓存「整形成功」结果（cacheReason === undefined）；fail-open 路径不消费 L3
      // 配额，缓存它零收益且会冻结瞬时失败（如 L3 冷加载超时 / audit 通道抖动），故不缓存。
      if (cacheReason === undefined) cacheSetOperation(cacheKey, shapedOperation, cacheReason);
    }

    // 重建 response：仅替换 result.operation，保全其余字段（status / taskId / continuation 等）
    base = {
      ...base,
      data: { ...(base.data ?? {}), result: { ...result, operation: shapedOperation } },
    };
    // 外层审计如实记录嵌套整形结果（0050 F1 附带 b，W1-09 #82）：
    // - cacheReason === undefined：嵌套整形成功（Q8 缓存命中或本轮递归完成）→ applied:true，
    //   不再恒记 passthrough
    // - Q7/Q6 fail-open 原因记外层审计（递归未发生的情形，嵌套审计缺失，须由外层兜底）
    if (cacheReason === undefined) shaping = { applied: true };
    else if (cacheReason === 'nested-over-budget') shaping = { applied: false, reason: 'nested-over-budget' };
    else if (cacheReason === 'nested-recursion-threw') shaping = { applied: false, reason: 'nested-recursion-threw' };
  }

  // ── D2 细化 L3-if-small 例外（subagent_status.result，T11 #45）+ D-13 旁挂式（W2-07 #90）──
  // 仅对 data.result.result 子字段做 L3（completed + 自由文本 string + ≤24K），其余字段原样。
  // D-13 旁挂式：L3 抽取结果挂 data.result.extracted（deliverables/files/blockers/conclusion，
  // 逐字抽取），result 字段原文原样不动——守住 0048 D11「result 必留」+「轮询取全量结果再
  // 验收」两条铁律；Q5 全丢 / 模型不可用 / 超时 / 配额 / 解析失败 → 原样 passthrough 不伪造。
  if (toolName === 'subagent_status' && isSubagentCompletedResult(rawResult)) {
    const text = (rawResult as JsonObject).result as string;
    if (estimateTokens(text) > l3BudgetTokens()) {
      // 超预算门（D6 护栏2）→ fail-open passthrough，reason=over-budget（不调模型）
      base = response;
      shaping = { applied: false, reason: 'over-budget' };
    } else {
      // L3 结构化抽取（D-11 真 schema；全路径 fail-open，reason 由 engine 给出）。
      // 传给引擎的 raw 除 result 原文外附带 lines（逐行拆分）——Q5 值存在性校验的锚点是
      // raw 的 JSON 序列化（engine.ts 启发式），自由文本的内部子串永远无法带引号命中；
      // 行值作为独立数组元素即可被逐字抽取命中（0047 Q5 verbatim 的落地方式）。
      const lines = text.split(/\r?\n/);
      if (lines[lines.length - 1] === '') lines.pop(); // 尾随换行不产生额外空行
      const outcome = await runL3({ result: text, lines }, SUBAGENT_STATUS_RESULT_SCHEMA, ctx.transport, ctx.sessionId);
      if (outcome.shaped) {
        // 旁挂式：extracted 挂上，result 原文原样不动（0048 D11）；其余内部上下文
        // （status/sessionId/tasks/usage/origin）原样保全
        base = { ...response, data: { ...(response.data ?? {}), result: { ...(rawResult as JsonObject), extracted: outcome.shaped } } };
        shaping = { applied: true };
      } else {
        // L3 失败（模型不可用/超时/配额/Q5 全丢）→ 原样 passthrough，不伪造
        base = response;
        shaping = { applied: false, reason: outcome.reason ?? 'passthrough' };
      }
    }
  }

  // D12 失败双帽（#32）：除 subagent 通道（D2 豁免，见 applyShape 早退）外全通道通用套用
  // error.message / error.details 长度帽（continuation 子键保全）。
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
