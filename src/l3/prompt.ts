import type { JsonObject, JsonSchema } from '../types.js';

/**
 * ADR-0047 D8.4 — L3 prompt 模板（T14 #44），与 adapter 实现分离。
 *
 * D8.4「prompt 是 L3 引擎输入的一部分（StructuredRequest.instruction），与 adapter
 * 实现分离：模板可随评测迭代，adapter 接口不变」。故 SYSTEM 规则与 USER 正文（raw 结果
 * 文本 + 目标 schema）都从本模块导出，adapter / engine 只引用、不内联——后续调 prompt
 * 措辞、调抽取质量只需改本文件，不动 engine / adapter。
 *
 * 模板与硬约束的衔接（D8.4）：
 *   - non-thinking 由参数层强制（D8.3 决策1 的 chat 模板），规则 4「只输出 JSON 本体」
 *     只是语义备份；JSON 落正文、可被 GBNF 解析。
 *   - 输出格式由 GBNF 令牌级强制（D8.3 决策3），prompt 不承担格式责任；规则 1/2/3 承担
 *     语义责任，是 Q5 校验的前置（模型尽量如实抽取，代码层再验值存在性）。
 *   - temperature=0、maxTokens≤2048 由 engine 设，不属模板职责。
 */

/** D8.4 SYSTEM 模板（规则 1–4）。 */
export const L3_SYSTEM_PROMPT = [
  '你是工具结果解析器。把给定的工具原始返回按目标 JSON Schema 抽取为结构化对象。',
  '规则：',
  '1. 只输出 schema 中声明的字段，绝不发明新字段',
  '2. 字段值必须直接来自原始返回文本（原样保留：不翻译、不改写、不总结、不推断）',
  '3. 原始返回中不存在的字段：标量 → 省略该字段；数组 → 输出空数组',
  '4. 只输出 JSON 本体，不输出任何解释文字或思考过程',
].join('\n');

/**
 * D8.4 USER 模板：把 raw 结果文本 + 目标 schema 拼成 instruction（`StructuredRequest.instruction`）。
 *
 * 值存在性校验（Q5）的锚点是 raw 文本的 JSON 序列化，故此处用 JSON.stringify 与 Q5 侧
 * 保持一致，模型抽取的标量值才能在 raw 文本中被逐字命中。
 */
export function buildInstruction(rawResult: JsonObject, schema: JsonSchema): string {
  return [
    '原始返回（RAW）：',
    JSON.stringify(rawResult),
    '',
    '目标 Schema：',
    JSON.stringify(schema),
    '',
    '请输出结构化结果：',
  ].join('\n');
}
