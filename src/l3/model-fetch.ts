import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_L3_MODEL_PATH, modelFilePath } from './registry.js';
import { l3WarmupEnabled } from './warmup.js';

/**
 * ADR-0051 D-7（#94 W3-02，0050 I-27 后半）— `myterminal l3-model fetch` 子命令下载模块。
 * ADR-0051 增补-06（#105，A3 审计 R7/R8/R9 + A3-5/6/8）— fetch 健壮性簇。
 *
 * 硬约束落地：
 *   1. 固定源（D-7）：HF unsloth/Qwen3.5-2B-GGUF Q4_K_M（1.2GB GGUF），**sha256 钉死**
 *      （供应链漂移零容忍：校验失败 → 报错且不落盘）。文件名由 DEFAULT_L3_MODEL_PATH
 *      单字面量拼接（增补-06 A3-8：URL 与解析链禁两处漂移）。
 *   2. 落盘与 #93 W3-01 解析链同源：默认目标 = `modelFilePath()`
 *      （registry 导出，`installationRoot()/models/DEFAULT_L3_MODEL_PATH` 单点拼接）；
 *      **env 覆盖优先**（增补-06 R8）：MYTERMINAL_L3_MODEL_PATH 非空白 → 落盘到 env 路径
 *      （消除「env 用户 fetch 1.2GB 落默认位、运行时恒 missing、提示循环」）。注意直接读
 *      process.env 而非 l3ModelPath()——其未安装时回落裸文件名，作为落盘目标会按 cwd 解析。
 *   3. 原子落盘：流式下载到 `<target>.part` 同时累计 sha256 → 校验通过才 rename 落盘；
 *      失败清理 .part → 可重试（网络中断后重跑成功，无残留毒化）。
 *   4. 幂等（AC）：目标已存在且 sha256 命中 → `ready`「已就绪」当 status，零下载。
 *   5. 并发互斥（增补-06 R9）：`<target>.lock` 锁文件（O_EXCL 原子创建，内容=持有者 pid）
 *      ——并发双 fetch 仅一个下载者，其余报错可见原因；死进程锁入口回收（pid 存活探测，
 *      SIGINT/崩溃残留自愈）；rename 落盘后对成品 sha256File 复验，不符即清理报错
 *      （兜底防任何交错字节落盘）。
 *   6. 流式期 IO 失败（磁盘满等）不崩溃（增补-06 R7）：createWriteStream 后立即挂
 *      'error' 监听并贯穿循环/drain/收尾竞速——优雅 error 返回 + .part 清理，
 *      不 uncaughtException。
 *   7. 完成文案按预热旋钮分支（增补-06 R12）：MYTERMINAL_L3_WARMUP=false 时不空许
 *      「下次启动自动预热」，改称「重启后生效」。
 *
 * 测试注入：`fetcher`（与 update.ts checkForUpdate 同模式）+ `expectedSha256`（测试可换
 * 夹具值；生产默认 = 钉死常量，见 AC2 接线测试）+ `targetPath`（覆盖 env/默认推导）。
 */

/** 固定源（D-7）：HF unsloth/Qwen3.5-2B-GGUF Q4_K_M（resolve 会 302 → CLI 侧 redirect follow）。
 * 文件名与解析链 DEFAULT_L3_MODEL_PATH 单字面量（增补-06 A3-8：禁两处漂移）。 */
export const L3_MODEL_SOURCE_URL = `https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/${DEFAULT_L3_MODEL_PATH}`;

/** sha256 钉死（#94 AC2：校验失败 → 报错且不落盘；grep aaf42c8b 即此处）。 */
export const L3_MODEL_SHA256 = 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223';

export type L3FetchStatus = 'ok' | 'ready' | 'error';

export interface L3FetchResult {
  status: L3FetchStatus;
  /** 落盘目标路径（与 #93 解析链同源；error 态为应落而未落的目标）。 */
  path: string;
  error?: string;
  /** 本次实际下载字节数（ready 幂等态为 0；error 态报已收累计，增补-06 A3-6）。 */
  bytesDownloaded: number;
}

export interface L3FetchOptions {
  /** 测试注入假 HTTP（默认全局 fetch；与 update.ts checkForUpdate 同模式）。 */
  fetcher?: typeof fetch;
  /** 覆盖落盘目标（默认 env 覆盖 → modelFilePath()——W3-01 解析链同源）。 */
  targetPath?: string;
  /** 覆盖期望摘要（测试夹具；生产默认 = L3_MODEL_SHA256 钉死值）。 */
  expectedSha256?: string;
  /** 进度回调（received 已收字节；total 未知时为 undefined）。 */
  onProgress?: (received: number, total: number | undefined) => void;
}

