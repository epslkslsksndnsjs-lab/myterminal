// ADR-0048 D8 高（#151）：后台输出内存封顶（落盘为权威源）
//
// 验收覆盖（对应 #151 Acceptance criteria）：
//   AC1 后台化后 out.stdout/out.stderr 不再无限增长（封顶到快照帽 50000 chars，
//       快照后停止累积——GB 级模拟流断言）
//   AC2 快照语义不变（转后台时点数据完整；>50000 → 2000 预览 + Original size 通知，
//       与 truncateResult(全量) 逐字节一致——超时转后台路径确定性断言）
//   AC3 落盘行为不变（盘帽 + 截断提示照旧，文件为权威源）
//
// 测试方式：直调 getTool('execute_cli').call（issue-134 手法）+ 测试观察钩子
// getSnapshotBufferForTest（先例：setBackgroundOutputCapForTest）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTool, setBackgroundOutputCapForTest, resetBackgroundOutputCapForTest, getSnapshotBufferForTest } from '../dist/subagent/tools.js';
import { clearAllShellTasks } from '../dist/subagent/shell-tracker.js';
import { clearAllSubagents } from '../dist/subagent/store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 与 truncateResult（result-budget.ts）同源常量：单结果上限 50000 / 预览 2000
const MAX_RESULT_SIZE_CHARS = 50_000;
const PREVIEW_SIZE = 2_000;

let TMP;

afterEach(() => {
  clearAllShellTasks();
  clearAllSubagents();
  resetBackgroundOutputCapForTest();
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  TMP = undefined;
});

function makeCtx() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue151-'));
  const controller = new AbortController();
  return { cwd: TMP, signal: controller.signal, agentId: 'test-agent-151', abort: () => controller.abort() };
}

function outputPathFor(ctx, backgroundId) {
  return path.join(ctx.outputDir ?? path.join(ctx.cwd, '.myterminal', 'subagent-outputs', ctx.agentId), `${backgroundId}.output`);
}

/** truncateResult 的期望输出（逐字节口径，供语义一致断言）。 */
function expectedTruncated(totalChars, fillChar = 'x') {
  return `${fillChar.repeat(PREVIEW_SIZE)}\n\n[Result truncated. Original size: ${totalChars} chars. Use read_file with offset/limit to see more.]`;
}

// ═══════════════════════════════════════════════════════════════
// AC2：快照语义不变（超时转后台——转后台时点数据完整 + 逐字节一致）
// ═══════════════════════════════════════════════════════════════

test('151-快照语义: 超时转后台 100K 已产输出 → 快照 = 2000 预览 + Original size 通知（与 truncateResult 逐字节一致）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const total = 100_000;
  // 立即写出 100K 后空转——超时（1s）转后台时输出已全部到达：快照总量确定性 = 100000
  const result = await tool.call({ command: `node -e "process.stdout.write('x'.repeat(${total})); setInterval(()=>{},100)"`, timeoutSec: 1 }, ctx);

  assert.ok(result.backgroundId, '超时转后台返回 backgroundId');
  assert.ok(result.outputPath, '含 outputPath');
  assert.strictEqual(result.exitCode, null, '后台无 exitCode');
  assert.strictEqual(result.stdout, expectedTruncated(total), '快照 stdout 与 truncateResult(全量) 逐字节一致（Original size 诚实）');
  assert.strictEqual(result.stderr, '', 'stderr 空');

  // 落盘文件为权威源：全量 100000 字符在文件里
  const file = outputPathFor(ctx, result.backgroundId);
  await sleep(300);
  const content = fs.readFileSync(file, 'utf-8');
  assert.equal(content.length, total, '落盘文件含全量输出（权威源）');
  ctx.abort(); // 收尸空转进程
});

test('151-快照语义: 转后台时点内存收紧——已积累 100K 缓冲在后台化后封顶 50000', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const total = 100_000;
  const result = await tool.call({ command: `node -e "process.stdout.write('x'.repeat(${total})); setInterval(()=>{},100)"`, timeoutSec: 1 }, ctx);
  assert.ok(result.backgroundId);

  // 前台阶段已积累 100K → 转后台时点收紧到快照帽（内存有界）
  const buf = getSnapshotBufferForTest();
  assert.ok(buf, '观察钩子可用');
  assert.ok(buf.stdoutChars <= MAX_RESULT_SIZE_CHARS, `内存缓冲封顶（${buf.stdoutChars} ≤ ${MAX_RESULT_SIZE_CHARS}）`);
  assert.equal(buf.stdoutTotalChars, total, '全量计数诚实保留（快照 Original size 依据）');
  assert.strictEqual(result.stdout, expectedTruncated(total), '快照仍逐字节一致（帽后重构通知）');
  ctx.abort();
});

// ═══════════════════════════════════════════════════════════════
// AC1 + AC3：GB 级模拟流内存有界（封顶 + 快照后停止累积 + 盘帽照旧）
// ═══════════════════════════════════════════════════════════════

