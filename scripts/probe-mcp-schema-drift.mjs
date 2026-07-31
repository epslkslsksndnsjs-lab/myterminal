import { readFileSync } from 'node:fs';
import { collectMcpTools } from '../test/fixtures/tool-schema-baseline-issue41.mjs';

const base = JSON.parse(readFileSync('../test/fixtures/mcp-tools-issue41.json', 'utf8'));
const cur = await collectMcpTools();

// 递归收集 (路径 -> 关键字) 差异
function walk(a, b, path, out) {
  const ka = new Set(Object.keys(a || {}));
  const kb = new Set(Object.keys(b || {}));
  for (const k of new Set([...ka, ...kb])) {
    const va = a ? a[k] : undefined;
    const vb = b ? b[k] : undefined;
    const p = path ? path + '.' + k : k;
    if (va && vb && typeof va === 'object' && typeof vb === 'object' && !Array.isArray(va)) {
      walk(va, vb, p, out);
    } else if (JSON.stringify(va) !== JSON.stringify(vb)) {
      out.push({ p, base: va, cur: vb });
    }
  }
}

const CONSTRAINT = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'enum', 'type', 'required', 'additionalProperties']);
const buckets = { 展示层default: [], 约束收紧: [], 约束放宽: [], 其他: [] };

for (const name of Object.keys(base)) {
  const out = [];
  walk(base[name].inputSchema, cur[name] && cur[name].inputSchema, '', out);
  for (const d of out) {
    const leaf = d.p.split('.').pop();
    const entry = name + ' :: ' + d.p + '  [' + JSON.stringify(d.base) + ' -> ' + JSON.stringify(d.cur) + ']';
    if (leaf === 'default') buckets.展示层default.push(entry);
    else if (CONSTRAINT.has(leaf)) {
      if (d.base === undefined) buckets.约束收紧.push(entry);
      else if (d.cur === undefined) buckets.约束放宽.push(entry);
      else buckets.其他.push(entry);
    } else buckets.其他.push(entry);
  }
}
for (const [k, v] of Object.entries(buckets)) {
  console.log('\n===== ' + k + ' (' + v.length + ') =====');
  v.forEach((x) => console.log('  ' + x));
}
