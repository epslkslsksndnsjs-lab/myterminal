import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { statfs } from 'node:fs/promises';

import { ensureDir } from './atomic.js';
import { isWithinBoundary } from './tool-boundary.js';
import { WorktreeRegistry, worktreeIdFor, type WorktreeEntry } from './worktree-registry.js';
import { directoryBytes, evaluateQuota, preservedTotals, type QuotaVerdict } from './worktree-quota.js';
import {
  addWorktree,
  bundleWorktreeBranch,
  checkGitAvailable,
  hasUncommittedChanges,
  hasUnmergedWorktreeCommits,
  isGitRepository,
  isRegisteredLinkedWorktree,
  registeredWorktreeBranch,
  removeWorktree,
  repoTopLevel,
  worktreeBranchFor,
  worktreeHasWork,
  type GitRunner,
} from './worktree-git.js';

/**
 * 写必隔离的执行体（ADR-0052 §11 / §12，偏离登记簿⑥）。
 *
 * 五条纪律：
 *   1. 生命周期 = per-dispatch：一路一件，重试共享同一件；被打断后重跑出一件新的，
 *      旧件按"有改动即保留"处置，绝不自动续用；
 *   2. 拒绝发生在任何资源副作用之前：git 不可用 / 不是仓库 / 脏树 / worktree 套 worktree /
 *      配额到线，一条都不落地目录、一条都不登记；
 *   3. 竞态纪律：创建即登记（账先于树）、删除加 fence（先原子重命名进 trash 再删）、
 *      创建与清理走同一条串行列、每条 git 命令都关自动 gc；
 *   4. 磁盘上界 = 拒新增，绝不删旧：软阈值只告警，硬上限只拒建，唯一减法是人来合并或丢弃；
 *   5. 判不准一律按"保留"：任何派生检查抛错都不得让这一件被自动删掉（宁留孤儿不丢工作）。
 *
 * git / 字节度量 / 磁盘可用量三处都可整体假化：单元用例喂假 git，
 * 端到端用例用真 git——同一套判定代码跑两边。
 */

/** fence 中转位与归档位（都在隔离区根下，不进 git 视野）。 */
export const WORKTREE_TRASH_DIR = '.trash';
export const WORKTREE_ARCHIVE_DIR = 'archive';

/** 磁盘上界与保留项的动作各有具名审计（丢弃与归档是"唯一减法 = 人"的两条腿）。 */
export type WorktreeAuditAction = 'worktree-quota-warn' | 'worktree-quota-blocked' | 'worktree_discard' | 'worktree_archive';

export type WorktreeAuditEvent = {
  action: WorktreeAuditAction;
  runId: string;
  actor: string;
  result: string;
  reasons?: string[];
  detail?: string;
};

export type WorktreeQuotaGates = { keepQuotaCount: number; keepQuotaBytes: number };
export type WorktreeClock = { now: () => number; iso: () => string };

export type WorktreeServiceDeps = {
  /** 隔离区根：<managedRoot>/worktrees。 */
  worktreesRoot: string;
  /** git 命令的落点；缺省由 workspaceDir 反推仓库顶层。 */
  workspaceDir?: string;
  /** 仓库顶层覆盖位（测试与非常规布局）。 */
  repoRoot?: string;
  registryFile?: string;
  git?: GitRunner;
  gates?: WorktreeQuotaGates;
  /** 磁盘可用字节（默认 statfs 实读）；注入它才走得到"磁盘 < 2GB"那一臂。 */
  freeBytes?: () => number | Promise<number>;
  /** 单件字节口径（默认目录实量）。 */
  measureBytes?: (worktreePath: string) => number;
  clock?: WorktreeClock;
  audit?: (event: WorktreeAuditEvent) => void;
};

export type Provisioned =
  | { ok: true; id: string; path: string; branch: string; reused: boolean }
  | { ok: false; reason: string; message: string };

export type Released = { kept: boolean; id: string; path: string; branch: string; bytes?: number; branchPreserved?: boolean };

/** pin 的两种下场：拿到一块已注册的现成件，或带着具名拒因回来（不建、不删、不计配额）。 */
export type Pinned = { ok: true; path: string; branch: string } | { ok: false; reason: string; message: string };

const DAY_MS = 24 * 60 * 60 * 1000;

