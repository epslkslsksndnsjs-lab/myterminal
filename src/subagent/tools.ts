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
import { truncateResult } from './result-budget.js';
import { getSubagent, createSubagent } from './store.js';
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

// D8 第 1 条：超时上限 600s（Claude BashTool 同款：默认 120s 不变、上限 600s）
const EXECUTE_CLI_MAX_TIMEOUT_SEC = 600;
// 审查 O1：转后台竞态 drain 的有界等待上限——孙进程持管道 fd 时 'end'/'close' 永不触发，
// 超时强制放行避免工具调用永久挂起（快照尽力而为）
const BACKGROUND_DRAIN_TIMEOUT_MS = 2000;

// D8 第 4 条：落盘盘帽——抄 Claude 5GB 盘帽口径（diskOutput.ts MAX_TASK_OUTPUT_BYTES），
// 数值按本项目实际定 256MB：子 agent 后台输出再大也是异常态，256MB 已远超正常输出。
// pipe 模式等价口径：写入侧累计超限 → 截断提示 + 丢弃后续 chunk（Claude DiskTaskOutput #capped，
// 不杀进程——杀进程是 Claude 文件模式 watchdog 的职责，我们的写路径全在 JS 侧，无需轮询）。
let backgroundOutputCapBytes = 256 * 1024 * 1024;
export const BACKGROUND_OUTPUT_CAP_BYTES_DISPLAY = '256MB';

/** 仅供测试——注入盘帽（先例：store.ts setCleanupDelayMs） */
export function setBackgroundOutputCapForTest(bytes: number): void {
  backgroundOutputCapBytes = bytes;
}
export function resetBackgroundOutputCapForTest(): void {
  backgroundOutputCapBytes = 256 * 1024 * 1024;
}

// D8 第 8 条：无意义命令判据——Claude BashTool isAutobackgroundingAllowed 原判据原样移植：
// 首 token（base command）命中禁用列表 → 不自动转后台。误判两方向均不致命（D8 第 8 条）。
// 显式 run_in_background=true 不受此判据约束（Claude 同款：explicit 恒 honored）。
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = ['sleep']; // sleep 类应在前台跑（Claude 同款）
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
  description: 'Execute a shell command. Returns stdout, stderr, and exit code.',
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
      // .gitignore 不跟踪）。子 read_file 在 cwd 内可达（D8 第 2 条）。
      let backgroundId: string | undefined;
      let outputPath: string | undefined;
      let fileHandle: FileHandle | null = null;
      let bytesWritten = 0;
      let capped = false;
      let pendingText = '';
      const outputDir = ctx.outputDir ?? join(ctx.cwd, '.myterminal', 'subagent-outputs', ctx.agentId);

      // D8 第 4 条：写入侧盘帽——累计超限 → 截断提示 + 丢弃后续 chunk（pipe 模式不杀进程；
      // 抄 Claude diskOutput.ts #capped）。content.length（UTF-16）欠计 UTF-8 字节 ≤3×，
      // 对磁盘防满防护足够（Claude 同款注释口径）。
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
      // （抄 Claude diskOutput.ts initTaskOutput）。O_NOFOLLOW 仅 Unix（Windows 无此攻击面）。
      async function createOutputFile(id: string): Promise<string> {
        const file = join(outputDir, `${id}.output`);
        await mkdir(outputDir, { recursive: true });
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

      // D8 第 11 条：转后台返回体——backgroundId + 已产输出（truncateResult 封顶）+ 引导语
      function backgroundResult(id: string, file: string, outStr: string | undefined, errStr: string | undefined): JsonObject {
        return {
          backgroundId: id,
          outputPath: file,
          message: `Output is being written to: ${file}`,
          stdout: truncateResult(outStr ?? ''),
          stderr: truncateResult(errStr ?? ''),
          exitCode: null,
        };
      }

      // stdout/stderr 收进对象容器——TS 对回调捕获的 let 变量会扩大为 string|undefined（TS2345）
      const out = { stdout: '', stderr: '' };
      // 转后台失败兜底：建文件失败（磁盘/权限）→ 杀进程 + 报错（比后台失联更可诊断）
      function failBackground(err: unknown): void {
        if (!settled) {
          settled = true;
          resolvePromise({
            is_error: true,
            message: `Failed to start background task: ${(err as Error).message}`,
            stdout: truncateResult(out.stdout ?? ''),
            stderr: truncateResult(out.stderr ?? ''),
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
        // 到点不杀、只登记转后台（Claude ShellCommand #handleTimeout 同款）
      });

      // 决策 28：追踪 shell 进程
      trackShellTask(ctx.agentId, child);

      child.stdout?.on('data', (d: Buffer) => {
        const text = d.toString();
        out.stdout += text;
        void appendOutput(text);
      });
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString();
        out.stderr += text;
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
          stdout: truncateResult(out.stdout),
          stderr: truncateResult(out.stderr),
          exitCode: code,
          is_error: interpretation.isError || false,
          ...(interpretation.message ? { message: interpretation.message } : {}),
        });
      });

      // ADR-0048 D8：显式后台——run_in_background=true 秒回 backgroundId+outputPath，命令继续跑
      // （Claude BashTool run_in_background 同款：explicit 恒 honored，不受 isAutobackgroundingAllowed 约束）
      if (explicitBackground) {
        // 局部 const 跨回调捕获（闭包变量跨函数边界不窄化——TS control-flow）
        const bgId = `bg_${randomUUID().slice(0, 8)}`;
        backgroundId = bgId;
        void createOutputFile(bgId)
          .then(async (file) => {
            outputPath = file;
            // 竞态：exit 先于 data 排空——等流结束再取快照（快命令输出不丢）
            if (childExited) await drainStreams(child);
            // 只 flush pendingText：每次 data 已逐条进 appendOutput（句柄就绪前暂存，
            // 就绪后直写），追加 out.stdout 会双重写入（pendingText ⊆ out.stdout）
            await appendOutput('');
            registerBackground(bgId, child);
            if (childExited) closeOutputHandle();
            if (!settled) {
              settled = true;
              resolvePromise(backgroundResult(bgId, file, out.stdout, out.stderr));
            }
          })
          .catch(failBackground);
        return;
      }

      // ADR-0048 D8：超时自动转后台——自持计时器。到点不杀，只登记 backgroundId 转后台；
      // sleep 类无意义命令不转后台（shouldAutoBackground 判据），照旧杀掉（原 spawn timeout 语义）。
      timeoutTimer = setTimeout(() => {
        if (settled || backgrounded) return;
        if (child.exitCode !== null || child.killed) return;
        if (isAutobackgroundingAllowed(command)) {
          backgrounded = true;
          // 局部 const 跨回调捕获（闭包变量跨函数边界不窄化——TS control-flow）
          const bgId = `bg_${randomUUID().slice(0, 8)}`;
          backgroundId = bgId;
          void createOutputFile(bgId)
            .then(async (file) => {
              outputPath = file;
              // 竞态：exit 先于 data 排空——等流结束再取快照
              if (childExited) await drainStreams(child);
              // 只 flush pendingText：转后台前已产输出（D8 第 11 条）全在 pendingText，
              // 追加 out.stdout 会双重写入（pendingText ⊆ out.stdout）
              await appendOutput('');
              registerBackground(bgId, child);
              if (childExited) closeOutputHandle();
              if (!settled) {
                settled = true;
                resolvePromise(backgroundResult(bgId, file, out.stdout, out.stderr));
              }
            })
            .catch(failBackground);
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
  description: 'Update a task status. States: pending → in_progress → completed; or blocked (with blockedReason) when you cannot proceed.',
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
