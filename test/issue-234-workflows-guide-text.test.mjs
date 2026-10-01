// #234（T11 文案三面与技能）——GPT_INSTRUCTIONS WORKFLOWS 段 × workflow_start 描述同文锁
//
// 票面六条测试清单（口径 = ADR-0052 §23① 钉的六条）：
//   ① 双版 WORKFLOWS 段 ≤1200 码点
//   ② workflow_start 描述与 EN 段正文逐字相等（照 issue-140 AC② 的模板串抽取手法）
//   ③ 关键词纪律：en poll / partial / cancel / cache；zh 轮询 / partial / 取消 / 缓存
//   ④ 边界数字在位：2 / 16 / 1000 / 30 / 8,000,000
//   ⑤ 双版锚点序 SUBAGENT → SKILL → WORKFLOWS →（EN）MESSAGES, EVENTS, AND HISTORY
//     ／（ZH）消息、事件与历史
//   ⑥ workflow_cancel 三句描述不入同文约束（工具本地文本）
//
// 另加：尺寸棘轮（描述/段 ≤1200 + 参数级 900/950/250/850，二者独立计）、文本内容禁令
// （loopMinutes 与任何模型可传闸门参数）、reduce 面 = { runId }、既有 SUBAGENT..SKILL
// 抽取不受影响。
//
// 码点口径：[...s].length（与 wc -m 一致），非 UTF-16 码元。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { BUILTIN_INPUT_SCHEMAS } from '../dist/tool-schemas.js';

const root = path.resolve(import.meta.dirname, '..');
const EN_DOC = 'docs/GPT_INSTRUCTIONS.md';
const ZH_DOC = 'docs/GPT_INSTRUCTIONS.zh-CN.md';

/** 段 = 起始标题与后继标题之间（不含两标题），首尾空行剥掉——照 issue-140 手法。 */
function segment(file, start, end) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${file} 段 ${start}..${end} 缺失`);
  return text.slice(from + start.length, to).replace(/^\n+|\n+$/g, '');
}

/** 正文 = 从第一条 bullet 起（标题行不进正文，同文锁比对的是正文）。 */
function bodyOf(segmentText) {
  const lines = segmentText.split('\n');
  const first = lines.findIndex((line) => line.startsWith('- '));
  assert.ok(first >= 0, '段内没有 bullet 行');
  return lines.slice(first).join('\n').trim();
}

const enSection = () => segment(EN_DOC, 'WORKFLOWS', 'MESSAGES, EVENTS, AND HISTORY');
const zhSection = () => segment(ZH_DOC, 'WORKFLOWS', '消息、事件与历史');
const enBody = () => bodyOf(enSection());
const zhBody = () => bodyOf(zhSection());

/** 照 issue-140 AC②：从 core-tools 的 description 取，不读 dist（锁的是源码文本）。 */
function coreDescription(toolName, title) {
  const src = fs.readFileSync(path.join(root, 'src/core-tools.ts'), 'utf8');
  const pattern = new RegExp(
    `name: '${toolName}',\\s*title: '${title}',[\\s\\S]*?description: (\`([^\\\`]*)\`|'((?:[^'\\\\]|\\\\.)*)')`,
  );
  const match = src.match(pattern);
  assert.ok(match, `core-tools.ts 找不到 ${toolName} 的 description`);
  return match[2] ?? match[3];
}

const START_DESCRIPTION = () => coreDescription('workflow_start', 'Start workflow');

// ── ① 双版 ≤1200 码点（硬上限）──

const SECTION_CAP = 1200;

test('① WORKFLOWS 段双版正文 ≤1200 码点', () => {
  for (const [name, body] of [['en', enBody()], ['zh', zhBody()]]) {
    const chars = [...body].length;
    assert.ok(chars <= SECTION_CAP, `${name} WORKFLOWS 段正文 ${chars} 码点 > ${SECTION_CAP}`);
    assert.ok(chars > 400, `${name} WORKFLOWS 段正文只有 ${chars} 码点，生存必需内容不可能装得下`);
  }
});

// ── ② 与 workflow_start 描述逐字相等 ──

test('② workflow_start 描述与 EN 段正文逐字相等（同文锁）', () => {
  assert.equal(START_DESCRIPTION().trim(), enBody());
});

test('② 描述本身也过 ≤1200 码点棘轮（口径：工具总描述 = 段正文）', () => {
  const chars = [...START_DESCRIPTION().trim()].length;
  assert.ok(chars <= SECTION_CAP, `workflow_start 描述 ${chars} 码点 > ${SECTION_CAP}`);
});

// ── ③ 关键词纪律 ──

test('③ 收尾与判定关键词双版在位', () => {
  const en = enBody();
  for (const kw of ['poll', 'partial', 'cancel', 'cache']) {
    assert.ok(en.includes(kw), `en 缺关键词 ${kw}`);
  }
  const zh = zhBody();
  for (const kw of ['轮询', 'partial', '取消', '缓存']) {
    assert.ok(zh.includes(kw), `zh 缺关键词 ${kw}`);
  }
});

