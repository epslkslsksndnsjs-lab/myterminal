import { readJson, writeJsonAtomic } from './atomic.js';
import { isTerminal, readWithRenameWindow, withDualWrite, RENAMED_FIELDS, type FieldRename, type RunIndex, type RunSnapshot, SCHEMA_VERSION } from './schema.js';
import { normalizeIndex } from './run-index.js';

/**
 * 终态快照——只在终态写一次。
 * 非终态调用直接抛：快照是"这一 run 的定论"，活跃期写它等于制造假终态。
 */

export async function writeSnapshot(file: string, index: RunIndex, renames: readonly FieldRename[] = RENAMED_FIELDS.snapshot): Promise<RunSnapshot> {
  if (!isTerminal(index.status)) throw new Error(`Cannot snapshot a run that is not terminal (status: ${index.status}).`);
  const snapshot: RunSnapshot = { ...index, schemaVersion: SCHEMA_VERSION };
  await writeJsonAtomic(file, withDualWrite(snapshot, renames));
  return snapshot;
}

export async function readSnapshot(file: string, readerVersion: number = SCHEMA_VERSION, renames: readonly FieldRename[] = RENAMED_FIELDS.snapshot): Promise<RunSnapshot | undefined> {
  const raw = await readJson(file);
  if (raw === undefined) return undefined;
  // 快照与索引同形，改名窗口按快照自己那张表走（两表可以不同节奏出清）。
  const index = normalizeIndex(raw, readerVersion, renames);
  if (!isTerminal(index.status)) throw new Error(`Snapshot is not terminal (status: ${index.status}); refusing to read.`);
  return { ...index, schemaVersion: SCHEMA_VERSION };
}

export async function hasSnapshot(file: string): Promise<boolean> {
  return (await readJson(file)) !== undefined;
}
