// End-to-end acceptance for M2: one full tool_call conversation with no
// ChatGPT involvement. The Anthropic adapter's SSE parsing is real; only the
// HTTP boundary is a fake fetch. The host runs headless on a FakeTerminal.

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnthropicAdapter } from '../subagent/llm-adapter.js'
import { createNativeSession } from './cli-host.js'
import { FakeTerminal } from '../nativetui/fake-terminal.js'
import type { SubagentSettings } from '../types.js'

function sse(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}`).join('\n') + '\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function toolUseReply(filePath: string): Response {
  const input = JSON.stringify({ path: filePath })
  return sse([
    { type: 'message_start', message: { usage: { input_tokens: 42 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading the file.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: input.slice(0, 8) } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: input.slice(8) } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ])
}

function finalReply(text: string): Response {
  return sse([
    { type: 'message_start', message: { usage: { input_tokens: 90 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  ])
}

const settings: SubagentSettings = {
  enabled: true,
  model: 'test-model',
  baseUrl: 'https://gateway.invalid',
  apiKey: 'test-key',
  maxTurns: 5,
  timeoutSec: 120,
  maxParallel: 1,
}

describe('M2 end-to-end: native agent round with a tool call', () => {
  it('reads a real file through the tool pipeline and renders the answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-e2e-'))
    const file = join(dir, 'note.txt')
    writeFileSync(file, 'alpha\n')

    const requests: Array<Record<string, unknown>> = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return requests.length === 1 ? toolUseReply(file) : finalReply('The file contains: alpha')
    }) as unknown as typeof fetch

    try {
      const term = new FakeTerminal(100, 30)
      const session = createNativeSession({
        settings,
        cwd: dir,
        terminal: term,
        adapter: new AnthropicAdapter('test-key', fetchImpl, settings.baseUrl),
      })
      session.boot.tui.start()

      session.boot.input.onSubmit!('read note.txt and tell me what it says')
      await session.idle()
      session.quit()
      await session.exited

      // Two LLM calls: tool_use round, then the final answer.
      expect(requests).toHaveLength(2)

      // The API saw the tool result in the second request.
      const second = requests[1] as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }
      const toolResultBlock = second.messages
        .flatMap((m) => m.content)
        .find((b) => b.type === 'tool_result')
      expect(toolResultBlock).toMatchObject({ tool_use_id: 'toolu_1' })
      expect(String(toolResultBlock!.content)).toContain('alpha')

      // The conversation is durable across turns in the shared context.
      expect(session.context.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])

      const blocks = session.boot.transcript.getBlocks()
      expect(blocks.some((b) => b.kind === 'tool' && b.name === 'read_file' && b.status === 'done')).toBe(true)
      expect(blocks.some((b) => b.kind === 'assistant' && b.text.includes('The file contains: alpha'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
