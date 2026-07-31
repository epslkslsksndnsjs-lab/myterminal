import { z } from 'zod';
import type { JsonSchema } from './types.js';

/**
 * ADR-0032（#41）：JSON Schema → zod 派生器。
 *
 * MCP 协议层的 zod 不再手抄——它由 `tool-schemas.ts` 的单源 JSON Schema 派生。
 * 这个文件的**安全红线**（决策块硬要求）：
 *
 *   遇到任何不认识/不支持的关键字，必须抛 `UnsupportedSchemaError`，
 *   **禁止静默回退 z.any()/z.looseObject()/passthrough**。
 *
 * 理由：静默回退产生的"全通" schema 比原来的 44 字段 catchall 更隐蔽——
 * 客户端会以为约束存在，运行期 `invokeTool` 却按真 schema 拒绝，两层各说各话。
 * 宁可在**进程启动时**因为新增了派生器不认识的关键字而炸掉（测试/启动即发现），
 * 也不要在**客户端调用时**才暴露。
 *
 * 支持的关键字 = `JsonSchema` 类型（types.ts）的全部 14 个：
 * type / description / properties / required / additionalProperties / items /
 * enum / minLength / maxLength / minimum / maximum / minItems / maxItems / default。
 *
 * 语义对齐 `invokeTool` 运行期校验（core-tools.ts）：
 *   · `default` 只进 JSON Schema 展示（经 `.meta()`），**不注入运行期**——
 *     zod 的 `.default()` 会在 parse 时填值，改变转发给 `ExtensionService.call`
 *     的参数 = 行为变更，绝对不可。实测 `.meta({ default })` 只影响
 *     `z.toJSONSchema` 输出，`safeParse({})` 仍返回 `{}`。
 *   · `additionalProperties: false` → `z.object`（**strip 模式**，未知字段静默丢弃）——
 *     1:1 复刻 main 基线 raw-shape 注册语义（#70 门禁裁定）。刻意不用 `z.strictObject`：
 *     strict 会拒绝未知字段，属行为变更；「展示层 strip / 运行期拒绝」的分歧
 *     若要消灭，须单独开票作为显式行为变更走流程。
 *   · `additionalProperties: true` 且无 properties（开放 record，如
 *     planned call 的 input）→ `z.record(z.string(), z.unknown())`。
 */
export class UnsupportedSchemaError extends Error {
  constructor(public readonly path: string, reason: string) {
    super(`Unsupported JSON Schema at ${path}: ${reason}`);
    this.name = 'UnsupportedSchemaError';
  }
}

/** 每种 type 允许出现的关键字全集；出现集合之外的键一律抛错。 */
const KNOWN_KEYS: Record<string, ReadonlySet<string>> = {
  string: new Set(['type', 'description', 'default', 'enum', 'minLength', 'maxLength']),
  integer: new Set(['type', 'description', 'default', 'minimum', 'maximum']),
  number: new Set(['type', 'description', 'default', 'minimum', 'maximum']),
  boolean: new Set(['type', 'description', 'default']),
  array: new Set(['type', 'description', 'default', 'items', 'minItems', 'maxItems']),
  object: new Set(['type', 'description', 'default', 'properties', 'required', 'additionalProperties']),
};

function fail(path: string, reason: string): never {
  throw new UnsupportedSchemaError(path, reason);
}

function assertKnownKeys(schema: JsonSchema, type: string, path: string): void {
  const known = KNOWN_KEYS[type];
  for (const key of Object.keys(schema)) {
    if (!known.has(key)) fail(path, `keyword "${key}" is not supported for type "${type}" — refusing to silently drop it`);
  }
}

/** description/default 只进 JSON Schema 展示层，不改变运行期 parse 结果。 */
function withMeta<T extends z.ZodType>(node: T, schema: JsonSchema): T {
  const meta: Record<string, unknown> = {};
  if (schema.description !== undefined) meta.description = schema.description;
  if (schema.default !== undefined) meta.default = schema.default;
  return Object.keys(meta).length > 0 ? (node.meta(meta) as unknown as T) : node;
}

