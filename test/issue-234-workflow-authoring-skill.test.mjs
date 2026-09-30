// #234（T11 文案三面与技能）——workflow-authoring 技能面
//
// 锁定的是"技能作为模型可见第三份文本"的全部契约：
//   ① 经既有内建技能机制可见可加载（listSkills / loadSkill），零新安装面；
//   ② manifest 过既有校验（name 形态 / description 10..800 / when_to_use ≤2000 / mode=inline），
//      校验走真加载器（把发布件放进项目技能根去读），不是另写一份常量断言；
//   ③ 三块结构（触发与使用 / 作者参考 / 汇总体模板 + 轮询规则）；
//   ④ 三态触发规则 + opt-in（描述与 workflow_start 首段都含"仅用户请求、不自行发起"）；
//   ⑤ 文本内容禁令（loopMinutes 与任何模型可传闸门参数）+ reduce 面 = { runId } + 无命令入口；
//   ⑥ 轮询与收尾 doctrine、partial 诚实与判定、摘要形状（模板级、不作机器契约）；
//   ⑦ 汇总体 objective 模板与终态消息模板按行核对（T6 锁定版原样发布，改一字即红）；
//   ⑧ 发布物 SKILL.md 与内建注册正文逐字同文（防两份文本漂移）。
//
// 归属：技能名 workflow-authoring 是 #234 / #235 共享常量（#235 的 MCP instructions 行逐字引用），
// 本文件把它钉死——改名会同时打穿 #235 的防漂移矩阵。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { listSkills, loadSkill } from '../dist/skills.js';
import { DIGEST_TEMPLATE, REDUCER_OBJECTIVE_TEMPLATE, reducerSummaryBudget } from '../dist/workflows/reducer.js';
import { buildKvFirstLine, MAX_NOTICE_CODE_UNITS } from '../dist/workflows/notice.js';
import { WORKFLOW_SETTING_KEYS } from '../dist/workflows/gates.js';
import { KNOWN_AGENT_OPTS } from '../dist/workflows/agent-opts.js';

const root = path.resolve(import.meta.dirname, '..');
const SKILL_NAME = 'workflow-authoring';
const RELEASED_FILE = path.join(root, 'skills', SKILL_NAME, 'SKILL.md');

/** 走真加载器：把发布件放进项目技能根（<workspace>/.myterminal/skills/<name>/SKILL.md）再读。 */
function withInstalledSkill(run) {
  const base = path.join(os.tmpdir(), `issue-234-${randomBytes(4).toString('hex')}`);
  const configDir = path.join(base, 'config');
  const workspaceDir = path.join(base, 'workspace');
  const skillDir = path.join(workspaceDir, '.myterminal', 'skills', SKILL_NAME);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, 'skills'), { recursive: true });
  fs.copyFileSync(RELEASED_FILE, path.join(skillDir, 'SKILL.md'));
  try {
    return run(configDir, workspaceDir);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function builtinRecord() {
  return withInstalledSkill((configDir, workspaceDir) => {
    // 删掉用户件，只留内建注册——这样读到的必然是 BUILTIN_SKILLS 那一份。
    fs.rmSync(path.join(workspaceDir, '.myterminal', 'skills', SKILL_NAME), { recursive: true, force: true });
    return loadSkill(configDir, workspaceDir, SKILL_NAME);
  });
}

function skillBody() {
  const raw = fs.readFileSync(RELEASED_FILE, 'utf8');
  return raw.replace(/^---[\s\S]*?---\s*\n?/, '');
}

// ── ① 可见与可加载 ──

test('① 技能经既有内建机制出现在列表里，且 mode=inline', () => {
  const listed = withInstalledSkill((configDir, workspaceDir) => {
    fs.rmSync(path.join(workspaceDir, '.myterminal', 'skills', SKILL_NAME), { recursive: true, force: true });
    return listSkills(configDir, workspaceDir);
  });
  const record = listed.find((entry) => entry.name === SKILL_NAME);
  assert.ok(record, `${SKILL_NAME} 未在 listSkills 结果里`);
  assert.equal(record.mode, 'inline');
  assert.ok(record.description.length >= 10 && record.description.length <= 800, 'description 越出既有 10..800 上下限');
  assert.ok(record.when_to_use.length > 0 && record.when_to_use.length <= 2000, 'when_to_use 越出既有 ≤2000 上限');
});

test('① 发布件过既有 frontmatter 校验（真加载器读出来即证明）', () => {
  const loaded = withInstalledSkill((configDir, workspaceDir) => loadSkill(configDir, workspaceDir, SKILL_NAME));
  assert.ok(loaded, '发布件没通过既有校验（loadSkill 返回空）');
  assert.equal(loaded.name, SKILL_NAME);
  assert.equal(loaded.mode, 'inline');
  assert.ok(loaded.content.trim().length > 2000, '正文过短，装不下三块内容');
});

test('⑧ 发布件正文与内建注册逐字同文（两份文本不得漂移）', () => {
  const builtin = builtinRecord();
  assert.ok(builtin, '内建注册里没有 workflow-authoring');
  assert.equal(builtin.content, skillBody().endsWith('\n') ? skillBody() : `${skillBody()}\n`);
  assert.equal(builtin.description, loadedFrontmatter('description'));
  assert.equal(builtin.when_to_use, loadedFrontmatter('when_to_use'));
  assert.equal(builtin.mode, 'inline');
});

function loadedFrontmatter(key) {
  const raw = fs.readFileSync(RELEASED_FILE, 'utf8');
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter, 'SKILL.md 缺 frontmatter');
  const line = frontmatter[1].split('\n').find((entry) => entry.startsWith(`${key}:`));
  assert.ok(line, `SKILL.md frontmatter 缺 ${key}`);
  return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
}

