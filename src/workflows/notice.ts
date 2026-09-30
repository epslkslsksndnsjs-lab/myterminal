import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createExclusive, readJson, writeJsonAtomic } from './atomic.js';
import { readMachineRecord } from './schema.js';
import { SCHEMA_VERSION, type WorkflowStatus } from './schema.js';
import type { RunPaths } from './paths.js';

/**
 * 终态消息与 durable outbox——投递纪律的物理形态（ADR-0052 §15）。
 *
 * 三条纪律：
 *   1. 至少一次投递 + 消费侧去重：发送侧做不到 exactly-once（两将军），所以一切投递带
 *      内容键 `(runId, sha256)`，文件名即内容键——同键重投落同一文件，天然幂等；
 *   2. 先落盘再投递：通知原子写进 outbox/ 才试图投递，投成功才标 delivered；
 *      进程死在半路时"有标记、outbox 有未投项"就是排空趟的唯一判据；
 *   3. 首行 KV 是身份，不是排版：宁可不发也不裁身份段——去重键一旦是半截 sha，
 *      消费侧就会把同一份结果当两个。
 */

/** 通知体度量口径 = UTF-16 码元（照仓库既有 slice 口径，与码点数不同）。 */
export const MAX_NOTICE_CODE_UNITS = 200;
/** 截断标记计入总长（照仓库既有截断惯例）。 */
export const NOTICE_TRUNCATION_MARKER = '…';
const KV_TAG = '[workflow]';
/** settled-notice 的压缩尾段：绝对路径装不下时，用公共约定复原它（无路径换算层，布局即约定）。 */
export function canonicalIndexTail(runId: string): string {
  return `${NOTICE_TRUNCATION_MARKER}/workflows/runs/${runId}/index.json`;
}

export type NoticeKind = 'settled-notice' | 'digest';

export function buildKvFirstLine(input: { kind: NoticeKind; runId: string; sha256: string }): string {
  return `${KV_TAG} kind=${input.kind} runId=${input.runId} sha256=${input.sha256}`;
}

export type SettledNoticeDraft = {
  runId: string;
  status: WorkflowStatus;
  /** = 快照文件字节哈希（票面口径：settled-notice 的 sha256 走快照，digest 走 digest 文件）。 */
  sha256: string;
  indexPath: string;
  succeeded: number;
  total: number;
};

export type NoticeBody = { ok: true; body: string } | { ok: false; reason: 'kv-too-long'; message: string };

