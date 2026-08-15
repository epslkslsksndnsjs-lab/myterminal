// M6：LLM 适配层——多 provider 统一接入
// 决策 1/2/14/21/24/27/29
// 上层 agent loop 与 LLM 无关；这是唯一跟外部 API 打交道的模块

import type { JsonObject, JsonSchema, SubagentSettings } from '../types.js';
import type { ContentBlock, NormalizedMessage, TokenUsage } from './token-counter.js';

// ── 适配器输出的标准流式事件（屏蔽 provider 差异）──

export type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; jsonFragment: string }
  | { type: 'tool_call_end'; index: number; id: string }
  | { type: 'message_end'; usage: TokenUsage; stopReason?: string };

// ── 决策 21：6 种错误分类 ──

export type LlmErrorKind = 'rate_limit' | 'server_overload' | 'auth' | 'prompt_too_long' | 'connection' | 'system';

export class LlmError extends Error {
  constructor(
    public kind: LlmErrorKind,
    message: string,
    public status?: number,
    public retryAfterMs?: number, // 决策 21：优先用 Retry-After 头
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

// ── 统一调用参数 ──

export type ChatParams = {
  model: string;
  system: string;
  messages: NormalizedMessage[];
  tools: Array<{ name: string; description: string; input_schema: JsonSchema }>;
  maxTokens: number;
};

// ── 适配器接口（决策 2）──

export interface LlmAdapter {
  readonly provider: string;
  stream(params: ChatParams, signal: AbortSignal): AsyncGenerator<StreamChunk, void, unknown>;
  create(params: ChatParams, signal: AbortSignal): Promise<{ message: NormalizedMessage; usage: TokenUsage }>;
}

// ═══════════════════════════════════════════════
// ADR-0048 D10（#138）：请求体组装单源 + 缓存断点
// ═══════════════════════════════════════════════

/**
 * 请求体组装（stream/create 共用单源）。
 * withCacheControl=true：system 转块数组 + tools **末项**打 `cache_control:{type:"ephemeral"}`
 * （断点顺序按协议前缀 system→tools，ADR D10 第 4 条；断点只打末项——前缀缓存语义下
 * 末项一个断点即覆盖全部工具前缀；全项打点时 8 工具=9 断点，超网关 4 断点上限、
 * 严格网关必 400）。
 * withCacheControl=false：system 纯字符串、tools 无断点——与现状逐字兼容（去断点重试/降级形态）。
 */
export function buildBody(
  params: ChatParams,
  withCacheControl: boolean,
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }> = params.messages,
  stream = false,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages,
    ...(stream ? { stream: true } : {}),
    max_tokens: params.maxTokens > 0 ? params.maxTokens : 4096,
  };

  if (params.system) {
    body.system = withCacheControl
      ? [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }]
      : params.system;
  }
  if (params.tools.length > 0) {
    body.tools = params.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      ...(withCacheControl && i === params.tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
  }
  return body;
}

// ═══════════════════════════════════════════════
// 决策 24：消息归一化
// ═══════════════════════════════════════════════

/**
 * 消息归一化（决策 24）
 * 1. 合并连续同 role 消息（content 数组拼接）
 * 2. 保持 user/assistant 交替
 * 3. tool_use/tool_result 配对检查——孤儿 tool_use 自动补 interrupted tool_result
 */
export function normalizeMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  if (messages.length === 0) return [];

  // Step 1: 合并连续同 role 消息
  const merged: NormalizedMessage[] = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.content = [...last.content, ...msg.content];
    } else {
      merged.push({ role: msg.role, content: [...msg.content] });
    }
  }

  // Step 2: 收集所有 tool_use id 和 tool_result id
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of merged) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolUseIds.add(block.id);
      } else if (block.type === 'tool_result') {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  // Step 3: 孤儿 tool_use 自动补 interrupted tool_result（决策 24 + 37）
  const orphanIds: string[] = [];
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) {
      orphanIds.push(id);
    }
  }

  if (orphanIds.length > 0) {
    const orphanBlocks: ContentBlock[] = orphanIds.map(id => ({
      type: 'tool_result' as const,
      tool_use_id: id,
      content: 'Tool execution was interrupted. The tool may or may not have completed.',
      is_error: true,
    }));

    // 追加到末尾 user 消息（决策 24：tool_result 包在 user 消息里）
    const lastMsg = merged[merged.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      lastMsg.content = [...lastMsg.content, ...orphanBlocks];
    } else {
      merged.push({ role: 'user', content: orphanBlocks });
    }
  }

  return merged;
}

