// Issue #157（ADR-0048 D8 低）— R6 .gitignore 机制 + A1 闸门审计痕迹
//
// R6：tools.ts:337 注释声称输出目录「.gitignore 不跟踪」，但全仓无任何代码维护 .gitignore
//     → 补机制：转后台落盘时在 <cwd>/.myterminal/subagent-outputs/.gitignore 写自忽略
//     `*`（含自身）→ 用户仓库 git status 零噪声；flag wx 幂等不覆盖用户编辑。
// A1：闸门 CHILD_RESULT_UNREVIEWED 抛出前不落 history → 抛错前镜像 CHILD_REVIEW_REQUIRED
//     同机制写 checkpoint + completion_blocked + save()，拦截事件进审计链。
//
// 测试方式：切片 1 直调 MyTerminalStore（136-s6 手法）；切片 2 直调 getTool('execute_cli').call（134 手法）。
// 注：任何 src 改动后必须先 bun run build 再跑测试（#43）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { MyTerminalStore } from '../dist/store.js';
import { clearAllSubagents, createSubagent, markResultFetched } from '../dist/subagent/store.js';
import { getTool } from '../dist/subagent/tools.js';
import { clearAllShellTasks } from '../dist/subagent/shell-tracker.js';

let TMP;

afterEach(() => {
  clearAllShellTasks();
  clearAllSubagents();
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  TMP = undefined;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

function tempDir() {
  const dir = path.join(os.tmpdir(), 'issue-157-' + randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTask(objective) {
  return { objective, background: 'slice background', deliverables: ['slice done'], acceptanceCriteria: ['verified'], constraints: ['local only'] };
}

function makeCtx(overrides = {}) {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue157-'));
  return {
    cwd: TMP,
    signal: new AbortController().signal,
    agentId: 'test-agent-157',
    ...overrides,
  };
}

function outputPathFor(ctx, backgroundId) {
  return path.join(ctx.outputDir ?? path.join(ctx.cwd, '.myterminal', 'subagent-outputs', ctx.agentId), `${backgroundId}.output`);
}

// ══════════════════════════════════════════════════════
// 切片 1：A1 闸门拦截事件落审计链
// ══════════════════════════════════════════════════════

test('157-a1: 未验收子结果收工被拦时落审计痕迹（checkpoint+completion_blocked+phase 回 working）', () => {
  const dir = tempDir();
  const store = new MyTerminalStore(path.join(dir, 'state'));
  const root = store.registerRoot({ name: 'root', role: 'lead' });
  const childInfo = store.registerDelegate(root.session.id, { name: 'worker', task: makeTask('delegated slice') });
  const childId = childInfo.session.id;

  // 子会话先收工（终态）；child 完成事件发给 root，须 ack 才能过旧闸门
  store.checkpoint(childId, { phase: 'completed', summary: 'child done.' });
  const childEvents = store.snapshot().events.filter((e) => e.recipientSessionId === root.session.id && e.sourceSessionId === childId);
  if (childEvents.length) store.acknowledgeEvents(root.session.id, childEvents.map((e) => e.id));
  // subagent record 进终态但父从未调 status → 未验收
  clearAllSubagents();
  const rec = createSubagent('task-gate', { subject: 'delegated work' });
  rec.status = 'completed';
  rec.result = 'child result payload';
  rec.completedAt = Date.now();
  rec.sessionId = childId;

  // 收工 → 拦
  assert.throws(
    () => store.checkpoint(root.session.id, { phase: 'completed', summary: 'wrap up' }),
    (err) => {
      assert.equal(err.code, 'CHILD_RESULT_UNREVIEWED');
      assert.equal(err.message, '先查子结果再收工');
      return true;
    },
  );

  // A1：抛错前审计痕迹已落
  const after = store.session(root.session.id);
  assert.equal(after.phase, 'working', '拦截后 phase 回 working');
  assert.ok(after.latestCheckpoint, 'latestCheckpoint 已置位');
  assert.deepEqual(after.latestCheckpoint.tags, ['child-result-unreviewed']);
  assert.match(after.latestCheckpoint.summary, /unretrieved/, 'checkpoint summary 标注未取结果');

  const historyFile = path.join(dir, 'state', 'history', `${root.session.id}.jsonl`);
  assert.ok(fs.existsSync(historyFile), 'history 文件已写');
  const entries = fs.readFileSync(historyFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  const types = entries.map((e) => e.type);
  assert.ok(types.includes('checkpoint'), 'history 落 checkpoint');
  assert.ok(types.includes('completion_blocked'), 'history 落 completion_blocked');
  const blocked = entries.find((e) => e.type === 'completion_blocked');
  assert.equal(blocked.data.children.length, 1);
  assert.equal(blocked.data.children[0].sessionId, childId);
  assert.equal(blocked.data.children[0].requiresReview, true);

  // 闸门语义不回归：父取过终态 result → 放行
  markResultFetched('task-gate');
  const done = store.checkpoint(root.session.id, { phase: 'completed', summary: 'wrap up' });
  assert.equal(done.phase, 'completed');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════
// 切片 2：R6 输出层自忽略 .gitignore 机制
// ══════════════════════════════════════════════════════

test('157-r6: 转后台落盘维护输出层自忽略 .gitignore（含 *，幂等不覆盖用户编辑）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');

  const result = await tool.call({ command: 'echo r6', run_in_background: true }, ctx);
  assert.ok(result.backgroundId, '返回体应含 backgroundId');

  const gitignorePath = path.join(ctx.cwd, '.myterminal', 'subagent-outputs', '.gitignore');
  assert.ok(await waitFor(() => fs.existsSync(gitignorePath)), '输出层 .gitignore 应落盘');
  const content = fs.readFileSync(gitignorePath, 'utf-8');
  assert.ok(content.includes('*'), `自忽略 .gitignore 应含 *: ${content}`);

  // 机制不破坏写链：输出文件照常落盘
  const outputFile = outputPathFor(ctx, result.backgroundId);
  assert.ok(await waitFor(() => fs.existsSync(outputFile)), '输出文件应照常落盘');

  // 幂等：用户编辑不被覆盖
  fs.writeFileSync(gitignorePath, '# user edited\n*\n');
  const result2 = await tool.call({ command: 'echo again', run_in_background: true }, ctx);
  assert.ok(result2.backgroundId);
  assert.ok(await waitFor(() => fs.existsSync(outputPathFor(ctx, result2.backgroundId))), '二次运行输出文件应落盘');
  assert.equal(fs.readFileSync(gitignorePath, 'utf-8'), '# user edited\n*\n', '二次运行不得覆盖用户编辑');
});
