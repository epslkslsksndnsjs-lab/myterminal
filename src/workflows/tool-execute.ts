import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

import { resolveToolPath } from './tool-boundary.js';
import { classifyCommand, interpretExitCode } from './tool-command.js';
import { boundText, toolFailure, toolOk, MAX_TOOL_RESULT_CHARS } from './tool-output.js';
import { collectCommand, isAcceptingCommands, registerCommand, signalPidGroup } from './command-tree.js';
import type { FileHandle } from 'node:fs/promises';
import type { OwnedCommand } from './command-tree.js';
import type { AgentTool } from './tool-face.js';

/**
 * 执行工具——有界、可后台、按进程组收。
 *
 * 四条纪律：
 *   1. 有界：超时默认 120 秒、上限 600 秒（越界值夹回来，不按字面等），到点先 SIGTERM
 *      打进程组、宽限后补 SIGKILL，并把已经产出的部分如实带回去；
 *   2. 可后台：run_in_background 起一条并立刻回句柄 + 输出文件路径；输出独占创建
 *      （0600、拒跟随符号链接）、按字节帽截断并写下显式标记，回看走读文件工具；
 *   3. 按组收：detached 起跑、负 pid 收尸，abort / 该路结算 / 关机三条路落到同一个收法；
 *   4. 命令闸：只读面只放 safe 读命令，危险表两种模式都挡，拒因照实回给模型。
 *
 * 停接单期间（优雅关机进行中）新命令一律拒——已经排队的不补起，燃烧就地打住。
 * 命令自己 cd 逃逸属既有同等暴露面；shell 级沙箱不在这一版。
 */

export const DEFAULT_EXECUTE_TIMEOUT_SEC = 120;
export const MAX_EXECUTE_TIMEOUT_SEC = 600;
/** 后台输出文件的字节帽：到点写一条显式标记后停止追加，进程照跑。 */
export const MAX_BACKGROUND_OUTPUT_BYTES = 256 * 1024 * 1024;
/** SIGTERM 后给命令进程组自己收尾的宽限。 */
export const COMMAND_GRACE_MS = 2_000;

const REFUSAL_TEXT: Record<string, string> = {
  'command-substitution': 'command substitution is not auditable, so it is refused here',
  'dangerous-command': 'the command matches the dangerous-command list',
  'not-in-read-only-allowlist': 'this path only runs allowlisted read-only commands',
  'interpreter-recursion': 'nested interpreter wrappers exceeded the allowed depth',
};

function clampTimeout(value: unknown): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_EXECUTE_TIMEOUT_SEC;
  return Math.min(MAX_EXECUTE_TIMEOUT_SEC, Math.max(1, raw));
}

type Counter = { text: string; chars: number };

function append(buffer: Counter, chunk: Buffer | string): void {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  buffer.chars += text.length;
  if (buffer.text.length >= MAX_TOOL_RESULT_CHARS) return;
  buffer.text += text.slice(0, MAX_TOOL_RESULT_CHARS - buffer.text.length);
}

function boundedOutput(stdout: Counter, stderr: Counter): Record<string, unknown> {
  const out = boundText(stdout.text);
  const err = boundText(stderr.text);
  return {
    stdout: out.text,
    stderr: err.text,
    stdoutChars: stdout.chars,
    stderrChars: stderr.chars,
    truncated: out.truncated || err.truncated,
  };
}

function backgroundFlags(): number {
  // win32 不支持 O_NOFOLLOW；那里目录本身由模块独占创建。
  return process.platform === 'win32'
    ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
}

/**
 * 测试缝：把后台输出的字节帽压小，用例才能真的走到"写满即停 + 显式标记"那条臂。
 * 缺省就是生产口径（256MB），不改语义只改刻度。
 */
let backgroundCapBytes = MAX_BACKGROUND_OUTPUT_BYTES;

export function setMaxBackgroundOutputBytes(value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error('background output cap must be a positive finite number');
  backgroundCapBytes = Math.floor(value);
}

