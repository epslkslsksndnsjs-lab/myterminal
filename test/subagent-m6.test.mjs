// M6 LLM 适配层测试——token-counter + llm-adapter
// 决策 14 / 21 / 24 / 27 / 29
// 目标：≥ 20 用例，覆盖率 ≥ 90%

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

// ── Import 构建产物 ──

import {
  estimateTokens,
  estimateMessageTokens,
} from '../dist/subagent/token-counter.js';

import {
  AnthropicAdapter,
  LlmError,
  collectStream,
  createAdapter,
  normalizeMessages,
  STREAM_IDLE_TIMEOUT_MS,
} from '../dist/subagent/llm-adapter.js';

// ═══════════════════════════════════════════════
// Fake fetch 工具函数
// ═══════════════════════════════════════════════

/** 创建 SSE 响应的 fake fetch */
function sseFakeResponse(sseText, status = 200, headers = {}) {
  const encoder = new TextEncoder();
  const chunks = [encoder.encode(sseText)];
  let index = 0;
  let closed = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      }
      if (index >= chunks.length && !closed) {
        closed = true;
        controller.close();
      }
    }
  });
  return new Response(stream, { status, headers });
}

/** 创建一个"发一个 chunk 后永远不关闭"的流（测试 Watchdog 用） */
function hangingStreamResponse(sseText, status = 200) {
  const encoder = new TextEncoder();
  let sent = false;
  const stream = new ReadableStream({
    async pull(controller) {
      if (!sent) {
        controller.enqueue(encoder.encode(sseText));
        sent = true;
      }
      // 不 close——模拟连接挂起
      await new Promise(() => {}); // never resolves
    }
  });
  return new Response(stream, { status });
}

/** 非流式 JSON 响应 */
function jsonFakeResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 创建 fake fetch——始终返回同一个 response */
function fakeFetchOnce(response) {
  return async () => response;
}

/** 创建 fake fetch——按顺序返回（每次调用消费一个） */
function fakeFetchSequence(responses) {
  let i = 0;
  return async () => {
    if (i >= responses.length) throw new Error('No more responses');
    return responses[i++];
  };
}

/** 创建简单的 chatParams 夹具 */
function makeChatParams(overrides = {}) {
  return {
    model: 'gpt-4o',
    system: 'You are a helpful assistant.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ],
    tools: [],
    maxTokens: 4096,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════
// 第一部分：token-counter 测试（决策 29）
// ═══════════════════════════════════════════════

// ── 用例 1：estimateTokens ──

describe('subagent-m6', () => {
test('estimateTokens — 基本文本', () => {
  assert.equal(estimateTokens('abcd'), 2); // 4 chars / 4 * 4/3 = 1.33 → ceil = 2
});

test('estimateTokens — 空字符串', () => {
  assert.equal(estimateTokens(''), 0);
});

test('estimateTokens — 中文文本', () => {
  // 每个汉字 1 char，4 chars ≈ 1 token
  const result = estimateTokens('你好世界');
  assert.ok(result > 0);
  assert.equal(typeof result, 'number');
});

// ── 用例 2：estimateMessageTokens ──

test('estimateMessageTokens — 混合内容块计数', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Hello world' },                // ~4 tokens
        { type: 'tool_result', tool_use_id: '1', content: 'result text', is_error: false }, // ~3 tokens
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will help' },                 // ~3 tokens
        { type: 'tool_use', id: '2', name: 'read', input: { path: '/tmp' } }, // ~3 tokens for JSON
      ],
    },
  ];
  const tokens = estimateMessageTokens(messages);
  // 手动估算：text: 11+10=21/4*4/3=7; tool_result: 11/4*4/3=4; tool_use JSON: ~14/4*4/3=5; 2 msg overhead=8; total~24
  assert.ok(tokens > 10, `Expected > 10, got ${tokens}`);
  assert.ok(tokens < 50, `Expected < 50, got ${tokens}`);
  assert.equal(typeof tokens, 'number');
});

test('estimateMessageTokens — 含 image block', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', source: 'base64...' },
      ],
    },
  ];
  const tokens = estimateMessageTokens(messages);
  // image = 2000 + overhead 4 = 2004
  assert.ok(tokens >= 2000, `Expected >= 2000, got ${tokens}`);
});

// ── 用例 3（已移除）：getModelContextWindow / getAutoCompactThreshold ──
// ADR-0045 D5：上下文窗口与压缩阈值改由 SubagentSettings 直供，不再按模型名查表；
// 这两个函数已从 token-counter 删除，相关用例随之移除。

