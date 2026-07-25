import type { MyTerminalSettings } from '../../types.js';
import type { Theme } from './types.js';
import { paletteFor } from './palette.js';

export type { Theme } from './types.js';

/** themeFor — 与旧 state.ts 签名兼容的主题入口（ADR-0004 决策 3）。 */
export function themeFor(name: MyTerminalSettings['uiTheme']): Theme {
  return paletteFor(name);
}
