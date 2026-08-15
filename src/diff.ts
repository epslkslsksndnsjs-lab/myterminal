import { spawn } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MyTerminalConfig } from './types.js';

export type DiffSnapshot = {
  lines: string[];
  updatedAt?: string;
  checkedAt?: string;
  loading: boolean;
  truncated: boolean;
  truncationReasons?: string[];
  error?: string;
  unavailableReason?: 'not-git-repository' | 'git-unavailable';
};

type CaptureResult = {
  text: string;
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  limitReason?: 'characters' | 'lines';
};

type CaptureOptions = {
  maxChars: number;
  maxLines?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

function lineBreaks(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) === 10) count += 1;
  return count;
}

function sliceToLineBudget(value: string, remainingBreaks: number): string {
  if (remainingBreaks <= 0) return '';
  let seen = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 10) continue;
    seen += 1;
    if (seen >= remainingBreaks) return value.slice(0, index + 1);
  }
  return value;
}

async function capture(args: string[], cwd: string, options: CaptureOptions): Promise<CaptureResult> {
  const maxLines = options.maxLines ?? Number.MAX_SAFE_INTEGER;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const child = spawn('git', args, {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
  });
  let text = '';
  let stderr = '';
  let breaks = 0;
  let truncated = false;
  let timedOut = false;
  let aborted = false;
  let limitReason: CaptureResult['limitReason'];
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const terminate = (): void => {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
    killTimer ||= setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } }, 400);
    killTimer.unref?.();
  };
  const onAbort = (): void => { aborted = true; terminate(); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; truncated = true; terminate(); }, timeoutMs);
  timer.unref?.();

  child.stdout.on('data', (chunk: Buffer) => {
    if (limitReason || aborted) return;
    const raw = chunk.toString('utf8');
    const remainingChars = Math.max(0, options.maxChars - text.length);
    let accepted = raw.slice(0, remainingChars);
    if (accepted.length < raw.length) limitReason = 'characters';
    const remainingBreaks = Math.max(0, maxLines - breaks);
    const lineBounded = sliceToLineBudget(accepted, remainingBreaks);
    if (lineBounded.length < accepted.length) limitReason = 'lines';
    accepted = lineBounded;
    text += accepted;
    breaks += lineBreaks(accepted);
    if (limitReason || text.length >= options.maxChars || breaks >= maxLines) {
      limitReason ||= text.length >= options.maxChars ? 'characters' : 'lines';
      truncated = true;
      terminate();
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const remaining = Math.max(0, 20_000 - stderr.length);
    if (remaining > 0) stderr += chunk.toString('utf8').slice(0, remaining);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', (error) => { if (!settled) { settled = true; reject(error); } });
    child.once('close', (code) => { if (!settled) { settled = true; resolve(code ?? 1); } });
  }).finally(() => {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', onAbort);
  });

  if (exitCode !== 0 && !truncated && !aborted) throw new Error(stderr.trim() || `git exited with ${exitCode}`);
  return { text, exitCode, truncated, timedOut, aborted, limitReason };
}

async function sampleUntrackedFile(file: string, maxBytes: number): Promise<{ bytes: Buffer; size: number }> {
  const info = await stat(file);
  if (!info.isFile()) return { bytes: Buffer.alloc(0), size: 0 };
  const length = Math.min(info.size, maxBytes);
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, 0);
    return { bytes: bytes.subarray(0, bytesRead), size: info.size };
  } finally { await handle.close(); }
}

function equivalentSnapshot(left: DiffSnapshot, right: DiffSnapshot): boolean {
  return left.truncated === right.truncated
    && left.error === right.error
    && left.unavailableReason === right.unavailableReason
    && JSON.stringify(left.truncationReasons || []) === JSON.stringify(right.truncationReasons || [])
    && left.lines.length === right.lines.length
    && left.lines.every((line, index) => line === right.lines[index]);
}

/**
 * Optional Git capability adapter for the TUI.
 *
 * Source work, retained output, rendered lines, untracked-file sampling, and
 * wall-clock time are independently bounded. Reaching a bound terminates the
 * Git subprocess instead of merely discarding its output while it keeps working.
 */
