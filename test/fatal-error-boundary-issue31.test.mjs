// #70 门禁锁测试：FatalErrorBoundary 在缺 I18nProvider 时必须仍渲染致命错误屏（main 09f2246 行为）。
// 回归背景：#31 改造后 boundary 曾在 !i18n 时整体 return null——白屏 + 吞掉「按 q/Esc 退出」唯一指引。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { FatalErrorBoundary } from '../dist/tui/FatalErrorBoundary.js';
import { I18nContext } from '../dist/tui/copy/context.js';
import { i18nFor } from '../dist/tui/copy/i18n.js';

// 递归展开 React 元素树（不依赖 react-dom/OpenTUI；Consumer/函数组件手动展开）。
function collectText(node, i18nValue) {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((n) => collectText(n, i18nValue)).join('');
  if (typeof node === 'object' && node.type !== undefined) {
    const { type, props } = node;
    // Context.Consumer：children 是 render-prop，喂入 i18nValue
    if (type === I18nContext.Consumer || (type && type.$$typeof && String(type.$$typeof).includes('context'))) {
      const rendered = props.children(i18nValue);
      return collectText(rendered, i18nValue);
    }
    if (typeof type === 'function') {
      // 函数/类组件尽力展开；用 hooks 的组件（如 Mascot）裸调会抛，跳过其子树（与断言无关）。
      try {
        if (type.prototype && type.prototype.isReactComponent) {
          const inst = new type(props);
          return collectText(inst.render(), i18nValue);
        }
        return collectText(type(props), i18nValue);
      } catch {
        return '';
      }
    }
    return collectText(props?.children, i18nValue);
  }
  return '';
}

function renderFatal(i18nValue) {
  const runtime = { log: () => {}, config: { uiLanguage: 'zh-CN' } };
  const theme = { background: '#000', bad: '#f00', text: '#fff', muted: '#888' };
  const boundary = new FatalErrorBoundary({ runtime, theme, onFatal: () => {}, children: null });
  boundary.state = { error: new Error('boom-from-render') };
  const tree = boundary.render();
  return collectText(tree, i18nValue);
}

test('FATAL-LOCK-1: 缺 I18nProvider 时致命错误屏仍渲染安全退出指引（main 基线行为）', () => {
  const out = renderFatal(undefined); // Consumer 收到 undefined = 无 Provider
  assert.ok(out.length > 0, '缺 provider 时渲染产物不得为空（白屏回归）');
  assert.match(out, /按 q 或 Esc|Press q or Esc/, '必须包含安全退出指引');
  assert.match(out, /boom-from-render/, '必须展示原始错误信息');
});

test('FATAL-LOCK-2: 有 I18nProvider 时按 provider 语言渲染（zh-CN）', () => {
  const out = renderFatal(i18nFor('zh-CN'));
  assert.match(out, /按 q 或 Esc 安全退出/);
  assert.match(out, /严重错误/);
});

test('FATAL-LOCK-3: 有 I18nProvider（en）时渲染英文指引', () => {
  const out = renderFatal(i18nFor('en'));
  assert.match(out, /Press q or Esc to exit safely/);
  assert.match(out, /Fatal error/);
});

test('FATAL-LOCK-4: 开发不变量错误的开发指令文案不得渲染给用户（AI_RULES），普通错误不受影响', async () => {
  const { DevInvariantError } = await import('../dist/tui/copy/context.js');
  const runtime = { log: () => {}, config: { uiLanguage: 'zh-CN' } };
  const theme = { background: '#000', bad: '#f00', text: '#fff', muted: '#888' };
  const boundary = new FatalErrorBoundary({ runtime, theme, onFatal: () => {}, children: null });
  boundary.state = { error: new DevInvariantError('useI18n() used outside <I18nProvider>. Wrap the render root with I18nProvider.') };
  const out = collectText(boundary.render(), undefined);
  assert.ok(out.length > 0, '仍必须渲染致命错误屏');
  assert.match(out, /按 q 或 Esc|Press q or Esc/, '安全退出指引不受影响');
  assert.doesNotMatch(out, /useI18n|I18nProvider|Wrap the render root/, '开发指令不得作为 UI 文案泄漏给用户');
  assert.match(out, /界面内部错误|Internal interface error/, '须用用户向兜底文案替代');
});
