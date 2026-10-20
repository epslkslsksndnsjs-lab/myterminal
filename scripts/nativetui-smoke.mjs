#!/usr/bin/env node
// Headless end-to-end smoke test for the ported nativetui render stack.
// min-agent's tui-smoke.mjs drives a real binary inside tmux; this machine
// has no tmux, so we assert the same behaviors through FakeTerminal + the
// public component API: boot layout paints, typed input echoes, backspace
// edits, and rendered rows never exceed the terminal width.
//
// Note: FakeTerminal.output is a diff byte stream, not a screen grid —
// content assertions use "contains", state assertions go through the
// component API (same pattern as src/nativetui/tui.test.ts).

import { createBootScreen } from '../src/nativetui/index.js'
import { FakeTerminal } from '../src/nativetui/fake-terminal.js'
import { visibleWidth } from '../src/nativetui/utils.js'

const COLS = 80
const ROWS = 24

let failures = 0

function fail(message) {
  failures += 1
  console.error(`FAIL: ${message}`)
}

function assertContains(label, text, needle) {
  if (!text.includes(needle)) fail(`${label}: expected to contain "${needle}"`)
}

async function flushRender() {
  await new Promise((resolve) => setTimeout(resolve, 60))
}

async function main() {
  const term = new FakeTerminal(COLS, ROWS)
  const boot = createBootScreen(term, {
    model: 'glm-5.2',
    cwd: '/tmp/proj',
    wordmark: 'myterminal',
    startHint: 'type to start',
  })
  boot.tui.start()
  await flushRender()

  // --- Boot layout ------------------------------------------------------
  if (!term.altScreenActive) fail('boot should enter the alt screen')
  if (!term.mouseTrackingActive) fail('boot should enable mouse tracking')
  assertContains('alt screen sequence', term.output, '\x1b[?1049h')
  assertContains('wordmark', term.output, 'myterminal')
  assertContains('header model', term.output, 'glm-5.2')
  assertContains('header cwd', term.output, '/tmp/proj')
  assertContains('header start hint', term.output, 'type to start')
  assertContains('input prompt', term.output, '>')

  // --- Typing into the input ---------------------------------------------
  for (const ch of 'hello') term.emitInput(ch)
  await flushRender()
  if (boot.input.getValue() !== 'hello') {
    fail(`input should hold "hello", got "${boot.input.getValue()}"`)
  }

  // --- Backspace ----------------------------------------------------------
  term.emitInput('\x7f')
  await flushRender()
  if (boot.input.getValue() !== 'hell') {
    fail(`backspace should leave "hell", got "${boot.input.getValue()}"`)
  }

  // --- Overlong input stays within the terminal width ---------------------
  for (const ch of 'x'.repeat(200)) term.emitInput(ch)
  await flushRender()
  for (const line of boot.input.render(COLS)) {
    const width = visibleWidth(line)
    if (width > COLS) fail(`input row exceeds ${COLS} columns (${width})`)
  }

  // --- Cleanup -------------------------------------------------------------
  boot.tui.stop()
  if (!term.stoppedState) fail('tui.stop should stop the terminal')
  assertContains('leave alt screen', term.output, '\x1b[?1049l')

  if (failures > 0) {
    console.error(`\nsmoke: ${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('smoke: headless end-to-end assertions passed')
}

main().catch((e) => {
  console.error(`smoke: unexpected error: ${e.message}`)
  process.exit(1)
})
