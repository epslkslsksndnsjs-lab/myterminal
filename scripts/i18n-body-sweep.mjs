// #31 主体机械变换（批5 第 10 刀 / ADR-0032 / G4）。
//
// 只做「参数顺序安全」的纯机械变换，不碰 import / prop 签名 / useI18n 接入
// （那些由人工逐文件精修，见主理人 review）。
//
// 变换：
//   T1  `zh ? 'Z' : 'E'` / `zh ? \`Z\` : \`E\``  →  `t('E', 'Z')`   （en 在前、zh 在后）
//   T2  函数实参 `, zh)` → `, t)`（relativeTime / viewForHistoryEntry / statusLabel）
//       `, zh,` → `, t,`（hints）
//   T3  删 JSX 上的 `zh={...}` / `copy={...}` prop（去 prop-drilling 的机械一半）
//
// 护栏：变换后由 test/i18n-coverage-issue31.test.mjs 的
//   - behaviour lock（字面量多重集不变）
//   - coverage: no zh ? / no zh prop
//   - t(en, zh) 参数顺序（CJK 必须在第二参）
// 兜底。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '';
const TARGETS = [
  'src/tui/FatalErrorBoundary.tsx',
  'src/tui/screens/Extensions.tsx',
  'src/tui/screens/Sessions.tsx',
  'src/tui/screens/Settings.tsx',
  'src/tui/screens/Diff.tsx',
  'src/tui/screens/Messages.tsx',
  'src/tui/screens/Subagents.tsx',
  'src/tui/screens/Subagent.tsx',
  'src/tui/screens/Timeline.tsx',
  'src/tui/screens/Home.tsx',
  'src/tui/components/ToolCallRow.tsx',
  'src/tui/components/FormDialog.tsx',
  'src/tui/screens/Logs.tsx',
  'src/tui/components/HelpOverlay.tsx',
  'src/tui/components/MessageBubble.tsx',
  'src/tui/components/chrome/StatusLine.tsx',
  'src/tui/components/chrome/TopBar.tsx',
  'src/tui/components/chrome/BottomNav.tsx',
  'src/tui/App.tsx',
  'src/tui/Setup.tsx',
];

const LIT = `(?:'(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*"|\`(?:[^\`\\\\]|\\\\.)*\`)`;

// T1: zh ? LIT : LIT  →  t(LIT2, LIT1)
const T1 = new RegExp(`zh\\s*\\?\\s*(${LIT})\\s*:\\s*(${LIT})`, 'g');

// T2: function-arg , zh) → , t)  （hints 用 `, zh,` 单独处理）
const T2_CALLS = [
  /(relativeTime\(\s*[^()]*?)\s*,\s*zh\s*\)/g,
  /(viewForHistoryEntry\(\s*[^()]*?)\s*,\s*zh\s*\)/g,
  /(statusLabel\(\s*[^()]*?)\s*,\s*zh\s*\)/g,
];

// T3: strip ` zh={...}` / ` copy={...}` JSX props (keep one leading space if present)
const T3 = /\s+(?:zh|copy)=\{[^}]*\}/g;

let totalT1 = 0;
let totalT2 = 0;
let totalT3 = 0;

for (const rel of TARGETS) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) { console.log(`SKIP (missing) ${rel}`); continue; }
  let src = fs.readFileSync(full, 'utf8');
  const before = src;

  const t1Count = (src.match(T1) || []).length;
  src = src.replace(T1, (_m, a, b) => `t(${b}, ${a})`);

  let t2Count = 0;
  for (const re of T2_CALLS) {
    const n = (src.match(re) || []).length;
    t2Count += n;
    src = src.replace(re, (_m, pre) => `${pre}, t)`);
  }
  // hints 用 `, zh,` 尾逗号形式单独处理，避免丢掉后续参数
  src = src.replace(/(hints\(\s*[^()]*?)\s*,\s*zh\s*,/g, (_m, pre) => `${pre}, t,`);

  const t3Count = (src.match(T3) || []).length;
  src = src.replace(T3, '');

  if (src !== before) {
    fs.writeFileSync(full, src, 'utf8');
    console.log(`${rel}: T1=${t1Count} T2=${t2Count} T3=${t3Count}`);
    totalT1 += t1Count; totalT2 += t2Count; totalT3 += t3Count;
  } else {
    console.log(`${rel}: no change`);
  }
}

console.log(`\nTOTAL: T1=${totalT1} T2=${totalT2} T3=${totalT3}`);
