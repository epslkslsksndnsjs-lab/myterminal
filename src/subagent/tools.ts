// ADR-0007 决策 3/4/13/17/23/26/30/31/33/34/35/36/40
// Subagent 工具层——8 个工具 + 接口 + buildTool 工厂 + 注册表
//
// 决策 3：重新做一套 LLM 友好的工具，不绑 session/transport
// 决策 4：8 个工具——execute_cli/read_file/write_file/edit_file/glob/grep/task_create/task_update
// 决策 13：注册表模式（Map + buildTool + 按名称查找）
// 决策 31：10 字段接口（isConcurrencySafe 函数化 + validateInput + prompt + isDestructive + isEnabled）
// 决策 40：preToolUseHooks / postToolUseHooks 接口预留

import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { JsonObject, JsonSchema } from '../types.js';
import { recordFileRead, validateEdit, applyEdit } from './file-state.js';
import { trackShellTask } from './shell-tracker.js';
import { checkCommandSafety, isCommandConcurrencySafe, interpretExitCode } from './permissions.js';
import { truncateResult } from './result-budget.js';
import { syncTasks, getSubagent } from './store.js';
import { createGrep } from './grep-utils.js';

// ── 常量 ──

// 决策 35：read_file 拒绝的二进制扩展名
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.pdf', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.avi', '.mov', '.exe', '.dll', '.so', '.dylib',
  '.o', '.a', '.class', '.jar', '.wasm',
]);

// 决策 33：glob/grep 忽略目录——与 core-tools.ts IGNORED_DIRECTORIES 对齐 + build/ .cache/
const IGNORE_DIRECTORIES = new Set([
  '.git', '.myterminal', 'node_modules', 'dist', 'coverage', '.next', '.turbo',
  'build', '.cache',
]);

// 决策 34：glob 最大返回条数
const MAX_GLOB_RESULTS = 200;
// grep 最大匹配数
const MAX_GREP_MATCHES = 200;

// ── 接口（决策 23 + 31 + 40）──

export type SubagentToolContext = {
  cwd: string;                              // 决策 23：subagent 工作目录
  signal: AbortSignal;                      // 决策 23：abort 信号
  agentId: string;                          // 决策 23：subagent ID
  readOnly?: boolean;                       // 决策 17 第 1 层：readOnly 模式标志（M7 executor 注入）
  preToolUseHooks?: ToolHook[];             // 决策 40：v1 预留，空数组
  postToolUseHooks?: ToolHook[];
};

export type ValidationResult = { ok: boolean; message?: string };

// 决策 31：10 字段接口
export type SubagentTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  call(input: JsonObject, ctx: SubagentToolContext): Promise<JsonObject>;
  isReadOnly: boolean;
  isConcurrencySafe: boolean | ((input: JsonObject) => boolean);  // 决策 31：函数化
  maxResultSizeChars: number;
  checkPermissions?(input: JsonObject, ctx: SubagentToolContext): 'allow' | 'deny';
  prompt?(ctx: SubagentToolContext): string;                      // 决策 31：详细使用指南
  validateInput?(input: JsonObject, ctx: SubagentToolContext): ValidationResult;  // 决策 31：语义校验
  isDestructive?(input: JsonObject): boolean;                     // 决策 31：不可逆标记
  isEnabled?(ctx: SubagentToolContext): boolean;                  // 决策 31：运行时启用
};

// 决策 40
export type ToolHook = {
  name: string;
  before?(input: JsonObject, ctx: SubagentToolContext): Promise<HookResult | void>;
  after?(result: JsonObject, ctx: SubagentToolContext): Promise<HookResult | void>;
};

export type HookResult = {
  modifiedInput?: JsonObject;
  blockExecution?: boolean;
  modifiedResult?: JsonObject;
  additionalContext?: string;
};

// ── 辅助函数 ──

