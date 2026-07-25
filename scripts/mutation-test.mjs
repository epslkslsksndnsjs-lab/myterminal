import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// 5 个变异点，针对这次改动的关键逻辑
const mutations = [
  { name: 'policy classification removed (catch 标 failed 而非 policy_rejected)', file: 'src/extensions.ts', find: "isPolicyRejection ? 'policy_rejected' : 'failed'", replace: "'failed'" },
  { name: 'alias key not deleted (归一化不删别名键)', file: 'src/extensions.ts', find: '      delete normalized[alias];\n', replace: '' },
  { name: 'finishAudit fallback disabled (缺码兜底永不触发)', file: 'src/extensions.ts', find: '(!finalError || !finalError.code)', replace: '(false)' },
  { name: 'store read fallback removed (auditFact 读取兜底去掉)', file: 'src/store.ts', find: "rawErrorCode || (status === 'failed' || status === 'timeout' ? 'UNKNOWN_ERROR' : undefined)", replace: 'rawErrorCode' },
  { name: 'wrong alias mapping (pattern→path 错误映射)', file: 'src/core-tools.ts', find: "aliases: { pattern: 'query' }", replace: "aliases: { pattern: 'path' }", all: true },
];

let killedByTest = 0;
let killedByBuild = 0;
let survived = 0;
const results = [];

for (const m of mutations) {
  const orig = readFileSync(m.file, 'utf8');
  const mutated = m.all ? orig.split(m.find).join(m.replace) : orig.replace(m.find, m.replace);
  if (mutated === orig) {
    results.push({ name: m.name, status: 'ERROR: find string not matched' });
    continue;
  }
  writeFileSync(m.file, mutated);
  try {
    execSync('bun run build 2>&1', { stdio: 'pipe' });
  } catch {
    killedByBuild++;
    results.push({ name: m.name, status: 'KILLED (build error)' });
    writeFileSync(m.file, orig);
    continue;
  }
  try {
    const out = execSync('bun test --timeout 120000 test/*.test.mjs 2>&1', { stdio: 'pipe', encoding: 'utf8' });
    const passMatch = out.match(/(\d+) pass/);
    const failMatch = out.match(/(\d+) fail/);
    const passes = passMatch ? parseInt(passMatch[1]) : 0;
    const fails = failMatch ? parseInt(failMatch[1]) : 0;
    if (fails > 0) {
      killedByTest++;
      results.push({ name: m.name, status: `KILLED (test: ${fails} fail)` });
    } else {
      survived++;
      results.push({ name: m.name, status: `SURVIVED (${passes} pass / 0 fail)` });
    }
  } catch (e) {
    killedByTest++;
    const out = e.stdout?.toString() || '';
    const failMatch = out.match(/(\d+) fail/);
    results.push({ name: m.name, status: `KILLED (test exited: ${failMatch ? failMatch[1] + ' fail' : 'nonzero'})` });
  }
  writeFileSync(m.file, orig);
}

// 恢复正确状态
execSync('bun run build 2>&1', { stdio: 'pipe' });

const total = results.length;
const killed = killedByTest + killedByBuild;
console.log('\n=== 变异测试结果 ===');
for (const r of results) console.log(`  ${r.status.padEnd(28)} | ${r.name}`);
console.log(`\n总变异: ${total}`);
console.log(`被测试杀死: ${killedByTest}`);
console.log(`被编译杀死: ${killedByBuild}`);
console.log(`存活: ${survived}`);
console.log(`Mutation score (测试捕获): ${killedByTest}/${total} = ${total ? (killedByTest/total*100).toFixed(1) : 0}%`);
console.log(`Mutation score (含编译): ${killed}/${total} = ${total ? (killed/total*100).toFixed(1) : 0}%`);
