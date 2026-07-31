import { z } from 'zod';

// main 09f2246 mcp.ts:25 的形态（节选关键带类型字段 + catchall）
const MAIN = z.object({
  mode: z.enum(['root', 'delegate']).optional(),
  limit: z.number().int().optional(),
  markRead: z.boolean().optional(),
  deliverables: z.array(z.string()).optional(),
  name: z.string().optional(),
}).catchall(z.unknown());

// seams 0821a7d mcp.ts:34 的形态
const SEAMS = z.record(z.string(), z.unknown());

const cases = [
  ['limit 传字符串（应被 main 拒）',        { limit: 'abc' }],
  ['limit 传小数（int 约束）',              { limit: 1.5 }],
  ['mode 传非枚举值',                       { mode: 'wildcard' }],
  ['markRead 传字符串',                     { markRead: 'yes' }],
  ['deliverables 传字符串而非数组',         { deliverables: 'a,b' }],
  ['name 传数字',                           { name: 123 }],
  ['未声明的额外字段（两边都该放行）',       { somethingNew: 42 }],
  ['合法输入（两边都该放行）',               { limit: 10, mode: 'root' }],
];

const r = (s, v) => s.safeParse(v).success ? 'accept' : 'REJECT';
console.log('用例'.padEnd(38), 'main'.padEnd(8), 'seams');
console.log('-'.repeat(60));
let diff = 0;
for (const [label, val] of cases) {
  const a = r(MAIN, val), b = r(SEAMS, val);
  if (a !== b) diff++;
  console.log(label.padEnd(34), a.padEnd(10), b, a !== b ? '   <<< 行为不一致' : '');
}
console.log('-'.repeat(60));
console.log(`行为不一致用例数: ${diff} / ${cases.length}`);
