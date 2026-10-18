// Subagent Activity page — parity tests for the renderer ported 1:1 from
// min-agent (transcript/markdown/width algorithms) plus the read-only AG-UI
// recorder that feeds it. No TUI renderer/native module is loaded here.

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { Transcript, advanceToolPulse } from '../dist/tui/activity/transcript.js';
import { Markdown, renderMarkdown, defaultMarkdownStyle } from '../dist/tui/activity/markdown.js';
import { stripAnsi, visibleWidth, wrapTextWithAnsi, truncateToWidth } from '../dist/tui/activity/terminal-utils.js';
import { parseAnsiLine, ANSI_ATTRIBUTES } from '../dist/tui/activity/ansi.js';
import {
  SubagentActivity,
  SubagentActivityRecorder,
  subagentActivityRecorder,
} from '../dist/tui/activity/recordings.js';
import { routeCommand } from '../dist/tui/model/command-router.js';
import { TABS } from '../dist/tui/state.js';
import { emitAgUi } from '../dist/subagent/tui-bridge.js';

const clean = (s) => stripAnsi(s).trim();

const event = (type, data, subagentId = 'sub-a') => ({ subagentId, type, data, timestamp: 1 });

// ─── Transcript parity (same expectations as min-agent's transcript.test.ts) ───

