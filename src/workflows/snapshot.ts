import { readJson, writeJsonAtomic } from './atomic.js';
import { isTerminal, type RunIndex, type RunSnapshot, SCHEMA_VERSION } from './schema.js';
import { normalizeIndex } from './run-index.js';

/**
 * 终态快照——只在终态写一次。
 * 非终态调用直接抛：快照是"这一 run 的定论"，活跃期写它等于制造假终态。
 */

export async function writeSnapshot(file: string, index: RunIndex): Promise<RunSnapshot> {
  if (!isTerminal(index.status)) throw new Error(`Cannot snapshot a run that is not terminal (status: ${index.status}).`);
  const snapshot: RunSnapshot = { ...index, schemaVersion: SCHEMA_VERSION };
  await writeJsonAtomic(file, snapshot);
  return snapshot;
}

export async function readSnapshot(file: string, readerVersion: number = SCHEMA_VERSION): Promise<RunSnapshot | undefined> {
  const raw = await readJson(file);
  if (raw === undefined) return undefined;
  const index = normalizeIndex(raw, readerVersion);
  if (!isTerminal(index.status)) throw new Error(`Snapshot is not terminal (status: ${index.status}); refusing to read.`);
  return { ...index, schemaVersion: SCHEMA_VERSION };
}

export async function hasSnapshot(file: string): Promise<boolean> {
  return (await readJson(file)) !== undefined;
}
