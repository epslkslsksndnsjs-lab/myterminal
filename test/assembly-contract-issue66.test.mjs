// Issue #66 锁定测试：NormalizedMessage 组装契约
// 铁律：先锁定 → 再动 → 再跑测试
// 本文件锁定 4 处组装点的输出形状，重构后不改一行仍全绿

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  AnthropicAdapter,
  collectStream,
  LlmError,
} from '../dist/subagent/llm-adapter.js';

// ═══════════════════════════════════════════════
// 工具函数
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
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      }
      if (index >= chunks.length && !closed) {
        closed = true;
        controller.close();
      }
    }
  });
  return new Response(stream, { status });
}

function makeChatParams(overrides = {}) {
  return {
    model: 'gpt-4o',
    system: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    tools: [],
    maxTokens: 4096,
    ...overrides,
  };
}

const NEVER_ABORT = new AbortController().signal;


// ═══════════════════════════════════════════════
// Site 2: AnthropicAdapter.create 组装形状
// ═══════════════════════════════════════════════

describe('issue66 assembly contract — AnthropicAdapter.create', () => {
  test('纯文本响应 → message shape', async () => {
    const adapter = new AnthropicAdapter('sk-ant-test', async () => jsonFakeResponse({
        content: [{ type: 'text', text: 'Hello from Claude' }],
        usage: { input_tokens: 12, output_tokens: 8 },
      }));
    const { message, usage } = await adapter.create(makeChatParams(), NEVER_ABORT);

    assert.equal(message.role, 'assistant');
    assert.deepEqual(message.content, [{ type: 'text', text: 'Hello from Claude' }]);
    assert.equal(usage.input_tokens, 12);
    assert.equal(usage.output_tokens, 8);
  });

  test('纯工具调用 → message shape', async () => {
    const adapter = new AnthropicAdapter('sk-ant-test', async () => jsonFakeResponse({
        content: [{
          type: 'tool_use',
          id: 'tu_1',
          name: 'write_file',
          input: { path: '/tmp/x', content: 'data' },
        }],
        usage: { input_tokens: 15, output_tokens: 20 },
      }));
    const { message } = await adapter.create(makeChatParams(), NEVER_ABORT);

    assert.equal(message.role, 'assistant');
    assert.equal(message.content.length, 1);
    assert.deepEqual(message.content[0], {
      type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: '/tmp/x', content: 'data' },
    });
  });

  test('文本+工具混合 → 保持顺序', async () => {
    const adapter = new AnthropicAdapter('sk-ant-test', async () => jsonFakeResponse({
        content: [
          { type: 'text', text: 'I will help.' },
          { type: 'tool_use', id: 'tu_2', name: 'bash', input: { command: 'pwd' } },
        ],
        usage: { input_tokens: 10, output_tokens: 10 },
      }));
    const { message } = await adapter.create(makeChatParams(), NEVER_ABORT);

    assert.equal(message.content.length, 2);
    assert.equal(message.content[0].type, 'text');
    assert.equal(message.content[1].type, 'tool_use');
  });

  test('工具在前文本在后 → 保持原始顺序（不重排为 text 在前）', async () => {
    const adapter = new AnthropicAdapter('sk-ant-test', async () => jsonFakeResponse({
        content: [
          { type: 'tool_use', id: 'tu_3', name: 'bash', input: { command: 'whoami' } },
          { type: 'text', text: 'Done. Here is the output.' },
        ],
        usage: { input_tokens: 10, output_tokens: 12 },
      }));
    const { message } = await adapter.create(makeChatParams(), NEVER_ABORT);

    assert.equal(message.content.length, 2);
    // 关键回归锁：原始顺序为 [tool_use, text]，绝不能重排成 [text, tool_use]
    assert.equal(message.content[0].type, 'tool_use');
    assert.equal(message.content[1].type, 'text');
    assert.deepEqual(message.content[0], {
      type: 'tool_use', id: 'tu_3', name: 'bash', input: { command: 'whoami' },
    });
    assert.deepEqual(message.content[1], { type: 'text', text: 'Done. Here is the output.' });
  });

  test('文本/工具交错 → 保持原始交错顺序', async () => {
    const adapter = new AnthropicAdapter('sk-ant-test', async () => jsonFakeResponse({
        content: [
          { type: 'text', text: 'First.' },
          { type: 'tool_use', id: 'tu_4', name: 'bash', input: { command: 'a' } },
          { type: 'text', text: 'Second.' },
        ],
        usage: { input_tokens: 10, output_tokens: 14 },
      }));
    const { message } = await adapter.create(makeChatParams(), NEVER_ABORT);

    assert.equal(message.content.length, 3);
    assert.deepEqual(message.content.map((b) => b.type), ['text', 'tool_use', 'text']);
  });

  test('cache_read_input_tokens 透传', async () => {
    const adapter = new AnthropicAdapter('sk-ant-test', async () => jsonFakeResponse({
        content: [{ type: 'text', text: 'cached' }],
        usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 80 },
      }));
    const { usage } = await adapter.create(makeChatParams(), NEVER_ABORT);

    assert.equal(usage.cache_read_input_tokens, 80);
  });

  test('空 content → 空数组', async () => {
    const adapter = new AnthropicAdapter('sk-ant-test', async () => jsonFakeResponse({
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      }));
    const { message } = await adapter.create(makeChatParams(), NEVER_ABORT);

    assert.deepEqual(message.content, []);
  });

  test('usage 缺失 → 归零', async () => {
    const adapter = new AnthropicAdapter('sk-ant-test', async () => jsonFakeResponse({
        content: [{ type: 'text', text: 'x' }],
      }));
    const { usage } = await adapter.create(makeChatParams(), NEVER_ABORT);

    assert.equal(usage.input_tokens, 0);
    assert.equal(usage.output_tokens, 0);
  });
});