/** 文件流式 sha256（1.2GB 不进内存；幂等校验用）。 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath) as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

// ── 并发互斥锁（增补-06 R9）───────────────────────────────────────────────────
//
// `<target>.lock` 内容 = 持有者 pid。O_EXCL 原子创建保证「仅一个下载者」；持锁窗口 =
// 入口自愈清理 → 下载 → 校验 → rename → 成品复验 → 释放。锁与 .part 同目录，SIGINT/
// 崩溃残留由 pid 存活探测回收（A3-5 自愈）。

/** pid 存活探测（0 信号）：成功 → 存活；EPERM（进程存在但无权限，跨用户共享安装）
 * → 存活（防活锁误回收）；ESRCH 等 → 死亡。 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 获取下载互斥锁：'acquired'（O_EXCL 创建成功，或回收死进程锁后重取）| 'busy'
 * （持有者存活 / 锁内容不可读按存活保守处理）。非 EEXIST 的 IO 错误照常抛出。
 */
function acquireLock(lockPath: string): 'acquired' | 'busy' {
  try {
    writeFileSync(lockPath, `${process.pid}`, { flag: 'wx' });
    return 'acquired';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let holderPid = NaN;
    try {
      const raw = readFileSync(lockPath, 'utf8').trim();
      // 内容必须纯数字才解析：空/未写完（Number('')=0 会误判死进程）→ NaN → 下方按存活保守处理
      holderPid = /^\d+$/.test(raw) ? Number(raw) : NaN;
    } catch {
      /* 锁内容不可读（对方刚创建尚未写完）→ 按存活保守处理 */
    }
    if (!Number.isFinite(holderPid) || pidAlive(holderPid)) return 'busy';
    rmSync(lockPath, { force: true }); // 死进程锁 → 回收
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: 'wx' });
      return 'acquired';
    } catch {
      return 'busy'; // 回收竞争失败（另一进程抢先）→ 视为 busy
    }
  }
}

/**
 * 拉取 L3 模型（D-7 + 增补-06）：
 * - 幂等：目标已存在且 sha256 命中 → `ready`（已就绪，零下载）；
 * - 下载：互斥锁 → 清理上次中断残留 .part → 流式写入 `<target>.part`（进度回调 +
 *   累计 sha256，'error' 监听贯穿全程防崩溃）→ 校验通过 rename 原子落盘 → 成品复验，
 *   失败（网络断点/校验失败/IO 错误/并发互斥）→ 清理 .part + 释放锁返回 `error`
 *   （重跑可自愈）。
 */
