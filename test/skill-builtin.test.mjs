// 系统内建 skill 测试——BUILTIN_SKILLS fallback 机制
// 覆盖：listSkills 注入、loadSkill fallback、用户覆盖、用户删除后恢复

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { listSkills, loadSkill } from '../dist/skills.js';

// ── 测试辅助 ──

function tempDirs() {
  const root = join(tmpdir(), 'skill-builtin-' + randomBytes(4).toString('hex'));
  const configDir = join(root, 'config');
  const workspaceDir = join(root, 'workspace');
  mkdirSync(join(configDir, 'skills'), { recursive: true });
  mkdirSync(join(workspaceDir, '.myterminal', 'skills'), { recursive: true });
  return { root, configDir, workspaceDir };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function writeProjectSkill(workspaceDir, name, markdown) {
  const dir = join(workspaceDir, '.myterminal', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), markdown, 'utf8');
}

// ══════════════════════════════════════════════════════
// 用例 01：空目录时 listSkills 返回 adaptive-guard

test('01: listSkills 空目录时包含 adaptive-guard', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  try {
    const skills = listSkills(configDir, workspaceDir);
    const guard = skills.find((s) => s.name === 'adaptive-guard');
    assert.ok(guard, 'adaptive-guard should appear in skill list');
    assert.equal(guard.mode, 'inline');
    assert.ok(guard.description.length >= 10, 'description should be substantive');
    assert.ok(guard.when_to_use.length > 0, 'when_to_use should be present');
  } finally {
    cleanup(root);
  }
});

// ══════════════════════════════════════════════════════
// 用例 02：loadSkill 无用户文件时返回硬编码内容

test('02: loadSkill("adaptive-guard") 无用户文件时返回 built-in 内容', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  try {
    const record = loadSkill(configDir, workspaceDir, 'adaptive-guard');
    assert.ok(record, 'should return built-in record');
    assert.equal(record.name, 'adaptive-guard');
    assert.equal(record.mode, 'inline');
    assert.ok(record.content.includes('Recovery Decision Tree'), 'content should include recovery playbook');
    assert.ok(record.content.includes('Rate Limit'), 'content should cover rate limit category');
    assert.ok(record.content.includes('Context Overflow'), 'content should cover context overflow category');
  } finally {
    cleanup(root);
  }
});

// ══════════════════════════════════════════════════════
// 用例 03：用户同名文件覆盖 built-in

test('03: 用户同名 skill 覆盖 built-in', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  try {
    writeProjectSkill(workspaceDir, 'adaptive-guard', `---
name: adaptive-guard
description: User override of adaptive-guard skill.
when_to_use: Custom override.
mode: inline
---
# Custom Guard
This is user override content.
`);
    const record = loadSkill(configDir, workspaceDir, 'adaptive-guard');
    assert.ok(record, 'should return record');
    assert.equal(record.name, 'adaptive-guard');
    assert.ok(record.content.includes('Custom Guard'), 'should return user content, not built-in');
    assert.ok(!record.content.includes('Recovery Decision Tree'), 'should NOT contain built-in content');

    // listSkills 也应返回用户版本
    const skills = listSkills(configDir, workspaceDir);
    const guard = skills.find((s) => s.name === 'adaptive-guard');
    assert.ok(guard, 'adaptive-guard should still appear');
    assert.equal(guard.description, 'User override of adaptive-guard skill.');
  } finally {
    cleanup(root);
  }
});

// ══════════════════════════════════════════════════════
// 用例 04：用户删除文件后 fallback 到 built-in

test('04: 用户 skill 不存在时 fallback 到 built-in', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  try {
    // 先确认 built-in 可用
    const record = loadSkill(configDir, workspaceDir, 'adaptive-guard');
    assert.ok(record, 'built-in should be available');
    assert.equal(record.name, 'adaptive-guard');
    assert.ok(record.content.includes('Recovery Decision Tree'));
  } finally {
    cleanup(root);
  }
});

// ══════════════════════════════════════════════════════
// 用例 05：不存在的 skill 名仍返回 null

test('05: 不存在的 skill 名返回 null（不影响其他 skill）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  try {
    const record = loadSkill(configDir, workspaceDir, 'nonexistent-skill');
    assert.equal(record, null, 'non-existent skill should return null');
  } finally {
    cleanup(root);
  }
});
