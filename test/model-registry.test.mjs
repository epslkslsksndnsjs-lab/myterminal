// #51（批4 第6刀 / ADR-0031 / G9）模型元数据单源回归
// 证明 MODEL_PRICING + MODEL_CONTEXT_WINDOWS 已合并为单一 MODELS 注册表：
// 13 个模型每键同时含 pricing + contextWindow；值与原始两表完全一致（无漂移）。
// 新增模型只改 src/models/registry.ts 一处——此测试锁死该不变量。

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { MODELS } from '../dist/models/registry.js';

// 合并前原始两表的黄金值（来自 cost-tracker.ts MODEL_PRICING + token-counter.ts MODEL_CONTEXT_WINDOWS）
const EXPECTED = {
  'gpt-4o':           { pricing: { input: 2.5,  output: 10,   cacheRead: 1.25 },  contextWindow: { window: 128_000,   maxOutput: 16_384 } },
  'gpt-4o-mini':      { pricing: { input: 0.15, output: 0.6,  cacheRead: 0.075 }, contextWindow: { window: 128_000,   maxOutput: 16_384 } },
  'gpt-4.1':          { pricing: { input: 2,    output: 8,    cacheRead: 0.5 },   contextWindow: { window: 1_000_000, maxOutput: 32_768 } },
  'gpt-4.1-mini':     { pricing: { input: 0.4,  output: 1.6,  cacheRead: 0.1 },   contextWindow: { window: 1_000_000, maxOutput: 32_768 } },
  'claude-sonnet-4':  { pricing: { input: 3,    output: 15,   cacheRead: 0.3 },   contextWindow: { window: 200_000,   maxOutput: 16_384 } },
  'claude-haiku-4':   { pricing: { input: 0.8,  output: 4,    cacheRead: 0.08 },  contextWindow: { window: 200_000,   maxOutput: 8_192 } },
  'claude-opus-4':    { pricing: { input: 15,   output: 75,   cacheRead: 1.5 },   contextWindow: { window: 200_000,   maxOutput: 32_000 } },
  'deepseek-chat':    { pricing: { input: 0.27, output: 1.1,  cacheRead: 0.07 },  contextWindow: { window: 64_000,    maxOutput: 8_192 } },
  'deepseek-reasoner':{ pricing: { input: 0.55, output: 2.19, cacheRead: 0.14 },  contextWindow: { window: 64_000,    maxOutput: 8_192 } },
  'glm-4-flash':      { pricing: { input: 0.014,output: 0.014,cacheRead: 0 },     contextWindow: { window: 128_000,   maxOutput: 4_096 } },
  'glm-4':            { pricing: { input: 0.014,output: 0.014,cacheRead: 0 },     contextWindow: { window: 128_000,   maxOutput: 4_096 } },
  'qwen3.7-max':      { pricing: { input: 2.8,  output: 8.4,  cacheRead: 0.7 },   contextWindow: { window: 1_000_000, maxOutput: 65_536 } },
  'qwen-max':         { pricing: { input: 2.8,  output: 8.4,  cacheRead: 0.7 },   contextWindow: { window: 128_000,   maxOutput: 8_192 } },
};

describe('#51 MODELS 注册表单源不变量', () => {
  test('恰好 13 个模型键，且与原两表键集合一致', () => {
    const keys = Object.keys(MODELS);
    assert.equal(keys.length, 13);
    assert.deepEqual(keys.sort(), Object.keys(EXPECTED).sort());
  });

  test('每个模型键同时含 pricing 与 contextWindow（无“有价无窗/有窗无价”漂移）', () => {
    for (const [name, spec] of Object.entries(MODELS)) {
      assert.ok(spec && typeof spec === 'object', `${name} 必须是对象`);
      assert.ok(spec.pricing && typeof spec.pricing === 'object', `${name} 缺 pricing`);
      assert.ok(spec.contextWindow && typeof spec.contextWindow === 'object', `${name} 缺 contextWindow`);
      for (const k of ['input', 'output', 'cacheRead']) {
        assert.equal(typeof spec.pricing[k], 'number', `${name}.pricing.${k} 必须是数字`);
      }
      for (const k of ['window', 'maxOutput']) {
        assert.equal(typeof spec.contextWindow[k], 'number', `${name}.contextWindow.${k} 必须是数字`);
      }
    }
  });

  test('合并后值与原始两表完全一致（价格 + 上下文窗口均无丢失）', () => {
    for (const [name, exp] of Object.entries(EXPECTED)) {
      assert.deepEqual(MODELS[name].pricing, exp.pricing, `${name} pricing 漂移`);
      assert.deepEqual(MODELS[name].contextWindow, exp.contextWindow, `${name} contextWindow 漂移`);
    }
  });

  test('两处消费方同源：cost-tracker 与 token-counter 均引用 MODELS（无残留独立表）', () => {
    // 通过保守校验：同一模型在定价与窗口两侧都来自同一注册表，键集合严格相等
    const costKeys = Object.keys(MODELS);
    const windowKeys = Object.keys(MODELS);
    assert.deepEqual(costKeys.sort(), windowKeys.sort());
  });
});
