import fs from 'node:fs';
import path from 'node:path';

/**
 * worktree 的 git 工具层——模块自己调 git 的唯一出口。
 *
 * 四条纪律：
 *   1. 每一条命令都带 `-c gc.auto=0` 与 `--no-optional-locks`：几十路并发共用同一个对象库，
 *      自动 gc 会互踩 commondir 与 refs，可选锁会让并发路随机失败（ADR-0052 §11③）；
 *      这里**不写用户仓库配置**——把 gc.auto 落进 .git/config 是替用户改仓库，越界；
 *   2. 判定谓词一律 fail-closed：命令打不出去、退出码不对、stderr 有内容，都按"有活 / 脏"
 *      处理。宁可留孤儿 worktree，不可把没保住的改动删掉；
 *   3. 销毁谓词只有一个（worktreeHasWork）：任何删 worktree 的路径都走它，防策略漂移；
 *   4. runner 可整体替换：单元用例喂假 git，端到端用例用真 git——同一套判定代码。
 */

export type GitRunResult = { code: number | null; stdout: string; stderr: string };
export type GitRunner = (argv: string[], cwd: string) => Promise<GitRunResult>;

/** 每条命令的公共前缀：关自动 gc、不取可选锁。 */
export const GIT_NO_GC_ARGS: readonly string[] = ['-c', 'gc.auto=0', '--no-optional-locks'];

/** 分支前缀与 worktree 命名口径（一路一件，可倒回 runId + 槽位）。 */
export const WORKTREE_BRANCH_PREFIX = 'worktree-';