// ═══════════════════════════════════════════════
// Site 3: collectStream 正常路径组装形状
// ═══════════════════════════════════════════════

describe('issue66 assembly contract — collectStream normal path', () => {
  test('纯文本流 → message shape + hadToolCalls=false', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      'data: {"type":"message_stop"}',
    ].join('\n') + '\n';

    const adapter = new AnthropicAdapter('sk-ant-test', async () => sseFakeResponse(sse));

    const chunks = [];
    const result = await collectStream({
      adapter,
      chatParams: makeChatParams(),
      signal: NEVER_ABORT,
      onChunk: (c) => chunks.push(c),
    });

    assert.equal(result.message.role, 'assistant');
    assert.deepEqual(result.message.content, [{ type: 'text', text: 'Hello world' }]);
    assert.equal(result.hadToolCalls, false);
    assert.equal(result.usage.input_tokens, 10);
    assert.equal(result.usage.output_tokens, 5);
  });

  test('工具调用流 → message shape + hadToolCalls=true', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":20}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"bash"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"ls\\"}"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}',
      'data: {"type":"message_stop"}',
    ].join('\n') + '\n';

    const adapter = new AnthropicAdapter('sk-ant-test', async () => sseFakeResponse(sse));

    const result = await collectStream({
      adapter,
      chatParams: makeChatParams(),
      signal: NEVER_ABORT,
      onChunk: () => {},
    });

    assert.equal(result.message.role, 'assistant');
    assert.equal(result.hadToolCalls, true);
    assert.equal(result.message.content.length, 1);
    assert.deepEqual(result.message.content[0], {
      type: 'tool_use', id: 'call_1', name: 'bash', input: { cmd: 'ls' },
    });
  });

  test('空流 → 空 content + hadToolCalls=false', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}',
      'data: {"type":"message_stop"}',
    ].join('\n') + '\n';

    const adapter = new AnthropicAdapter('sk-ant-test', async () => sseFakeResponse(sse));

    const result = await collectStream({
      adapter,
      chatParams: makeChatParams(),
      signal: NEVER_ABORT,
      onChunk: () => {},
    });

    assert.deepEqual(result.message.content, []);
    assert.equal(result.hadToolCalls, false);
  });

  test('工具 JSON 解析失败 → _parse_error 降级', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_x","name":"bash"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{bad"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
      'data: {"type":"message_stop"}',
    ].join('\n') + '\n';

    const adapter = new AnthropicAdapter('sk-ant-test', async () => sseFakeResponse(sse));

    const result = await collectStream({
      adapter,
      chatParams: makeChatParams(),
      signal: NEVER_ABORT,
      onChunk: () => {},
    });

    assert.deepEqual(result.message.content[0], {
      type: 'tool_use', id: 'call_x', name: 'bash',
      input: { _parse_error: true, raw: '{bad' },
    });
  });
});