// ═══════════════════════════════════════════════
// 内部辅助：SSE 行读取器
// ═══════════════════════════════════════════════

async function* readSSELines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
): AsyncGenerator<string> {
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      yield line;
    }
  }

  // 刷新剩余缓冲
  if (buffer) yield buffer;
}

// ═══════════════════════════════════════════════
// 决策 21：错误分类
// ═══════════════════════════════════════════════

/**
 * HTTP 错误分类（决策 21 表）
 */
function classifyHttpError(status: number, body: string, headers?: Headers): LlmError {
  // 429 → rate_limit（解析 Retry-After 头）
  if (status === 429) {
    let retryAfterMs: number | undefined;
    const retryAfter = headers?.get('Retry-After');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : undefined;
    }
    return new LlmError('rate_limit', 'Rate limit exceeded. Please wait before retrying.', status, retryAfterMs);
  }

  // 529 → server_overload
  if (status === 529) {
    return new LlmError('server_overload', 'Server is overloaded. Consider switching to a fallback model.', status);
  }

  // 401/403 → auth（不重试！决策 21）
  if (status === 401 || status === 403) {
    return new LlmError('auth', 'API key is invalid or expired. Please check your environment variable.', status);
  }

  // 400 且 body 含 'prompt is too long' / 'context_length' → prompt_too_long
  if (status === 400) {
    const lower = body.toLowerCase();
    if (lower.includes('prompt is too long') || lower.includes('context_length') || lower.includes('maximum context length')) {
      return new LlmError('prompt_too_long', 'The prompt exceeds the model context window. Consider compacting the conversation.', status);
    }
  }

  // 其他 5xx → server_overload
  if (status >= 500) {
    return new LlmError('server_overload', `Server error (HTTP ${status}). Please retry later.`, status);
  }

  // 其他 → system
  return new LlmError('system', `Unexpected API error (HTTP ${status}): ${body.slice(0, 500)}`, status);
}

/**
 * 网络错误分类（决策 21 表）
 * - AbortError（用户 signal.aborted 触发）→ 原样抛出，不包装！
 * - LlmError（已经分类的 HTTP 错误）→ 透传
 * - TypeError/ECONNRESET/ETIMEDOUT → connection
 */
function classifyNetworkError(err: unknown): LlmError {
  if (err instanceof DOMException && err.name === 'AbortError') {
    // 用户触发的 abort——原样抛出，M7 靠它识别 abort（决策 21）
    throw err;
  }
  if (err instanceof LlmError) {
    // 已分类的错误（如 classifyHttpError 的结果）→ 透传
    throw err;
  }

  const message = err instanceof Error ? err.message : String(err);
  return new LlmError('connection', `Network error: ${message}`);
}

// ═══════════════════════════════════════════════
// 决策 24 + #66：NormalizedMessage 组装单源
// ═══════════════════════════════════════════════

/** 组装输入：已解析的工具调用中间态 */
export type AssemblyToolPart = { id: string; name: string; input: JsonObject };

/**
 * 组装输入的有序元素。#66 修复：早期实现收 `(textParts[], toolParts[])` 两个独立数组，
 * 组装时先铺完所有 text 再铺所有 tool——这会丢掉 Anthropic 非流式响应里 text/tool_use
 * 的原始交错顺序（`[tool, text]` 被重排成 `[text, tool]`），属行为变更。改为单个有序
 * 列表后，各调用点按到达顺序 push，assembleMessage 只做「空 text 过滤 + 定型」。
 */
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: AssemblyToolPart };

/**
 * assembleMessage——NormalizedMessage 组装单源（#66）
 * 所有适配器 / collectStream 的最终组装统一走此函数，行为契约：
 * - 空 text 不入 content
 * - content 块顺序 = parts 的到达顺序（不重排）
 * - hadToolCalls = content 中存在 tool_use 块
 */
export function assembleMessage(
  parts: MessagePart[],
  usage: TokenUsage,
): { message: NormalizedMessage; usage: TokenUsage; hadToolCalls: boolean } {
  const content: ContentBlock[] = [];

  for (const part of parts) {
    if (part.kind === 'text') {
      if (part.text.length > 0) content.push({ type: 'text', text: part.text });
    } else {
      content.push({ type: 'tool_use', id: part.tool.id, name: part.tool.name, input: part.tool.input });
    }
  }

  const hadToolCalls = content.some(b => b.type === 'tool_use');

  return {
    message: { role: 'assistant', content },
    usage,
    hadToolCalls,
  };
}