// 决策 4：路径限制在 cwd 内（防目录穿越）
function resolvePath(inputPath: string, cwd: string): string {
  const resolved = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
  const rel = relative(cwd, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${inputPath}" is outside working directory "${cwd}"`);
  }
  return resolved;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// 决策 36：diff 预览
function generateDiffPreview(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const maxLines = Math.max(oldLines.length, newLines.length, 5);
  const preview: string[] = [];
  for (let i = 0; i < Math.min(maxLines, 5); i++) {
    if (oldLines[i] !== newLines[i]) {
      if (oldLines[i] !== undefined) preview.push(`- ${oldLines[i]}`);
      if (newLines[i] !== undefined) preview.push(`+ ${newLines[i]}`);
    }
  }
  return preview.join('\n');
}

// 简单 glob→regex 转换（用于 grep-utils include 过滤；glob 工具也用此逻辑）
function globToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** 匹配任意字符（含 /）
        regexStr += '.*';
        i += 2;
        if (pattern[i] === '/') i++;  // **/ → .*/
      } else {
        // * 匹配任意非 / 字符
        regexStr += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else if (ch === '.') {
      regexStr += '\\.';
      i++;
    } else if ('\\^$+{}[]()|'.includes(ch)) {
      regexStr += '\\' + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }
  return new RegExp(`^${regexStr}$`);
}

// 递归遍历目录：skip IGNORE_DIRECTORIES，返回所有文件路径（相对 searchDir）
async function walkFiles(searchDir: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [searchDir];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue; // 跳过不可读目录
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRECTORIES.has(entry.name)) continue;
        queue.push(resolve(current, entry.name));
      } else if (entry.isFile()) {
        files.push(relative(searchDir, resolve(current, entry.name)).replace(/\\/g, '/'));
      }
    }
  }
  return files;
}

// ── 工厂 + 注册表（决策 13）──

export function buildTool(config: {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  call: (input: JsonObject, ctx: SubagentToolContext) => Promise<JsonObject>;
  isReadOnly: boolean;
  isConcurrencySafe?: boolean | ((input: JsonObject) => boolean);  // 决策 31：支持函数
  maxResultSizeChars?: number;
  checkPermissions?: (input: JsonObject, ctx: SubagentToolContext) => 'allow' | 'deny';
  prompt?: (ctx: SubagentToolContext) => string;
  validateInput?: (input: JsonObject, ctx: SubagentToolContext) => ValidationResult;
  isDestructive?: (input: JsonObject) => boolean;
  isEnabled?: (ctx: SubagentToolContext) => boolean;
}): SubagentTool {
  if (!config.name) throw new Error('Tool name is required');
  if (!config.description) throw new Error(`Tool ${config.name}: description is required`);
  if (!config.inputSchema) throw new Error(`Tool ${config.name}: inputSchema is required`);

  // 决策 31：未传 isConcurrencySafe 时，默认跟随 isReadOnly
  const concurrencySafe = config.isConcurrencySafe ?? config.isReadOnly;

  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    call: config.call,
    isReadOnly: config.isReadOnly,
    isConcurrencySafe: concurrencySafe,
    maxResultSizeChars: config.maxResultSizeChars ?? 50_000,
    checkPermissions: config.checkPermissions,
    prompt: config.prompt,
    validateInput: config.validateInput,
    isDestructive: config.isDestructive,
    isEnabled: config.isEnabled,
  };
}

export const toolRegistry = new Map<string, SubagentTool>();

export function getTool(name: string): SubagentTool | undefined {
  return toolRegistry.get(name);
}

