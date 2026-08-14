import type { LocalModelAdapter } from './adapter.js';
import { LlamaLocalAdapter } from './llama-adapter.js';

/**
 * ADR-0047 D8/D8.2/D8.3 — L3 适配器 registry（单例懒加载 + env 旋钮 + fake 注入）。
 *
 * 职责：解析框架配置（env 旋钮）并提供默认/注入的 LocalModelAdapter 单例。L3 引擎
 * （T10）只依赖 LocalModelAdapter 接口，不直接碰此 registry 的实例来源——真模型
 * （node-llama-cpp + Qwen3.5-2B Q4_K_M GGUF，~1.3GB）由 T12 落地为默认 adapter
 * （`LlamaLocalAdapter`，懒加载），测试环境经 `registerAdapterFactory` 注入 fake adapter
 * （成功/超时/不可用三路径），真模型不进自动化测试。
 */

// ── env 旋钮（D8.3 运维逃生舱）───────────────────────────────────────────────
//
// 优先级 env > 模式默认。多进程 cluster 参与者默认 false 属 D18.2（T13 落地）。
// - MYTERMINAL_L3_ENABLED：一键关 L3 → 全 passthrough（由 T10 引擎读取，false 时不调
//   模型）。未设置/空串 → 参与者默认（见下方 cluster gate）。
// - MYTERMINAL_L3_MODEL_PATH：覆盖 GGUF 路径。未设置/空串 → DEFAULT_L3_MODEL_PATH。
//   模型分发绝对路径（installationRoot 派生）随框架安装分发时确定；此处给稳定文件名默认。

/** 框架默认本地模型文件名（D8.3 已决：Qwen3.5-2B GGUF Q4_K_M；T12 实测 max ctx=256K ≥ 26K）。 */
export const DEFAULT_L3_MODEL_PATH = 'Qwen3.5-2B-Q4_K_M.gguf';

// ── D18.2 参与者层面 cluster gate ────────────────────────────────────────────
//
// cluster 参与者（server.cluster 非 null）L3 默认关闭，避免 N×1.1GB RAM 乘散。
// enabled = env.MYTERMINAL_L3_ENABLED ?? (server.cluster ? false : true)。
// 引导时（server.start）读一次 server.cluster 后 `setL3ClusterMode` 定一次，不随成员
// 增减翻转，不进每请求热路径（runL3 每请求只读 `l3Enabled()`，无 cluster 判断）。

/** 参与者默认（D18.2）：standalone 默认开；cluster 参与者默认关。 */
let clusterDefault = true;

/** D18.2 参与者层面 gate：clustered=true（cluster 参与者）→ L3 默认关；false → 默认开。 */
export function setL3ClusterMode(clustered: boolean): void {
  clusterDefault = clustered ? false : true;
}

/** 重置为 standalone 默认（测试隔离）。 */
export function resetL3ClusterMode(): void {
  clusterDefault = true;
}

/** L3 是否启用（env 优先；env 未设置 → 参与者默认 clusterDefault）。 */
export function l3Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MYTERMINAL_L3_ENABLED?.trim();
  if (!raw) return clusterDefault; // 未设置/空串 → 参与者默认（D18.2）
  return /^(1|true|yes|on)$/i.test(raw);
}

/** L3 本地模型 GGUF 路径（env 优先，未设置默认内置模型名）。 */
export function l3ModelPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MYTERMINAL_L3_MODEL_PATH?.trim();
  return raw ? raw : DEFAULT_L3_MODEL_PATH;
}

// ── 单例懒加载 + 注入（D8.2）────────────────────────────────────────────────
//
// LocalModelAdapter 实例（含已 load 的模型权重）由 registry 以单例持有：首次
// `getL3Adapter()` 懒加载（用注入的 factory 或默认 LlamaLocalAdapter），之后常驻复用；
// 冷加载延迟只在第一次发生。进程退出/会话结束调用 `resetL3Adapter()` 释放（下次再懒加载）。
//
// 注入语义：`registerAdapterFactory` 注册工厂后，仅在下一次懒加载时生效；若单例已创建，
// 需先 `resetL3Adapter()` 再注入（懒加载常驻，不随注册翻转——与 D18.2「注册时定一次、
// 不随成员增减翻转」同源）。

let adapterSingleton: LocalModelAdapter | undefined;
let adapterFactory: (() => LocalModelAdapter) | undefined;

/** 注册 adapter 工厂（测试注入 fake；默认走 LlamaLocalAdapter）。 */
export function registerAdapterFactory(factory: () => LocalModelAdapter): void {
  adapterFactory = factory;
}

/** 懒加载单例：首次调用创建并缓存，后续复用同一实例。默认 LlamaLocalAdapter（真模型懒加载）。 */
export function getL3Adapter(): LocalModelAdapter {
  if (!adapterSingleton) {
    adapterSingleton = adapterFactory ? adapterFactory() : new LlamaLocalAdapter(l3ModelPath());
  }
  return adapterSingleton;
}

/** 释放单例 + 注入工厂（进程退出/会话结束；测试 tearDown）。下次 getL3Adapter 重新懒加载。 */
export function resetL3Adapter(): void {
  adapterSingleton = undefined;
  adapterFactory = undefined;
}

/**
 * 只释放单例、保留注入工厂（#101 增补-02 测试隔离专用）。
 *
 * bun test 以共享 worker 池并行跑文件（同进程线程），模块级状态跨文件可见：文件 A
 * afterEach 的裸 resetL3Adapter 会清掉同 worker 文件 B 刚注入的 fake factory
 * （W1-08-E1a 全量并行必现 0!==1）。测试 afterEach 因此改用本函数：清掉本文件
 * 产生的单例缓存（防旧实例残留），但不动其他文件注入的 factory。注入前文件内
 * 隔离仍由 injectFake 前置的 resetL3Adapter() 保证（先全清再注入）。
 */
export function resetL3AdapterInstance(): void {
  adapterSingleton = undefined;
}
