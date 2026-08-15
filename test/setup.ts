/**
 * ADR-0051 增补-13 (#112)：测试全局预热隔离 — bun test 全局默认注入。
 *
 * 由 bunfig.toml `[test] preload` 在测试 worker 启动时加载（共享 worker 池下
 * ESM 模块缓存使本模块每 worker 只执行一次；W208/W303/issue-111 等文件顶部显式
 * `delete process.env.MYTERMINAL_L3_WARMUP` 会泄漏给同 worker 后续文件——该泄漏
 * 窗口无害：MODEL_PATH 钉死无人删除，预热开时 modelFileMissing 早退仍拦截加载）。
 *
 * 背景（2026-08-15 晚实测）：主仓库 models/ 存在真实模型后，全量测试并行 worker 各
 * 加载一份 gguf（RSS 20GB+、卡死 23 分钟）。两条加载路径：
 *   1. 预热 smoke probe：startL3Warmup → l3WarmupEnabled() 旋钮
 *   2. 直接路径：runL3 只查 l3Enabled()、不查预热旋钮 → getL3Adapter() 真实 adapter
 *      → isReady() → ensureLoaded() → loadModel(GGUF)。worker 无 models/ 时快速失败
 *      故历史没炸；models/ 有真模型后即真加载。
 *
 * 本文件做两件事（默认生效而非手动 env）：
 *   1. MYTERMINAL_L3_WARMUP=false：预热 smoke probe 全局关。需要预热语义的测试
 *      （W208/W303/issue-111 等）在文件顶部显式 `delete process.env.MYTERMINAL_L3_WARMUP`
 *      或 withEnv 覆盖，恢复默认开分支——覆盖能力原样保留。
 *   2. MYTERMINAL_L3_MODEL_PATH=<不存在路径>：直接路径的 loadModel 恒快速失败——
 *      任何机器（含 models/ 有真模型）逐字复刻「无 models/」基线语义，零 gguf 加载。
 *      路径解析链（env > 安装根 models > 裸文件名）的测试（W301/W302/issue-37）均
 *      显式管理该 env（withEnv/withTempHome），不受影响。
 *
 * 运行时（src/）零改动：本文件只注入测试进程 env。
 */

/** 直接路径隔离钉死路径（回归锁 issue-112 测试断言同源）。 */
export const TEST_L3_MODEL_PATH = '/nonexistent/myterminal-test-model-does-not-exist.gguf';

process.env.MYTERMINAL_L3_WARMUP = 'false';
process.env.MYTERMINAL_L3_MODEL_PATH = TEST_L3_MODEL_PATH;
