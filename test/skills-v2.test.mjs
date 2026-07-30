// ADR-0010 skill v2 数据层测试——skills.ts mode/forkOptions 解析与校验
// 覆盖决策：2（frontmatter 声明 mode）、5（list 带 mode）、6（forkOptions）、11（校验）
// 目标：src/skills.ts 行覆盖率 ≥ 90%；变异体 7/7 被杀死
//
// 变异体清单：
//   M1 mode 缺省值被改成 'fork'        → 用例 02 杀
//   M2 maxTurns 上限 200 改成 201      → 用例 07 杀
//   M3 provider 白名单校验被删         → 用例 06 杀
//   M4 数字字符串 coerce 被删          → 用例 05 杀（'30' 不再是 number 30）
//   M5 全局覆盖项目级优先级反转        → 用例 12 杀
//   M6 readOnly 'true' 解析反转        → 用例 05 杀
//   M7 fork 空 content 从警告变阻止    → 用例 10 杀

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { listSkills, loadSkill } from '../dist/skills.js';

// ── 测试辅助 ──

function tempDirs() {
  const root = join(tmpdir(), 'skills-v2-' + randomBytes(4).toString('hex'));
  const configDir = join(root, 'config');       // 全局 skills 在 <configDir>/skills/<name>/SKILL.md
  const workspaceDir = join(root, 'workspace'); // 项目级在 <workspaceDir>/.myterminal/skills/<name>/SKILL.md
  mkdirSync(join(configDir, 'skills'), { recursive: true });
  mkdirSync(join(workspaceDir, '.myterminal', 'skills'), { recursive: true });
  return { root, configDir, workspaceDir };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

/** 写一个项目级 skill */
function writeProjectSkill(workspaceDir, name, markdown) {
  const dir = join(workspaceDir, '.myterminal', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), markdown, 'utf8');
}

/** 写一个全局 skill */
function writeGlobalSkill(configDir, name, markdown) {
  const dir = join(configDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), markdown, 'utf8');
}

const VALID_HEADER = (name, extra = '') => `---
name: ${name}
description: A valid test skill for ADR-0010.
when_to_use: Use in tests.
${extra}---
`;

// ══════════════════════════════════════════════════════
// 用例 01-03：mode 解析（决策 2/11）
// ══════════════════════════════════════════════════════

test('01: 缺省 mode 为 inline', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'demo-skill', VALID_HEADER('demo-skill') + '\nDo the thing.\n');
  const record = loadSkill(configDir, workspaceDir, 'demo-skill');
  assert.ok(record);
  assert.equal(record.mode, 'inline');
  assert.equal(record.forkOptions, undefined);
  cleanup(root);
});

test('02: mode: fork 正确解析', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'fork-skill', VALID_HEADER('fork-skill', 'mode: fork\n') + '\nStep 1.\n');
  const record = loadSkill(configDir, workspaceDir, 'fork-skill');
  assert.ok(record);
  assert.equal(record.mode, 'fork');
  cleanup(root);
});

test('03: 非法 mode 值 → loadSkill 返回 null', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'bad-mode', VALID_HEADER('bad-mode', 'mode: remote\n') + '\nX.\n');
  const record = loadSkill(configDir, workspaceDir, 'bad-mode');
  assert.equal(record, null);
  cleanup(root);
});

// ══════════════════════════════════════════════════════
// 用例 04-09：forkOptions 解析与校验（决策 6/11）
// ══════════════════════════════════════════════════════