/**
 * emitAssembledMessage——回退路径 re-emit 单源（#66）
 * 已组装消息 → onChunk 事件序列：有 text → text_delta；始终 → message_end(usage)
 */
export function emitAssembledMessage(
  message: NormalizedMessage,
  usage: TokenUsage,
  onChunk: (chunk: StreamChunk) => void,
): void {
  const textBlock = message.content.find(b => b.type === 'text');
  if (textBlock && textBlock.type === 'text') {
    onChunk({ type: 'text_delta', text: textBlock.text });
  }
  onChunk({ type: 'message_end', usage });
}

// ═══════════════════════════════════════════════
// Anthropic 适配器（决策 2 + 24 + 27）
// ═══════════════════════════════════════════════

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: Array<Record<string, unknown>>;
};

export class AnthropicAdapter implements LlmAdapter {
  readonly provider: string = 'anthropic';
  private apiKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  // ADR-0048 D10（#138）：会话级缓存禁用标记——首个带断点请求 4xx 时置位，
  // 此后本会话（=本 run 一个 adapter 实例）不再打断点、不反复探测。
  private cacheDisabled = false;

  // ADR-0045（spine）：baseUrl 是厂商的 Anthropic 兼容 base URL（如
  // `https://api.anthropic.com` 或 `https://api.moonshot.cn/anthropic`），
  // 不含 `/v1` 与 `/messages`；代码统一补 `/v1/messages`。归一化剥掉末尾
  // 多余的 `/v1` 与 `/`，避免双 `/v1`（如旧默认 `.../v1`）或 `//`（如带尾斜杠）。
  constructor(apiKey: string, fetchImpl?: typeof fetch, baseUrl?: string) {
    this.apiKey = apiKey;
    const raw = (baseUrl ?? 'https://api.anthropic.com').trim().replace(/\/+$/, '');
    this.baseUrl = raw.endsWith('/v1') ? raw.slice(0, -3) : raw;
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // ── 请求转换：NormalizedMessage → Anthropic messages ──

  private buildMessages(messages: NormalizedMessage[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      const content: Array<Record<string, unknown>> = [];

      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            content.push({ type: 'text', text: block.text });
            break;
          case 'tool_use':
            content.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            });
            break;
          case 'tool_result':
            content.push({
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              content: block.content,
              is_error: block.is_error,
            });
            break;
          case 'image':
            // v1 占位，暂不处理
            break;
        }
      }

      if (content.length > 0) {
        result.push({ role: msg.role, content });
      }
    }

    return result;
  }

  // ── 流式请求 ──

  async *stream(params: ChatParams, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    try {
    // ADR-0048 D10（#138）：断点组装（system→tools，会话级 cacheDisabled 控制）
    const withCacheControl = !this.cacheDisabled;
    const messages = this.buildMessages(params.messages);
    let body = buildBody(params, withCacheControl, messages, true);
    const requestHeaders = {
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    };

    let response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal,
    });

    // 4xx 去断点重试一次 + 会话级禁用（ADR D10 第 6 条：不反复探测）。
    // 只对 4xx 降级：5xx 是网关瞬态/过载、与断点无关——若一并禁用会把瞬态故障
    // 误判为「断点被拒」、本会话缓存被永久误关（ADR 口径=4xx）。
    if (response.status >= 400 && response.status < 500 && withCacheControl) {
      this.cacheDisabled = true;
      body = buildBody(params, false, messages, true);
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal,
      });
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw classifyHttpError(response.status, errorBody, response.headers as unknown as Headers);
    }

    // SSE 解析
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const toolInputBuffers = new Map<number, { id: string; name: string; json: string }>();
    let usage: TokenUsage | undefined;
    let stopReason: string | undefined;

    try {
      for await (const line of readSSELines(reader, decoder)) {
        if (line.startsWith('event: ')) continue; // Anthropic SSE event type line——我们通过 data.type 路由
        if (!line.startsWith('data: ')) continue;

        const raw = line.slice(6);
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw);
        } catch {
          continue;
        }

        switch (data.type) {
          case 'message_start': {
            const msg = data.message as Record<string, unknown> | undefined;
            if (msg?.usage) {
              const msgUsage = msg.usage as Record<string, number>;
              usage = {
                input_tokens: msgUsage.input_tokens ?? 0,
                output_tokens: 0,
                cache_read_input_tokens: msgUsage.cache_read_input_tokens,
                // ADR-0048 D10（#138）：缓存创建记账——O1 复核（T1 实测基于非流式，
                // 流式路径在此补读；宽容派网关读不到则 undefined 展示）
                cache_creation_input_tokens: msgUsage.cache_creation_input_tokens,
              };
            }
            break;
          }

          case 'content_block_start': {
            const contentBlock = data.content_block as Record<string, unknown> | undefined;
            const index = data.index as number;
            if (contentBlock?.type === 'tool_use') {
              const id = contentBlock.id as string;
              const name = contentBlock.name as string;
              toolInputBuffers.set(index, { id, name, json: '' });
              yield { type: 'tool_call_start', index, id, name };
            }
            break;
          }

          case 'content_block_delta': {
            const delta = data.delta as Record<string, unknown> | undefined;
            const index = data.index as number;
            if (!delta) break;

            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              yield { type: 'text_delta', text: delta.text };
            } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const buf = toolInputBuffers.get(index);
              if (buf) {
                buf.json += delta.partial_json;
                yield { type: 'tool_call_delta', index, jsonFragment: delta.partial_json };
              }
            }
            break;
          }

          case 'content_block_stop': {
            const index = data.index as number;
            const buf = toolInputBuffers.get(index);
            if (buf) {
              yield { type: 'tool_call_end', index, id: buf.id };
            }
            break;
          }

          case 'message_delta': {
            const delta = data.delta as Record<string, unknown> | undefined;
            if (delta?.stop_reason && typeof delta.stop_reason === 'string') {
              stopReason = delta.stop_reason;
            }
            if (data.usage) {
              const msgUsage = data.usage as Record<string, number>;
              usage = {
                input_tokens: usage?.input_tokens ?? 0,
                output_tokens: msgUsage.output_tokens ?? 0,
                cache_read_input_tokens: usage?.cache_read_input_tokens,
                // ADR-0048 D10（#138）：delta 事件通常无 creation——沿用 message_start 已读值
                cache_creation_input_tokens: usage?.cache_creation_input_tokens,
              };
            }
            break;
          }

          case 'message_stop':
            // 流结束，在下面统一发 message_end
            break;

          case 'ping':
            // 心跳，忽略
            break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield {
      type: 'message_end',
      usage: usage ?? { input_tokens: 0, output_tokens: 0 },
      stopReason,
    };
    } catch (err) {
      throw classifyNetworkError(err);
    }
  }

  // ── 非流式请求（回退用，决策 27）──

  async create(params: ChatParams, signal: AbortSignal): Promise<{ message: NormalizedMessage; usage: TokenUsage }> {
    try {
    // ADR-0048 D10（#138）：断点组装 + 4xx 去断点重试一次 + 会话级禁用（同 stream）
    const withCacheControl = !this.cacheDisabled;
    const messages = this.buildMessages(params.messages);
    let body = buildBody(params, withCacheControl, messages);
    const requestHeaders = {
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    };

    let response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal,
    });

    // 同 stream：只对 4xx 降级（5xx 瞬态与断点无关，不误禁缓存）
    if (response.status >= 400 && response.status < 500 && withCacheControl) {
      this.cacheDisabled = true;
      body = buildBody(params, false, messages);
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal,
      });
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw classifyHttpError(response.status, errorBody, response.headers as unknown as Headers);
    }

    const data = await response.json() as Record<string, unknown>;
    const rawContent = data.content as Array<Record<string, unknown>> | undefined;
    // #66 修复：Anthropic 的 content 是一个**有序**块数组，text 与 tool_use 可任意交错。
    // 必须按到达顺序 push，不能拆成 text/tool 两桶再拼接——那会重排块顺序（行为变更）。
    const parts: MessagePart[] = [];

    if (rawContent) {
      for (const block of rawContent) {
        switch (block.type) {
          case 'text':
            if (typeof block.text === 'string') {
              parts.push({ kind: 'text', text: block.text });
            }
            break;
          case 'tool_use':
            parts.push({ kind: 'tool', tool: {
              id: block.id as string,
              name: block.name as string,
              input: (block.input as JsonObject) ?? {},
            } });
            break;
        }
      }
    }

    const msgUsage = data.usage as Record<string, number> | undefined;
    const usage: TokenUsage = {
      input_tokens: msgUsage?.input_tokens ?? 0,
      output_tokens: msgUsage?.output_tokens ?? 0,
      cache_read_input_tokens: msgUsage?.cache_read_input_tokens,
      // ADR-0048 D10（#138）：非流式缓存创建记账（T1 实测主路径）
      cache_creation_input_tokens: msgUsage?.cache_creation_input_tokens,
    };

    const { message, usage: assembledUsage } = assembleMessage(parts, usage);
    return { message, usage: assembledUsage };
    } catch (err) {
      throw classifyNetworkError(err);
    }
  }
}

