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

function redactString(value: string, secrets: Set<string>): string {
  let out = value
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(KEY_VALUE_RE, '$1$2[REDACTED]')
    .replace(QUERY_RE, '$1[REDACTED]');
  for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
  return out;
}

function sanitize(value: JsonValue, key: string, secrets: Set<string>): JsonValue {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (BODY_KEY.test(key)) return typeof value === 'string' ? `[REDACTED ${value.length} chars]` : '[REDACTED]';
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, '', secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, JsonValue>).map(([childKey, child]) => [childKey, sanitize(child, childKey, secrets)]),
    );
  }
  return value;
}

export function redact<T = JsonValue>(value: T): T {
  if (typeof value === 'string') return redactString(value, new Set()) as unknown as T;
  const secrets = collectSensitiveValues(value);
  return sanitize(value, '', secrets) as T;
}
