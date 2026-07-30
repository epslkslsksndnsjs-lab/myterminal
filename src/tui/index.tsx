import { createCliRenderer, type CliRenderer } from '@opentui/core';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider } from '@opentui/keymap/react';
import { createRoot, type Root } from '@opentui/react';
import { createElement } from 'react';
import type { MyTerminalRuntime } from '../server.js';
import type { WorkspaceRecord } from '../instances.js';
import { isDirectory } from '../config.js';
import { isAddWorkspaceSelection, selectedWorkspace } from '../workspace-selection.js';
import type { MyTerminalSettings } from '../types.js';
import { App } from './App.js';
import { Setup } from './Setup.js';
import { themeFor, TuiController, type FormQuestion, type RuntimeReconfigure } from './state.js';
import { FormDialog } from './components/FormDialog.js';
import { buildWorkspaceSelectorModel } from './workspace-selector.js';
import { i18nFor, type I18n } from './copy/i18n.js';
import { I18nProvider } from './copy/context.js';
import { rendererProfile } from './renderer-profile.js';

export type { RuntimeReconfigure, RuntimeReconfigureResult } from './state.js';

async function createRenderer(): Promise<CliRenderer> {
  return createCliRenderer({
    ...rendererProfile(),
    exitOnCtrlC: false,
    clearOnShutdown: true,
    autoFocus: true,
  });
}

function renderWithKeymap(renderer: CliRenderer, node: ReturnType<typeof createElement>, i18n: I18n): Root {
  const keymap = createDefaultOpenTuiKeymap(renderer);
  const root = createRoot(renderer);
  // i18n 是渲染根的一部分：这些入口在 App 之外直接挂 FormDialog，没有 App 的 Provider 兜底。
  root.render(createElement(KeymapProvider, { keymap }, createElement(I18nProvider, { value: i18n }, node)));
  return root;
}

export async function runSetupTui(defaults: MyTerminalSettings, records: WorkspaceRecord[] = []): Promise<MyTerminalSettings> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('First launch requires the TUI. Run `bun run dev` in an interactive terminal.');
  const renderer = await createRenderer();
  let root: Root | undefined;
  try {
    return await new Promise<MyTerminalSettings>((resolve, reject) => {
      root = renderWithKeymap(renderer, createElement(Setup, {
        defaults,
        records,
        mouseEnabled: renderer.useMouse,
        onComplete: resolve,
        onCancel: () => reject(new Error('Setup cancelled.')),
      }), i18nFor(defaults.uiLanguage));
    });
  } finally {
    root?.unmount();
    renderer.destroy();
  }
}

export async function runWorkspaceChooserTui(records: WorkspaceRecord[], currentWorkspaceDir: string, lang = 'zh-CN'): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Workspace selection requires an interactive terminal.');
  const renderer = await createRenderer();
  const i18n = i18nFor(lang);
  const t = i18n.t;
  let root: Root | undefined;
  const { items, question } = buildWorkspaceSelectorModel({
    label: t('Select workspace', '选择工作区'),
    records,
    currentWorkspaceDir,
    t,
  });
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      root = renderWithKeymap(renderer, createElement(FormDialog, {
        questions: [question],
        preamble: [renderer.useMouse
          ? t('Choose a workspace with arrow keys or the mouse.', '使用方向键或鼠标选择工作区。')
          : t('Choose a workspace with arrow keys and press Enter.', '使用方向键选择工作区，按 Enter 确认。')],
        theme: themeFor('dark'),
        width: renderer.width,
        height: renderer.height,
        mouseEnabled: renderer.useMouse,
        onComplete: (answers: string[]) => {
          const selected = selectedWorkspace(items, answers[0]);
          if (!selected) { reject(new Error('Invalid workspace selection.')); return; }
          if (selected.disabled) { reject(new Error(`Workspace is already active: ${selected.workspaceDir}`)); return; }
          if (!isAddWorkspaceSelection(selected)) { resolve(selected.workspaceDir); return; }
          root?.unmount();
          root = renderWithKeymap(renderer, createElement(FormDialog, {
            questions: [{
              label: t('New workspace path', '新的工作区路径'),
              fallback: currentWorkspaceDir,
              validate: (value: string) => isDirectory(value)
                ? undefined
                : t('Workspace must be an accessible directory.', '工作区必须是可访问的目录。'),
            }],
            preamble: [t('Enter the directory to add and open.', '输入要添加并打开的目录。')],
            theme: themeFor('dark'),
            width: renderer.width,
            height: renderer.height,
            mouseEnabled: renderer.useMouse,
            onComplete: (pathAnswers: string[]) => resolve(pathAnswers[0]),
            onCancel: () => resolve(undefined),
          }), i18n);
        },
        onCancel: () => resolve(undefined),
      }), i18n);
    });
  } finally {
    root?.unmount();
    renderer.destroy();
  }
}

export async function runChoiceTui(question: FormQuestion, preamble: string[], lang = 'zh-CN'): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Choice requires an interactive terminal.');
  const renderer = await createRenderer();
  let root: Root | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      root = renderWithKeymap(renderer, createElement(FormDialog, {
        questions: [question],
        preamble,
        theme: themeFor('dark'),
        width: renderer.width,
        height: renderer.height,
        mouseEnabled: renderer.useMouse,
        onComplete: (answers: string[]) => resolve(answers[0] || question.fallback || ''),
        onCancel: () => resolve('cancel'),
      }), i18nFor(lang));
    });
  } finally {
    root?.unmount();
    renderer.destroy();
  }
}

export class MyTerminalTui {
  constructor(private readonly runtime: MyTerminalRuntime, private readonly reconfigure: RuntimeReconfigure) {}

  async run(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive TUI requires a TTY. Use --headless for service mode.');
    const controller = new TuiController(this.runtime, this.reconfigure);
    controller.start();
    const renderer = await createRenderer();
    let root: Root | undefined;
    try {
      await new Promise<void>((resolve) => {
        root = renderWithKeymap(renderer, createElement(App, { controller, onExit: resolve }), i18nFor(this.runtime.config.uiLanguage));
      });
    } finally {
      root?.unmount();
      renderer.destroy();
      await controller.shutdown();
    }
  }
}
