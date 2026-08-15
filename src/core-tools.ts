import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, realpathSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import type { MyTerminalConfig } from './types.js';
import { MyTerminalError, publicSession, type MyTerminalStore } from './store.js';
import { resolveWorkspacePath, validateSafeRegex } from './security.js';
import type { JsonObject, TaskPackage, ToolDefinition } from './types.js';
import { BUILTIN_INPUT_SCHEMAS } from './tool-schemas.js';
import { sessionResourceManager } from './session-resource-manager.js';
import { continuationPolicy } from './continuation.js';
import { listSkills, loadSkill } from './skills.js';
import { getSubagentRunner } from './subagent/runner.js';
import { IGNORE_DIRECTORIES, walkFiles } from './utils/fs.js';

// Bounded wall-clock budget for search_text. The regex-safety gate (see
// validateSafeRegex) blocks the catastrophic-backtracking class; this is a
// defense-in-depth ceiling on total scan time for slow-but-legal patterns.
const SEARCH_TEXT_BUDGET_MS = 8000;

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
  // 基准取 realpath 后的 workspaceDir：resolveWorkspacePath 对存在的路径返回 realpath 形式
  // （macOS /var→/private/var 等 symlink 场景下与 config.workspaceDir 不一致），若不 realpath，
  // 输出的相对 path 会带 .. 前缀、且回传作输入时无法被 resolveWorkspacePath 复原（W1-03 #76
  // 翻页 round-trip 实测）。realpath 后两方同源，输出干净、可回传。
  return path.relative(realpathSync(config.workspaceDir), absolute) || '.';
}