// ═══════════════════════════════════════════════
// 决策 27：流式 Watchdog + 非流式回退
// ═══════════════════════════════════════════════

export const STREAM_IDLE_TIMEOUT_MS = 60_000; // 决策 27：60s 无事件 → 超时

// ═══════════════════════════════════════════════
// 决策 27 提升（#48）：可靠性装饰器
//   把 collectStream 的 watchdog + 失败降级提升为可复用的 LlmAdapter 装饰器，
//    让所有 LLM 调用（主聊天流 + autoCompact 摘要）共享同一套可靠性契约。
// ═══════════════════════════════════════════════

export interface ReliabilityOptions {
  /** 空闲/总超时毫秒。<=0 表示禁用 watchdog（直接透传）。默认 STREAM_IDLE_TIMEOUT_MS(60s) */
  idleTimeoutMs?: number;
  /** 超时错误文案前缀，用于区分流路径 / 压缩路径 */
  label?: string;
}

/**
 * ReliabilityAdapter——LlmAdapter 装饰器（决策 27 提升，#48）
 * 给 stream / create 都套上 watchdog：
 * - stream：空闲 watchdog——超过 idleTimeoutMs 无新 chunk → abort 并抛 connection 错误
 * - create：总超时 watchdog——超过 idleTimeoutMs 未 resolve → abort 并抛 connection 错误
 * 失败时透传：用户 abort 原样抛出；非 connection 的 LlmError 原样抛出。
 */
