// ADR-0048 D8 低（#162）：前台命令双份内存缓冲（D8 引入回归，无帽）
//
// 修法：前台模式跳过 appendOutput（单缓冲）——data handler 仅在 explicitBackground ||
// backgrounded 时喂 appendOutput；超时转后台时从快照捕获全量直写补全（经盘帽记账，
// 不经 pendingText 合流）。前台快照帽豁免理由：快照=转后台补全源（AC2 已产输出不丢），
// 帽对齐会截断补全源——注释/票面明示。
//
// 验收覆盖（对应 #162 Acceptance criteria）：
//   AC1 前台单缓冲（无重复累积）：GB 级大输出运行中 pendingText 恒零、out 全量单份
//   AC2 前台快照语义不变：退出时同源截断（truncateCappedResult ≡ truncateResult）
//   AC3 超时转后台补全不丢：pre-conversion stdout+stderr 全量进文件（151-AC2 钉死语义）
//
// 测试方式：直调 getTool('execute_cli').call（issue-134/151 手法）+ 观察钩子
// getSnapshotBufferForTest（#162 扩展 pendingTextChars）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTool, getSnapshotBufferForTest } from '../dist/subagent/tools.js';
import { clearAllShellTasks } from '../dist/subagent/shell-tracker.js';
import { clearAllSubagents } from '../dist/subagent/store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 与 truncateResult（result-budget.ts）同源常量：单结果上限 50000 / 预览 2000
const PREVIEW_SIZE = 2_000;

let TMP;

afterEach(() => {
  clearAllShellTasks();
  clearAllSubagents();
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  TMP = undefined;
});

function makeCtx() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue162-'));
  const controller = new AbortController();
  return { cwd: TMP, signal: controller.signal, agentId: 'test-agent-162', abort: () => controller.abort() };
}

function outputPathFor(ctx, backgroundId) {
  return path.join(ctx.outputDir ?? path.join(ctx.cwd, '.myterminal', 'subagent-outputs', ctx.agentId), `${backgroundId}.output`);
}

function expectedTruncated(totalChars, fillChar = 'x') {
  return `${fillChar.repeat(PREVIEW_SIZE)}\n\n[Result truncated. Original size: ${totalChars} chars. Use read_file with offset/limit to see more.]`;
}

async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(25);
  }
  return fn();
}

// ═══════════════════════════════════════════════════════
// AC1 + AC2：前台单缓冲 + 退出同源截断语义不变
// ═══════════════════════════════════════════════════════

// #176 CI 修复：本文件用例依赖 POSIX shell 语义（bash 链 / & 后台 / exec / sleep / seq 与引号规则），
// Windows cmd.exe 无对应语义——win32 整文件跳过；实现侧 win32 降级路径由既有适配用例覆盖。
const skipOnWin = process.platform === 'win32';

test.skipIf(skipOnWin)('162-单缓冲: 前台 300K 输出运行中 pendingText 恒零（无重复累积），退出截断语义不变', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const total = 300_000;
  // 300K 分 30 块 × 20ms ≈ 600ms 写完——运行窗口足够轮询断言
  const result = await tool.call({ command: `node -e "let i=0;const t=setInterval(()=>{process.stdout.write('x'.repeat(10000));if(++i>=30)clearInterval(t)},20)"` }, ctx);

  assert.equal(result.exitCode, 0, '前台命令正常完成');
  assert.ok(!result.backgroundId, '前台不转后台');
  // AC2：退出同源截断（out 全量未帽时 truncateCappedResult ≡ truncateResult(全量)）
  assert.strictEqual(result.stdout, expectedTruncated(total), '前台快照语义不变（2000 预览 + Original size 通知）');

  // AC1：单缓冲——settled 后 pendingText 恒零、out 全量单份（豁免理由见注释）
  const buf = getSnapshotBufferForTest();
  assert.ok(buf, '观察钩子可用');
  assert.equal(buf.pendingTextChars, 0, '前台 pendingText 零累积（无重复缓冲）');
  assert.equal(buf.stdoutChars, total, 'out.stdout 全量单份（快照=转后台补全源，前台豁免快照帽）');
  assert.equal(buf.stdoutTotalChars, total, '记账诚实');
});

test.skipIf(skipOnWin)('162-单缓冲: 前台大输出运行中轮询——pendingText 每刻为零', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  // 慢速流：200K 分 20 块 × 50ms = 1s——轮询窗口内多次观察
  const resultP = tool.call({ command: `node -e "let i=0;const t=setInterval(()=>{process.stdout.write('x'.repeat(10000));if(++i>=20)clearInterval(t)},50)"` }, ctx);

  let observedAccumulating = false;
  let pollCount = 0;
  let settled = false;
  resultP.then(() => { settled = true; });
  while (!settled && pollCount < 60) {
    await sleep(25);
    pollCount += 1;
    const buf = getSnapshotBufferForTest();
    assert.ok(buf, '观察钩子可用');
    assert.equal(buf.pendingTextChars, 0, `运行中 pendingText 必须恒零（第 ${pollCount} 次轮询）`);
    if (buf.stdoutChars > 0) observedAccumulating = true;
  }
  const result = await resultP;
  assert.equal(result.exitCode, 0);
  assert.ok(observedAccumulating, '轮询窗口内观察到输出累积（断言有实质覆盖）');

  const buf = getSnapshotBufferForTest();
  assert.equal(buf.pendingTextChars, 0, 'settled 后 pendingText 仍零');
  assert.equal(buf.stdoutChars, 200_000, 'out.stdout 全量单份');
});

// ═══════════════════════════════════════════════════════
// AC3：超时转后台 pre-conversion 输出补全不丢（stdout+stderr 全量进文件）
// ═══════════════════════════════════════════════════════

test.skipIf(skipOnWin)('162-补全: 超时转后台 pre-conversion stdout 60K + stderr 40K 全量进文件（151-AC2 语义保持）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  // 立即产出 100K（stdout 60K + stderr 40K）后空转——超时（1s）转后台时输出已全部到达
  const result = await tool.call({ command: `node -e "process.stdout.write('x'.repeat(60000));process.stderr.write('e'.repeat(40000));setInterval(()=>{},100)"`, timeoutSec: 1 }, ctx);

  assert.ok(result.backgroundId, '超时转后台返回 backgroundId');
  assert.ok(result.outputPath, '含 outputPath');

  // 落盘文件：pre-conversion 两流全量补全（stdout 块在前、stderr 块在后）
  const file = outputPathFor(ctx, result.backgroundId);
  assert.ok(await waitFor(() => fs.existsSync(file)), '输出文件落盘');
  const content = fs.readFileSync(file, 'utf-8');
  assert.equal(content.length, 100_000, `文件含 pre-conversion 全量（${content.length} = 100000）`);
  assert.equal(content.split('x').length - 1, 60_000, 'stdout 60K 全量');
  assert.equal(content.split('e').length - 1, 40_000, 'stderr 40K 全量');
  ctx.abort(); // 收尸空转进程
});