test('技能名是共享常量，且形态过既有 name 正则', () => {
  assert.equal(loadedFrontmatter('name'), SKILL_NAME);
  assert.match(SKILL_NAME, /^[a-z][a-z0-9-]{2,63}$/);
});

// ── ③ 三块结构 ──

test('③ 恰好三块：触发与使用 / 作者参考 / 汇总体模板 + 轮询规则', () => {
  const headings = skillBody().split('\n').filter((line) => line.startsWith('## '));
  assert.equal(headings.length, 3, `技能块数是 ${headings.length}，硬上限 3 块`);
  assert.match(headings[0], /触发与使用|Trigger and use/i);
  assert.match(headings[1], /作者参考|Authoring reference/i);
  assert.match(headings[2], /汇总体|reducer/i);
  assert.match(headings[2], /轮询|poll/i);
});

// ── ④ 触发三态与 opt-in ──

test('④ description 与 when_to_use 承担"何时加载"的触发语义，并含 opt-in 免责句', () => {
  const description = loadedFrontmatter('description');
  const whenToUse = loadedFrontmatter('when_to_use');
  assert.match(description, /only when the user (asks|requests)/i, 'description 缺 opt-in');
  assert.match(description, /does not itself authorize/i, 'description 缺"技能本身不授权"句');
  assert.match(whenToUse, /user asks|user requests|names workflows/i, 'when_to_use 缺触发判据');
});

test('④ 三态触发规则齐备：点名 → 加载执行；只给名字 → 先追问；带任务 → 执行', () => {
  const body = skillBody();
  assert.match(body, /names? (the )?workflows?/i, '缺"点名"态');
  assert.match(body, /ask (the user )?(what to run|which)/i, '缺"只给名字先追问"态');
  assert.match(body, /with a task[^.]*run it|then write the script and start/i, '缺"带任务直接执行"态');
});

// ── ⑤ 禁令 ──

const FORBIDDEN_GATE_WORDS = [
  'loopMinutes',
  'tokenCap=',
  'runGate=',
  'agentCap=',
  'maxParallel=',
  'reducerBudget=',
  'reduce:{runId, loopMinutes}',
];

test('⑤ 技能全文不出现 loopMinutes 或任何模型可传的预算 / 闸门参数', () => {
  const text = fs.readFileSync(RELEASED_FILE, 'utf8');
  for (const word of FORBIDDEN_GATE_WORDS) {
    assert.ok(!text.includes(word), `技能出现闸门参数 "${word}"`);
  }
  // reduce 面只有 runId 一个键（ADR §8 I10）。
  assert.match(text, /reduce:\s*\{runId\}/, '技能未按 reduce 面 = { runId } 写');
  for (const match of text.matchAll(/reduce:\s*\{([^}]*)\}/g)) {
    assert.equal(match[1].replace(/\s/g, ''), 'runId', `reduce 面写出了 runId 之外的键：${match[1]}`);
  }
});

test('⑤ 明示没有命令入口——启动只经对话里的工具调用', () => {
  const text = skillBody();
  assert.match(text, /no command entry point|there is no command|没有命令入口/i);
  assert.match(text, /scripts? are saved|scriptPath/, '技能缺脚本持久化 / 复用面');
});

