import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { JsonObject, JsonSchema } from './types.js';

export function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function resolveWorkspacePath(workspaceDir: string, stateDir: string, input = '.'): string {
  const realWorkspace = realpathSync(workspaceDir);
  const realState = existsSync(stateDir) ? realpathSync(stateDir) : path.resolve(realWorkspace, path.relative(workspaceDir, stateDir));
  const candidate = path.resolve(realWorkspace, input);
  const relative = path.relative(realWorkspace, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path escapes workspace: ${input}`);
  const stateRelative = path.relative(realState, candidate);
  if (!stateRelative.startsWith('..') && !path.isAbsolute(stateRelative)) throw new Error('Internal MyTerminal state is protected.');
  if (existsSync(candidate)) {
    const real = realpathSync(candidate);
    const realRelative = path.relative(realWorkspace, real);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error(`Symlink escapes workspace: ${input}`);
    return real;
  }
  let ancestor = path.dirname(candidate);
  while (!existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
  const realParent = realpathSync(ancestor);
  const parentRelative = path.relative(realWorkspace, realParent);
  if (parentRelative.startsWith('..') || path.isAbsolute(parentRelative)) throw new Error(`Parent escapes workspace: ${input}`);
  return candidate;
}

export function validateJsonSchema(schema: JsonSchema, value: unknown, label = 'input'): string[] {
  const errors: string[] = [];
  const type = schema.type;
  const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (type && actualType !== type && !(type === 'integer' && typeof value === 'number' && Number.isInteger(value))) {
    return [`${label} must be ${type}`];
  }
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) errors.push(`${label} must be one of the declared enum values`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${label} is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${label} is longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${label} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${label} is above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${label} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${label} has too many items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateJsonSchema(schema.items!, item, `${label}[${index}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as JsonObject;
    for (const required of schema.required ?? []) if (!(required in object)) errors.push(`${label}.${required} is required`);
    for (const [key, item] of Object.entries(object)) {
      const child = schema.properties?.[key];
      if (child) errors.push(...validateJsonSchema(child, item, `${label}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${label}.${key} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validateJsonSchema(schema.additionalProperties, item, `${label}.${key}`));
    }
  }
  return errors;
}

export function renderTemplate(value: string, input: JsonObject): string {
  return value.replace(/\{\{\s*input\.([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const replacement = input[key];
    if (replacement === undefined || replacement === null) return '';
    if (typeof replacement === 'object') return JSON.stringify(replacement);
    return String(replacement);
  });
}
