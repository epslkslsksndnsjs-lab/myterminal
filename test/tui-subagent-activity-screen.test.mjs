// Headless render test for the read-only Subagent Activity page.
// Proves the self-talk + tool-call stream reaches the actual TUI frame.

import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { testRender } from '@opentui/react/test-utils';

import { SubagentActivityList, SubagentActivityScreen } from '../dist/tui/screens/Activity.js';
import { subagentActivityRecorder } from '../dist/tui/activity/recordings.js';
import { I18nProvider } from '../dist/tui/copy/context.js';
import { i18nFor } from '../dist/tui/copy/i18n.js';
import { themeFor } from '../dist/tui/state.js';

async function frame(node, width = 100, height = 30) {
  let setup;
  await act(async () => {
    setup = await testRender(createElement(I18nProvider, { value: i18nFor('en') }, node), { width, height });
    await setup.flush();
  });
  try {
    return setup.captureCharFrame();
  } finally {
    await act(async () => { setup.renderer?.destroy?.(); });
  }
}

function record(id, status = 'completed', result) {
  return {
    id,
    status,
    tasks: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    abortController: new AbortController(),
    ...(result !== undefined ? { result } : {}),
  };
}

function seedLiveRun(id) {
  const emit = (type, data) => subagentActivityRecorder.ingest({ subagentId: id, type, data, timestamp: 1 });
  emit('RUN_STARTED');
  emit('TEXT_MESSAGE_CONTENT', { delta: 'I will read the file.\n' });
  emit('TOOL_CALL_START', { name: 'read_file' });
  emit('TOOL_CALL_START', { name: 'read_file', id: 'call-1' });
  emit('TOOL_CALL_ARGS', { id: 'call-1', input: { path: '/tmp/x' } });
  emit('TOOL_CALL_RESULT', { id: 'call-1', result: { content: 'contents', is_error: false } });
  emit('STEP_FINISHED', { turn: 1 });
  emit('TEXT_MESSAGE_CONTENT', { delta: 'The file says contents.' });
  emit('RUN_FINISHED', { result: 'The file says contents.' });
}