// ═══════════════════════════════════════════════
// Site 4: collectStream 回退路径组装形状
// ═══════════════════════════════════════════════

describe('issue66 assembly contract — collectStream fallback path', () => {
  test('流失败 + 无完整 tool_call → 回退非流式 + re-emit 事件', async () => {
    let callCount = 0;
    const adapter = new AnthropicAdapter('sk-ant-test', async () => {
      callCount++;
      if (callCount === 1) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          pull(controller) {
            controller.enqueue(encoder.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n'));
            controller.error(new Error('network disconnect'));
          }
        });
        return new Response(stream, { status: 200 });
      }
      return jsonFakeResponse({
        content: [{ type: 'text', text: 'Fallback response' }],
        usage: { input_tokens: 8, output_tokens: 4 },
      });
    });

    const chunks = [];
    const result = await collectStream({
      adapter,
      chatParams: makeChatParams(),
      signal: NEVER_ABORT,
      onChunk: (c) => chunks.push(c),
    });

    // 回退结果形状
    assert.equal(result.message.role, 'assistant');
    assert.deepEqual(result.message.content, [{ type: 'text', text: 'Fallback response' }]);
    assert.equal(result.hadToolCalls, false);
    assert.equal(result.usage.input_tokens, 8);
    assert.equal(result.usage.output_tokens, 4);

    // re-emit 事件序列：text_delta + message_end
    const textDeltas = chunks.filter(c => c.type === 'text_delta');
    const messageEnds = chunks.filter(c => c.type === 'message_end');
    assert.ok(textDeltas.length >= 1, 'should re-emit text_delta');
    assert.equal(textDeltas[textDeltas.length - 1].text, 'Fallback response');
    assert.ok(messageEnds.length >= 1, 'should re-emit message_end');
    assert.equal(messageEnds[messageEnds.length - 1].usage.input_tokens, 8);
    assert.equal(messageEnds[messageEnds.length - 1].usage.output_tokens, 4);
  });

  test('回退非流式含工具 → hadToolCalls=true + 无 text_delta', async () => {
    let callCount = 0;
    const adapter = new AnthropicAdapter('sk-ant-test', async () => {
      callCount++;
      if (callCount === 1) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          pull(controller) {
            controller.enqueue(encoder.encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_f","name":"bash"}}\n'));
            controller.error(new Error('connection reset'));
          }
        });
        return new Response(stream, { status: 200 });
      }
      return jsonFakeResponse({
        content: [{ type: 'tool_use', id: 'call_f', name: 'bash', input: { cmd: 'pwd' } }],
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    });

    const chunks = [];
    const result = await collectStream({
      adapter,
      chatParams: makeChatParams(),
      signal: NEVER_ABORT,
      onChunk: (c) => chunks.push(c),
    });

    assert.equal(result.hadToolCalls, true);
    assert.deepEqual(result.message.content[0], {
      type: 'tool_use', id: 'call_f', name: 'bash', input: { cmd: 'pwd' },
    });

    // 无文本 → 不应有 text_delta（只有 message_end）
    const textDeltas = chunks.filter(c => c.type === 'text_delta');
    assert.equal(textDeltas.length, 0);
    const messageEnds = chunks.filter(c => c.type === 'message_end');
    assert.ok(messageEnds.length >= 1);
  });
});