export class WorktreeService {
  readonly worktreesRoot: string;
  readonly registry: WorktreeRegistry;
  private readonly workspaceDir: string;
  private readonly repoRootOverride?: string;
  private readonly git: GitRunner;
  private readonly gates: WorktreeQuotaGates;
  private readonly freeBytes: () => number | Promise<number>;
  private readonly measureBytes: (worktreePath: string) => number;
  private readonly clock: WorktreeClock;
  private readonly audit?: (event: WorktreeAuditEvent) => void;
  private loaded = false;
  /** 创建与清理共用的一条串行列（§11③：单写者）。 */
  private serial: Promise<unknown> = Promise.resolve();
  private repoRootCache?: string;

  constructor(deps: WorktreeServiceDeps) {
    this.worktreesRoot = path.resolve(deps.worktreesRoot);
    this.workspaceDir = deps.workspaceDir ?? process.cwd();
    this.repoRootOverride = deps.repoRoot;
    this.registry = new WorktreeRegistry({ file: deps.registryFile ?? path.join(this.worktreesRoot, 'registry.json') });
    this.gates = deps.gates ?? { keepQuotaCount: 50, keepQuotaBytes: 5 * 1024 * 1024 * 1024 };
    this.clock = deps.clock ?? { now: () => Date.now(), iso: () => new Date().toISOString() };
    this.audit = deps.audit;
    this.measureBytes = deps.measureBytes ?? directoryBytes;
    this.freeBytes = deps.freeBytes ?? (() => defaultFreeBytes(this.worktreesRoot));
    this.git = deps.git ?? spawnGit();
  }

  /** 读盘（重复调用重新取盘面真相）；任何一次操作前都会自动走到这里。 */
  async load(): Promise<void> {
    await this.registry.load();
    this.loaded = true;
  }

  /** 串行列入口：任何一步都排在上一步之后（并发创建不互踩登记与目录）。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.serial.then(task, task);
    this.serial = next.catch(() => undefined);
    return next;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /**
   * 建一路的隔离件。顺序即纪律：闸门（含配额）→ 登记 → 建树。
   * 任何一步不合都带具名拒因回来，且在登记之前一步都不留下目录或条目。
   */
  async provision(input: { runId: string; dispatchId: string; label?: string }): Promise<Provisioned> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const id = worktreeIdFor(input.runId, input.dispatchId);
      const existing = this.registry.entry(id);
      // 一路一件：重试拿到的是同一件（starting / active 都算还没收场）。
      if (existing && (existing.state === 'starting' || existing.state === 'active')) {
        return { ok: true, id, path: existing.path, branch: existing.branch, reused: true };
      }
      if (existing) {
        return { ok: false, reason: 'worktree-slot-reuse', message: `The worktree for ${id} was already ${existing.state} at ${existing.path}; a released slot is never rebuilt under the same id.` };
      }
      const refusal = await this.preflight(input.runId, id);
      if (refusal) return refusal;