export class ReliabilityAdapter implements LlmAdapter {
  readonly provider: string;
  private inner: LlmAdapter;
  private idleTimeoutMs: number;
  private label: string;

  constructor(adapter: LlmAdapter, opts: ReliabilityOptions = {}) {
    this.inner = adapter;
    this.provider = adapter.provider;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
    this.label = opts.label ?? 'LLM call';
  }

  async *stream(params: ChatParams, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    // 禁用 watchdog → 直接透传（保持 idleTimeoutMs:0 语义）
    if (this.idleTimeoutMs <= 0) {
      yield* this.inner.stream(params, signal);
      return;
    }

    const watchdogController = new AbortController();
    const combinedSignal = AbortSignal.any([signal, watchdogController.signal]);
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => watchdogController.abort(), this.idleTimeoutMs) as unknown as ReturnType<typeof setTimeout>;
    };

    try {
      resetWatchdog();
      for await (const chunk of this.inner.stream(params, combinedSignal)) {
        resetWatchdog();
        yield chunk;
      }
    } catch (err) {
      // 仅当 watchdog 触发（而非用户主动 abort）时，转为 connection 超时错误
      if (watchdogController.signal.aborted && !signal.aborted) {
        throw new LlmError('connection', `${this.label} idle timeout`);
      }
      throw err;
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  async create(params: ChatParams, signal: AbortSignal): Promise<{ message: NormalizedMessage; usage: TokenUsage }> {
    // 禁用 watchdog → 直接透传
    if (this.idleTimeoutMs <= 0) {
      return this.inner.create(params, signal);
    }

    const watchdogController = new AbortController();
    const combinedSignal = AbortSignal.any([signal, watchdogController.signal]);
    const watchdog = setTimeout(() => watchdogController.abort(), this.idleTimeoutMs) as unknown as ReturnType<typeof setTimeout>;

    try {
      return await this.inner.create(params, combinedSignal);
    } catch (err) {
      if (watchdogController.signal.aborted && !signal.aborted) {
        throw new LlmError('connection', `${this.label} idle timeout`);
      }
      throw err;
    } finally {
      clearTimeout(watchdog);
    }
  }
}

/** 用可靠性装饰器包裹一个 LlmAdapter（#48） */
export function withReliability(adapter: LlmAdapter, opts: ReliabilityOptions = {}): LlmAdapter {
  return new ReliabilityAdapter(adapter, opts);
}

