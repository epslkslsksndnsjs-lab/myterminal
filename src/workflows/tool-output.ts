/**
 * 工具返回的唯一出口——结构化 JSON、有界、显式截断。
 *
 * 三条纪律：
 *   1. 一律结构化 JSON：成功带 ok:true，失败带 ok:false + error + reason——没有第三种形状，
 *      也没有"空字符串当成功"的静默态；空结果是正当结果，走 ok 不走 error。
 *   2. 有界：上限照仓库既有文件工具的字符口径；编码出口是最后一道硬闸，任何单个工具
 *      都不可能把无界文本递给模型。压缩只动大的文本字段，小的原样保留。
 *   3. 截断必显式：压过就写 truncated / chars / shown 三个读数，绝不悄悄少给。压完仍装不下
 *      （碎字段太多、单个都不大）时不切 JSON——切成半截是自相矛盾的文本，改出一条具名失败。
 */

/** 单次工具返回的字符上限（与仓库既有文件工具同口径）——整包 JSON 的总帽。 */
export const MAX_TOOL_RESULT_CHARS = 50_000;
/**
 * 字段级文本上限：给信封（ok 与计数字段）留出余量，使工具自己截过一次的文本
 * 不会再被编码出口二次压缩——那会把五万字符压成两千，该给的内容反而少了。
 */
export const MAX_TOOL_TEXT_CHARS = MAX_TOOL_RESULT_CHARS - 512;
/** 兜底压缩时单个文本字段保留的预览字符数。 */
export const TRUNCATION_PREVIEW_CHARS = 2_000;

export type BoundedText = { text: string; truncated: boolean; chars: number; shown: number };

export type ToolPayload = Record<string, unknown> & ({ ok: true } | { ok: false });

export type EncodedToolResult = { content: string; isError: boolean };

/** 切到 maxChars；落在代理对中间时退一格，不留孤立高位。 */
function cut(value: string, maxChars: number): string {
  const limit = Math.max(0, maxChars);
  if (limit >= value.length) return value;
  const last = value.charCodeAt(limit - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit;
  return value.slice(0, end);
}

/** 字段级截断：工具用它给自己写出 chars / shown / truncated 三个读数。 */
export function boundText(value: string, maxChars: number = MAX_TOOL_TEXT_CHARS): BoundedText {
  const chars = value.length;
  if (chars <= maxChars) return { text: value, truncated: false, chars, shown: chars };
  const text = cut(value, maxChars);
  return { text, truncated: true, chars, shown: text.length };
}

export function toolOk(payload: Record<string, unknown> = {}): ToolPayload {
  return { ok: true, ...payload };
}

/** 失败必须有名：空文案与无名拒因都是形状错，当场抛，不进模型视野。 */
export function toolFailure(error: string, reason: string, extra: Record<string, unknown> = {}): ToolPayload {
  if (typeof error !== 'string' || !error.trim()) throw new Error('tool result shape error: error message must be non-empty');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('tool result shape error: reason must be non-empty');
  return { ok: false, error, reason, ...extra };
}

/** 当前最大且还值得压的文本字段（信封字段不动：错误文案与读数压了就没证据了）。 */
function largestStringField(record: Record<string, unknown>): string | undefined {
  let best: string | undefined;
  let bestLength = TRUNCATION_PREVIEW_CHARS;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.length <= bestLength) continue;
    if (key === 'error' || key === 'reason' || key === 'note') continue;
    best = key;
    bestLength = value.length;
  }
  return best;
}

/** 编码出口：序列化后过界就按字段大小逐个压到预览长度，直到落进上限。 */
export function encodeToolResult(payload: ToolPayload): EncodedToolResult {
  const record: Record<string, unknown> = { ...payload };
  let content = JSON.stringify(record);
  let isError = record.ok === false;
  while (content.length > MAX_TOOL_RESULT_CHARS) {
    const field = largestStringField(record);
    if (!field) break;
    const original = record[field] as string;
    record[field] = cut(original, TRUNCATION_PREVIEW_CHARS);
    record[`${field}Chars`] = original.length;
    record[`${field}Shown`] = (record[field] as string).length;
    record.truncated = true;
    content = JSON.stringify(record);
  }
  if (content.length > MAX_TOOL_RESULT_CHARS) {
    isError = true;
    content = JSON.stringify({
      ok: false,
      error: `The tool produced ${content.length} characters, over the ${MAX_TOOL_RESULT_CHARS}-character result cap, with no single field large enough to compress. Narrow the request.`,
      reason: 'result-too-large',
    });
  }
  return { content, isError };
}
