import { execSync } from 'node:child_process';

/**
 * 双口径之一：行覆盖门禁（ADR-0052 §13）。
 *
 * 与变异口径并行、缺一不算完成。核心（workflows 引擎目录）≥95%，
 * 边缘（MCP/桥接适配等）≥80%。默认跑全量套件；开发期可用
 * TEST_FILES='test/issue-224-*.test.mjs' 只看本票面。
 */

const CORE_LINE_THRESHOLD = Number(process.env.COVERAGE_CORE_MIN ?? 95);
const EDGE_LINE_THRESHOLD = Number(process.env.COVERAGE_EDGE_MIN ?? 80);
const TEST_FILES = process.env.TEST_FILES || 'test/*.test.mjs';

/** 核心 = workflows 引擎目录（调度 / 沙箱 / 账本 / 结算 / 注册表 / 路径与版本）。 */
const CORE_PATTERN = /dist\/workflows\//;

const out = execSync(`bun test --coverage --timeout 120000 ${TEST_FILES} 2>&1`, {
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
  env: { ...process.env, CI: '1' },
});

const rows = [];
for (const line of out.split('\n')) {
  const match = /^\s*([\w./@-]+\.m?js)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|?/.exec(line);
  if (!match) continue;
  rows.push({ file: match[1], funcs: Number(match[2]), lines: Number(match[3]) });
}

if (rows.length === 0) {
  console.error('未解析到任何覆盖率行——报告格式变了，门禁不能假绿。');
  process.exit(1);
}

const core = rows.filter((row) => CORE_PATTERN.test(row.file));
if (core.length === 0) {
  console.error('未找到 workflows 核心文件的覆盖率行——门禁不能假绿。');
  process.exit(1);
}

const failures = [];
for (const row of core) {
  if (row.lines < CORE_LINE_THRESHOLD) failures.push(`${row.file}: 行覆盖 ${row.lines}% < 核心线 ${CORE_LINE_THRESHOLD}%`);
}
const coreLines = core.reduce((sum, row) => sum + row.lines, 0) / core.length;

console.log(`核心文件 ${core.length} 个，平均行覆盖 ${coreLines.toFixed(2)}%（线 = ${CORE_LINE_THRESHOLD}%）`);
for (const row of core.sort((a, b) => a.lines - b.lines)) {
  console.log(`  ${row.lines.toFixed(2).padStart(6)}%  ${row.file}`);
}
console.log(`边缘线 = ${EDGE_LINE_THRESHOLD}%（本票无边缘文件，随后续票接入）`);

if (failures.length) {
  console.error('\n覆盖门禁未过：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('覆盖门禁通过。');