export function getMaxBackgroundOutputBytes(): number {
  return backgroundCapBytes;
}

export function resetMaxBackgroundOutputBytes(): void {
  backgroundCapBytes = MAX_BACKGROUND_OUTPUT_BYTES;
}

/** 后台输出的落地：字节帽内追加，过帽写一条显式标记后不再写（进程照跑，只是不再攒输出）。 */
async function sinkBackground(handle: FileHandle, state: { bytes: number; capped: boolean }, chunk: Buffer | string): Promise<void> {
  if (state.capped) return;
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  if (state.bytes + Buffer.byteLength(text) > backgroundCapBytes) {
    state.capped = true;
    await handle.write(`\n[output truncated: exceeded ${backgroundCapBytes} bytes]\n`);
    return;
  }
  state.bytes += Buffer.byteLength(text);
  await handle.write(text);
}

export const executeCliTool: AgentTool = {
  name: 'execute_cli',
  target: 'command',
  write: false,
  description: 'Run one shell command with a bounded timeout, or start it in the background. On a read-only path only allowlisted read commands run and output redirection is refused. Every command runs in its own process group and is collected when this path aborts or the runtime shuts down.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command line.' },
      cwd: { type: 'string', description: 'Working directory for the command; must stay inside this path\'s boundary.' },
      timeoutSec: { type: 'integer', description: `Foreground timeout in seconds (default ${DEFAULT_EXECUTE_TIMEOUT_SEC}, max ${MAX_EXECUTE_TIMEOUT_SEC}).` },
      run_in_background: { type: 'boolean', description: 'Start it and return immediately with a handle plus an output file path.' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async run(input, context) {
    if (!isAcceptingCommands()) return toolFailure('The runtime is shutting down; no new commands are accepted.', 'shutting-down');
    // 已经中止的路不再起新进程：这条路本身就是被收的对象。
    if (context.signal.aborted) return toolFailure('This path was aborted before the command could start.', 'aborted');
    if (typeof input.command !== 'string' || !input.command.trim()) return toolFailure('command must be a non-empty string.', 'empty-command');
    const gate = classifyCommand(input.command, context.mode);
    if (!gate.allowed) {
      return toolFailure(`Refused: ${input.command} — ${REFUSAL_TEXT[gate.reason] ?? 'the command gate rejected it'}.`, gate.reason);
    }
    let workingDir = context.cwd;
    if (input.cwd !== undefined) {
      try {
        workingDir = resolveToolPath(input.cwd, context.cwd, 'cwd');
      } catch (error) {
        return toolFailure((error as Error).message, 'outside-boundary');
      }
    }
    const timeoutSec = clampTimeout(input.timeoutSec);
    const id = `cmd_${randomUUID().slice(0, 8)}`;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, { cwd: workingDir, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], signal: context.signal });
    } catch (error) {
      // 起不来（界外 / 不可 exec 的 cwd 会同步抛）也是一次明确交付，不静默当空结果。
      return toolFailure(`The command could not be started: ${(error as Error).message}`, 'spawn-failed', { timeoutSec });
    }
    const record: OwnedCommand = {
      id,
      runId: context.runId,
      dispatchId: context.dispatchId,
      pid: child.pid ?? 0,
      child,
      backgrounded: input.run_in_background === true,
      startedAt: Date.now(),
    };

    if (record.backgrounded) {
      const file = path.join(context.run.bgDir, `${id}.output`);
      let handle: FileHandle;
      try {
        await mkdir(context.run.bgDir, { recursive: true });
        handle = await open(file, backgroundFlags(), 0o600);
      } catch (error) {
        child.kill('SIGKILL');
        return toolFailure(`Could not open the background output file: ${(error as Error).message}`, 'background-output-failed');
      }
      record.outputPath = file;
      registerCommand(record);
      const state = { bytes: 0, capped: false };
      child.stdout?.on('data', (chunk: Buffer | string) => void sinkBackground(handle, state, chunk));
      child.stderr?.on('data', (chunk: Buffer | string) => void sinkBackground(handle, state, chunk));
      child.once('close', () => void handle.close().catch(() => undefined));
      return toolOk({
        backgroundId: id,
        pid: record.pid,
        outputPath: file,
        note: 'The command runs in the background. Read outputPath as it grows; the process group is collected when this path ends.',
      });
    }

    registerCommand(record);
    const stdout: Counter = { text: '', chars: 0 };
    const stderr: Counter = { text: '', chars: 0 };
    child.stdout?.on('data', (chunk: Buffer | string) => append(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => append(stderr, chunk));

    const outcome = await new Promise<{ code: number | null; timedOut: boolean; aborted: boolean; spawnError?: string }>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // 谁先动手就定性到底：收尸期间 child 会以"退出"回来，那不是命令自己跑完的下场。
      let terminated: 'timeout' | 'aborted' | undefined;
      const settle = (value: { code: number | null; timedOut: boolean; aborted: boolean; spawnError?: string }): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        context.signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      // 收完才回话：超时与中止的返回点就是"进程组已经不在了"的确认点，账本里不留无主树。
      // 打组信号在第一时刻发出去——Node 自己的 signal 兜底只杀直接子进程，
      // 组里的孙进程要这一刀；账本收尸负责确认与销账。
      const collectThenSettle = (kind: 'timeout' | 'aborted'): void => {
        terminated = kind;
        signalPidGroup(child.pid ?? 0, 'SIGTERM');
        void collectCommand(id, COMMAND_GRACE_MS).then(() => settle({
          code: child.exitCode,
          timedOut: kind === 'timeout',
          aborted: kind === 'aborted',
        }));
      };
      const onAbort = (): void => collectThenSettle('aborted');
      timer = setTimeout(() => collectThenSettle('timeout'), timeoutSec * 1000);
      timer.unref();
      if (context.signal.aborted) onAbort();
      else context.signal.addEventListener('abort', onAbort, { once: true });
      child.once('exit', (code) => {
        if (terminated) return;
        // spawn 的 signal 兜底可能在我们的监听器之前就把子进程结果定下来——
        // 那仍是"被中止"，不许落成一次普通退出。
        if (context.signal.aborted) { collectThenSettle('aborted'); return; }
        settle({ code, timedOut: false, aborted: false });
      });
      child.once('error', (error) => {
        if (terminated) return;
        if (context.signal.aborted) { collectThenSettle('aborted'); return; }
        // 异步起不来（ENOENT / ENOTDIR 之类）同样是一次明确交付。
        settle({ code: null, timedOut: false, aborted: false, spawnError: (error as Error).message });
      });
    });

    if (outcome.timedOut) {
      return toolFailure(`The command did not finish within ${timeoutSec}s; its process group was collected.`, 'timeout', { ...boundedOutput(stdout, stderr), timeoutSec });
    }
    if (outcome.aborted) {
      return toolFailure('The command was collected because its agent path was aborted.', 'aborted', { ...boundedOutput(stdout, stderr), timeoutSec });
    }
    if (outcome.spawnError) {
      return toolFailure(`The command could not be started: ${outcome.spawnError}`, 'spawn-failed', { ...boundedOutput(stdout, stderr), timeoutSec });
    }
    const payload: Record<string, unknown> = { ...boundedOutput(stdout, stderr), timeoutSec };
    payload.exitCode = outcome.code;
    const verdict = interpretExitCode(input.command, outcome.code);
    if (verdict.isError) return toolFailure(verdict.message ?? `Command exited with code ${String(outcome.code)}`, 'nonzero-exit', payload);
    if (verdict.message) return toolOk({ ...payload, note: verdict.message });
    return toolOk(payload);
  },
};

/** 执行工具在工具表里就一个：可后台与前台同一条闸、同一个收尸路径。 */
export const EXECUTE_TOOLS: readonly AgentTool[] = [executeCliTool];
