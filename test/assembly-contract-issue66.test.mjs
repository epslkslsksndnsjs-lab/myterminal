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
  
  
});

// ═══════════════════════════════════════════════
// Site 4: collectStream 回退路径组装形状
// ═══════════════════════════════════════════════

describe('issue66 assembly contract — collectStream fallback path', () => {
  
  
});
