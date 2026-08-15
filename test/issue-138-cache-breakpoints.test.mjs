// ADR-0048 T7 (#138)：提示词缓存断点（D10）— 契约测试
//
// 锁定四项 AC：
//   AC1 首请求 system/tools 两处 cache_control 断点（顺序 system→tools，ephemeral；
//       tools 断点只在末项——全项打点 8 工具=9 断点超网关 4 断点上限必 400）
//   AC2 4xx → 去断点重试一次 + 会话级禁用（不反复探测）；5xx 不重试不置位（瞬态不误禁）；
//       宽容派（非 4xx）不降级
//   AC3 三处解析点（message_start/message_delta/非流式）补读 cache_creation_input_tokens
//        + CostTracker 账本含 cacheCreationTokens（addUsage 累加、getUsage 输出）
//   AC4 T1 结论引用：宽容派判定（cache_read 恒 0）只记账展示不切行为
//
// 测试方式：import ../dist/subagent/llm-adapter.js + cost-tracker.js（build 产物）。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter, buildBody } from '../dist/subagent/llm-adapter.js';
import { CostTracker } from '../dist/subagent/cost-tracker.js';

// ═══════════════════════════════════════════════
// 工具函数（照 issue-66 惯例）
// ═══════════════════════════════════════════════

function jsonFakeResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseFakeResponse(sseText, status = 200) {
  const encoder = new TextEncoder();
  const chunks = [encoder.encode(sseText)];
  let index = 0;
  let closed = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      if (index >= chunks.length && !closed) {
        closed = true;
        controller.close();
      }
    },
  });
  return new Response(stream, { status });
}

const SSE_STOP = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":7,"cache_read_input_tokens":0}}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

function makeChatParams(overrides = {}) {
  return {
    model: 'deepseek-v4-flash',
    system: 'You are a cache probe.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    tools: [{ name: 'echo', description: 'Echo input.', input_schema: { type: 'object', properties: {}, required: [] } }],
    maxTokens: 4096,
    ...overrides,
  };
}

const NEVER_ABORT = new AbortController().signal;

// ═══════════════════════════════════════════════
// AC1：断点组装
// ═══════════════════════════════════════════════

test('AC1 buildBody 带断点：system 首块 + tools 末项 cache_control ephemeral，system 先于 tools', () => {
  const twoTools = makeChatParams({
    tools: [
      { name: 'echo', description: 'Echo input.', input_schema: { type: 'object', properties: {}, required: [] } },
      { name: 'grep2', description: 'Grep files.', input_schema: { type: 'object', properties: {}, required: [] } },
    ],
  });
  const body = buildBody(twoTools, true);
  assert.ok(Array.isArray(body.system), 'system 应为块数组');
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  // 断点只打末项工具（前缀缓存语义：末项一个断点覆盖全部工具前缀；全项打点 8 工具=9 断点超网关 4 断点上限必 400）
  assert.equal(body.tools[0].cache_control, undefined, '非末项工具不打断点');
  assert.deepEqual(body.tools[1].cache_control, { type: 'ephemeral' }, '末项工具带断点');
  const json = JSON.stringify(body);
  assert.equal((json.match(/cache_control/g) ?? []).length, 2, '全请求恰好 2 个断点（system+末项工具）');
  const sysIdx = json.indexOf('"system"');
  const toolsIdx = json.indexOf('"tools"');
  assert.ok(sysIdx !== -1 && toolsIdx !== -1 && sysIdx < toolsIdx, 'system 应先于 tools');
});

test('AC1 buildBody 无断点：system 纯字符串、tools 无 cache_control（现状逐字兼容）', () => {
  const body = buildBody(makeChatParams(), false);
  assert.equal(typeof body.system, 'string');
  assert.equal(body.tools[0].cache_control, undefined);
  assert.equal(JSON.stringify(body).includes('cache_control'), false);
});

// ═══════════════════════════════════════════════
// AC2：4xx 降级（去断点重试一次 + 会话级禁用）
// ═══════════════════════════════════════════════

test('AC2 create 4xx 带断点 → 去断点重试一次成功；会话级禁用（后续调用不再带断点）', async () => {
  const seen = [];
  const adapter = new AnthropicAdapter('sk-test', async (_url, init) => {
    const body = JSON.parse(init.body);
    const hasBreak = JSON.stringify(body).includes('cache_control');
    // 带断点 → 400 拒绝（严格派网关）；无断点 → 200 成功
    if (hasBreak) {
      seen.push({ body, status: 400 });
      return jsonFakeResponse({ type: 'error', error: { message: 'unrecognized field cache_control' } }, 400);
    }
    seen.push({ body, status: 200 });
    return jsonFakeResponse({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 } });
  });

  const result = await adapter.create(makeChatParams(), NEVER_ABORT);
  assert.equal(result.message.content[0].type, 'text');
  assert.equal(seen.length, 2, '应恰好请求两次（带断点 + 去断点重试）');
  assert.equal(seen[0].status, 400);
  assert.equal(JSON.stringify(seen[0].body).includes('cache_control'), true, '首次带断点');
  assert.equal(seen[1].status, 200);
  assert.equal(JSON.stringify(seen[1].body).includes('cache_control'), false, '重试去断点');

  // 会话级禁用：第二次 create 调用不再带断点（不反复探测）
  const again = await adapter.create(makeChatParams(), NEVER_ABORT);
  assert.equal(again.message.content[0].type, 'text');
  assert.equal(seen.length, 3, '第二次调用只应请求一次（不再带断点）');
  assert.equal(JSON.stringify(seen[2].body).includes('cache_control'), false);
});

