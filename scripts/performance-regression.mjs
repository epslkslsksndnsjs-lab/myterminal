import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { act, createElement } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { MyTerminalRuntime } from '../dist/server.js';
import { MyTerminalStore } from '../dist/store.js';
import { SessionDetail } from '../dist/tui/screens/Sessions.js';
import { TuiController, themeFor } from '../dist/tui/state.js';
import { I18nProvider } from '../dist/tui/copy/context.js';
import { i18nFor } from '../dist/tui/copy/i18n.js';
import { microCompact } from '../dist/subagent/executor.js';
import { useTimelineModel } from '../dist/tui/hooks/useTimelineModel.js';

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
  // #31 之后 SessionDetail 内部使用 useI18n hook，必须在 React 渲染器 + I18nProvider 内运行。
  let historySetup;
  await act(async () => {
    historySetup = await testRender(
      createElement(I18nProvider, { value: i18nFor('en') }, createElement(SessionDetail, { runtime, groupId: root.session.id, theme: themeFor('dark') })),
      { width: 80, height: 24 },
    );
    await historySetup.flush();
  });
  const historyElapsedMs = performance.now() - historyStarted;
  const historyMemoryAfter = process.memoryUsage().rss;
  historySetup.renderer?.destroy?.();

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

  // ── #63（批5 第 11 刀·性能刀）基准段 ──────────────────────────────
  // context()：child（parent 挂 10 万条 history）+ 超预算消息触发 fitProjection 裁剪
  const ctxTask = { objective: 'perf-context', background: 'issue #63 benchmark', deliverables: ['ctx'], acceptanceCriteria: ['fast'], constraints: ['none'] };
  const ctxWorker = scaledStore.registerDelegate(root.session.id, { name: 'ctx-worker', task: ctxTask });
  const ctxHistoryPath = path.join(stateDir, 'history', `${ctxWorker.session.id}.jsonl`);
  const ctxRows = [];
  for (let index = 0; index < 5_000; index += 1) {
    ctxRows.push(JSON.stringify({ at: new Date(index).toISOString(), type: 'tool_audit', data: { id: `ctx-${index}`, action: 'read_file', status: 'completed', durationMs: index % 5, result: { index, payload: 'y'.repeat(512) } } }));
  }
  fs.writeFileSync(ctxHistoryPath, `${ctxRows.join('\n')}\n`);
  for (let index = 0; index < 25; index += 1) scaledStore.sendMessage(root.session.id, ctxWorker.session.id, `${index}:${'c'.repeat(1500)}`);
  globalThis.Bun?.gc?.(true);
  const contextFirstStarted = performance.now();
  const contextProjection = scaledStore.context(ctxWorker.session.id);
  const contextFirstMs = performance.now() - contextFirstStarted;
  const contextRepeatStarted = performance.now();
  for (let index = 0; index < 50; index += 1) scaledStore.context(ctxWorker.session.id);
  const contextRepeat50Ms = performance.now() - contextRepeatStarted;

  // microCompact：1500 对 tool_use/tool_result（修前 resolveToolName 全量扫描 = O(n²)）
  const microPairs = 1_500;
  const microMessages = [];
  for (let index = 0; index < microPairs; index += 1) {
    microMessages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu-${index}`, name: index % 2 ? 'read_file' : 'write_file', input: {} }] });
    microMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${index}`, content: 'x'.repeat(64) }] });
  }
  const microStarted = performance.now();
  microCompact(microMessages);
  const microCompactMs = performance.now() - microStarted;

  // timeline：同 revision 100 帧（修前每帧都取 auditFacts(5000) 并 structuredClone）
  const timelineSnapshot = controller.snapshot();
  useTimelineModel(timelineSnapshot, 7); // 预热一帧建 AuditLog 缓存
  const timelineStarted = performance.now();
  for (let index = 0; index < 100; index += 1) useTimelineModel(timelineSnapshot, 7);
  const timelineFrames100Ms = performance.now() - timelineStarted;

  console.log(JSON.stringify({
    history: { requestedEntries: historyEntries, indexedEntries: runtime.store.historyCount(root.session.id), renderedEntries: runtime.store.historiesForTui([root.session.id]).length, elapsedMs: historyElapsedMs, rssDeltaBytes: historyMemoryAfter - historyMemoryBefore },
    inbox: { total: page.total, returned: page.messages.length, observations: observations.length, elapsedMs: inboxElapsedMs, rssDeltaBytes: inboxMemoryAfter - inboxMemoryBefore },
    tui: { sourceMessages: messageEntries, snapshotMessages: snapshot.state.messages.length, snapshotMs: tuiSnapshotMs },
    issue63: {
      context: { firstMs: contextFirstMs, repeat50Ms: contextRepeat50Ms, projectionBytes: JSON.stringify(contextProjection).length },
      microCompact: { pairs: microPairs, elapsedMs: microCompactMs },
      timeline: { frames: 100, elapsedMs: timelineFrames100Ms },
    },
  }, null, 2));
} finally {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
}
process.exit(0);