// ── ④ 边界数字在位（按定稿写法）──

test('④ 边界数字双版在位：2 / 16 / 1000 / 30 / 8,000,000', () => {
  const en = enBody();
  const zh = zhBody();
  assert.ok(en.includes('max(2, min(16, cores-2))'), 'en 缺并发窗口公式');
  assert.ok(zh.includes('max(2, min(16, 核数-2))'), 'zh 缺并发窗口公式');
  for (const [body, label] of [[en, 'en'], [zh, 'zh']]) {
    for (const n of ['1000', '30', '8,000,000']) {
      assert.ok(body.includes(n), `${label} 缺边界数字 ${n}`);
    }
  }
});

// ── ⑤ 锚点序 + 插入位置 = SKILL 之后 ──

test('⑤ 双版锚点序 SUBAGENT → SKILL → WORKFLOWS → 后继节', () => {
  for (const [file, next] of [[EN_DOC, 'MESSAGES, EVENTS, AND HISTORY'], [ZH_DOC, '消息、事件与历史']]) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const at = (marker) => text.indexOf(marker);
    assert.ok(at('SUBAGENT') >= 0 && at('SKILL') >= 0 && at('WORKFLOWS') >= 0 && at(next) >= 0, `${file} 锚点缺失`);
    assert.ok(at('SUBAGENT') < at('SKILL'), `${file} SUBAGENT 不在 SKILL 之前`);
    assert.ok(at('SKILL') < at('WORKFLOWS'), `${file} WORKFLOWS 段不在 SKILL 之后`);
    assert.ok(at('WORKFLOWS') < at(next), `${file} WORKFLOWS 段不在后继节标题之前`);
  }
});

test('⑤ zh 版 WORKFLOWS 头用英文（与 zh 版 SUBAGENT / SKILL 风格一致）', () => {
  const lines = fs.readFileSync(path.join(root, ZH_DOC), 'utf8').split('\n');
  const heading = lines[lines.indexOf('WORKFLOWS')];
  assert.equal(heading, 'WORKFLOWS', 'zh 版段标题必须正好是英文 WORKFLOWS 一行');
  assert.ok(lines[lines.indexOf(heading) + 1].startsWith('- '), '标题后应紧跟 bullet 正文');
  assert.ok(!lines.some((line) => /^工作流/.test(line) && !line.startsWith('-')), 'zh 版出现了中文段标题');
});

test('⑤ 既有 SUBAGENT..SKILL 段抽取不受影响（issue-140 的锚点不被插队污染）', () => {
  for (const [file, next] of [[EN_DOC, 'SKILL'], [ZH_DOC, 'SKILL']]) {
    const subagentSegment = segment(file, 'SUBAGENT', next);
    assert.ok(!subagentSegment.includes('WORKFLOWS'), `${file} SUBAGENT..SKILL 段抽到了新段内容`);
    assert.ok(!/workflow/i.test(subagentSegment), `${file} SUBAGENT..SKILL 段混入 workflow 措辞`);
  }
});

// ── 四段骨架：决策段最前，不可被其它内容挤走 ──

/**
 * 骨架按 bullet 边界判，不用整段 indexOf——两个词落在同一条 bullet 里时，
 * indexOf 的大小关系是巧合而不是顺序锁（评审抓到的假断言）。
 * 作者指针句刻意嵌在运行段内（容量裁决：段只保生存必需），所以判据是
 * "指针句在限制段之前、复用内容独占最后一条 bullet"。
 */
const SKELETON_MARKERS = [
  ['en', enBody, { decision: 'only when the user asks', pointer: 'workflow-authoring', limits: 'Limits:', reuse: 'resumeFromRunId', antiDrift: 'contract lives only there' }],
  ['zh', zhBody, { decision: '只在用户提出时', pointer: 'workflow-authoring', limits: '限制：', reuse: 'resumeFromRunId', antiDrift: '脚本契约只写在技能里' }],
];

test('骨架顺序：决策段第一条、作者指针在限制段之前、复用段是最后一条（双版）', () => {
  for (const [label, getBody, markers] of SKELETON_MARKERS) {
    const bullets = getBody().split('\n').filter((line) => line.startsWith('- '));
    assert.ok(bullets.length >= 4, `${label}：bullet 只有 ${bullets.length} 条，四段骨架不成立`);
    const at = (needle) => {
      const index = bullets.findIndex((bullet) => bullet.includes(needle));
      assert.ok(index >= 0, `${label}：没有 bullet 含 "${needle}"`);
      return index;
    };
    assert.equal(at(markers.decision), 0, `${label}：决策段不在第一条`);
    assert.ok(at(markers.pointer) < at(markers.limits), `${label}：作者指针句没在限制段之前`);
    assert.equal(at(markers.reuse), bullets.length - 1, `${label}：复用段没占住最后一条 bullet`);
    assert.ok(getBody().includes(markers.antiDrift), `${label}：缺"契约只在技能里"的防漂移句`);
  }
});

