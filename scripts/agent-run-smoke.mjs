#!/usr/bin/env node
// Headless smoke for `myterminal run` (M2): boots the native TUI on a
// FakeTerminal, drives one scripted tool-call round, and asserts the
// transcript, then exits. No network, no real terminal.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeSession } from '../src/agent/cli-host.js'
import { FakeTerminal } from '../src/nativetui/fake-terminal.js'

const dir = mkdtempSync(join(tmpdir(), 'agent-smoke-'))
writeFileSync(join(dir, 'note.txt'), 'smoke-content\n')

let failures = 0
const check = (label, ok) => {
  if (!ok) {
    failures += 1
    console.error(`FAIL: ${label}`)
  }
}

async function main() {
  const term = new FakeTerminal(100, 30)
  const session = createNativeSession({
    settings: {
      enabled: true,
      model: 'test-model',
      baseUrl: 'https://gateway.invalid',
      apiKey: 'test-key',
      maxTurns: 4,
      timeoutSec: 60,
      maxParallel: 1,
    },
    cwd: dir,
    terminal: term,
    runAgentImpl: async function* (opts) {
      opts.context.messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: join(dir, 'note.txt') } }],
      })
      yield { type: 'assistant_text', delta: 'checking ' }
      yield { type: 'tool_call', id: 't1', name: 'read_file', args: { path: join(dir, 'note.txt') } }
      yield { type: 'tool_result', id: 't1', name: 'read_file', result: 'smoke-content' }
      yield { type: 'assistant_text', delta: 'done' }
      yield { type: 'turn_end', stopReason: 'end_turn' }
    },
  })
  session.boot.tui.start()
  session.boot.input.onSubmit('run the smoke')
  await session.idle()
  await new Promise((resolve) => setTimeout(resolve, 40))

  const blocks = session.boot.transcript.getBlocks()
  const text = blocks.map((b) => (b.kind === 'tool' ? b.name : b.kind === 'raw' ? b.line : b.text)).join('\n')
  check('boot screen painted', term.output.length > 0)
  check('user prompt echoed', text.includes('run the smoke'))
  check('tool call visible', blocks.some((b) => b.kind === 'tool' && b.name === 'read_file'))
  check('assistant text rendered', text.includes('checking') && text.includes('done'))

  session.quit()
  await session.exited
  check('terminal stopped on quit', term.stoppedState)

  if (failures > 0) {
    console.error(`${failures} failure(s)`)
    process.exit(1)
  }
  console.log('agent-run smoke: OK')
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => rmSync(dir, { recursive: true, force: true }))