export function worktreeBranchFor(id: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${id}`;
}

function prefixed(...args: string[]): string[] {
  return [...GIT_NO_GC_ARGS, ...args];
}

/** 命令打完的三读数；打不出去按"非零退出 + 原文"回，绝不抛给调用方决定语义。 */
async function run(runner: GitRunner, cwd: string, args: string[]): Promise<GitRunResult> {
  try {
    return await runner(prefixed(...args), cwd);
  } catch (error) {
    return { code: null, stdout: '', stderr: (error as Error).message };
  }
}

function succeeded(result: GitRunResult): boolean {
  return result.code === 0 && result.stderr.trim() === '';
}

/** git 在不在：`git version` 打得出去且认得出banner。 */
export async function checkGitAvailable(runner: GitRunner): Promise<boolean> {
  const result = await run(runner, process.cwd(), ['version']);
  return succeeded(result) && /^git version /m.test(result.stdout);
}

/** 给定目录是否落在某个工作树里。 */
export async function isGitRepository(runner: GitRunner, cwd: string): Promise<boolean> {
  const result = await run(runner, cwd, ['rev-parse', '--is-inside-work-tree']);
  return succeeded(result) && result.stdout.trim() === 'true';
}

/** 仓库顶层目录；拿不到即 null（调用方按"不可用"处理，不猜）。 */
export async function repoTopLevel(runner: GitRunner, cwd: string): Promise<string | null> {
  const result = await run(runner, cwd, ['rev-parse', '--show-toplevel']);
  if (!succeeded(result)) return null;
  const top = result.stdout.trim();
  return top ? top : null;
}

/**
 * 主 worktree 路径：`git worktree list --porcelain` 的第一条就是主树。
 * 注册表是唯一权威——主树在不在边界内由它说，不由目录包含关系说。
 */
export async function mainWorktreePath(runner: GitRunner, cwd: string): Promise<string | null> {
  const result = await run(runner, cwd, ['worktree', 'list', '--porcelain']);
  if (!succeeded(result)) return null;
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const value = line.slice('worktree '.length).trim();
    if (value) return value;
  }
  return null;
}

/**
 * 该路径是不是一个**已注册**的 linked worktree（pin 的门禁）。
 * 注册表 + 活性探针双检：目录被 rm 后注册记录仍可留（prunable），重建为普通目录会被活性探针拒。
 */
export async function isRegisteredLinkedWorktree(runner: GitRunner, repoRoot: string, candidate: string): Promise<boolean> {
  const listed = await run(runner, repoRoot, ['worktree', 'list', '--porcelain']);
  if (!succeeded(listed)) return false;
  const registered = listed.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return false;
  }
  if (!registered.some((item) => item === real || path.resolve(item) === real)) return false;
  const probe = await run(runner, real, ['rev-parse', '--git-dir']);
  return succeeded(probe) && probe.stdout.trim() !== '';
}

/**
 * 工作区脏检查（创建前的闸门）。
 * 口径：只看未忽略的改动——`--ignored` 一条都不问，managed 根这类被 ignore 的目录不算脏。
 * 检查本身打不出去 / 有 stderr / 有任何条目 → 一律 true（fail-closed：判不准就当脏）。
 */
export async function hasUncommittedChanges(runner: GitRunner, cwd: string): Promise<boolean> {
  const result = await run(runner, cwd, ['status', '--porcelain', '--untracked-files=normal']);
  if (result.code !== 0 || result.stderr.trim() !== '') return true;
  return result.stdout.split('\n').some((line) => line.trim() !== '');
}

/** 可丢弃的构建 / 依赖输出根：命中它们的 ignored 条目不算"有活"（照参考口径，不扩表）。 */
export const DISPOSABLE_IGNORED_ROOTS: readonly string[] = ['node_modules', 'dist', 'coverage'];

/**
 * 唯一销毁谓词——"这个 worktree 里还有活吗"。
 *
 * 任何 git 侧错误、任何 stderr、任何判不准，都返回 true（宁留孤儿不丢工作）。
 * 豁免只有两族：可丢弃的 ignored 输出根、纯符号链接折叠出来的目录；其余条目一律算有活。
 */
export async function worktreeHasWork(runner: GitRunner, worktreePath: string): Promise<boolean> {
  // 先确认这里真是个 worktree（.git 必须在）：否则 git 会向上发现外层仓库，把别人的状态当成这个的答案。
  try {
    fs.accessSync(path.join(worktreePath, '.git'));
  } catch {
    return true;
  }
  const result = await run(runner, worktreePath, ['status', '--porcelain', '--untracked-files=normal', '--ignored=matching']);
  if (result.code !== null && result.code !== 0) return true;
  if (result.stderr.trim() !== '') return true;
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const status = line.slice(0, 2);
    const target = line.slice(3).trim();
    if (status !== '??' && status !== '!!') return true;
    if (!isExemptEntry(worktreePath, target, status)) return true;
  }
  return false;
}

function isExemptEntry(worktreePath: string, target: string, status: string): boolean {
  const normalized = target.replace(/\\/g, '/');
  const head = normalized.split('/')[0] ?? '';
  if (status === '!!' && DISPOSABLE_IGNORED_ROOTS.includes(head)) return true;
  // ignored 目录里只剩符号链接（依赖软链、workspace 链接）时同样可丢弃；有真文件即不算。
  if (status === '!!') {
    const absolute = path.join(worktreePath, target);
    return symlinkOnlyDirectory(absolute);
  }
  return false;
}

/** 折叠目录里每一项都是符号链接才算"只有链接"；空目录、读不到都不算豁免。 */
function symlinkOnlyDirectory(directory: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return entries.every((entry) => entry.isSymbolicLink());
}

/** 该路径的分支标签（best-effort）：detached HEAD、读不出都回空串，不当成错。 */
export async function registeredWorktreeBranch(runner: GitRunner, worktreePath: string): Promise<string> {
  const result = await run(runner, worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!succeeded(result)) return '';
  const branch = result.stdout.trim();
  return branch && branch !== 'HEAD' ? branch : '';
}

/** 建 worktree：新分支 + 给定路径 + 从 baseRef 起。失败抛出 git 原文（拒因照实回）。 */
export async function addWorktree(
  runner: GitRunner,
  options: { repoRoot: string; worktreePath: string; branch: string; baseRef?: string },
): Promise<{ path: string; branch: string }> {
  const result = await run(runner, options.repoRoot, ['worktree', 'add', '-b', options.branch, options.worktreePath, options.baseRef ?? 'HEAD']);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || `git worktree add exited ${result.code}`).trim();
    throw new Error(detail.slice(0, 2_000));
  }
  return { path: options.worktreePath, branch: options.branch };
}

/** 分支上有没有尚未合并回基线的提交；判不准按"有"处理（保留）。 */
export async function hasUnmergedWorktreeCommits(
  runner: GitRunner,
  options: { repoRoot: string; branch: string; baseRef?: string },
): Promise<boolean> {
  const base = options.baseRef ?? 'HEAD';
  const result = await run(runner, options.repoRoot, ['rev-list', '--count', `${base}..${options.branch}`]);
  if (!succeeded(result)) return true;
  const count = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(count)) return true;
  return count > 0;
}

/**
 * 删 worktree：目录已由调用方 fence 走（原子重命名进 trash），这里只做 git 侧清理。
 * 注册位用 prune 收（物理目录已不在，`worktree remove` 只会报路径缺失）；
 * 分支用 `branch -d` 安全删——没合并的分支 git 会拒绝，拒绝即 branchPreserved。
 */
export async function removeWorktree(
  runner: GitRunner,
  options: { repoRoot: string; worktreePath: string; branch: string; deleteBranch?: boolean },
): Promise<{ branchPreserved: boolean }> {
  await run(runner, options.repoRoot, ['worktree', 'prune']);
  if (options.deleteBranch === false) return { branchPreserved: true };
  const deleted = await run(runner, options.repoRoot, ['branch', '-d', options.branch]);
  return { branchPreserved: !succeeded(deleted) };
}

/** 归档三步的前两拍：bundle 落地 → verify 认它完整。verify 不过即删掉 bundle，绝不留下"看起来有备份"。 */
export async function bundleWorktreeBranch(
  runner: GitRunner,
  options: { repoRoot: string; branch: string; bundleFile: string; worktreePath: string },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const created = await run(runner, options.worktreePath, ['bundle', 'create', options.bundleFile, options.branch]);
  if (!succeeded(created)) {
    await fs.promises.rm(options.bundleFile, { force: true }).catch(() => undefined);
    const detail = (created.stderr || created.stdout || `git bundle create exited ${created.code}`).trim();
    return { ok: false, message: detail.slice(0, 2_000) };
  }
  const verified = await run(runner, options.worktreePath, ['bundle', 'verify', options.bundleFile]);
  if (!succeeded(verified)) {
    await fs.promises.rm(options.bundleFile, { force: true }).catch(() => undefined);
    const detail = (verified.stderr || verified.stdout || `git bundle verify exited ${verified.code}`).trim();
    return { ok: false, message: detail.slice(0, 2_000) };
  }
  return { ok: true };
}
