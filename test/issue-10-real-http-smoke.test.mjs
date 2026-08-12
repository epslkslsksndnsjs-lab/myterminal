// ADR-0045 #10 — 真 HTTP 冒烟测试（real HTTP + Anthropic SSE dialect）
//
// 与 subagent-m6 的 fake-fetch 测试互补：本文件走**真实线路**——
// 起一个真 http.createServer 说 Anthropic SSE 方言，把 baseUrl 指过去，
// 验全 HTTP 路径：URL join、x-api-key 头、HTTP 错误分类、真实流式 chunk、abort。
// fake fetch 全部跳过，因此能暴露兼容网关的"怪异格式"（只在真实线路暴露）。
//
// 先例：stability-regression.test.mjs 已用 net.createServer 开真端口。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { AnthropicAdapter, LlmError } from '../dist/subagent/llm-adapter.js';

// ── 工具：开一个真 HTTP server，handler 收到请求时回调 ──

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

// 强制断开 keep-alive 连接并关闭，避免 bun test 进程因悬挂 socket 挂起
function closeServer(server) {
  try { server.closeAllConnections?.(); } catch { /* noop */ }
  server.close();
  server.unref?.();
}

function makeChatParams(overrides = {}) {
  return {
    model: 'claude-sonnet-4-20250514',
    system: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    tools: [],
    maxTokens: 4096,
    ...overrides,
  };
}

// 标准 Anthropic SSE 流（单段文本）——含 event: 行，验证适配器按 data.type 路由
function sseText(text) {
  return (
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":5}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}\n\n` +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  );
}

// ── 用例 1：URL join + x-api-key 头 + anthropic-version 头 + 真实流式 chunk ──

test('real HTTP — URL join /v1/messages + x-api-key 头 + 真实流式 chunk', async () => {
  let capturedUrl;
  let capturedHeaders;
  const { server, baseUrl } = await startServer((req, res) => {
    capturedUrl = req.url;
    capturedHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sseText('Hi-from-real-SSE'));
    res.end();
  });

  try {
    // 普通 baseUrl（无尾斜杠、无 /v1）
    const adapter = new AnthropicAdapter('sk-ant-10-key', undefined, baseUrl);
    const chunks = [];
    for await (const c of adapter.stream(makeChatParams(), new AbortController().signal)) {
      chunks.push(c);
    }

    // URL join：请求必须打到 /v1/messages（baseUrl + 代码补的 /v1/messages）
    assert.equal(capturedUrl, '/v1/messages', 'URL join 应拼出 /v1/messages');

    // x-api-key 头真实流入线路
    assert.equal(capturedHeaders['x-api-key'], 'sk-ant-10-key', 'x-api-key 头应等于构造器传入的 key');
    // anthropic-version 头也应存在
    assert.equal(capturedHeaders['anthropic-version'], '2023-06-01', 'anthropic-version 头应为 2023-06-01');
    // 真实流式：适配器应解析出文本 delta
    const textChunks = chunks.filter((c) => c.type === 'text_delta');
    assert.equal(textChunks.length, 1, '应有一条 text_delta');
    assert.equal(textChunks[0].text, 'Hi-from-real-SSE', 'text_delta 文本应来自真 server 的 SSE');
    assert.ok(chunks.some((c) => c.type === 'message_end'), '流应以 message_end 结束');
  } finally {
    closeServer(server);
  }
});

// ── 用例 1b：URL join 归一——baseUrl 带尾斜杠 + /v1 也不双拼 ──

test('real HTTP — baseUrl 带 /v1/ 尾时归一后仍拼成 /v1/messages', async () => {
  let capturedUrl;
  const { server, baseUrl } = await startServer((req, res) => {
    capturedUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sseText('ok'));
    res.end();
  });

  try {
    // 故意传带 /v1/ 尾的 baseUrl，验证构造函数归一（剥 /v1 + 尾斜杠）后不双拼成 //v1/messages
    const adapter = new AnthropicAdapter('sk-ant-10-key', undefined, `${baseUrl}/v1/`);
    for await (const _ of adapter.stream(makeChatParams(), new AbortController().signal)) { /* drain */ }
    assert.equal(capturedUrl, '/v1/messages', '带 /v1/ 尾的 baseUrl 归一后仍应拼成 /v1/messages，不能 //v1/messages');
  } finally {
    closeServer(server);
  }
});

// ── 用例 2：HTTP 错误分类（真线路：429 rate_limit + Retry-After / 401 auth / 400 prompt_too_long）──

async function expectLlmError(server, baseUrl, status, body, headers) {
  const adapter = new AnthropicAdapter('sk-ant-10-key', undefined, baseUrl);
  try {
    for await (const _ of adapter.stream(makeChatParams(), new AbortController().signal)) { /* drain */ }
    return null;
  } catch (err) {
    return err;
  } finally {
    closeServer(server);
  }
}

test('real HTTP — 错误分类：429→rate_limit(+Retry-After) / 401→auth / 400→prompt_too_long', async () => {
  // 429 + Retry-After
  {
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(429, { 'Retry-After': '3' });
      res.end('Rate limited');
    });
    const err = await expectLlmError(server, baseUrl, 429);
    assert.ok(err instanceof LlmError, '429 应抛 LlmError');
    assert.equal(err.kind, 'rate_limit');
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 3000, 'Retry-After: 3 → 3000ms');
  }

  // 401 auth（不重试）
  {
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(401);
      res.end('Unauthorized');
    });
    const err = await expectLlmError(server, baseUrl, 401);
    assert.ok(err instanceof LlmError, '401 应抛 LlmError');
    assert.equal(err.kind, 'auth');
    assert.ok(err.message.toLowerCase().includes('api key'), 'auth 信息应含 API key 指引');
  }

  // 400 + body 含 "prompt is too long" → prompt_too_long
  {
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'prompt is too long for this model' }));
    });
    const err = await expectLlmError(server, baseUrl, 400);
    assert.ok(err instanceof LlmError, '400 应抛 LlmError');
    assert.equal(err.kind, 'prompt_too_long', 'body 含 "prompt is too long" 应分类为 prompt_too_long');
  }
});

// ── 用例 3：abort 透传 AbortError（真实线路中途中止）──

test('real HTTP — abort 时透传 AbortError（不包装）', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    // 故意不响应：模拟连接挂起，等待客户端 abort
  });

  const adapter = new AnthropicAdapter('sk-ant-10-key', undefined, baseUrl);
  const ac = new AbortController();

  const loop = (async () => {
    for await (const _ of adapter.stream(makeChatParams(), ac.signal)) { /* 永不到达 */ }
  })();

  // 让请求真正发出并建立连接，再 abort
  await new Promise((resolve) => setTimeout(resolve, 80));
  ac.abort();

  let threw = null;
  try {
    await loop;
  } catch (err) {
    threw = err;
  } finally {
    closeServer(server);
  }

  assert.ok(threw, 'abort 应使 stream 抛出');
  assert.equal(threw?.name, 'AbortError', 'abort 应原样透传 AbortError（classifyNetworkError 不包装）');
});
