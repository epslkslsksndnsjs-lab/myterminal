// M2 acceptance: runAgent drives a full tool_call round through the existing
// subagent pipeline and yields nativetui-shaped AgentEvents; abort and retry
// behavior is pinned here.

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgent, type AgentLoopOptions } from './loop.js'
import type { AgentEvent } from '../nativetui/events.js'
import type { LlmAdapter, StreamChunk } from '../subagent/llm-adapter.js'
import { LlmError } from '../subagent/llm-adapter.js'

type Turn = {
  text?: string
  toolCalls?: Array<{ id: string; name: string; input: unknown }>
  usage?: { input_tokens: number; output_tokens: number }
  stopReason?: string
  failure?: LlmError | Error
  /** 在发完 chunk 后等待该信号（用于 abort 测试） */
  waitForAbort?: boolean
}

/** 脚本化适配器：每轮按顺序回放一个 Turn。 */
function scriptedAdapter(turns: Turn[]) {
  let index = 0
  const calls: Array<{ model: string }> = []
  const adapter: LlmAdapter & { callCount: number; models: string[] } = {
    provider: 'test',
    callCount: 0,
    models: [],
    async *stream(params, signal): AsyncGenerator<StreamChunk> {
      this.callCount++
      calls.push({ model: params.model })
      this.models.push(params.model)
      const turn = turns[Math.min(index, turns.length - 1)]
      index++

      if (turn.failure) throw turn.failure

      if (turn.text) yield { type: 'text_delta', text: turn.text }

      if (turn.toolCalls) {
        for (let i = 0; i < turn.toolCalls.length; i++) {
          const tc = turn.toolCalls[i]
          yield { type: 'tool_call_start', index: i, id: tc.id, name: tc.name }
          const json = JSON.stringify(tc.input)
          for (let j = 0; j < json.length; j += 5) {
            yield { type: 'tool_call_delta', index: i, jsonFragment: json.slice(j, j + 5) }
          }
          yield { type: 'tool_call_end', index: i, id: tc.id }
        }
      }

      if (turn.waitForAbort) {
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'))
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        })
      }

      yield { type: 'message_end', usage: turn.usage ?? { input_tokens: 10, output_tokens: 5 }, stopReason: turn.stopReason }
    },
    async create() {
      throw new Error('create() is not used by runAgent')
    },
  }
  return adapter
}

function baseOptions(overrides: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    adapter: scriptedAdapter([{ text: 'hello' }]),
    model: 'test-model',
    context: { system: 'system', messages: [] },
    cwd: process.cwd(),
    agentId: 'loop-test',
    signal: new AbortController().signal,
    maxTurns: 5,
    ...overrides,
  }
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const ev of gen) events.push(ev)
  return events
}