export async function fetchL3Model(options: L3FetchOptions = {}): Promise<L3FetchResult> {
  const fetcher = options.fetcher ?? fetch;
  // 增补-06 R8：env 覆盖优先于默认位；空白视为未设置。勿走 l3ModelPath()——其未安装时
  // 回落裸文件名会破坏默认场景（见文件头注释 2）。
  const envTarget = process.env.MYTERMINAL_L3_MODEL_PATH?.trim();
  const target = options.targetPath ?? (envTarget || modelFilePath());
  const expectedSha256 = options.expectedSha256 ?? L3_MODEL_SHA256;
  const tmp = `${target}.part`;
  const lock = `${target}.lock`;
  let received = 0; // 函数级：error 态也要报累计已收字节（增补-06 A3-6）

  try {
    // 幂等短路：目标已就绪（hash 命中）→ 不下载（只读路径，不需要锁）。置于 try 内：
    // 读错误（并发复验失败方 rmSync(target) 打断读流等）→ 优雅 error 而非 unhandledRejection
    if (existsSync(target) && (await sha256File(target)) === expectedSha256) {
      return { status: 'ready', path: target, bytesDownloaded: 0 };
    }
    mkdirSync(path.dirname(target), { recursive: true });
    if (acquireLock(lock) === 'busy') {
      let holder = '未知';
      try { holder = readFileSync(lock, 'utf8').trim() || '未知'; } catch { /* 不可读按未知 */ }
      throw new Error(`并发 fetch 进行中（进程 ${holder} 持有锁 ${lock}）；请等待其完成后重试`);
    }
    try {
      rmSync(tmp, { force: true }); // 增补-06 A3-5：持锁后清上次中断残留 .part（自愈）
      const response = await fetcher(L3_MODEL_SOURCE_URL, { redirect: 'follow' });
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}`);
      if (!response.body) throw new Error('下载失败：响应体缺失');
      const rawTotal = response.headers.get('content-length');
      const total = rawTotal ? Number(rawTotal) : undefined;

      const hash = createHash('sha256');
      const out = createWriteStream(tmp);
      // 增补-06 R7：流式期 IO 错误（磁盘满等）→ 监听贯穿循环/drain/收尾，竞速拒绝即
      // 优雅 error 返回（不 uncaughtException 崩溃），下方清理照常执行。
      const writeError = new Promise<never>((_, reject) => {
        out.once('error', reject);
      });
      // createWriteStream 的 fd 打开是异步的：主循环可能已因网络错误提前退出并返回，
      // 迟到的 open/写错误后发 → 本竞速分支已无等待者 → 预挂 catch 标记 handled，
      // 防 unhandledRejection（生产态进程崩溃 / 测试态 worker 被杀，R7 完整面）。
      writeError.catch(() => { /* 错误已由主路径 error 返回承载 */ });
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          received += chunk.length;
          options.onProgress?.(received, total);
          if (!out.write(chunk)) {
            await Promise.race([new Promise<void>((resolve) => out.once('drain', resolve)), writeError]);
          }
        }
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            out.end();
            out.once('finish', resolve);
            out.once('error', reject);
          }),
          writeError,
        ]);
      } finally {
        out.destroy();
      }

      const digest = hash.digest('hex');
      if (digest !== expectedSha256) {
        throw new Error(`sha256 校验失败：期望 ${expectedSha256}，实际 ${digest}（不落盘）`);
      }
      renameSync(tmp, target); // 校验通过才原子落盘
      // 增补-06 R9：rename 后对成品复验——任何交错/残留字节落盘都被拦下，不符即清理报错
      if ((await sha256File(target)) !== expectedSha256) {
        rmSync(target, { force: true });
        throw new Error('落盘复验失败：成品 sha256 与钉死值不符，已清理（请重试）');
      }
      return { status: 'ok', path: target, bytesDownloaded: received };
    } finally {
      // 先清 .part 再放锁：避免「放锁后、清理前」窗口内新持有者创建的 .part 被误删
      try { rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖主错误 */ }
      rmSync(lock, { force: true });
    }
  } catch (error) {
    return {
      status: 'error',
      path: target,
      bytesDownloaded: received, // 增补-06 A3-6：报实际累计已收字节（不再恒 0）
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 完成输出四要素（D-8 通道1：进度 → sha256 ✓ → 落盘路径 → 预热行；ready 幂等态输出
 * 「已就绪」）。预热行按旋钮分支（增补-06 R12）：l3WarmupEnabled() false 时不空许
 * 「下次启动自动预热」，改称「重启后生效」。
 */
export function formatFetchCompletion(result: L3FetchResult, warmupEnabled: boolean = l3WarmupEnabled()): string[] {
  const warmupLine = warmupEnabled
    ? 'L3 模型已就绪，下次启动自动预热'
    : 'L3 模型已就绪，重启后生效（预热旋钮 MYTERMINAL_L3_WARMUP 当前为关）';
  if (result.status === 'ready') {
    return [
      `已就绪：sha256 ✓ ${L3_MODEL_SHA256}`,
      `落盘路径 ${result.path}`,
      warmupLine,
    ];
  }
  return [
    `sha256 ✓ ${L3_MODEL_SHA256}`,
    `落盘路径 ${result.path}`,
    warmupLine,
  ];
}

/** CLI 处理器（cli.ts `l3-model fetch` 派发调用；out 注入便于测试捕获输出）。返回进程退出码。 */
export async function runL3ModelFetchCli(options: {
  fetcher?: typeof fetch;
  targetPath?: string;
  expectedSha256?: string;
  out?: (line: string) => void;
} = {}): Promise<number> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const result = await fetchL3Model({
    fetcher: options.fetcher,
    targetPath: options.targetPath,
    expectedSha256: options.expectedSha256,
    onProgress: (received, total) => {
      const pct = total ? ` (${Math.floor((received / total) * 100)}%)` : '';
      out(`\r下载中 ${received}/${total ?? '?'} bytes${pct}`);
    },
  });
  out('');
  if (result.status === 'error') {
    out(`l3-model fetch 失败：${result.error}`);
    return 1;
  }
  for (const line of formatFetchCompletion(result)) out(line);
  return 0;
}
