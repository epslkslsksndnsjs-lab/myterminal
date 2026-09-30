import type { ChildProcess } from 'node:child_process';

/**
 * 在飞命令树账本——按进程组收，两条收尸路径（随路 abort / 随进程关机）。
 *
 * 三条纪律：
 *   1. 每条命令都以自己的进程组起跑（detached），收也按组收：负号打的是整组，
 *      单杀 shell 会把它派生的孙进程留在世上继续写盘；组杀失败才退回单杀。
 *   2. SIGTERM 先走，有限宽限后仍未退出的补 SIGKILL——宽限是给命令自己收尾用的，
 *      不是给挂死的进程占着工作区用的。
 *   3. 停接单（拒新命令）→ 收在飞树 → 有界等待，是优雅关机的固定三步；
 *      后台命令的记录随既有 subagent 记录同窗清理（1h，不另设窗口）。
 *
 * 诚实边界：命令自己 cd 到别处再动手，属于既有同等暴露面（本模块的边界是工具层路径闸），
 * shell 级沙箱不在这一版。
 */

/** 后台命令记录的清理窗：与既有 subagent 记录 TTL 同值，不另开一套。 */
export const BACKGROUND_RECORD_TTL_MS = 60 * 60 * 1000;

/** 关机时给在飞命令树的收尾宽限。 */
export const DEFAULT_COMMAND_GRACE_MS = 2_000;

export type OwnedCommand = {
  id: string;
  runId: string;
  dispatchId: string;
  pid: number;
  child: ChildProcess;
  backgrounded: boolean;
  startedAt: number;
  endedAt?: number;
  outputPath?: string;
};

export type CommandTreeOwner = { runId: string; dispatchId: string };

export function ownerKey(runId: string, dispatchId: string): string {
  return `${runId}/${dispatchId}`;
}

const commands = new Map<string, OwnedCommand>();
const waiters = new Map<string, Set<() => void>>();
let accepting = true;
let ttlMs = BACKGROUND_RECORD_TTL_MS;

/** 测试缝：把 1h 记录窗压缩到毫秒级。 */
export function setBackgroundRecordTtlMs(value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error('background record ttl must be a positive finite number');
  ttlMs = Math.floor(value);
}

export function getBackgroundRecordTtlMs(): number {
  return ttlMs;
}

/** 还接不接受新命令（优雅关机第一步是停接单）。 */
export function isAcceptingCommands(): boolean {
  return accepting;
}

export function stopAcceptingCommands(): void {
  accepting = false;
}

/** 恢复接单：关机流程之外的同一进程重新启用会走到这里。 */
export function resumeAcceptingCommands(): void {
  accepting = true;
}

/** 登记一条在飞命令；退出时间戳在这里落账，后台记录留下、前台记录即刻出账。 */
export function registerCommand(command: OwnedCommand): void {
  commands.set(command.id, command);
  command.child.once('exit', () => {
    const record = commands.get(command.id);
    if (!record) return;
    record.endedAt = Date.now();
    if (!record.backgrounded) commands.delete(record.id);
    wake(command.id);
  });
}

export function getCommand(id: string): OwnedCommand | undefined {
  return commands.get(id);
}

/** 观测面：某条路名下的命令（含已退出但仍在记录窗内的后台项）。 */
export function listCommands(filter?: Partial<CommandTreeOwner>): OwnedCommand[] {
  return [...commands.values()].filter(
    (command) => (!filter?.runId || command.runId === filter.runId) && (!filter?.dispatchId || command.dispatchId === filter.dispatchId),
  );
}

function signalGroup(command: OwnedCommand, signal: NodeJS.Signals): void {
  if (signalPidGroup(command.pid, signal)) return;
  try {
    command.child.kill(signal);
  } catch {
    /* 已经不在了 */
  }
}