test('⑤ 限制数值在技能里也在位（容量裁决：技能是 doctrine 全文载体）', () => {
  const text = skillBody();
  for (const n of ['max(2, min(16', '1000', '30', '8,000,000', '180', '5/15/50']) {
    assert.ok(text.includes(n), `技能缺数值 ${n}`);
  }
});

// ── ⑥ 轮询与收尾 doctrine（数字必须锚定）──

test('⑥ 轮询预算与放手规则：回合内 ≤10 分钟、>20 路不轮询、到点留 runId 结束回合', () => {
  const text = skillBody();
  assert.match(text, /10 minutes/, '缺回合内轮询预算');
  assert.match(text, /more than 20|over 20|>20/, '缺 20 路不轮询线');
  assert.match(text, /keep the runId and end the turn|leave the runId/, '缺"到点留 runId 结束回合"');
  assert.match(text, /lastActivityAt/, '缺"轮询刷新 lastActivityAt"句');
  assert.match(text, /15 minutes/, '缺既有 stale 窗数值（窗本身不改，只说明）');
});

test('⑥ 启动回合 = 先侦察再写脚本，且同回合两个调用（start + reduce）', () => {
  const text = skillBody();
  assert.match(text, /reconnoiter|scout first|inspect first/i, '缺"先侦察"');
  assert.match(text, /same turn/, '缺"同回合两个调用"');
});

test('⑥ 收尾纪律：NOT_FOUND / failed → 查收件箱终态消息 → 必要时同 runId 重跑', () => {
  const text = skillBody();
  assert.match(text, /NOT_FOUND/, '缺 NOT_FOUND 分支');
  assert.match(text, /inbox/, '缺收件箱指引');
  assert.match(text, /same runId/, '缺同 runId 重跑指引');
});

test('⑥ 去重条款三条齐备（同键忽略 / 异 sha 注"更新版" / 轮询与消息合并、不重复触发下游）', () => {
  const text = skillBody();
  assert.match(text, /same \(runId, sha256\)|same runId \+ sha256|identical key/i, '缺同键忽略');
  assert.match(text, /updated version/, '缺"更新版"注记');
  assert.match(text, /one result, two views|two views of one result/i, '缺轮询与消息合并处理');
  assert.match(text, /act once|do not trigger downstream twice/, '缺不重复触发下游动作');
});

test('⑥ 规模建议 5/15/50 与补跑通道（新 run 聚焦失败子集，或脚本内建重试）', () => {
  const text = skillBody();
  assert.ok(text.includes('5/15/50'), '缺规模建议');
  assert.match(text, /new run|fresh run/, '缺"新 run 补跑"通道');
  assert.match(text, /in-script retry|retry built into the script/, '缺"脚本内建重试"通道');
  assert.match(text, /never (auto-)?rerun|never reruns on its own|永不自动重跑/, '缺"模块永不自动重跑"句');
});

// ── ⑥/⑦ partial 诚实与判定 ──

test('⑥ partial 诚实：以 partial 形态出现、判定归脚本与用户验收标准', () => {
  const text = skillBody();
  assert.match(text, /partial must (be reported )?as partial/, '缺 partial 形态句');
  assert.match(text, /acceptance criteria/, '缺用户验收标准裁决');
  assert.match(text, /deliver with the warning|带警告交付/, '缺默认带警告交付');
  assert.match(text, /only degradation is the user editing the script/, '缺"唯一降级 = 用户改脚本"');
});

test('⑥ issue 类产物逐条裁决：修 / 补 / 记账 [未确认]，未裁决不允许存在', () => {
  const text = skillBody();
  assert.match(text, /\[未确认\]/, '缺 [未确认] 记账态');
  assert.match(text, /修|fix it/, '缺"修"裁决项');
  assert.match(text, /补|add it|patch it/, '缺"补"裁决项');
  assert.match(text, /never (leave )?an unadjudicated|未裁决不允许存在/i, '缺"未裁决不允许存在"');
});

// ── ⑦ 汇总体模板与终态消息模板：按行核对 T6 锁定版 ──