// ═══════════════════════════════════════════════
// 第二部分：normalizeMessages 测试（决策 24）
// ═══════════════════════════════════════════════

// ── 用例 4：合并连续同 role ──

test('normalizeMessages — 合并连续同 role 消息', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'A' }] },
    { role: 'user', content: [{ type: 'text', text: 'B' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'C' }] },
  ];
  const result = normalizeMessages(messages);
  assert.equal(result.length, 2);
  assert.equal(result[0].role, 'user');
  assert.equal(result[0].content.length, 2); // A + B merged
  assert.equal(result[0].content[0].text, 'A');
  assert.equal(result[0].content[1].text, 'B');
});

test('normalizeMessages — 空数组', () => {
  const result = normalizeMessages([]);
  assert.equal(result.length, 0);
});

// ── 用例 5：孤儿 tool_use 补齐 ──

test('normalizeMessages — 孤儿 tool_use 自动补 interrupted tool_result', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: '/tmp' } },
      ],
    },
  ];
  const result = normalizeMessages(messages);
  // 应该有 2 条消息：assistant（tool_use） + user（孤儿补齐的 tool_result）
  assert.ok(result.length >= 2, `Expected >= 2, got ${result.length}`);
  // 最后一条 user 消息应包含补齐的 tool_result
  const lastMsg = result[result.length - 1];
  assert.equal(lastMsg.role, 'user');
  const toolResult = lastMsg.content.find(b => b.type === 'tool_result');
  assert.ok(toolResult, 'Should have tool_result');
  assert.equal(toolResult.tool_use_id, 'toolu_1');
  assert.equal(toolResult.is_error, true);
  assert.ok(toolResult.content.includes('interrupted'));
});

test('normalizeMessages — tool_result 保持配对', () => {
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok', is_error: false }],
    },
  ];
  const result = normalizeMessages(messages);
  // 配对完整，不应有额外补齐
  const userMsg = result.find(m => m.role === 'user');
  const toolResults = userMsg.content.filter(b => b.type === 'tool_result');
  assert.equal(toolResults.length, 1); // 只有原有的 1 个
});

// ═══════════════════════════════════════════════


// ── 用例 7：SSE 文本流 ──


// ── 用例 8：SSE tool_calls 流 ──


// ── 用例 9：include_usage 验证 ──


// ── 用例 10：content 检测（不看 stop_reason） ──


// ═══════════════════════════════════════════════
// 第四部分：AnthropicAdapter 测试
// ═══════════════════════════════════════════════

// ── 用例 11：请求头 + body 转换 ──

test('AnthropicAdapter — 请求头含 x-api-key + anthropic-version', async () => {
  let capturedHeaders;
  let capturedBody;
  const fakeFetch = async (url, init) => {
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return sseFakeResponse(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":5}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
  };

  const adapter = new AnthropicAdapter('sk-ant-test', fakeFetch);
  const chunks = [];
  for await (const chunk of adapter.stream(makeChatParams({ model: 'claude-sonnet-4' }), new AbortController().signal)) {
    chunks.push(chunk);
  }

  assert.ok(capturedHeaders['x-api-key'], 'Should have x-api-key header');
  assert.ok(capturedHeaders['anthropic-version'], 'Should have anthropic-version header');
  assert.equal(capturedBody.model, 'claude-sonnet-4');
  assert.equal(capturedBody.stream, true);
  // 验证 system 在顶层
  assert.ok(capturedBody.system, 'Should have system field');

  // 验证流式输出
  const textChunks = chunks.filter(c => c.type === 'text_delta');
  assert.equal(textChunks.length, 1);
  assert.equal(textChunks[0].text, 'Hi');

  const end = chunks.find(c => c.type === 'message_end');
  assert.ok(end);
});

// ── 用例 12：content_block_start/delta/stop 事件 ──

test('AnthropicAdapter — tool_use content_block 事件流转', async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":10}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/tmp\\"}"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';

  const adapter = new AnthropicAdapter('sk-ant-test', fakeFetchOnce(sseFakeResponse(sse)));
  const chunks = [];
  for await (const chunk of adapter.stream(makeChatParams(), new AbortController().signal)) {
    chunks.push(chunk);
  }

  const startChunk = chunks.find(c => c.type === 'tool_call_start');
  assert.ok(startChunk);
  assert.equal(startChunk.name, 'read');
  assert.equal(startChunk.id, 'toolu_1');

  const deltaChunk = chunks.find(c => c.type === 'tool_call_delta');
  assert.ok(deltaChunk);
  assert.ok(deltaChunk.jsonFragment.includes('/tmp'));

  const endChunk = chunks.find(c => c.type === 'tool_call_end');
  assert.ok(endChunk);
});

