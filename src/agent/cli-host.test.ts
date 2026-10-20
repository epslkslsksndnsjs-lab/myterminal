// M2 acceptance: the native TUI host wires input → agent events → transcript,
// aborts the running turn on Escape, and exits when idle-Escape is pressed.

import { describe, it, expect } from 'bun:test'
import { createNativeSession, type RunHostOptions } from './cli-host.js'
import type { AgentEvent } from '../nativetui/events.js'
import { FakeTerminal } from '../nativetui/fake-terminal.js'
import type { SubagentSettings } from '../types.js'

const flushRender = () => new Promise((resolve) => setTimeout(resolve, 25))

function settings(overrides: Partial<SubagentSettings> = {}): SubagentSettings {
  return {
    enabled: true,
    model: 'test-model',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'test-key',
    maxTurns: 5,
    timeoutSec: 60,
    maxParallel: 1,
    ...overrides,
  }
}

function session(overrides: Partial<RunHostOptions> = {}) {
  const term = new FakeTerminal(80, 24)
  const s = createNativeSession({
    settings: settings(),
    cwd: '/tmp/proj',
    terminal: term,
    runAgentImpl: async function* (opts) {
      // Mirror the real loop: the assistant message lands in shared context.
      opts.context.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] })
      yield { type: 'assistant_text', delta: 'Hi there' }
      yield { type: 'turn_end', stopReason: 'end_turn' }
    },
    ...overrides,
  })
  s.boot.tui.start()
  return { term, s }
}

function transcriptText(s: ReturnType<typeof session>['s']): string {
  return s.boot.transcript
    .getBlocks()
    .map((b) => (b.kind === 'tool' ? b.name : b.kind === 'raw' ? b.line : b.text))
    .join('\n')
}

describe('native CLI host', () => {
  it('submits input, forwards agent events, and renders the reply', async () => {
    const { s } = session()

    s.boot.input.onSubmit!('hello')
    await s.idle()
    await flushRender()

    expect(transcriptText(s)).toContain('hello')
    expect(transcriptText(s)).toContain('Hi there')
    expect(s.context.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] })
    // assistant reply is persisted for the next turn
    expect(s.context.messages.at(-1)?.role).toBe('assistant')
  })

  it('ignores a second submit while a turn is running', async () => {
    let calls = 0
    const { s } = session({
      runAgentImpl: async function* (_opts) {
        calls++
        await new Promise((r) => setTimeout(r, 30))
        yield { type: 'assistant_text', delta: 'done' }
        yield { type: 'turn_end', stopReason: 'end_turn' }
      },
    })

    s.boot.input.onSubmit!('first')
    s.boot.input.onSubmit!('second')
    await s.idle()

    expect(calls).toBe(1)
  })

  it('aborts the running turn on Escape instead of exiting', async () => {
    let aborted = false
    const { term, s } = session({
      runAgentImpl: async function* (opts) {
        yield { type: 'assistant_text', delta: 'working' }
        await new Promise<void>((resolve) => {
          opts.signal.addEventListener('abort', () => {
            aborted = true
            resolve()
          }, { once: true })
        })
        yield { type: 'turn_end', stopReason: 'aborted' }
      },
    })

    s.boot.input.onSubmit!('go')
    await flushRender()
    s.boot.input.onEscape!()
    await s.idle()
    await flushRender()

    expect(aborted).toBe(true)
    expect(term.stoppedState).toBe(false)
    expect(transcriptText(s)).toContain('working')
  })

  it('exits when Escape is pressed while idle', async () => {
    const { s, term } = session()
    s.boot.input.onEscape!()
    await s.exited
    expect(term.stoppedState).toBe(true)
  })

  it('writes loop errors into the transcript instead of throwing', async () => {
    const { s } = session({
      runAgentImpl: async function* () {
        yield { type: 'assistant_text', delta: '\n[error] boom' }
        yield { type: 'turn_end', stopReason: 'error' }
      },
    })

    s.boot.input.onSubmit!('trigger')
    await s.idle()
    await flushRender()

    expect(transcriptText(s)).toContain('[error] boom')
  })
})
