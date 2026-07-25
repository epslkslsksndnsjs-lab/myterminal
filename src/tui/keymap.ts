import { useBindings } from '@opentui/keymap/react';
import type { Detail } from './state.js';

type Actions = {
  enabled: boolean;
  tab: number;
  detail?: Detail;
  inputEditing: boolean;
  switchTab: (index: number) => void;
  nextTab: (delta: number) => void;
  back: () => void;
  quit: () => void | Promise<void>;
  moveSelection: (delta: number) => void;
  open: () => void;
  createSession: () => void | Promise<void>;
  sessionAction: () => void | Promise<void>;
  sendMessage: () => void | Promise<void>;
  refreshDiff: () => void | Promise<void>;
  addExtension: () => void | Promise<void>;
  removeExtension: () => void | Promise<void>;
  configure: () => void | Promise<void>;
  rotateCredentials: () => void | Promise<void>;
  updateApplication: () => void | Promise<void>;
  toggleAudit: () => void;
  enterInput: () => void;
  openHelp: () => void;
};

const command = (run: () => void | Promise<void>) => () => { void run(); return true; };

/**
 * useAppKeymap — 键盘路由五层优先级（ADR-0004 决策 4、9）：
 *   form(400) → input-editing(350) → detail-esc(300) → page(200) → global(100)。
 * form 由 FormDialog 自管理（priority 400），不在此函数内。
 * input-editing 由 InputBar 自管理（priority 350），不在此函数内。
 * 此处管理 detail-esc(300) / page(200) / global(100) 三层。
 * page 与 global 层在 inputEditing 为 true 时 disabled，实现隔离。
 */
export function useAppKeymap(actions: Actions): void {
  const { enabled, tab, detail, inputEditing } = actions;

  // layer 300: detail esc
  useBindings(() => ({
    priority: 300,
    enabled: enabled && Boolean(detail),
    bindings: [{ key: 'escape', cmd: command(actions.back) }],
  }), [enabled, detail, actions.back]);

  // layer 200: page actions (disabled when inputEditing)
  useBindings(() => ({
    priority: 200,
    enabled: enabled && !detail && !inputEditing,
    bindings: [
      ...([1, 2, 5].includes(tab) ? [
        { key: 'down', cmd: command(() => actions.moveSelection(1)) },
        { key: 'up', cmd: command(() => actions.moveSelection(-1)) },
        { key: 'j', cmd: command(() => actions.moveSelection(1)) },
        { key: 'k', cmd: command(() => actions.moveSelection(-1)) },
        { key: 'pagedown', cmd: command(() => actions.moveSelection(10)) },
        { key: 'pageup', cmd: command(() => actions.moveSelection(-10)) },
        { key: 'home', cmd: command(() => actions.moveSelection(-Number.MAX_SAFE_INTEGER)) },
        { key: 'end', cmd: command(() => actions.moveSelection(Number.MAX_SAFE_INTEGER)) },
      ] : []),
      ...(tab === 1 ? [
        { key: 'return', cmd: command(actions.open) },
        { key: 'n', cmd: command(actions.createSession) },
        { key: 'u', cmd: command(actions.sessionAction) },
      ] : []),
      ...(tab === 2 ? [
        { key: 'return', cmd: command(actions.open) },
        { key: 'm', cmd: command(actions.sendMessage) },
      ] : []),
      ...(tab === 4 ? [{ key: 'r', cmd: command(actions.refreshDiff) }] : []),
      ...(tab === 5 ? [
        { key: 'e', cmd: command(actions.addExtension) },
        { key: 'x', cmd: command(actions.removeExtension) },
      ] : []),
      ...([0, 6].includes(tab) ? [
        { key: 'c', cmd: command(actions.configure) },
      ] : []),
      ...(tab === 6 ? [{ key: 'k', cmd: command(actions.rotateCredentials) }, { key: 'u', cmd: command(actions.updateApplication) }] : []),
      ...(tab === 7 ? [{ key: 'a', cmd: command(actions.toggleAudit) }] : []),
    ],
  }), [enabled, detail, tab, inputEditing, actions.moveSelection, actions.open, actions.createSession, actions.sessionAction, actions.sendMessage, actions.refreshDiff, actions.addExtension, actions.removeExtension, actions.configure, actions.rotateCredentials, actions.updateApplication, actions.toggleAudit]);

  // layer 100: global shortcuts (disabled when inputEditing)
  useBindings(() => ({
    priority: 100,
    enabled: enabled && !inputEditing,
    bindings: [
      ...Array.from({ length: 8 }, (_, index) => ({ key: String(index + 1), cmd: command(() => actions.switchTab(index)) })),
      { key: 'tab', cmd: command(() => actions.nextTab(1)) },
      { key: 'shift+tab', cmd: command(() => actions.nextTab(-1)) },
      { key: 'q', cmd: command(actions.quit) },
      { key: 'ctrl+c', cmd: command(actions.quit) },
      { key: 'i', cmd: command(actions.enterInput) },
      { key: '/', cmd: command(actions.enterInput) },
      { key: '?', cmd: command(actions.openHelp) },
    ],
  }), [enabled, inputEditing, actions.switchTab, actions.nextTab, actions.quit, actions.enterInput, actions.openHelp]);
}