test('04: forkOptions 全字段正确解析', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  const fm = `mode: fork
forkOptions:
  provider: deepseek
  model: deepseek-chat
  maxTurns: 30
  timeoutSec: 600
  readOnly: true
  deliverables: [code, tests]
  acceptanceCriteria: [green]
  constraints: [no-network]
`;
  writeProjectSkill(workspaceDir, 'full-opts', VALID_HEADER('full-opts', fm) + '\nWork.\n');
  const record = loadSkill(configDir, workspaceDir, 'full-opts');
  assert.ok(record);
  assert.equal(record.mode, 'fork');
  assert.deepEqual(record.forkOptions, {
    provider: 'deepseek',
    model: 'deepseek-chat',
    maxTurns: 30,
    timeoutSec: 600,
    readOnly: true,
    deliverables: ['code', 'tests'],
    acceptanceCriteria: ['green'],
    constraints: ['no-network'],
  });
  // 类型必须被 coerce：maxTurns/timeoutSec 是 number，不是字符串
  assert.equal(typeof record.forkOptions.maxTurns, 'number');
  assert.equal(typeof record.forkOptions.timeoutSec, 'number');
  assert.equal(typeof record.forkOptions.readOnly, 'boolean');
  cleanup(root);
});

test('05: 字符串数字 coerce + readOnly 解析（杀 M4/M6）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  const fm = `mode: fork
forkOptions:
  maxTurns: "30"
  readOnly: "true"
`;
  writeProjectSkill(workspaceDir, 'coerce-opts', VALID_HEADER('coerce-opts', fm) + '\nWork.\n');
  const record = loadSkill(configDir, workspaceDir, 'coerce-opts');
  assert.ok(record);
  assert.equal(record.forkOptions.maxTurns, 30);
  assert.equal(record.forkOptions.readOnly, true);
  cleanup(root);
});

test('06: forkOptions.provider 非法 → null（杀 M3）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  const fm = `mode: fork
forkOptions:
  provider: moonshot
`;
  writeProjectSkill(workspaceDir, 'bad-provider', VALID_HEADER('bad-provider', fm) + '\nWork.\n');
  assert.equal(loadSkill(configDir, workspaceDir, 'bad-provider'), null);
  cleanup(root);
});

test('06b: forkOptions.provider qwen 合法 → 正常解析（#61 红灯）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  const fm = `mode: fork
forkOptions:
  provider: qwen
`;
  writeProjectSkill(workspaceDir, 'qwen-fork', VALID_HEADER('qwen-fork', fm) + '\nWork.\n');
  const record = loadSkill(configDir, workspaceDir, 'qwen-fork');
  assert.ok(record, 'provider: qwen must be accepted by the skills fork path');
  assert.equal(record.forkOptions.provider, 'qwen');
  cleanup(root);
});

test('06c: FORK_PROVIDERS 派生自 types.ts 单源——联合类型全员被 fork 路径接受（#61 防漂移）', async () => {
  // G6：期望值来自独立真相源 types.ts（SUBAGENT_PROVIDERS），而非 skills.ts 自身
  const { SUBAGENT_PROVIDERS } = await import('../dist/types.js');
  assert.ok(Array.isArray(SUBAGENT_PROVIDERS) && SUBAGENT_PROVIDERS.length >= 5, 'types.ts 必须导出运行时单源 SUBAGENT_PROVIDERS');
  const { root, configDir, workspaceDir } = tempDirs();
  for (const provider of SUBAGENT_PROVIDERS) {
    const name = `sp-${provider}`;
    const fm = `mode: fork\nforkOptions:\n  provider: ${provider}\n`;
    writeProjectSkill(workspaceDir, name, VALID_HEADER(name, fm) + '\nWork.\n');
    const record = loadSkill(configDir, workspaceDir, name);
    assert.ok(record, `provider=${provider} 必须被 fork 路径接受（新增 provider 只改 types.ts 一处）`);
    assert.equal(record.forkOptions.provider, provider);
  }
  cleanup(root);
});

test('07: maxTurns 越界 0 和 201 → null（杀 M2）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  for (const [name, turns] of [['turns-low', 0], ['turns-high', 201]]) {
    const fm = `mode: fork\nforkOptions:\n  maxTurns: ${turns}\n`;
    writeProjectSkill(workspaceDir, name, VALID_HEADER(name, fm) + '\nWork.\n');
    assert.equal(loadSkill(configDir, workspaceDir, name), null, `maxTurns=${turns} should be rejected`);
  }
  // 边界值合法
  for (const [name, turns] of [['turns-min', 1], ['turns-max', 200]]) {
    const fm = `mode: fork\nforkOptions:\n  maxTurns: ${turns}\n`;
    writeProjectSkill(workspaceDir, name, VALID_HEADER(name, fm) + '\nWork.\n');
    assert.ok(loadSkill(configDir, workspaceDir, name), `maxTurns=${turns} should be accepted`);
  }
  cleanup(root);
});

test('08: timeoutSec 越界 29 和 3601 → null；30/3600 合法', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  for (const [name, sec, ok] of [['sec-low', 29, false], ['sec-high', 3601, false], ['sec-min', 30, true], ['sec-max', 3600, true]]) {
    const fm = `mode: fork\nforkOptions:\n  timeoutSec: ${sec}\n`;
    writeProjectSkill(workspaceDir, name, VALID_HEADER(name, fm) + '\nWork.\n');
    assert.equal(loadSkill(configDir, workspaceDir, name) !== null, ok, `timeoutSec=${sec}`);
  }
  cleanup(root);
});

test('09: forkOptions 非嵌套对象 → null', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'flat-opts', VALID_HEADER('flat-opts', 'mode: fork\nforkOptions: yes\n') + '\nWork.\n');
  assert.equal(loadSkill(configDir, workspaceDir, 'flat-opts'), null);
  cleanup(root);
});

// ══════════════════════════════════════════════════════
// 用例 10-12：决策 11 警告 / list 带 mode / 全局优先
// ══════════════════════════════════════════════════════

test('10: mode: fork 但 content 为空 → 仍加载成功（只警告，杀 M7）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'empty-fork', VALID_HEADER('empty-fork', 'mode: fork\n'));
  const record = loadSkill(configDir, workspaceDir, 'empty-fork');
  assert.ok(record, 'fork with empty content must still load (warning only)');
  assert.equal(record.mode, 'fork');
  cleanup(root);
});

test('11: listSkills 返回带 mode 字段（决策 5）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'inline-one', VALID_HEADER('inline-one') + '\nA.\n');
  writeProjectSkill(workspaceDir, 'fork-one', VALID_HEADER('fork-one', 'mode: fork\n') + '\nB.\n');
  const skills = listSkills(configDir, workspaceDir);
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.equal(byName['inline-one'].mode, 'inline');
  assert.equal(byName['fork-one'].mode, 'fork');
  cleanup(root);
});

test('12: 同名 skill 全局覆盖项目级，mode 也来自全局（杀 M5）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'dup-skill', VALID_HEADER('dup-skill') + '\nProject version.\n');
  writeGlobalSkill(configDir, 'dup-skill', VALID_HEADER('dup-skill', 'mode: fork\n') + '\nGlobal version.\n');
  const record = loadSkill(configDir, workspaceDir, 'dup-skill');
  assert.ok(record);
  assert.equal(record.mode, 'fork');
  assert.match(record.content, /Global version/);
  const listed = listSkills(configDir, workspaceDir).find((s) => s.name === 'dup-skill');
  assert.equal(listed.mode, 'fork');
  cleanup(root);
});

// ══════════════════════════════════════════════════════
// 用例 13-14：回归——原有行为不破坏
// ══════════════════════════════════════════════════════

test('13: 无 frontmatter 的文件 → null（原有校验不变）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'no-front', 'Just markdown, no frontmatter.\n');
  assert.equal(loadSkill(configDir, workspaceDir, 'no-front'), null);
  cleanup(root);
});

test('14: 不存在的 skill → null', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  assert.equal(loadSkill(configDir, workspaceDir, 'ghost-skill'), null);
  cleanup(root);
});