test('AC2 stream 4xx 带断点 → 去断点重试一次；宽容派（200）不降级不置位', async () => {
  const seen = [];
  const adapter = new AnthropicAdapter('sk-test', async (_url, init) => {
    const body = JSON.parse(init.body);
    const hasBreak = JSON.stringify(body).includes('cache_control');
    seen.push({ body, status: hasBreak ? 400 : 200 });
    if (hasBreak) {
      return jsonFakeResponse({ type: 'error', error: { message: 'cache_control not allowed' } }, 400);
    }
    return sseFakeResponse(SSE_STOP);
  });

  const chunks = [];
  for await (const chunk of adapter.stream(makeChatParams(), NEVER_ABORT)) chunks.push(chunk);
  assert.equal(chunks.some((c) => c.type === 'message_end'), true);
  assert.equal(seen.length, 2);
  assert.equal(JSON.stringify(seen[0].body).includes('cache_control'), true);
  assert.equal(JSON.stringify(seen[1].body).includes('cache_control'), false, '重试去断点');
});

test('AC2 5xx 带断点 → 不重试不置位（瞬态过载不误禁缓存），后续调用仍带断点', async () => {
  const seen = [];
  const adapter = new AnthropicAdapter('sk-test', async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ body });
    if (seen.length === 1) {
      return jsonFakeResponse({ type: 'error', error: { message: 'overloaded' } }, 500);
    }
    return jsonFakeResponse({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 } });
  });

  await assert.rejects(adapter.create(makeChatParams(), NEVER_ABORT));
  assert.equal(seen.length, 1, '5xx 不触发去断点重试');
  assert.equal(JSON.stringify(seen[0].body).includes('cache_control'), true, '首次仍带断点');

  const ok = await adapter.create(makeChatParams(), NEVER_ABORT);
  assert.equal(ok.message.content[0].type, 'text');
  assert.equal(seen.length, 2);
  assert.equal(JSON.stringify(seen[1].body).includes('cache_control'), true, '5xx 后会话未被误禁，仍带断点');
});

test('AC4 宽容派（200 恒响应，cache_read=0）不降级：后续调用仍带断点（只记账展示不切行为）', async () => {
  const seen = [];
  const adapter = new AnthropicAdapter('sk-test', async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ body });
    // 宽容派：200，无 cache_creation、cache_read 恒 0
    return jsonFakeResponse({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0 } });
  });

  await adapter.create(makeChatParams(), NEVER_ABORT);
  await adapter.create(makeChatParams(), NEVER_ABORT);
  assert.equal(seen.length, 2);
  assert.equal(JSON.stringify(seen[0].body).includes('cache_control'), true, '首次带断点');
  assert.equal(JSON.stringify(seen[1].body).includes('cache_control'), true, '宽容派下不切换行为，继续带断点');
});

// ═══════════════════════════════════════════════
// AC3：三处解析点补读 cache_creation_input_tokens
// ═══════════════════════════════════════════════

test('AC3 stream message_start 读 cache_creation_input_tokens → message_end 带出', async () => {
  const adapter = new AnthropicAdapter('sk-test', async () => sseFakeResponse(SSE_STOP));
  const chunks = [];
  for await (const chunk of adapter.stream(makeChatParams(), NEVER_ABORT)) chunks.push(chunk);
  const end = chunks.find((c) => c.type === 'message_end');
  assert.ok(end && end.type === 'message_end');
  assert.equal(end.usage.cache_creation_input_tokens, 7);
  assert.equal(end.usage.cache_read_input_tokens, 0);
});

test('AC3 stream message_delta：output 更新、creation 沿用 message_start 已读值', async () => {
  const SSE_WITH_DELTA = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":7,"cache_read_input_tokens":0}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const adapter = new AnthropicAdapter('sk-test', async () => sseFakeResponse(SSE_WITH_DELTA));
  const chunks = [];
  for await (const chunk of adapter.stream(makeChatParams(), NEVER_ABORT)) chunks.push(chunk);
  const end = chunks.find((c) => c.type === 'message_end');
  assert.ok(end && end.type === 'message_end');
  assert.equal(end.usage.output_tokens, 25, 'message_delta 更新 output');
  assert.equal(end.usage.cache_creation_input_tokens, 7, 'creation 沿用 message_start 已读值');
  assert.equal(end.usage.cache_read_input_tokens, 0);
  assert.equal(end.stopReason, 'end_turn');
});

test('AC3 create 非流式读 cache_creation_input_tokens', async () => {
  const adapter = new AnthropicAdapter('sk-test', async () =>
    jsonFakeResponse({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 7 },
    }),
  );
  const { usage } = await adapter.create(makeChatParams(), NEVER_ABORT);
  assert.equal(usage.cache_creation_input_tokens, 7);
});

test('AC3 CostTracker 账本：addUsage 累加 cache_creation_input_tokens → getUsage().cacheCreationTokens', () => {
  const tracker = new CostTracker();
  tracker.addUsage({ input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 7 });
  tracker.addUsage({ input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 3 });
  const summary = tracker.getUsage();
  assert.equal(summary.cacheCreationTokens, 10, '7+3 累加');
  assert.equal(summary.inputTokens, 8);
  assert.equal(summary.cacheReadTokens, 0);
  // cache_creation 缺省（旧响应/宽容派）→ 账本加 0，不 NaN
  tracker.addUsage({ input_tokens: 1, output_tokens: 1 });
  assert.equal(tracker.getUsage().cacheCreationTokens, 10);
});
