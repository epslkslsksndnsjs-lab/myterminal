import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectMcpTools } from '../test/fixtures/tool-schema-baseline-issue41.mjs';

const base = JSON.parse(readFileSync(new URL('../test/fixtures/mcp-tools-issue41.json', import.meta.url), 'utf8'));
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
const buckets = { 展示层default: [], 约束收紧: [], 约束放宽: [], 工具面增减: [], 对外文案与注解: [], 其他: [] };

// 基线只遍历自己认识的工具 → 新加的工具（如 #235 的两个 workflow 直连工具）在旧探针里
// 完全隐身。先把名单差本身报出来，再对两侧交集逐字段走。
const baseNames = new Set(Object.keys(base));
const curNames = new Set(Object.keys(cur || {}));
for (const name of [...curNames].filter((n) => !baseNames.has(n)).sort()) {
  const t = cur[name] || {};
  buckets.工具面增减.push(`+ ${name}  title=${JSON.stringify(t.title)}  annotations=${JSON.stringify(t.annotations)}`);
}
for (const name of [...baseNames].filter((n) => !curNames.has(n)).sort()) {
  buckets.工具面增减.push(`- ${name}  （基线有、现无）`);
}

for (const name of baseNames) {
  if (!curNames.has(name)) continue;
  // 非 schema 的对外面：title / description / annotations / _meta 漂了也要显式看见
  for (const field of ['title', 'description']) {
    if (JSON.stringify(base[name][field]) !== JSON.stringify(cur[name][field])) {
      buckets.对外文案与注解.push(`${name} :: ${field}  ` + JSON.stringify([base[name][field], cur[name][field]]));
    }
  }
  for (const field of ['annotations', '_meta']) {
    const out = [];
    walk(base[name][field], cur[name][field], field, out);
    for (const d of out) buckets.对外文案与注解.push(`${name} :: ${d.p}  [` + JSON.stringify(d.base) + ' -> ' + JSON.stringify(d.cur) + ']');
  }
  const out = [];
  walk(base[name].inputSchema, cur[name].inputSchema, '', out);
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
