// Startup must not parse a pathological multi-hundred-MB session history.
// The recent-history window is byte-bounded; the newest entries remain visible.

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MyTerminalStore } from '../dist/store.js';

function tempState(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mt-history-${tag}-`));
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true, mode: 0o700 });
  return dir;
}

test('oversized history parses only a bounded recent byte tail', () => {
  const dir = tempState('cap');
  try {
    const session = 'ses_cap';
    const huge = JSON.stringify({
      at: '2026-01-01T00:00:00.000Z',
      type: 'tool_audit',
      data: { id: 'old-huge', action: 'read', status: 'completed', payload: 'x'.repeat(9 * 1024 * 1024) },
    });
    const recent = JSON.stringify({
      at: '2026-10-17T00:00:00.000Z',
      type: 'tool_audit',
      data: { id: 'recent', action: 'read', status: 'completed' },
    });
    fs.writeFileSync(path.join(dir, 'history', `${session}.jsonl`), `${huge}\n${recent}\n`);

    const store = new MyTerminalStore(dir);
    const entries = store.readRecentHistory(session);
    assert.deepEqual(entries.map((entry) => entry.data.id), ['recent'], 'the old 9 MB entry is outside the bounded tail');
    assert.equal(entries[0].at, '2026-10-17T00:00:00.000Z');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normal histories keep their complete recent window', () => {
  const dir = tempState('normal');
  try {
    const session = 'ses_normal';
    const lines = ['first', 'second'].map((id, index) => JSON.stringify({
      at: `2026-10-17T00:00:0${index}.000Z`,
      type: 'tool_audit',
      data: { id, action: 'read', status: 'completed' },
    }));
    fs.writeFileSync(path.join(dir, 'history', `${session}.jsonl`), `${lines.join('\n')}\n`);

    const store = new MyTerminalStore(dir);
    const entries = store.readRecentHistory(session);
    assert.deepEqual(entries.map((entry) => entry.data.id), ['first', 'second']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
