import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { JsonObject, JsonSchema } from './types.js';

export function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

// --- SEC-01: user-supplied regular expressions ---------------------------------
//
// Two independent layers guard `search_text --regex`:
//
//  1. `validateSafeRegex` (below) is a cheap, conservative *static gate*. It
//     rejects the well-known catastrophic-backtracking shapes before anything is
//     compiled, so the common abuse cases fail fast and without cost. A static
//     shape check can never be complete (e.g. `a*a*a*a*a*a*b` is exponential but
//     structurally ordinary), so it is NOT the security boundary.
//  2. `IsolatedRegexMatcher` is the authoritative guard: the pattern is compiled
//     and executed in a separate process, and if a match attempt outlives its
//     wall-clock budget that process is killed. A pathological pattern therefore
//     cannot block the event loop regardless of how it looks.
export const REGEX_SOURCE_MAX_LENGTH = 1000;
// Hard wall-clock ceiling for one isolated match request (and for startup).
export const REGEX_MATCH_TIMEOUT_MS = 2_000;
// Upper bound on the characters handed to the matcher in one round trip, so a
// single huge line or a huge file cannot turn into an unbounded request.
export const REGEX_BATCH_MAX_CHARS = 128_000;

export function validateSafeRegex(source: string): void {
  if (typeof source !== 'string' || source.length === 0) throw new Error('Regex source must be a non-empty string.');
  if (source.length > REGEX_SOURCE_MAX_LENGTH) throw new Error(`Regex source exceeds the ${REGEX_SOURCE_MAX_LENGTH}-character limit.`);
  const normalized = source
    .replace(/\\./g, '·') // drop escaped chars so '.' etc. are not read as atoms
    .replace(/\[[^\]]*\]/g, 'x'); // collapse char classes to a single atom
  const groupStarts: number[] = [];
  const groupHasQuantifier: boolean[] = [];
  const isQuantifier = (ch: string): boolean => ch === '*' || ch === '+' || ch === '?' || ch === '{';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '(') {
      groupStarts.push(i);
      groupHasQuantifier.push(false);
      if (normalized[i + 1] === '?') {
        // Skip the group-type marker (`?:`, `?<name>`, `?=`, `?!`, `?<=`, `?<!`)
        // so its '?' is not mistaken for a quantifier on the group.
        if (normalized[i + 2] === '<' && normalized[i + 3] !== '=' && normalized[i + 3] !== '!') {
          const close = normalized.indexOf('>', i + 3);
          i = close >= 0 ? close : i + 2;
        } else {
          i += 2;
        }
      }
    } else if (ch === ')') {
      if (groupHasQuantifier.length === 0) throw new Error('Unbalanced parentheses in regex source.');
      const groupStart = groupStarts.pop()!;
      const had = groupHasQuantifier.pop()!;
      if (had && groupHasQuantifier.length > 0) groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      const outer = normalized[i + 1] ?? '';
      if (had && isQuantifier(outer)) throw new Error('Regex contains nested quantifiers and may cause catastrophic backtracking (ReDoS).');
      if (outer === '*' || outer === '+' || outer === '{') {
        const body = normalized.slice(groupStart + 1, i);
        if (hasAmbiguousAlternation(body)) {
          throw new Error('Regex repeats an alternation with overlapping branches and may cause catastrophic backtracking (ReDoS).');
        }
      }
    } else if (isQuantifier(ch)) {
      if (groupHasQuantifier.length > 0) groupHasQuantifier[groupHasQuantifier.length - 1] = true;
    }
  }
  if (groupHasQuantifier.length !== 0) throw new Error('Unbalanced parentheses in regex source.');
}

// True when the top-level alternatives of a sub-expression can match a shared
// prefix (e.g. `a|ab`, `x|x`, or an empty branch). Repeating such a group is the
// classic polynomial/exponential shape `(a|aa)+` that nesting checks miss.
function hasAmbiguousAlternation(rawBody: string): boolean {
  const body = stripGroupPrefix(rawBody);
  const branches: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === '|' && depth === 0) {
      branches.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  branches.push(current);
  if (branches.length < 2) return false;
  if (branches.some((branch) => branch.length === 0)) return true;
  for (let i = 0; i < branches.length; i += 1) {
    for (let j = 0; j < branches.length; j += 1) {
      // Identical or prefix-related branches (a|aa, x|x) are ambiguous: the
      // engine cannot tell which alternative consumed the input.
      if (i !== j && branches[j].length > 0 && branches[i].startsWith(branches[j])) return true;
    }
  }
  return false;
}

