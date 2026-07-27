import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MyTerminalConfig } from './types.js';
import { MyTerminalError, publicSession, type MyTerminalStore } from './store.js';
import { resolveWorkspacePath } from './security.js';
import type { JsonObject, JsonSchema, TaskPackage, ToolDefinition } from './types.js';
import { disarmSessionResources } from './session-resources.js';
import { continuationPolicy } from './continuation.js';
import { listSkills, loadSkill } from './skills.js';
import { getSubagentRunner } from './subagent/runner.js';

const IGNORED_DIRECTORIES = new Set(['.git', '.myterminal', 'node_modules', 'dist', 'coverage', '.next', '.turbo']);

type CommandResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  cancelled: boolean;
};

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function boundedOutput(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, max)}\n… output truncated …`, truncated: true };
}

function decodeBlob(content: string, encoding: string): Buffer {
  if (encoding === 'utf-8') return Buffer.from(content, 'utf8');
  if (encoding !== 'base64' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new Error('encoding must be utf-8 or content must be valid base64.');
  return Buffer.from(content, 'base64');
}

async function runCommand(args: {
  executable: string;
  argv?: string[];
  cwd: string;
  timeoutSec: number;
  maxOutputChars: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  displayCommand?: string;
}): Promise<CommandResult> {
  const startedAt = Date.now();
  const child = spawn(args.executable, args.argv ?? [], {
    cwd: args.cwd,
    env: args.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    // A distinct Windows process group prevents forced timeout cleanup from
    // disturbing the Runtime's own console/ConPTY association.
    detached: true,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let cancelled = false;
  let windowsTermination: Promise<void> | undefined;
  const captureLimit = args.maxOutputChars * 2;
  child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < captureLimit) stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < captureLimit) stderr += chunk.toString('utf8'); });
  const terminate = (force: boolean) => {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], { stdio: 'ignore', windowsHide: true });
      windowsTermination ||= new Promise<void>((resolve) => {
        killer.once('error', () => {
          try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already exited */ }
          resolve();
        });
        killer.once('close', () => resolve());
      });
      return;
    }
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already exited */ } }
  };
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const requestStop = (reason: 'timeout' | 'cancel') => {
    if (reason === 'timeout') timedOut = true; else cancelled = true;
    // Windows has no process-group signal equivalent. Non-forced taskkill can
    // leave console descendants running until they finish naturally, so cancel
    // the owned tree atomically. POSIX retains a short graceful period.
    terminate(process.platform === 'win32');
    if (process.platform !== 'win32') {
      forceTimer ||= setTimeout(() => terminate(true), 1_500);
      forceTimer.unref();
    }
  };
  const timer = setTimeout(() => requestStop('timeout'), args.timeoutSec * 1000);
  const abort = () => requestStop('cancel');
  if (args.signal?.aborted) abort(); else args.signal?.addEventListener('abort', abort, { once: true });
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(() => {
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    args.signal?.removeEventListener('abort', abort);
  });
  if (windowsTermination) await windowsTermination;
  const boundedStdout = boundedOutput(stdout, args.maxOutputChars);
  const boundedStderr = boundedOutput(stderr, args.maxOutputChars);
  return {
    command: args.displayCommand ?? [args.executable, ...(args.argv ?? [])].join(' '),
    cwd: args.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut,
    stdout: boundedStdout.text,
    stderr: boundedStderr.text,
    truncated: boundedStdout.truncated || boundedStderr.truncated,
    durationMs: Date.now() - startedAt,
    cancelled,
  };
}

async function runShellCommand(args: {
  command: string;
  cwd: string;
  stateDir: string;
  timeoutSec: number;
  maxOutputChars: number;
  signal?: AbortSignal;
}): Promise<CommandResult> {
  if (process.platform !== 'win32') {
    return runCommand({
      executable: process.env.SHELL || '/bin/sh',
      argv: ['-lc', args.command],
      cwd: args.cwd,
      timeoutSec: args.timeoutSec,
      maxOutputChars: args.maxOutputChars,
      signal: args.signal,
      displayCommand: args.command,
    });
  }

  // Passing nested quotes through Bun -> CreateProcess -> cmd.exe /s /c can
  // change their meaning. A private one-shot batch file gives cmd exactly the
  // user command and also provides one stable process-tree root for timeout.
  const commandDir = path.join(args.stateDir, 'command-tasks', randomUUID());
  const commandFile = path.join(commandDir, 'run.cmd');
  await mkdir(commandDir, { recursive: true });
  await writeFile(commandFile, `@echo off\r\n${args.command}\r\n`, 'utf8');
  try {
    return await runCommand({
      executable: process.env.ComSpec || 'cmd.exe',
      argv: ['/d', '/q', '/c', commandFile],
      cwd: args.cwd,
      timeoutSec: args.timeoutSec,
      maxOutputChars: args.maxOutputChars,
      signal: args.signal,
      displayCommand: args.command,
    });
  } finally {
    await rm(commandDir, { recursive: true, force: true });
  }
}

function relative(config: MyTerminalConfig, absolute: string): string {
  return path.relative(config.workspaceDir, absolute) || '.';
}

async function walkFiles(config: MyTerminalConfig, start: string, limit: number): Promise<string[]> {
  const root = resolveWorkspacePath(config.workspaceDir, config.stateDir, start);
  const files: string[] = [];
  const queue = [root];
  while (queue.length && files.length < limit) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile()) files.push(absolute);
      if (files.length >= limit) break;
    }
  }
  return files;
}

export function createBuiltinTools(config: MyTerminalConfig, store: MyTerminalStore): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const add = (definition: ToolDefinition) => tools.set(definition.name, definition);
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
  const mutating = { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false };
  const localCreate = { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true };
  const actor = (context: Parameters<ToolDefinition['invoke']>[1]) => {
    if (!context.authenticatedSession) throw new MyTerminalError('IDENTITY_REQUIRED', 'Register or inherit a MyTerminal session before calling this tool.');
    return context.authenticatedSession;
  };

  add({
    name: 'workspace_info', title: 'Workspace info', description: 'Inspect the single authorized workspace and MyTerminal runtime.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: readOnly,
    invoke: async () => ({ workspaceDir: config.workspaceDir, platform: process.platform, node: process.version, stateRevision: store.revision() }),
  });
  add({
    name: 'list_dir', title: 'List directory', description: 'List one directory inside the authorized workspace.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', default: '.' } }, additionalProperties: false }, annotations: readOnly,
    invoke: async (input, context) => {
      const directory = resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.path) || '.');
      const entries = await readdir(directory, { withFileTypes: true });
      return { path: relative(config, directory), entries: entries.filter((entry) => !IGNORED_DIRECTORIES.has(entry.name)).slice(0, 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })), truncated: entries.length > 500 };
    },
  });
  add({
    name: 'find_files', title: 'Find files', description: 'Find files by case-insensitive path substring.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, path: { type: 'string', default: '.' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['query'], additionalProperties: false }, annotations: readOnly,
    aliases: { pattern: 'query' },
    invoke: async (input) => {
      const query = asString(input.query, 'query').toLowerCase();
      const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(500, input.limit)) : 100;
      const files = await walkFiles(config, asOptionalString(input.path) || '.', 10_000);
      const matches = files.map((file) => relative(config, file)).filter((file) => file.toLowerCase().includes(query)).slice(0, limit);
      return { matches, truncated: matches.length === limit };
    },
  });
  add({
    name: 'search_text', title: 'Search text', description: 'Search bounded UTF-8 files for text or a regular expression.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, path: { type: 'string', default: '.' }, regex: { type: 'boolean', default: false }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['query'], additionalProperties: false }, annotations: readOnly,
    aliases: { pattern: 'query' },
    invoke: async (input) => {
      const query = asString(input.query, 'query');
      const matcher = input.regex ? new RegExp(query, 'i') : undefined;
      const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(500, input.limit)) : 100;
      const files = await walkFiles(config, asOptionalString(input.path) || '.', 2_000);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const file of files) {
        if (matches.length >= limit) break;
        const fileStat = await stat(file);
        if (fileStat.size > 1_000_000) continue;
        let text: string;
        try { text = await readFile(file, 'utf8'); } catch { continue; }
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (matcher ? matcher.test(line) : line.toLowerCase().includes(query.toLowerCase())) matches.push({ path: relative(config, file), line: index + 1, text: line.slice(0, 500) });
          if (matches.length >= limit) break;
        }
      }
      return { matches, truncated: matches.length >= limit };
    },
  });
  add({
    name: 'read_file', title: 'Read file', description: 'Read a bounded UTF-8 file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, maxBytes: { type: 'integer', minimum: 1, maximum: 1_000_000 } }, required: ['path'], additionalProperties: false }, annotations: readOnly,
    invoke: async (input) => {
      const file = resolveWorkspacePath(config.workspaceDir, config.stateDir, asString(input.path, 'path'));
      const maxBytes = typeof input.maxBytes === 'number' ? Math.min(1_000_000, input.maxBytes) : 256_000;
      const buffer = await readFile(file);
      const content = buffer.subarray(0, maxBytes).toString('utf8');
      return { path: relative(config, file), content, sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length, truncated: buffer.length > maxBytes };
    },
  });
  add({
    name: 'read_file_range', title: 'Read file lines', description: 'Read a line range with a content hash.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['path', 'startLine', 'endLine'], additionalProperties: false }, annotations: readOnly,
    invoke: async (input) => {
      const file = resolveWorkspacePath(config.workspaceDir, config.stateDir, asString(input.path, 'path'));
      const content = await readFile(file, 'utf8');
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, Number(input.startLine));
      const end = Math.max(start, Math.min(lines.length, Number(input.endLine)));
      return { path: relative(config, file), startLine: start, endLine: end, totalLines: lines.length, content: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n'), sha256: createHash('sha256').update(content).digest('hex') };
    },
  });
  add({
    name: 'write_file', title: 'Write file', description: 'Create or replace one UTF-8 file inside the workspace.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' }, expectedSha256: { type: 'string' }, createParents: { type: 'boolean' } }, required: ['path', 'content'], additionalProperties: false }, annotations: mutating,
    invoke: async (input) => {
      const file = resolveWorkspacePath(config.workspaceDir, config.stateDir, asString(input.path, 'path'));
      if (input.expectedSha256) {
        const current = await readFile(file);
        const actual = createHash('sha256').update(current).digest('hex');
        if (actual !== input.expectedSha256) throw new Error(`File changed: expected ${input.expectedSha256}, got ${actual}`);
      }
      if (input.createParents) await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, asString(input.content, 'content'), 'utf8');
      return { path: relative(config, file), bytes: Buffer.byteLength(String(input.content)), sha256: createHash('sha256').update(String(input.content)).digest('hex') };
    },
  });
  add({
    name: 'apply_patch', title: 'Apply exact patch', description: 'Apply exact text replacements with optional SHA protection.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, expectedSha256: { type: 'string' }, replacements: { type: 'array', minItems: 1, items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['oldText', 'newText'], additionalProperties: false } } }, required: ['path', 'replacements'], additionalProperties: false }, annotations: mutating,
    invoke: async (input) => {
      const file = resolveWorkspacePath(config.workspaceDir, config.stateDir, asString(input.path, 'path'));
      let content = await readFile(file, 'utf8');
      const beforeHash = createHash('sha256').update(content).digest('hex');
      if (input.expectedSha256 && input.expectedSha256 !== beforeHash) throw new Error(`File changed: expected ${input.expectedSha256}, got ${beforeHash}`);
      for (const replacement of input.replacements as Array<JsonObject>) {
        const oldText = asString(replacement.oldText, 'oldText');
        const newText = asString(replacement.newText, 'newText');
        const occurrences = content.split(oldText).length - 1;
        if (occurrences === 0) throw new Error('Patch oldText was not found.');
        if (occurrences > 1 && !replacement.replaceAll) throw new Error('Patch oldText matched more than once; set replaceAll=true explicitly.');
        content = replacement.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
      }
      await writeFile(file, content, 'utf8');
      return { path: relative(config, file), beforeSha256: beforeHash, afterSha256: createHash('sha256').update(content).digest('hex') };
    },
  });
  add({
    name: 'blob_create', title: 'Create local blob', description: 'Store UTF-8 or base64 content in a local content-addressed staging blob without changing workspace files or contacting external services.',
    inputSchema: { type: 'object', properties: { content: { type: 'string', maxLength: 1_400_000 }, encoding: { type: 'string', enum: ['utf-8', 'base64'], default: 'utf-8' } }, required: ['content'], additionalProperties: false }, annotations: localCreate,
    invoke: async (input) => {
      const buffer = decodeBlob(asString(input.content, 'content'), asOptionalString(input.encoding) || 'utf-8');
      if (buffer.length > 1_000_000) throw new Error('Decoded blob content must not exceed 1,000,000 bytes.');
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const directory = path.join(config.stateDir, 'blobs');
      const file = path.join(directory, sha256);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { await writeFile(file, buffer, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      return { sha256, bytes: buffer.length, encoding: input.encoding === 'base64' ? 'base64' : 'utf-8', staged: true };
    },
  });
  add({
    name: 'blob_read', title: 'Read local blob', description: 'Read bounded content from a previously staged local blob without changing files.',
    inputSchema: { type: 'object', properties: { sha256: { type: 'string', minLength: 64, maxLength: 64 }, encoding: { type: 'string', enum: ['utf-8', 'base64'], default: 'utf-8' }, maxBytes: { type: 'integer', minimum: 1, maximum: 1_000_000 } }, required: ['sha256'], additionalProperties: false }, annotations: readOnly,
    invoke: async (input) => {
      const sha256 = asString(input.sha256, 'sha256');
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('sha256 must contain 64 lowercase hexadecimal characters.');
      const buffer = await readFile(path.join(config.stateDir, 'blobs', sha256));
      const maxBytes = typeof input.maxBytes === 'number' ? input.maxBytes : 256_000;
      const bounded = buffer.subarray(0, maxBytes);
      return { sha256, bytes: buffer.length, truncated: buffer.length > maxBytes, encoding: input.encoding === 'base64' ? 'base64' : 'utf-8', content: input.encoding === 'base64' ? bounded.toString('base64') : bounded.toString('utf8') };
    },
  });
  add({
    name: 'blob_write_file', title: 'Create file from blob', description: 'Create a workspace file from a staged blob. Repeating the same content succeeds; different existing content is never overwritten.',
    inputSchema: { type: 'object', properties: { sha256: { type: 'string', minLength: 64, maxLength: 64 }, path: { type: 'string', minLength: 1 }, createParents: { type: 'boolean', default: false } }, required: ['sha256', 'path'], additionalProperties: false }, annotations: localCreate,
    invoke: async (input) => {
      const sha256 = asString(input.sha256, 'sha256');
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('sha256 must contain 64 lowercase hexadecimal characters.');
      const buffer = await readFile(path.join(config.stateDir, 'blobs', sha256));
      if (createHash('sha256').update(buffer).digest('hex') !== sha256) throw new Error('Staged blob integrity check failed.');
      const file = resolveWorkspacePath(config.workspaceDir, config.stateDir, asString(input.path, 'path'));
      if (input.createParents) await mkdir(path.dirname(file), { recursive: true });
      try { await writeFile(file, buffer, { flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await readFile(file);
        const existingSha256 = createHash('sha256').update(existing).digest('hex');
        if (existingSha256 !== sha256) throw new Error('Target file already exists with different content; blob_write_file never overwrites files.');
        return { path: relative(config, file), bytes: existing.length, sha256, alreadyExisted: true };
      }
      return { path: relative(config, file), bytes: buffer.length, sha256, alreadyExisted: false };
    },
  });
  add({
    name: 'execute_cli', title: 'Execute command', description: 'Execute one bounded shell command in the workspace.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 20_000 }, cwd: { type: 'string' }, timeoutSec: { type: 'integer', minimum: 1, maximum: 3600 } }, required: ['command'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    invoke: async (input, context) => {
      const cwd = resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.cwd) || '.');
      return await runShellCommand({ command: asString(input.command, 'command'), cwd, stateDir: config.stateDir, timeoutSec: typeof input.timeoutSec === 'number' ? input.timeoutSec : config.commandTimeoutSec, maxOutputChars: config.maxOutputChars, signal: context.signal }) as unknown as JsonObject;
    },
  });

  for (const gitTool of [
    ['git_status', ['status', '--short', '--branch']],
    ['git_diff', ['diff']],
    ['git_log', ['log', '--oneline', '-n', '30']],
  ] as const) {
    add({
      name: gitTool[0], title: gitTool[0].replace('_', ' '), description: `Run bounded ${gitTool[0]} in the workspace.`,
      inputSchema: { type: 'object', properties: { cwd: { type: 'string' } }, additionalProperties: false }, annotations: readOnly,
      invoke: async (input, context) => await runCommand({ executable: 'git', argv: [...gitTool[1]], cwd: resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.cwd) || '.'), timeoutSec: 30, maxOutputChars: config.maxOutputChars, signal: context.signal }) as unknown as JsonObject,
    });
  }
  add({
    name: 'git_show', title: 'Git show', description: 'Show one bounded Git revision or object.',
    inputSchema: { type: 'object', properties: { revision: { type: 'string', minLength: 1 }, cwd: { type: 'string' } }, required: ['revision'], additionalProperties: false }, annotations: readOnly,
    invoke: async (input, context) => {
      const revision = asString(input.revision, 'revision');
      if (!/^[A-Za-z0-9_./~^{}:@+-]+$/.test(revision)) throw new Error('Unsafe Git revision syntax.');
      return await runCommand({ executable: 'git', argv: ['show', '--stat', '--oneline', revision], cwd: resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.cwd) || '.'), timeoutSec: 30, maxOutputChars: config.maxOutputChars, signal: context.signal }) as unknown as JsonObject;
    },
  });
  add({
    name: 'run_checks', title: 'Run project checks', description: 'Run declared typecheck, build, and test package scripts in order.',
    inputSchema: { type: 'object', properties: { includeTest: { type: 'boolean', default: true }, cwd: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    invoke: async (input, context) => {
      const cwd = resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.cwd) || '.');
      const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      const names = ['typecheck', 'build', ...(input.includeTest === false ? [] : ['test'])].filter((name) => pkg.scripts?.[name]);
      const results: JsonObject[] = [];
      for (const name of names) {
        const result = await runCommand({ executable: process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm', argv: process.platform === 'win32' ? ['/d', '/s', '/c', `npm run ${name}`] : ['run', name], cwd, timeoutSec: Math.max(config.commandTimeoutSec, 300), maxOutputChars: config.maxOutputChars, signal: context.signal });
        results.push({ name, ...result });
        if (result.exitCode !== 0) break;
      }
      return { scripts: names, results, passed: results.length === names.length && results.every((result) => result.exitCode === 0) };
    },
  });

  const stringList = { type: 'array', items: { type: 'string' }, maxItems: 100 } as const;
  const taskProperties = {
    objective: { type: 'string', minLength: 1, maxLength: 4000 }, background: { type: 'string', minLength: 1, maxLength: 4000 },
    deliverables: { ...stringList, minItems: 1 }, acceptanceCriteria: { ...stringList, minItems: 1 }, constraints: { ...stringList, minItems: 1 },
  };
  add({
    name: 'session_register', title: 'Register session', description: 'Create and claim a root session, or delegate one direct child from an authenticated root. Delegate by domain and parallel workload with a complete role/task package; do not offload one large objective wholesale to a single child.',
    inputSchema: {
      type: 'object', properties: {
        mode: { type: 'string', enum: ['root', 'delegate'], default: 'root' }, name: { type: 'string', minLength: 1, maxLength: 80 }, role: { type: 'string', maxLength: 80 },
        continuesSessionId: { type: 'string' }, task: { type: 'object', properties: taskProperties, required: ['objective', 'background', 'deliverables', 'acceptanceCriteria', 'constraints'], additionalProperties: false },
      }, required: ['mode', 'name'], additionalProperties: false,
    }, annotations: localCreate,
    invoke: async (input, context) => {
      const mode = input.mode === 'delegate' ? 'delegate' : 'root';
      if (mode === 'root') {
        const result = store.registerRoot({ name: asString(input.name, 'name'), role: asOptionalString(input.role), continuesSessionId: asOptionalString(input.continuesSessionId) });
        return { session: publicSession(result.session), identity: result.identity, context: store.context(result.session.id) };
      }
      const current = actor(context);
      if (!input.task || typeof input.task !== 'object' || Array.isArray(input.task)) throw new MyTerminalError('INVALID_INPUT', 'task is required for delegate mode.');
      const result = store.registerDelegate(current.id, { name: asString(input.name, 'name'), role: asOptionalString(input.role), task: input.task as TaskPackage, continuesSessionId: asOptionalString(input.continuesSessionId) });
      return { session: publicSession(result.session), claimCode: result.claimCode, handoffPrompt: result.handoffPrompt };
    },
  });
  add({
    name: 'session_inherit', title: 'Inherit session', description: 'Claim unfinished work. Use claimCode for handoff/released/revoked sessions, or the previous sessionToken to reclaim the same stale session after an interrupted ChatGPT run.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', minLength: 1 }, claimCode: { type: 'string', minLength: 1 }, sessionToken: { type: 'string', minLength: 1 } }, required: ['sessionId'], additionalProperties: false }, annotations: localCreate,
    invoke: async (input) => {
      const claimCode = asOptionalString(input.claimCode);
      const sessionToken = asOptionalString(input.sessionToken);
      if (!claimCode && !sessionToken) throw new MyTerminalError('INVALID_INPUT', 'Provide claimCode or the previous sessionToken.');
      const result = store.inherit(asString(input.sessionId, 'sessionId'), { claimCode, sessionToken });
      return { session: publicSession(result.session), identity: result.identity, context: result.context };
    },
  });
  add({
    name: 'session_list', title: 'List sessions', description: 'List the audited session hierarchy, phases, presence, and continuation links.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: readOnly,
    invoke: async (_input, context) => { actor(context); return { sessions: store.listSessions().map(publicSession) }; },
  });
  const plannedCall: JsonSchema = { type: 'object', properties: { tool: { type: 'string', minLength: 3, maxLength: 64 }, input: { type: 'object', additionalProperties: true }, purpose: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['tool', 'input'], additionalProperties: false };
  add({
    name: 'session_checkpoint', title: 'Checkpoint session', description: 'Record durable session state. When the optional enhanced Actions long-task harness is enabled, a working checkpoint requires 1-3 exact concrete nextCalls and the returned nextCall must run immediately.',
    inputSchema: { type: 'object', properties: { phase: { type: 'string', enum: ['pending', 'working', 'waiting', 'blocked', 'completed', 'cancelled'] }, summary: { type: 'string', minLength: 1, maxLength: 4000 }, nextSteps: stringList, blockers: stringList, artifacts: stringList, milestone: { type: 'string', maxLength: 1000 }, tags: stringList, nextCalls: { type: 'array', minItems: 1, maxItems: 3, items: plannedCall }, replanReason: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['phase', 'summary'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    invoke: async (input, context) => {
      const current = actor(context);
      if (context.transport === 'actions' && input.phase === 'working') {
        const policy = continuationPolicy(config.actionsContinuationMode);
        const count = Array.isArray(input.nextCalls) ? input.nextCalls.length : 0;
        if (policy.enabled && (count < policy.minCalls || count > policy.maxCalls)) {
          const expected = policy.exactCalls ? `exactly ${policy.exactCalls}` : `${policy.minCalls}-${policy.maxCalls}`;
          throw new MyTerminalError('CONTINUATION_PLAN_REQUIRED', `Actions ${config.actionsContinuationMode} mode requires ${expected} nextCalls on every working checkpoint.`, {
            continuationMode: config.actionsContinuationMode, minCalls: policy.minCalls, maxCalls: policy.maxCalls,
            ...(policy.exactCalls ? { requiredCount: policy.exactCalls } : {}), mustContinue: true, userFacingFinalProhibited: true,
            example: { phase: 'working', summary: 'Continue the active task.', nextCalls: Array.from({ length: policy.exactCalls ?? 1 }, () => ({ tool: 'workspace_info', input: {}, purpose: 'Execute the next concrete step.' })) },
          });
        }
      }
      const session = store.checkpoint(current.id, input);
      if (session.phase === 'completed' || session.phase === 'cancelled') disarmSessionResources(config, current.id);
      return { session: publicSession(session) };
    },
  });
  add({
    name: 'session_context', title: 'Read session context', description: 'Return the bounded 16K context projection for the authenticated session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: readOnly,
    invoke: async (_input, context) => ({ context: store.context(actor(context).id) }),
  });
  add({
    name: 'session_history', title: 'Read paginated session history', description: 'Read permanent structured history for the authenticated session and its continuation ancestors without overloading context.',
    inputSchema: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 }, includeAncestors: { type: 'boolean', default: true } }, additionalProperties: false }, annotations: readOnly,
    invoke: async (input, context) => ({ history: store.historyPage(actor(context).id, typeof input.offset === 'number' ? input.offset : 0, typeof input.limit === 'number' ? input.limit : 100, input.includeAncestors !== false) }),
  });
  add({
    name: 'session_release', title: 'Release session', description: 'Release the current controller and issue a new one-time handoff code.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: localCreate,
    invoke: async (_input, context) => { const result = store.release(actor(context).id); return { session: publicSession(result.session), claimCode: result.claimCode, handoffPrompt: result.handoffPrompt }; },
  });
  add({
    name: 'session_unregister', title: 'Release session (deprecated)', description: 'Compatibility alias for session_release. It never deletes history.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false }, annotations: localCreate,
    invoke: async (_input, context) => { const result = store.release(actor(context).id); return { deprecated: true, replacement: 'session_release', removed: false, session: publicSession(result.session), claimCode: result.claimCode, handoffPrompt: result.handoffPrompt }; },
  });
  add({
    name: 'session_tag', title: 'Tag session', description: 'Append audit-friendly tags to the authenticated session.',
    inputSchema: { type: 'object', properties: { tags: { ...stringList, minItems: 1 } }, required: ['tags'], additionalProperties: false }, annotations: localCreate,
    invoke: async (input, context) => ({ session: publicSession(store.tag(actor(context).id, input.tags as string[])) }),
  });
  add({
    name: 'session_subscribe', title: 'Subscribe to session', description: 'Subscribe the authenticated session to another session’s key progress.',
    inputSchema: { type: 'object', properties: { targetSessionId: { type: 'string', minLength: 1 } }, required: ['targetSessionId'], additionalProperties: false }, annotations: localCreate,
    invoke: async (input, context) => { const current = actor(context); store.subscribe(current.id, asString(input.targetSessionId, 'targetSessionId')); return { subscribed: true, subscriberSessionId: current.id, targetSessionId: input.targetSessionId }; },
  });
  add({
    name: 'session_events_ack', title: 'Acknowledge events', description: 'Acknowledge delivered event IDs; history remains permanent.',
    inputSchema: { type: 'object', properties: { eventIds: { ...stringList, minItems: 1, maxItems: 100 } }, required: ['eventIds'], additionalProperties: false }, annotations: localCreate,
    invoke: async (input, context) => ({ acknowledged: store.acknowledgeEvents(actor(context).id, input.eventIds as string[]) }),
  });
  add({
    name: 'message_send', title: 'Send session message', description: 'Send a durable message as the authenticated session to a recipient session name or ID; sender cannot be overridden. The response includes send/return timestamps and call latency.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', minLength: 1 }, body: { type: 'string', minLength: 1, maxLength: 20_000 } }, required: ['to', 'body'], additionalProperties: false }, annotations: localCreate,
    invoke: async (input, context) => {
      const startedAt = new Date().toISOString();
      const message = store.sendMessage(actor(context).id, asString(input.to, 'to'), asString(input.body, 'body'));
      const returnedAt = new Date().toISOString();
      return { message, timing: { sentAt: message.createdAt, returnedAt, elapsedMs: Math.max(0, Date.parse(returnedAt) - Date.parse(startedAt)) } };
    },
  });
  add({
    name: 'message_inbox', title: 'Read session inbox', description: 'Read only the authenticated session’s durable inbox.',
    inputSchema: { type: 'object', properties: { markRead: { type: 'boolean', default: false }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }, additionalProperties: false }, annotations: { ...readOnly, readOnlyHint: false },
    invoke: async (input, context) => { const current = actor(context); const page = store.inboxPage(current.id, input.markRead === true, typeof input.offset === 'number' ? input.offset : undefined, typeof input.limit === 'number' ? input.limit : 50); return { session: publicSession(current), ...page, observations: store.observeMessages(page.messages) }; },
  });
  add({
    name: 'message_list', title: 'List own collaboration messages', description: 'List recent inbound and outbound messages involving the authenticated session.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 1000 } }, additionalProperties: false }, annotations: readOnly,
    invoke: async (input, context) => { const current = actor(context); const messages = store.messagesForSession(current.id, typeof input.limit === 'number' ? input.limit : 100); return { messages, observations: store.observeMessages(messages) }; },
  });
  add({
    name: 'message_conversation', title: 'Read two-way conversation', description: 'Read the complete recent two-way conversation between the authenticated session and another session selected by name or ID.',
    inputSchema: { type: 'object', properties: { with: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 5000 } }, required: ['with'], additionalProperties: false }, annotations: readOnly,
    invoke: async (input, context) => { const conversation = store.conversation(actor(context).id, asString(input.with, 'with'), typeof input.limit === 'number' ? input.limit : 1000); return { conversation, observations: store.observeMessages(conversation.messages) }; },
  });
  add({
    name: 'skill', title: 'Run skill',
    description: 'List installed skills when called without arguments, or run one by name. Inline skills return their instructions; fork skills start a subagent and return a taskId to poll with subagent_status.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, additionalProperties: false },
    // ADR-0010 决策 8：fork 会启动 subagent（有副作用），整体标非 readOnly
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    invoke: async (input, context) => {
      const configDir = path.dirname(config.settingsPath);
      const name = asOptionalString(input.name);
      // 决策 3：无参 = list
      if (!name) {
        return { skills: listSkills(configDir, config.workspaceDir) } as unknown as JsonObject;
      }
      const record = loadSkill(configDir, config.workspaceDir, name);
      if (!record) throw new MyTerminalError('NOT_FOUND', `Skill not found: ${name}`);
      // 决策 1/3：inline 直接返回内容（决策 17：不要求 identity）
      if (record.mode !== 'fork') {
        return { name: record.name, description: record.description, mode: 'inline', content: record.content };
      }
      // fork 模式——决策 17：要求 identity；防线 A 与 subagent_start 一致（递归防护）
      if (context.transport === 'subagent') {
        throw new MyTerminalError('FORBIDDEN', 'Subagents cannot start sub-subagents.');
      }
      const session = actor(context);
      const runner = getSubagentRunner();
      try {
        // 决策 15：objective 加 skill 前缀；决策 6：forkOptions 覆盖默认配置；决策 14：origin 传入
        const started = runner.start(session.id, {
          objective: `执行技能 "${name}" 的指令：\n\n${record.content}`,
          background: record.description,
          ...record.forkOptions,
        }, { type: 'skill', skillName: name });
        return { name: record.name, description: record.description, mode: 'fork', taskId: started.taskId, sessionId: started.sessionId, status: started.status };
      } catch (err) {
        // 决策 18：maxParallel 超限 → FORBIDDEN；其他启动失败 → EXTENSION_ERROR
        const message = err instanceof Error ? err.message : String(err);
        const code = message.includes('Max parallel') ? 'FORBIDDEN' : 'EXTENSION_ERROR';
        throw new MyTerminalError(code, message);
      }
    },
  });

  // ── Subagent 工具（ADR-0009 决策 1/8/9/12）──
  const SUBAGENT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false };
  const PROVIDER_ENUM = ['openai', 'anthropic', 'deepseek', 'glm'];

  add({
    name: 'subagent_start', title: 'Start subagent',
    description: 'Start a subagent to work on a sub-task asynchronously. Returns taskId immediately; poll with subagent_status for progress. Completion arrives as a message notification.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string', minLength: 1, maxLength: 4000 },
        background: { type: 'string', maxLength: 4000 },
        deliverables: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        constraints: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        provider: { type: 'string', enum: PROVIDER_ENUM },
        model: { type: 'string' },
        maxTurns: { type: 'integer', minimum: 1, maximum: 200 },
        timeoutSec: { type: 'integer', minimum: 30, maximum: 3600 },
        readOnly: { type: 'boolean' },
      },
      required: ['objective'],
      additionalProperties: false,
    },
    annotations: SUBAGENT_ANNOTATIONS,
    invoke: async (input, context) => {
      // 决策 8 防线 A：递归防护——subagent 不能启动 sub-subagent
      if (context.transport === 'subagent') {
        throw new MyTerminalError('FORBIDDEN', 'Subagents cannot start sub-subagents.');
      }
      const session = actor(context);
      const runner = getSubagentRunner();
      return runner.start(session.id, {
        objective: asString(input.objective, 'objective'),
        background: asOptionalString(input.background),
        deliverables: Array.isArray(input.deliverables) ? (input.deliverables as string[]) : undefined,
        acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? (input.acceptanceCriteria as string[]) : undefined,
        constraints: Array.isArray(input.constraints) ? (input.constraints as string[]) : undefined,
        provider: asOptionalString(input.provider) as 'openai' | 'anthropic' | 'deepseek' | 'glm' | undefined,
        model: asOptionalString(input.model),
        maxTurns: typeof input.maxTurns === 'number' ? input.maxTurns : undefined,
        timeoutSec: typeof input.timeoutSec === 'number' ? input.timeoutSec : undefined,
        readOnly: typeof input.readOnly === 'boolean' ? input.readOnly : undefined,
      }) as unknown as JsonObject;
    },
  });

  add({
    name: 'subagent_status', title: 'Subagent status',
    description: 'Query subagent progress, tasks, cost, and result. Idempotent: after completion the result stays available for repeated queries until the one-hour cleanup.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', minLength: 1 } },
      required: ['taskId'],
      additionalProperties: false,
    },
    annotations: readOnly,
    invoke: async (input) => {
      const runner = getSubagentRunner();
      try {
        return runner.status(asString(input.taskId, 'taskId')) as unknown as JsonObject;
      } catch (err) {
        const code = (err as { code?: string }).code === 'NOT_FOUND' ? 'NOT_FOUND' : 'EXTENSION_ERROR';
        throw new MyTerminalError(code as 'NOT_FOUND' | 'EXTENSION_ERROR', (err as Error).message);
      }
    },
  });

  add({
    name: 'subagent_abort', title: 'Abort subagent',
    description: 'Abort a running subagent. Idempotent — calling on an already-terminal subagent returns its current status.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', minLength: 1 } },
      required: ['taskId'],
      additionalProperties: false,
    },
    annotations: SUBAGENT_ANNOTATIONS,
    invoke: async (input) => {
      const runner = getSubagentRunner();
      try {
        return runner.abort(asString(input.taskId, 'taskId')) as unknown as JsonObject;
      } catch (err) {
        const code = (err as { code?: string }).code === 'NOT_FOUND' ? 'NOT_FOUND' : 'EXTENSION_ERROR';
        throw new MyTerminalError(code as 'NOT_FOUND' | 'EXTENSION_ERROR', (err as Error).message);
      }
    },
  });

  return tools;
}

export type { CommandResult };
export { runCommand };
