/**
 * JSON Schema 子集闸门——工具入参与结构化提交共用一把尺。
 *
 * 认识的关键词只有这些：type（含联合类型与 null）、required、properties、
 * additionalProperties、items、enum、const、minLength、maxLength、minimum、maximum、pattern。
 * 两条纪律：
 *   1. 不认识的关键词点名报出（unsupportedSchemaKeywords），不静默当成通过——
 *      一份用到了 anyOf 的 schema 被"全放行"地校验，比校验失败更危险。
 *   2. schema 自身形状不合法即抛（不是返回一条违例）：那是脚本写错了，属调用形状。
 * pattern 按 JS 正则语义解释；违例带可定位路径（items[0].n），模型改得动。
 */

export type SchemaViolation = { path: string; message: string };

const SUPPORTED_KEYWORDS = ['type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern'] as const;
const IGNORED_KEYWORDS = ['$schema', '$id', '$comment', '$defs', 'definitions', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly'];
const ROOT_PATH = '(root)';

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  // integer 是 number 的子集：报给模型的类型名照 JS 口径（number），判据另说。
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number';
  return jsonTypeOf(value) === expected;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** 逐条下钻收集不认识的关键词，按出现顺序去重。 */
export function unsupportedSchemaKeywords(schema: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const note = (key: string): void => {
    if (seen.has(key) || (IGNORED_KEYWORDS as readonly string[]).includes(key)) return;
    if ((SUPPORTED_KEYWORDS as readonly string[]).includes(key)) return;
    seen.add(key);
    found.push(key);
  };
  const walkChildren = (key: string, value: unknown): void => {
    if (key === 'properties' || key === 'definitions' || key === '$defs') {
      const record = asRecord(value);
      if (record) for (const child of Object.values(record)) walk(child);
      return;
    }
    if (key === 'items') {
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
      return;
    }
    if (key === 'additionalProperties') walk(value);
  };
  const walk = (node: unknown): void => {
    const record = asRecord(node);
    if (!record) return;
    for (const [key, value] of Object.entries(record)) {
      if (!(SUPPORTED_KEYWORDS as readonly string[]).includes(key)) note(key);
      walkChildren(key, value);
    }
  };
  walk(schema);
  return found;
}

/** 校验一个值；返回全部违例（空表 = 通过）。schema 形状不合法即抛。 */
export function gateJsonSchema(value: unknown, schema: unknown): SchemaViolation[] {
  if (schema === undefined || schema === null) return [];
  const record = asRecord(schema);
  if (!record) throw new Error('schema must be a JSON object.');
  const violations: SchemaViolation[] = [];
  visit(value, record, ROOT_PATH, violations);
  return violations;
}

function visit(value: unknown, schema: Record<string, unknown>, at: string, out: SchemaViolation[]): void {
  const expected = schema.type;
  if (typeof expected === 'string') {
    if (!typeMatches(value, expected)) {
      out.push({ path: at, message: `expected type ${expected}, got ${jsonTypeOf(value)}` });
      return;
    }
  } else if (Array.isArray(expected)) {
    if (!expected.some((item) => typeof item === 'string' && typeMatches(value, item))) {
      out.push({ path: at, message: 'value matches none of the allowed types' });
      return;
    }
  }

  if ('const' in schema && !deepEqual(value, schema.const)) out.push({ path: at, message: 'value is not the required constant' });
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(value, item))) out.push({ path: at, message: 'value not in enum' });

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) out.push({ path: at, message: `string shorter than minLength ${schema.minLength}` });
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) out.push({ path: at, message: `string longer than maxLength ${schema.maxLength}` });
    if (typeof schema.pattern === 'string') {
      let regex: RegExp;
      try {
        regex = new RegExp(schema.pattern);
      } catch {
        out.push({ path: at, message: 'schema pattern is not a valid regular expression' });
        return;
      }
      if (!regex.test(value)) out.push({ path: at, message: 'string does not match pattern' });
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) out.push({ path: at, message: `number below minimum ${schema.minimum}` });
    if (typeof schema.maximum === 'number' && value > schema.maximum) out.push({ path: at, message: `number above maximum ${schema.maximum}` });
  }

  const properties = asRecord(schema.properties);
  if (jsonTypeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.hasOwn(object, key)) out.push({ path: at, message: `missing required property "${key}"` });
      }
    }
    if (properties) {
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(object, key)) continue;
        const childSchema = asRecord(child);
        if (childSchema) visit(object[key], childSchema, at === ROOT_PATH ? key : `${at}.${key}`, out);
      }
    }
    if (schema.additionalProperties === false) {
      const declared = new Set(Object.keys(properties ?? {}));
      for (const key of Object.keys(object)) {
        if (!declared.has(key)) out.push({ path: at, message: `unexpected property "${key}"` });
      }
    } else {
      const extra = asRecord(schema.additionalProperties);
      if (extra) {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (properties && Object.hasOwn(properties, key)) continue;
          visit(child, extra, at === ROOT_PATH ? key : `${at}.${key}`, out);
        }
      }
    }
  }

  if (Array.isArray(value)) {
    const items = asRecord(schema.items);
    if (items) {
      value.forEach((item, index) => visit(item, items, `${at}[${index}]`, out));
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  const recordA = asRecord(a);
  const recordB = asRecord(b);
  if (recordA && recordB) {
    const keysA = Object.keys(recordA);
    const keysB = Object.keys(recordB);
    return keysA.length === keysB.length && keysA.every((key) => Object.hasOwn(recordB, key) && deepEqual(recordA[key], recordB[key]));
  }
  return false;
}
