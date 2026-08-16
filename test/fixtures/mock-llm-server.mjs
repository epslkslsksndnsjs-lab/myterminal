// ADR-0048 T11（#142）：mock-llm 假网关——本地 Anthropic 兼容 HTTP 服务（测试基建）
//
// 剧本能力（AC1）：SSE 流式 / 工具调用 / 4xx / 超时（stall 中途断流）/ 慢速 / 挂死，
// 全部经 POST /v1/messages 响应。请求按序消费脚本队列（每 POST 弹一个 handler），
// 请求全量记入 requests 日志（body 已解析）——全链路零真 key 断言依赖它。
//
// SSE 编码与 AnthropicAdapter.stream 的解析器逐事件对齐（llm-adapter.ts:434-520）：
// message_start / content_block_start / content_block_delta / content_block_stop /
// message_delta / message_stop。工具调用块 = content_block{type:'tool_use',id,name,input:{}}
// + input_json_delta 增量。非流式（create 路径）= 普通 JSON content 块数组。
//
// 用法（测试内）：
//   const mock = new MockLlmServer();
//   await mock.start();                       // 监听 127.0.0.1:0
//   mock.queue.push(mock.textReply('done'));  // 每 POST 弹一个
//   mock.url                                  // http://127.0.0.1:PORT（baseUrl 口径，无 /v1）
//   mock.requests                             // [{ body, headers }...]
//   await mock.stop();

import http from 'node:http';

function sse(events) {
  let out = '';
  for (const [event, data] of events) {
    if (event) out += `event: ${event}\n`;
    out += `data: ${JSON.stringify(data)}\n\n`;
  }
  return out;
}

/** 完整文本流式响应（SSE 全事件链）。 */
export function textReply(text, { startUsage = {}, stopReason = 'end_turn' } = {}) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(sse([
      ['message_start', { type: 'message_start', message: { id: 'msg_mock', usage: { input_tokens: 10, output_tokens: 0, ...startUsage } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ]));
    res.end();
  };
}

/** 单个工具调用块（tool_use + input_json_delta 增量 + stop）。 */
export function toolUseReply(name, input, { startUsage = {} } = {}) {
  const json = JSON.stringify(input);
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(sse([
      ['message_start', { type: 'message_start', message: { id: 'msg_mock', usage: { input_tokens: 10, output_tokens: 0, ...startUsage } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_mock_1', name, input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ]));
    res.end();
  };
}

/** HTTP 错误剧本（4xx/5xx——classifyHttpError 分类路径）。 */
export function httpErrorReply(status, body = '{"type":"error","error":{"type":"api_error","message":"mock error"}}') {
  return (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  };
}

/** 非流式 JSON 回复（create 路径——autoCompact 摘要等）。 */
export function jsonReply(contentBlocks, { usage = { input_tokens: 10, output_tokens: 5 }, stopReason = 'end_turn' } = {}) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_mock', content: contentBlocks, usage, stop_reason: stopReason, model: 'mock' }));
  };
}

/** 非流式文本块快捷方式。 */
export function jsonTextReply(text) {
  return jsonReply([{ type: 'text', text }]);
}

/** 慢速流式：每 chunk 间隔 delayMs（进度在动——不触发空闲 watchdog）。 */
export function slowTextReply(text, { chunkSize = 8, delayMs = 50, startUsage = {} } = {}) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(sse([
      ['message_start', { type: 'message_start', message: { id: 'msg_mock', usage: { input_tokens: 10, output_tokens: 0, ...startUsage } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ]));
    let i = 0;
    const timer = setInterval(() => {
      const chunk = text.slice(i, i + chunkSize);
      i += chunkSize;
      if (chunk) {
        res.write(sse([['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }]]));
      } else {
        clearInterval(timer);
        res.write(sse([
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
          ['message_stop', { type: 'message_stop' }],
        ]));
        res.end();
      }
    }, delayMs);
  };
}

/** 中途断流（stall）：发完 message_start 后永远不再有事件——空闲 watchdog 剧本。 */
export function stallMidStreamReply({ startUsage = {} } = {}) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(sse([
      ['message_start', { type: 'message_start', message: { id: 'msg_mock', usage: { input_tokens: 10, output_tokens: 0, ...startUsage } } }],
    ]));
    // 不 end——连接挂着直到 watchdog abort / stop() 兜底
  };
}

/** 挂死：完全不响应（响应头都不发）——总超时 watchdog 剧本。 */
export function hangReply() {
  return (req, res) => {
    // 什么都不做；stop() 时统一销毁挂起连接
  };
}

export class MockLlmServer {
  constructor() {
    this.queue = [];       // 每 POST 弹一个 handler（FIFO）
    this.defaultHandler = null; // 队列空时的兜底 handler（内容路由剧本用它抗请求数漂移）
    this.requests = [];    // 全量请求日志 [{ body, headers }]
    this._server = null;
    this._sockets = new Set();
  }

  async start() {
    this._server = http.createServer((req, res) => {
      this._sockets.add(req.socket);
      req.socket.on('close', () => this._sockets.delete(req.socket));
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found"}}');
        return;
      }
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { body = {}; }
        req.body = body; // 把解析后的请求体挂上 req——剧本 handler 按 body 路由
        this.requests.push({ body, headers: req.headers });
        const handler = this.queue.shift() ?? this.defaultHandler;
        if (!handler) {
          // 无剧本：默认完整文本回复（防挂）
          textReply('mock default reply')(req, res);
          return;
        }
        handler(req, res);
      });
    });
    await new Promise((resolve) => this._server.listen(0, '127.0.0.1', resolve));
    const addr = this._server.address();
    this.port = addr.port;
    return this;
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** 全部请求体里的 system 序列化文本（断言摘要请求等用；system 是块数组）。 */
  get allSystems() {
    return this.requests.map((r) => JSON.stringify(r.body?.system ?? ''));
  }

  /** 全部请求体里的 messages（已解析）。 */
  get allMessages() {
    return this.requests.map((r) => r.body?.messages ?? []);
  }

  async stop() {
    for (const socket of this._sockets) { try { socket.destroy(); } catch { /* 忽略 */ } }
    this._sockets.clear();
    if (!this._server) return;
    await new Promise((resolve) => this._server.close(resolve));
    this._server = null;
  }
}
