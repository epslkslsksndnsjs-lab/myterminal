import { useBindings } from '@opentui/keymap/react';
import type { Detail } from './state.js';

type Actions = {
  enabled: boolean;
  tab: number;
  detail?: Detail;
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
};

const command = (run: () => void | Promise<void>) => () => { void run(); return true; };

export function useAppKeymap(actions: Actions): void {
  const { enabled, tab, detail } = actions;

  useBindings(() => ({
    priority: 300,
    enabled: enabled && Boolean(detail),
    bindings: [{ key: 'escape', cmd: command(actions.back) }],
  }), [enabled, detail, actions.back]);

  useBindings(() => ({
    priority: 200,
    enabled: enabled && !detail,
    bindings: [
      ...([1, 2, 4].includes(tab) ? [
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
      ...(tab === 3 ? [{ key: 'r', cmd: command(actions.refreshDiff) }] : []),
      ...(tab === 4 ? [
        { key: 'e', cmd: command(actions.addExtension) },
        { key: 'x', cmd: command(actions.removeExtension) },
      ] : []),
      ...([0, 5].includes(tab) ? [
        { key: 'c', cmd: command(actions.configure) },
      ] : []),
      ...(tab === 5 ? [{ key: 'k', cmd: command(actions.rotateCredentials) }, { key: 'u', cmd: command(actions.updateApplication) }] : []),
      ...(tab === 6 ? [{ key: 'a', cmd: command(actions.toggleAudit) }] : []),
    ],
  }), [enabled, detail, tab, actions.moveSelection, actions.open, actions.createSession, actions.sessionAction, actions.sendMessage, actions.refreshDiff, actions.addExtension, actions.removeExtension, actions.configure, actions.rotateCredentials, actions.updateApplication, actions.toggleAudit]);

  useBindings(() => ({
    priority: 100,
    enabled,
    bindings: [
      ...Array.from({ length: 7 }, (_, index) => ({ key: String(index + 1), cmd: command(() => actions.switchTab(index)) })),
      { key: 'tab', cmd: command(() => actions.nextTab(1)) },
      { key: 'shift+tab', cmd: command(() => actions.nextTab(-1)) },
      { key: 'q', cmd: command(actions.quit) },
      { key: 'ctrl+c', cmd: command(actions.quit) },
    ],
  }), [enabled, actions.switchTab, actions.nextTab, actions.quit]);
}
