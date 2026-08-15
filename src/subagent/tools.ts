// ADR-0007 决策 3/4/13/17/23/26/30/31/33/34/35/36/40
// Subagent 工具层——8 个工具 + 接口 + buildTool 工厂 + 注册表
//
// 决策 3：重新做一套 LLM 友好的工具，不绑 session/transport
// 决策 4：8 个工具——execute_cli/read_file/write_file/edit_file/glob/grep/task_create/task_update
// 决策 13：注册表模式（Map + buildTool + 按名称查找）
// 决策 31：10 字段接口（isConcurrencySafe 函数化 + validateInput + prompt + isDestructive + isEnabled）
// 决策 40：preToolUseHooks / postToolUseHooks 接口预留

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { JsonObject, JsonSchema } from '../types.js';
import { recordFileRead, validateEdit, applyEdit } from './file-state.js';
import { trackShellTask, registerBackgroundTask } from './shell-tracker.js';
import { checkCommandSafety, isCommandConcurrencySafe, interpretExitCode } from './permissions.js';
import { truncateResult, truncateCappedResult, MAX_RESULT_SIZE_CHARS } from './result-budget.js';
import { getSubagent, createSubagent } from './store.js';
import { getAgentOutputDir } from './output-dir.js';
import { redact } from '../redact.js';
import { createGrep } from './grep-utils.js';
import { IGNORE_DIRECTORIES, walkFiles } from '../utils/fs.js';

// ── 常量 ──

// 决策 35：read_file 拒绝的二进制扩展名
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.pdf', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.avi', '.mov', '.exe', '.dll', '.so', '.dylib',
  '.o', '.a', '.class', '.jar', '.wasm',
]);

// 决策 33：glob/grep 忽略目录——单一真相源见 ../utils/fs.ts 的 IGNORE_DIRECTORIES（含 build/.cache）

// 决策 34：glob 最大返回条数
const MAX_GLOB_RESULTS = 200;
// grep 最大匹配数
const MAX_GREP_MATCHES = 200;

// ── ADR-0048 D8（第四轮修订）：execute_cli 双模式 + 转后台落盘 ──

// D8 第 1 条：超时上限 600s（默认 120s 不变、上限 600s）
const EXECUTE_CLI_MAX_TIMEOUT_SEC = 600;
// 审查 O1：转后台竞态 drain 的有界等待上限——孙进程持管道 fd 时 'end'/'close' 永不触发，
// 超时强制放行避免工具调用永久挂起（快照尽力而为）
const BACKGROUND_DRAIN_TIMEOUT_MS = 2000;

// D8 第 4 条：落盘盘帽——5GB 上限（diskOutput.ts MAX_TASK_OUTPUT_BYTES），
// 数值按本项目实际定 256MB：子 agent 后台输出再大也是异常态，256MB 已远超正常输出。
// pipe 模式等价口径：写入侧累计超限 → 截断提示 + 丢弃后续 chunk（#capped 语义：
// 不杀进程——文件模式 watchdog 才杀进程，我们的写路径全在 JS 侧，无需轮询）。
let backgroundOutputCapBytes = 256 * 1024 * 1024;
export const BACKGROUND_OUTPUT_CAP_BYTES_DISPLAY = '256MB';

/** 仅供测试——注入盘帽（先例：store.ts setCleanupDelayMs） */
export function setBackgroundOutputCapForTest(bytes: number): void {
  backgroundOutputCapBytes = bytes;
}
export function resetBackgroundOutputCapForTest(): void {
  backgroundOutputCapBytes = 256 * 1024 * 1024;
}

// #151 内存快照帽的测试观察钩子（先例：setBackgroundOutputCapForTest）——
// 最近一次 execute_cli 调用的内存缓冲占用；仅供 GB 级模拟流内存有界断言，生产无用。
type SnapshotBuffers = {
  out: { stdout: string; stderr: string };
  outTotal: { stdout: number; stderr: number };
};
let snapshotBuffersForTest: SnapshotBuffers | undefined;

