import { appendLine, readLines, replaceLinesAtomic } from './atomic.js';
import { SCHEMA_VERSION } from './schema.js';

/**
 * 调用账——续跑时能回答"这一路跑到哪了"的唯一证据。
 *
 * 两条纪律：
 *   1. 单写者按行追加：并发路可以任意顺序完成，但账按 admission 顺序归位，
 *      写入本身串行（内部 promise 链），绝不两行交错粘连；
 *   2. 恢复规则 = 截断至最长良前缀：撕裂尾行与中间损坏同规则，
 *      丢弃段显式记账（不静默丢）。
 */

export type JournalRecord =
  | { type: 'launched'; version: number; runId: string; at: string }
  | { type: 'started'; version: number; seq: number; key?: string; label?: string; at: string }
  | { type: 'result'; version: number; seq: number; key?: string; value: unknown; at: string }
  | { type: 'failed'; version: number; seq: number; key?: string; error: { kind: string; message: string }; at: string };

/** 记账入参：version 由 append 补，其余按记录类型各自成立（联合分发）。 */
type OmitVersion<T> = T extends unknown ? Omit<T, 'version'> : never;
export type JournalInput = OmitVersion<JournalRecord> & { version?: number };

export type TruncationReport = {
  /** 保留的良前缀行数。 */
  kept: number;
  /** 被丢弃的行数（含首个损坏行及其后全部）。 */
  dropped: number;
};

export class Journal {
  /** 单写者锁：append 串行化，避免并发路交错写坏行边界。 */
  private tail: Promise<unknown> = Promise.resolve();
  /** 归位游标：下一条应落盘的 admission 序号。 */
  private expected = 1;
  /** 乱序归位缓冲：先完成的路等着前一路，账才按调用序连续。 */
  private readonly holding = new Map<number, { line: string; settle: () => void }>();

  constructor(private readonly file: string) {}

  static open(file: string): Journal {
    return new Journal(file);
  }

  /** 记账一行。返回已排队的写盘 promise（fire-and-forget 场景可不安 await）。 */
  append(record: JournalInput): Promise<void> {
    return this.enqueue(this.lineFor(record));
  }

  private lineFor(record: JournalInput, seq?: number): string {
    return JSON.stringify({ version: SCHEMA_VERSION, ...(seq === undefined ? {} : { seq }), ...record });
  }

  private enqueue(line: string): Promise<void> {
    const next = this.tail.then(() => appendLine(this.file, line));
    // 锁链自身永不因单点失败而断：后续行仍要写，失败由调用方从 drain() 观察。
    this.tail = next.catch(() => undefined);
    return next;
  }

  /**
   * 按 admission 序归位地记一行（seq = 调用序，1 起）。
   *
   * 前面还有没结算的路时，这一行先在缓冲里等着——完成顺序绝不改写账本顺序。
   * 返回的 promise 在该行真正落盘时兑现；调用方按 fire-and-forget 处理，
   * 结算前 flushPending() 把等不到口的行升序补齐（不静默丢）。
   */
  appendOrdered(seq: number, record: JournalInput): Promise<void> {
    if (!Number.isInteger(seq) || seq < 1) {
      return Promise.reject(new TypeError(`journal sequence must be a positive integer; received: ${String(seq)}`));
    }
    if (seq < this.expected) {
      // 重放的旧序号（同一路的第二张账）不再进链，直接落盘。
      return this.enqueue(this.lineFor(record, seq));
    }
    const line = this.lineFor(record, seq);
    return new Promise<void>((resolve) => {
      this.holding.set(seq, { line, settle: resolve });
      this.pumpOrdered();
    });
  }

  /** 把能连续的行依次落盘（缺口留在缓冲里等）。 */
  private pumpOrdered(): void {
    while (this.holding.has(this.expected)) {
      const seq = this.expected;
      const held = this.holding.get(seq) as { line: string; settle: () => void };
      this.holding.delete(seq);
      this.expected = seq + 1;
      void this.enqueue(held.line).then(held.settle, held.settle);
    }
  }

  /** 缓冲里还压着几行（观测面）。 */
  pendingCount(): number {
    return this.holding.size;
  }

  /**
   * 终态前的补齐：把等不到前序的行按 seq 升序写完。
   * 在飞被打断的路本就无账可记，缺口保留原样——"started 无 result" 即那一路的账。
   */
  async flushPending(): Promise<void> {
    const seqs = [...this.holding.keys()].sort((a, b) => a - b);
    for (const seq of seqs) {
      const held = this.holding.get(seq) as { line: string; settle: () => void };
      this.holding.delete(seq);
      this.expected = Math.max(this.expected, seq + 1);
      void this.enqueue(held.line).then(held.settle, held.settle);
    }
    await this.tail;
  }

  /** 续跑入参：已有几路记账，游标就从几 + 1 起。 */
  prime(nextSeq: number): void {
    this.expected = Number.isInteger(nextSeq) && nextSeq > 0 ? nextSeq : 1;
  }

  /** 等所有排队中的写入落盘（结算前必调）。 */
  async drain(): Promise<void> {
    await this.flushPending();
  }

  async read(): Promise<JournalRecord[]> {
    const lines = await readLines(this.file);
    const records: JournalRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as JournalRecord);
      } catch {
        break; // 撕裂行：读取侧同样只认最长良前缀
      }
    }
    return records;
  }

  /**
   * 截断至最长良前缀，返回丢弃记账。文件原子替换，原内容在替换成功前不动。
   */
  async truncateToGoodPrefix(): Promise<TruncationReport> {
    const lines = await readLines(this.file);
    const kept: string[] = [];
    for (const line of lines) {
      try {
        JSON.parse(line);
        kept.push(line);
      } catch {
        break;
      }
    }
    const dropped = lines.length - kept.length;
    if (dropped > 0) await replaceLinesAtomic(this.file, kept);
    // 文件换了，缓冲与游标必须跟着重算：留旧游标会把该落盘的行永远压在缓冲里。
    this.holding.clear();
    this.expected = 1;
    return { kept: kept.length, dropped };
  }
}