export class WorkspaceDiffTracker {
  private timer?: NodeJS.Timeout;
  private refreshing = false;
  private refreshController?: AbortController;
  private repositoryState: 'unknown' | 'available' | 'not-git-repository' | 'git-unavailable' = 'unknown';
  private repositoryCheckedAt = 0;
  private stopped = true;
  private value: DiffSnapshot = { lines: [], loading: true, truncated: false };

  constructor(
    private readonly config: MyTerminalConfig,
    private readonly intervalMs = 10_000,
    private readonly maxChars = 300_000,
    private readonly maxLines = 2_000,
    private readonly maxUntrackedFiles = 300,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refresh(false);
    this.timer = setInterval(() => void this.refresh(false), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.refreshController?.abort();
  }

  snapshot(): DiffSnapshot {
    return { ...this.value, lines: [...this.value.lines], truncationReasons: this.value.truncationReasons ? [...this.value.truncationReasons] : undefined };
  }

  revision(): string {
    return [
      this.value.loading,
      this.value.updatedAt || '',
      this.value.lines.length,
      this.value.error || '',
      this.value.unavailableReason || '',
      this.value.truncated,
    ].join(':');
  }

  async refresh(showLoading = true): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    const controller = new AbortController();
    this.refreshController = controller;
    if (showLoading) this.value = { ...this.value, loading: true };
    const checkedAt = new Date().toISOString();
    const truncationReasons: string[] = [];
    try {
      if (this.repositoryState === 'unknown' || Date.now() - this.repositoryCheckedAt > 30_000) {
        try {
          const probe = await capture(['rev-parse', '--is-inside-work-tree'], this.config.workspaceDir, { maxChars: 1000, maxLines: 10, timeoutMs: 3000, signal: controller.signal });
          if (probe.aborted) return;
          this.repositoryState = probe.text.trim() === 'true' ? 'available' : 'not-git-repository';
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.repositoryState = /ENOENT|not found|cannot find/i.test(message) ? 'git-unavailable' : 'not-git-repository';
        }
        this.repositoryCheckedAt = Date.now();
      }

      if (this.repositoryState !== 'available') {
        this.commit({ lines: [], checkedAt, loading: false, truncated: false, unavailableReason: this.repositoryState });
        return;
      }

      const [diff, status] = await Promise.all([
        capture(['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', '--', '.'], this.config.workspaceDir, {
          maxChars: this.maxChars,
          maxLines: this.maxLines,
          timeoutMs: 8_000,
          signal: controller.signal,
        }),
        capture(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], this.config.workspaceDir, {
          maxChars: 200_000,
          timeoutMs: 8_000,
          signal: controller.signal,
        }),
      ]);
      if (diff.aborted || status.aborted || controller.signal.aborted) return;
      if (diff.timedOut) truncationReasons.push('tracked diff timed out');
      else if (diff.limitReason) truncationReasons.push(`tracked diff ${diff.limitReason} limit reached`);
      if (status.timedOut) truncationReasons.push('untracked-file enumeration timed out');
      else if (status.limitReason) truncationReasons.push('untracked-file enumeration output limit reached');

      const lines = diff.text.split(/\r?\n/).filter((line, index, all) => line || index < all.length - 1).slice(0, this.maxLines);
      let usedChars = lines.reduce((total, line) => total + line.length + 1, 0);
      let truncated = diff.truncated || status.truncated || lines.length >= this.maxLines;
      const statusRecords = status.text.split('\0');
      if (status.truncated) statusRecords.pop();
      const untracked = statusRecords.filter((record) => record.startsWith('?? ')).map((record) => record.slice(3));
      if (untracked.length > this.maxUntrackedFiles) {
        truncationReasons.push(`untracked-file sampling limited to ${this.maxUntrackedFiles} files`);
        truncated = true;
      }

      const workspaceRoot = await realpath(this.config.workspaceDir);
      const stateRoot = await realpath(this.config.stateDir).catch(() => path.resolve(this.config.stateDir));
      const deadline = Date.now() + 4_000;
      for (const relative of untracked.slice(0, this.maxUntrackedFiles)) {
        if (controller.signal.aborted) return;
        if (Date.now() >= deadline) {
          truncationReasons.push('untracked-file sampling time budget reached');
          truncated = true;
          break;
        }
        if (usedChars >= this.maxChars || lines.length >= this.maxLines) {
          truncationReasons.push(lines.length >= this.maxLines ? 'rendered line limit reached' : 'rendered character limit reached');
          truncated = true;
          break;
        }
        const absolute = path.resolve(workspaceRoot, relative);
        const lexical = path.relative(workspaceRoot, absolute);
        if (!lexical || lexical.startsWith('..') || path.isAbsolute(lexical)) continue;
        try {
          const resolved = await realpath(absolute);
          const workspaceRelative = path.relative(workspaceRoot, resolved);
          const stateRelative = path.relative(stateRoot, resolved);
          if (workspaceRelative.startsWith('..') || path.isAbsolute(workspaceRelative)) continue;
          if (!stateRelative.startsWith('..') && !path.isAbsolute(stateRelative)) continue;
          const info = await stat(resolved);
          if (info.isDirectory()) {
            const line = `?? ${relative.replace(/\/$/, '')}/ (untracked directory; contents collapsed)`;
            if (lines.length + 1 > this.maxLines || usedChars + line.length + 1 > this.maxChars) {
              truncationReasons.push(lines.length >= this.maxLines ? 'rendered line limit reached' : 'rendered character limit reached');
              truncated = true;
              break;
            }
            lines.push(line);
            usedChars += line.length + 1;
            truncationReasons.push('untracked directories are collapsed instead of recursively enumerated');
            truncated = true;
            continue;
          }

          const remainingChars = Math.max(0, this.maxChars - usedChars);
          const allowance = Math.min(64_000, remainingChars);
          if (!allowance) { truncated = true; break; }
          const sample = await sampleUntrackedFile(resolved, Math.max(8_000, allowance));
          if (!sample.size) continue;
          const header = [`diff --git a/${relative} b/${relative}`, 'new file mode 100644'];
          const binaryProbe = sample.bytes.subarray(0, Math.min(sample.bytes.length, 8000));
          if (binaryProbe.includes(0)) {
            const additions = [...header, `Binary file ${relative} is untracked (${sample.size} bytes)`];
            if (lines.length + additions.length > this.maxLines) { truncated = true; break; }
            lines.push(...additions);
            usedChars += additions.reduce((total, line) => total + line.length + 1, 0);
            continue;
          }

          const content = sample.bytes.subarray(0, allowance).toString('utf8');
          const contentLines = content.split(/\r?\n/);
          const prefix = [...header, '--- /dev/null', `+++ b/${relative}`, `@@ -0,0 +1,${contentLines.length} @@`];
          const availableLines = Math.max(0, this.maxLines - lines.length - prefix.length);
          const selected = contentLines.slice(0, availableLines).map((line) => `+${line}`);
          const additions = [...prefix, ...selected];
          lines.push(...additions);
          usedChars += additions.reduce((total, line) => total + line.length + 1, 0);
          if (selected.length < contentLines.length || sample.size > allowance || usedChars >= this.maxChars) {
            truncationReasons.push(`untracked file ${relative} was sampled`);
            truncated = true;
          }
        } catch {
          const additions = [`diff --git a/${relative} b/${relative}`, `untracked file unavailable: ${relative}`];
          if (lines.length + additions.length <= this.maxLines) lines.push(...additions);
          else truncated = true;
        }
      }

      const uniqueReasons = [...new Set(truncationReasons)];
      this.commit({
        lines: lines.slice(0, this.maxLines),
        checkedAt,
        loading: false,
        truncated: truncated || uniqueReasons.length > 0,
        truncationReasons: uniqueReasons.length ? uniqueReasons : undefined,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.repositoryState = 'unknown';
      this.commit({ lines: [], checkedAt, loading: false, truncated: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.refreshController === controller) this.refreshController = undefined;
      this.refreshing = false;
    }
  }

  private commit(next: DiffSnapshot): void {
    const unchanged = equivalentSnapshot(this.value, next);
    this.value = {
      ...next,
      updatedAt: unchanged ? this.value.updatedAt : next.checkedAt,
    };
  }
}