/** 仅供测试——读取最近一次 execute_cli 调用的内存快照缓冲占用（#151 内存有界断言）。 */
export function getSnapshotBufferForTest(): { stdoutChars: number; stderrChars: number; stdoutTotalChars: number; stderrTotalChars: number } | undefined {
  if (!snapshotBuffersForTest) return undefined;
  const { out, outTotal } = snapshotBuffersForTest;
  return {
    stdoutChars: out.stdout.length,
    stderrChars: out.stderr.length,
    stdoutTotalChars: outTotal.stdout,
    stderrTotalChars: outTotal.stderr,
  };
}

// D8 第 8 条：无意义命令判据——首 token（base command）命中禁用列表 → 不自动转后台。
// 误判两方向均不致命（D8 第 8 条）。
// 显式 run_in_background=true 不受此判据约束（explicit 恒 honored）。
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = ['sleep']; // sleep 类应在前台跑
function isAutobackgroundingAllowed(command: string): boolean {
  const baseCommand = command.trim().split(/\s+/)[0] ?? '';
  if (!baseCommand) return true;
  return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(baseCommand);
}

// ── 接口（决策 23 + 31 + 40）──

export type SubagentToolContext = {
  cwd: string;                              // 决策 23：subagent 工作目录
  signal: AbortSignal;                      // 决策 23：abort 信号
  agentId: string;                          // 决策 23：subagent ID
  readOnly?: boolean;                       // 决策 17 第 1 层：readOnly 模式标志（M7 executor 注入）
  /** ADR-0048 D8：后台输出落盘目录（executor 注入 cwd/.myterminal/subagent-outputs/<agentId>；缺省由 call 派生） */
  outputDir?: string;
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
// ADR-0015: realpath 检查防止 symlink 逃逸
function resolvePath(inputPath: string, cwd: string): string {
  const resolved = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
  const rel = relative(cwd, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${inputPath}" is outside working directory "${cwd}"`);
  }
  // ADR-0015: realpath 后再校验包含关系——防 symlink 指向 cwd 外
  let realPath: string | undefined;
  let realCwdPath: string | undefined;
  try {
    realPath = realpathSync(resolved);
    realCwdPath = realpathSync(cwd);
  } catch {
    // realpath 失败（ENOENT/EPERM/其他）：跳过检查，词法检查已通过
  }
  if (realPath && realCwdPath) {
    const realRel = relative(realCwdPath, realPath);
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new Error(`Path "${inputPath}" resolves via symlink to outside working directory "${cwd}"`);
    }
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
  description: `Execute a shell command and return its output (stdout, stderr, exit code).

IMPORTANT: Prefer dedicated tools over raw shell. Use read_file (not cat/head/tail), write_file / edit_file (not sed/awk), glob (not find/ls), grep (not grep/rg). Reserve execute_cli for commands that truly need a shell.

# Boundaries
- command: one shell command line (required). Runs via shell in a new process group.
- cwd: working directory for this call (optional). Defaults to the subagent working directory; must stay inside it.
- timeoutSec: seconds before this call times out. Default 120, minimum 1, maximum 600.
- run_in_background: set true to start the command in the background and return immediately (default false).
- In read-only mode only safe read-style commands are permitted — write commands are denied.
- Very large output is returned truncated. Background output is written to a file under .myterminal/subagent-outputs/ (256MB cap; beyond that, output is dropped with a truncation notice).

# Discipline
- Use absolute paths in commands: the working directory resets on every call, so relative paths break across calls.
- If a command creates directories or files, verify the parent directory exists first.
- Chain dependent commands with '&&' in one call; run independent commands as separate parallel calls.
- Do not use '&' to background a command yourself — use run_in_background.
- On timeout the command is automatically moved to the background: you get backgroundId + output file path, and the command keeps running — read its output later with read_file. Exception: commands starting with sleep are killed on timeout instead.
- Do not poll with sleep loops and do not blindly retry a failing command — read the error and diagnose the root cause.

# Failures
- Non-zero exit code: the result carries exitCode and is_error with an interpretation message — read it, fix, retry.
- is_error with a message: the message says what went wrong (spawn failure, permission denial, background start failure) — act on it.
- A denied command is not a bug to work around by rephrasing — report the blocker.`,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      cwd: { type: 'string', description: 'Working directory (defaults to subagent cwd)' },
      timeoutSec: { type: 'number', description: 'Timeout in seconds (default 120, max 600). On timeout the command is moved to background (returns backgroundId + output file path) unless it is a sleep-style no-op command.', default: 120, maximum: 600, minimum: 1 },
      run_in_background: { type: 'boolean', description: 'Set to true to run this command in the background. Returns immediately with backgroundId + output path; use read_file to read the output later.', default: false },
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
    // ADR-0048 D8：超时上限 600s——schema maximum 之外防御性钳制（直调路径不走 schema 校验）
    const timeoutSec = Math.min((input.timeoutSec as number) ?? 120, EXECUTE_CLI_MAX_TIMEOUT_SEC);
    const timeoutMs = timeoutSec * 1000;
    const explicitBackground = input.run_in_background === true;

    return new Promise<JsonObject>((resolvePromise) => {
      let settled = false;
      let backgrounded = false;

      // ADR-0048 D8（第四轮修订）：转后台输出落盘——backgroundId 命名文件
      // 落盘目录 = <cwd>/.myterminal/subagent-outputs/<agentId>（workspace 内状态目录先例
      // .myterminal/skills；IGNORE_DIRECTORIES 含 .myterminal → 子 glob/grep 自动忽略；
      // git 侧由输出层自忽略 .gitignore（`*`，R6/#157）兜住 → 用户 git status 零噪声）。
      // 子 read_file 在 cwd 内可达（D8 第 2 条）。
      let backgroundId: string | undefined;
      let outputPath: string | undefined;
      let fileHandle: FileHandle | null = null;
      let bytesWritten = 0;
      let capped = false;
      let pendingText = '';
      const outputDir = ctx.outputDir ?? getAgentOutputDir(ctx.cwd, ctx.agentId);

      // D8 第 4 条：写入侧盘帽——累计超限 → 截断提示 + 丢弃后续 chunk（pipe 模式不杀进程；
      // diskOutput.ts #capped 语义）。content.length（UTF-16）欠计 UTF-8 字节 ≤3×，
      // 对磁盘防满防护足够。
      async function appendOutput(text: string | undefined): Promise<void> {
        if (capped) return;
        if (!fileHandle) {
          // 文件句柄就绪前暂存（显式后台先 spawn 后建文件）；'' = flush 信号
          if (text !== undefined) pendingText += text;
          return;
        }
        if (pendingText) {
          const buffered = pendingText;
          pendingText = '';
          text = (text ?? '') === '' ? buffered : buffered + text;
        }
        if (!text) return;
        bytesWritten += text.length;
        if (bytesWritten > backgroundOutputCapBytes) {
          capped = true;
          try { await fileHandle.write(`\n[output truncated: exceeded ${BACKGROUND_OUTPUT_CAP_BYTES_DISPLAY} disk cap]\n`); } catch { /* 忽略 */ }
          return;
        }
        try { await fileHandle.write(text); } catch { /* 忽略 */ }
      }

      // D8 第 4 条：创建输出文件——O_NOFOLLOW 防 symlink 攻击 + O_EXCL 防抢先占位
      // （diskOutput.ts initTaskOutput 语义）。O_NOFOLLOW 仅 Unix（Windows 无此攻击面）。
      async function createOutputFile(id: string): Promise<string> {
        const file = join(outputDir, `${id}.output`);
        await mkdir(outputDir, { recursive: true });
        // R6（#157）：输出层自忽略 .gitignore（`*` 含自身）→ 用户仓库 git status 零噪声；
        // 不触碰用户仓库根 .gitignore。flag wx 幂等（EEXIST=已存在不覆盖用户编辑）；
        // 任何失败非致命——权限不足等不阻断命令执行。
        await writeFile(join(dirname(outputDir), '.gitignore'), '# MyTerminal background output — self-ignored\n*\n', { flag: 'wx' })
          .catch(() => { /* 忽略 */ });
        const flags = process.platform === 'win32'
          ? 'wx'
          : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
        fileHandle = await open(file, flags);
        return file;
      }

      // D8 第 7 条：句柄进 shell-tracker backgroundId 索引（收尸链已承担进程组杀）；
      // SubagentRecord 只存 backgroundId→pid 元数据（Q1 勘误：不重复发明收尸基建）
      function registerBackground(id: string, child: ChildProcess): void {
        registerBackgroundTask(ctx.agentId, id, child);
        const record = getSubagent(ctx.agentId);
        if (record) {
          if (!record.backgroundTasks) record.backgroundTasks = [];
          if (child.pid) record.backgroundTasks.push({ backgroundId: id, pid: child.pid });
        }
      }

      // D8 第 11 条：转后台返回体——backgroundId + 已产输出（truncateCappedResult 封顶）+ 引导语
      // #151：快照从内存帽缓冲取（outTotal 全量记账），语义与 truncateResult(全量) 逐字节一致
      function backgroundResult(id: string, file: string): JsonObject {
        return {
          backgroundId: id,
          outputPath: file,
          message: `Output is being written to: ${file}`,
          stdout: truncateCappedResult(out.stdout, outTotal.stdout),
          stderr: truncateCappedResult(out.stderr, outTotal.stderr),
          exitCode: null,
        };
      }

      // stdout/stderr 收进对象容器——TS 对回调捕获的 let 变量会扩大为 string|undefined（TS2345）
      const out = { stdout: '', stderr: '' };
      // #151：内存侧快照帽——后台化后 out.* 只留快照截断量（truncateCappedResult 同源 50K），
      // 全量字符数记计数器；快照后（settled）停止累积。落盘文件为权威源（盘帽 256MB 照旧）。
      const outTotal = { stdout: 0, stderr: 0 };
      // 测试观察钩子（先例：setBackgroundOutputCapForTest）——供 GB 级模拟流内存有界断言
      snapshotBuffersForTest = { out, outTotal };
      function appendSnapshot(kind: 'stdout' | 'stderr', text: string): void {
        if (settled) return; // 快照已定——停止累积（后台生命周期不再无限增长）
        outTotal[kind] += text.length;
        if (explicitBackground || backgrounded) {
          // 后台化后封顶到快照帽，超量丢弃（快照只取截断量；盘帽文件才是权威源）
          if (out[kind].length >= MAX_RESULT_SIZE_CHARS) return;
          out[kind] = (out[kind] + text).slice(0, MAX_RESULT_SIZE_CHARS);
          return;
        }
        out[kind] += text; // 前台照旧全量（退出时同源截断）
      }
      // 转后台失败兜底：建文件失败（磁盘/权限）→ 杀进程 + 报错（比后台失联更可诊断）
      function failBackground(err: unknown): void {
        if (!settled) {
          settled = true;
          resolvePromise({
            is_error: true,
            message: `Failed to start background task: ${(err as Error).message}`,
            stdout: truncateCappedResult(out.stdout, outTotal.stdout),
            stderr: truncateCappedResult(out.stderr, outTotal.stderr),
            exitCode: null,
          });
        }
        // 即时清理：进程组杀 + 降级单杀（同 cleanupAgentShellTasks 三级链第一级，防孤儿残留）
        try {
          if (child.pid) process.kill(-child.pid, 'SIGTERM');
        } catch {
          try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
        }
      }

      const child = spawn(command, {
        cwd: workingDir,
        shell: true,
        signal: ctx.signal,
        detached: true,          // 决策 28：新进程组，杀时用 process.kill(-pid)
        // ADR-0048 D8（第四轮修订）：移除 spawn timeout 选项改自持计时器——
        // 到点不杀、只登记转后台（#handleTimeout 语义）
      });

      // 决策 28：追踪 shell 进程
      trackShellTask(ctx.agentId, child);

      child.stdout?.on('data', (d: Buffer) => {
        const text = d.toString();
        appendSnapshot('stdout', text);
        void appendOutput(text);
      });
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString();
        appendSnapshot('stderr', text);
        void appendOutput(text);
      });

      // ADR-0048 D8：自持计时器声明在分支前——exit/error 清理要引用；显式后台无计时器
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      // 竞态标记：显式后台快命令可能先于建文件完成——文件就绪后由 createOutputFile.then 关句柄
      let childExited = false;

      function closeOutputHandle(): void {
        if (fileHandle) {
          const h = fileHandle;
          fileHandle = null;
          void h.close().catch(() => {});
        }
      }

      // 竞态路径专用：exit 可能先于 stdout/stderr 数据排空——等流结束再取已产输出快照
      function drainStreams(child: ChildProcess): Promise<void> {
        const waits: Array<Promise<void>> = [];
        for (const s of [child.stdout, child.stderr]) {
          if (!s) continue;
          // 审查 O1 勘误：readableEnded 快速路径不可靠——Bun 在 exit 事件时可能已标
          // EOF 但 'data' 尚未分发（AC9b 实测快照空）。无条件等 'end'/'close'；
          // 两者均已错过（极端）时由下方 2s 兜底放行。
          waits.push(new Promise((r) => {
            const stream = s as NodeJS.ReadableStream;
            stream.once('end', r);
            stream.once('close', r);
          }));
        }
        if (waits.length === 0) return Promise.resolve();
        // 审查 O1：有界等待——孙进程持管道 fd（如 nohup x &）时 'end'/'close' 永不触发，
        // 超时强制放行，避免工具调用永久挂起（快照尽力而为，落盘文件仍持续收写）
        return Promise.race([
          Promise.all(waits).then(() => {}),
          new Promise<void>((r) => setTimeout(r, BACKGROUND_DRAIN_TIMEOUT_MS)),
        ]);
      }

      // error/exit 监听器必须注册在显式分支 return 之前——
      // 否则显式后台模式无监听：spawn 失败即未捕获 'error' 事件崩溃，命令完成也不关句柄（fd 泄漏）
      child.on('error', (err: Error) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        // D8：后台命令建文件失败已杀进程，错误分支跳过（settled 已置）
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
        if (timeoutTimer) clearTimeout(timeoutTimer);
        // 审查 O2：进入后台模式（显式或超时转）后命令完成统一 deferred——交给
        // createOutputFile.then 按后台语义 resolve（backgroundId+outputPath+完整快照）。
        // 原先仅 fileHandle===null 走 deferred，「文件已建、.then 未 resolve」窄窗口
        // 会按前台 exitCode 返回丢身份（命令已完成但调用方拿不到 backgroundId）。
        if ((explicitBackground || backgrounded) && !settled) {
          childExited = true;
          return;
        }
        // D8：后台命令结束——数据已全部落盘，关闭文件句柄（文件保留供 read_file）
        closeOutputHandle();
        if (settled) return;
        settled = true;

        const code = exitCode ?? -1;
        // 决策 32 第 3 层：退出码语义
        const interpretation = interpretExitCode(command, code);

        resolvePromise({
          // #151：前台退出路径同样走全量记账截断（out 未帽时与 truncateResult 等价）
          stdout: truncateCappedResult(out.stdout, outTotal.stdout),
          stderr: truncateCappedResult(out.stderr, outTotal.stderr),
          exitCode: code,
          is_error: interpretation.isError || false,
          ...(interpretation.message ? { message: interpretation.message } : {}),
        });
      });

      // ADR-0048 #154：两后台分支共用单函数——createOutputFile.then 链逐字相同，抽 backgroundize
      // （显式 run_in_background 与超时转后台：建文件→排空→flush→登记→后台语义 resolve）
      function backgroundize(child: ChildProcess): void {
        // 局部 const 跨回调捕获（闭包变量跨函数边界不窄化——TS control-flow）
        const bgId = `bg_${randomUUID().slice(0, 8)}`;
        backgroundId = bgId;
        void createOutputFile(bgId)
          .then(async (file) => {
            outputPath = file;
            // 竞态：exit 先于 data 排空——等流结束再取快照（快命令输出不丢）
            if (childExited) await drainStreams(child);
            // 只 flush pendingText：每次 data 已逐条进 appendOutput（句柄就绪前暂存，
            // 就绪后直写；转后台前已产输出（D8 第 11 条）亦在 pendingText），
            // 追加 out.stdout 会双重写入（pendingText ⊆ out.stdout）
            await appendOutput('');
            registerBackground(bgId, child);
            if (childExited) closeOutputHandle();
            if (!settled) {
              settled = true;
              resolvePromise(backgroundResult(bgId, file));
            }
          })
          .catch(failBackground);
      }

      // ADR-0048 D8：显式后台——run_in_background=true 秒回 backgroundId+outputPath，命令继续跑
      // （explicit 恒 honored，不受自动转后台判据约束）
      // （Claude BashTool run_in_background 同款：explicit 恒 honored，不受 isAutobackgroundingAllowed 约束）
      if (explicitBackground) {
        backgroundize(child);
        return;
      }

      // ADR-0048 D8：超时自动转后台——自持计时器。到点不杀，只登记 backgroundId 转后台；
      // sleep 类无意义命令不转后台（shouldAutoBackground 判据），照旧杀掉（原 spawn timeout 语义）。
      timeoutTimer = setTimeout(() => {
        if (settled || backgrounded) return;
        if (child.exitCode !== null || child.killed) return;
        if (isAutobackgroundingAllowed(command)) {
          backgrounded = true;
          // #151：转后台时点收紧内存——前台阶段已积累的也截到快照帽（总量已在 outTotal 记账）
          out.stdout = out.stdout.slice(0, MAX_RESULT_SIZE_CHARS);
          out.stderr = out.stderr.slice(0, MAX_RESULT_SIZE_CHARS);
          backgroundize(child);
        } else {
          // sleep 类不转后台——超时杀（决策 32 语义保持：exitCode 非 null，非 is_error）
          child.kill('SIGTERM');
        }
      }, timeoutMs);
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
  description: `Read a text file from the working directory and return its content with line numbers.

# Boundaries
- path: absolute path or relative to the working directory (required). Must stay inside the working directory — paths outside it are rejected.
- offset: first line to return, 1-based (default 1).
- limit: max lines to return (default 2000).
- Binary files (images, PDFs, archives, media, executables, compiled objects...) are rejected — read_file supports text files only.
- Very long results are truncated.

# Discipline
- Read a file before editing it — edit_file refuses files that were never read.
- When you only need part of a large file, use offset/limit to read just that part.
- Output lines are numbered as "<line>\t<content>" — the number prefix is not part of the file.

# Failures
- File not found: the error names the path — use glob to find the correct path.
- Path is a directory: use glob to list directory contents instead.
- Binary file rejected: do not retry with different parameters — the extension is blocked by design.`,
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
  description: `Write content to a file. Creates the file (and parent directories) if missing; overwrites if it exists.

# Boundaries
- path: absolute path or relative to the working directory (required). Must stay inside the working directory.
- content: the exact text to write (required).
- Parent directories are created automatically.
- Returns whether the file was created or overwritten, plus line count.

# Discipline
- For modifying an existing file, prefer edit_file — it changes only what you specify. Use write_file for new files or complete rewrites.
- Writing a file also records it as read, so a subsequent edit_file on it is allowed.
- NEVER create documentation files (*.md, README*) unless the task explicitly requires them.
- Do not add emojis or decorative text to files unless asked.

# Failures
- is_error with a message: usually a permission or path problem (e.g. path outside the working directory) — read it and adjust.`,
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
  description: `Replace an exact string in a file with new content.

# Boundaries
- path / old_string / new_string are required. Path must stay inside the working directory.
- old_string must match the file exactly — including whitespace and indentation — and must be unique in the file unless replace_all is set.
- replace_all (default false): when true, every occurrence of old_string is replaced.
- Returns a diff preview of the change.

# Discipline
- You must read the file with read_file first — edit_file refuses files that were never read.
- Prefer editing existing files over creating new ones; use write_file for new files.
- Copy old_string from the read_file output after the line-number prefix — never include the number prefix in old_string.
- Keep old_string as small as possible while staying unique.

# Failures
- "File has not been read yet": read the file with read_file, then retry the edit.
- "String to replace not found": read the file again and copy the exact text.
- "Found N matches": add more surrounding context to old_string, or set replace_all=true when you want every occurrence.`,
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
  description: `Find files matching a glob pattern. Returns a sorted list of relative paths.

# Boundaries
- pattern: glob pattern (required), e.g. "**/*.ts" or "src/*.test.*".
- path: search directory (optional; defaults to the working directory, must stay inside it).
- At most 200 matches are returned; when more exist the result is truncated and the true total is reported as matchCount.
- Generated/ignored directories (.git, .myterminal, node_modules, dist, coverage, .next, .turbo, build, .cache) are skipped automatically.

# Discipline
- Use glob to find files by name; use grep to search file contents.
- If results are truncated, narrow the pattern instead of trying to page through.

# Failures
- Zero matches is not an error — it means the pattern matched nothing; try a broader pattern.
- is_error with a message: usually a path problem (outside the working directory).`,
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
      // 决策 33：递归遍历，跳过 IGNORE_DIRECTORIES（共享单源 ../utils/fs.ts，返回绝对路径 → 转相对供 glob 匹配）
      const allFiles = (await walkFiles(searchDir)).map((f) => relative(searchDir, f).replace(/\\/g, '/'));
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
  description: `Search file contents with a regex. Returns matching lines as file:line:text.

# Boundaries
- pattern: regex (required). An invalid regex is reported with a friendly error.
- path: search directory (optional; defaults to the working directory).
- include: optional glob filter to restrict which files are searched (e.g. "*.ts").
- At most 200 matches are returned; when more exist the result is truncated and the true total is reported as matchCount.
- Skips the same ignored directories as glob.

# Discipline
- Use grep for content search; use glob for filename search.
- Escape regex special characters when searching literal text (e.g. function calls with braces).
- Prefer grep over shell grep/rg commands.

# Failures
- Invalid regex pattern: the error says so — fix the pattern.
- Zero matches is not an error — broaden the pattern or the directory.
- is_error with a message: usually a path problem.`,
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
      // ADR-0028: 不再用消息子串猜错误类型。先确定性校验正则语法，
      // 非法正则直接返回友好消息，不暴露引擎内部细节；其他失败返回脱敏后的消息。
      try {
        new RegExp(pattern);
      } catch {
        return { is_error: true, message: `Invalid regex pattern: ${pattern}.` };
      }
      const detail = err instanceof Error ? err.message : String(err);
      return { is_error: true, message: `Grep failed: ${redact(detail)}` };
    }
  },
});