function stringSchema(schema: JsonSchema, path: string): z.ZodType {
  if (schema.enum !== undefined) {
    if (schema.minLength !== undefined || schema.maxLength !== undefined) fail(path, 'enum combined with minLength/maxLength is not supported');
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) fail(path, 'enum must be a non-empty array');
    for (const value of schema.enum) {
      if (typeof value !== 'string') fail(path, `enum value ${JSON.stringify(value)} does not match type "string"`);
    }
    return z.enum(schema.enum as [string, ...string[]]);
  }
  let node = z.string();
  if (schema.minLength !== undefined) node = node.min(schema.minLength);
  if (schema.maxLength !== undefined) node = node.max(schema.maxLength);
  return node;
}

function numberSchema(schema: JsonSchema): z.ZodType {
  let node = schema.type === 'integer' ? z.int() : z.number();
  if (schema.minimum !== undefined) node = node.min(schema.minimum);
  if (schema.maximum !== undefined) node = node.max(schema.maximum);
  return node;
}

function arraySchema(schema: JsonSchema, path: string): z.ZodType {
  if (schema.items === undefined) fail(path, 'array without items is unbounded — declare items explicitly');
  let node = z.array(jsonSchemaToZod(schema.items, `${path}.items`));
  if (schema.minItems !== undefined) node = node.min(schema.minItems);
  if (schema.maxItems !== undefined) node = node.max(schema.maxItems);
  return node;
}

function objectSchema(schema: JsonSchema, path: string): z.ZodType {
  const ap = schema.additionalProperties;
  if (ap === undefined) fail(path, 'object must declare additionalProperties explicitly (true for open records, false otherwise)');
  if (typeof ap === 'object') fail(path, 'schema-valued additionalProperties is not supported');

  if (ap === true) {
    // 开放 record（如 planned call 的 input）。带 properties/required 的
    // "半开放"对象运行期语义含混，单源里也不存在——直接拒绝。
    if (schema.properties !== undefined) fail(path, 'additionalProperties:true with properties is not supported — use false, or drop properties for an open record');
    if (schema.required !== undefined) fail(path, 'additionalProperties:true with required is not supported');
    return z.record(z.string(), z.unknown());
  }

  if (schema.properties === undefined) fail(path, 'object with additionalProperties:false must declare properties');
  const required = new Set(schema.required ?? []);
  for (const name of required) {
    if (!(name in schema.properties)) fail(path, `required property "${name}" is not declared in properties`);
  }
  const shape: Record<string, z.ZodType> = {};
  for (const [key, child] of Object.entries(schema.properties)) {
    const node = jsonSchemaToZod(child, `${path}.${key}`);
    shape[key] = required.has(key) ? node : node.optional();
  }
  // strip 模式（见文件头注释）：1:1 复刻 main 基线 raw-shape 注册的未知字段语义。
  // 刻意不用 z.strictObject——strict 会拒绝未知字段，属 #41 实现者自加的行为变更（main 是 strip）。
  return z.object(shape);
}

/**
 * 把单源 JSON Schema 派生成语义等价的 zod schema。
 *
 * @param schema 单源 JSON Schema（通常来自 `BUILTIN_INPUT_SCHEMAS`）
 * @param path   错误定位用的根路径（通常是工具名）；抛错信息形如
 *               `Unsupported JSON Schema at session_register.task.objective: …`
 * @throws UnsupportedSchemaError 遇到任何不支持的关键字/结构——绝不静默回退
 */
export function jsonSchemaToZod(schema: JsonSchema, path: string): z.ZodType {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) fail(path, 'schema node must be an object');
  const type = schema.type;
  if (type === undefined) fail(path, 'missing "type" — refusing to derive z.any()');
  if (typeof type !== 'string' || !(type in KNOWN_KEYS)) fail(path, `type "${String(type)}" is not supported`);
  assertKnownKeys(schema, type, path);

  switch (type) {
    case 'string': return withMeta(stringSchema(schema, path), schema);
    case 'integer':
    case 'number': return withMeta(numberSchema(schema), schema);
    case 'boolean': return withMeta(z.boolean(), schema);
    case 'array': return withMeta(arraySchema(schema, path), schema);
    default: return withMeta(objectSchema(schema, path), schema);
  }
}