// `(?:a|aa)+`, `(?<name>a|aa)+` and `(?=...)` all share the `?` prefix syntax;
// it carries no meaning for the ambiguity check and is stripped.
function stripGroupPrefix(body: string): string {
  if (!body.startsWith('?')) return body;
  if (body.startsWith('?:')) return body.slice(2);
  if (body.startsWith('?<')) {
    const close = body.indexOf('>');
    return close >= 0 ? body.slice(close + 1) : body.slice(2);
  }
  return body.slice(2);
}

// Runs in a separate process: one JSON request per stdin line, one JSON response
// per stdout line. It owns the only live `RegExp` object for the whole search.
const REGEX_WORKER_SCRIPT = `
const readline = require('node:readline');
const send = (value) => { process.stdout.write(JSON.stringify(value) + '\\n'); };
let regex = null;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  try {
    if (message.type === 'init') {
      regex = new RegExp(message.source, message.flags || 'i');
      send({ type: 'result', id: message.id, matched: [] });
      return;
    }
    if (!regex) throw new Error('Regex matcher is not initialised.');
    const matched = [];
    const stopAfter = message.stopAfter > 0 ? message.stopAfter : Infinity;
    const lines = message.lines || [];
    for (let index = 0; index < lines.length; index += 1) {
      if (matched.length >= stopAfter) break;
      if (regex.test(lines[index])) matched.push(index);
    }
    send({ type: 'result', id: message.id, matched });
  } catch (error) {
    send({
      type: 'error',
      id: message.id,
      name: (error && error.name) || 'Error',
      message: String((error && error.message) || error),
    });
  }
});
`;

type RegexWorkerRequest =
  | { type: 'init'; source: string; flags: string }
  | { type: 'test'; lines: string[]; stopAfter: number };

type RegexWorkerMessage =
  | { type: 'result'; id: number; matched: number[] }
  | { type: 'error'; id?: number; name?: string; message: string };

type PendingRequest = {
  resolve: (matched: number[]) => void;
  reject: (error: Error) => void;
};

export type RegexBatchOutcome = { status: 'ok'; matched: number[] } | { status: 'timeout' };

type RegexRuntimeCandidate = { command: string; args: string[]; env: NodeJS.ProcessEnv };

// Isolation is a child process, not a worker thread: `Worker#terminate()` cannot
// preempt a native `RegExp` call under Bun (the thread keeps backtracking forever
// and `terminate()` never settles), while SIGKILL on a child process always does.
// `-e` keeps matcher startup at one module load; BUN_BE_BUN makes a compiled
// `myterminal` binary behave like `bun` so the same command serves source runs,
// `bun test` and the packaged binary (a plain `bun`/`node` run ignores it).
function regexRuntimeCandidates(): RegexRuntimeCandidate[] {
  const args = ['-e', REGEX_WORKER_SCRIPT];
  const versions = process.versions as Record<string, string | undefined>;
  if (versions.bun) return [{ command: process.execPath, args, env: { ...process.env, BUN_BE_BUN: '1' } }];
  return [{ command: process.execPath, args, env: process.env }];
}

// Interruptible, isolated execution of a single user-supplied pattern.
//
// The pattern only ever runs in a child process. Every request carries a hard
// wall-clock budget; when it expires the child is killed (a native `RegExp` call
// cannot be cancelled cooperatively) and the request reports `timeout`. The
// killed matcher is single-use and must be disposed by the caller.
export class IsolatedRegexMatcher {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly reader: Interface;
  private nextId = 1;
  private closed = false;
  private disposal: Promise<void> | undefined;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {
    this.reader = createInterface({ input: child.stdout });
    this.reader.on('line', (line: string) => this.onLine(line));
    // stderr is only diagnostic output; drain it so the child can never block.
    child.stderr.resume();
    child.on('error', (error: Error) => this.onGone(error));
    child.on('exit', (code, signal) => this.onGone(new Error(`Regex matcher exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`)));
  }

