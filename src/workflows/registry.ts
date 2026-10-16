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

/** 按 runId 更新一条（不存在则追加），返回写入后的全量。 */
export async function upsertRegistry(file: string, entry: RegistryEntry): Promise<RunRegistry> {
  const current = await readRegistry(file);
  const index = current.runs.findIndex((item) => item.runId === entry.runId);
  const runs = index >= 0 ? current.runs.map((item, i) => (i === index ? entry : item)) : [...current.runs, entry];
  return await writeRegistry(file, { schemaVersion: SCHEMA_VERSION, runs });
}
