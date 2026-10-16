import { createExclusive, readJson, removeFile } from './atomic.js';

/**
 * resume 排他锁（ADR-0052 §17）——防两个续跑者共写同一 run 目录 / 标记 / worktree，
 * 也防同一脚本被两路全量重跑烧两份 token。
 *
 * 判据 = owner pid + epoch，两条各堵一个洞：
 *   · pid 不在（进程已死）→ 锁失效，可接管；
 *   · pid 在但 epoch 更低（pid 复用窗口：老进程死了、pid 被新进程捡走）→ 旧锁仍失效；
 *     同 pid 同 epoch 才是"我自己还持有"，幂等放行。
 * epoch 单调靠进程实例递增：重启必然拿到更大的 epoch，于是复用 pid 打不死接管判定。
 *
 * 读不出来的锁（撕裂 / 非本人可读）一律按"有人持着"处理，绝不静默接管——
 * 误判成失效会让两个续跑者同时进目录，正是这把锁要挡的事。
 */

export type LockIdentity = { pid: number; epoch: number };

export type LockRecord = LockIdentity & { at: string; ownerSessionId: string };

export type LockProbe = LockIdentity & {
  /** pid 是否存活：生产走 process.kill(pid, 0)，测试注入。 */
  isAlive(pid: number): boolean;
  now(): number;
  iso(): string;
};

export type AcquireResult =
  | { ok: true; record: LockRecord }
  | { ok: false; reason: 'held'; holder?: LockRecord }
  | { ok: false; reason: 'unreadable' };

function readLockRecord(raw: unknown): LockRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid < 0) return undefined;
  if (typeof value.epoch !== 'number' || !Number.isInteger(value.epoch) || value.epoch < 0) return undefined;
  return {
    pid: value.pid,
    epoch: value.epoch,
    at: typeof value.at === 'string' ? value.at : '',
    ownerSessionId: typeof value.ownerSessionId === 'string' ? value.ownerSessionId : '',
  };
}

/**
 * 旧锁是否失效（可接管）：
 *   持有者进程没了 → 失效；
 *   持有者 pid 与本次相同但 epoch 更低（pid 被复用后的新实例）→ 旧锁失效；
 *   其余（他人存活进程持着）→ 仍有效。
 */
export function isLockStale(holder: LockRecord, self: LockIdentity, isAlive: (pid: number) => boolean): boolean {
  if (!isAlive(holder.pid)) return true;
  if (holder.pid === self.pid && holder.epoch < self.epoch) return true;
  return false;
}

/**
 * 取锁：独占创建；已存在则按 pid+epoch 判失效——失效就删掉重抢一次，
 * 抢赢才返回持有（两路同判失效时靠 createExclusive 决出唯一胜者）。
 */
export async function acquireResumeLock(lockFile: string, ownerSessionId: string, probe: LockProbe): Promise<AcquireResult> {
  const write = (): Promise<boolean> =>
    createExclusive(lockFile, `${JSON.stringify({ pid: probe.pid, epoch: probe.epoch, at: probe.iso(), ownerSessionId }, null, 2)}\n`);

  if (await write()) {
    return { ok: true, record: { pid: probe.pid, epoch: probe.epoch, at: probe.iso(), ownerSessionId } };
  }

  const raw = await readJson(lockFile).catch(() => ({} as unknown));
  const holder = readLockRecord(raw);
  if (holder === undefined) return { ok: false, reason: 'unreadable' };
  if (!isLockStale(holder, probe, probe.isAlive)) return { ok: false, reason: 'held', holder };

  // 失效锁：先清再抢。删与抢之间可能有人插队，抢输即 held，绝不双持。
  await removeFile(lockFile);
  if (await write()) {
    return { ok: true, record: { pid: probe.pid, epoch: probe.epoch, at: probe.iso(), ownerSessionId } };
  }
  const raced = readLockRecord(await readJson(lockFile).catch(() => undefined));
  return { ok: false, reason: 'held', holder: raced };
}

/** 放锁只放自己那一把：pid + epoch 都对上才删，拿别人的锁释放即结构性错误。 */
export async function releaseResumeLock(lockFile: string, self: LockIdentity): Promise<{ released: boolean }> {
  const holder = readLockRecord(await readJson(lockFile).catch(() => undefined));
  if (!holder || holder.pid !== self.pid || holder.epoch !== self.epoch) return { released: false };
  await removeFile(lockFile);
  return { released: true };
}
