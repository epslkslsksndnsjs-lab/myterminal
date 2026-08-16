// ADR-0048 #159：落盘文件未派生——转后台 bg_*.output 被 abort 误删（#151 × #156 交互红）
//
// 根因：#156 R4 回滚把 abort 的正常收尸当作 spawn 失败——AbortError 'error' 事件
// 触发 unlink 删掉落盘文件（D8 语义：文件必须留存供 read_file，会话级清理归 #152）。
//
// 验收覆盖（对应 #159 Acceptance criteria）：
//   AC1 转后台后 output 文件必落盘（bg_*.output 可 read_file 读）——abort 收尸后仍在
//   AC2 #151 内存有界用例绿（合体后口径）
//   AC3 真实 spawn 失败 R4 回滚照旧（无残留 .output）
//
// 测试方式：直调 getTool('execute_cli').call（issue-134 手法）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTool } from '../dist/subagent/tools.js';
import { clearAllShellTasks } from '../dist/subagent/shell-tracker.js';
import { clearAllSubagents } from '../dist/subagent/store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TMP;

afterEach(() => {
  clearAllShellTasks();
  clearAllSubagents();
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  TMP = undefined;
});

function makeCtx() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue159-'));
  const controller = new AbortController();
  return { cwd: TMP, signal: controller.signal, agentId: 'test-agent-159', abort: () => controller.abort() };
}

function outputPathFor(ctx, backgroundId) {
  return path.join(ctx.outputDir ?? path.join(ctx.cwd, '.myterminal', 'subagent-outputs', ctx.agentId), `${backgroundId}.output`);
}

// ═══════════════════════════════════════════════════════════════
// AC1：快照后 abort 收尸 → 落盘文件仍在（回归 #159 ENOENT）
// ═══════════════════════════════════════════════════════════════

// #176 CI 修复：本文件用例依赖 POSIX shell 语义（bash 链 / & 后台 / exec / sleep / seq 与引号规则），
// Windows cmd.exe 无对应语义——win32 整文件跳过；实现侧 win32 降级路径由既有适配用例覆盖。
const skipOnWin = process.platform === 'win32';

test.skipIf(skipOnWin)('159-AC1: 快照后 abort 收尸 → bg_*.output 文件仍在且可读（D8 落盘留存）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  // 持续流：快照（~1ms）先于 node 启动（~50ms）——等输出产出一批后再 abort 收尸
  const result = await tool.call({ command: `node -e 'let w=()=>{process.stdout.write("z".repeat(100000));setTimeout(w,30)};w()'`, run_in_background: true }, ctx);
  assert.ok(result.backgroundId, '返回 backgroundId');
  const file = outputPathFor(ctx, result.backgroundId);
  assert.ok(fs.existsSync(file), '转后台后文件已落盘（快照返回时存在）');
  // 等子进程启动并产出（100KB 立即 + 30ms 持续）——有界轮询（CI 负载下固定 300ms 不足，#176 实测 mac 轮换 flake）
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    try {
      if (fs.readFileSync(file, 'utf-8').includes('z')) break;
    } catch { /* 文件尚未就绪 */ }
  }
  assert.ok(fs.readFileSync(file, 'utf-8').includes('z'), '已产输出持续落盘');

  // 收尸：abort 杀进程（AbortError 'error' 事件会触发）——文件必须留存且内容保全
  ctx.abort();
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8').includes('z')) break;
    } catch { /* 文件尚未就绪 */ }
  }
  assert.ok(fs.existsSync(file), 'abort 收尸后落盘文件仍在（#156 R4 回滚不得误删）');
  assert.ok(fs.readFileSync(file, 'utf-8').includes('z'), '文件可 read_file 读（含已产输出）');
});

test.skipIf(skipOnWin)('159-AC1b: 一次性输出命令快照后 abort → 文件落盘且内容保全', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  // 写 50KB 后空转：输出产出一批后再 abort——覆盖 backgroundize .then 已完成路径
  const result = await tool.call({ command: `node -e 'process.stdout.write("w".repeat(50000));setInterval(()=>{},50)'`, run_in_background: true }, ctx);
  assert.ok(result.backgroundId, '返回 backgroundId');
  const file = outputPathFor(ctx, result.backgroundId);
  await sleep(300); // 等 50KB 落盘
  assert.ok(fs.readFileSync(file, 'utf-8').includes('w'), '一次性输出已落盘');
  ctx.abort();
  await sleep(400);
  assert.ok(fs.existsSync(file), 'abort 后文件仍落盘（spawnFailed 守卫不误删 abort 场景）');
  assert.ok(fs.readFileSync(file, 'utf-8').includes('w'), '内容保全');
});

// ═══════════════════════════════════════════════════════════════
// AC2：#151 内存有界用例（合体后口径）
// ═══════════════════════════════════════════════════════════════

test.skipIf(skipOnWin)('159-AC2: #151 内存有界断言在合体后保持绿（abort 后盘帽文件可读）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: `node -e 'let w=()=>{process.stdout.write("y".repeat(1000000));setTimeout(w,20)};w()'`, timeoutSec: 1 }, ctx);
  assert.ok(result.backgroundId, '超时转后台返回 backgroundId');
  assert.ok(/Original size: \d+ chars/.test(result.stdout), '快照通知形态保持');
  ctx.abort();
  await sleep(400);
  const file = outputPathFor(ctx, result.backgroundId);
  assert.ok(fs.existsSync(file), 'abort 后落盘文件仍在（#151 × #156 交互已修）');
  assert.ok(fs.statSync(file).size > 0, '文件非空（已产输出落盘）');
});

// ═══════════════════════════════════════════════════════════════
// R4 回滚语义保持（#156 已覆盖：spawn ENOENT/预中止 → 不残留、不登记；
// exit-127 非 spawn error——shell:true 下命令不存在走 exit 路径，文件为空留存）
// 本票不动 R4 守卫，回归由 issue-156-spawn-error-background.test.mjs 全量保障。
// ═══════════════════════════════════════════════════════════════
