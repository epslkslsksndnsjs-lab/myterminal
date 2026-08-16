// ADR-0048 #160 — 票间回归修复：#156 回滚误删 post-spawn abort 的输出文件（#151 AC3 权威源）
//
// 根因：Bun 在 post-spawn signal abort 也发 'error'（ABORT_ERR，pid 已生成），
// #156 的 error handler 回滚（unlink 输出文件）把「已跑过、被 abort 杀死」的
// 后台命令当成 spawn 失败 → 输出文件被删、落盘权威源契约破坏（#151 红）。
// 修复：回滚仅限 child.pid === undefined（从未成功 spawn）；backgroundize 守卫
// 补 child.killed（建文件窗口内 abort 不登记死进程）。
//
// 验收覆盖：
//   AC1  显式后台 post-spawn abort → 输出文件保留含已产输出（权威源不删）+ 索引条目保留
//   AC2  前台 post-spawn abort → is_error 语义不变（"Command execution failed"）
//   AC3  R4 不回归复核：真正 spawn 失败（cwd 被删）仍回滚（不登记/不残留）

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTool } from '../dist/subagent/tools.js';
import { getBackgroundTask, clearAllShellTasks } from '../dist/subagent/shell-tracker.js';
import { defaultContext } from '../dist/subagent/context.js';
import { clearAllSubagents } from '../dist/subagent/store.js';

let TMP;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  clearAllShellTasks();
  clearAllSubagents();
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  TMP = undefined;
});

function makeCtx(overrides = {}) {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue160-'));
  const controller = new AbortController();
  return { cwd: TMP, signal: controller.signal, agentId: 'test-agent-160', abort: () => controller.abort(), ...overrides };
}

function outputPathFor(ctx, backgroundId) {
  return path.join(ctx.outputDir ?? path.join(ctx.cwd, '.myterminal', 'subagent-outputs', ctx.agentId), `${backgroundId}.output`);
}

test('AC1 显式后台 post-spawn abort：输出文件保留含已产输出（权威源不删）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  // exec sleep：abort 杀直接子进程（sh exec 后即 sleep），无孤儿孙进程
  const result = await tool.call({ command: 'echo start-160 && exec sleep 30', run_in_background: true }, ctx);
  assert.ok(result.backgroundId, '应返回 backgroundId');
  assert.ok(!result.is_error, '后台启动不是错误');
  await sleep(200); // start-160 已落盘，子仍在跑
  ctx.abort(); // post-spawn abort → Bun 'error'（ABORT_ERR，pid 已生成）
  await sleep(300);
  const file = outputPathFor(ctx, result.backgroundId);
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(content.includes('start-160'), `abort 后输出文件应保留: ${content}`);
  // 索引条目保留至 agent 收尸（abort 不是 spawn 失败，不得误删登记）
  assert.ok(getBackgroundTask(result.backgroundId), '索引条目保留至 agent 收尸');
});

test('AC2 前台 post-spawn abort：is_error 语义不变', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const p = tool.call({ command: 'sleep 30' }, ctx);
  await sleep(200);
  ctx.abort();
  const result = await p;
  assert.ok(result.is_error, '前台 abort 应报 is_error');
  assert.ok(result.message.includes('Command execution failed'), `消息应可诊断: ${result.message}`);
  assert.strictEqual(result.backgroundId, undefined, '前台无 backgroundId');
  assert.strictEqual(defaultContext.backgroundTasks.size, 0, '前台 abort 不登记索引');
});

test('AC3 R4 不回归：真正 spawn 失败（cwd 被删）仍回滚', async () => {
  const ctx = makeCtx();
  const gone = path.join(ctx.cwd, 'gone');
  fs.mkdirSync(gone);
  fs.rmdirSync(gone);
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'sleep 30', cwd: gone, run_in_background: true }, ctx);
  assert.ok(result.is_error, 'spawn 失败应报 is_error');
  assert.strictEqual(result.backgroundId, undefined);
  await sleep(500); // .then 链落定（#156 教训：R4 缺陷异步显现）
  assert.strictEqual(defaultContext.backgroundTasks.size, 0, 'spawn 失败不得登记死进程');
  const outDir = path.join(ctx.cwd, '.myterminal', 'subagent-outputs', ctx.agentId);
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  assert.deepStrictEqual(files, [], `不得残留 .output 文件: ${files.join(',')}`);
});
