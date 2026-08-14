import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { modelFilePath } from './registry.js';

/**
 * ADR-0051 D-7（#94 W3-02，0050 I-27 后半）— `myterminal l3-model fetch` 子命令下载模块。
 *
 * 硬约束落地：
 *   1. 固定源（D-7）：HF unsloth/Qwen3.5-2B-GGUF Q4_K_M（1.2GB GGUF），**sha256 钉死**
 *      （供应链漂移零容忍：校验失败 → 报错且不落盘）。
 *   2. 落盘与 #93 W3-01 解析链严格同源：目标 = `modelFilePath()`（registry 导出，
 *      `installationRoot()/models/DEFAULT_L3_MODEL_PATH` 单点拼接）——'models' 子目录名与
 *      文件名不在此处硬编码，杜绝两处漂移（91 审查观察项 ①）。
 *   3. 原子落盘：流式下载到 `<target>.part` 同时累计 sha256 → 校验通过才 rename 落盘；
 *      失败清理 .part → 可重试（网络中断后重跑成功，无残留毒化）。
 *   4. 幂等（AC）：目标已存在且 sha256 命中 → `ready`「已就绪」当 status，零下载。
 *
 * 测试注入：`fetcher`（与 update.ts checkForUpdate 同模式）+ `expectedSha256`（测试可换
 * 夹具值；生产默认 = 钉死常量，见 AC2 接线测试）。
 */

/** 固定源（D-7）：HF unsloth/Qwen3.5-2B-GGUF Q4_K_M（resolve 会 302 → CLI 侧 redirect follow）。 */
export const L3_MODEL_SOURCE_URL = 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf';

/** sha256 钉死（#94 AC2：校验失败 → 报错且不落盘；grep aaf42c8b 即此处）。 */
export const L3_MODEL_SHA256 = 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223';

export type L3FetchStatus = 'ok' | 'ready' | 'error';

export interface L3FetchResult {
  status: L3FetchStatus;
  /** 落盘目标路径（与 #93 解析链同源；error 态为应落而未落的目标）。 */
  path: string;
  error?: string;
  /** 本次实际下载字节数（ready 幂等态为 0）。 */
  bytesDownloaded: number;
}

export interface L3FetchOptions {
  /** 测试注入假 HTTP（默认全局 fetch；与 update.ts checkForUpdate 同模式）。 */
  fetcher?: typeof fetch;
  /** 覆盖落盘目标（默认 modelFilePath()——W3-01 解析链同源）。 */
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

/**
 * 拉取 L3 模型（D-7）：
 * - 幂等：目标已存在且 sha256 命中 → `ready`（已就绪，零下载）；
 * - 下载：流式写入 `<target>.part`（进度回调 + 累计 sha256）→ 校验通过 rename 原子落盘，
 *   失败（网络断点/校验失败）→ 清理 .part 返回 `error`（重跑可自愈）。
 */
export async function fetchL3Model(options: L3FetchOptions = {}): Promise<L3FetchResult> {
  const fetcher = options.fetcher ?? fetch;
  const target = options.targetPath ?? modelFilePath();
  const expectedSha256 = options.expectedSha256 ?? L3_MODEL_SHA256;
  const tmp = `${target}.part`;

  // 幂等短路：目标已就绪（hash 命中）→ 不下载
  if (existsSync(target) && (await sha256File(target)) === expectedSha256) {
    return { status: 'ready', path: target, bytesDownloaded: 0 };
  }

  try {
    mkdirSync(path.dirname(target), { recursive: true });
    const response = await fetcher(L3_MODEL_SOURCE_URL, { redirect: 'follow' });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}`);
    if (!response.body) throw new Error('下载失败：响应体缺失');
    const rawTotal = response.headers.get('content-length');
    const total = rawTotal ? Number(rawTotal) : undefined;

    const hash = createHash('sha256');
    let received = 0;
    const out = createWriteStream(tmp);
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        received += chunk.length;
        options.onProgress?.(received, total);
        if (!out.write(chunk)) {
          await new Promise<void>((resolve) => out.once('drain', resolve));
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end();
        out.once('finish', resolve);
        out.once('error', reject);
      });
    } finally {
      out.destroy();
    }

    const digest = hash.digest('hex');
    if (digest !== expectedSha256) {
      throw new Error(`sha256 校验失败：期望 ${expectedSha256}，实际 ${digest}（不落盘）`);
    }
    renameSync(tmp, target); // 校验通过才原子落盘
    return { status: 'ok', path: target, bytesDownloaded: received };
  } catch (error) {
    // 失败清理 .part（可重试前提：无残留毒化）；目标未被触碰（原子落盘语义）
    try { rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖主错误 */ }
    return {
      status: 'error',
      path: target,
      bytesDownloaded: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 完成输出四要素（D-8 通道1：进度 → sha256 ✓ → 落盘路径 → 预热行；ready 幂等态输出「已就绪」）。 */
export function formatFetchCompletion(result: L3FetchResult): string[] {
  if (result.status === 'ready') {
    return [
      `已就绪：sha256 ✓ ${L3_MODEL_SHA256}`,
      `落盘路径 ${result.path}`,
      'L3 模型已就绪，下次启动自动预热',
    ];
  }
  return [
    `sha256 ✓ ${L3_MODEL_SHA256}`,
    `落盘路径 ${result.path}`,
    'L3 模型已就绪，下次启动自动预热',
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