// 导出所有工具的 schema（供 LLM 适配层构造 tools 参数）
export function getAllToolSchemas(): Array<{ name: string; description: string; input_schema: JsonSchema }> {
  return Array.from(toolRegistry.values()).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

// 决策 17 第 1 层：readOnly 模式过滤
// Bug 2 修复：task_create/task_update isReadOnly=true，因此在 readOnly 列表中
export function getToolNames(opts?: { readOnly?: boolean }): string[] {
  const names: string[] = [];
  for (const tool of toolRegistry.values()) {
    if (opts?.readOnly && !tool.isReadOnly) continue;
    names.push(tool.name);
  }
  return names;
}

// ── 导入导出辅助：供 grep-utils 使用 ──
export { IGNORE_DIRECTORIES, MAX_GREP_MATCHES };

// ════════════════════════════════════════════════════════════════
// 3.1 execute_cli（决策 4 + 17 + 19 + 28 + 31 + 32）
// ════════════════════════════════════════════════════════════════

const executeCliTool = buildTool({
  name: 'execute_cli',
  description: 'Execute a shell command. Returns stdout, stderr, and exit code.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      cwd: { type: 'string', description: 'Working directory (defaults to subagent cwd)' },
      timeoutSec: { type: 'number', description: 'Timeout in seconds (default 120)' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  isReadOnly: false,
  // 决策 31：函数化——安全命令可并发，危险命令独占
  isConcurrencySafe: (input: JsonObject) => isCommandConcurrencySafe(input.command as string),

  async call(input, ctx) {
    const command = input.command as string;
    const workingDir = input.cwd ? resolvePath(input.cwd as string, ctx.cwd) : ctx.cwd;
    const timeoutMs = ((input.timeoutSec as number) ?? 120) * 1000;

    return new Promise<JsonObject>((resolvePromise) => {
      let settled = false;

      const child = spawn(command, {
        cwd: workingDir,
        shell: true,
        signal: ctx.signal,
        detached: true,          // 决策 28：新进程组，杀时用 process.kill(-pid)
        timeout: timeoutMs,
      });

      // 决策 28：追踪 shell 进程
      trackShellTask(ctx.agentId, child);

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        resolvePromise({
          is_error: true,
          message: `Command execution failed: ${err.message}`,
          stdout: '',
          stderr: '',
          exitCode: null,
        });
      });

      child.on('exit', (exitCode: number | null) => {
        if (settled) return;
        settled = true;

        const code = exitCode ?? -1;
        // 决策 32 第 3 层：退出码语义
        const interpretation = interpretExitCode(command, code);

        resolvePromise({
          stdout: truncateResult(stdout),
          stderr: truncateResult(stderr),
          exitCode: code,
          is_error: interpretation.isError || false,
          ...(interpretation.message ? { message: interpretation.message } : {}),
        });
      });
    });
  },

  // 决策 17 + 32：命令级安全检查
  checkPermissions(input, ctx) {
    const cmd = input.command as string;
    return checkCommandSafety(cmd, ctx.readOnly ?? false);
  },
});

// ════════════════════════════════════════════════════════════════
// 3.2 read_file（决策 4 + 19 + 26 + 35）
// ════════════════════════════════════════════════════════════════

const readFileTool = buildTool({
  name: 'read_file',
  description: 'Read a file with line numbers. Returns content and total lines.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
      offset: { type: 'number', description: 'Start line (1-based, default 1)' },
      limit: { type: 'number', description: 'Max lines to read (default 2000)' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input, ctx) {
    const filePath = resolvePath(input.path as string, ctx.cwd);
    const offset = (input.offset as number) ?? 1;
    const limit = (input.limit as number) ?? 2000;

    // 决策 35：二进制检测
    const ext = extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      return {
        is_error: true,
        message: `File "${input.path}" appears to be a binary file (${ext}). read_file only supports text files.`,
      };
    }

    try {
      const fileStat = await stat(filePath);

      // 决策 35：目录/不存在错误区分
      if (fileStat.isDirectory()) {
        return {
          is_error: true,
          message: `"${input.path}" is a directory, not a file. Use glob to list directory contents.`,
        };
      }

      const content = await readFile(filePath, 'utf-8');
      const allLines = content.split('\n');
      const totalLines = allLines.length;
      const start = Math.max(0, offset - 1);
      const end = Math.min(start + limit, totalLines);
      const selectedLines = allLines.slice(start, end);

      // 带行号格式
      const numbered = selectedLines.map((line, i) => `${start + i + 1}\t${line}`).join('\n');

      // 决策 26：记录到 fileState
      recordFileRead(ctx.agentId, filePath, content);

      return {
        content: truncateResult(numbered),
        totalLines,
        startLine: start + 1,
        endLine: end,
      };
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      // 决策 35：文件不存在区分
      if (nodeErr.code === 'ENOENT') {
        return {
          is_error: true,
          message: `File not found: "${input.path}". Use glob to find the correct path.`,
        };
      }
      return { is_error: true, message: `Failed to read file: ${(err as Error).message}` };
    }
  },
});

// ════════════════════════════════════════════════════════════════
// 3.3 write_file（决策 4 + 26）
// ════════════════════════════════════════════════════════════════

const writeFileTool = buildTool({
  name: 'write_file',
  description: 'Write content to a file. Creates or overwrites.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  isReadOnly: false,
  isConcurrencySafe: false,  // 决策 18：文件写入竞争

  async call(input, ctx) {
    const filePath = resolvePath(input.path as string, ctx.cwd);
    const content = input.content as string;

    try {
      const existed = await fileExists(filePath);

      // 自动创建父目录
      await mkdir(dirname(filePath), { recursive: true });

      await writeFile(filePath, content, 'utf-8');

      // 决策 26：同步更新 fileState 缓存
      recordFileRead(ctx.agentId, filePath, content);

      const lines = content.split('\n').length;
      return { action: existed ? 'overwritten' : 'created', lines, path: filePath };
    } catch (err) {
      return { is_error: true, message: `Failed to write file: ${(err as Error).message}` };
    }
  },
});

