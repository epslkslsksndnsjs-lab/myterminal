// #31 行为锁收割器（批5 第 10 刀 / ADR-0032 / G4）。
//
// 单源：锁定测试与基线生成器共用同一套收割逻辑，避免二者漂移后行为锁失效。
// 生成基线：bun test/fixtures/i18n-harvest.mjs --write

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const FIXTURE = path.join(here, 'i18n-literals-issue31.json');

/**
 * 作用域键的唯一归一化入口：一律 POSIX 分隔符。
 *
 * 基线 JSON 的键在 POSIX 平台生成（`src/tui/App.tsx`），而 path.relative/path.join 在
 * Windows 上产出 `src\tui\App.tsx`——不归一化会让 Windows CI 上全部基线键匹配失败
 * （症状：55 个文件齐报「文件消失」）。键只作为标识符使用，读文件时再交给 path.join
 * 还原成平台路径，故归一化不影响任何实际 I/O。
 */
export function toPosixKey(relativePath) {
  return relativePath.split(path.sep).join('/').split('\\').join('/');
}

/** seam 作用域：整个 TUI 层 + 被 TUI 穿透的 workspace-selection。键一律 POSIX。 */
export function scopeFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(toPosixKey(path.relative(ROOT, full)));
    }
  };
  walk(path.join(ROOT, 'src', 'tui'));
  files.push('src/workspace-selection.ts');
  return files.sort();
}

/** 去掉行注释与块注释，避免注释里的中文/引号污染字面量收割。 */
export function stripComments(source) {
  let out = '';
  let index = 0;
  let mode = 'code';
  let quote = '';
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; index += 2; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; index += 2; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { mode = 'string'; quote = ch; out += ch; index += 1; continue; }
      out += ch; index += 1; continue;
    }
    if (mode === 'line') { if (ch === '\n') { mode = 'code'; out += ch; } index += 1; continue; }
    if (mode === 'block') { if (ch === '*' && next === '/') { mode = 'code'; index += 2; continue; } index += 1; continue; }
    if (ch === '\\') { out += ch + (next ?? ''); index += 2; continue; }
    out += ch;
    if (ch === quote) { mode = 'code'; quote = ''; }
    index += 1;
  }
  return out;
}

/** 丢弃模块说明符（import/export … from '…'），它们会随文件新增而合法变动。 */
export function stripModuleSpecifiers(source) {
  return source
    .replace(/^\s*(?:import|export)[\s\S]*?from\s*(['"])[^'"]*\1\s*;?\s*$/gm, '')
    .replace(/^\s*import\s*(['"])[^'"]*\1\s*;?\s*$/gm, '');
}

/**
 * 收割一个文件里全部字符串/模板字面量（原样，含 ${} 片段），排序后返回。
 *
 * 先把 CRLF 折成 LF：无 .gitattributes 时 Windows checkout 会落 CRLF，跨行模板字面量
 * 会把 \r 一并收进多重集，使行为锁在 Windows 上假红。当前基线 0 条跨行字面量，故此归一化
 * 对既有基线是逐字节 no-op（已用重新生成基线 + git diff 为空验证）。
 */
export function harvestLiterals(source) {
  const text = stripModuleSpecifiers(stripComments(source.replace(/\r\n/g, '\n')));
  const literals = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch !== '"' && ch !== "'" && ch !== '`') { index += 1; continue; }
    const quote = ch;
    let cursor = index + 1;
    let body = '';
    while (cursor < text.length) {
      const cur = text[cursor];
      if (cur === '\\') { body += cur + (text[cursor + 1] ?? ''); cursor += 2; continue; }
      if (cur === quote) break;
      body += cur;
      cursor += 1;
    }
    literals.push(body);
    index = cursor + 1;
  }
  return literals.sort();
}

export function snapshotScope() {
  const snapshot = {};
  for (const file of scopeFiles()) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    snapshot[file] = harvestLiterals(fs.readFileSync(full, 'utf8'));
  }
  return snapshot;
}

if (process.argv.includes('--write')) {
  const snapshot = snapshotScope();
  fs.writeFileSync(FIXTURE, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const count = Object.values(snapshot).reduce((sum, list) => sum + list.length, 0);
  console.log(`wrote ${FIXTURE}: ${Object.keys(snapshot).length} files / ${count} literals`);
}
