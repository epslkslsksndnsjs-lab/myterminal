// 旧 Subagent 详情屏：思考流（thinking: true）只进 Activity 页的自述面板，
// 不许混进本屏的"输出"面板——输出保持助手消息口径（executor 侧同一契约：
// thinking 是展示专用的自言自语，不回传、不当作助手输出）。
//
// 守卫回归：executor 给思考流打上 thinking: true 之前，本屏把所有
// TEXT_MESSAGE_CONTENT 无差别并进输出文本；打标之后若本屏不认这个标，
// 网关的 reasoning_delta 就会混进"输出"，用户分不清哪句是助手的回答。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { testRender } from '@opentui/react/test-utils';

import { SubagentDetail } from '../dist/tui/screens/Subagent.js';
import { createSubagent, clearAllSubagents } from '../dist/subagent/store.js';
import { emitAgUi } from '../dist/subagent/tui-bridge.js';
import { I18nProvider } from '../dist/tui/copy/context.js';
import { i18nFor } from '../dist/tui/copy/i18n.js';
import { themeFor } from '../dist/tui/state.js';

afterEach(() => {
  clearAllSubagents();
});

test('思考流不进"输出"：只有 thinking 增量时输出面板不出现，正常增量照常上屏', async () => {
  const id = 'sub-detail-thinking';
  createSubagent(id, { subject: 'detail thinking guard' });

  let setup;
  await act(async () => {
    setup = await testRender(createElement(I18nProvider, { value: i18nFor('en') }, createElement(SubagentDetail, { subagentId: id, theme: themeFor('dark') })), { width: 100, height: 30 });
    await setup.flush();
  });

  // 订阅在挂载时建立：只发思考增量，等 16ms 批量 flush 落帧。
  // 等帧条件用"事件流里出现该事件"作落帧信号——输出面板不许被撑出来才是断言本体。
  await act(async () => {
    emitAgUi(id, 'TEXT_MESSAGE_CONTENT', { delta: 'thinking out loud', thinking: true });
    await new Promise((resolve) => { setTimeout(resolve, 40); });
  });
  const afterThinking = await setup.waitForFrame((text) => text.includes('thinking out loud'));
  assert.doesNotMatch(afterThinking, /Output/, '思考流不许把"输出"面板撑出来');

  // 对照：正常文本增量照常进输出面板（守卫没把正常流一起挡掉）。
  await act(async () => {
    emitAgUi(id, 'TEXT_MESSAGE_CONTENT', { delta: 'real answer' });
    await new Promise((resolve) => { setTimeout(resolve, 40); });
  });
  // 等到"real answer"出现在事件流 JSON 之外的一行——即输出面板里。
  const afterText = await setup.waitForFrame((text) =>
    text.split('\n').some((line) => line.includes('real answer') && !line.includes('TEXT_MESSAGE_CONTENT')),
  );
  assert.match(afterText, /Output/, '正常助手文本必须渲染出输出面板');

  // 混合态下思考流也只许留在原始事件流里，不许以任何非 JSON 形态上屏。
  const lines = afterText.split('\n');
  assert.ok(
    !lines.some((line) => line.includes('thinking out loud') && !line.includes('TEXT_MESSAGE_CONTENT')),
    '混合流里思考流不许进输出面板',
  );

  await act(async () => { setup.renderer?.destroy?.(); });
});