test('151-内存有界: GB 级模拟流下转后台后 out.* 封顶 50000 且冻结，落盘盘帽照旧', async () => {
  const ctx = makeCtx();
  // 盘帽注入小值：文件侧 5MB 截断（不占磁盘跑 GB），内存侧断言才是本票核心
  setBackgroundOutputCapForTest(5 * 1024 * 1024);
  const tool = getTool('execute_cli');
  // ~1MB/20ms = 50MB/s 持续流：前台跑满 1s（~45MB+ 已产）→ 超时转后台 → 再流 1.5s。
  // 注：显式后台路径 settled 在文件就绪（~1ms）即置位——快照即冻结；转后台后仍持续灌流的
  // 内存有界断言必须走超时转后台路径（前台积累 → 转后台时点收紧 → 快照后冻结）。
  const result = await tool.call({ command: `node -e 'let w=()=>{process.stdout.write("y".repeat(1000000));setTimeout(w,20)};w()'`, timeoutSec: 1 }, ctx);
  assert.ok(result.backgroundId, '超时转后台返回 backgroundId');
  assert.strictEqual(result.exitCode, null, '后台无 exitCode');

  // 快照语义：转后台时点已产 45MB+ → 预览 + Original size 通知（诚实总量）
  const m = /Original size: (\d+) chars/.exec(result.stdout);
  assert.ok(m, '快照含 Original size 通知');
  const snapshotTotal = Number(m[1]);
  assert.ok(snapshotTotal >= 30_000_000, `转后台时点已产输出计入快照总量（${snapshotTotal} ≥ 30M）`);
  assert.ok(result.stdout.startsWith('y'.repeat(PREVIEW_SIZE)), '快照为 2000 预览形态');

  // 内存有界断言：转后台后（快照 + 持续流 1.5s）缓冲恒 ≤ 50000、总量冻结
  let maxChars = 0;
  let maxTotal = 0;
  let lastChars = -1;
  let frozenStreak = 0;
  let maxFrozenStreak = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(50);
    const buf = getSnapshotBufferForTest();
    assert.ok(buf, '观察钩子可用');
    maxChars = Math.max(maxChars, buf.stdoutChars, buf.stderrChars);
    maxTotal = Math.max(maxTotal, buf.stdoutTotalChars);
    if (lastChars === buf.stdoutChars) {
      frozenStreak++;
      maxFrozenStreak = Math.max(maxFrozenStreak, frozenStreak);
    } else {
      frozenStreak = 0;
    }
    lastChars = buf.stdoutChars;
  }
  assert.ok(maxChars <= MAX_RESULT_SIZE_CHARS, `内存缓冲全程封顶（峰值 ${maxChars} ≤ ${MAX_RESULT_SIZE_CHARS}）`);
  assert.equal(maxTotal, snapshotTotal, '快照后总量冻结（停止累积——GB 级流不再进内存）');
  assert.ok(maxFrozenStreak >= 10, `快照后缓冲冻结（最长连续 ${maxFrozenStreak} 次轮询值不变）`);

  // 落盘行为不变：文件有盘帽截断提示（权威源 + 盘帽照旧）
  ctx.abort(); // 收尸流进程（spawn signal 链）
  await sleep(300);
  const file = outputPathFor(ctx, result.backgroundId);
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(content.includes('[output truncated: exceeded'), '落盘文件含盘帽截断提示（行为不变）');
}, { timeout: 30000 });

// ═══════════════════════════════════════════════════════════════
// 前台语义不回归 + 小输出文件权威
// ═══════════════════════════════════════════════════════════════

test('151-前台不回归: 前台大输出退出 → 与 truncateResult(全量) 逐字节一致', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const total = 200_000;
  const result = await tool.call({ command: `node -e "process.stdout.write('x'.repeat(${total}))"` }, ctx);
  assert.ok(!result.backgroundId, '前台无 backgroundId');
  assert.strictEqual(result.exitCode, 0, '前台退出码照旧');
  assert.strictEqual(result.stdout, expectedTruncated(total), '前台路径输出与修复前逐字节一致');
});

test('151-小输出权威源: 显式后台小输出 → 文件含全量（落盘为权威源）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: "node -e \"process.stdout.write('hello background')\"", run_in_background: true }, ctx);
  assert.ok(result.backgroundId);
  // 快照 = 文件就绪时点已到数据（node 启动前 ≈ 空）——不超帽即可；权威在文件
  assert.ok(['', 'hello background'].includes(result.stdout), `快照 ∈ {空, 全量}（实际 ${result.stdout.length} chars）`);
  const file = outputPathFor(ctx, result.backgroundId);
  await sleep(400);
  assert.ok(fs.readFileSync(file, 'utf-8').includes('hello background'), '文件含完整输出（权威源）');
});
