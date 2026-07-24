#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { settingsPath } from '../src/config.js';
import { readWorkspaceRegistry } from '../src/instances.js';
import { armMacOneShotAwakeLock } from '../src/session-resources.js';

const sessionId = process.argv[2];
if (!sessionId || !/^ses_[A-Za-z0-9-]+$/.test(sessionId)) {
  console.error('A valid MyTerminal sessionId is required.');
  process.exit(2);
}

try {
  const configDir = path.dirname(settingsPath());
  const record = readWorkspaceRegistry(configDir).find((candidate) => {
    try {
      const state = JSON.parse(readFileSync(path.join(candidate.stateDir, 'state.json'), 'utf8')) as { sessions?: Array<{ id?: string }> };
      return state.sessions?.some((session) => session.id === sessionId);
    } catch { return false; }
  });
  if (!record) throw new Error(`No registered workspace owns session ${sessionId}.`);
  const result = armMacOneShotAwakeLock({ workspaceDir: record.workspaceDir, stateDir: record.stateDir } as never, sessionId);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
