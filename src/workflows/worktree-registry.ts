import path from 'node:path';
import { assertRunId } from './ids.js';
import { assertWorktreeId } from './paths.js';
import { readJson, writeJsonAtomic } from './atomic.js';
import { readMachineRecord, withSchemaVersion, SCHEMA_VERSION } from './schema.js';

/**
 * worktree 登记簿——创建即登记（ADR-0052 §11④①），机器件、版本化、单写者。
 *
 * 三条纪律：
 *   1. 登记落盘先于建工作树：建行失败要把条目收回到 removed，绝不能留下"盘上有件、账上无名"
 *      或"账上有名、盘上无件"的悬空态；配额与面板都读这本账，账是保留项的唯一权威；
 *   2. 单写者队列：并发 provision / release 各自改自己的条目，落盘串行进行，
 *      两次改写不会互相盖掉；
 *   3. 版本超前即拒读（fail-closed），同 id 重复登记即拒——静默覆盖会把两件不同的活记成一件。
 */

/** 生命周期四态：登记 → 在建 → 生效 → 保留或已删。 */
export const WORKTREE_STATES = ['starting', 'active', 'preserved', 'removed'] as const;
export type WorktreeState = (typeof WORKTREE_STATES)[number];

export type WorktreeEntry = {
  id: string;
  runId: string;
  dispatchId: string;
  label: string;
  path: string;
  branch: string;
  state: WorktreeState;
  /** 登记时刻（ISO，来自注入时钟）。 */
  at: string;
  /** 最后一次状态变化时刻。 */
  updatedAt?: string;
  /** 保留项的字节数（配额计数口径）；非保留态不测。 */
  bytes?: number;
  /** 归档后的 bundle 路径；未归档不造字段。 */
  archiveFile?: string;
};

export type WorktreeRegistryFile = { schemaVersion: number; entries: WorktreeEntry[] };

/** 一路一件的 id = runId + 槽位：同一路的重试共享它，别的 run 撞不上它。 */
export function worktreeIdFor(runId: string, dispatchId: string): string {
  assertRunId(runId);
  if (!/^d\d{4}$/.test(dispatchId)) throw new Error(`worktree id needs a d#### dispatch slot; received: ${String(dispatchId)}`);
  return assertWorktreeId(`${runId}-${dispatchId}`);
}

export type RegistryDeps = { file: string };

export class WorktreeRegistry {
  readonly file: string;
  private items = new Map<string, WorktreeEntry>();
  private loaded = false;
  /** 单写者队列：任何一次改写都排在上一次之后。 */
  private writes: Promise<void> = Promise.resolve();

  constructor(deps: RegistryDeps) {
    this.file = deps.file;
  }

  /** 读盘（幂等）；文件不存在 = 空账，版本超前 = 拒。 */
  async load(): Promise<{ schemaVersion: number; entries: WorktreeEntry[] }> {
    const raw = await readJson(this.file);
    this.items = new Map();
    let schemaVersion = SCHEMA_VERSION;
    if (raw !== undefined) {
      const record = readMachineRecord<WorktreeRegistryFile>(raw, SCHEMA_VERSION, 'worktree registry');
      schemaVersion = record.schemaVersion;
      for (const entry of Array.isArray(record.entries) ? record.entries : []) {
        if (typeof entry?.id === 'string') this.items.set(entry.id, entry);
      }
    }
    this.loaded = true;
    return { schemaVersion, entries: this.itemsInOrder() };
  }

  private ensureLoaded(): void {
    if (!this.loaded) throw new Error('The worktree registry must be loaded before it is read or written.');
  }

  private itemsInOrder(): WorktreeEntry[] {
    return [...this.items.values()].sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at)));
  }

  entries(): WorktreeEntry[] {
    this.ensureLoaded();
    return this.itemsInOrder();
  }

  entry(id: string): WorktreeEntry | undefined {
    this.ensureLoaded();
    return this.items.get(id);
  }

  /** 创建即登记：先落盘再说。同 id 已存在即拒，不覆盖。 */
  async register(input: { id: string; runId: string; dispatchId: string; label?: string; path: string; branch: string; at: string }): Promise<WorktreeEntry> {
    this.ensureLoaded();
    assertWorktreeId(input.id);
    assertRunId(input.runId);
    if (this.items.has(input.id)) throw new Error(`worktree ${input.id} is already registered; registration is never overwritten silently.`);
    const entry: WorktreeEntry = {
      id: input.id,
      runId: input.runId,
      dispatchId: input.dispatchId,
      label: input.label ?? input.dispatchId,
      path: path.resolve(input.path),
      branch: input.branch,
      state: 'starting',
      at: input.at,
    };
    this.items.set(entry.id, entry);
    await this.flush();
    return entry;
  }

  private async mutate(id: string, change: (entry: WorktreeEntry) => WorktreeEntry): Promise<void> {
    this.ensureLoaded();
    const current = this.items.get(id);
    if (!current) throw new Error(`worktree ${id} is not registered.`);
    this.items.set(id, change(current));
    return this.flush();
  }

  setState(id: string, state: WorktreeState, at: string): Promise<void> {
    return this.mutate(id, (entry) => ({ ...entry, state, updatedAt: at }));
  }

  setBytes(id: string, bytes: number): Promise<void> {
    return this.mutate(id, (entry) => ({ ...entry, bytes: Math.max(0, Math.floor(bytes)) }));
  }

  markArchived(id: string, archiveFile: string, at: string): Promise<void> {
    return this.mutate(id, (entry) => ({ ...entry, state: 'removed', archiveFile, updatedAt: at }));
  }

  /** 测试缝：把登记时刻往前拨，用例才能真的走到"超期"那一臂。 */
  shiftAge(id: string, ageMs: number): Promise<void> {
    return this.mutate(id, (entry) => ({ ...entry, at: new Date(Date.parse(entry.at) - ageMs).toISOString() }));
  }

  /** 保留项 = 有改动未处置，配额与面板都只吃这一档。 */
  preserved(): WorktreeEntry[] {
    return this.itemsInOrder().filter((entry) => entry.state === 'preserved');
  }

  private flush(): Promise<void> {
    const snapshot = { entries: this.itemsInOrder() };
    this.writes = this.writes.then(() => writeJsonAtomic(this.file, withSchemaVersion(snapshot))).catch(() => undefined);
    return this.writes;
  }
}