/**
 * 对一个 pid 打整组信号（负 pid = 它领导的进程组），成功返回 true。
 * 执行工具在超时与中止的第一时间就调它——账本记录可能已被"退出"事件销掉，
 * 但组里的孙进程不会自己走，等账本再动手就晚了。
 */
export function signalPidGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function exited(command: OwnedCommand): boolean {
  return command.endedAt !== undefined || command.child.exitCode !== null || command.child.signalCode !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function wake(id: string): void {
  const set = waiters.get(id);
  if (!set) return;
  waiters.delete(id);
  for (const notify of set) notify();
}

/** 等到这一条真没了：宽限内退出即返回，超时也返回，绝不无限等。 */
function waitForExit(command: OwnedCommand, graceMs: number): Promise<void> {
  if (exited(command)) return Promise.resolve();
  const settled = new Promise<void>((resolve) => {
    const set = waiters.get(command.id) ?? new Set<() => void>();
    set.add(resolve);
    waiters.set(command.id, set);
  });
  return Promise.race([settled, sleep(graceMs)]);
}

/**
 * 收一条命令：SIGTERM 打组 → 有限宽限 → 仍活着的补 SIGKILL。
 * 返回这一次是否确认它走了。
 */
export async function collectCommand(id: string, graceMs: number = DEFAULT_COMMAND_GRACE_MS): Promise<boolean> {
  const command = commands.get(id);
  if (!command) return true;
  signalGroup(command, 'SIGTERM');
  await waitForExit(command, graceMs);
  if (exited(command)) {
    commands.delete(id);
    return true;
  }
  signalGroup(command, 'SIGKILL');
  await waitForExit(command, graceMs);
  commands.delete(id);
  return exited(command);
}

/** 收某一路名下的全部在飞命令树（随路中止与该路结算）。 */
export async function collectOwnerCommands(owner: CommandTreeOwner, graceMs?: number): Promise<number> {
  const ids = listCommands(owner).filter((command) => command.endedAt === undefined).map((command) => command.id);
  for (const id of ids) await collectCommand(id, graceMs);
  return ids.length;
}

/** 收某个 run 名下的全部在飞命令树（run 终态与取消）。 */
export async function collectRunCommands(runId: string, graceMs?: number): Promise<number> {
  const ids = listCommands({ runId }).filter((command) => command.endedAt === undefined).map((command) => command.id);
  for (const id of ids) await collectCommand(id, graceMs);
  return ids.length;
}

/**
 * 优雅关机：停接单 → 收全部在飞命令树 → 有界宽限 → 顺手清过期记录。
 * 关机之后账本只剩"已退出"的后台记录，供在场者按记录窗回看。
 */
export async function shutdownCommandTrees(options: { graceMs?: number; now?: number } = {}): Promise<{ collected: number; remaining: number; graceMs: number }> {
  stopAcceptingCommands();
  const graceMs = options.graceMs ?? DEFAULT_COMMAND_GRACE_MS;
  const pending = listCommands().filter((command) => command.endedAt === undefined);
  for (const command of pending) await collectCommand(command.id, graceMs);
  const remaining = listCommands().filter((command) => command.endedAt === undefined).length;
  pruneCommandRecords(options.now ?? Date.now());
  return { collected: pending.length, remaining, graceMs };
}

/** 过期后台记录清理（1h 窗，与既有 subagent 记录同值）；返回清掉的条数。 */
export function pruneCommandRecords(now: number = Date.now()): number {
  let removed = 0;
  for (const [id, command] of [...commands]) {
    if (command.endedAt === undefined || now - command.endedAt < ttlMs) continue;
    commands.delete(id);
    removed++;
  }
  return removed;
}

/** 测试缝：清空账本并恢复接单，不留跨用例残味。 */
export function resetCommandLedger(): void {
  commands.clear();
  wakeAll();
  waiters.clear();
  accepting = true;
  ttlMs = BACKGROUND_RECORD_TTL_MS;
}

function wakeAll(): void {
  for (const set of waiters.values()) for (const notify of set) notify();
}