  /**
   * Compiles `source` in a fresh child process. Rejects if the pattern is
   * invalid or if no runtime can be spawned — regex search fails closed rather
   * than falling back to executing the pattern on the event loop.
   */
  static async create(source: string, options: { flags?: string; timeoutMs?: number } = {}): Promise<IsolatedRegexMatcher> {
    if (typeof source !== 'string' || source.length === 0) throw new Error('Regex source must be a non-empty string.');
    if (source.length > REGEX_SOURCE_MAX_LENGTH) throw new Error(`Regex source exceeds the ${REGEX_SOURCE_MAX_LENGTH}-character limit.`);
    const timeoutMs = Math.max(25, Math.floor(options.timeoutMs ?? REGEX_MATCH_TIMEOUT_MS));
    const startupMs = Math.max(1_000, Math.min(timeoutMs, 5_000));
    let lastError: Error | undefined;
    for (const candidate of regexRuntimeCandidates()) {
      let matcher: IsolatedRegexMatcher | undefined;
      try {
        matcher = new IsolatedRegexMatcher(
          spawn(candidate.command, candidate.args, { env: candidate.env, windowsHide: true }),
          timeoutMs,
        );
        const started = await matcher.send({ type: 'init', source, flags: options.flags ?? 'i' }, startupMs);
        if (started === null) throw new Error('Regex matcher did not start within the time budget.');
        return matcher;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await matcher?.dispose();
      }
    }
    throw lastError ?? new Error('No JavaScript runtime is available to run the regex matcher.');
  }

  /**
   * Returns the indices of matching lines. `stopAfter` caps the number of
   * reported matches and `deadline` (epoch ms) bounds the whole batch; when
   * either the per-request budget or the deadline expires the outcome is
   * `timeout` and the child has already been killed.
   */
  async testLines(lines: string[], options: { stopAfter?: number; deadline?: number } = {}): Promise<RegexBatchOutcome> {
    const stopAfter = typeof options.stopAfter === 'number' && options.stopAfter > 0 ? options.stopAfter : 0;
    const matched: number[] = [];
    let offset = 0;
    while (offset < lines.length) {
      if (stopAfter > 0 && matched.length >= stopAfter) break;
      if (options.deadline !== undefined && Date.now() >= options.deadline) return { status: 'timeout' };
      const remaining = options.deadline === undefined ? this.timeoutMs : Math.min(this.timeoutMs, options.deadline - Date.now());
      const chunk = chunkLines(lines, offset);
      const result = await this.send({ type: 'test', lines: chunk, stopAfter: stopAfter > 0 ? stopAfter - matched.length : 0 }, Math.max(1, remaining));
      if (result === null) return { status: 'timeout' };
      for (const index of result) matched.push(offset + index);
      offset += chunk.length;
    }
    return { status: 'ok', matched };
  }

  /** Releases the child process. Safe to call more than once. */
  async dispose(): Promise<void> {
    this.failPending(new Error('Regex matcher disposed.'));
    try {
      this.reader.close();
    } catch {
      // already closed
    }
    try {
      this.child.stdin.end();
    } catch {
      // pipe already gone
    }
    await this.terminate();
  }

  private send(payload: RegexWorkerRequest, timeoutMs: number): Promise<number[] | null> {
    if (this.closed) return Promise.reject(new Error('Regex matcher is closed.'));
    const id = this.nextId++;
    return new Promise<number[] | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The child is stuck inside one native RegExp call and cannot be asked to
        // stop cooperatively, so kill it. A killed matcher is not reusable.
        void this.terminate();
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (matched) => {
          clearTimeout(timer);
          resolve(matched);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onLine(line: string): void {
    if (!line) return;
    let message: RegexWorkerMessage;
    try {
      message = JSON.parse(line) as RegexWorkerMessage;
    } catch {
      return;
    }
    if (message.type === 'error' && message.id === undefined) {
      this.onGone(new Error(message.message));
      return;
    }
    const id = message.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.type === 'result') {
      pending.resolve(message.matched);
      return;
    }
    const error = new Error(message.message);
    if (message.name) error.name = message.name;
    pending.reject(error);
  }

  private onGone(error: Error): void {
    this.closed = true;
    this.failPending(error);
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(error);
  }

  private terminate(): Promise<void> {
    this.closed = true;
    this.disposal ??= new Promise<void>((resolve) => {
      const child = this.child;
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      // SIGKILL is immediate; the guard only exists so a wedged process cannot
      // hold the event loop open forever.
      const guard = setTimeout(resolve, 2_000);
      child.once('exit', () => {
        clearTimeout(guard);
        resolve();
      });
      try {
        child.kill('SIGKILL');
      } catch {
        clearTimeout(guard);
        resolve();
      }
    });
    return this.disposal;
  }
}

// Splits `lines` into a bounded request: a chunk never exceeds REGEX_BATCH_MAX_CHARS
// (except for a single line that is larger on its own, which the time budget covers).
function chunkLines(lines: string[], offset: number): string[] {
  const chunk: string[] = [];
  let chars = 0;
  for (let index = offset; index < lines.length; index += 1) {
    const line = lines[index];
    if (chunk.length > 0 && chars + line.length > REGEX_BATCH_MAX_CHARS) break;
    chunk.push(line);
    chars += line.length;
  }
  return chunk;
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
