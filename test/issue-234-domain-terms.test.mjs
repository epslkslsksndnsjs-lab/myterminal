// #234（T11 文案三面与技能）——域文档面：CONTEXT.md 术语边界 + README 措辞债
//
// ADR-0052 Consequences 末条：README.md:7 现称 Skill 即 "reusable agent **workflows**"，
// 与新模块撞名——CONTEXT.md（待建）必须一次性钉死 Workflow / Workflow Agent / Reducer / Run
// 与 Session / Subagent / Skill 的边界。本文件把这两件事一起锁住：
//   ① 术语表六个概念齐备，且每条给出"边界"与"不作同义词"的指向；
//   ② 撞名句在双版 README 中确实移除，Workflows 能力在双版各有一句；
//   ③ 技能名 workflow-authoring 是 #234 / #235 共享常量，域文档不得另起别名。
//
// 术语表是被 /domain-modeling 与后继 agent 当词汇表用的，不是散文——所以断言按"条目 + 划界句"来。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const CONTEXT = read('CONTEXT.md');
const README_EN = read('README.md');
const README_ZH = read('README.zh-CN.md');

// ── ① 六个概念的边界 ──

const TERMS = ['Workflow', 'Workflow Agent', 'Reducer', 'Run', 'Session', 'Subagent', 'Skill'];

test('① CONTEXT.md 存在且六个撞名概念逐条立目', () => {
  assert.ok(fs.existsSync(path.join(root, 'CONTEXT.md')), '仓库根缺 CONTEXT.md（ADR-0052 Consequences 末条要求本票新建）');
  for (const term of TERMS) {
    assert.ok(new RegExp(`^### ${term.replace(/[.*+?^$\{\}()\[\]|\\\\]/g, '\\$&')}\\b`, 'm').test(CONTEXT), `CONTEXT.md 未给 ${term} 立目`);
  }
});

test('① 每条术语都带划界句：是什么 / 不是什么 / 不作同义词', () => {
  const blocks = CONTEXT.split('\n### ').slice(1);
  assert.ok(blocks.length >= TERMS.length, '立目数少于术语数');
  for (const term of TERMS) {
    const block = blocks.find((entry) => entry.startsWith(term));
    assert.ok(block, `${term} 块缺失`);
    assert.match(block, /—|不是|is not|not to be confused/, `${term} 缺"不是什么"`);
    assert.match(block, /同义词|synonym/i, `${term} 缺"不作同义词"指向`);
  }
});

test('① 撞名根因写死：Skill 不是 Workflow，Subagent 不是 Workflow Agent，Run 不是 Session', () => {
  assert.match(CONTEXT, /Skill[^.\n]*不是[^.\n]*Workflow|Skill[^.\n]*is not[^.\n]*workflow/i, '缺 Skill ≠ Workflow 划界');
  assert.match(CONTEXT, /Subagent[^.\n]*(不是|is not)[^.\n]*Workflow Agent/i, '缺 Subagent ≠ Workflow Agent 划界');
  assert.match(CONTEXT, /Run[^.\n]*(不是|is not)[^.\n]*Session/i, '缺 Run ≠ Session 划界');
  assert.match(CONTEXT, /Reducer[^.\n]*(是|is)[^.\n]*subagent/i, '缺"Reducer 就是一个现有 subagent"');
});

test('① 术语表自带中文口径（汇总体 / 一次运行 / 会话），与模型可见文本同源', () => {
  for (const zh of ['汇总体', '工作流', '技能', '会话']) {
    assert.ok(CONTEXT.includes(zh), `CONTEXT.md 缺中文口径 ${zh}`);
  }
  assert.ok(CONTEXT.includes('workflow-authoring'), 'CONTEXT.md 未点名随模块发布的技能');
});

// ── ② README 措辞债 ──

test('② 双版 README 不再把 Skill 说成 "workflows / 工作流"（撞名句已修）', () => {
  assert.ok(!/reusable agent workflows/i.test(README_EN), '英文 README 仍称 Skill 为 reusable agent workflows');
  assert.ok(!/可复用智能体工作流/.test(README_ZH), '中文 README 仍称 Skill 为可复用智能体工作流');
  for (const [name, text] of [['README.md', README_EN], ['README.zh-CN.md', README_ZH]]) {
    const skillSentence = text.split('\n').find((line) => /\*\*Skill\*\*|\*\*技能\*\*/.test(line)) ?? '';
    assert.ok(skillSentence.length > 0, `${name} 找不到 Skill 那句`);
    assert.ok(!/workflow|工作流/i.test(skillSentence.replace(/\*\*Workflows?\*\*/g, '')), `${name} 的 Skill 句仍与 workflow 混称`);
  }
});

test('② Workflows 能力在双版 README 各有一句，且与既有双语锁不冲突', () => {
  assert.match(README_EN, /\*\*Workflows\*\*/);
  assert.match(README_ZH, /\*\*Workflows\*\*/);
  // 既有 docs.test.mjs 依赖的三句原样在位（本票只动措辞，不动这些）。
  assert.match(README_EN, /normal chat mode a controlled way to work on your local computer/);
  assert.match(README_ZH, /普通 Chat 对话模式也能以可控方式在本地电脑上工作/);
});

test('③ 技能名单源：内建注册与发布件同词（#235 的 MCP 文案逐字引用该名）', () => {
  assert.match(read('src/skills.ts'), /name:\s*['"]workflow-authoring['"]/);
  assert.match(read('skills', 'workflow-authoring', 'SKILL.md'), /^name: workflow-authoring$/m);
});