describe('Activity screen renders the live stream', () => {
  test('self-talk and tool calls share one frame; tools expand on demand', async () => {
    seedLiveRun('sub-frame');
    const props = {
      subagents: [record('sub-frame')],
      selected: 0,
      width: 100,
      theme: themeFor('dark'),
    };

    // expandRev > 0 is what the ctrl+o binding produces while this subpage is open.
    const collapsed = await frame(createElement(SubagentActivityScreen, { ...props, expandRev: 0 }));
    assert.match(collapsed, /sub-frame/);
    assert.match(collapsed, /Completed/);
    assert.match(collapsed, /I will read the file\./);
    assert.match(collapsed, /The file says contents\./);
    assert.match(collapsed, /read_file/);
    assert.match(collapsed, /done/);
    assert.doesNotMatch(collapsed, /args:/);

    // 展开是状态更新后的重渲染：等帧落到含 args: 的那一帧，不靠一次性抓拍
    //（高负载下 flush 的 idle 判定可能早于重渲染落帧，抓拍式断言会假红）。
    let expandSetup;
    await act(async () => {
      expandSetup = await testRender(createElement(I18nProvider, { value: i18nFor('en') }, createElement(SubagentActivityScreen, { ...props, expandRev: 1 })), { width: 100, height: 30 });
      await expandSetup.flush();
    });
    try {
      const expanded = await expandSetup.waitForFrame((text) => /args:/.test(text) && /result: contents/.test(text));
      assert.match(expanded, /args:/);
      assert.match(expanded, /\/tmp\/x/);
      assert.match(expanded, /result: contents/);
    } finally {
      await act(async () => { expandSetup.renderer?.destroy?.(); });
    }
  });

  test('empty state and seeded final result are visible', async () => {
    const empty = await frame(createElement(SubagentActivityScreen, {
      subagents: [],
      selected: 0,
      width: 100,
      theme: themeFor('dark'),
      expandRev: 0,
    }));
    assert.match(empty, /No subagent activity/);

    const seeded = await frame(createElement(SubagentActivityScreen, {
      subagents: [record('sub-seeded', 'completed', 'final report from the record')],
      selected: 0,
      width: 100,
      theme: themeFor('dark'),
      expandRev: 0,
    }));
    assert.match(seeded, /final report from the record/);
    assert.match(seeded, /read-only|Completed/);
  });

  test('clicking a tool header collapses/expands that tool block', async () => {
    seedLiveRun('sub-click');
    let setup;
    await act(async () => {
      setup = await testRender(createElement(I18nProvider, { value: i18nFor('en') }, createElement(SubagentActivityScreen, {
        subagents: [record('sub-click')],
        selected: 0,
        width: 100,
        theme: themeFor('dark'),
        expandRev: 0,
      })), { width: 100, height: 30 });
      await setup.flush();
    });
    try {
      // 首帧也走等帧原语：seed 与挂载之间的 16ms 批量通知不参与首帧确定性。
      const collapsed = await setup.waitForFrame((text) => text.includes('read_file'));
      const headerRow = collapsed.split('\n').findIndex((line) => line.includes('read_file'));
      assert.ok(headerRow >= 0, 'tool header must be on screen');

      await act(async () => {
        await setup.mockMouse.click(4, headerRow);
      });
      // 点击→状态更新→重渲染：等帧落到展开态，不用一次性抓拍（负载下会假红）。
      const expanded = await setup.waitForFrame((text) => /args:/.test(text) && /result: contents/.test(text));

      const expandedHeaderRow = expanded.split('\n').findIndex((line) => line.includes('read_file'));
      assert.ok(expandedHeaderRow >= 0);
      await act(async () => {
        // Move away and wait out the click threshold, like a second human click.
        await setup.mockMouse.moveTo(0, 0);
        await new Promise((resolve) => { setTimeout(resolve, 60); });
        await setup.mockMouse.click(4, expandedHeaderRow);
      });
      // 折叠态：帧里不再有 args:。第二击若没生效，帧会停在展开态 → 等帧超时即红，不会真空过。
      const recollapsed = await setup.waitForFrame((text) => !/args:/.test(text));
      assert.doesNotMatch(recollapsed, /args:/);
    } finally {
      await act(async () => { setup.renderer?.destroy?.(); });
    }
  });

  test('concurrent conversations are listed separately and open into their own subpage', async () => {
    subagentActivityRecorder.ingest({ subagentId: 'sub-left', type: 'TEXT_MESSAGE_CONTENT', data: { delta: 'left conversation' }, timestamp: 1 });
    subagentActivityRecorder.ingest({ subagentId: 'sub-right', type: 'TEXT_MESSAGE_CONTENT', data: { delta: 'right conversation' }, timestamp: 1 });
    const subagents = [record('sub-left', 'running'), record('sub-right', 'running')];

    const list = await frame(createElement(SubagentActivityList, {
      subagents,
      selected: 0,
      theme: themeFor('dark'),
      onSelect: () => {},
      onOpen: () => {},
    }), 100, 24);
    assert.match(list, /sub-left/);
    assert.match(list, /sub-right/);
    assert.match(list, /left conversation/);
    assert.match(list, /right conversation/);
    assert.match(list, /concurrent runs stay separate/);

    const second = await frame(createElement(SubagentActivityScreen, {
      subagents,
      selected: 1,
      width: 100,
      theme: themeFor('dark'),
      expandRev: 0,
    }), 100, 24);
    assert.match(second, /sub-right/);
    assert.match(second, /right conversation/);
    assert.match(second, /2\/2/);
    assert.match(second, /switch conversation/);
  });

  test('clicking a conversation card opens its subpage', async () => {
    subagentActivityRecorder.ingest({ subagentId: 'sub-open', type: 'TEXT_MESSAGE_CONTENT', data: { delta: 'open me' }, timestamp: 1 });
    let opened = -1;
    let setup;
    await act(async () => {
      setup = await testRender(createElement(I18nProvider, { value: i18nFor('en') }, createElement(SubagentActivityList, {
        subagents: [record('sub-open', 'running')],
        selected: 0,
        theme: themeFor('dark'),
        onSelect: () => {},
        onOpen: (index) => { opened = index; },
      })), { width: 100, height: 24 });
      await setup.flush();
    });
    try {
      const row = setup.captureCharFrame().split('\n').findIndex((line) => line.includes('sub-open'));
      assert.ok(row >= 0);
      await act(async () => {
        await setup.mockMouse.click(5, row);
        await setup.flush();
      });
      assert.equal(opened, 0);
    } finally {
      await act(async () => { setup.renderer?.destroy?.(); });
    }
  });

  test('a removed conversation shows an explicit fallback instead of another conversation', async () => {
    const seen = await frame(createElement(SubagentActivityScreen, {
      subagents: [record('sub-still-here')],
      selected: -1,
      width: 100,
      theme: themeFor('dark'),
      expandRev: 0,
    }), 100, 20);
    assert.match(seen, /no longer available/);
    assert.doesNotMatch(seen, /sub-still-here/);
  });

  test('failed runs surface the error without a reply control', async () => {
    subagentActivityRecorder.ingest({
      subagentId: 'sub-failed',
      type: 'RUN_ERROR',
      data: { error: 'network down' },
      timestamp: 1,
    });
    const seen = await frame(createElement(SubagentActivityScreen, {
      subagents: [record('sub-failed', 'failed')],
      selected: 0,
      width: 100,
      theme: themeFor('dark'),
      expandRev: 0,
    }));
    assert.match(seen, /Failed/);
    assert.match(seen, /Error: network down/);
    assert.doesNotMatch(seen, /input|send/i);
  });
});