export function createBuiltinTools(config: MyTerminalConfig, store: MyTerminalStore): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const add = (definition: ToolDefinition) => tools.set(definition.name, definition);
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
  const mutating = { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false };
  // ADR-0034（#74）：这里曾有一个 `localCreate` 共享对象，把 idempotentHint:true
  // 一次性撒给 10 个工具且从未向下覆盖，与 mcp.ts:181 `safeLocalMutation`（以 false
  // 为基准、真幂等者显式 opt-in）默认极性相反，造成 4 条对外声明漂移。
  // 现改为：`localWrite` 只承载三个安全语义 hint，刻意不含 idempotentHint，
  // 强制每个使用者显式表态。判定理由登记在
  // test/annotations-contract-issue74.test.mjs 的 IDEMPOTENCY_LEDGER。
  const localWrite = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const actor = (context: Parameters<ToolDefinition['invoke']>[1]) => {
    if (!context.authenticatedSession) throw new MyTerminalError('IDENTITY_REQUIRED', 'Register or inherit a MyTerminal session before calling this tool.');
    return context.authenticatedSession;
  };

  add({
    name: 'workspace_info', title: 'Workspace info', description: 'Inspect the single authorized workspace and MyTerminal runtime.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.workspace_info, annotations: readOnly,
    invoke: async () => ({ workspaceDir: config.workspaceDir, platform: process.platform, node: process.version, stateRevision: store.revision() }),
  });
  add({
    name: 'list_dir', title: 'List directory', description: 'List one directory inside the authorized workspace.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.list_dir, annotations: readOnly,
    invoke: async (input, context) => {
      const directory = resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.path) || '.');
      const all = (await readdir(directory, { withFileTypes: true })).filter((entry) => !IGNORE_DIRECTORIES.has(entry.name));
      // W1-03（#76）：分页切片（默认 0/500、上限 500 与 500 帽对齐）；上报 total + page，
      // 供 L1 reducer 派生 totalCount / truncated / 分页 continuation（对齐 session_list T07）
      const offset = typeof input.offset === 'number' && input.offset >= 0 ? Math.floor(input.offset) : 0;
      const limit = typeof input.limit === 'number' && input.limit >= 1 ? Math.min(Math.floor(input.limit), 500) : 500;
      const page = all.slice(offset, offset + limit);
      return {
        path: relative(config, directory),
        entries: page.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })),
        total: all.length,
        page: { offset, limit },
        truncated: offset + page.length < all.length,
      };
    },
  });
  add({
    name: 'find_files', title: 'Find files', description: 'Find files by case-insensitive path substring.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.find_files, annotations: readOnly,
    aliases: { pattern: 'query' },
    invoke: async (input) => {
      const query = asString(input.query, 'query').toLowerCase();
      const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(500, input.limit)) : 100;
      const files = await walkFiles(resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.path) || '.'), { limit: 10_000 });
      const matches = files.map((file) => relative(config, file)).filter((file) => file.toLowerCase().includes(query));
      // totalMatches：截断前的真实匹配总量（D16.2 totalCount 的唯一合法来源；W1-01 #74 的
      // reduceCollectionCount 剥除并统一为 totalCount，绝不泄漏进模型上下文，D17）
      // 增补-09（#108，R17）：恰中 limit（matches.length === limit）不算截断——handler 手握
      // 全量，恰限时 truncated=true 会与 count==totalCount 自相矛盾误导模型；仅 `>` 才截断。
      return { matches: matches.slice(0, limit), truncated: matches.length > limit, totalMatches: matches.length };
    },
  });
  add({
    name: 'search_text', title: 'Search text', description: 'Search bounded UTF-8 files for text or a regular expression.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.search_text, annotations: readOnly,
    aliases: { pattern: 'query' },
    invoke: async (input) => {
      const query = asString(input.query, 'query');
      if (input.regex) validateSafeRegex(query);
      const matcher = input.regex ? new RegExp(query, 'i') : undefined;
      const searchDeadline = Date.now() + SEARCH_TEXT_BUDGET_MS;
      const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(500, input.limit)) : 100;
      const files = await walkFiles(resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.path) || '.'), { limit: 2_000 });
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const file of files) {
        if (Date.now() > searchDeadline) break;
        const fileStat = await stat(file);
        if (fileStat.size > 1_000_000) continue;
        let text: string;
        try { text = await readFile(file, 'utf8'); } catch { continue; }
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (matcher ? matcher.test(line) : line.toLowerCase().includes(query.toLowerCase())) matches.push({ path: relative(config, file), line: index + 1, text: line.slice(0, 500) });
          if (matches.length >= limit) break;
        }
        if (matches.length >= limit) break;
      }
      const timedOut = Date.now() > searchDeadline;
      return { matches, truncated: matches.length >= limit || timedOut };
    },
  });
  add({
    name: 'read_file', title: 'Read file', description: 'Read a bounded UTF-8 file.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.read_file, annotations: readOnly,
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
    inputSchema: BUILTIN_INPUT_SCHEMAS.read_file_range, annotations: readOnly,
    invoke: async (input) => {
      const file = resolveWorkspacePath(config.workspaceDir, config.stateDir, asString(input.path, 'path'));
      const start = Math.max(1, Number(input.startLine));
      const end = Math.max(start, Number(input.endLine));
      // 默认 256_000、上限 1_000_000，与 read_file 对称（D15/T08）
      const cap = Math.min(1_000_000, Math.max(1, typeof input.maxBytes === 'number' ? input.maxBytes : 256_000));

      // 流式读取：逐块更新 sha256（字节精确，等同原 readFile 全量哈希），仅保留
      // [start, end] 区间行，绝不把整文件读入内存（D15/T08：不再整文件进内存）。
      // StringDecoder 正确处理跨 64KB 块边界的多字节（CJK）字符，避免 UTF-8 断裂损坏。
      const stream = createReadStream(file);
      const hash = createHash('sha256');
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      let lineNo = 0;
      let newlineCount = 0;
      let endedWithNewline = false;
      const picked: string[] = [];
      for await (const chunk of stream) {
        hash.update(chunk);
        buffer += decoder.write(chunk);
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          let line = buffer.slice(0, nl);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          lineNo += 1;
          newlineCount += 1;
          if (lineNo >= start && lineNo <= end) picked.push(`${lineNo}: ${line}`);
          buffer = buffer.slice(nl + 1);
          endedWithNewline = true;
        }
        if (buffer.length > 0) endedWithNewline = false;
      }
      if (buffer.length > 0) {
        // flush 残余多字节序列（无残留则为空串），并把末段（无尾随换行）记为最后一行的正文
        buffer += decoder.end();
        lineNo += 1;
        if (lineNo >= start && lineNo <= end) picked.push(`${lineNo}: ${buffer}`);
      }
      if (endedWithNewline) lineNo += 1; // 尾随空行计入（匹配 split(/\r?\n/) 语义）
      // totalLines 严格等价于 content.split(/\r?\n/).length = newlineCount + 1
      // （含空文件=1，与 read_file 一致），而非 lineNo（否则空文件会回归为 0）
      const totalLines = newlineCount + 1;
      const clampedEnd = Math.min(end, totalLines);

      let content = picked.join('\n');
      let truncated = false;
      if (Buffer.byteLength(content, 'utf8') > cap) {
        // 按字节截断（模型上下文保护）；回退到码点边界，避免切断多字节字符产生 U+FFFD 损坏
        const buf = Buffer.from(content, 'utf8');
        let cut = Math.min(cap, buf.length);
        while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--; // 跳过 UTF-8 续字节
        content = buf.subarray(0, cut).toString('utf8');
        truncated = true;
      }
      return {
        path: relative(config, file),
        startLine: start,
        endLine: clampedEnd,
        totalLines,
        content,
        sha256: hash.digest('hex'),
        truncated,
      };
    },
  });
  add({
    name: 'write_file', title: 'Write file', description: 'Create or replace one UTF-8 file inside the workspace.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.write_file, annotations: mutating,
    invoke: async (input, context) => {
      actor(context); // ADR-0016: 纵深防御鉴权
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
    inputSchema: BUILTIN_INPUT_SCHEMAS.apply_patch, annotations: mutating,
    invoke: async (input, context) => {
      actor(context); // ADR-0016: 纵深防御鉴权
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
    // 内容寻址：同内容重复创建得同一 blob（与 mcp.ts:229 opt-in 一致）
    inputSchema: BUILTIN_INPUT_SCHEMAS.blob_create, annotations: { ...localWrite, idempotentHint: true },
    invoke: async (input, context) => {
      actor(context); // ADR-0016: 纵深防御鉴权
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
    inputSchema: BUILTIN_INPUT_SCHEMAS.blob_read, annotations: readOnly,
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
    // 同内容重复写成功，不同内容永不覆盖（与 mcp.ts:231 opt-in 一致）
    inputSchema: BUILTIN_INPUT_SCHEMAS.blob_write_file, annotations: { ...localWrite, idempotentHint: true },
    invoke: async (input, context) => {
      actor(context); // ADR-0016: 纵深防御鉴权
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
        if (existingSha256 !== sha256) throw new MyTerminalError('EXTENSION_ERROR', 'Target file already exists with different content; blob_write_file never overwrites files.');
        return { path: relative(config, file), bytes: existing.length, sha256, alreadyExisted: true };
      }
      return { path: relative(config, file), bytes: buffer.length, sha256, alreadyExisted: false };
    },
  });
  add({
    name: 'execute_cli', title: 'Execute command', description: 'Execute one bounded shell command in the workspace.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.execute_cli,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    invoke: async (input, context) => {
      actor(context); // ADR-0016: 纵深防御鉴权
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
      inputSchema: BUILTIN_INPUT_SCHEMAS[gitTool[0]], annotations: readOnly,
      invoke: async (input, context) => await runCommand({ executable: 'git', argv: [...gitTool[1]], cwd: resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.cwd) || '.'), timeoutSec: 30, maxOutputChars: config.maxOutputChars, signal: context.signal }) as unknown as JsonObject,
    });
  }
  add({
    name: 'git_show', title: 'Git show', description: 'Show one bounded Git revision or object.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.git_show, annotations: readOnly,
    invoke: async (input, context) => {
      const revision = asString(input.revision, 'revision');
      if (!/^[A-Za-z0-9_./~^{}:@+-]+$/.test(revision)) throw new Error('Unsafe Git revision syntax.');
      // W2-04 #87（0050 I-29 / D-12）：真实 revision 放 `--` 前（`-- <revision>` 会把
      // revision 当 pathspec → 按 revision 查询恒空）。例外：以 '-' 开头的 revision 不可能是
      // git 对象名（git 禁止 ref 以 '-' 开头），仍走 `--` 保护形式当 pathspec（恒空、exit 0）——
      // 保全 #35 选项注入不变式（'-p' 不得被当 patch option），与修复前逐字节一致。
      const argv = revision.startsWith('-')
        ? ['show', '--stat', '--oneline', '--', revision]
        : ['show', revision, '--stat', '--oneline'];
      return await runCommand({ executable: 'git', argv, cwd: resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.cwd) || '.'), timeoutSec: 30, maxOutputChars: config.maxOutputChars, signal: context.signal }) as unknown as JsonObject;
    },
  });
  add({
    name: 'run_checks', title: 'Run project checks', description: 'Run declared typecheck, build, and test package scripts in order.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.run_checks, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
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

  add({
    name: 'session_register', title: 'Register session', description: 'Create and claim a root session, or delegate one direct child from an authenticated root. Delegate by domain and parallel workload with a complete role/task package; do not offload one large objective wholesale to a single child.',
    // 非幂等：每次调用产出新 session 与新 token，重放会留下孤儿 session
    inputSchema: BUILTIN_INPUT_SCHEMAS.session_register, annotations: { ...localWrite, idempotentHint: false },
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
    // 非幂等：消耗一次性 claimCode，重放不等价
    inputSchema: BUILTIN_INPUT_SCHEMAS.session_inherit, annotations: { ...localWrite, idempotentHint: false },
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
    inputSchema: BUILTIN_INPUT_SCHEMAS.session_list, annotations: readOnly,
    invoke: async (input, context) => {
      actor(context);
      // D15/T07：服务端按 offset/limit 切片（默认 20、上限 200，与 BUILTIN_INPUT_SCHEMAS.session_list 对齐）；
      // 同时上报 total + page，供 L1 reducer 派生 totalCount / truncated / 分页 continuation。
      const offset = typeof input.offset === 'number' && input.offset >= 0 ? Math.floor(input.offset) : 0;
      const limit = typeof input.limit === 'number' && input.limit >= 1 ? Math.min(Math.floor(input.limit), 200) : 20;
      const all = store.listSessions().map(publicSession);
      return { sessions: all.slice(offset, offset + limit), total: all.length, page: { offset, limit } };
    },
  });
  add({
    name: 'session_checkpoint', title: 'Checkpoint session', description: 'Record durable session state. When the optional enhanced Actions long-task harness is enabled, a working checkpoint requires 1-3 exact concrete nextCalls and the returned nextCall must run immediately.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.session_checkpoint, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
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
      if (session.phase === 'completed' || session.phase === 'cancelled') sessionResourceManager.disposeSession(config, current.id);
      return { session: publicSession(session) };
    },
  });
  add({
    name: 'session_context', title: 'Read session context', description: 'Return the bounded 16K context projection for the authenticated session.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.session_context, annotations: readOnly,
    invoke: async (_input, context) => ({ context: store.context(actor(context).id) }),
  });
  add({
    name: 'session_history', title: 'Read paginated session history', description: 'Read permanent structured history for the authenticated session and its continuation ancestors without overloading context.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.session_history, annotations: readOnly,
    invoke: async (input, context) => ({ history: store.historyPage(actor(context).id, typeof input.offset === 'number' ? input.offset : 0, typeof input.limit === 'number' ? input.limit : 100, input.includeAncestors !== false) }),
  });
  add({
    name: 'session_release', title: 'Release session', description: 'Release the current controller and issue a new one-time handoff code.',
    // 非幂等：每次签发新的一次性 handoff code
    inputSchema: BUILTIN_INPUT_SCHEMAS.session_release, annotations: { ...localWrite, idempotentHint: false },
    invoke: async (_input, context) => { const result = store.release(actor(context).id); return { session: publicSession(result.session), claimCode: result.claimCode, handoffPrompt: result.handoffPrompt }; },
  });
  add({
    name: 'session_unregister', title: 'Release session (deprecated)', description: 'Compatibility alias for session_release. It never deletes history.',
    // 非幂等：session_release 的逐字别名，必须同值
    inputSchema: BUILTIN_INPUT_SCHEMAS.session_unregister, annotations: { ...localWrite, idempotentHint: false },
    invoke: async (_input, context) => { const result = store.release(actor(context).id); return { deprecated: true, replacement: 'session_release', removed: false, session: publicSession(result.session), claimCode: result.claimCode, handoffPrompt: result.handoffPrompt }; },
  });
  add({
    name: 'session_tag', title: 'Tag session', description: 'Append audit-friendly tags to the authenticated session.',
    // store.ts tag()：`[...new Set(...)]` 去重，重复打同一标签结果不变
    inputSchema: BUILTIN_INPUT_SCHEMAS.session_tag, annotations: { ...localWrite, idempotentHint: true },
    invoke: async (input, context) => ({ session: publicSession(store.tag(actor(context).id, input.tags as string[])) }),
  });
  add({
    name: 'session_subscribe', title: 'Subscribe to session', description: 'Subscribe the authenticated session to another session’s key progress.',
    // store.ts subscribe()：`some()` 查重后才 push，重复订阅不产生第二条
    inputSchema: BUILTIN_INPUT_SCHEMAS.session_subscribe, annotations: { ...localWrite, idempotentHint: true },
    invoke: async (input, context) => { const current = actor(context); store.subscribe(current.id, asString(input.targetSessionId, 'targetSessionId')); return { subscribed: true, subscriberSessionId: current.id, targetSessionId: input.targetSessionId }; },
  });
  add({
    name: 'session_events_ack', title: 'Acknowledge events', description: 'Acknowledge delivered event IDs; history remains permanent.',
    // 按事件 ID 确认，重复确认无额外效果（与 mcp.ts:214 opt-in 一致）
    inputSchema: BUILTIN_INPUT_SCHEMAS.session_events_ack, annotations: { ...localWrite, idempotentHint: true },
    invoke: async (input, context) => ({ acknowledged: store.acknowledgeEvents(actor(context).id, input.eventIds as string[]) }),
  });
  add({
    name: 'message_send', title: 'Send session message', description: 'Send a durable message as the authenticated session to a recipient session name or ID; sender cannot be overridden. The response includes send/return timestamps and call latency.',
    // 非幂等：每次调用追加一条新的持久消息，重放产生重复消息
    inputSchema: BUILTIN_INPUT_SCHEMAS.message_send, annotations: { ...localWrite, idempotentHint: false },
    invoke: async (input, context) => {
      const startedAt = new Date().toISOString();
      const message = store.sendMessage(actor(context).id, asString(input.to, 'to'), asString(input.body, 'body'));
      const returnedAt = new Date().toISOString();
      return { message, timing: { sentAt: message.createdAt, returnedAt, elapsedMs: Math.max(0, Date.parse(returnedAt) - Date.parse(startedAt)) } };
    },
  });
  add({
    name: 'message_inbox', title: 'Read session inbox', description: 'Read only the authenticated session’s durable inbox.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.message_inbox, annotations: { ...readOnly, readOnlyHint: false },
    invoke: async (input, context) => { const current = actor(context); const page = store.inboxPage(current.id, input.markRead === true, typeof input.offset === 'number' ? input.offset : undefined, typeof input.limit === 'number' ? input.limit : 50); return { session: publicSession(current), ...page, observations: store.observeMessages(page.messages) }; },
  });
  add({
    name: 'message_list', title: 'List own collaboration messages', description: 'List recent inbound and outbound messages involving the authenticated session.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.message_list, annotations: readOnly,
    invoke: async (input, context) => { const current = actor(context); const page = store.messagesForSessionPage(current.id, typeof input.offset === 'number' ? input.offset : undefined, typeof input.limit === 'number' ? input.limit : 100); return { ...page, observations: store.observeMessages(page.messages) }; },
  });
  add({
    name: 'message_conversation', title: 'Read two-way conversation', description: 'Read the complete recent two-way conversation between the authenticated session and another session selected by name or ID.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.message_conversation, annotations: readOnly,
    invoke: async (input, context) => { const conversation = store.conversation(actor(context).id, asString(input.with, 'with'), typeof input.offset === 'number' ? input.offset : undefined, typeof input.limit === 'number' ? input.limit : 1000); return { conversation, observations: store.observeMessages(conversation.messages) }; },
  });
  add({
    name: 'skill', title: 'Run skill',
    description: 'List installed skills when called without arguments, or run one by name. Inline skills return their instructions; fork skills start a subagent and return a taskId to poll with subagent_status.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.skill,
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
      // 决策 18：maxParallel 超限 → FORBIDDEN（runner.start 已携码抛出）；
      // 其他启动失败 → EXTENSION_ERROR。不再用消息子串猜 code（ADR-0028）。
      if (err instanceof MyTerminalError) throw err;
      throw new MyTerminalError('EXTENSION_ERROR', err instanceof Error ? err.message : String(err));
    }
    },
  });

  // ── Subagent 工具（ADR-0009 决策 1/8/9/12；ADR-0045 spine 重塑）──
  // ADR-0045 已删 provider 概念：subagent_start 不再暴露 provider/model 枚举，
  // 适配器收敛为单一 Anthropic Messages 协议（baseUrl 可配）；模型只来自全局配置。
  // 此处无 provider/SUBAGENT_PROVIDERS 引用（常量已由 ADR-0045 删除）。
  const SUBAGENT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false };

  add({
    name: 'subagent_start', title: 'Start subagent',
    description: 'Start a subagent to work on a sub-task asynchronously. Returns taskId immediately; poll with subagent_status for progress. Completion arrives as a message notification.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.subagent_start,
    annotations: SUBAGENT_ANNOTATIONS,
    invoke: async (input, context) => {
      // 决策 8 防线 A：递归防护——subagent 不能启动 sub-subagent
      if (context.transport === 'subagent') {
        throw new MyTerminalError('FORBIDDEN', 'Subagents cannot start sub-subagents.');
      }
      const session = actor(context);
      const runner = getSubagentRunner();
      // D3：外部契约只留 objective + 三覆盖；内部四字段由 skills fork 等内部路径直供（SubagentStartInput 保留可选）
      return runner.start(session.id, {
        objective: asString(input.objective, 'objective'),
        maxTurns: typeof input.maxTurns === 'number' ? input.maxTurns : undefined,
        timeoutSec: typeof input.timeoutSec === 'number' ? input.timeoutSec : undefined,
        readOnly: typeof input.readOnly === 'boolean' ? input.readOnly : undefined,
      }) as unknown as JsonObject;
    },
  });

  add({
    name: 'subagent_status', title: 'Subagent status',
    description: 'Query subagent progress, tasks, token usage, and result. Idempotent: after completion the result stays available for repeated queries until the one-hour cleanup.',
    inputSchema: BUILTIN_INPUT_SCHEMAS.subagent_status,
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
    inputSchema: BUILTIN_INPUT_SCHEMAS.subagent_abort,
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