test('⑦ 汇总体 objective 模板逐行原样发布（T6 锁定版，改一个字即红）', () => {
  // 哨兵取"不会与别的数字撞车"的值，渲染后把哨兵与由 runId 长度推导的预算数换回尖括号占位——
  // 锁的是措辞与行序，不被每次发布的动态数值牵着走。
  const SENTINEL = {
    runId: '__RID__',
    terminalPath: '__TERM__',
    indexPath: '__IDX__',
    digestPath: '__DIG__',
    rounds: 4111,
    waitChunkSec: 7333,
  };
  const rendered = REDUCER_OBJECTIVE_TEMPLATE(SENTINEL);
  const summaryBudget = String(reducerSummaryBudget(SENTINEL.runId));
  const toPlaceholder = (line) => line
    .split(SENTINEL.runId).join('<runId>')
    .split(SENTINEL.terminalPath).join('<terminal>')
    .split(SENTINEL.indexPath).join('<index>')
    .split(SENTINEL.digestPath).join('<digest>')
    .split(String(SENTINEL.rounds)).join('<rounds>')
    .split(String(SENTINEL.waitChunkSec)).join('<waitChunkSec>')
    .split(summaryBudget).join('<summaryBudget>');
  const text = skillBody();
  const lines = rendered.split('\n').map(toPlaceholder);
  assert.ok(lines.length >= 8, 'T6 模板行数异常');
  for (const line of lines) {
    assert.ok(text.includes(line), `objective 模板缺行：${line.slice(0, 72)}`);
  }
});

test('⑦ 终态消息模板锁定：首行 KV 语法 + 200 帽 + 三段上报模板', () => {
  const kv = buildKvFirstLine({ kind: 'settled-notice', runId: '<runId>', sha256: '<hex>' });
  const digestKv = buildKvFirstLine({ kind: 'digest', runId: '<runId>', sha256: '<hex>' });
  const text = skillBody();
  assert.ok(text.includes(kv), `技能缺 settled-notice 首行模板 ${kv}`);
  assert.ok(text.includes(digestKv), '技能缺 digest 首行模板');
  assert.ok(text.includes(String(MAX_NOTICE_CODE_UNITS)), '技能缺 200 码元帽');
  assert.ok(text.includes('<summaryBudget>'), '技能缺摘要正文预算（200 减 KV 首行后的余量）');
  for (const section of ['结论', '失败清单', '产物与索引']) {
    assert.ok(text.includes(section), `技能缺三段上报模板段名 ${section}`);
  }
});

// ── 摘要形状（ADR §20② 落地适配）──

test('摘要形状 = 模板级：schema 片段随技能发布物同处，字段照 T6 锁定版原样', () => {
  const text = skillBody();
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, '技能内没有 schema 片段（应随发布物同处）');
  assert.deepEqual(JSON.parse(match[1]), DIGEST_TEMPLATE);
  assert.match(text, /not a machine contract/, '缺"不作机器契约"声明');
  assert.match(text, /parse it programmatically.*index|一律回索引/i, '缺"程序化解析一律回索引"');
  assert.match(text, /never rewritten|永不改写/, '缺"旧 run digest 永不改写"');
});

// ── 作者参考必须与实现同源（防文案与引擎两张皮）──

test('作者参考的 agent() 选项表与运行时白名单同源（12 项一个不多一个不少）', () => {
  const text = skillBody();
  for (const opt of KNOWN_AGENT_OPTS) {
    assert.ok(new RegExp(`\\b${opt}\\b`).test(text), `作者参考缺 agent() 选项 ${opt}`);
  }
  assert.equal(KNOWN_AGENT_OPTS.length, 12, '运行时选项表变了——作者参考要同步（且要判是不是偏离）');
  // 未知键即拒是契约的一部分。
  assert.match(text, /unknown option|unknown key|未知键/i, '缺"未知键即拒"句');
});

test('作者参考的写必隔离与工具面随模式变，与设置节同源数值', () => {
  const text = skillBody();
  assert.match(text, /isolation:'worktree'|isolation: 'worktree'/, '缺写必隔离面');
  assert.match(text, /read-only by default|默认只读/i, '缺默认只读句');
  assert.match(text, /write_file|apply_patch/, '缺写工具名');
  // 闸门数值单源：设置登记表里的默认值必须在技能里说得到（抽查三档）。
  const defaults = Object.fromEntries(WORKFLOW_SETTING_KEYS.map((key) => [key.name, key.default]));
  assert.equal(defaults.tokenCap, 8_000_000);
  assert.equal(defaults.agentCap, 1000);
  assert.equal(defaults.runGateMinutes, 30);
});

test('作者参考缺非确定性禁令即红（Date / Math.random 双禁）', () => {
  const text = skillBody();
  assert.match(text, /Math\.random/, '缺 Math.random 禁令');
  assert.match(text, /Date/, '缺 Date 禁令');
  assert.match(text, /reject|拒/, '缺"启动前整体拒"');
});
