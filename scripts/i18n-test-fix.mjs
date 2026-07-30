// #31 测试调用点同步（G4）：把旧签名 `zh: boolean` 调用改为新的 `t: Translate` 调用。
// 仅改测试文件，不动 src。行为语义保持不变（true→取中文，false→取英文）。
import fs from 'node:fs';

const edits = {
  'test/tui-redesign-m3.test.mjs': (s) => s
    .replace(/relativeTime\(([^,]+),\s*([^,]+),\s*true\s*\)/g, 'relativeTime($1, $2, (en, zh) => zh)')
    .replace(/relativeTime\(([^,]+),\s*([^,]+),\s*false\s*\)/g, 'relativeTime($1, $2, (en, zh) => en)'),
  'test/tui-redesign-m4a.test.mjs': (s) => s
    .replace(/viewForHistoryEntry\(([^,]+),\s*true\s*\)/g, 'viewForHistoryEntry($1, (en, zh) => zh)')
    .replace(/viewForHistoryEntry\(([^,]+),\s*false\s*\)/g, 'viewForHistoryEntry($1, (en, zh) => en)'),
};

let total = 0;
for (const [file, fn] of Object.entries(edits)) {
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  const n = (before.match(/,\s*(true|false)\s*\)/g) || []).length;
  fs.writeFileSync(file, after);
  total += n;
  console.log(`${file}: ${n} 处调用点已同步`);
}
console.log(`done, total ${total}`);