      const location = this.locationFor(id);
      const branch = worktreeBranchFor(id);
      await this.registry.register({ id, runId: input.runId, dispatchId: input.dispatchId, ...(input.label ? { label: input.label } : {}), path: location, branch, at: this.clock.iso() });
      try {
        await ensureDir(path.dirname(location));
        await addWorktree(this.git, { repoRoot: await this.requiredRepoRoot(), worktreePath: location, branch });
      } catch (error) {
        // 建行失败：登记条目收掉，账上不能留一件不存在的活。
        await this.registry.setState(id, 'removed', this.clock.iso()).catch(() => undefined);
        return { ok: false, reason: 'worktree-create-failed', message: `git worktree add failed for ${id}: ${(error as Error).message}` };
      }
      await this.registry.setState(id, 'active', this.clock.iso());
      return { ok: true, id, path: location, branch, reused: false };
    });
  }

  /**
   * pin 到一块已注册的 linked worktree（externallyManaged）：不建、不删、不计配额，
   * 只把这一路的边界挪过去。
   *
   * 注册表是唯一权威门禁——"目录看起来像 worktree"不算数：`git worktree list` 里有它、
   * 且它自己答得出 `--git-dir`，两条同时成立才放行。目录被 rm 后重建为普通目录这一类伪装机
   * 会在活性探针那一步被拒。realpath 只求一次，门禁与返回用同一个对象（防验证后换向的 TOCTOU）。
   */
  async pin(input: { runId: string; dispatchId: string; workingDir: string }): Promise<Pinned> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      if (!(await checkGitAvailable(this.git))) {
        return { ok: false, reason: 'worktree-git-unavailable', message: 'git is not available on this machine, so a pinned worktree cannot be verified for this path.' };
      }
      const repoRoot = await this.resolveRepoRoot();
      if (!repoRoot) {
        return { ok: false, reason: 'worktree-not-a-repository', message: `The working directory is not a git repository, so workingDir ${JSON.stringify(input.workingDir)} cannot be pinned.` };
      }
      let pinned: string;
      try {
        pinned = fs.realpathSync(path.resolve(input.workingDir));
      } catch {
        return { ok: false, reason: 'worktree-not-registered', message: `workingDir ${JSON.stringify(input.workingDir)} does not exist, so it cannot be pinned.` };
      }
      if (!(await isRegisteredLinkedWorktree(this.git, repoRoot, pinned))) {
        return { ok: false, reason: 'worktree-not-registered', message: `${pinned} is not a registered linked worktree of ${repoRoot}: the git registry, not the directory's looks, decides.` };
      }
      return { ok: true, path: pinned, branch: await registeredWorktreeBranch(this.git, pinned) };
    });
  }

  /**
   * 资源副作用之前的全部闸门：git 可用性 → 是否仓库 → 嵌套 → 脏树 → 配额。
   * 每条都带具名拒因；判不准按"拒"处理。
   */
  private async preflight(runId: string, id: string): Promise<Provisioned | undefined> {
    if (!(await checkGitAvailable(this.git))) {
      return { ok: false, reason: 'worktree-git-unavailable', message: 'git is not available on this machine, so an isolated worktree cannot be created for this path.' };
    }
    const repoRoot = await this.resolveRepoRoot();
    if (!repoRoot) {
      return { ok: false, reason: 'worktree-not-a-repository', message: `The working directory is not a git repository, so isolation: "worktree" cannot be honoured for ${id}.` };
    }
    if (isWithinBoundary(repoRoot, this.worktreesRoot)) {
      return { ok: false, reason: 'worktree-nested', message: `${repoRoot} is already inside this module's isolation zone; a worktree cannot be created from a worktree.` };
    }
    if (!(await isGitRepository(this.git, repoRoot))) {
      return { ok: false, reason: 'worktree-not-a-repository', message: `git does not report ${repoRoot} as a work tree, so isolation: "worktree" cannot be honoured for ${id}.` };
    }
    if (await hasUncommittedChanges(this.git, repoRoot)) {
      return { ok: false, reason: 'worktree-dirty-tree', message: `${repoRoot} has uncommitted changes; a run cannot branch off a dirty tree (commit or stash them first).` };
    }
    const quota = await this.quotaVerdict();
    if (quota.level === 'warn') this.recordQuota('worktree-quota-warn', runId, 'warned', quota);
    if (quota.level === 'blocked') {
      this.recordQuota('worktree-quota-blocked', runId, 'blocked', quota);
      return {
        ok: false,
        reason: 'worktree-quota',
        message: `No new worktree may be created (${quota.reasons.join(', ')}): ${quota.preservedCount} kept worktrees of ${this.gates.keepQuotaCount} and ${quota.preservedBytes} kept bytes of ${this.gates.keepQuotaBytes}, with ${Math.floor(await this.freeBytes())} bytes free. Nothing old was deleted — dispose a kept worktree in the Worktrees panel.`,
      };
    }
    return undefined;
  }

  private async quotaVerdict(): Promise<QuotaVerdict> {
    const totals = preservedTotals(this.registry.entries());
    return evaluateQuota({ ...totals, freeBytes: await this.freeBytes(), gates: this.gates });
  }

  private recordQuota(action: WorktreeAuditAction, runId: string, result: string, quota: QuotaVerdict): void {
    this.audit?.({ action, runId, actor: runId, result, reasons: [...quota.reasons] });
  }

  private locationFor(id: string): string {
    return path.join(this.worktreesRoot, id);
  }

  private async resolveRepoRoot(): Promise<string | null> {
    if (this.repoRootCache) return this.repoRootCache;
    if (this.repoRootOverride) {
      this.repoRootCache = path.resolve(this.repoRootOverride);
      return this.repoRootCache;
    }
    const top = await repoTopLevel(this.git, this.workspaceDir);
    if (top) this.repoRootCache = top;
    return top;
  }

  /** 建树与清理都需要顶层目录；preflight 已经判过它存在，这里只把 null 挡成明确错误。 */
  private async requiredRepoRoot(): Promise<string> {
    const repoRoot = await this.resolveRepoRoot();
    if (!repoRoot) throw new Error('the repository root could not be resolved');
    return repoRoot;
  }

  /**
   * 收一路：clean 自动删，有改动保留并回报 path + branch。
   * 判"有活"与销毁用同一个谓词（worktreeHasWork），再加未合并提交那一半；
   * 任一边抛错都按保留处理。
   */
  async release(id: string, options: { hasWork?: boolean | (() => boolean | Promise<boolean>) } = {}): Promise<Released> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const entry = this.requireEntry(id);
      const kept = await this.hasWorkInside(entry, options.hasWork);
      if (kept) return await this.preserve(entry);
      if (!(await this.fenceAway(entry.path, id))) return await this.preserve(entry);
      const removed = await removeWorktree(this.git, { repoRoot: await this.requiredRepoRoot(), worktreePath: entry.path, branch: entry.branch, deleteBranch: true });
      await this.dropFenced(id);
      await this.registry.setState(id, 'removed', this.clock.iso());
      return { kept: false, id, path: entry.path, branch: entry.branch, ...(removed.branchPreserved ? { branchPreserved: true } : {}) };
    });
  }

  private async hasWorkInside(entry: WorktreeEntry, override: boolean | (() => boolean | Promise<boolean>) | undefined): Promise<boolean> {
    if (typeof override === 'boolean') return override;
    if (override) {
      try {
        return await override();
      } catch {
        return true;
      }
    }
    try {
      if (!fs.existsSync(entry.path)) return false;
      const [dirty, ahead] = await Promise.all([
        worktreeHasWork(this.git, entry.path),
        hasUnmergedWorktreeCommits(this.git, { repoRoot: await this.requiredRepoRoot(), branch: entry.branch }),
      ]);
      return dirty || ahead;
    } catch {
      return true;
    }
  }

  private async preserve(entry: WorktreeEntry): Promise<Released> {
    await this.registry.setState(entry.id, 'preserved', this.clock.iso());
    const bytes = this.measureBytes(entry.path);
    await this.registry.setBytes(entry.id, bytes);
    return { kept: true, id: entry.id, path: entry.path, branch: entry.branch, bytes };
  }

  /**
   * fence：先原子重命名进 trash，再谈删除——clean 检查与删除之间不留窗口。
   * 重命名打不出去就不删（残活进程还在往里写，或文件系统另有说法）。
   */
  private async fenceAway(worktreePath: string, id: string): Promise<boolean> {
    const trash = path.join(this.worktreesRoot, WORKTREE_TRASH_DIR);
    try {
      await ensureDir(trash);
      fs.renameSync(worktreePath, path.join(trash, id));
      return true;
    } catch {
      return false;
    }
  }

  private async dropFenced(id: string): Promise<void> {
    await fs.promises.rm(path.join(this.worktreesRoot, WORKTREE_TRASH_DIR, id), { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * 唯一减法 = 人：面板上的丢弃，审计留痕。
   * 分支没合并时 git 会拒删分支，那条留下的分支就是恢复线索。
   */
  async discard(id: string, actor: string): Promise<{ ok: true; path: string; branch: string } | { ok: false; reason: string; message: string }> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const entry = this.registry.entry(id);
      if (!entry) {
        this.audit?.({ action: 'worktree_discard', runId: id, actor, result: 'not-found' });
        return { ok: false, reason: 'worktree-not-found', message: `No worktree is registered under ${id}.` };
      }
      if (entry.state !== 'preserved') {
        return { ok: false, reason: 'worktree-not-disposable', message: `${id} is ${entry.state}; only kept work awaiting a human decision is disposed here.` };
      }
      if (!(await this.fenceAway(entry.path, id))) {
        this.audit?.({ action: 'worktree_discard', runId: entry.runId, actor, result: 'failed', detail: 'the worktree could not be moved to the fence directory' });
        return { ok: false, reason: 'worktree-discard-failed', message: `${id} could not be moved to the fence directory; nothing was deleted.` };
      }
      const removed = await removeWorktree(this.git, { repoRoot: await this.requiredRepoRoot(), worktreePath: entry.path, branch: entry.branch, deleteBranch: true });
      await this.dropFenced(id);
      await this.registry.setState(id, 'removed', this.clock.iso());
      this.audit?.({
        action: 'worktree_discard',
        runId: entry.runId,
        actor,
        result: 'discarded',
        ...(removed.branchPreserved ? { detail: `branch ${entry.branch} was not fully merged and is kept` } : {}),
      });
      return { ok: true, path: entry.path, branch: entry.branch };
    });
  }

  /** 保留项清单（面板与配额都读它）。 */
  preserved(): WorktreeEntry[] {
    return this.registry.preserved();
  }

  /** 配额档位（面板顶部那一行与审计用同一把尺）。 */
  async quotaSummary(): Promise<QuotaVerdict> {
    await this.ensureLoaded();
    return await this.quotaVerdict();
  }

  /**
   * 可选自动归档（默认关）：超期未处置的保留项打成 bundle → 校验完整 → 才删目录。
   * 校验不过绝不删——"无损可恢复"这句承诺比省地方重要。
   */
  async archiveDue(options: { autoArchive: boolean; archiveAfterDays: number }): Promise<{ id: string; ok: boolean; message?: string }[]> {
    if (!options.autoArchive) return [];
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const cutoff = this.clock.now() - options.archiveAfterDays * DAY_MS;
      const outcomes: { id: string; ok: boolean; message?: string }[] = [];
      for (const entry of this.registry.preserved()) {
        if (Date.parse(entry.at) > cutoff) continue;
        const bundleFile = path.join(this.worktreesRoot, WORKTREE_ARCHIVE_DIR, `${entry.id}.bundle`);
        await ensureDir(path.dirname(bundleFile));
        const repoRoot = await this.requiredRepoRoot();
        const bundled = await bundleWorktreeBranch(this.git, { repoRoot, branch: entry.branch, bundleFile, worktreePath: entry.path });
        if (!bundled.ok) {
          outcomes.push({ id: entry.id, ok: false, message: bundled.message });
          this.audit?.({ action: 'worktree_archive', runId: entry.runId, actor: entry.runId, result: 'failed', detail: bundled.message });
          continue;
        }
        if (!(await this.fenceAway(entry.path, entry.id))) {
          outcomes.push({ id: entry.id, ok: false, message: 'the bundle verified but the worktree could not be moved to the fence directory; nothing was deleted.' });
          continue;
        }
        await removeWorktree(this.git, { repoRoot, worktreePath: entry.path, branch: entry.branch, deleteBranch: true });
        await this.dropFenced(entry.id);
        await this.registry.markArchived(entry.id, bundleFile, this.clock.iso());
        outcomes.push({ id: entry.id, ok: true });
        this.audit?.({ action: 'worktree_archive', runId: entry.runId, actor: entry.runId, result: 'archived', detail: bundleFile });
      }
      return outcomes;
    });
  }

  private requireEntry(id: string): WorktreeEntry {
    const entry = this.registry.entry(id);
    if (!entry) throw new Error(`worktree ${id} is not registered; nothing to release.`);
    return entry;
  }
}

/**
 * 默认磁盘可用量：statfs 实读，读不到按 0（拒建，不是放行）。
 * 隔离区常常还没落地，statfs 打在不存在的路径上会 ENOENT —— 那会被读成"磁盘只剩 0 字节"
 * 而把所有写路拒掉。所以往上找到第一个真实存在的环节再问：可用量是卷的属性，同一卷上
 * 任何一个已存在的点问出来的数都一样。
 */
async function defaultFreeBytes(at: string): Promise<number> {
  let probe = at;
  for (;;) {
    try {
      const stats = await statfs(probe);
      return stats.bsize * stats.bavail;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return 0;
      const parent = path.dirname(probe);
      if (parent === probe) return 0;
      probe = parent;
    }
  }
}

/** 默认 git 执行体：spawn 一条 git，收齐 stdout / stderr 与退出码。 */
function spawnGit(): GitRunner {
  return async (argv, cwd) =>
    await new Promise<GitRunnerResult>((resolve) => {
      const child = spawn('git', argv, { cwd });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

type GitRunnerResult = { code: number | null; stdout: string; stderr: string };
