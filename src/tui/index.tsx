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

function renderWithKeymap(renderer: CliRenderer, node: ReturnType<typeof createElement>): Root {
  const keymap = createDefaultOpenTuiKeymap(renderer);
  const root = createRoot(renderer);
  root.render(createElement(KeymapProvider, { keymap }, node));
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
      }));
    });
  } finally {
    root?.unmount();
    renderer.destroy();
  }
}

export async function runWorkspaceChooserTui(records: WorkspaceRecord[], currentWorkspaceDir: string, zh = true): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Workspace selection requires an interactive terminal.');
  const renderer = await createRenderer();
  let root: Root | undefined;
  const { items, question } = buildWorkspaceSelectorModel({
    label: zh ? '选择工作区' : 'Select workspace',
    records,
    currentWorkspaceDir,
    zh,
  });
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      root = renderWithKeymap(renderer, createElement(FormDialog, {
        questions: [question],
        preamble: [renderer.useMouse
          ? (zh ? '使用方向键或鼠标选择工作区。' : 'Choose a workspace with arrow keys or the mouse.')
          : (zh ? '使用方向键选择工作区，按 Enter 确认。' : 'Choose a workspace with arrow keys and press Enter.')],
        theme: themeFor('dark'),
        width: renderer.width,
        height: renderer.height,
        zh,
        mouseEnabled: renderer.useMouse,
        onComplete: (answers: string[]) => {
          const selected = selectedWorkspace(items, answers[0]);
          if (!selected) { reject(new Error('Invalid workspace selection.')); return; }
          if (selected.disabled) { reject(new Error(`Workspace is already active: ${selected.workspaceDir}`)); return; }
          if (!isAddWorkspaceSelection(selected)) { resolve(selected.workspaceDir); return; }
          root?.unmount();
          root = renderWithKeymap(renderer, createElement(FormDialog, {
            questions: [{
              label: zh ? '新的工作区路径' : 'New workspace path',
              fallback: currentWorkspaceDir,
              validate: (value: string) => isDirectory(value)
                ? undefined
                : (zh ? '工作区必须是可访问的目录。' : 'Workspace must be an accessible directory.'),
            }],
            preamble: [zh ? '输入要添加并打开的目录。' : 'Enter the directory to add and open.'],
            theme: themeFor('dark'),
            width: renderer.width,
            height: renderer.height,
            zh,
            mouseEnabled: renderer.useMouse,
            onComplete: (pathAnswers: string[]) => resolve(pathAnswers[0]),
            onCancel: () => resolve(undefined),
          }));
        },
        onCancel: () => resolve(undefined),
      }));
    });
  } finally {
    root?.unmount();
    renderer.destroy();
  }
}

export async function runChoiceTui(question: FormQuestion, preamble: string[], zh = true): Promise<string> {
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
        zh,
        mouseEnabled: renderer.useMouse,
        onComplete: (answers: string[]) => resolve(answers[0] || question.fallback || ''),
        onCancel: () => resolve('cancel'),
      }));
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
        root = renderWithKeymap(renderer, createElement(App, { controller, onExit: resolve }));
      });
    } finally {
      root?.unmount();
      renderer.destroy();
      await controller.shutdown();
    }
  }
}