describe('ported Transcript', () => {
  test('renders a user block with the You label', () => {
    const t = new Transcript();
    t.addUser('hello');
    assert.deepEqual(t.render(80).map(clean), ['You: hello']);
  });

  test('streams assistant text into one markdown block across deltas', () => {
    const t = new Transcript();
    t.appendAssistant('Hel');
    t.appendAssistant('lo ');
    t.appendAssistant('world');
    assert.equal(t.getBlocks().length, 1);
    assert.deepEqual(t.render(80).map(clean), ['Hello world']);
  });

  test('starts a fresh assistant block after a user turn', () => {
    const t = new Transcript();
    t.addUser('hi');
    t.appendAssistant('one');
    t.addUser('again');
    t.appendAssistant('two');
    assert.deepEqual(t.render(80).map(clean), ['You: hi', 'one', 'You: again', 'two']);
  });

  test('endTurn closes the streaming assistant block', () => {
    const t = new Transcript();
    t.appendAssistant('part one');
    t.endTurn();
    t.appendAssistant('part two');
    assert.equal(t.getBlocks().length, 2);
  });

  test('collapsed tool block shows name, status, and ctrl+o hint', () => {
    const t = new Transcript();
    t.addTool('read_file', { path: '/tmp/x' });
    t.setToolResult('contents');
    assert.deepEqual(t.getBlocks(), [{ kind: 'tool', id: null, name: 'read_file', args: { path: '/tmp/x' }, result: 'contents', expanded: false, status: 'done' }]);
    const lines = t.render(80).map(stripAnsi);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /read_file/);
    assert.match(lines[0], /done/);
    assert.match(lines[0], /\(ctrl\+o to expand\)/);
  });

  test('expanded tool block renders args and result', () => {
    const t = new Transcript();
    t.addTool('read_file', { path: '/tmp/x' });
    t.setToolResult('contents');
    t.setToolsExpanded(true);
    const lines = t.render(80).map(stripAnsi);
    assert.match(lines[0], /read_file/);
    assert.match(lines[0], /done/);
    assert.ok(lines.some((line) => line.includes('args:')));
    assert.ok(lines.some((line) => line.includes('result: contents')));
  });

  test('setToolsExpanded(false) collapses every block again', () => {
    const t = new Transcript();
    t.addTool('read_file', { path: '/tmp/x' });
    t.setToolResult('contents');
    t.setToolsExpanded(true);
    t.setToolsExpanded(false);
    const lines = t.render(80).map(stripAnsi);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\(ctrl\+o to expand\)/);
  });

  test('expand-all state applies to existing and new tool blocks', () => {
    const t = new Transcript();
    t.addTool('a');
    t.addTool('b');
    t.toggleToolsExpanded();
    assert.equal(t.getToolsExpanded(), true);
    assert.deepEqual(t.getBlocks().map((b) => (b.kind === 'tool' ? b.expanded : null)), [true, true]);
    t.toggleToolsExpanded();
    assert.deepEqual(t.getBlocks().map((b) => (b.kind === 'tool' ? b.expanded : null)), [false, false]);
    t.setToolsExpanded(true);
    t.addTool('after');
    assert.deepEqual(t.getBlocks().map((b) => (b.kind === 'tool' ? b.expanded : null)), [true, true, true]);
  });

  test('expanded tool block without args/result omits those rows', () => {
    const t = new Transcript();
    t.addTool('read_file');
    t.setToolsExpanded(true);
    const lines = t.render(80).map(stripAnsi);
    assert.match(lines[0], /read_file/);
    assert.equal(lines.some((line) => line.includes('args:')), false);
  });

  test('result attaches to the last tool block', () => {
    const t = new Transcript();
    t.addTool('a');
    t.addTool('b');
    t.setToolResult('result for b');
    const blocks = t.getBlocks();
    assert.equal(blocks[0].result, null);
    assert.equal(blocks[1].result, 'result for b');
  });

  test('results match by id, not position (batched tool calls)', () => {
    const t = new Transcript();
    t.addTool('a', undefined, 'id-a');
    t.addTool('b', undefined, 'id-b');
    t.setToolResultById('id-a', 'result a');
    t.setToolResultById('id-b', 'result b');
    assert.equal(t.getBlocks()[0].result, 'result a');
    assert.equal(t.getBlocks()[1].result, 'result b');
  });

  test('marks a tool error by id', () => {
    const t = new Transcript();
    t.addTool('a', undefined, 'id-a');
    t.setToolResultById('id-a', 'error: boom');
    assert.equal(t.getBlocks()[0].status, 'error');
  });

  test('tracks running → done / error', () => {
    const t = new Transcript();
    t.addTool('a');
    assert.equal(t.getBlocks()[0].status, 'running');
    t.setToolResult('ok');
    assert.equal(t.getBlocks()[0].status, 'done');

    const t2 = new Transcript();
    t2.addTool('b');
    t2.setToolResult('error: boom');
    assert.equal(t2.getBlocks()[0].status, 'error');
    const lines = t2.render(80).map(stripAnsi);
    assert.match(lines[0], /b/);
    assert.match(lines[0], /error/);
  });

  test('wraps long assistant text', () => {
    const t = new Transcript();
    t.appendAssistant(Array.from({ length: 12 }, (_, i) => `w${i}`).join(' '));
    const lines = t.render(20).map(clean);
    assert.ok(lines.length > 1);
    assert.match(lines[0], /^w0/);
  });

  test('legacy raw lines and clear still work', () => {
    const t = new Transcript();
    t.appendLine('You: legacy');
    assert.deepEqual(t.render(80), ['You: legacy']);
    assert.deepEqual(t.getLines(), ['You: legacy']);
    t.appendAssistant('b');
    t.clear();
    assert.deepEqual(t.render(80), []);
    assert.deepEqual(t.getBlocks(), []);
  });

  test('concurrent tool blocks collapse independently', () => {
    const t = new Transcript();
    t.addTool('grep', undefined, 'id-a');
    t.addTool('glob', undefined, 'id-b');

    assert.equal(t.render(80).length, 2, 'both collapsed = one header row each');
    assert.equal(t.getToolBlockIndexAtLine(0), 0);
    assert.equal(t.getToolBlockIndexAtLine(1), 1);

    t.toggleToolExpanded(0);
    const lines = t.render(80);
    assert.equal(t.getBlocks()[0].expanded, true);
    assert.equal(t.getBlocks()[1].expanded, false, 'collapsing one concurrent tool must not touch the other');
    assert.equal(t.getToolBlockIndexAtLine(0), 0, 'expanded block still maps its header');
    assert.equal(t.getToolBlockIndexAtLine(lines.length - 1), 1, 'the other header stays clickable');

    t.toggleToolExpanded(0);
    assert.equal(t.render(80).length, 2, 're-collapsing restores one row per tool');

    t.toggleToolsExpanded();
    assert.deepEqual(t.getBlocks().map((block) => block.expanded), [true, true]);
  });

  test('pulse frames advance for running tools', () => {
    const t = new Transcript();
    t.addTool('a');
    const first = clean(t.render(80)[0]);
    advanceToolPulse();
    const second = clean(t.render(80)[0]);
    assert.notEqual(first, second);
  });
});