/** 按码元切，不留孤立高位。 */
function cutCodeUnits(value: string, limit: number): string {
  if (limit >= value.length) return value;
  const keep = Math.max(0, limit - NOTICE_TRUNCATION_MARKER.length);
  const last = value.charCodeAt(keep - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep;
  return `${value.slice(0, end)}${NOTICE_TRUNCATION_MARKER}`;
}

/**
 * settled-notice 通知体：首行 KV + 第二行"status X/Y index=<路径>"。
 * 超长路径压缩阶梯（随技能模板锁定，逐级降档、每级都重算是否装得下）：
 *   ① 索引绝对路径 ② 公共约定规范尾段 ③ 去掉 X/Y 读数 ④ 按码元硬切第二行。
 * 身份段（首行）不参与压缩：装不下即拒发（fail-closed），盘面与索引仍是真相源。
 */
export function buildSettledNotice(draft: SettledNoticeDraft): NoticeBody {
  const kv = buildKvFirstLine({ kind: 'settled-notice', runId: draft.runId, sha256: draft.sha256 });
  const room = MAX_NOTICE_CODE_UNITS - kv.length - 1;
  if (room < 1) {
    return {
      ok: false,
      reason: 'kv-too-long',
      message: `The ${kv.length}-code-unit KV header leaves no room inside the ${MAX_NOTICE_CODE_UNITS}-code-unit notice limit; the notice is not sent.`,
    };
  }
  const tail = canonicalIndexTail(draft.runId);
  const counts = `${draft.succeeded}/${draft.total}`;
  const ladder = [
    `${draft.status} ${counts} index=${draft.indexPath}`,
    `${draft.status} ${counts} index=${tail}`,
    `${draft.status} index=${tail}`,
  ];
  const line = ladder.find((candidate) => candidate.length <= room) ?? cutCodeUnits(ladder[ladder.length - 1], room);
  return { ok: true, body: `${kv}\n${line}` };
}

/** 文件字节哈希——去重键的另一半由内容算出，不由谁声明。 */
export async function sha256File(file: string): Promise<string> {
  const bytes = await readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

/** 缺件 = undefined（"没有摘要"是事实）；其他 IO 错误原样抛出，不吞成"没有"。 */
export async function sha256FileIfPresent(file: string): Promise<string | undefined> {
  try {
    return await sha256File(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export type OutboxDraft = {
  kind: NoticeKind;
  runId: string;
  sha256: string;
  status?: WorkflowStatus;
  /** 索引绝对路径：通知体只是指针，全量在索引 / 摘要里。 */
  index: string;
  body: string;
  at: string;
};

export type OutboxItem = OutboxDraft & {
  schemaVersion: number;
  delivered: boolean;
  deliveredAt?: string;
  attempts: number;
};

export type OutboxPut = { created: boolean; item: OutboxItem };

/** 内容键即文件名：同键同文件，重投落回同一项。 */
export function outboxFileName(item: { kind: NoticeKind; sha256: string }): string {
  return `${item.kind}-${item.sha256}.json`;
}

function toItem(draft: OutboxDraft): OutboxItem {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: draft.kind,
    runId: draft.runId,
    sha256: draft.sha256,
    ...(draft.status !== undefined ? { status: draft.status } : {}),
    index: draft.index,
    body: draft.body,
    at: draft.at,
    delivered: false,
    attempts: 0,
  };
}

/** 写-if-absent：已存在即原样回读（已投递的位不许被重投抹回未投递）。 */
export async function putNotice(run: RunPaths, draft: OutboxDraft): Promise<OutboxPut> {
  const item = toItem(draft);
  const file = path.join(run.outboxDir, outboxFileName(item));
  const created = await createExclusive(file, `${JSON.stringify(item, null, 2)}\n`);
  if (created) return { created: true, item };
  const raw = await readJson(file);
  // 排空趟可能刚抢在中间读走又删掉：这里补写回去，created 才算得诚实。
  if (raw === undefined) {
    await writeJsonAtomic(file, item);
    return { created: true, item };
  }
  return { created: false, item: normalizeOutboxItem(raw) };
}

export async function markNoticeDelivered(run: RunPaths, item: OutboxItem, at: string): Promise<OutboxItem> {
  const next: OutboxItem = { ...item, delivered: true, deliveredAt: at, attempts: item.attempts + 1 };
  await writeJsonAtomic(path.join(run.outboxDir, outboxFileName(next)), next);
  return next;
}

/** 未投递项即排空趟的工作集（判据：有终态标记且 outbox 有未 delivered 项）。 */
export async function readOutbox(run: RunPaths): Promise<OutboxItem[]> {
  let names: string[];
  try {
    names = await readdir(run.outboxDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const items: OutboxItem[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const raw = await readJson(path.join(run.outboxDir, name));
    if (raw === undefined) continue;
    items.push(normalizeOutboxItem(raw));
  }
  return items;
}

/** 读侧过版本闸：比读者更新的不兼容版本 fail-closed 拒读，不半读半猜。 */
export function normalizeOutboxItem(raw: unknown): OutboxItem {
  const record = readMachineRecord<{ schemaVersion?: number }>(raw, SCHEMA_VERSION, 'outbox item');
  const value = record as unknown as Record<string, unknown>;
  return {
    schemaVersion: record.schemaVersion ?? SCHEMA_VERSION,
    kind: value.kind === 'digest' ? 'digest' : 'settled-notice',
    runId: typeof value.runId === 'string' ? value.runId : '',
    sha256: typeof value.sha256 === 'string' ? value.sha256 : '',
    ...(typeof value.status === 'string' ? { status: value.status as WorkflowStatus } : {}),
    index: typeof value.index === 'string' ? value.index : '',
    body: typeof value.body === 'string' ? value.body : '',
    at: typeof value.at === 'string' ? value.at : '',
    delivered: value.delivered === true,
    ...(typeof value.deliveredAt === 'string' ? { deliveredAt: value.deliveredAt } : {}),
    attempts: typeof value.attempts === 'number' && Number.isFinite(value.attempts) ? value.attempts : 0,
  };
}
