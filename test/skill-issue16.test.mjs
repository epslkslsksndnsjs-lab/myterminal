// Issue #16（ADR-0031 / G9）：项目级 skill 静默失效修复
// 根因：src/skills.ts 的 scanDir 只认子目录里的 SKILL.md，
//       (1) 平铺 .md 文件（<name>.md）被 isDirectory() 过滤静默丢弃；
//       (2) 子目录缺 SKILL.md 被 existsSync 静默跳过；两者均无告警。
// 决策块唯一依据：scanDir 对不符合结构的条目输出**告警日志**（禁止静默）+ 兼容目录式与平铺 .md 两种布局。
// 验收：两种布局均加载 + 坏结构有告警。
//
// 红灯（修复前应失败）：
//   A/B 平铺布局被 listSkills/loadSkill 发现 —— 当前 scanDir 不读根目录 .md，故失败
//   C   子目录缺 SKILL.md —— 当前无告警，故失败
//   D   平铺 .md 缺 frontmatter —— 当前连文件都不读，零告警，故失败
// 绿灯（修复后应全绿）：
//   E   目录式布局仍正常（回归保护）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { listSkills, loadSkill } from '../dist/skills.js';

// ── 测试辅助 ──

function tempDirs() {
  const root = join(tmpdir(), 'skill-issue16-' + randomBytes(4).toString('hex'));
  const configDir = join(root, 'config');
  const workspaceDir = join(root, 'workspace');
  mkdirSync(join(configDir, 'skills'), { recursive: true });
  mkdirSync(join(workspaceDir, '.myterminal', 'skills'), { recursive: true });
  return { root, configDir, workspaceDir };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

/** 目录式布局：<skillsDir>/<name>/SKILL.md */
function writeDirSkill(baseSkillsDir, name, markdown) {
  const dir = join(baseSkillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), markdown, 'utf8');
}

/** 平铺布局：<skillsDir>/<name>.md */
function writeFlatSkill(baseSkillsDir, fileName, markdown) {
  writeFileSync(join(baseSkillsDir, fileName), markdown, 'utf8');
}

const projectSkills = (workspaceDir) => join(workspaceDir, '.myterminal', 'skills');
const globalSkills = (configDir) => join(configDir, 'skills');

const VALID_HEADER = (name, extra = '') => `---
name: ${name}
description: A valid test skill for issue #16.
when_to_use: Use in tests.
${extra}---
`;

/** 捕获 console.warn 调用，返回拼接后的消息数组 */
function captureWarns(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return warns;
}

// ══════════════════════════════════════════════════════
// 红灯 A：平铺 .md 布局应被 listSkills 发现
// ══════════════════════════════════════════════════════

test('A: 平铺 .md 布局被 listSkills 发现（第二种布局）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeFlatSkill(projectSkills(workspaceDir), 'code-review.md', VALID_HEADER('code-review') + '\nReview the code.\n');
  const skills = listSkills(configDir, workspaceDir);
  assert.ok(
    skills.some((s) => s.name === 'code-review'),
    'flat <name>.md skill must appear in listSkills output',
  );
  cleanup(root);
});

// ══════════════════════════════════════════════════════
// 红灯 B：平铺 .md 布局应被 loadSkill 加载
// ══════════════════════════════════════════════════════

test('B: 平铺 .md skill 可被 loadSkill 加载（含 content）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeFlatSkill(projectSkills(workspaceDir), 'code-review.md', VALID_HEADER('code-review') + '\nReview the code.\n');
  const record = loadSkill(configDir, workspaceDir, 'code-review');
  assert.ok(record, 'flat skill must load via loadSkill');
  assert.equal(record.name, 'code-review');
  assert.match(record.content, /Review the code/);
  cleanup(root);
});

// ══════════════════════════════════════════════════════
// 红灯 C：子目录缺 SKILL.md → 必须告警（非静默）
// ══════════════════════════════════════════════════════

test('C: skills 子目录缺 SKILL.md → console.warn 告警且跳过', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  // 建一个子目录但不放 SKILL.md
  mkdirSync(join(projectSkills(workspaceDir), 'broken-dir'), { recursive: true });
  const warns = captureWarns(() => listSkills(configDir, workspaceDir));
  assert.ok(
    warns.some((m) => /broken-dir/.test(m) && /SKILL\.md/.test(m)),
    `missing SKILL.md must trigger a warning naming the dir; got: ${JSON.stringify(warns)}`,
  );
  cleanup(root);
});

// ══════════════════════════════════════════════════════
// 红灯 D：平铺 .md 缺 frontmatter → 必须告警（非静默）
// ══════════════════════════════════════════════════════

test('D: 平铺 .md 缺 frontmatter → console.warn 告警且不被列出', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeFlatSkill(projectSkills(workspaceDir), 'claw-p0.md', '# 标题\n\n没有 frontmatter 的内容\n');
  let skills;
  const warns = captureWarns(() => {
    skills = listSkills(configDir, workspaceDir);
  });
  assert.ok(!skills.some((s) => s.name === 'claw-p0'), 'malformed flat skill must not be listed');
  assert.ok(warns.length > 0, `a malformed flat .md file must trigger at least one warning; got none`);
  assert.ok(
    warns.some((m) => /claw-p0\.md/.test(m)),
    `warning must name the offending file; got: ${JSON.stringify(warns)}`,
  );
  cleanup(root);
});

// ══════════════════════════════════════════════════════
// 绿灯 E（回归）：目录式布局仍正常
// ══════════════════════════════════════════════════════

test('E: 目录式 <name>/SKILL.md 布局仍被发现（回归保护）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeDirSkill(projectSkills(workspaceDir), 'dir-skill', VALID_HEADER('dir-skill') + '\nDir based.\n');
  const skills = listSkills(configDir, workspaceDir);
  assert.ok(skills.some((s) => s.name === 'dir-skill'), 'directory-style layout must still be discovered');
  const record = loadSkill(configDir, workspaceDir, 'dir-skill');
  assert.ok(record);
  assert.equal(record.name, 'dir-skill');
  cleanup(root);
});
