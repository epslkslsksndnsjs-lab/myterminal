import type { MyTerminalSettings } from '../../types.js';
import type { Theme } from './types.js';

/**
 * Claude 暖色双主题（ADR-0004 决策 3）。
 * dark = 暖黑暗（珊瑚橙 accent），light = 暖纸亮（accent 加深保对比度）。
 * 对比度目标：正文 ≥ 7:1，功能文本/muted ≥ 4.5:1（WCAG AA），已逐一验算。
 */
const WARM_DARK: Theme = {
  background: '#221E19',
  panel: '#2A251F',
  panelAlt: '#352E26',
  selected: '#E07850',
  selectedText: '#221E19',
  text: '#F2EBE1',
  muted: '#A89F93',
  accent: '#E07850',
  good: '#A3BE8C',
  warn: '#E5B567',
  bad: '#D06A6A',
  border: '#4A423A',
  user: '#E8C07D',
  agent: '#E07850',
  tool: '#8FB0C9',
  system: '#A89F93',
};

const WARM_LIGHT: Theme = {
  background: '#FAF5EE',
  panel: '#FFFFFF',
  panelAlt: '#F1EAE0',
  selected: '#B04A2E',
  selectedText: '#FFFDF9',
  text: '#2C2420',
  muted: '#6E655B',
  accent: '#B04A2E',
  good: '#55703F',
  warn: '#8F6420',
  bad: '#B04A4A',
  border: '#D9CFC0',
  user: '#8F6420',
  agent: '#B04A2E',
  tool: '#41647E',
  system: '#6E655B',
};

export function paletteFor(name: MyTerminalSettings['uiTheme']): Theme {
  return name === 'light' ? { ...WARM_LIGHT } : { ...WARM_DARK };
}