// ═══════════════════════════════════════════════
// 第五部分：错误分类测试（决策 21）
// ═══════════════════════════════════════════════

// ── 用例 13：429 rate_limit + Retry-After ──

test('错误分类 — 429 + Retry-After → rate_limit', async () => {
  const fakeFetch = async () => new Response('Rate limited', {
    status: 429,
    headers: { 'Retry-After': '3' },
  });

  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);
  try {
    const chunks = [];
    for await (const chunk of adapter.stream(makeChatParams(), new AbortController().signal)) {
      chunks.push(chunk);
    }
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof LlmError);
    assert.equal(err.kind, 'rate_limit');
    assert.equal(err.retryAfterMs, 3000);
    assert.equal(err.status, 429);
  }
});

// ── 用例 14：401 auth → 不重试 ──

test('错误分类 — 401 → auth（消息含 API key 指引）', async () => {
  const fakeFetch = async () => new Response('Unauthorized', { status: 401 });

  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);
  try {
    const chunks = [];
    for await (const chunk of adapter.stream(makeChatParams(), new AbortController().signal)) {
      chunks.push(chunk);
    }
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof LlmError);
    assert.equal(err.kind, 'auth');
    assert.ok(err.message.toLowerCase().includes('api key'));
  }
});

// ── 用例 15：529 server_overload ──

test('错误分类 — 529 → server_overload', async () => {
  const fakeFetch = async () => new Response('Overloaded', { status: 529 });

  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);
  try {
    const chunks = [];
    for await (const chunk of adapter.stream(makeChatParams(), new AbortController().signal)) {
      chunks.push(chunk);
    }
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof LlmError);
    assert.equal(err.kind, 'server_overload');
  }
});

// ── 用例 16：400 prompt_too_long ──

test('错误分类 — 400 含 context_length → prompt_too_long', async () => {
  const fakeFetch = async () => new Response(
    '{"error":{"message":"This model maximum context length is 128000 tokens"}}',
    { status: 400 },
  );

  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);
  try {
    const chunks = [];
    for await (const chunk of adapter.stream(makeChatParams(), new AbortController().signal)) {
      chunks.push(chunk);
    }
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof LlmError);
    assert.equal(err.kind, 'prompt_too_long');
  }
});

// ── 用例 17：网络错误 → connection ──

test('错误分类 — fetch reject (TypeError) → connection', async () => {
  const fakeFetch = async () => { throw new TypeError('fetch failed'); };

  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);
  try {
    const chunks = [];
    for await (const chunk of adapter.stream(makeChatParams(), new AbortController().signal)) {
      chunks.push(chunk);
    }
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof LlmError);
    assert.equal(err.kind, 'connection');
  }
});

// ── 用例 18：abort 不被包装 ──

test('错误分类 — signal.abort() → AbortError 原样抛出', async () => {
  const fakeFetch = async () => {
    throw new DOMException('The operation was aborted', 'AbortError');
  };

  const controller = new AbortController();
  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);

  try {
    const chunks = [];
    for await (const chunk of adapter.stream(makeChatParams(), controller.signal)) {
      chunks.push(chunk);
    }
    assert.fail('Should have thrown');
  } catch (err) {
    // AbortError 应该原样抛出，不被包装成 LlmError
    assert.ok(err instanceof DOMException);
    assert.equal(err.name, 'AbortError');
  }
});

// ═══════════════════════════════════════════════
// 第六部分：Watchdog + 回退测试（决策 27）
// ═══════════════════════════════════════════════

// ── 用例 19：Watchdog 超时 ──

test('Watchdog — 流挂起后超时→connection 错误', async () => {
  let callCount = 0;
  // 第一次调用 stream 永远挂起（等待 signal abort），第二次调用 create 立即失败
  const fakeFetch = async (url, init) => {
    callCount++;
    if (callCount === 1) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
        // 不 resolve——模拟挂起，直到 watchdog 触发 abort
      });
    }
    // fallback create() 也失败
    throw new TypeError('Network error');
  };

  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);
  try {
    await collectStream({
      adapter,
      chatParams: makeChatParams(),
      signal: new AbortController().signal,
      onChunk: () => {},
      idleTimeoutMs: 100,
    });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.equal(callCount, 2, 'Should call stream + fallback create');
    assert.ok(err instanceof LlmError, `Expected LlmError, got ${err?.constructor?.name}`);
    assert.equal(err.kind, 'connection');
  }
});

