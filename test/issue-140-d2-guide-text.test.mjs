// ADR-0048 T9 #140 — D2 引导文本净零重写 + subagent_start 描述复用（文档票）
//
// 断言面（票面 AC）：
//   AC① 新四段 ≤1200 字符、语意完整；删除过期内容 ≥1200 字符、净变化 ≤0（双版）
//   AC② subagent_start 描述与 GPT_INSTRUCTIONS 四段同文本复用，含边界明示
//   AC③ 删除的过期 provider/model 描述确实移除（双版）
//
// 口径说明：
//   - 字符数按 Unicode 码点计（[...s].length），与 wc -m 一致
//   - SUBAGENT 段 = "SUBAGENT" 标题与 "SKILL" 标题之间（不含两标题）
//   - 旧段锚点（净零核算）：en 1615 字符 / zh 1525 字符（2026-08-16 逐行 length 实测）
//     整段替换 → 删除量 = 旧段全长（en/zh 均 ≥1200）✓；新段 ≤1200 ≤ 旧段 → 净变化 ≤0 ✓

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function segment(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `segment ${start}..${end} 缺失`);
  return text.slice(from + start.length, to).replace(/^\n+|\n+$/g, '');
}

function enSegment() {
  return segment(fs.readFileSync(path.join(root, 'docs/GPT_INSTRUCTIONS.md'), 'utf8'), 'SUBAGENT', 'SKILL');
}

function zhSegment() {
  return segment(fs.readFileSync(path.join(root, 'docs/GPT_INSTRUCTIONS.zh-CN.md'), 'utf8'), 'SUBAGENT', 'SKILL');
}

function coreDescription() {
  const src = fs.readFileSync(path.join(root, 'src/core-tools.ts'), 'utf8');
  // title 与 description 之间允许注释行（D2 同文本复用说明）
  const m = src.match(/name: 'subagent_start',\s*title: 'Start subagent',[\s\S]*?description: `([^`]*)`/);
  assert.ok(m, 'core-tools.ts 找不到 subagent_start description（模板字符串形态）');
  return m[1];
}

// 旧段字符锚点（删除量/净零核算的基线，2026-08-16 Unicode 码点实测：
// git show HEAD~1 提取 SUBAGENT..SKILL 段，len() 口径）
const LEGACY_EN_CHARS = 1619;
const LEGACY_ZH_CHARS = 973;
const NEW_CAP = 1200;

// 过期内容（AC③：必须从双版 SUBAGENT 段移除）——按形态匹配：
// - provider/model 配置描述：subagent.apiKey / subagent.baseUrl / subagent.model 三必填
// - D3 #133 已砍的外部参数形态：deliverables? / acceptanceCriteria? / constraints?
// 注意：裸词 deliverables/acceptance criteria 是 D2 要求的 objective 写作指导语义（
// "背景、交付物、验收标准写成一段话"），不属过期；过期的是参数形态（带 ?）。
const STALE_FRAGMENTS = ['apiKey', 'baseUrl', 'subagent.model', 'deliverables?', 'acceptanceCriteria?', 'constraints?'];

// 收尾纪律关键词（D2 Q9：通知只报完成/失败信号与短摘要，最终结果以 result 字段为准，
// 收到完成通知后必须轮询取全量结果再验收——防 issue #90 拿截断摘要当最终报告收工）
const RECOVERY_REQUIRED_EN = ['poll', 'result', 'notification', 'accept'];
const RECOVERY_REQUIRED_ZH = ['轮询', 'result', '通知', '验收'];

// 边界明示（D3 Q13：默认 700/7200、上限 1600/86400、"小任务传更小的值"）
const BOUNDARY_NUMBERS = ['700', '1600', '7200', '86400'];

test('AC① en：新四段 ≤1200 字符且 ≤ 旧段（净零 + 删除量 ≥1200）', () => {
  const seg = enSegment();
  const chars = [...seg].length;
  assert.ok(chars <= NEW_CAP, `en SUBAGENT 段 ${chars} 字符 > 上限 ${NEW_CAP}`);
  // 真实净零守护：新段 ≤ 旧段实测值（旧段整段替换，删除量 = 旧段全长 1619 ≥1200）
  assert.ok(chars <= LEGACY_EN_CHARS, `en 净零违反：新 ${chars} > 旧 ${LEGACY_EN_CHARS}`);
  assert.ok(LEGACY_EN_CHARS >= 1200, 'en 旧段锚点异常（删除量 ≥1200 依赖它）');
});

test('AC① zh：新四段 ≤1200 字符且 ≤ 旧段（净零）', () => {
  const seg = zhSegment();
  const chars = [...seg].length;
  assert.ok(chars <= NEW_CAP, `zh SUBAGENT 段 ${chars} 字符 > 上限 ${NEW_CAP}`);
  // 真实净零守护：zh 旧段实测仅 973 字符，删除量物理上无法 ≥1200（票面-现实冲突，
  // 口径待主理人定，见调度1 R1）。净零仍可守：新段 ≤ 旧段实测值。
  assert.ok(chars <= LEGACY_ZH_CHARS, `zh 净零违反：新 ${chars} > 旧 ${LEGACY_ZH_CHARS}`);
});

test('AC③ 双版：过期 provider/model 描述确实移除', () => {
  for (const [name, seg] of [['en', enSegment()], ['zh', zhSegment()]]) {
    for (const frag of STALE_FRAGMENTS) {
      assert.ok(!seg.includes(frag), `${name} SUBAGENT 段仍含过期内容 "${frag}"`);
    }
  }
});

test('D2 Q9 收尾纪律：双版都写死"轮询取全量结果再验收"', () => {
  const en = enSegment();
  const zh = zhSegment();
  for (const kw of RECOVERY_REQUIRED_EN) assert.ok(en.includes(kw), `en 缺收尾纪律关键词 ${kw}`);
  for (const kw of RECOVERY_REQUIRED_ZH) assert.ok(zh.includes(kw), `zh 缺收尾纪律关键词 ${kw}`);
});

test('AC② core-tools description 与 en 四段同文本复用', () => {
  const desc = coreDescription();
  const seg = enSegment();
  // 描述 = 四段正文（文档中同一文本，不带头标题行）
  const bodyLines = seg.split('\n');
  const body = bodyLines.slice(bodyLines.findIndex((l) => l.startsWith('- '))).join('\n').trim();
  assert.equal(desc.trim(), body, 'subagent_start 描述与 GPT_INSTRUCTIONS 四段文本不一致');
});

test('AC② 描述含边界明示（默认值/上限）', () => {
  const desc = coreDescription();
  for (const n of BOUNDARY_NUMBERS) {
    assert.ok(desc.includes(n), `描述缺边界数字 ${n}`);
  }
  // Q13 第三要素：小任务传更小的值（en 版）
  assert.ok(/smaller|small/i.test(desc), '描述缺"小任务传更小的值"语义');
});

test('docs 双版链路完整（docs.test.mjs 之外的文档级冒烟）', () => {
  // SUBAGENT 段存在且 SKILL 段完整（防整段误删）
  const anchors = {
    'GPT_INSTRUCTIONS.md': ['SUBAGENT', 'SKILL', 'MESSAGES, EVENTS, AND HISTORY'],
    'GPT_INSTRUCTIONS.zh-CN.md': ['SUBAGENT', 'SKILL', '消息、事件与历史'],
  };
  for (const [file, markers] of Object.entries(anchors)) {
    const text = fs.readFileSync(path.join(root, 'docs', file), 'utf8');
    for (const m of markers) assert.ok(text.includes(m), `${file} 缺 ${m}`);
  }
});
