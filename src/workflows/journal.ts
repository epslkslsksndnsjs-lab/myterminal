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

/** 一次写盘失败的记账：seq 是归位序号，launched 这类无序号行没有。 */
export type JournalWriteFailure = { readonly seq?: number; readonly cause: unknown };

/**
 * 账本写盘失败：调用方必须看见它，而不是拿到一个假的"已落盘"。
 *
 * 失败是粘的——除非走恢复出口 truncateToGoodPrefix()（重建账本），
 * 否则 drain() 每次调用都抛：一次没写进盘的行，绝不能在结算时被当成写过。
 */
export class JournalWriteError extends Error {
  readonly failures: readonly JournalWriteFailure[];

  constructor(message: string, failures: readonly JournalWriteFailure[] = []) {
    super(message);
    this.name = 'JournalWriteError';
    this.failures = [...failures];
  }
}

/** 缓冲里等前一路的一行：落盘成败分别兑现到调用方手里。 */
type HeldLine = { line: string; resolve: () => void; reject: (error: unknown) => void };

export class Journal {
  /** 单写者锁：append 串行化，避免并发路交错写坏行边界。 */
  private tail: Promise<unknown> = Promise.resolve();
  /** 归位游标：下一条应落盘的 admission 序号。 */
  private expected = 1;
  /** 乱序归位缓冲：先完成的路等着前一路，账才按调用序连续。 */
  private readonly holding = new Map<number, HeldLine>();
  /** 已发生的写盘失败（粘性）：drain() 据此拒绝，绝不假报成功。 */
  private readonly failures: JournalWriteFailure[] = [];

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

  private enqueue(line: string, seq?: number): Promise<void> {
    const next = this.tail.then(() => appendLine(this.file, line));
    // 失败当场记账，一次都不吞：这一行的调用方从返回的 promise 上看到原始 IO 错误，
    // 结算侧从 drain() 看到汇总。锁链自身仍不因单点失败而断（后续行照写），
    // 但"少了一行"这件事留在 failures 里，直到恢复出口重建账本。
    next.catch((error: unknown) => {
      this.failures.push({ ...(seq === undefined ? {} : { seq }), cause: error });
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  /**
   * 按 admission 序归位地记一行（seq = 调用序，1 起）。
   *
   * 前面还有没结算的路时，这一行先在缓冲里等着——完成顺序绝不改写账本顺序。
   * 返回的 promise 在该行真正落盘时兑现；调用方按 fire-and-forget 处理，
   * 结算前 flushPending() 把等不到口的行升序补齐（不静默丢）。
   * 写盘失败时这一行以原始 IO 错误拒绝，并记进 drain() 的汇总（见 JournalWriteError）。
   */
  appendOrdered(seq: number, record: JournalInput): Promise<void> {
    if (!Number.isInteger(seq) || seq < 1) {
      return Promise.reject(new TypeError(`journal sequence must be a positive integer; received: ${String(seq)}`));
    }
    if (seq < this.expected) {
      // 重放的旧序号（同一路的第二张账）不再进链，直接落盘。
      return this.enqueue(this.lineFor(record, seq), seq);
    }
    const line = this.lineFor(record, seq);
    const persisted = new Promise<void>((resolve, reject) => {
      this.holding.set(seq, { line, resolve, reject });
      this.pumpOrdered();
    });
    // 只挂内部空分支把"已处理"标上，fire-and-forget 场景不至于因未处理拒绝打断进程；
    // 调用方拿到的仍是同一个会拒绝的 promise，失败一次都不会被吞掉。
    void persisted.catch(() => undefined);
    return persisted;
  }

  /** 把能连续的行依次落盘（缺口留在缓冲里等）。 */
  private pumpOrdered(): void {
    while (this.holding.has(this.expected)) {
      const seq = this.expected;
      const held = this.holding.get(seq) as HeldLine;
      this.holding.delete(seq);
      this.expected = seq + 1;
      // 成败各自归位：写盘失败以原始 IO 错误拒给这一行的调用方，绝不 resolve 掉了事。
      void this.enqueue(held.line, seq).then(() => held.resolve(), (error: unknown) => held.reject(error));
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
      const held = this.holding.get(seq) as HeldLine;
      this.holding.delete(seq);
      this.expected = Math.max(this.expected, seq + 1);
      void this.enqueue(held.line, seq).then(() => held.resolve(), (error: unknown) => held.reject(error));
    }
    // 先把排队中的写入全部落到底（含失败），再汇总：不许在还有写在飞时就报结果。
    await this.tail;
    this.throwIfWriteFailed();
  }

  /** 已发生的写盘失败（观测面，drain() 抛的就是这些）。 */
  writeFailures(): readonly JournalWriteFailure[] {
    return [...this.failures];
  }

  /** 写盘失败汇总：有失败就抛，粘到恢复出口重建账本为止。 */
  private throwIfWriteFailed(): void {
    if (this.failures.length === 0) return;
    const first = this.failures[0] as JournalWriteFailure;
    const where = first.seq === undefined ? 'unordered record' : `seq ${first.seq}`;
    const cause = first.cause instanceof Error ? first.cause.message : String(first.cause);
    throw new JournalWriteError(
      `journal write failed: ${this.failures.length} line(s) not persisted (first: ${where}: ${cause}); the account is incomplete — truncate to good prefix before resuming`,
      this.failures,
    );
  }

  /** 续跑入参：已有几路记账，游标就从几 + 1 起。 */
  prime(nextSeq: number): void {
    this.expected = Number.isInteger(nextSeq) && nextSeq > 0 ? nextSeq : 1;
  }

  /** 等所有排队中的写入落盘（结算前必调）。有写盘失败则抛 JournalWriteError。 */
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
    // A syntactically valid JSONL suffix is not necessarily a valid journal:
    // if seq N failed to persist but seq N+1 did, accepting N+1 would silently
    // erase the evidence of the missing admission. Preserve only the prefix
    // before the earliest failed ordered sequence. An unordered write failure
    // (most importantly the initial launched record) has no safe sequence
    // boundary, so conservatively discard the whole file.
    const hasUnorderedFailure = this.failures.some((failure) => failure.seq === undefined);
    const failedSeqs = this.failures
      .map((failure) => failure.seq)
      .filter((seq): seq is number => seq !== undefined);
    const earliestFailedSeq = failedSeqs.length > 0 ? Math.min(...failedSeqs) : undefined;
    if (!hasUnorderedFailure) {
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as { seq?: unknown };
          if (earliestFailedSeq !== undefined && typeof record.seq === 'number' && record.seq >= earliestFailedSeq) {
            break;
          }
          kept.push(line);
        } catch {
          break;
        }
      }
    }
    const dropped = lines.length - kept.length;
    if (dropped > 0) await replaceLinesAtomic(this.file, kept);
    // 文件换了，缓冲与游标必须跟着重算：留旧游标会把该落盘的行永远压在缓冲里。
    const pending = [...this.holding.values()];
    this.holding.clear();
    this.expected = 1;
    // 账本已重建（最长良前缀可查），此前的写盘失败不再适用于新账。
    this.failures.length = 0;
    // 缓冲里没落盘的行随截断一起判死：调用方必须拿到拒绝，不许无限等一个不会来的落盘。
    for (const held of pending) {
      held.reject(new JournalWriteError('journal truncated to good prefix before this line was persisted; the line was discarded'));
    }
    return { kept: kept.length, dropped };
  }
}
