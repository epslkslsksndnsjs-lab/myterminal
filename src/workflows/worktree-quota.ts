import fs from 'node:fs';
import path from 'node:path';

/**
 * 磁盘上界四层（ADR-0052 §11④）——上界 = 拒新增，绝不删旧（"不丢工作"守恒）。
 *
 * 四层各自成立，顺序即语义：
 *   a) 双配额：保留量上限 = keepQuotaCount（默认 50 个）+ keepQuotaBytes（默认 5 GB）；
 *   b) 软阈值（配额 80%）→ 告警：TUI 与审计双侧都看得见，但照常新建；
 *   c) 硬上限或磁盘可用低于下界 → 拒建：涉事那一路 fail-closed 判败，一条旧 worktree 都不动；
 *   d) 唯一减法 = 人：面板上合并或丢弃（可选自动归档默认关）。
 *
 * 计数口径 = 保留项（有改动未处置）的数量与字节——在建的那一路不计入自己，
 * 否则并发跑到第 50 路会把自己算进账、把自己拒了。
 */

/** 磁盘可用量下界：低于它就不再新增隔离区。 */
export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/** 软阈值比例：达配额这一成即告警（还没到拒建的线）。 */
export const QUOTA_SOFT_THRESHOLD_RATIO = 0.8;

export type QuotaLevel = 'ok' | 'warn' | 'blocked';

export type QuotaReason = 'keep-quota-count' | 'keep-quota-bytes' | 'free-disk';

export type QuotaInput = {
  preservedCount: number;
  preservedBytes: number;
  freeBytes: number;
  gates: { keepQuotaCount: number; keepQuotaBytes: number };
};

export type QuotaVerdict = {
  level: QuotaLevel;
  reasons: QuotaReason[];
  preservedCount: number;
  preservedBytes: number;
  freeBytes: number;
  keepQuotaCount: number;
  keepQuotaBytes: number;
};

/**
 * 四层里的第二、第三层在这一次判定里说清：软阈值只出告警，硬上限与磁盘下界出拒建理由。
 * 返回值不带"该删谁"——上界 = 拒新增，删不是这一层的活（唯一减法 = 人）。
 */
export function evaluateQuota(input: QuotaInput): QuotaVerdict {
  const blocked: QuotaReason[] = [];
  const warned: QuotaReason[] = [];
  const soft = (value: number, ceiling: number): boolean => value >= ceiling * QUOTA_SOFT_THRESHOLD_RATIO;
  const verdict = (level: QuotaLevel, reasons: QuotaReason[]): QuotaVerdict => ({
    level,
    reasons,
    preservedCount: input.preservedCount,
    preservedBytes: input.preservedBytes,
    freeBytes: input.freeBytes,
    keepQuotaCount: input.gates.keepQuotaCount,
    keepQuotaBytes: input.gates.keepQuotaBytes,
  });
  if (input.preservedCount >= input.gates.keepQuotaCount) blocked.push('keep-quota-count');
  else if (soft(input.preservedCount, input.gates.keepQuotaCount)) warned.push('keep-quota-count');
  if (input.preservedBytes >= input.gates.keepQuotaBytes) blocked.push('keep-quota-bytes');
  else if (soft(input.preservedBytes, input.gates.keepQuotaBytes)) warned.push('keep-quota-bytes');
  if (input.freeBytes < MIN_FREE_BYTES) blocked.push('free-disk');
  // 硬上限优先：已经到拒建的线，就不再叠一条"快到了"的告警把两件事混着说。
  if (blocked.length > 0) return verdict('blocked', blocked);
  if (warned.length > 0) return verdict('warn', warned);
  return verdict('ok', []);
}

/**
 * 目录字节数：普通文件的尺寸累加，符号链接不跟随（防环，也不把别人的仓库算成这一件的成本）。
 * 读不到按 0 计并继续——配额是保护性上界，不能因为一个目录项打不开就把整条路拒掉。
 */
export function directoryBytes(root: string): number {
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (entry.isFile()) total += fs.statSync(full).size;
      } catch {
        continue;
      }
    }
  }
  return total;
}

/** 保留项的合计（数量按条目、字节按登记值）——唯一计数口径。 */
export function preservedTotals(entries: readonly { state: string; bytes?: number }[]): { preservedCount: number; preservedBytes: number } {
  const kept = entries.filter((entry) => entry.state === 'preserved');
  return { preservedCount: kept.length, preservedBytes: kept.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) };
}
