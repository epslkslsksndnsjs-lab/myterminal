// ADR-0051 增补-13 (#112)：测试全局预热隔离 — 回归锁
//
// 背景（2026-08-15 晚实测）：主仓库 models/ 存在真实模型后，全量测试并行 worker 各加载
// 一份 gguf（RSS 20GB+、卡死 23 分钟）。两条加载路径：
//   1. 预热 smoke probe（startL3Warmup → l3WarmupEnabled 旋钮）
//   2. 直接路径（runL3 只查 l3Enabled、不查预热旋钮 → getL3Adapter 真实 adapter →
//      isReady → ensureLoaded → loadModel(GGUF)）；worker 无 models/ 时快速失败故历史没炸
//
// 根治（bunfig.toml [test] preload → test/setup.ts，worker 启动注入，默认生效而非手动 env）：
//   - MYTERMINAL_L3_WARMUP=false：预热 smoke probe 默认关（测试内显式 delete/覆盖仍有效）
//   - MYTERMINAL_L3_MODEL_PATH=<不存在路径>：直接路径的 loadModel 恒快速失败；warmup 的
//     modelFileMissing 早退路径同样拦截（missing 早退先于 isReady）——任何机器（含 models/
//     有真模型）逐字复刻「无 models/」基线语义，零 gguf 加载
//
// 共享 worker 说明（#112 实证）：bun test 以 worker 池并行跑文件，preload 在 worker 内
// 对 setup.ts 只执行一次（ESM 模块缓存）；W208/W303/issue-111 等文件顶部显式
// `delete process.env.MYTERMINAL_L3_WARMUP` 会泄漏给同 worker 后续文件（预热恢复默认开）。
// 该泄漏窗口无害：MODEL_PATH 钉死无人删除（W301/W302/W303 均 withEnv 保存/恢复），
// 预热开时 modelFileMissing 早退仍拦截加载。因此本锁断言「机制 + 语义」而非进程 env 常存。
//
// 测试方式：直接驱动 ../dist/l3/warmup.js + ../dist/l3/registry.js（build 产物）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { l3WarmupEnabled, startL3Warmup, resetL3Warmup, l3Health, resetL3Health } from '../dist/l3/warmup.js';
import { l3ModelPath, DEFAULT_L3_MODEL_PATH, resetL3Adapter, resetL3AdapterInstance } from '../dist/l3/registry.js';
import { TEST_L3_MODEL_PATH } from './setup.ts';

const root = path.resolve(import.meta.dirname, '..');

afterEach(() => {
  resetL3Warmup();
  resetL3Health();
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）
});

test('AC1a 全局默认机制锁：bunfig.toml preload 接线 + setup.ts 注入内容（静态）', () => {
  const bunfig = fs.readFileSync(path.join(root, 'bunfig.toml'), 'utf8');
  assert.match(bunfig, /preload\s*=\s*\[[^\]]*test\/setup\.ts/, 'bunfig.toml [test] preload 必须指向 test/setup.ts');
  const setup = fs.readFileSync(path.join(root, 'test', 'setup.ts'), 'utf8');
  assert.match(setup, /MYTERMINAL_L3_WARMUP\s*=\s*'false'/, 'setup.ts 必须注入 MYTERMINAL_L3_WARMUP=false');
  assert.match(setup, /MYTERMINAL_L3_MODEL_PATH\s*=\s*TEST_L3_MODEL_PATH/, 'setup.ts 必须注入 MODEL_PATH 钉死');
  // 生产语义不变（D-6）：env 未设置/空串 → 预热默认开
  assert.strictEqual(l3WarmupEnabled({}), true, '生产默认（env 未设置）仍为预热开');
  assert.strictEqual(l3WarmupEnabled({ MYTERMINAL_L3_WARMUP: 'false' }), false, '显式 false → 关（覆盖能力保留）');
});

test('AC1b 直接路径隔离：MODEL_PATH 钉死到不存在的模型文件（任何机器含真模型环境恒快败）', () => {
  const raw = process.env.MYTERMINAL_L3_MODEL_PATH;
  assert.ok(raw && raw.length > 0, 'worker 启动注入 MYTERMINAL_L3_MODEL_PATH（setup.ts preload）');
  assert.strictEqual(raw, TEST_L3_MODEL_PATH, '注入值与 setup 导出常量同源（单一事实源）');
  assert.equal(fs.existsSync(raw), false, '钉死路径必须不存在 → 真实 adapter 的 loadModel 恒快速失败');
  assert.strictEqual(l3ModelPath(), raw, '解析链（env > 安装根 > 裸文件名）命中钉死路径');
  assert.notStrictEqual(raw, DEFAULT_L3_MODEL_PATH, '不得与裸文件名默认重合');
});

test('AC1c 运行时零加载语义：真 adapter + 钉死路径 → 预热 missing 早退（先于 isReady/加载）', async () => {
  const savedEnabled = process.env.MYTERMINAL_L3_ENABLED;
  const savedWarmup = process.env.MYTERMINAL_L3_WARMUP;
  process.env.MYTERMINAL_L3_ENABLED = 'true'; // 显式开（防共享 worker 泄漏到关态）
  delete process.env.MYTERMINAL_L3_WARMUP; // 显式恢复默认开分支——覆盖能力正是本票要保留的语义
  const logs = [];
  const log = (m) => logs.push(m);
  try {
    resetL3Adapter(); // 清 factory → 默认 LlamaLocalAdapter（真 adapter，零 fake）
    const missingPath = path.join(root, 'models', DEFAULT_L3_MODEL_PATH);
    if (fs.existsSync(missingPath)) {
      // 真模型在场（AC1 验收环境）：解析链本会命中真模型——钉死路径必须压过它
      assert.notStrictEqual(l3ModelPath(), missingPath, '钉死路径必须压过安装根真模型（env > 安装根）');
    }
    startL3Warmup(log, [5, 10, 15]);
    // missing 早退同步发生（modelFileMissing 先于 isReady/加载）
    assert.strictEqual(l3Health()?.status, 'missing', '钉死路径不存在 → missing 早退（零加载）');
    assert.ok(logs.some((m) => m.includes('myterminal l3-model fetch')), 'missing 日志指向 fetch 命令');
    // 无任何加载证据：状态停留 missing 且无 ready/failed 迁移（adapter 从未被碰）
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(l3Health()?.status, 'missing', '80ms 后仍 missing（无加载/重试迁移）');
  } finally {
    if (savedEnabled === undefined) delete process.env.MYTERMINAL_L3_ENABLED;
    else process.env.MYTERMINAL_L3_ENABLED = savedEnabled;
    if (savedWarmup === undefined) delete process.env.MYTERMINAL_L3_WARMUP;
    else process.env.MYTERMINAL_L3_WARMUP = savedWarmup;
    resetL3AdapterInstance();
  }
});