// ── 用例 20：不因已产出 tool_call 回退 ──

test('回退 — 已产出完整 tool_call_end 则不回退', async () => {
  let callCount = 0;
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":10}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/tmp\\"}"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';

  const fakeFetch = async () => {
    callCount++;
    if (callCount === 1) return sseFakeResponse(sse);
    // 不应被调用第二遍（tool_call_end 已发生 = 已产出完整结果）
    return jsonFakeResponse({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'fallback' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  };

  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);
  const result = await collectStream({
    adapter,
    chatParams: makeChatParams({
      tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object', properties: {} } }],
    }),
    signal: new AbortController().signal,
    onChunk: () => {},
    idleTimeoutMs: 0,
  });

  // 流正常完成，tool_call 已产出——不应回退到 create()
  assert.equal(callCount, 1, 'create() 不应被调用（tool_call_end 已发生）');
  assert.ok(result.hadToolCalls || result.message.content.some(b => b.type === 'tool_use'),
    'Should have tool calls');
});

// ── 用例 21：流式失败回退到 create() ──

test('回退 — 流式开头失败 → 自动回退 create()', async () => {
  let callCount = 0;
  const fakeFetch = async () => {
    callCount++;
    if (callCount === 1) {
      // 第一次：流式失败（网络错误类）
      throw new TypeError('fetch failed');
    }
    // 第二次：非流式成功（Anthropic 形状）
    return jsonFakeResponse({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Fallback response' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    });
  };

  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);
  const result = await collectStream({
    adapter,
    chatParams: makeChatParams(),
    signal: new AbortController().signal,
    onChunk: () => {},
    idleTimeoutMs: 0,
  });

  assert.equal(callCount, 2, 'Should have called fetch twice (stream + fallback)');
  assert.equal(result.hadToolCalls, false);
  assert.ok(result.message.content.some(b => b.type === 'text' && b.text.includes('Fallback')));
});

// ═══════════════════════════════════════════════
// 第七部分：集成测试（决策 24 + 27）
// ═══════════════════════════════════════════════

// ── 用例 22：两轮对话集成 ──

test('集成 — 两轮对话（tool_call + tool_result + 最终文本）', async () => {
  let callCount = 0;
  const fakeFetch = async () => {
    callCount++;
    if (callCount === 1) {
      // 第 1 轮：LLM 流式返回 text + tool_call（Anthropic SSE）
      return sseFakeResponse(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"r1","usage":{"input_tokens":15}}}\n\n' +
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check that."}}\n\n' +
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/tmp/test\\"}"}}\n\n' +
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      );
    }
    // 第 2 轮：LLM 流式返回纯文本（Anthropic SSE）
    return sseFakeResponse(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"r2","usage":{"input_tokens":20}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"File contents: hello"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
  };

  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);

  // 第 1 轮
  const round1 = await collectStream({
    adapter,
    chatParams: makeChatParams({
      tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    }),
    signal: new AbortController().signal,
    onChunk: () => {},
    idleTimeoutMs: 0,
  });

  assert.equal(callCount, 1);
  assert.equal(round1.hadToolCalls, true);
  assert.ok(round1.usage.input_tokens > 0);

  // 构建 tool_result 后，第 2 轮
  const round2Messages = [
    ...makeChatParams().messages,
    round1.message,
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'hello',
        is_error: false,
      }],
    },
  ];

  const round2 = await collectStream({
    adapter,
    chatParams: makeChatParams({ messages: round2Messages, tools: [] }),
    signal: new AbortController().signal,
    onChunk: () => {},
    idleTimeoutMs: 0,
  });

  assert.equal(callCount, 2);
  assert.equal(round2.hadToolCalls, false);
  assert.ok(round2.usage.input_tokens > 0);
  const text = round2.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  assert.ok(text.includes('hello'));
});


// ═══════════════════════════════════════════════
// 第八部分：createAdapter 工厂（决策 14）
// ═══════════════════════════════════════════════

// ── 用例 23：createAdapter 按 settings 创建（ADR-0045 spine：单适配器，配置即端点）──

test('createAdapter — returns AnthropicAdapter from settings.apiKey/baseUrl', () => {
  const adapter = createAdapter({
    enabled: true,
    model: 'claude-sonnet-4-20250514',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-test',
    maxTurns: 50,
    timeoutSec: 300,
    maxParallel: 2,
  });
  assert.equal(adapter.provider, 'anthropic');
  assert.ok(adapter instanceof AnthropicAdapter);
});

