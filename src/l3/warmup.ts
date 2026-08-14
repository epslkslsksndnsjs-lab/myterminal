import type { JsonObject, JsonSchema } from '../types.js';
import { getL3Adapter, l3Enabled } from './registry.js';
import { buildInstruction } from './prompt.js';
import { L3_MAX_TOKENS } from './engine.js';

/**
 * ADR-0051 D-6（#91 W2-08）— L3 异步预热 + smoke probe（0050 G1 翻转必修）。
 *
 * 消除「首次 L3 调用冷加载 ~1.3GB 模型在 8s 超时下大概率首调 fail-open」高危坑
 * （ADR-0047 第 323 行点名）：standalone 下 server.start 后台异步触发预热
 * （不 await，启动耗时零影响）；冷载实测 1776ms（getLlama 235 + loadModel 1541）
 * ≪ 8s 超时，预热完成后首调即可命中已加载模型。
 *
 * 流程（D-6）：后台 isReady 加载 → smoke probe（dummy complete 断言可解析 + schema
 * 合法）→ 失败有限退避（WARMUP_MAX_RETRIES=3）→ 全失败仅记日志（不抛错不阻断）。
 * 热路径零新闸门：本模块不写任何状态供 runL3 读取，失败后首个真实 L3 调用照旧走
 * 既有 isReady/超时/失败矩阵 fail-open。
 *
 * 语义约束：
 *   - 单例语义不破坏（D8.2）：预热经 getL3Adapter() 拿懒加载单例——预热即首次加载，
 *     后续真实调用复用同一实例，不重建。
 *   - 幂等：进程内只跑一次（warmupStarted 门闩）；server.close 重置门闩
 *     （「下次启动自动预热」，D-8.1 第 1 条），测试经 resetL3Warmup 隔离。
 *   - env 优先（D-6）：l3Enabled() 为 false（env 关 / cluster 参与者默认关）→ 整体
 *     no-op，绝不碰 adapter。
 *   - env 优先（#101 增补-02）：l3WarmupEnabled() 为 false（显式关预热旋钮）→ no-op。
 *     旋钮与 MYTERMINAL_L3_ENABLED 同一模式（env 优先）：未设置/空串 → 默认开，
 *     生产行为逐字不变；测试环境设 MYTERMINAL_L3_WARMUP=false 防止预热 smoke probe
 *     挤占注入的 fake adapter / 真加载模型拖垮运行时探测类测试（W206-AC9、W104-AC8 等）。
 */

/** D-6「失败有限退避 3 次」：初始 1 次 + 3 次退避重试 = 最多 WARMUP_MAX_RETRIES+1 次尝试。 */
export const WARMUP_MAX_RETRIES = 3;

/** 每次重试前的退避时长（ms）：500/1000/2000 递增；测试可注入小值缩短等待。 */
export const WARMUP_BACKOFF_MS: readonly number[] = [500, 1000, 2000];

/** smoke probe 用最小 schema（D-6「schema 合法」：探针即用合法 JsonSchema）。 */
const SMOKE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
};

/** smoke probe 用 dummy raw 结果（Q5 值存在性校验的锚点）。 */
const SMOKE_RAW: JsonObject = { ok: true };

/**
 * 关预热旋钮（#101 增补-02，与 D-6 MYTERMINAL_L3_ENABLED 同一模式：env 优先）。
 * - MYTERMINAL_L3_WARMUP：一键关预热。未设置/空串 → 预热开（生产默认不变）；
 *   显式 true/1/yes/on → 开；其余非空值（false/0/no/off…）→ 关。
 * 测试环境在文件顶部设 MYTERMINAL_L3_WARMUP=false，杜绝预热 smoke probe 挤占
 * 注入 fake adapter 的计数 / 真加载模型拖垮运行时探测测试（#101 事实底座：整合才爆）。
 */
export function l3WarmupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MYTERMINAL_L3_WARMUP?.trim();
  if (!raw) return true; // 未设置/空串 → 默认开（D-6 原行为逐字不动）
  return /^(1|true|yes|on)$/i.test(raw);
}

/** 进程内预热门闩（幂等：重复 start 只预热一次，防并发加载 2×1.3GB RAM 乘散）。 */
let warmupStarted = false;

/** 重置预热门闩（server.close「下次启动自动预热」/ 测试隔离）。 */
export function resetL3Warmup(): void {
  warmupStarted = false;
}

/** 预热日志回调类型（与 server.log 兼容：'info' | 'error'）。 */
export type WarmupLogger = (message: string, level?: 'info' | 'error') => void;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 异步预热（fire-and-forget，立即返回）：后台 isReady 加载 → smoke probe → 失败退避。
 *
 * - l3Enabled() false（env 关 / cluster 参与者默认关）→ 同步 no-op，零副作用。
 * - 全失败仅记日志（error），绝不抛错、绝不阻断 server.start（D-6）。
 * - backoffMs 为测试注入点（缺省 WARMUP_BACKOFF_MS）。
 */
export function startL3Warmup(log: WarmupLogger, backoffMs: readonly number[] = WARMUP_BACKOFF_MS): void {
  if (!l3Enabled()) return; // env 优先（D-6）：关 → 不预热（no-op 不消费幂等门闩）
  if (!l3WarmupEnabled()) return; // #101 增补-02：显式关预热 → no-op（同不消费门闩；测试可测试化）
  if (warmupStarted) return; // 幂等门闩：进程内单次（D-6「下次启动自动预热」由 close 重置）
  warmupStarted = true;
  const adapter = getL3Adapter(); // 懒加载单例：预热即首次加载；后续真实调用复用（D8.2）
  void (async () => {
    const startedAt = Date.now();
    try {
      for (let attempt = 0; attempt <= WARMUP_MAX_RETRIES; attempt++) {
        if (attempt > 0) await sleepMs(backoffMs[attempt - 1] ?? WARMUP_BACKOFF_MS[WARMUP_BACKOFF_MS.length - 1]);
        if (!(await adapter.isReady())) continue; // 加载失败 → 退避重试
        // smoke probe：dummy complete，断言输出可解析（object 非 null 且为普通对象）
        const probe = await adapter.complete({
          instruction: buildInstruction(SMOKE_RAW, SMOKE_SCHEMA),
          schema: SMOKE_SCHEMA,
          maxTokens: L3_MAX_TOKENS,
          temperature: 0,
        });
        if (probe.object !== null && typeof probe.object === 'object' && !Array.isArray(probe.object)) {
          log(`L3 warmup ready (${Date.now() - startedAt}ms)`, 'info');
          return;
        }
      }
      // 全失败仅记日志（D-6）：不抛错不阻断；首调走既有 isReady/失败矩阵 fail-open
      log(`L3 warmup failed after ${WARMUP_MAX_RETRIES + 1} attempts; first L3 call will lazy-load (fail-open)`, 'error');
    } catch (error) {
      log(`L3 warmup error: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  })();
}
