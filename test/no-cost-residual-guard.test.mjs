// ADR-0046 D1 — no-cost-residual 守卫测试 (final gate, ticket #21)
//
// 目的：锁死 ADR-0046 D1 的成果——成本/美元/定价概念已从 src/ 彻底移除。
// 任何在 src/ 重新出现的裸词 totalUSD / settledUSD / resolvePricing / pricing / cost
// （排除下方刻意保留的 CostTracker 纯 token 累加器子系统与注释）都会让本测试失败。
//
// 设计要点（对照 ticket #21 规范）：
//   - 排除 CostTracker 标识符（类名 CostTracker、变量 costTracker）
//   - 排除 cost-tracker 文件名（出现在 import 路径 './cost-tracker.js' 中）
//   - 排除注释
//   - updateSubagentCost 属同一刻意保留子系统（usage 更新器），且被 \b 词边界自然排除
//
// 当前 src/ 已满足：grep 与 codebase-memory 实时检索均确认零概念残留，
// 故本测试在现状下应通过，并把"零残留"作为回归红线固定下来。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..', 'src');

// 刻意保留的 token（ADR-0046 D1 降级为纯 token 累加器的子系统），守卫不得误报。
const ALLOWED_TOKENS = [
  'cost-tracker', // 文件名，出现在 import 路径中
  'CostTracker',  // 类标识符
  'costTracker',  // 变量标识符
  'updateSubagentCost', // 同一保留子系统（usage 更新器）
];

// 绝不允许在 src/ 作为裸词重现的成本/定价概念词。
const RESIDUAL_PATTERN = /\b(totalUSD|settledUSD|resolvePricing|pricing|cost)\b/g;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释
    .replace(/\/\/.*$/gm, ' '); // 行注释（移除只会减少匹配，不会误增）
}

function stripAllowed(src) {
  let out = src;
  for (const token of ALLOWED_TOKENS) {
    out = out.split(token).join(' ');
  }
  return out;
}

function collectSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

test('ADR-0046 D1: no cost-concept residuals remain in src/', () => {
  const files = collectSourceFiles(SRC_DIR);
  const violations = [];

  for (const file of files) {
    const rel = file.slice(SRC_DIR.length + 1);
    let text = readFileSync(file, 'utf8');
    text = stripComments(text);
    text = stripAllowed(text);

    const hits = text.match(RESIDUAL_PATTERN);
    if (hits) {
      for (const h of hits) violations.push(`${rel}: residual "${h}"`);
    }
  }

  assert.deepStrictEqual(
    violations,
    [],
    `Cost-concept residuals found in src/ (ADR-0046 D1 regression):\n${violations.join('\n')}`,
  );
});