// ════════════════════════════════════════════════════════════════
// 3.4 edit_file（决策 4 + 19 + 26 + 36，Bug 3 修复）
// ════════════════════════════════════════════════════════════════

const editFileTool = buildTool({
  name: 'edit_file',
  description: 'Replace old_string with new_string in a file. File must be read first.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old_string: { type: 'string', minLength: 1, description: 'Exact string to replace. Must be non-empty and unique (unless replace_all).' },
      new_string: { type: 'string', description: 'Replacement string' },
      replace_all: { type: 'boolean', default: false, description: 'Replace all occurrences (Bug 3 修复)' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input, ctx) {
    const filePath = resolvePath(input.path as string, ctx.cwd);
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) ?? false;

    // 决策 26：先读后写 + 唯一性检查（M2 的 validateEdit）
    const validation = validateEdit(ctx.agentId, filePath, oldString, replaceAll);
    if (!validation.ok) {
      return { is_error: true, message: validation.message };
    }

    try {
      // M2 的 applyEdit：内存中执行替换并同步缓存
      const newContent = applyEdit(ctx.agentId, filePath, oldString, newString, replaceAll);

      // 写入磁盘
      await writeFile(filePath, newContent, 'utf-8');

      // 生成 diff 预览
      const diff = generateDiffPreview(oldString, newString);
      return { success: true, diff };
    } catch (err) {
      return { is_error: true, message: `Failed to edit file: ${(err as Error).message}` };
    }
  },
});

// ════════════════════════════════════════════════════════════════
// 3.5 glob（决策 4 + 18 + 33 + 34）
// ════════════════════════════════════════════════════════════════

const globTool = buildTool({
  name: 'glob',
  description: 'Find files matching a glob pattern. Returns sorted relative path list.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts")' },
      path: { type: 'string', description: 'Search directory (defaults to cwd)' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input, ctx) {
    const searchDir = input.path ? resolvePath(input.path as string, ctx.cwd) : ctx.cwd;
    const pattern = input.pattern as string;

    try {
      // 决策 33：递归遍历，跳过 IGNORE_DIRECTORIES
      const allFiles = await walkFiles(searchDir);
      const regex = globToRegex(pattern);
      const matches = allFiles.filter((f) => regex.test(f)).sort();
      const total = matches.length;

      // 决策 34：MAX_RESULTS=200 截断 + header 报告真实总数
      const truncated = total > MAX_GLOB_RESULTS;
      const displayed = matches.slice(0, MAX_GLOB_RESULTS);

      const header = truncated
        ? `Found ${total} files (showing first ${MAX_GLOB_RESULTS}). Refine your pattern for more specific results.\n\n`
        : `Found ${total} files.\n\n`;

      const filesText = header + displayed.join('\n');

      return {
        matchCount: total,
        truncated,
        files: truncateResult(filesText),
      };
    } catch (err) {
      return { is_error: true, message: `Glob failed: ${(err as Error).message}` };
    }
  },
});

// ════════════════════════════════════════════════════════════════
// 3.6 grep（决策 4 + 18 + 33 + 34）
// ════════════════════════════════════════════════════════════════

const grepTool = buildTool({
  name: 'grep',
  description: 'Search file contents with regex. Returns matching lines with file:line:text format.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for in file contents' },
      path: { type: 'string', description: 'Search directory (defaults to cwd)' },
      include: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input, ctx) {
    const searchDir = input.path ? resolvePath(input.path as string, ctx.cwd) : ctx.cwd;
    const pattern = input.pattern as string;
    const include = input.include as string | undefined;

    try {
      const { results, totalMatches, truncated } = await createGrep(pattern, searchDir, {
        include,
        maxMatches: MAX_GREP_MATCHES,
      });

      // 决策 34：grep 同理 header + 截断
      const header = truncated
        ? `Found ${totalMatches} matches (showing first ${MAX_GREP_MATCHES}). Refine your search for more specific results.\n\n`
        : `Found ${totalMatches} matches.\n\n`;

      const formatted = results.map((r) => `${r.path}:${r.line}:${r.text}`).join('\n');
      const fullText = header + formatted;

      return {
        matchCount: totalMatches,
        truncated,
        results: truncateResult(fullText),
      };
    } catch (err) {
      const msg = (err as Error).message;
      // 非法正则提示
      if (msg.includes('Invalid regular expression') || msg.includes('SyntaxError')) {
        return { is_error: true, message: `Invalid regex pattern: ${pattern}. ${msg}` };
      }
      return { is_error: true, message: `Grep failed: ${msg}` };
    }
  },
});

