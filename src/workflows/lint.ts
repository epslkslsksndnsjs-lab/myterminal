/**
 * 启动前的确定性扫描——在烧任何一个 token 之前拒掉不可重放的脚本。
 *
 * 续跑靠"同一段脚本重放出同一串调用"，所以非确定性调用是硬伤：
 * Math.random() 与全部 Date 取值都是违例。扫描是掩蔽后的文本扫描
 * （字符串与注释置空格、保留换行），不是语法解析——永不抛、永不返回 null。
 */

export type DeterminismViolation = { literal: string; line: number };

const VIOLATIONS: Array<{ literal: string; pattern: RegExp }> = [
  { literal: 'Math.random()', pattern: /Math\s*\.\s*random\s*\(\s*\)/ },
  { literal: 'Date()', pattern: /(?<![.\w$])Date\s*\(\s*\)/ },
  { literal: 'Date.now()', pattern: /(?<![.\w$])Date\s*\.\s*now\s*\(\s*\)/ },
  { literal: 'Date.parse()', pattern: /(?<![.\w$])Date\s*\.\s*parse\s*\(/ },
  { literal: 'Date.UTC()', pattern: /(?<![.\w$])Date\s*\.\s*UTC\s*\(/ },
  { literal: 'new Date()', pattern: /\bnew\s+Date\s*\(/ },
];

/** 把字符串字面量与注释整段抹成空格（保留换行），正则才不会撞进字符串内部。 */
function maskNonCode(source: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' = 'code';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (ch === "'") { mode = 'single'; out += ' '; i += 1; continue; }
      if (ch === '"') { mode = 'double'; out += ' '; i += 1; continue; }
      if (ch === '`') { mode = 'template'; out += ' '; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += ch; i += 1; continue; }
      out += ch === '\n' ? ch : ' '; i += 1; continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += ch === '\n' ? ch : ' '; i += 1; continue;
    }
    // 字符串内部：转义符跳过两个字符，换行保留（模板内换行是真换行）
    if (ch === '\\') { out += '  '; i += 2; continue; }
    if (
      (mode === 'single' && ch === "'") ||
      (mode === 'double' && ch === '"') ||
      (mode === 'template' && ch === '`')
    ) { mode = 'code'; out += ' '; i += 1; continue; }
    out += ch === '\n' ? ch : ' ';
    i += 1;
  }
  return out;
}

export function scanDeterminism(source: string): DeterminismViolation[] {
  if (typeof source !== 'string' || source.length === 0) return [];
  const masked = maskNonCode(source);
  // `new Date()` 先整段抹掉再扫其余模式——否则它会被 `Date()` 那条重复报一次，
  // 同一处违例列两条会让人以为有两处问题。
  const withoutNewDate = masked.replace(/\bnew\s+Date\s*\(/g, (m) => ' '.repeat(m.length));
  const found: DeterminismViolation[] = [];
  for (const { literal, pattern } of VIOLATIONS) {
    const regex = new RegExp(pattern.source, 'g');
    const haystack = literal === 'new Date()' ? masked : withoutNewDate;
    for (const match of haystack.matchAll(regex)) {
      const before = masked.slice(0, match.index ?? 0);
      const line = before.split('\n').length;
      found.push({ literal, line });
    }
  }
  return found.sort((a, b) => a.line - b.line || a.literal.localeCompare(b.literal));
}

/** 违例的人读描述（供拒因回显，最多列 5 条）。 */
export function describeViolations(violations: DeterminismViolation[], maxListed = 5): string {
  if (violations.length === 0) return '';
  const listed = violations.slice(0, maxListed).map((v) => `${v.literal} (line ${v.line})`);
  const rest = violations.length - listed.length;
  const tail = rest > 0 ? ` and ${rest} more` : '';
  return `${listed.join(', ')}${tail}; resume replay depends on deterministic scripts.`;
}