/**
 * collectStream——流式 LLM 调用的高阶函数（决策 27）
 * M7 executor 直接用它，而不是裸调 adapter.stream。
 * 内部用 withReliability 包裹，继承 watchdog + 失败降级（决策 27 提升，#48）。
 */
export async function collectStream(params: {
  adapter: LlmAdapter;
  chatParams: ChatParams;
  signal: AbortSignal;
  onChunk: (chunk: StreamChunk) => void;
  idleTimeoutMs?: number;
}): Promise<{ message: NormalizedMessage; usage: TokenUsage; hadToolCalls: boolean }> {
  const { adapter, chatParams, signal, onChunk, idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS } = params;

  // 用可靠性装饰器包裹——继承 watchdog + 失败降级（决策 27 提升，#48）
  const reliable = withReliability(adapter, { idleTimeoutMs, label: 'Stream idle timeout' });

  // 流式累积状态
  let textBuffer = '';
  const toolInputBuffers = new Map<number, { id: string; name: string; json: string }>();
  let finalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  let hadAnyToolCallEnd = false; // 决策 27：防双重执行

  try {
    for await (const chunk of reliable.stream(chatParams, signal)) {
      onChunk(chunk); // M7 注入，转 AG-UI 事件

      switch (chunk.type) {
        case 'text_delta':
          textBuffer += chunk.text;
          break;

        case 'tool_call_start':
          toolInputBuffers.set(chunk.index, { id: chunk.id, name: chunk.name, json: '' });
          break;

        case 'tool_call_delta': {
          const buf = toolInputBuffers.get(chunk.index);
          if (buf) buf.json += chunk.jsonFragment;
          break;
        }

        case 'tool_call_end':
          hadAnyToolCallEnd = true;
          break;

        case 'message_end':
          finalUsage = chunk.usage;
          break;
      }
    }

    // 流正常结束——组装 NormalizedMessage（#66：走 assembleMessage 单源）
    // 流式路径把所有 text_delta 累进单个 textBuffer，工具在其后，
    // 故顺序天然是「先 text 后 tools」，与 main 基线一致。
    const parts: MessagePart[] = [{ kind: 'text', text: textBuffer }];
    for (const [, buf] of toolInputBuffers) {
      let input: JsonObject;
      try {
        input = JSON.parse(buf.json) as JsonObject;
      } catch {
        // 决策 27：JSON 解析失败 → 文本降级 + 注释说明
        input = { _parse_error: true, raw: buf.json };
      }
      parts.push({ kind: 'tool', tool: { id: buf.id, name: buf.name, input } });
    }

    return assembleMessage(parts, finalUsage);
  } catch (error) {
    // 用户 abort 原样抛出（决策 21）
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    // 非 connection 的 LlmError（auth/prompt_too_long/rate_limit/server_overload/system）→ 不回退
    if (error instanceof LlmError && error.kind !== 'connection') {
      throw error;
    }

    // connection（watchdog 空闲超时/网络）或通用错误 → 尚未产出完整 tool_call 时回退到非流式
    // 决策 27：流式中途失败，回退到非流式（仅当尚未产出任何完整 tool_call）
    if (!hadAnyToolCallEnd) {
      const result = await reliable.create(chatParams, signal);
      const hadToolCalls = result.message.content.some(b => b.type === 'tool_use');
      // 回退成功——通过 emitAssembledMessage 通知 M7（#66 单源）
      emitAssembledMessage(result.message, result.usage, onChunk);
      return { ...result, hadToolCalls };
    }

    // 已产出完整 tool_call → 不回退（决策 27：防双重执行）
    throw error instanceof LlmError ? error : new LlmError('connection', `Stream error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ═══════════════════════════════════════════════
// 工厂（决策 14）
// ═══════════════════════════════════════════════

/**
 * 根据 settings 创建适配器（ADR-0045 spine）。
 * 配置契约：apiKey / baseUrl 为必填、由配置文件显式提供；
 * 代码永不猜测模型 / 端点 / credential。零默认、单适配器（Anthropic Messages 协议）。
 */
export function createAdapter(settings: SubagentSettings): LlmAdapter {
  const key = settings.apiKey;
  const baseUrl = settings.baseUrl;
  const model = settings.model;
  if (!key || !baseUrl || !model) {
    throw new Error(
      'Subagent apiKey, baseUrl and model are required. Provide them in the MyTerminal config file (subagent.apiKey / subagent.baseUrl / subagent.model).',
    );
  }
  return new AnthropicAdapter(key, undefined, baseUrl);
}