test('createAdapter — 缺少 apiKey/baseUrl/model 抛错', () => {
  assert.throws(() => {
    createAdapter({
      enabled: true,
      model: '',
      baseUrl: '',
      apiKey: '',
      maxTurns: 50,
      timeoutSec: 300,
      maxParallel: 2,
    });
  }, /Subagent apiKey, baseUrl and model are required/);
});

// ═══════════════════════════════════════════════
// 第九部分：deepseek 特定测试 + 补充覆盖
// ═══════════════════════════════════════════════


test('STREAM_IDLE_TIMEOUT_MS 为 60_000', () => {
  assert.equal(STREAM_IDLE_TIMEOUT_MS, 60_000);
});

// ── 额外覆盖：AnthropicAdapter create() 非流式 ──

test('AnthropicAdapter — create() 非流式', async () => {
  const fakeFetch = async () => jsonFakeResponse({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Non-streaming response' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 },
  });

  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);
  const result = await adapter.create(makeChatParams({ model: 'claude-sonnet-4' }), new AbortController().signal);

  assert.equal(result.message.role, 'assistant');
  assert.ok(result.message.content.some(b => b.type === 'text'));
  assert.ok(result.usage.input_tokens > 0);
  assert.ok(result.usage.output_tokens > 0);
});


// ── 额外覆盖：collectStream 中 JSON 解析失败降级 ──

test('collectStream — JSON 解析失败 → 文本降级', async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":5}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"bad","input":{}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"not valid json"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';

  const adapter = new AnthropicAdapter('sk-ant', fakeFetchOnce(sseFakeResponse(sse)));
  const result = await collectStream({
    adapter,
    chatParams: makeChatParams(),
    signal: new AbortController().signal,
    onChunk: () => {},
    idleTimeoutMs: 0,
  });

  // 即使 JSON 解析失败，也不应抛错——tool_use block 包含 _parse_error
  const toolUses = result.message.content.filter(b => b.type === 'tool_use');
  assert.equal(toolUses.length, 1);
  assert.equal(toolUses[0].input._parse_error, true);
});

// ── 额外覆盖：AnthropicAdapter create() HTTP 错误 ──

test('AnthropicAdapter — create() HTTP 错误分类', async () => {
  const fakeFetch = async () => new Response('Unauthorized', { status: 401 });

  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);
  try {
    await adapter.create(makeChatParams({ model: 'claude-sonnet-4' }), new AbortController().signal);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof LlmError);
    assert.equal(err.kind, 'auth');
  }
});

// ── 额外覆盖：AnthropicAdapter stream 含 tools ──

test('AnthropicAdapter — stream 含 tools 参数', async () => {
  let capturedBody;
  const fakeFetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return sseFakeResponse(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":5}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
  };

  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);
  const params = makeChatParams({
    model: 'claude-sonnet-4',
    tools: [{ name: 'read', description: 'Read file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  });

  const chunks = [];
  for await (const chunk of adapter.stream(params, new AbortController().signal)) {
    chunks.push(chunk);
  }

  // 验证 tools 已传递
  assert.ok(capturedBody.tools, 'Tools should be in request body');
  assert.equal(capturedBody.tools.length, 1);
  assert.equal(capturedBody.tools[0].name, 'read');
});

// ── 额外覆盖：AnthropicAdapter create() 含 tools ──

test('AnthropicAdapter — create() 含 tools', async () => {
  let capturedBody;
  const fakeFetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return jsonFakeResponse({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok with tools' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
  };

  const adapter = new AnthropicAdapter('sk-ant', fakeFetch);
  const result = await adapter.create(makeChatParams({
    model: 'claude-sonnet-4',
    tools: [{ name: 'write', description: 'Write file', input_schema: { type: 'object', properties: {} } }],
  }), new AbortController().signal);

  assert.ok(result.message.content.some(b => b.type === 'text'));
  assert.ok(capturedBody.tools);
  assert.equal(capturedBody.tools.length, 1);
  assert.equal(capturedBody.tools[0].name, 'write');
});

// ── 额外覆盖：normalizeMessages 边界情况 ──

test('normalizeMessages — 多条孤儿 tool_use', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'read', input: {} },
        { type: 'tool_use', id: 't2', name: 'write', input: {} },
      ],
    },
  ];
  const result = normalizeMessages(messages);
  const userMsg = result.find(m => m.role === 'user');
  assert.ok(userMsg, 'Should have user message with orphan results');
  const toolResults = userMsg.content.filter(b => b.type === 'tool_result');
  assert.equal(toolResults.length, 2);
  assert.equal(toolResults[0].is_error, true);
  assert.equal(toolResults[1].is_error, true);
});
});
