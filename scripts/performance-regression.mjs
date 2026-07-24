import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { MyTerminalRuntime } from '../dist/server.js';
import { MyTerminalStore } from '../dist/store.js';
import { SessionDetail } from '../dist/tui/screens/Sessions.js';
import { TuiController, themeFor } from '../dist/tui/state.js';

const historyEntries = Number(process.argv[2] || 100_000);
const messageEntries = Number(process.argv[3] || 5_000);
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-perf-regression-'));
const stateDir = path.join(workspaceDir, '.myterminal');
const config = {
  workspaceDir, stateDir, settingsPath: path.join(stateDir, 'settings.json'), host: '127.0.0.1', port: 0,
  connectorKey: 'perf-connector-key-1234567890', actionsToken: 'perf-actions-token-12345678901234567890',
  publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'en', uiTheme: 'dark',
  passiveLockEnabled: false, actionsContinuationMode: 'off', nonBlockingTasksEnabled: false,
};

try {
  const store = new MyTerminalStore(stateDir);
  const root = store.registerRoot({ name: 'performance-regression' });
  const historyPath = path.join(stateDir, 'history', `${root.session.id}.jsonl`);
  const fd = fs.openSync(historyPath, 'a');
  try {
    for (let start = 0; start < historyEntries; start += 1_000) {
      const rows = [];
      for (let index = start; index < Math.min(historyEntries, start + 1_000); index += 1) {
        rows.push(JSON.stringify({ at: new Date(index).toISOString(), type: 'tool_audit', data: { id: `act-${index}`, action: 'list_dir', status: 'completed', durationMs: index % 7, result: { index, payload: 'x'.repeat(512) } } }));
      }
      fs.writeSync(fd, `${rows.join('\n')}\n`);
    }
  } finally { fs.closeSync(fd); }

  const runtime = new MyTerminalRuntime(config);
  globalThis.Bun?.gc?.(true);
  const historyMemoryBefore = process.memoryUsage().rss;
  const historyStarted = performance.now();
  const tree = SessionDetail({ runtime, groupId: root.session.id, theme: themeFor('dark'), zh: false });
  const historyElapsedMs = performance.now() - historyStarted;
  const historyMemoryAfter = process.memoryUsage().rss;

  const state = runtime.store.snapshot();
  const other = runtime.store.registerRoot({ name: 'message-peer' });
  state.sessions = runtime.store.snapshot().sessions;
  state.messages = Array.from({ length: messageEntries }, (_, index) => ({
    id: `msg-${index}`, from: other.session.id, to: root.session.id,
    source: 'session', body: `${index}:${'m'.repeat(512)}`, createdAt: new Date(index).toISOString(),
  }));
  fs.writeFileSync(path.join(stateDir, 'state.json'), `${JSON.stringify(state)}\n`);
  const scaledStore = new MyTerminalStore(stateDir);
  globalThis.Bun?.gc?.(true);
  const inboxMemoryBefore = process.memoryUsage().rss;
  const inboxStarted = performance.now();
  const page = scaledStore.inboxPage(root.session.id);
  const observations = scaledStore.observeMessages(page.messages);
  const inboxElapsedMs = performance.now() - inboxStarted;
  const inboxMemoryAfter = process.memoryUsage().rss;
  const scaledRuntime = new MyTerminalRuntime(config);
  const controller = new TuiController(scaledRuntime, async () => ({ runtime: scaledRuntime }));
  const snapshotStarted = performance.now();
  const snapshot = controller.snapshot();
  const tuiSnapshotMs = performance.now() - snapshotStarted;

  console.log(JSON.stringify({
    history: { requestedEntries: historyEntries, indexedEntries: runtime.store.historyCount(root.session.id), renderedEntries: runtime.store.historiesForTui([root.session.id]).length, elapsedMs: historyElapsedMs, rssDeltaBytes: historyMemoryAfter - historyMemoryBefore, rootChildren: Array.isArray(tree?.props?.children) ? tree.props.children.length : 0 },
    inbox: { total: page.total, returned: page.messages.length, observations: observations.length, elapsedMs: inboxElapsedMs, rssDeltaBytes: inboxMemoryAfter - inboxMemoryBefore },
    tui: { sourceMessages: messageEntries, snapshotMessages: snapshot.state.messages.length, snapshotMs: tuiSnapshotMs },
  }, null, 2));
} finally {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
}