// ════════════════════════════════════════════════════════════════
// 3.7 task_create（决策 4 + Bug 2 修复）
// ════════════════════════════════════════════════════════════════

// 本地任务存储（决策 13：独立于 session 系统，按 agentId 隔离）
const localTasks = new Map<string, Array<{ id: string; subject: string; description: string; status: 'pending' | 'in_progress' | 'completed' }>>();

const taskCreateTool = buildTool({
  name: 'task_create',
  description: 'Create a task for tracking progress. Returns the created task.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Brief task title' },
      description: { type: 'string', description: 'Detailed description' },
    },
    required: ['subject', 'description'],
    additionalProperties: false,
  },
  // Bug 2 修复：isReadOnly=true——任务存储不是文件系统
  isReadOnly: true,

  async call(input, ctx) {
    const task = {
      id: `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      subject: input.subject as string,
      description: input.description as string,
      status: 'pending' as const,
    };

    // 本地 Map 存储（主存储）
    const tasks = localTasks.get(ctx.agentId) ?? [];
    tasks.push(task);
    localTasks.set(ctx.agentId, tasks);

    // 如果 M2 store 有 SubagentRecord，同步一份（供父 AI 查询进度）
    const record = getSubagent(ctx.agentId);
    if (record) {
      syncTasks(ctx.agentId, tasks);
    }

    return { task: { id: task.id, subject: task.subject } };
  },
});

// ════════════════════════════════════════════════════════════════
// 3.8 task_update（决策 4 + Bug 2 修复 + 教程 s27）
// ════════════════════════════════════════════════════════════════

const taskUpdateTool = buildTool({
  name: 'task_update',
  description: 'Update a task status. States: pending → in_progress → completed.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID from task_create' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
    },
    required: ['taskId', 'status'],
    additionalProperties: false,
  },
  // Bug 2 修复：isReadOnly=true——任务存储不是文件系统
  isReadOnly: true,

  async call(input, ctx) {
    const taskId = input.taskId as string;
    const newStatus = input.status as 'pending' | 'in_progress' | 'completed';

    const tasks = localTasks.get(ctx.agentId);
    if (!tasks || tasks.length === 0) {
      return { is_error: true, message: 'No tasks found. Use task_create first.' };
    }

    const taskIndex = tasks.findIndex((t) => t.id === taskId);

    if (taskIndex === -1) {
      return { is_error: true, message: `Task ${taskId} not found` };
    }

    const task = tasks[taskIndex];

    // 状态机校验（教程 s27）
    const validTransitions: Record<string, string[]> = {
      pending: ['in_progress'],
      in_progress: ['completed'],
      completed: [],  // 终态不可变
    };

    if (!validTransitions[task.status]?.includes(newStatus)) {
      return {
        is_error: true,
        message: `Invalid transition: ${task.status} → ${newStatus}. Valid transitions: pending → in_progress → completed.`,
      };
    }

    tasks[taskIndex] = { ...task, status: newStatus };

    // 教程 s27：allDone 自动清空
    if (tasks.every((t) => t.status === 'completed')) {
      localTasks.delete(ctx.agentId);
      // 同步到 M2 store
      const record = getSubagent(ctx.agentId);
      if (record) syncTasks(ctx.agentId, []);
      return { task: { id: taskId, status: newStatus }, allDone: true, message: 'All tasks completed, list cleared' };
    }

    // 同步到 M2 store
    const record = getSubagent(ctx.agentId);
    if (record) syncTasks(ctx.agentId, tasks);

    return { task: { id: taskId, status: newStatus } };
  },
});

// ── 注册 8 个工具（决策 13）──

toolRegistry.set('execute_cli', executeCliTool);
toolRegistry.set('read_file', readFileTool);
toolRegistry.set('write_file', writeFileTool);
toolRegistry.set('edit_file', editFileTool);
toolRegistry.set('glob', globTool);
toolRegistry.set('grep', grepTool);
toolRegistry.set('task_create', taskCreateTool);
toolRegistry.set('task_update', taskUpdateTool);
