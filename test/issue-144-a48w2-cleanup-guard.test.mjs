// ADR-0048 票 #144 — A48-W2 清理守卫测试（F1/F3/F4/F5 回归红线）
//
// 目的：锁死 A48-W2 轴2 审计低危打包的成果：
//   F1 updateUsage / F3 collectSubagentResult+getSubagentResult 死函数已从 src/subagent 移除
//   F4 SubagentRecord.createdAt/completedAt 死写字段已从 store.ts 移除
//   F5 mcp.ts subagent_status 描述与 core-tools.ts 幂等口径逐字对齐
//
// 任何在 src/subagent 重新出现上述标识符（注释除外）都会让本测试失败。
// 仿 no-cost-residual-guard.test.mjs 惯例（ADR-0046 D1 守卫，ticket #21）。
// 变异体对抗：本守卫即变异杀手——F1/F3 函数复活、F4 字段复活、F5 描述回退，任一变异必被本文件杀死。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..', 'src');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释
    .replace(/\/\/.*$/gm, ' '); // 行注释
}

function collectSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// 切片 1（F5）：mcp.ts subagent_status 描述 = 幂等口径，与 core-tools.ts:705 逐字一致
// 期望值来源：ADR-0048:215 幂等保留语义 + core-tools.ts 现状措辞（spec 来源，非代码重算）。
const IDEMPOTENT_DESCRIPTION =
  'Query subagent progress, tasks, token usage, and result. Idempotent: after completion the result stays available for repeated queries until the one-hour cleanup.';

test('144-F5: mcp.ts subagent_status description is idempotent', () => {
  const mcp = readFileSync(join(SRC_DIR, 'mcp.ts'), 'utf8');
  const coreTools = readFileSync(join(SRC_DIR, 'core-tools.ts'), 'utf8');

  // core-tools 与 mcp.ts 双含同一幂等句（对齐契约；core-tools 侧若先改，本守卫即报警）
  assert.ok(coreTools.includes(IDEMPOTENT_DESCRIPTION), 'core-tools.ts should contain the idempotent description');
  assert.ok(mcp.includes(IDEMPOTENT_DESCRIPTION), 'mcp.ts subagent_status should use the idempotent description');
  assert.ok(!mcp.includes('On first call after completion'), 'mcp.ts must not retain the collect-on-read wording');
});

// 切片 2（F1/F3）：src/subagent 零残留 updateUsage / collectSubagentResult / getSubagentResult
const DEAD_FUNCTIONS_PATTERN = /\b(updateUsage|collectSubagentResult|getSubagentResult)\b/g;

test('144-F1F3: dead functions removed from src/subagent', () => {
  const files = collectSourceFiles(join(SRC_DIR, 'subagent'));
  const violations = [];

  for (const file of files) {
    const rel = file.slice(SRC_DIR.length + 1);
    const text = stripComments(readFileSync(file, 'utf8'));
    const hits = text.match(DEAD_FUNCTIONS_PATTERN);
    if (hits) {
      for (const h of hits) violations.push(`${rel}: residual "${h}"`);
    }
  }

  assert.deepStrictEqual(
    violations,
    [],
    `Dead-function residuals found in src/subagent (ADR-0048 #144 F1/F3 regression):\n${violations.join('\n')}`,
  );
});

// 切片 3（F4）：store.ts 零残留 createdAt / completedAt（SubagentRecord 死写字段）
const DEAD_FIELDS_PATTERN = /\b(createdAt|completedAt)\b/g;

test('144-F4: SubagentRecord createdAt/completedAt removed from store.ts', () => {
  const store = stripComments(readFileSync(join(SRC_DIR, 'subagent', 'store.ts'), 'utf8'));
  const hits = store.match(DEAD_FIELDS_PATTERN);
  assert.deepStrictEqual(
    hits,
    null,
    `Dead-field residuals found in src/subagent/store.ts (ADR-0048 #144 F4 regression)`,
  );
});