// ─── Markdown parity (same expectations as min-agent's markdown.test.ts) ───

describe('ported Markdown', () => {
  const plain = (lines) => lines.map((line) => stripAnsi(line)).join('\n');

  test('renders a top-level heading without a # prefix', () => {
    const text = plain(renderMarkdown('# Hello', 40));
    assert.match(text, /Hello/);
    assert.doesNotMatch(text, /# Hello/);
  });

  test('renders a level-3 heading with prefix', () => {
    assert.match(plain(renderMarkdown('### Hello', 40)), /### Hello/);
  });

  test('renders unordered and ordered lists', () => {
    const unordered = plain(renderMarkdown('- a\n- b', 40));
    assert.match(unordered, /- a/);
    assert.match(unordered, /- b/);
    const ordered = plain(renderMarkdown('1. one\n2. two', 40));
    assert.match(ordered, /1\. one/);
    assert.match(ordered, /2\. two/);
  });

  test('renders fenced code blocks with borders', () => {
    const text = plain(renderMarkdown('```ts\nconst x = 1\n```', 40));
    assert.match(text, /```ts/);
    assert.match(text, /const x = 1/);
    assert.match(text, /```/);
  });

  test('renders blockquotes and width-aware tables', () => {
    assert.match(plain(renderMarkdown('> quoted text', 40)), /│ quoted text/);
    const table = plain(renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |', 40));
    assert.match(table, /┌─/);
    assert.match(table, /│ a/);
    assert.match(table, /│ 1/);
    assert.match(table, /┴/);
    assert.match(table, /┘/);
  });

  test('renders inline bold, italic, code', () => {
    const text = plain(renderMarkdown('**bold** *em* `code`', 40));
    assert.match(text, /bold/);
    assert.match(text, /em/);
    assert.match(text, /code/);
  });

  test('wraps long text and CJK within the viewport', () => {
    for (const line of renderMarkdown('word '.repeat(40), 20)) {
      assert.ok(visibleWidth(line) <= 20);
    }
    for (const line of renderMarkdown('中文测试内容'.repeat(10), 20)) {
      assert.ok(visibleWidth(line) <= 20);
    }
  });

  test('does not shrink a streaming code block on a partial closing fence', () => {
    assert.match(plain(renderMarkdown('```ts\nconst x = 1\n```', 40)), /```/);
  });

  test('caches render output for identical text/width', () => {
    const md = new Markdown('hi', defaultMarkdownStyle);
    const first = md.render(40);
    assert.deepEqual(md.render(40), first);
    md.setText('bye');
    assert.notDeepEqual(md.render(40), first);
  });
});

// ─── Width/wrap parity ───

describe('ported terminal width utilities', () => {
  test('visibleWidth ignores ANSI and counts CJK as two columns', () => {
    assert.equal(visibleWidth('\x1b[31mred\x1b[0m'), 3);
    assert.equal(visibleWidth('中文'), 4);
    assert.equal(visibleWidth('abc'), 3);
  });

  test('wrapTextWithAnsi preserves text and width', () => {
    const wrapped = wrapTextWithAnsi('one two three four', 8);
    assert.ok(wrapped.length > 1);
    for (const line of wrapped) assert.ok(visibleWidth(line) <= 8);
    assert.equal(wrapped.join(' ').replace(/\s+/g, ' ').trim(), 'one two three four');
  });

  test('truncateToWidth keeps ANSI codes out of the width budget', () => {
    const out = truncateToWidth('\x1b[32mabcdef\x1b[0m', 5);
    assert.equal(visibleWidth(out), 5);
    assert.match(stripAnsi(out), /^ab\.\.\.$/);
  });
});

// ─── ANSI bridge ───

describe('ANSI bridge', () => {
  test('maps the tool panel background and status colors', () => {
    const t = new Transcript();
    t.addTool('read_file', { path: '/x' });
    t.setToolResult('contents');
    const segments = parseAnsiLine(t.render(80)[0]);
    assert.ok(segments.some((segment) => segment.bg === '#262626'), 'tool panel bg (256-color 235) must survive');
    assert.ok(segments.some((segment) => segment.text === 'done' && segment.fg === '#0dbc79'), 'done must be green');
  });

  test('maps running status to the reference magenta', () => {
    const t = new Transcript();
    t.addTool('read_file');
    const segments = parseAnsiLine(t.render(80)[0]);
    assert.ok(segments.some((segment) => segment.text.includes('running') && segment.fg === '#bc3fbc'));
  });

  test('maps markdown bold to the bold attribute', () => {
    const segments = parseAnsiLine(renderMarkdown('**bold**', 40)[0]);
    assert.ok(segments.some((segment) => segment.text === 'bold' && (segment.attributes & ANSI_ATTRIBUTES.BOLD) !== 0));
  });

  test('maps user panel colors and strips non-SGR escapes', () => {
    const t = new Transcript();
    t.addUser('hi');
    const segments = parseAnsiLine(t.render(20)[0]);
    assert.ok(segments.some((segment) => segment.bg === '#585858'), 'user panel bg (256-color 240) must survive');
    assert.ok(segments.some((segment) => segment.fg === '#f2f2f2'));
    const dropped = parseAnsiLine('\x1b]8;;http://x\x07link\x1b]8;;\x07');
    assert.equal(dropped.map((segment) => segment.text).join(''), 'link');
  });
});

// ─── AG-UI → transcript mapping ───

describe('SubagentActivity event mapping', () => {
  test('merges self-talk and tool calls in arrival order without duplicate blocks', () => {
    const activity = new SubagentActivity();
    activity.apply(event('RUN_STARTED'));
    activity.apply(event('TEXT_MESSAGE_CONTENT', { delta: 'I will read ' }));
    activity.apply(event('TEXT_MESSAGE_CONTENT', { delta: 'the file.' }));
    activity.apply(event('TOOL_CALL_START', { name: 'read_file' }));
    activity.apply(event('TOOL_CALL_ARGS', { delta: '{"path":' }));
    activity.apply(event('TOOL_CALL_START', { name: 'read_file', id: 'call-1' }));
    activity.apply(event('TOOL_CALL_ARGS', { id: 'call-1', input: { path: '/tmp/x' } }));
    activity.apply(event('TOOL_CALL_RESULT', { id: 'call-1', result: { tool_use_id: 'call-1', content: 'contents', is_error: false } }));
    activity.apply(event('STEP_FINISHED'));
    activity.apply(event('TEXT_MESSAGE_CONTENT', { delta: 'Done.' }));

    const blocks = activity.transcript.getBlocks();
    assert.deepEqual(blocks.map((block) => block.kind), ['assistant', 'tool', 'assistant']);
    assert.equal(blocks[0].text, 'I will read the file.');
    assert.equal(blocks[1].name, 'read_file');
    assert.equal(blocks[1].id, 'call-1');
    assert.deepEqual(blocks[1].args, { path: '/tmp/x' });
    assert.equal(blocks[1].result, 'contents');
    assert.equal(blocks[1].status, 'done');
    assert.equal(blocks[2].text, 'Done.');
    assert.deepEqual(activity.transcript.render(80).map(clean).filter(Boolean).length > 0, true);
  });

  test('matches parallel tool results by id regardless of completion order', () => {
    const activity = new SubagentActivity();
    activity.apply(event('TOOL_CALL_START', { name: 'grep' }));
    activity.apply(event('TOOL_CALL_START', { name: 'glob' }));
    activity.apply(event('TOOL_CALL_START', { name: 'grep', id: 'g1' }));
    activity.apply(event('TOOL_CALL_START', { name: 'glob', id: 'g2' }));
    activity.apply(event('TOOL_CALL_RESULT', { id: 'g2', result: { content: 'glob-result', is_error: false } }));
    activity.apply(event('TOOL_CALL_RESULT', { id: 'g1', result: { content: 'grep-result', is_error: false } }));
    const blocks = activity.transcript.getBlocks();
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].id, 'g1');
    assert.equal(blocks[0].result, 'grep-result');
    assert.equal(blocks[1].id, 'g2');
    assert.equal(blocks[1].result, 'glob-result');
    assert.ok(blocks.every((block) => block.status === 'done'));
  });

  test('same-name parallel tools bind ids FIFO without cross-wiring', () => {
    const activity = new SubagentActivity();
    activity.apply(event('TOOL_CALL_START', { name: 'grep' }));
    activity.apply(event('TOOL_CALL_START', { name: 'grep' }));
    activity.apply(event('TOOL_CALL_ARGS', { delta: '{"pattern":"first"}' }));
    activity.apply(event('TOOL_CALL_ARGS', { delta: '{"pattern":"second"}' }));
    activity.apply(event('TOOL_CALL_START', { name: 'grep', id: 'c1' }));
    activity.apply(event('TOOL_CALL_START', { name: 'grep', id: 'c2' }));
    activity.apply(event('TOOL_CALL_ARGS', { id: 'c1', input: { pattern: 'first' } }));
    activity.apply(event('TOOL_CALL_ARGS', { id: 'c2', input: { pattern: 'second' } }));
    activity.apply(event('TOOL_CALL_RESULT', { id: 'c1', result: { content: 'first-result', is_error: false } }));
    activity.apply(event('TOOL_CALL_RESULT', { id: 'c2', result: { content: 'second-result', is_error: false } }));

    const blocks = activity.transcript.getBlocks();
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map((block) => block.id), ['c1', 'c2']);
    assert.deepEqual(blocks.map((block) => block.args), [{ pattern: 'first' }, { pattern: 'second' }]);
    assert.deepEqual(blocks.map((block) => block.result), ['first-result', 'second-result']);
    assert.ok(blocks.every((block) => block.status === 'done'));
  });

  test('rejected or skipped tool calls settle at step end instead of spinning forever', () => {
    const activity = new SubagentActivity();
    activity.apply(event('TOOL_CALL_START', { name: 'unknown_tool' }));
    activity.apply(event('STEP_FINISHED', { turn: 1 }));
    const [block] = activity.transcript.getBlocks();
    assert.equal(block.status, 'error');
    assert.match(block.result, /rejected or skipped/);
    assert.equal(activity.transcript.hasRunning(), false);
  });

  test('run end also settles any remaining unreported tool blocks', () => {
    const activity = new SubagentActivity();
    activity.apply(event('TOOL_CALL_START', { name: 'blocked_tool' }));
    activity.apply(event('RUN_ERROR', { error: 'boom' }));
    assert.equal(activity.transcript.getBlocks()[0].status, 'error');
    assert.equal(activity.transcript.hasRunning(), false);
  });

  test('marks tool errors from both result shapes', () => {
    const activity = new SubagentActivity();
    activity.apply(event('TOOL_CALL_START', { name: 'run_bash', id: 'e1' }));
    activity.apply(event('TOOL_CALL_RESULT', { id: 'e1', result: { content: 'boom', is_error: true } }));
    assert.equal(activity.transcript.getBlocks()[0].status, 'error');
    assert.equal(activity.transcript.getBlocks()[0].result, 'boom');

    activity.apply(event('TOOL_CALL_START', { name: 'run_bash', id: 'e2' }));
    activity.apply(event('TOOL_CALL_RESULT', { id: 'e2', error: 'crash' }));
    assert.equal(activity.transcript.getBlocks()[1].status, 'error');
    assert.equal(activity.transcript.getBlocks()[1].result, 'error: crash');
  });

  test('tracks run status, turns, and abort reason', () => {
    const activity = new SubagentActivity();
    activity.apply(event('RUN_STARTED'));
    activity.apply(event('STEP_STARTED', { turn: 3 }));
    assert.equal(activity.turns, 3);
    activity.apply(event('RUN_ERROR', { reason: 'user_abort', error: 'Aborted by parent' }));
    assert.equal(activity.status, 'aborted');
    assert.equal(activity.error, 'Aborted by parent');

    const failed = new SubagentActivity();
    failed.apply(event('RUN_ERROR', { error: 'network down' }));
    assert.equal(failed.status, 'failed');

    const done = new SubagentActivity();
    done.apply(event('RUN_FINISHED', { result: 'summary' }));
    assert.equal(done.status, 'completed');
    assert.equal(done.result, 'summary');
  });

  test('ignores unknown event types and id-less args without a call', () => {
    const activity = new SubagentActivity();
    activity.apply(event('STATE_SNAPSHOT', { tasks: [{ id: 't' }] }));
    activity.apply(event('TOOL_CALL_ARGS', { delta: 'orphan' }));
    assert.deepEqual(activity.transcript.getBlocks(), []);
  });

  test('seeds a missed final report exactly once', () => {
    const activity = new SubagentActivity();
    const record = { id: 'sub-a', status: 'completed', result: 'final report' };
    activity.seed(record);
    activity.seed(record);
    assert.equal(activity.status, 'completed');
    assert.equal(activity.transcript.getBlocks().length, 1);
    assert.equal(activity.transcript.getBlocks()[0].kind, 'assistant');
    assert.equal(activity.transcript.getBlocks()[0].text, 'final report');
  });

  test('does not seed over streamed assistant text', () => {
    const activity = new SubagentActivity();
    activity.apply(event('TEXT_MESSAGE_CONTENT', { delta: 'streamed' }));
    activity.seed({ id: 'sub-a', status: 'completed', result: 'final report' });
    assert.equal(activity.transcript.getBlocks().length, 1);
    assert.equal(activity.transcript.getBlocks()[0].text, 'streamed');
  });
});

// ─── Recorder batching/listener seam ───

describe('bus wiring', () => {
  test('the global recorder consumes real AG-UI events without touching subagent state', () => {
    emitAgUi('bus-test', 'TEXT_MESSAGE_CONTENT', { delta: 'via the real bus' });
    const activity = subagentActivityRecorder.get('bus-test');
    assert.ok(activity);
    assert.equal(activity.transcript.getBlocks()[0].text, 'via the real bus');
  });
});

describe('navigation', () => {
  test('Activity is appended as the twelfth tab and has command aliases', () => {
    assert.equal(TABS.length, 12);
    assert.equal(TABS[11], 'Activity');
    assert.deepEqual(routeCommand('/activity'), { kind: 'navigate', tab: 11 });
    assert.deepEqual(routeCommand('/活动'), { kind: 'navigate', tab: 11 });
  });
});

describe('SubagentActivityRecorder', () => {
  test('records per subagent, batches notifications, and isolates ids', () => {
    const recorder = new SubagentActivityRecorder();
    let notifications = 0;
    const unsubscribe = recorder.subscribe(() => { notifications += 1; });
    recorder.ingest(event('TEXT_MESSAGE_CONTENT', { delta: 'a' }, 'one'));
    recorder.ingest(event('TEXT_MESSAGE_CONTENT', { delta: 'b' }, 'two'));
    assert.equal(notifications, 0);
    recorder.flush();
    assert.equal(notifications, 1);
    assert.equal(recorder.get('one').transcript.getBlocks()[0].text, 'a');
    assert.equal(recorder.get('two').transcript.getBlocks()[0].text, 'b');
    assert.deepEqual(recorder.ids(), ['one', 'two']);
    unsubscribe();
    recorder.flush();
    assert.equal(notifications, 1);
  });

  test('retain drops activities whose records are gone', () => {
    const recorder = new SubagentActivityRecorder();
    recorder.ingest(event('TEXT_MESSAGE_CONTENT', { delta: 'a' }, 'keep'));
    recorder.ingest(event('TEXT_MESSAGE_CONTENT', { delta: 'b' }, 'drop'));
    recorder.retain(['keep']);
    assert.deepEqual(recorder.ids(), ['keep']);
  });

  test('ensure seeds and reuses the same activity object', () => {
    const recorder = new SubagentActivityRecorder();
    const record = { id: 'seed', status: 'failed', result: undefined, error: 'bad' };
    const first = recorder.ensure(record);
    const second = recorder.ensure(record);
    assert.equal(first, second);
    assert.equal(first.status, 'failed');
    assert.equal(first.error, 'bad');
  });
});
