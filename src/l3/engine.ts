import type { JsonObject, JsonSchema } from '../types.js';
import { getL3Adapter, l3Enabled } from './registry.js';

/**
 * ADR-0047 D6/D8.4 — L3 引擎（T10）：护栏 + Q5 + 调模型 + 全路径 fail-open。
 *
 * 职责：L2 执行层（tool-parse.ts `shapeToolResponse`）路由判定为 `schema→L3` 后，由本引擎
 * 执行「护栏1 超时 → 护栏3 配额 → 调模型 → Q5 校验」，任何一步失败均 fail-open 回
 * passthrough（D11「L3 永不使系统更坏」）。
 *
 * reason 权威枚举（T10 合并 5 个，用户拍板；D8.4 细分 l3-unavailable / l3-parse-error /
 * q5-rejected / engine-error 归 T13）：
 *   - `l3-unavailable-timeout`：模型不可用（supportsStructuredOutput=false / isReady=false）+ 超时
 *   - `quota`：会话配额超限
 *   - `passthrough`：env 关 L3 / Q5 全字段丢弃 / 引擎自身异常
 *   （`over-budget` / `nested-over-budget` 由 tool-parse.ts 的预算门 + 递归预算门产生，不在本引擎）
 *
 * 会话配额（D6 护栏3）：Map<sessionId, count> 计数；`clearL3Quota(sessionId?)` 会话结束删除。
 * 与 tool-parse.ts 的 `clearOperationCache`（T05/Q8）同构：本模块只暴露原语，接线留调用方。
 */

// ── D6 护栏1：transport 感知超时 + maxTokens ────────────────────────────────
//
// actions 通道（网页端，受 K5 45s 约束）→ ≤8000ms（给工具自身执行留 ~37s）；
// 本地 / TUI / MCP / apps → 20000ms。L3 maxTokens ≤2048（结构化解析不需要长输出）。
export const L3_TIMEOUT_ACTIONS_MS = 8000;
export const L3_TIMEOUT_OTHER_MS = 20000;
export const L3_MAX_TOKENS = 2048;

/** transport 感知超时（D6 护栏1）：actions → 8s，其余 → 20s。 */
export function l3TimeoutMs(transport: string): number {
  return transport === 'actions' ? L3_TIMEOUT_ACTIONS_MS : L3_TIMEOUT_OTHER_MS;
}

// ── D6 护栏3：会话级配额 ────────────────────────────────────────────────────

export const L3_MAX_PER_SESSION_DEFAULT = 50;

/** 会话配额 Map：`sessionId → 已用次数`。sessionId 缺省（bootstrap）时用空串 key。 */
const sessionQuota = new Map<string, number>();

/** 会话配额上限（可配置，env 优先，未设置默认 50）。 */
export function l3MaxPerSession(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MYTERMINAL_L3_MAX_PER_SESSION?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (n >= 0) return n;
  }
  return L3_MAX_PER_SESSION_DEFAULT;
}

/** 会话结束删除配额计数（不传 sessionId → 清全量）。 */
export function clearL3Quota(sessionId?: string): void {
  if (sessionId === undefined) {
    sessionQuota.clear();
    return;
  }
  sessionQuota.delete(sessionId);
}

// ── Q5 防幻觉：字段白名单 + 值存在性校验 ───────────────────────────────────
//
// 字段白名单：只留 schema.properties 里注册的已知 key，白名单外字段丢弃（防模型发明字段）。
// 值存在性校验：标量值（string/number/boolean）须在原始 raw 文本（JSON.stringify(rawResult)）
// 中存在，否则丢该字段（防模型幻觉值）。
// 任一层全字段皆丢 → 整体 fail-open passthrough（D8.4「全部字段皆丢 → 整体 fail-open」）。

