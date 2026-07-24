import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StoredState } from './types.js';

const EMPTY: StoredState = { schemaVersion: 2, revision: 0, sessions: [], messages: [], events: [], subscriptions: [], appBindings: [], extensions: [] };

function readState(dir: string): StoredState | undefined {
  const file = path.join(dir, 'state.json');
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredState;
    if (parsed.schemaVersion !== 2) return undefined;
    return parsed;
  } catch { return undefined; }
}

function newer<T extends { updatedAt?: string; createdAt?: string }>(left: T, right: T): T {
  const l = left.updatedAt || left.createdAt || '';
  const r = right.updatedAt || right.createdAt || '';
  return r > l ? { ...left, ...right } : { ...right, ...left };
}

function mergeBy<T>(items: T[], key: (item: T) => string, merge?: (a: T, b: T) => T): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    const previous = map.get(id);
    map.set(id, previous && merge ? merge(previous, item) : previous || item);
  }
  return [...map.values()];
}

function stableKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function mergeStoredStates(states: StoredState[]): StoredState {
  const valid = states.filter(Boolean);
  return {
    ...EMPTY,
    revision: Math.max(0, ...valid.map((state) => state.revision || 0)) + 1,
    sessions: mergeBy(valid.flatMap((state) => state.sessions || []), (item) => item.id, newer),
    messages: mergeBy(valid.flatMap((state) => state.messages || []), (item) => item.id),
    events: mergeBy(valid.flatMap((state) => state.events || []), (item) => item.id),
    subscriptions: mergeBy(valid.flatMap((state) => state.subscriptions || []), (item) => `${item.subscriberSessionId}:${item.targetSessionId}`),
    appBindings: mergeBy(valid.flatMap((state) => state.appBindings || []), (item) => item.clientSessionKey),
    extensions: mergeBy(valid.flatMap((state) => state.extensions || []), (item) => item.name),
  };
}

function mergeHistory(targetDir: string, sources: string[]): void {
  const targetHistory = path.join(targetDir, 'history');
  mkdirSync(targetHistory, { recursive: true, mode: 0o700 });
  const names = new Set<string>();
  for (const source of sources) {
    const dir = path.join(source, 'history');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (name.endsWith('.jsonl')) names.add(name);
  }
  for (const name of names) {
    const lines: string[] = [];
    for (const source of [targetDir, ...sources]) {
      const file = path.join(source, 'history', name);
      if (!existsSync(file)) continue;
      lines.push(...readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean));
    }
    const unique = new Map<string, string>();
    for (const line of lines) unique.set(stableKey(line), line);
    const sorted = [...unique.values()].sort((a, b) => {
      try { return String(JSON.parse(a).at || '').localeCompare(String(JSON.parse(b).at || '')); } catch { return a.localeCompare(b); }
    });
    writeFileSync(path.join(targetHistory, name), sorted.length ? `${sorted.join('\n')}\n` : '', { mode: 0o600 });
  }
}

export function migrateWorkspaceState(targetDir: string, sourceDirs: string[]): { sources: string[]; sessions: number } {
  const sources = [...new Set(sourceDirs.map((item) => path.resolve(item)))].filter((item) => item !== path.resolve(targetDir) && existsSync(item));
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const states = [readState(targetDir), ...sources.map(readState)].filter((item): item is StoredState => Boolean(item));
  if (states.length) {
    const merged = mergeStoredStates(states);
    writeFileSync(path.join(targetDir, 'state.json'), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    mergeHistory(targetDir, sources);
    writeFileSync(path.join(targetDir, 'migration.json'), `${JSON.stringify({ schemaVersion: 1, sources, sessions: merged.sessions.length, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    return { sources, sessions: merged.sessions.length };
  }
  return { sources, sessions: 0 };
}
