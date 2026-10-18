import path from 'node:path';

import { readJson, writeJsonAtomic } from './atomic.js';
import {
  isTerminal,
  readWithRenameWindow,
  withDualWrite,
  MAX_RETAINED_TERMINAL_RUNS,
  RENAMED_FIELDS,
  readMachineRecord,
  type FieldRename,
  type RegistryEntry,
  type RunRegistry,
  SCHEMA_VERSION,
} from './schema.js';

/**
 * run 注册表：活跃 run 全留，终态 run 保留最近 10 条。
 * 归属字段（ownerSessionId）随记录一起落盘——"run 是谁的"由它锚定。
 */

function normalize(raw: unknown, readerVersion: number = SCHEMA_VERSION, renames: readonly FieldRename[] = RENAMED_FIELDS.registry): RunRegistry {
  const record = readMachineRecord<RunRegistry>(raw, readerVersion, 'registry.json');
  const value = record as unknown as Record<string, unknown>;
  const runs = Array.isArray(value.runs) ? value.runs : [];
  return {
    schemaVersion: record.schemaVersion,
    runs: runs
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      // 改名窗口按条目走：status 这类字段活在每条记录上。
      .map((item) => readWithRenameWindow(item, renames).value)
      .map((item) => ({
        runId: typeof item.runId === 'string' ? item.runId : '',
        status: (typeof item.status === 'string' ? item.status : 'running') as RegistryEntry['status'],
        ownerSessionId: typeof item.ownerSessionId === 'string' ? item.ownerSessionId : '',
        startedAt: typeof item.startedAt === 'string' ? item.startedAt : '',
        ...(typeof item.endedAt === 'string' ? { endedAt: item.endedAt } : {}),
      })),
  };
}

export async function readRegistry(file: string, readerVersion: number = SCHEMA_VERSION, renames: readonly FieldRename[] = RENAMED_FIELDS.registry): Promise<RunRegistry> {
  const raw = await readJson(file);
  if (raw === undefined) return { schemaVersion: SCHEMA_VERSION, runs: [] };
  return normalize(raw, readerVersion, renames);
}

/** 写入并按保留数裁剪：活跃条目永不裁剪，终态只留最近 MAX_RETAINED_TERMINAL_RUNS 条。 */
export async function writeRegistry(file: string, registry: RunRegistry, renames: readonly FieldRename[] = RENAMED_FIELDS.registry): Promise<RunRegistry> {
  const active = registry.runs.filter((entry) => !isTerminal(entry.status));
  const terminal = registry.runs
    .filter((entry) => isTerminal(entry.status))
    .sort((a, b) => (a.endedAt ?? a.startedAt).localeCompare(b.endedAt ?? b.startedAt))
    .slice(-MAX_RETAINED_TERMINAL_RUNS);
  const next: RunRegistry = { schemaVersion: SCHEMA_VERSION, runs: [...active, ...terminal] };
  await writeJsonAtomic(file, { ...next, runs: next.runs.map((entry) => withDualWrite(entry, renames)) });
  return next;
}

/**
 * 每文件的单写者队列（PER-02）：upsert 的读-改-写整段串行。
 *
 * 原子写只保证"单次写入不撕裂"，管不到"读到旧值"：两个并发 upsert 各自读到同一份旧注册表，
 * 后写者把先写者刚追加的条目整片盖掉。队列补的就是这一段——同一文件的读-改-写按登记顺序排队。
 *
 * 键取 resolve 后的路径：同一文件的不同写法（相对/绝对、带 `.` 段）落进同一条队列。
 * 队列游标只记"轮到没轮到"，不记成败——前一手失败不毒化后来者，也不会留下未处理的拒绝。
 */
const registryWriteChain = new Map<string, Promise<void>>();

function enqueueRegistryWrite<T>(file: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = registryWriteChain.get(key) ?? Promise.resolve();
  // then(task, task)：前一手无论成败都轮到本手，拒绝不沿队列传播。
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  registryWriteChain.set(key, settled);
  void settled.then(() => {
    // 只有自己仍是队尾时才摘表：排队期间新来者登记的游标不能被前人删掉。
    if (registryWriteChain.get(key) === settled) registryWriteChain.delete(key);
  });
  return run;
}

/** 按 runId 更新一条（不存在则追加），返回写入后的全量。 */
export async function upsertRegistry(file: string, entry: RegistryEntry): Promise<RunRegistry> {
  return await enqueueRegistryWrite(file, async () => {
    const current = await readRegistry(file);
    const index = current.runs.findIndex((item) => item.runId === entry.runId);
    const runs = index >= 0 ? current.runs.map((item, i) => (i === index ? entry : item)) : [...current.runs, entry];
    return await writeRegistry(file, { schemaVersion: SCHEMA_VERSION, runs });
  });
}
