/**
 * SGR parser for the ported min-agent transcript output.
 *
 * Kept free of @opentui imports so the exact styled output can be asserted in
 * plain unit tests. Attribute bits mirror OpenTUI's TextAttributes.
 */
export const ANSI_ATTRIBUTES = {
  BOLD: 1 << 0,
  DIM: 1 << 1,
  ITALIC: 1 << 2,
  UNDERLINE: 1 << 3,
  BLINK: 1 << 4,
  INVERSE: 1 << 5,
  HIDDEN: 1 << 6,
  STRIKETHROUGH: 1 << 7,
} as const;

export type AnsiSegment = {
  text: string;
  fg?: string;
  bg?: string;
  attributes: number;
};

type AnsiState = {
  fg?: string;
  bg?: string;
  attributes: number;
};

const BASE_COLORS = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#767676', '#f14c4c', '#23d18b', '#f5f543',
  '#3b8eea', '#d670d6', '#29b8db', '#f2f2f2',
] as const;

function colorFrom256(index: number): string {
  if (index < 16) return BASE_COLORS[index] ?? BASE_COLORS[7];
  if (index < 232) {
    const value = index - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(value / 36)] ?? 0;
    const g = steps[Math.floor((value % 36) / 6)] ?? 0;
    const b = steps[value % 6] ?? 0;
    return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  }
  const level = 8 + (index - 232) * 10;
  const hex = level.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

function colorFromAnsiCode(code: number, bright: boolean): string | undefined {
  if (code >= 30 && code <= 37) return BASE_COLORS[(code - 30) + (bright ? 8 : 0)];
  if (code >= 90 && code <= 97) return BASE_COLORS[(code - 90) + 8];
  return undefined;
}

function applySgr(state: AnsiState, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const code = params[i];
    switch (code) {
      case 0:
        state.fg = undefined;
        state.bg = undefined;
        state.attributes = 0;
        break;
      case 1:
        state.attributes |= ANSI_ATTRIBUTES.BOLD;
        break;
      case 2:
        state.attributes |= ANSI_ATTRIBUTES.DIM;
        break;
      case 3:
        state.attributes |= ANSI_ATTRIBUTES.ITALIC;
        break;
      case 4:
        state.attributes |= ANSI_ATTRIBUTES.UNDERLINE;
        break;
      case 5:
        state.attributes |= ANSI_ATTRIBUTES.BLINK;
        break;
      case 7:
        state.attributes |= ANSI_ATTRIBUTES.INVERSE;
        break;
      case 8:
        state.attributes |= ANSI_ATTRIBUTES.HIDDEN;
        break;
      case 9:
        state.attributes |= ANSI_ATTRIBUTES.STRIKETHROUGH;
        break;
      case 21:
      case 22:
        state.attributes &= ~(ANSI_ATTRIBUTES.BOLD | ANSI_ATTRIBUTES.DIM);
        break;
      case 23:
        state.attributes &= ~ANSI_ATTRIBUTES.ITALIC;
        break;
      case 24:
        state.attributes &= ~ANSI_ATTRIBUTES.UNDERLINE;
        break;
      case 25:
        state.attributes &= ~ANSI_ATTRIBUTES.BLINK;
        break;
      case 27:
        state.attributes &= ~ANSI_ATTRIBUTES.INVERSE;
        break;
      case 28:
        state.attributes &= ~ANSI_ATTRIBUTES.HIDDEN;
        break;
      case 29:
        state.attributes &= ~ANSI_ATTRIBUTES.STRIKETHROUGH;
        break;
      case 39:
        state.fg = undefined;
        break;
      case 49:
        state.bg = undefined;
        break;
      case 38:
      case 48: {
        const target = code === 38 ? 'fg' : 'bg';
        const mode = params[i + 1];
        if (mode === 5 && params[i + 2] !== undefined) {
          state[target] = colorFrom256(params[i + 2]);
          i += 2;
        } else if (mode === 2 && params[i + 4] !== undefined) {
          const r = params[i + 2].toString(16).padStart(2, '0');
          const g = params[i + 3].toString(16).padStart(2, '0');
          const b = params[i + 4].toString(16).padStart(2, '0');
          state[target] = `#${r}${g}${b}`;
          i += 4;
        }
        break;
      }
      default:
        if (code >= 30 && code <= 37) state.fg = colorFromAnsiCode(code, false);
        else if (code >= 90 && code <= 97) state.fg = colorFromAnsiCode(code, true);
        else if (code >= 40 && code <= 47) state.bg = colorFromAnsiCode(code - 10, false);
        else if (code >= 100 && code <= 107) state.bg = colorFromAnsiCode(code - 10, true);
        break;
    }
  }
}

/** Parse one ANSI row into styled spans; non-SGR escapes are dropped. */
export function parseAnsiLine(line: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const state: AnsiState = { attributes: 0 };
  let plain = '';

  const flush = (): void => {
    if (!plain) return;
    segments.push({
      text: plain,
      fg: state.fg,
      bg: state.bg,
      attributes: state.attributes,
    });
    plain = '';
  };

  let i = 0;
  while (i < line.length) {
    if (line[i] !== '\x1b') {
      plain += line[i];
      i++;
      continue;
    }
    const csi = /^\x1b\[([0-9;:]*)m/.exec(line.slice(i));
    if (csi) {
      flush();
      const raw = csi[1];
      const params = raw === '' ? [0] : raw.split(';').map((part) => Number.parseInt(part, 10) || 0);
      applySgr(state, params);
      i += csi[0].length;
      continue;
    }
    // Drop OSC/DCS-style control strings (hyperlink sequences included) whole.
    if (line[i + 1] === ']' || line[i + 1] === 'P' || line[i + 1] === '_' || line[i + 1] === '^' || line[i + 1] === 'X') {
      let end = i + 2;
      while (end < line.length && line[end] !== '\x07' && !(line[end] === '\x1b' && line[end + 1] === '\\')) end++;
      i = line[end] === '\x1b' ? end + 2 : Math.min(line.length, end + 1);
      continue;
    }
    // Drop any other escape sequence rather than shipping terminal controls.
    const other = /^\x1b\[[0-9;:?<=>]*[\x40-\x7e]/.exec(line.slice(i));
    i += other ? other[0].length : Math.min(2, line.length - i);
  }
  flush();
  return segments;
}