test('opt-in 语义在描述首段（仅用户请求可启动、不自行发起）', () => {
  const en = enBody().split('\n')[0];
  assert.ok(/only when the user asks/.test(en), '首段缺"只在用户提出时"');
  assert.ok(/Never self-initiate|Never start on your own/.test(en), '首段缺"绝不自行发起"');
  assert.ok(/ask what to run first/.test(en), '首段缺"只给名字先追问"');
});

// ── 文本内容禁令 ──

const FORBIDDEN_GATE_WORDS = [
  'loopMinutes',
  'tokenCap',
  'runGate',
  'agentCap',
  'concurrencyWindow=',
  'maxParallel',
  'reducerBudget',
  'timeoutSec',
  'maxTurns',
  'stallMs',
  'budgetEndsAt',
];

test('禁令：段与描述不出现 loopMinutes 或任何模型可传的闸门参数', () => {
  for (const [label, text] of [['en 段', enBody()], ['zh 段', zhBody()], ['描述', START_DESCRIPTION()]]) {
    for (const word of FORBIDDEN_GATE_WORDS) {
      assert.ok(!text.includes(word), `${label} 出现模型可传闸门参数 "${word}"`);
    }
  }
});

test('禁令：限制数值必须在段内出现（数值保留 ≠ 参数暴露）', () => {
  const en = enBody();
  assert.ok(en.includes('8,000,000') && en.includes('30-minute'), '段缺默认上限数值');
  assert.ok(/widen only on.*explicit user request/.test(en), '段缺"仅用户明确要求才调大"授权句');
});

test('reduce 面 = { runId }（ADR §8 I10），示例文案按此写', () => {
  assert.ok(enBody().includes('reduce:{runId}'), 'en 段未按 reduce:{runId} 写');
  assert.ok(zhBody().includes('reduce:{runId}'), 'zh 段未按 reduce:{runId} 写');
});

test('明示没有命令入口——启动只经对话里的工具调用', () => {
  assert.match(enBody(), /No command entry point|there are no commands/i);
  assert.match(zhBody(), /没有命令入口/);
});

// ── ⑥ workflow_cancel 三句描述不入同文约束 ──

test('⑥ workflow_cancel 描述是工具本地文本：三句照旧，且不与 WORKFLOWS 段同文', () => {
  const desc = coreDescription('workflow_cancel', 'Cancel workflow');
  assert.equal(
    desc.trim(),
    'Cancel a running workflow run started by this session. Idempotent; a terminal run returns its current status. The reducer will report partial results.',
  );
  assert.notEqual(desc.trim(), enBody(), 'workflow_cancel 描述被并入了同文约束');
  // 段里可以提 workflow_cancel（那是启动链的一部分），但不得整段复用它的三句。
  assert.ok(!enBody().includes('started by this session'), '段把 cancel 的归属句抄进了同文约束');
});

// ── 尺寸棘轮：参数级上限（防膨胀；与段/描述独立计）──

const PARAM_CAPS = { script: 900, scriptPath: 950, args: 250, resumeFromRunId: 850 };
/**
 * 参数面**当前没有任何描述文本**，棘轮处于休眠态——休眠不是"空过"：长度锁在基线 0 上，
 * 谁给参数加文本，这条即红，必须显式改基线并自证未越各自上限（防"悄悄膨胀"）。
 */
const PARAM_TEXT_BASELINE = { script: 0, scriptPath: 0, args: 0, resumeFromRunId: 0 };

test('棘轮：参数描述长度锁在基线上（休眠态；加文本必须显式改基线）', () => {
  const properties = BUILTIN_INPUT_SCHEMAS.workflow_start.properties;
  assert.deepEqual(Object.keys(properties).sort(), Object.keys(PARAM_CAPS).sort(), '参数集变了——上限表与基线都要同步改');
  for (const [name, cap] of Object.entries(PARAM_CAPS)) {
    const raw = properties[name].description;
    assert.ok(raw === undefined || typeof raw === 'string', `${name} 的 description 不是字符串，长度无从度量`);
    const chars = [...(raw ?? '')].length;
    assert.ok(chars <= cap, `${name} 参数描述 ${chars} 码点 > 上限 ${cap}`);
    assert.equal(chars, PARAM_TEXT_BASELINE[name], `${name} 参数描述由 ${PARAM_TEXT_BASELINE[name]} 码点变成 ${chars} 码点——加文本要显式改基线，别让它悄悄长`);
  }
});

test('棘轮：形状本身未被塞进闸门参数（additionalProperties false + 无 required 之外的键）', () => {
  const schema = BUILTIN_INPUT_SCHEMAS.workflow_start;
  assert.equal(schema.additionalProperties, false);
  for (const key of Object.keys(schema.properties)) {
    assert.ok(!FORBIDDEN_GATE_WORDS.some((word) => key.toLowerCase().includes(word.toLowerCase())), `参数面出现闸门参数 ${key}`);
  }
});
