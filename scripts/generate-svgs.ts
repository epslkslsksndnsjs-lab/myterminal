/**
 * M6 SVG Generator — regenerates docs/assets/tui/*.svg for the new Claude warm-theme TUI redesign.
 * Run: bun run scripts/generate-svgs.ts
 *
 * Text-grid rendering: each contiguous same-color text segment = <rect> background + <text> foreground.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Warm Dark Theme Colors (from src/tui/theme/palette.ts) ───
const C = {
  bg:        '#221E19',
  panel:     '#2A251F',
  panelAlt:  '#352E26',
  selected:  '#E07850',
  selText:   '#221E19',
  text:      '#F2EBE1',
  muted:     '#A89F93',
  accent:    '#E07850',
  good:      '#A3BE8C',
  warn:      '#E5B567',
  bad:       '#D06A6A',
  border:    '#4A423A',
  user:      '#E8C07D',
  tool:      '#8FB0C9',
} as const;

const FONT = 'SFMono-Regular,Menlo,Consolas,monospace';
const FS = 15, CW = 10, RH = 20, LM = 24, FW = 1228, FH = 748;

// ─── Types ───
interface Seg { t: string; f: string; b?: string; w?: boolean }
interface Row { segs: Seg[]; rowBg?: string }

// ─── Renderer ───
function renderRow(row: Row, y: number): string {
  let x = LM, h = '';
  for (const s of row.segs) {
    const bg = s.b ?? row.rowBg ?? C.bg;
    const bold = s.w ? ' font-weight="700"' : '';
    h += `<rect x="${x}" y="${y}" width="${s.t.length * CW}" height="${RH}" fill="${bg}"/>`;
    h += `<text x="${x}" y="${y + 15}" fill="${s.f}"${bold}>${s.t}</text>`;
    x += s.t.length * CW;
  }
  const rem = FW - x;
  if (rem > 0) {
    const bg = row.rowBg ?? C.bg;
    h += `<rect x="${x}" y="${y}" width="${rem}" height="${RH}" fill="${bg}"/>`;
    h += `<text x="${x}" y="${y + 15}" fill="${bg}">${' '.repeat(Math.floor(rem / CW))}</text>`;
  }
  return h;
}

function renderPage(rows: Row[]): string {
  const body = rows.map((r, i) => renderRow(r, 24 + i * RH)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FW}" height="${FH}" viewBox="0 0 ${FW} ${FH}">
<rect width="100%" height="100%" rx="16" fill="${C.bg}"/>
<g font-family="${FONT}" font-size="${FS}" xml:space="preserve">${body}</g>
</svg>`;
}

// ─── Shared builders ───
function topBar(): Row {
  return { rowBg: C.panel, segs: [
    { t: ' ', f: C.text }, { t: 'MyTerminal', f: C.accent, w: true },
    { t: '  ', f: C.text }, { t: '\u25CF running', f: C.good },
    { t: '  ', f: C.text }, { t: 'v0.1.0', f: C.muted },
  ]};
}
function tabBar(active: number, labels: string[]): Row {
  const s: Seg[] = [{ t: ' ', f: C.text }];
  for (let i = 0; i < labels.length; i++) {
    const L = `${i + 1} ${labels[i]}`;
    s.push(i === active ? { t: L, f: C.selText, b: C.selected, w: true } : { t: L, f: C.muted });
    s.push({ t: ' ', f: C.text });
  }
  return { rowBg: C.panel, segs: s };
}
function separator(): Row {
  return { segs: [{ t: '\u2500'.repeat(118), f: C.border }] };
}
function bottomNav(active: number, labels: string[]): Row {
  const s: Seg[] = [{ t: ' ', f: C.text }];
  for (let i = 0; i < labels.length; i++) {
    s.push(i === active ? { t: labels[i], f: C.selText, b: C.selected, w: true } : { t: labels[i], f: C.muted });
    s.push({ t: ' ', f: C.text });
  }
  return { rowBg: C.panel, segs: s };
}
function inputBar(en: boolean): Row {
  const hint = en ? 'Type a command or message...' : '\u8F93\u5165\u547D\u4EE4\u6216\u6D88\u606F...';
  const help = en ? 'i or click to type \u00B7 / commands \u00B7 Tab pages \u00B7 q quit'
                  : 'i \u6216\u70B9\u51FB\u8F93\u5165 \u00B7 / \u547D\u4EE4 \u00B7 Tab \u5207\u6362\u9875\u9762 \u00B7 q \u9000\u51FA';
  return { segs: [
    { t: ' ', f: C.text },
    { t: '\u276F ' + hint, f: C.muted },
    { t: '  ' + help, f: C.muted },
  ]};
}
function statusLine(k: string): Row {
  return { rowBg: C.panelAlt, segs: [{ t: ' ' + k, f: C.text, w: true }] };
}
function blank(): Row { return { segs: [{ t: ' ', f: C.text }] }; }
function t(txt: string, fg = C.text, bld = false, ind = 1): Row {
  return { segs: [{ t: ' '.repeat(ind) + txt, f: fg, w: bld }] };
}
function kv(k: string, v: string, kc = C.accent, vc = C.text, ind = 1): Row {
  return { segs: [{ t: ' '.repeat(ind) + k, f: kc, w: true }, { t: ' ' + v, f: vc }] };
}

// ─── Tab labels ───
const EN = ['Overview','Sessions','Messages','Timeline','Diff','Extensions','Settings','Logs'];
const ZH = ['\u6982\u89C8','\u4F1A\u8BDD','\u6D88\u606F','\u65F6\u95F4\u7EBF','Diff','\u6269\u5C55','\u8BBE\u7F6E','\u65E5\u5FD7'];

// ─── Overview page ───
function overview(en: boolean): Row[] {
  const T = en ? EN : ZH;
  const G = en ? 'Good morning.' : '\u65E9\u4E0A\u597D\u3002';
  const S = en ? '2 session(s) on the job. All good.' : '2 \u4E2A session \u5DE5\u4F5C\u4E2D\u3002\u4E00\u5207\u6B63\u5E38\u3002';
  const SH = en ? 'Sessions' : '\u4F1A\u8BDD';
  const SIN = en ? '2 active \u00B7 press 2 for all' : '2 \u6D3B\u8DC3 \u00B7 \u6309 2 \u770B\u5168\u90E8';
  const AH = en ? 'Activity' : '\u52A8\u6001';
  const AIN = en ? 'press 4 for timeline \u00B7 press 8 for logs' : '\u6309 4 \u770B\u65F6\u95F4\u7EBF \u00B7 \u6309 8 \u770B\u65E5\u5FD7';
  const BT = en ? 'i to type a message or / command' : 'i \u8F93\u5165\u6D88\u606F\u6216 / \u547D\u4EE4';
  const SK = en
    ? 'Tab page  \u2191\u2193 scroll  c configure  hold v for credentials  q quit  i input'
    : 'Tab \u5207\u6362  \u2191\u2193 \u6EDA\u52A8  c \u914D\u7F6E  \u6309\u4F4F v \u663E\u793A\u51ED\u636E  q \u9000\u51FA  i \u8F93\u5165';

  return [
    topBar(),
    tabBar(0, T),
    separator(),
    // mascot
    t('\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E', C.accent, false, 2),
    t('\u256D\u256F \u25D4 \u25D4 \u2570\u256E', C.accent, false, 2),
    t('\u2570\u256E  \u25E1  \u256D\u256F', C.accent, false, 2),
    t('\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F', C.accent, false, 2),
    blank(),
    t(G, C.text, true, 2),
    t(S, C.muted, false, 2),
    blank(),
    // sessions
    kv(SH, SIN, C.accent, C.muted),
    // group 1
    { segs: [{ t: '  \u25CF ', f: C.accent }, { t: 'agent-group', f: C.text, w: true }, { t: '           \u25CF completed', f: C.good }] },
    { segs: [{ t: '    \u23FF final checkpoint reached — all 3 work records closed', f: C.muted }, { t: '  3m ago', f: C.muted }] },
    { segs: [{ t: '    \u251C\u2500 \uD83D\uDCC1 link2', f: C.text }, { t: '             \u25CF completed', f: C.good }, { t: '  \u25CB claimed', f: C.good }] },
    { segs: [{ t: '    \u2502   \u2514\u2500 write_file + read_file \u00B7 3 audit entries', f: C.muted }] },
    { segs: [{ t: '    \u2514\u2500 \uD83D\uDCC1 child-session', f: C.text }, { t: '          \u25CF working', f: C.accent }, { t: '  \u25CB claimed', f: C.good }] },
    { segs: [{ t: '        \u2514\u2500 analyzing codebase...  \u25CF running', f: C.accent }] },
    blank(),
    // group 2
    { segs: [{ t: '  \u25CF ', f: C.accent }, { t: 'review-task', f: C.text, w: true }, { t: '             \u25CF working', f: C.accent }] },
    { segs: [{ t: '    \u2514\u2500 \uD83D\uDCC1 diff-check', f: C.text }, { t: '            \u25CF blocked', f: C.bad }, { t: '  \u25CB stale', f: C.bad }] },
    blank(),
    // activity
    kv(AH, AIN, C.accent, C.muted),
    { segs: [{ t: '  \u23FA ', f: C.tool }, { t: '01:23:45 ', f: C.muted }, { t: 'user \u2192 agent_group: analyzing the codebase structure...', f: C.text }, { t: '  \u25CF running', f: C.accent }] },
    { segs: [{ t: '  \u23FA ', f: C.tool }, { t: '01:22:30 ', f: C.muted }, { t: 'agent_group \u00B7 write_file \u2192 src/index.ts', f: C.text }, { t: '      \u2713 45ms', f: C.good }] },
    { segs: [{ t: '  \u23FA ', f: C.user }, { t: '01:20:15 ', f: C.muted }, { t: 'user \u2192 link2: ' + (en ? 'confirmed the results' : '\u786E\u8BA4\u7ED3\u679C'), f: C.text }, { t: '        ' + (en ? 'message' : '\u6D88\u606F'), f: C.muted }] },
    { segs: [{ t: '  \u23FA ', f: C.tool }, { t: '01:18:02 ', f: C.muted }, { t: 'link2 \u00B7 read_file \u2192 package.json', f: C.text }, { t: '             \u2713 12ms', f: C.good }] },
    { segs: [{ t: '  \u23FA ', f: C.tool }, { t: '01:15:30 ', f: C.muted }, { t: 'diff-check \u00B7 session_register \u2192 mode=child', f: C.text }, { t: '    \u2299 policy', f: C.warn }] },
    { segs: [{ t: '  \u23FA ', f: C.tool }, { t: '01:10:00 ', f: C.muted }, { t: 'child-session \u00B7 git_diff \u2192 staged (3 files)', f: C.text }, { t: '   \u2713 89ms', f: C.good }] },
    { segs: [{ t: '  \u23FA ', f: C.user }, { t: '00:55:20 ', f: C.muted }, { t: 'user \u2192 agent_group: ' + (en ? 'please review the diff before committing' : '\u63D0\u4EA4\u524D\u8BF7\u5BA1\u67E5 diff'), f: C.text }, { t: '  ' + (en ? 'message' : '\u6D88\u606F'), f: C.muted }] },
    blank(),
    t(BT, C.muted, false, 2),
    bottomNav(0, T),
    inputBar(en),
    statusLine(SK),
  ];
}

// ─── Sessions page ───
function sessions(en: boolean): Row[] {
  const T = en ? EN : ZH;
  const SK = en
    ? '\u2191\u2193/j k select  PgUp/PgDn jump  Enter open  n new/delegate  u actions  q quit  i input'
    : '\u2191\u2193/j k \u9009\u62E9  PgUp/PgDn \u8DF3\u8F6C  Enter \u6253\u5F00  n \u65B0\u5EFA/\u59D4\u6D3E  u \u64CD\u4F5C  q \u9000\u51FA  i \u8F93\u5165';

  const r: Row[] = [topBar(), tabBar(1, T), separator(), blank()];

  const NM = (e: string, z: string) => en ? e : z;
  const comp = NM('completed','\u5DF2\u5B8C\u6210');
  const work = NM('working','\u5DE5\u4F5C\u4E2D');
  const blk = NM('blocked','\u5DF2\u963B\u585E');
  const clm = NM('claimed','\u5DF2\u8BA4\u9886');
  const stl = NM('stale','\u5DF2\u8FC7\u671F');
  const rec = NM('records','\u5DE5\u4F5C\u8BB0\u5F55');
  const ch = NM('children','\u5B50\u4F1A\u8BDD');

  // group 1
  r.push(
    t('\u250C\u2500 agent-group', C.text, true),
    { segs: [{ t: '  \u2502 \u25CF active', f: C.good }, { t: '  \u2502 \u25CF ' + comp, f: C.good }] },
    { segs: [{ t: '  \u251C\u2500 ' + rec + ': 3', f: C.muted }, { t: '    parent', f: C.text, w: true }, { t: '  \u25CF ' + comp, f: C.good }, { t: '  \u25CB ' + clm, f: C.good }] },
    { segs: [{ t: '  \u2502   \u2514\u2500 created 2026-07-25 14:30 \u00B7 last active 15:45', f: C.muted }] },
    { segs: [{ t: '  \u251C\u2500 ' + ch + ': 2', f: C.muted }] },
    { segs: [{ t: '  \u2502   \u251C\u2500 \uD83D\uDCC1 link2', f: C.text }, { t: '        \u25CF ' + comp, f: C.good }, { t: '  \u25CB ' + clm, f: C.good }] },
    { segs: [{ t: '  \u2502   \u2502   \u2514\u2500 checkpoint: all files written', f: C.muted }] },
    { segs: [{ t: '  \u2502   \u2514\u2500 \uD83D\uDCC1 child-session', f: C.text }, { t: '   \u25CF ' + work, f: C.accent }, { t: '  \u25CB ' + clm, f: C.good }] },
    { segs: [{ t: '  \u2502       \u2514\u2500 goal: implement user auth module', f: C.muted }] },
    { segs: [{ t: '  \u251C\u2500 action: press u, then choose...', f: C.muted }] },
    { segs: [{ t: '  \u2514\u2500 summary: final checkpoint reached \u00B7 3m ago', f: C.muted }] },
    blank(),
  );

  // group 2
  r.push(
    t('\u250C\u2500 review-task', C.text, true),
    { segs: [{ t: '  \u2502 \u25CF ' + work, f: C.accent }, { t: '  \u2502 \u25CB ' + clm, f: C.good }] },
    { segs: [{ t: '  \u251C\u2500 ' + rec + ': 1', f: C.muted }, { t: '    parent', f: C.text, w: true }, { t: '  \u25CF ' + work, f: C.accent }, { t: '  \u25CB ' + clm, f: C.good }] },
    { segs: [{ t: '  \u2502   \u2514\u2500 created 2026-07-26 01:30 \u00B7 running review pass #3', f: C.muted }] },
    { segs: [{ t: '  \u251C\u2500 ' + ch + ': 1', f: C.muted }] },
    { segs: [{ t: '  \u2502   \u2514\u2500 \uD83D\uDCC1 diff-check', f: C.text }, { t: '     \u25CF ' + blk, f: C.bad }, { t: '  \u25CB ' + stl, f: C.bad }] },
    { segs: [{ t: '  \u2502       \u2514\u2500 blocked on: awaiting parent approval', f: C.muted }] },
    blank(),
  );

  // group 3
  r.push(
    t('\u250C\u2500 deploy-pipeline', C.text, true),
    { segs: [{ t: '  \u2502 \u25CF ' + comp, f: C.good }, { t: '  \u2502 \u25CB ' + clm, f: C.good }] },
    { segs: [{ t: '  \u251C\u2500 ' + rec + ': 1', f: C.muted }, { t: '    parent', f: C.text, w: true }, { t: '  \u25CF ' + comp, f: C.good }, { t: '  \u25CB ' + clm, f: C.good }] },
    { segs: [{ t: '  \u2502   \u2514\u2500 created 2026-07-25 10:00 \u00B7 completed 12:30', f: C.muted }] },
    { segs: [{ t: '  \u2514\u2500 summary: deployment successful to staging', f: C.muted }] },
    blank(),
  );

  // padding rows to match ~35 total
  r.push(blank(), blank());
  r.push(bottomNav(1, T), inputBar(en), statusLine(SK));
  return r;
}

// ─── Settings page ───
function settings(en: boolean): Row[] {
  const T = en ? EN : ZH;
  const SK = en
    ? '\u2191\u2193 scroll  c configure  hold v to reveal  k rotate  u update  q quit  i input'
    : '\u2191\u2193 \u6EDA\u52A8  c \u4FEE\u6539\u914D\u7F6E  \u6309\u4F4F v \u663E\u793A\u51ED\u636E  k \u8F6E\u6362  u \u66F4\u65B0  q \u9000\u51FA  i \u8F93\u5165';

  const NM = (e: string, z: string) => en ? e : z;
  return [
    topBar(),
    tabBar(6, T),
    separator(),
    blank(),
    // Card 1: Runtime
    t('\u250C\u2500 ' + NM('Runtime settings','\u8FD0\u884C\u8BBE\u7F6E'), C.accent, true),
    kv(NM('Language','\u754C\u9762\u8BED\u8A00'), 'zh-CN', C.text, C.text, 2),
    kv(NM('Theme','\u754C\u9762\u4E3B\u9898'), 'dark', C.text, C.text, 2),
    kv(NM('Settings file','\u914D\u7F6E\u6587\u4EF6'), '~/.config/myterminal/settings.json', C.text, C.muted, 2),
    kv(NM('Workspace','\u5DE5\u4F5C\u533A'), '~/myproject', C.text, C.text, 2),
    kv(NM('Listen','\u76D1\u542C\u5730\u5740'), '127.0.0.1:3000', C.text, C.text, 2),
    kv(NM('Public URL','\u516C\u7F51 URL'), 'https://example.ngrok.io', C.text, C.text, 2),
    kv(NM('Max output','\u6700\u5927\u8F93\u51FA'), '1048576 chars', C.text, C.text, 2),
    kv(NM('Timeout','\u547D\u4EE4\u8D85\u65F6'), '60s', C.text, C.text, 2),
    kv(NM('Long-task harness','\u957F\u4EFB\u52A1 Harness'), 'off', C.text, C.muted, 2),
    kv(NM('Non-blocking tasks','\u975E\u963B\u585E\u4EFB\u52A1'), 'off', C.text, C.muted, 2),
    blank(),
    // Card 2: macOS lock
    t('\u250C\u2500 ' + NM('macOS Passive Lock','macOS \u88AB\u52A8\u9501\u5C4F'), C.accent, true),
    t('\u2502 ' + NM('armed','\u5DF2\u5E03\u9632'), C.good, false, 2),
    t('\u2502 ' + NM('Display: kept awake','\u5C4F\u5E55: \u4FDD\u6301\u9192\u7740'), C.text, false, 2),
    t('\u2514\u2500 ' + NM('Accessibility permission: granted','\u65E0\u969C\u7887\u6743\u9650: \u5DF2\u6388\u6743'), C.muted, false, 2),
    blank(),
    // Card 3: Credentials
    t('\u250C\u2500 ' + NM('Credentials & update','\u51ED\u636E\u4E0E\u66F4\u65B0'), C.accent, true),
    { segs: [{ t: '  \u2502 ' + NM('Apps connector','Apps \u8FDE\u63A5\u5668') + ': myt-****-****-****-****', f: C.text }] },
    { segs: [{ t: '  \u2502 ' + NM('Actions token','Actions \u4EE4\u724C') + ': sk-****-****-****-****', f: C.text }] },
    { segs: [{ t: '  \u2502 \u26A0 ' + NM('Rotating credentials disconnects existing clients.','\u8F6E\u6362\u51ED\u636E\u4F1A\u4F7F\u73B0\u6709\u8FDE\u63A5\u5931\u6548\u3002'), f: C.warn }] },
    { segs: [{ t: '  \u251C\u2500 ' + NM('Update','\u66F4\u65B0') + ': checking...', f: C.muted }] },
    { segs: [{ t: '  \u2514\u2500 ' + NM('Version','\u7248\u672C') + ': v0.1.1 \u00B7 ' + NM('up to date','\u5DF2\u662F\u6700\u65B0'), f: C.good }] },
    blank(),
    blank(),
    blank(),
    blank(),
    bottomNav(6, T),
    inputBar(en),
    statusLine(SK),
  ];
}

// ─── Main ───
const OUT = join(import.meta.dir, '..', 'docs', 'assets', 'tui');
const pages: { file: string; fn: (en: boolean) => Row[] }[] = [
  { file: 'overview-en.svg',     fn: overview },
  { file: 'overview-zh-CN.svg',  fn: overview },
  { file: 'sessions-en.svg',     fn: sessions },
  { file: 'sessions-zh-CN.svg',  fn: sessions },
  { file: 'settings-en.svg',     fn: settings },
  { file: 'settings-zh-CN.svg',  fn: settings },
];

for (const { file, fn } of pages) {
  const isEn = file.includes('-en.');
  const rows = fn(isEn);
  const svg = renderPage(rows);
  writeFileSync(join(OUT, file), svg, 'utf-8');
  console.log(`${file}: ${rows.length} rows, ${svg.length}B`);
}
console.log('\nDone.');
