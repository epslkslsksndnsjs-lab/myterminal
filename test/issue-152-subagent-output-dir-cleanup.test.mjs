// Issue #152（ADR-0048 D8 中）— subagent 输出目录清理接线
//
// session-resource-manager 登记 'subagent-outputs' agent 资源：agent 终结（disposeAgent）时
// 删除 <cwd>/.myterminal/subagent-outputs/<agentId>（D8 只写不删的磁盘泄漏收口）。
// 收尸顺序：agent-shell-tasks（① 进程组杀，含转后台）先于本资源（④）——删目录无活进程写窗口。
// 闸门（AC2）：record 在世（running）不删；record 已被清（1h 兜底/#143 收口）仍删孤儿目录。
// 切片：
//   S1 终结清理（终态 agent 目录被删 + 登记清除）
//   S2 在世不误删（running → 目录保留，登记保留）
//   S3 无 record 孤儿目录（record 已清 → 目录仍删，收尸兜底）
//   S4 多 agent 隔离（B 终态删、A 在世留，互不误伤）
//   S5 幂等（目录从未创建 → 不抛错，登记清除）

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sessionResourceManager } from '../dist/session-resource-manager.js';
import { defaultContext } from '../dist/subagent/context.js';
import { clearAllOutputDirs, getAgentOutputDir } from '../dist/subagent/output-dir.js';
import { clearAllSubagents, createSubagent, updateSubagentStatus } from '../dist/subagent/store.js';

// 造一个带内容的 agent 输出目录并登记（S4 多 agent 共用 root 时显式传入）
function makeOutputDir(agentId, root = mkdtempSync(join(tmpdir(), 'issue152-'))) {
  const dir = getAgentOutputDir(root, agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bg.output'), 'partial output');
  defaultContext.outputDirs.set(agentId, dir);
  return { root, dir };
}

function resetState() {
  clearAllSubagents();
  clearAllOutputDirs();
}

// ── S1：终结清理 ──
test('152-s1: 终态 agent 的 subagent-outputs/<agentId> 目录在 disposeAgent 时被删除', () => {
  resetState();
  const { root, dir } = makeOutputDir('sa-a');
  createSubagent('sa-a', { subject: 'slice task' });
  updateSubagentStatus('sa-a', 'completed', { result: 'done.' });
  try {
    sessionResourceManager.disposeAgent('sa-a');
    assert.equal(existsSync(dir), false, '终态 agent 输出目录应被收口删除');
    assert.equal(defaultContext.outputDirs.has('sa-a'), false, '目录登记应同步清除');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── S2：在世不误删（AC2）──
test('152-s2: running 在世 agent 目录不被误删（AC2）', () => {
  resetState();
  const { root, dir } = makeOutputDir('sa-run');
  createSubagent('sa-run', { subject: 'still running' }); // 缺省 status=running
  try {
    sessionResourceManager.disposeAgent('sa-run');
    assert.equal(existsSync(dir), true, 'running agent 目录必须保留');
    assert.equal(defaultContext.outputDirs.has('sa-run'), true, '登记必须保留（收尸时再删）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── S3：无 record 孤儿目录 ──
test('152-s3: record 已被清（1h 兜底/#143 收口）的孤儿目录仍被收尸删除', () => {
  resetState();
  const { root, dir } = makeOutputDir('sa-ghost');
  try {
    sessionResourceManager.disposeAgent('sa-ghost');
    assert.equal(existsSync(dir), false, '孤儿输出目录应被删除');
    assert.equal(defaultContext.outputDirs.has('sa-ghost'), false, '登记应同步清除');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── S4：多 agent 隔离 ──
test('152-s4: 多 agent 共存只删终结者目录，在世 agent 目录不误伤', () => {
  resetState();
  const { root, dir: dirLive } = makeOutputDir('sa-live');
  createSubagent('sa-live', { subject: 'living' });
  const { dir: dirDead } = makeOutputDir('sa-dead', root);
  createSubagent('sa-dead', { subject: 'dying' });
  updateSubagentStatus('sa-dead', 'failed', { error: 'boom' });
  try {
    sessionResourceManager.disposeAgent('sa-dead');
    assert.equal(existsSync(dirDead), false, '终结 agent 目录应删除');
    assert.equal(existsSync(dirLive), true, '在世 agent 目录不得误伤');
    assert.equal(defaultContext.outputDirs.has('sa-live'), true, '在世登记不得误清');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── S5：幂等（目录从未创建）──
test('152-s5: 目录从未创建（无转后台输出）时 disposeAgent 幂等不抛', () => {
  resetState();
  const root = mkdtempSync(join(tmpdir(), 'issue152-'));
  const dir = getAgentOutputDir(root, 'sa-quiet');
  defaultContext.outputDirs.set('sa-quiet', dir);
  createSubagent('sa-quiet', { subject: 'no bg output' });
  updateSubagentStatus('sa-quiet', 'completed', { result: 'clean.' });
  try {
    sessionResourceManager.disposeAgent('sa-quiet'); // 不应抛错
    assert.equal(existsSync(dir), false);
    assert.equal(defaultContext.outputDirs.has('sa-quiet'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
