// ADR-0047 T09 (#37)：L3 抽象接口 + registry 单例 + env 旋钮 + fake adapter 注入（D8 接口层）
//
// 验收断言：
//   AC1  接口纯类型零运行时依赖——dist/l3/adapter.js 无运行时导出（类型擦除后为空模块），
//        与 subagent/Anthropic 配置彻底解耦
//   AC2  env 旋钮：MYTERMINAL_L3_ENABLED（一键关 L3）/ MYTERMINAL_L3_MODEL_PATH（覆盖 GGUF），
//        优先级 env > 默认
//   AC3  registry 单例懒加载常驻：冷加载只在首次，后续复用同一实例；reset 释放后重新懒加载
//   AC4  测试环境可注入 fake adapter（成功 / 超时 / 不可用三条路径）；默认 unavailable adapter
//
// 测试方式：直接驱动 ../dist/l3/registry.js（build 产物）；fake adapter 在测试内构造，不进 src。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_L3_MODEL_PATH,
  l3Enabled,
  l3ModelPath,
  registerAdapterFactory,
  getL3Adapter,
  resetL3Adapter, resetL3AdapterInstance,
} from '../dist/l3/registry.js';

/** 三路径 fake adapter（成功 / 超时 / 不可用）。 */
function fakeAdapter({ ready = true, mode = 'success' } = {}) {
  return {
    id: 'fake',
    supportsStructuredOutput: ready,
    isReady: async () => ready,
    complete: async (req) => {
      if (mode === 'timeout') return { object: null, finishReason: 'timeout', latencyMs: 1, modelId: 'fake' };
      if (mode === 'unavailable') return { object: null, finishReason: 'error', latencyMs: 1, modelId: 'fake' };
      return { object: { extracted: true }, finishReason: 'stop', latencyMs: 1, modelId: 'fake' };
    },
  };
}

afterEach(() => resetL3AdapterInstance()); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）

// ── AC1：接口纯类型零运行时依赖 ──────────────────────────────────────────────

test('AC1 adapter.js 无运行时导出（纯类型擦除，零运行时依赖）', async () => {
  const mod = await import('../dist/l3/adapter.js');
  assert.deepStrictEqual(Object.keys(mod), []);
});

// ── AC2：env 旋钮（env > 默认）──────────────────────────────────────────────

test('AC2 MYTERMINAL_L3_ENABLED 默认 true（未设置 / 空串）', () => {
  assert.strictEqual(l3Enabled({}), true);
  assert.strictEqual(l3Enabled({ MYTERMINAL_L3_ENABLED: '' }), true);
  assert.strictEqual(l3Enabled({ MYTERMINAL_L3_ENABLED: '   ' }), true);
});

test('AC2 MYTERMINAL_L3_ENABLED truthy → true', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes', 'ON']) {
    assert.strictEqual(l3Enabled({ MYTERMINAL_L3_ENABLED: v }), true, `value=${v}`);
  }
});

test('AC2 MYTERMINAL_L3_ENABLED falsy/其他 → false（一键关 L3）', () => {
  for (const v of ['0', 'false', 'off', 'no', 'garbage']) {
    assert.strictEqual(l3Enabled({ MYTERMINAL_L3_ENABLED: v }), false, `value=${v}`);
  }
});

test('AC2 MYTERMINAL_L3_MODEL_PATH 默认 + 覆盖', () => {
  assert.strictEqual(l3ModelPath({}), DEFAULT_L3_MODEL_PATH);
  assert.strictEqual(l3ModelPath({ MYTERMINAL_L3_MODEL_PATH: '' }), DEFAULT_L3_MODEL_PATH);
  assert.strictEqual(l3ModelPath({ MYTERMINAL_L3_MODEL_PATH: '   ' }), DEFAULT_L3_MODEL_PATH);
  assert.strictEqual(l3ModelPath({ MYTERMINAL_L3_MODEL_PATH: '/custom/Qwen3.5-3B-Q4_K_M.gguf' }), '/custom/Qwen3.5-3B-Q4_K_M.gguf');
});

// ── AC3：单例懒加载常驻 + reset 释放 ─────────────────────────────────────────

test('AC3 冷加载只在首次：两次 getL3Adapter 返回同一实例', () => {
  const a = getL3Adapter();
  const b = getL3Adapter();
  assert.strictEqual(a, b);
});

test('AC3 reset 释放后重新懒加载出新实例', () => {
  const a = getL3Adapter();
  resetL3Adapter();
  const b = getL3Adapter();
  assert.notStrictEqual(a, b);
});

test('AC3 注入语义：单例已创建后 register 不生效，reset 后注入才生效', () => {
  const cached = getL3Adapter(); // 默认 unavailable 已缓存
  const fake = fakeAdapter();
  registerAdapterFactory(() => fake);
  assert.strictEqual(getL3Adapter(), cached); // 常驻，不随注册翻转

  resetL3Adapter();
  registerAdapterFactory(() => fake);
  assert.strictEqual(getL3Adapter(), fake); // reset 后懒加载走注入工厂
});

// ── AC4：默认 unavailable + fake 三路径 ──────────────────────────────────────

test('AC4 默认 llama adapter（T12）：supportsStructuredOutput=true + id=qwen3.5-2b，懒加载不触发模型', () => {
  resetL3Adapter(); // #101：先全清——本测试断言"无 factory 时默认 LlamaLocalAdapter"，防 bun 共享 worker 下其他文件残留的 fake factory 污染
  const adapter = getL3Adapter();
  assert.strictEqual(adapter.supportsStructuredOutput, true);
  assert.strictEqual(adapter.id, 'qwen3.5-2b');
  // 不调 isReady/complete——那会动态 import node-llama-cpp 并尝试加载 ~1.3GB 真模型；
  // 真模型不进自动化测试，行为验证走 registerAdapterFactory 注入 fake（下方 AC4 注入用例）。
});

test('AC4 注入 fake（成功路径）：getL3Adapter 返回注入实例 + complete=stop', async () => {
  const fake = fakeAdapter({ ready: true, mode: 'success' });
  registerAdapterFactory(() => fake);
  const adapter = getL3Adapter();
  assert.strictEqual(adapter, fake);
  assert.strictEqual(adapter.supportsStructuredOutput, true);
  assert.strictEqual(await adapter.isReady(), true);
  const result = await adapter.complete({ instruction: 'parse', schema: { type: 'object' } });
  assert.strictEqual(result.finishReason, 'stop');
  assert.notStrictEqual(result.object, null);
});

test('AC4 注入 fake（超时路径）：complete=timeout + object=null', async () => {
  const fake = fakeAdapter({ ready: true, mode: 'timeout' });
  registerAdapterFactory(() => fake);
  const adapter = getL3Adapter();
  const result = await adapter.complete({ instruction: 'parse', schema: {} });
  assert.strictEqual(result.finishReason, 'timeout');
  assert.strictEqual(result.object, null);
});

test('AC4 注入 fake（不可用路径）：isReady=false + supportsStructuredOutput=false', async () => {
  const fake = fakeAdapter({ ready: false, mode: 'unavailable' });
  registerAdapterFactory(() => fake);
  const adapter = getL3Adapter();
  assert.strictEqual(adapter.supportsStructuredOutput, false);
  assert.strictEqual(await adapter.isReady(), false);
});
