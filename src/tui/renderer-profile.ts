import type { CliRendererConfig } from '@opentui/core';

export type RendererProfile = Pick<CliRendererConfig,
  'targetFps' | 'maxFps' | 'debounceDelay' | 'useThread' | 'screenMode' |
  'useMouse' | 'enableMouseMovement' | 'consoleMode' | 'useKittyKeyboard'>;

export type WindowsTuiMode = 'compatible' | 'mouse';

export function windowsTuiMode(env: NodeJS.ProcessEnv = process.env): WindowsTuiMode {
  return env.MYTERMINAL_WINDOWS_TUI_MODE?.trim().toLowerCase() === 'mouse' ? 'mouse' : 'compatible';
}

export function rendererProfile(platform = process.platform, env: NodeJS.ProcessEnv = process.env): RendererProfile {
  if (platform !== 'win32') {
    return {
      targetFps: 60,
      maxFps: 60,
      debounceDelay: 100,
      screenMode: 'alternate-screen',
      useMouse: true,
      enableMouseMovement: true,
      consoleMode: 'console-overlay',
      useKittyKeyboard: { disambiguate: true, alternateKeys: true },
    };
  }

  const mouse = windowsTuiMode(env) === 'mouse';
  return {
    // OpenTUI 0.4.5 enables its native output thread by default outside Linux.
    // Keep Windows rendering on the Bun thread: ConPTY hosts vary and the
    // native writer can otherwise remain blocked while the UI appears frozen.
    useThread: false,
    targetFps: 20,
    maxFps: 20,
    debounceDelay: 150,
    screenMode: 'main-screen',
    useMouse: mouse,
    enableMouseMovement: false,
    consoleMode: 'disabled',
    useKittyKeyboard: null,
  };
}
