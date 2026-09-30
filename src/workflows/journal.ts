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

  constructor(private readonly file: string) {}

  static open(file: string): Journal {
    return new Journal(file);
  }

  /** 记账一行。返回已排队的写盘 promise（fire-and-forget 场景可不安 await）。 */
  append(record: JournalInput): Promise<void> {
    const line = JSON.stringify({ version: SCHEMA_VERSION, ...record });
    const next = this.tail.then(() => appendLine(this.file, line));
    // 锁链自身永不因单点失败而断：后续行仍要写，失败由调用方从 drain() 观察。
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** 等所有排队中的写入落盘（结算前必调）。 */
  async drain(): Promise<void> {
    await this.tail;
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
    return { kept: kept.length, dropped };
  }
}