// ════════════════════════════════════════════════════════════════
// 3.7 task_create（决策 4 + Bug 2 修复）
// ════════════════════════════════════════════════════════════════

// ADR-0032 #47：任务状态单源——删除 localTasks 镜像，统一走 store.record.tasks（见 task_create/task_update）

const taskCreateTool = buildTool({
  name: 'task_create',
  description: `Create a task in your task list to track progress. The parent watches this list through your task status — it is the only window the parent has into your progress.

# Boundaries
- subject (required): max 120 characters. Write it as a progress sentence the parent can read at a glance — e.g. "Fixed parser null-pointer, now adding tests" — not just "Fix bug".
- description (required): what needs to be done.
- New tasks start as pending.

# Discipline
- Create tasks for work with 3 or more distinct steps; skip the list for a single trivial step.
- Update each task's status with task_update as you go — mark in_progress when starting, completed the moment it is done.
- Check the list before creating to avoid duplicates.
- When you discover the work cannot proceed (needed tool missing, permission denied, or the task conflicts with the parameters given), do not create endless new tasks — mark the current one blocked with a blockedReason naming the mismatching parameter, then produce the final report. The parent sees blocked + blockedReason on its next poll.

# Failures
- The tool returns the created task id — keep it; task_update needs it.`,
  inputSchema: {
    type: 'object',
    properties: {
      // D9（#139）：subject ≤120 字符——进度句随每轮 poll 全量进父上下文，防膨胀
      subject: { type: 'string', maxLength: 120, description: 'Brief task title' },
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

    // ADR-0032 #47：store 单源。record 缺失时 lazy createSubagent 兜底（与 executor.ts 同款），
    // 清空注入的主目标任务，使 record.tasks 仅承载 task_create 子任务（保持 allDone 语义与旧 localTasks 一致）。
    let record = getSubagent(ctx.agentId);
    if (!record) {
      record = createSubagent(ctx.agentId, { subject: String(input.subject ?? 'task session') });
      record.tasks = [];
    }

    record.tasks.push(task);

    return { task: { id: task.id, subject: task.subject } };
  },
});

// ════════════════════════════════════════════════════════════════
// 3.8 task_update（决策 4 + Bug 2 修复 + 教程 s27）
// ════════════════════════════════════════════════════════════════

const taskUpdateTool = buildTool({
  name: 'task_update',
  description: `Update a task's status — or block it when you cannot proceed.

# Boundaries
- taskId: the task id returned by task_create (required).
- status: one of pending, in_progress, completed, blocked (required).
- blockedReason: required when status=blocked; max 1000 characters. State exactly which parameter or constraint mismatches the task.
- Valid transitions: pending → in_progress | blocked; in_progress → completed | blocked; blocked → completed. completed is terminal.

# Discipline
- Mark a task in_progress when you start it and completed the moment you finish it — do not batch completions.
- ONLY mark completed when the work is fully done: tests pass, no unresolved errors. Otherwise keep it in_progress.
- When you cannot proceed (needed tool missing, permission denied, or the task conflicts with the parameters given), set blocked with a blockedReason naming the mismatch — fail fast, do not spin, then produce the final report. The parent sees blocked + blockedReason on its next poll of your tasks.
- When every task is completed the list is cleared automatically.

# Failures
- blockedReason missing or over 1000 chars: the error says so — state which parameter mismatches the task, concisely.
- Invalid transition (e.g. blocked → in_progress, or updating a completed task): the error lists the valid transitions — follow them.
- Task id not found / no tasks yet: create tasks with task_create first.`,
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID from task_create' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] },
      blockedReason: { type: 'string', maxLength: 1000, description: 'Reason for blocking. Required when status=blocked (max 1000 chars).' },
    },
    required: ['taskId', 'status'],
    additionalProperties: false,
  },
  // Bug 2 修复：isReadOnly=true——任务存储不是文件系统
  isReadOnly: true,

  async call(input, ctx) {
    const taskId = input.taskId as string;
    const newStatus = input.status as 'pending' | 'in_progress' | 'completed' | 'blocked';
    const blockedReason = input.blockedReason as string | undefined;

    // D12（ADR-0048 #135）：blocked 必填 blockedReason（≤1000 字符）——写明哪个参数与任务不符
    if (newStatus === 'blocked') {
      if (!blockedReason || !blockedReason.trim()) {
        return { is_error: true, message: 'blockedReason is required when status is blocked. State which parameter mismatches the task.' };
      }
      if (blockedReason.length > 1000) {
        return { is_error: true, message: `blockedReason exceeds 1000 characters (got ${blockedReason.length}).` };
      }
    }

    // ADR-0032 #47：store 单源——直接读写 record.tasks
    const record = getSubagent(ctx.agentId);
    if (!record || record.tasks.length === 0) {
      return { is_error: true, message: 'No tasks found. Use task_create first.' };
    }
    const tasks = record.tasks;

    const taskIndex = tasks.findIndex((t) => t.id === taskId);

    if (taskIndex === -1) {
      return { is_error: true, message: `Task ${taskId} not found` };
    }

    const task = tasks[taskIndex];

    // 状态机校验（教程 s27 + D12：blocked 近终态——允许 pending/in_progress→blocked、blocked→completed，
    // 禁止 blocked→in_progress 回转）
    const validTransitions: Record<string, string[]> = {
      pending: ['in_progress', 'blocked'],
      in_progress: ['completed', 'blocked'],
      blocked: ['completed'],
      completed: [],  // 终态不可变
    };

    if (!validTransitions[task.status]?.includes(newStatus)) {
      return {
        is_error: true,
        message: `Invalid transition: ${task.status} → ${newStatus}. Valid transitions: pending → in_progress | blocked; in_progress → completed | blocked; blocked → completed.`,
      };
    }

    // blocked 时落 blockedReason（父轮询 tasks 字段可见）；非 blocked 传了 blockedReason 忽略
    tasks[taskIndex] = newStatus === 'blocked'
      ? { ...task, status: newStatus, blockedReason: blockedReason!.trim() }
      : { ...task, status: newStatus };

    // 教程 s27：allDone 自动清空（单源：直接清空 record.tasks）
    if (tasks.every((t) => t.status === 'completed')) {
      record.tasks = [];
      return { task: { id: taskId, status: newStatus }, allDone: true, message: 'All tasks completed, list cleared' };
    }

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

// ADR-0032 #47：localTasks 镜像已移除，任务状态统一在 store.record.tasks（自带 1h 兜底清理，无需独立清理）
