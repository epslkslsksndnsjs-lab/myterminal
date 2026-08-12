#!/usr/bin/env node
// CI 守卫：禁止把本机用户家目录绝对路径提交进仓库。
// 这类路径在其他机器 / CI 上会失效，并泄露提交者本机用户名。
// 失败示例：/Users/apple/...、C:\Users\apple\...
// 设计意图：跨平台项目里，任何写死进源码的本机家目录都是泄漏，必须改用
//   相对路径 / 裸模块说明符（由包管理器解析）/ 环境变量（如 MYTERMINAL_HOME）。
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// 允许的用户名：macOS 系统账户、CI 夹具用的假用户名。
// 真实本机用户名（如 apple、a）不在其中，会被拦截。
const ALLOWED = new Set([
  'Shared', 'Guest', 'tester', 'runner', 'example', 'admin', 'local', 'root',
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.zip', '.gz', '.tar', '.tgz',
  '.bz2', '.7z', '.xz', '.node', '.wasm', '.woff', '.woff2',
  '.ttf', '.otf', '.eot', '.mp4', '.webm', '.ico', '.pdf', '.bin',
]);

// 返回该行命中的本机家目录路径描述列表。
function checkLine(file, lineNo, line) {
  const hits = [];
  const reMac = /\/Users\/([^/\s'"]+)/g;
  let m;
  while ((m = reMac.exec(line))) {
    const user = m[1];
    if (!ALLOWED.has(user) && !user.startsWith('_')) {
      hits.push(`/Users/${user}`);
    }
  }
  const reWin = /[A-Za-z]:\\Users\\([^\\/\s'"]+)/g;
  while ((m = reWin.exec(line))) {
    const user = m[1];
    if (!ALLOWED.has(user) && !user.startsWith('_')) {
      hits.push(`...\\Users\\${user}`);
    }
  }
  for (const h of hits) {
    console.log(`[FAIL] ${file}:${lineNo} 本机家目录绝对路径: ${h}`);
  }
  return hits.length;
}

let violations = 0;
const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n').filter(Boolean);

for (const f of files) {
  if (f.endsWith('check-no-absolute-paths.mjs')) continue; // 跳过守卫自身（源码含 /Users/ 正则字面量）
  const ext = f.slice(f.lastIndexOf('.'));
  if (BINARY_EXT.has(ext)) continue;
  let content;
  try {
    content = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    violations += checkLine(f, i + 1, line);
  });
}

if (violations > 0) {
  console.error(
    `\n发现 ${violations} 处本机绝对路径泄漏。请改为相对路径 / 裸模块说明符，` +
    `由包管理器或环境变量解析，不要硬编码本机家目录。`
  );
  process.exit(1);
}
console.log('[OK] 未发现本机绝对路径泄漏');
