// Single source of truth for secret redaction (ADR-0026).
//
// Every egress that can carry user/secret data — HTTP responses, logs,
// audit records, error messages — must route through redact() so that a new
// egress cannot silently bypass redaction. This replaces the previously
// forked implementations in store.ts (object form) and update-transaction.ts
// (string form) with one module.
//
// Semantics intentionally match the former store.ts sanitizer:
//   - values under sensitive keys (token/secret/password/...) -> "[REDACTED]"
//   - values under body/content keys -> "[REDACTED <n> chars]" (string) else "[REDACTED]"
//   - free strings -> regex redaction (Bearer, key=value, ?key=) + literal secret sweep
//   - accepts both object and string input ("dual form")

const SENSITIVE_KEY = /token|authorization|claimcode|credential|connectorkey|secret|password|api[_-]?key/i;
const BODY_KEY = /body|content/i;
const BEARER_RE = /\bBearer\s+\S+/gi;
const KEY_VALUE_RE = /(["']?(?:token|authorization|credential|claimCode|connectorKey|secret|password|api[_-]?key)["']?\s*[:=]\s*)(["']?)[^\s,}\]]+/gi;
const QUERY_RE = /([?&](?:token|key|secret|password|api[_-]?key)=)[^&\s]+/gi;

type JsonValue = unknown;

function collectSensitiveValues(value: JsonValue, key = '', found = new Set<string>()): Set<string> {
  if (SENSITIVE_KEY.test(key) || BODY_KEY.test(key)) {
    if (typeof value === 'string' && value.length >= 4) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveValues(item, '', found);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, JsonValue>)) {
      collectSensitiveValues(child, childKey, found);
    }
  }
  return found;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 逐字替换所有 secrets 的出现。旧实现是 `for (secret of secrets) split/join`——审计事件
 * （#102：120 条消息后每条查询 ~4MB，secrets 达百条）下 O(字符串数 × secrets 数) 的
 * 数组分配洪水（实测单次 ~1s）。改为把 secrets 转义后合并成单条 alternation，一次
 * replace 完成：每字符串 O(长度)。交替顺序 = secrets 发现顺序，与旧 split/join 的
 * 应用顺序一致，重叠 secret 的胜负裁决逐字不变（#102-AC1 已钉契约）。 */
function redactString(value: string, secretsRegex?: RegExp): string {
  let out = value
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(KEY_VALUE_RE, '$1$2[REDACTED]')
    .replace(QUERY_RE, '$1[REDACTED]');
  if (secretsRegex) out = out.replace(secretsRegex, '[REDACTED]');
  return out;
}

function sanitize(value: JsonValue, key: string, secretsRegex?: RegExp): JsonValue {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (BODY_KEY.test(key)) return typeof value === 'string' ? `[REDACTED ${value.length} chars]` : '[REDACTED]';
  if (typeof value === 'string') return redactString(value, secretsRegex);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, '', secretsRegex));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, JsonValue>).map(([childKey, child]) => [childKey, sanitize(child, childKey, secretsRegex)]),
    );
  }
  return value;
}

export function redact<T = JsonValue>(value: T): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  const secrets = collectSensitiveValues(value);
  const secretsRegex = secrets.size ? new RegExp([...secrets].map(escapeRegExp).join('|'), 'g') : undefined;
  return sanitize(value, '', secretsRegex) as T;
}
