// Subagent system prompt 重写 — TDD 红绿循环
// seam: 导出的 getSubagentSystemPrompt（src/subagent/executor.ts）
// 目的：校验重写后的提示词覆盖 P0 安全边界 + P1 执行纪律 + claude subagent 精华，
//       不改动任何运行时行为。断言句子均取自草稿 spec（独立来源），非代码重新计算。
// 运行前必须 build：bun run build && bun test test/subagent-system-prompt.test.mjs

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { getSubagentSystemPrompt } from '../dist/subagent/executor.js';

const TASK = 'Refactor the auth module';
const TOOLS = ['read_file', 'write_file', 'edit_file', 'execute_cli', 'glob', 'grep', 'task_create', 'task_update'];
const CWD = '/workspace/proj';

function build() {
  return getSubagentSystemPrompt(TASK, TOOLS, CWD);
}

test('identity + completion mandate', () => {
  const p = build();
  assert.match(p, /stateless local executor/);
  assert.match(p, /don't gold-plate, but don't leave it half-done/);
  assert.match(p, /The caller relays your report to the user/);
});

test('P0 operating boundaries (cwd lock + no destructive cmds + read-only)', () => {
  const p = build();
  assert.match(p, /# Operating boundaries/);
  assert.match(p, /Work only inside the working directory/);
  assert.match(p, /Never run destructive or irreversible commands/);
  assert.match(p, /read-only mode/);
});

test('P1 doing-tasks discipline (scope / verify before done)', () => {
  const p = build();
  assert.match(p, /# Doing tasks/);
  assert.match(p, /Solve exactly what was asked/);
  assert.match(p, /Verify your work before declaring done/);
});

test('tool usage + absolute paths', () => {
  const p = build();
  assert.match(p, /# Using your tools/);
  assert.match(p, /Use absolute paths for all file operations/);
  assert.match(p, /Prefer dedicated tools over raw shell/);
});

test('reporting honesty + lean (no fabrication / no emojis)', () => {
  const p = build();
  assert.match(p, /# Reporting/);
  assert.match(p, /never fabricate results or claim success falsely/);
  assert.match(p, /no emojis/);
});

test('environment section reflects dynamic inputs', () => {
  const p = build();
  assert.match(p, /# Environment/);
  assert.match(p, new RegExp(`Working directory: ${CWD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(p, /Platform:/);
  assert.match(p, /Tools available:/);
  for (const t of TOOLS) assert.match(p, new RegExp(`- ${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('legacy two-line # Rules block is gone (replaced by sectioned prompt)', () => {
  const p = build();
  // 旧版只有两条散装 Rules；新版应无孤立的 "# Rules" 段标题
  assert.doesNotMatch(p, /# Rules/);
});