function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** 递归 Q5：白名单过滤 + 值存在性校验。nonEmpty=false 表示该层字段全丢。 */
function applyQ5(value: unknown, schema: JsonSchema | undefined, rawText: string): { kept: unknown; nonEmpty: boolean } {
  if (isScalar(value)) {
    // 值存在性校验：标量值须在 raw 文本中存在（启发式，对齐 ADR Q5）。
    // string 用 JSON.stringify（带引号）精确匹配完整字符串值，避免 "red" 误命中 "reddish"；
    // number/boolean 用 String()（JSON 中数字/布尔不带引号，子串匹配，接受启发式局限）。
    const s = typeof value === 'string' ? JSON.stringify(value) : String(value);
    return rawText.includes(s) ? { kept: value, nonEmpty: true } : { kept: undefined, nonEmpty: false };
  }
  if (Array.isArray(value)) {
    const itemSchema = schema?.items;
    const out: unknown[] = [];
    for (const item of value) {
      const r = applyQ5(item, itemSchema, rawText);
      if (r.nonEmpty) out.push(r.kept);
    }
    return { kept: out, nonEmpty: out.length > 0 };
  }
  if (isPlainObject(value)) {
    const props = schema?.properties;
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      if (props && !(k in props)) continue; // 白名单外字段 → 丢弃
      const r = applyQ5(v, props ? props[k] : undefined, rawText);
      if (r.nonEmpty) out[k] = r.kept;
    }
    return { kept: out, nonEmpty: Object.keys(out).length > 0 };
  }
  // null / undefined 等非标量非容器：无法做值存在性校验，原样保留
  return { kept: value, nonEmpty: true };
}

// ── 调模型（护栏1 transport 感知超时）───────────────────────────────────────

/** L3 解析指令（T10 最小模板；D8.4 完整 prompt 模板归 T13）。 */
const L3_INSTRUCTION =
  'Parse the raw tool output into the target JSON schema. Output only fields declared in the schema, with values taken verbatim from the raw text.';

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ── L3 引擎主入口 ───────────────────────────────────────────────────────────

export type L3Outcome = {
  /** Q5 校验后、白名单过滤 + 值存在性校验通过的整形结果；失败 → null。 */
  shaped: JsonObject | null;
  /** 失败原因（仅 fail-open 路径；成功时 undefined）。 */
  reason?: 'l3-unavailable-timeout' | 'quota' | 'passthrough';
};

/**
 * L3 引擎（T10）：护栏1 超时 → 护栏3 配额 → 调模型 → Q5 校验，全路径 fail-open。
 *
 * @param rawResult 工具原始 `data.result`（预算门已在 L2 层拦截，此处 ≤ RAW_BUDGET_TOKENS）。
 * @param schema 目标结构化 schema（字段白名单来源）。
 * @param transport 通道（决定超时：actions→8s，其余→20s）。
 * @param sessionId 会话标识（配额计数 key；bootstrap 缺省时用空串）。
 * @param timeoutMs 超时覆盖（测试注入点，验证真竞速截断；缺省用 transport 感知超时）。
 */
export async function runL3(
  rawResult: JsonObject,
  schema: JsonSchema,
  transport: string,
  sessionId: string | undefined,
  timeoutMs?: number,
): Promise<L3Outcome> {
  // env 一键关 L3（D8.3）→ passthrough（不调模型、不耗配额）
  if (!l3Enabled()) return { shaped: null, reason: 'passthrough' };

  const adapter = getL3Adapter();
  // 模型不可用（supportsStructuredOutput=false）→ l3-unavailable-timeout（不调模型、不耗配额）
  if (!adapter.supportsStructuredOutput) return { shaped: null, reason: 'l3-unavailable-timeout' };
  try {
    if (!(await adapter.isReady())) return { shaped: null, reason: 'l3-unavailable-timeout' };
  } catch {
    return { shaped: null, reason: 'l3-unavailable-timeout' };
  }

  // 会话配额（D6 护栏3）：超限 → quota passthrough（不调模型）
  const key = sessionId ?? '';
  const used = sessionQuota.get(key) ?? 0;
  if (used >= l3MaxPerSession()) return { shaped: null, reason: 'quota' };
  sessionQuota.set(key, used + 1);

  try {
    // 调模型（护栏1 transport 感知超时 + maxTokens≤2048 + temperature=0 确定性）
    const result = await withTimeout(
      adapter.complete({
        instruction: L3_INSTRUCTION,
        schema,
        maxTokens: L3_MAX_TOKENS,
        temperature: 0,
      }),
      timeoutMs ?? l3TimeoutMs(transport),
    );
    if (result === 'timeout') return { shaped: null, reason: 'l3-unavailable-timeout' };
    if (result.object === null) return { shaped: null, reason: 'l3-unavailable-timeout' };

    // Q5 防幻觉：字段白名单 + 值存在性校验；全字段皆丢 → passthrough
    const rawText = JSON.stringify(rawResult);
    const q5 = applyQ5(result.object, schema, rawText);
    if (!q5.nonEmpty || !isPlainObject(q5.kept)) return { shaped: null, reason: 'passthrough' };
    return { shaped: q5.kept };
  } catch {
    // 引擎自身异常 → passthrough（D11 fail-open，绝不阻断）
    return { shaped: null, reason: 'passthrough' };
  }
}