describe('runAgent', () => {
  it('streams assistant text and ends with end_turn', async () => {
    const events = await collect(runAgent(baseOptions({
      adapter: scriptedAdapter([{ text: 'Hello' }]),
    })))

    expect(events).toEqual([
      { type: 'assistant_text', delta: 'Hello' },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      { type: 'turn_end', stopReason: 'end_turn' },
    ])
  })

  it('runs a tool call round through the real tool pipeline and feeds the result back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-'))
    writeFileSync(join(dir, 'note.txt'), 'alpha\nbeta\n')
    try {
      const adapter = scriptedAdapter([
        { toolCalls: [{ id: 't1', name: 'read_file', input: { path: join(dir, 'note.txt') } }] },
        { text: 'The file says alpha.' },
      ])
      const context = { system: 'system', messages: [] as AgentLoopOptions['context']['messages'] }
      const events = await collect(runAgent(baseOptions({ adapter, context, cwd: dir })))

      expect(adapter.callCount).toBe(2)
      expect(events).toContainEqual({ type: 'tool_call', id: 't1', name: 'read_file', args: { path: join(dir, 'note.txt') } })

      const result = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result')
      expect(result?.id).toBe('t1')
      expect(result?.result).toContain('alpha')

      expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'end_turn' })
      // tool_use / tool_result pair fed back before the final assistant message
      const [assistantTurn, toolResultTurn, finalTurn] = context.messages
      expect(assistantTurn.content[0]).toMatchObject({ type: 'tool_use', id: 't1', name: 'read_file' })
      expect(toolResultTurn.role).toBe('user')
      expect(toolResultTurn.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: false })
      expect(finalTurn.role).toBe('assistant')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports tool errors with the error: prefix the TUI keys off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-'))
    try {
      const adapter = scriptedAdapter([
        { toolCalls: [{ id: 't1', name: 'read_file', input: { path: join(dir, 'missing.txt') } }] },
        { text: 'Could not read it.' },
      ])
      const events = await collect(runAgent(baseOptions({ adapter, cwd: dir })))
      const result = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result')
      expect(result?.result.startsWith('error:')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('aborts mid-stream and ends the turn as aborted', async () => {
    const ctrl = new AbortController()
    const adapter = scriptedAdapter([{ text: 'partial', waitForAbort: true }])
    const events: AgentEvent[] = []

    const consume = (async () => {
      for await (const ev of runAgent(baseOptions({ adapter, signal: ctrl.signal }))) {
        events.push(ev)
        if (ev.type === 'assistant_text') ctrl.abort()
      }
    })()
    await consume

    expect(events.some((e) => e.type === 'assistant_text')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'aborted' })
  })

  it('does not start a turn when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const adapter = scriptedAdapter([{ text: 'never' }])
    const events = await collect(runAgent(baseOptions({ adapter, signal: ctrl.signal })))
    expect(adapter.callCount).toBe(0)
    expect(events).toEqual([{ type: 'turn_end', stopReason: 'aborted' }])
  })

  it('retries a transient failure, emits retry, then succeeds', async () => {
    const adapter = scriptedAdapter([
      { failure: new LlmError('rate_limit', 'slow down', 429, 1) },
      { text: 'recovered' },
    ])
    const events = await collect(runAgent(baseOptions({ adapter })))

    const retry = events.find((e): e is Extract<AgentEvent, { type: 'retry' }> => e.type === 'retry')
    expect(retry).toMatchObject({ attempt: 1, errorMessage: 'slow down' })
    expect(retry!.delayMs).toBeGreaterThanOrEqual(0)
    expect(events.some((e) => e.type === 'assistant_text' && e.delta === 'recovered')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'end_turn' })
    expect(adapter.callCount).toBe(2)
  })

  it('does not retry a turn that already streamed text (no duplicate rendering)', async () => {
    // Text arrives, then the stream breaks with a retryable error.
    let calls = 0
    const adapter: LlmAdapter = {
      provider: 'test',
      async *stream(): AsyncGenerator<StreamChunk> {
        calls++
        yield { type: 'text_delta', text: 'partial output' }
        throw new LlmError('rate_limit', 'mid-stream 429', 429, 1)
      },
      async create() {
        throw new Error('unused')
      },
    }
    const events = await collect(runAgent(baseOptions({ adapter })))

    expect(calls).toBe(1)
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'assistant_text' && e.delta === 'partial output')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'error' })
  })

  it('fails fast on an auth error without retrying', async () => {
    const adapter = scriptedAdapter([{ failure: new LlmError('auth', 'bad key', 401) }])
    const events = await collect(runAgent(baseOptions({ adapter })))

    expect(adapter.callCount).toBe(1)
    expect(events.some((e) => e.type === 'retry')).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'error' })
  })

  it('stops calling the API once the circuit breaker trips', async () => {
    const adapter = scriptedAdapter([{ failure: new LlmError('rate_limit', 'boom', 429, 1) }])
    const events = await collect(runAgent(baseOptions({ adapter, maxTurns: 20 })))

    // CB threshold is 5 consecutive failures; the 6th iteration must refuse
    // the API call outright instead of hammering it.
    expect(adapter.callCount).toBe(5)
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'error' })
    expect(events.some((e) => e.type === 'assistant_text' && e.delta.includes('Circuit breaker'))).toBe(true)
  })

  it('stops at maxTurns with an error turn_end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-loop-'))
    try {
      const toolTurn: Turn = { toolCalls: [{ id: 't', name: 'read_file', input: { path: join(dir, 'missing.txt') } }] }
      const adapter = scriptedAdapter([toolTurn])
      const events = await collect(runAgent(baseOptions({ adapter, cwd: dir, maxTurns: 2 })))

      expect(adapter.callCount).toBe(2)
      expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'error' })
      expect(events.some((e) => e.type === 'assistant_text' && e.delta.includes('Max turns'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports max_tokens as the stop reason', async () => {
    const adapter = scriptedAdapter([{ text: 'truncated', stopReason: 'max_tokens' }])
    const events = await collect(runAgent(baseOptions({ adapter })))
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'max_tokens' })
  })
})
