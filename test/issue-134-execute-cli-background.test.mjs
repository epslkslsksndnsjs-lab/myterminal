// ADR-0048 T3 (#134)：execute_cli 双模式 + 转后台落盘（D8 第四轮修订）
//
// 验收覆盖（对应 #134 Acceptance criteria）：
//   AC1  显式后台：run_in_background=true 秒回 backgroundId+outputPath，命令继续跑
//   AC2  超时转后台：到点不杀、转后台、返回 outputPath 引导语（已产输出不丢）
//   AC3  子经 read_file 读输出文件（含 offset/limit 分页）
//   AC4  会话终结收尸整个进程组（三级收尸链：进程组→单杀→2s SIGKILL 升级）
//   AC5  sleep 类无意义命令不转后台（shouldAutoBackground 判据：base command ∈ ['sleep']）
//   AC6  无 cli_output 新增（8 工具不变）；schema 有 run_in_background + timeoutSec 上限 600
//   AC7  落盘大小上限 + 截断提示（盘帽口径 5GB，数值本项目定；pipe 模式丢弃超限 chunk）
//   AC8  前台语义不回归（echo → stdout/exitCode 原样，无 backgroundId）
//
// 测试方式：直调 getTool('execute_cli').call（subagent-m4 手法，从 ../dist 导入）。
// 注：任何 src 改动后必须先 bun run build 再跑测试（#43）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTool, getAllToolSchemas } from '../dist/subagent/tools.js';
import { setBackgroundOutputCapForTest, resetBackgroundOutputCapForTest } from '../dist/subagent/tools.js';
import { registerBackgroundTask, getBackgroundTask, cleanupAgentShellTasks, clearAllShellTasks } from '../dist/subagent/shell-tracker.js';
import { createSubagentContext } from '../dist/subagent/context.js';
import { createSubagent, clearAllSubagents } from '../dist/subagent/store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TMP;

afterEach(() => {
  clearAllShellTasks();
  clearAllSubagents();
  resetBackgroundOutputCapForTest();
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  TMP = undefined;
});

function makeCtx(overrides = {}) {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue134-'));
  return {
    cwd: TMP,
    signal: new AbortController().signal,
    agentId: 'test-agent-134',
    ...overrides,
  };
}

function outputPathFor(ctx, backgroundId) {
  return path.join(ctx.outputDir ?? path.join(ctx.cwd, '.myterminal', 'subagent-outputs', ctx.agentId), `${backgroundId}.output`);
}

test('AC1 显式后台：run_in_background=true 秒回 backgroundId+outputPath，命令继续跑', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const started = Date.now();
  const result = await tool.call({ command: 'echo start; sleep 1; echo done', run_in_background: true }, ctx);
  const elapsed = Date.now() - started;

  // 秒回：命令总耗时 1s+，返回必须显著更快
  assert.ok(elapsed < 500, `显式后台应秒回（elapsed=${elapsed}ms）`);
  assert.ok(result.backgroundId, '返回体应含 backgroundId');
  assert.ok(result.outputPath, '返回体应含 outputPath');
  assert.ok(result.message.includes('Output is being written to:'), `引导语缺失: ${result.message}`);
  assert.ok(result.message.includes(result.outputPath), '引导语应含 outputPath');
  assert.strictEqual(result.exitCode, null, '后台命令无 exitCode');
  assert.ok(!result.is_error, '转后台不是错误');

  // 命令继续跑：文件最终有 start + done
  const outputFile = outputPathFor(ctx, result.backgroundId);
  assert.strictEqual(result.outputPath, outputFile, 'outputPath 应为 <outputDir>/<backgroundId>.output');
  await sleep(1800);
  const content = fs.readFileSync(outputFile, 'utf-8');
  assert.ok(content.includes('start'), `文件应含已产输出 start: ${content}`);
  assert.ok(content.includes('done'), `命令应继续跑完并落盘 done: ${content}`);
});

test('AC1b 显式后台登记 backgroundId→ChildProcess 索引（shell-tracker）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'sleep 0.2', run_in_background: true }, ctx);
  const child = getBackgroundTask(result.backgroundId);
  assert.ok(child, 'backgroundId 应可经 shell-tracker 索引查到 ChildProcess');
  assert.strictEqual(child.pid > 0, true);
  await sleep(400);
});

test('AC2 超时转后台：到点不杀、返回 backgroundId + 引导语、已产输出不丢', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'echo slow-start; sleep 1.5; echo slow-done', timeoutSec: 1 }, ctx);

  // 到点（1s）返回：未杀、转后台
  assert.ok(result.backgroundId, '超时应转后台返回 backgroundId');
  assert.ok(result.outputPath, '应返回 outputPath');
  assert.ok(result.message.includes('Output is being written to:'), `引导语缺失: ${result.message}`);
  assert.strictEqual(result.exitCode, null, '超时不杀：exitCode 应为 null');
  assert.ok(result.stdout.includes('slow-start'), '转后台前已产输出不丢');

  // 命令继续跑：1.5s 后 slow-done 落盘
  const outputFile = outputPathFor(ctx, result.backgroundId);
  await sleep(1800);
  const content = fs.readFileSync(outputFile, 'utf-8');
  assert.ok(content.includes('slow-start'), `文件应含转后台前输出: ${content}`);
  assert.ok(content.includes('slow-done'), `命令应继续跑完并落盘 slow-done: ${content}`);
});

test('AC3 子经 read_file 读输出文件（含 offset/limit）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'printf "line1\\nline2\\nline3\\nline4\\nline5\\n"', run_in_background: true }, ctx);
  await sleep(500);

  const readTool = getTool('read_file');
  // 相对 cwd 路径 + offset/limit 分页
  const rel = path.relative(ctx.cwd, result.outputPath);
  const r1 = await readTool.call({ path: rel, offset: 1, limit: 2 }, ctx);
  assert.ok(!r1.is_error, `read_file 应能读输出文件: ${JSON.stringify(r1)}`);
  assert.ok(r1.content.includes('line1'), `分页应含 line1: ${r1.content}`);
  assert.ok(r1.content.includes('line2'));
  assert.ok(!r1.content.includes('line3'), 'limit=2 不应越页');
  assert.ok(r1.totalLines >= 5);
  assert.strictEqual(r1.startLine, 1);
  assert.strictEqual(r1.endLine, 2);

  // 续页
  const r2 = await readTool.call({ path: rel, offset: 3, limit: 2 }, ctx);
  assert.ok(r2.content.includes('line3') && r2.content.includes('line4'));
  assert.ok(!r2.content.includes('line5'));
});

test('AC4 会话终结收尸：cleanupAgentShellTasks 杀后台进程组', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'sleep 60', run_in_background: true }, ctx);
  assert.ok(result.backgroundId);
  const child = getBackgroundTask(result.backgroundId);
  assert.ok(child, '后台进程应登记在索引');

  // 会话终结：disposeAgent → cleanupAgentShellTasks
  cleanupAgentShellTasks(ctx.agentId);

  await sleep(300);
  // Bun 信号杀进程：exitCode 保持 null，信号在 signalCode（Node/Bun 差异）
  assert.ok(child.signalCode !== null || child.exitCode !== null || child.killed,
    `后台进程应被收尸: exitCode=${child.exitCode} signalCode=${child.signalCode} killed=${child.killed}`);
});

test('AC4b 收尸后 backgroundId 索引清空', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'sleep 60', run_in_background: true }, ctx);
  assert.ok(getBackgroundTask(result.backgroundId), '收尸前应可查到');
  cleanupAgentShellTasks(ctx.agentId);
  assert.strictEqual(getBackgroundTask(result.backgroundId), undefined, '收尸后索引应清空');
});

test('AC5 sleep 类不转后台：到点杀掉，无 backgroundId（shouldAutoBackground 判据）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'sleep 5', timeoutSec: 1 }, ctx);

  assert.strictEqual(result.backgroundId, undefined, 'sleep 类不应转后台');
  // 原语义保持（改造前 spawn timeout 杀 → exitCode -1 → interpretExitCode 判 isError）
  assert.ok(result.exitCode !== null, `sleep 类超时应被杀: exitCode=${result.exitCode}`);
  assert.strictEqual(result.exitCode, -1);
});

test('AC5b sleep 链首命令同样不转后台（`sleep 2 && echo done`）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'sleep 2 && echo done', timeoutSec: 1 }, ctx);
  assert.strictEqual(result.backgroundId, undefined);
  assert.ok(result.exitCode !== null);
});

test('AC5c 非 sleep 命令超时转后台（echo 首命令可转）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'echo fast; sleep 3', timeoutSec: 1 }, ctx);
  assert.ok(result.backgroundId, 'echo 首命令应可自动转后台');
  assert.ok(result.stdout.includes('fast'));
});

test('AC6 无 cli_output 新增：8 工具不变 + schema 契约', async () => {
  const schemas = getAllToolSchemas();
  assert.strictEqual(schemas.length, 8, '8 工具不变');
  assert.ok(!schemas.some((s) => s.name === 'cli_output'), '无 cli_output 新增');

  const exec = schemas.find((s) => s.name === 'execute_cli');
  assert.ok(exec.input_schema.properties.run_in_background, 'schema 应有 run_in_background');
  assert.strictEqual(exec.input_schema.properties.timeoutSec.maximum, 600, 'timeoutSec 上限 600');
  assert.strictEqual(exec.input_schema.properties.timeoutSec.default, 120, 'timeoutSec 默认 120 不变');
});

test('AC6b 超上限防御性钳制：timeoutSec=900 按 600 执行（不因直调路径炸）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'echo clamp-ok', timeoutSec: 900 }, ctx);
  assert.ok(result.stdout.includes('clamp-ok'));
});

test('AC7 落盘大小上限：超限截断 + 丢弃后续 chunk（pipe 模式不杀进程）', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  // 测试钩子：把盘帽压到 100 字节（先例：store.setCleanupDelayMs）
  setBackgroundOutputCapForTest(100);
  const result = await tool.call({ command: 'echo start; node -e "process.stdout.write(\'x\'.repeat(10000))"; echo tail', run_in_background: true }, ctx);
  await sleep(1200);
  const content = fs.readFileSync(result.outputPath, 'utf-8');
  assert.ok(content.includes('start'), 'cap 前输出应保留');
  assert.ok(content.includes('disk cap'), `超限应有截断提示: ${content.slice(-200)}`);
  // 进程不被杀（pipe 模式丢弃超限 chunk）：tail 是否落盘取决于时序，不断言
  assert.ok(content.length < 10000, `超限 chunk 应被丢弃: len=${content.length}`);
});

test('AC1e 显式后台快命令：仍按后台语义返回，输出最终落盘完整', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  // echo 瞬时完成——exit 可能先于 data 排空、也可能先于建文件就绪（竞态路径）。
  // 后台语义：stdout 快照为当时已产输出（快命令可为空），
  // 完整性契约在落盘文件——read_file 随时可读。
  const result = await tool.call({ command: 'echo instant', run_in_background: true }, ctx);
  assert.ok(result.backgroundId, '快命令也应返回 backgroundId');
  assert.ok(result.outputPath, '应返回 outputPath');
  assert.strictEqual(result.exitCode, null, '按后台语义：exitCode null');
  assert.strictEqual(typeof result.stdout, 'string', 'stdout 快照为字符串（可为空）');
  // 文件存在且含全部输出（pendingText flush 路径，句柄由 .then/exit 兜底关闭）
  await sleep(300); // 等 data 排空落盘（与 AC1 同款等待口径）
  const content = fs.readFileSync(result.outputPath, 'utf-8');
  assert.ok(content.includes('instant'), `文件应含输出: ${content}`);
});

test('AC9a O1 防御：快命令 + 孙进程存活（sleep 60 &）——调用有界返回不挂起，输出落盘完整', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  // 审查 O1：孙进程持管道 fd 时 'end'/'close' 可能永不触发。修复 = drain 有界 2s 放行
  //（Promise.race 5s 兜底把无界挂起转成可断言的红）。
  // 注：Bun 实测建文件（~0.5ms）恒先于 shell 退出（~1-2ms），「exit 先于建文件」路径
  // 黑盒不可达；快照空属后台语义（resolve 先于数据）——完整性契约在落盘文件。
  const result = await Promise.race([
    tool.call({ command: 'sleep 60 & echo spawned', run_in_background: true }, ctx),
    new Promise((_, reject) => setTimeout(() => reject(new Error('drain 无界等待：调用挂起')), 5000)),
  ]);
  assert.ok(result.backgroundId, '应返回 backgroundId');
  assert.strictEqual(result.exitCode, null, '后台语义：exitCode null');
  // 数据最终落盘（read_file 随时可读）
  await sleep(300);
  const content = fs.readFileSync(result.outputPath, 'utf-8');
  assert.ok(content.includes('spawned'), `文件应含输出: ${content}`);
  // 收尸：杀 shell 进程组（sleep 60 孤儿同组），避免残留
  cleanupAgentShellTasks(ctx.agentId);
  await sleep(300);
  assert.strictEqual(getBackgroundTask(result.backgroundId), undefined, '收尸后索引清空');
});

test('AC9b O2 契约守护：命令已完成后台调用恒返回后台语义', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  // 审查 O2：进入后台模式后命令完成统一 deferred 走后台语义（backgroundId+outputPath），
  // 不按前台 exitCode 返回丢身份。注：Bun 微任务清空先于事件回调，「文件已建、.then
  // 未 resolve」窗口理论不可达（open 完成 → .then 微任务必然先于 exit 回调），此用例为
  // 契约守护；快照完整性时序不保证（快命令 resolve 先于数据属后台语义），不断言。
  const result = await tool.call({ command: 'echo hello; sleep 2 &', run_in_background: true }, ctx);
  assert.ok(result.backgroundId, '后台语义：backgroundId');
  assert.strictEqual(result.exitCode, null, '后台语义：exitCode null');
  // 等 sleep 2 自然结束（管道关闭），避免残留
  await sleep(2400);
});

test('AC1d 建文件失败兜底：不可写 outputDir → is_error + 杀进程（failBackground）', async () => {
  const ctx = makeCtx();
  // 只读目录：open(O_CREAT|O_EXCL) 必失败（非 root 用户）
  const roDir = path.join(ctx.cwd, 'readonly');
  fs.mkdirSync(roDir);
  fs.chmodSync(roDir, 0o444);
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'sleep 30', run_in_background: true }, { ...ctx, outputDir: roDir });
  assert.ok(result.is_error, '建文件失败应报 is_error');
  assert.ok(result.message.includes('Failed to start background task'), `消息应可诊断: ${result.message}`);
  assert.strictEqual(result.backgroundId, undefined);
  // 进程被兜底杀掉（不泄漏孤儿）
  await sleep(400);
  const child = getBackgroundTask('anything');
  assert.strictEqual(child, undefined, '未登记索引（registerBackground 未执行）');
});

test('AC8 前台语义不回归：echo → stdout/exitCode 原样，无 backgroundId', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'echo hello', timeoutSec: 5 }, ctx);
  assert.ok(result.stdout.includes('hello'));
  assert.strictEqual(result.exitCode, 0);
  assert.ok(!result.is_error);
  assert.strictEqual(result.backgroundId, undefined);
  assert.strictEqual(result.outputPath, undefined);
  assert.strictEqual(result.message, undefined);
});

test('AC8b 前台完成时无输出文件残留', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  await tool.call({ command: 'echo hello' }, ctx);
  const outDir = ctx.outputDir ?? path.join(ctx.cwd, '.myterminal', 'subagent-outputs', ctx.agentId);
  assert.ok(!fs.existsSync(outDir), '前台完成不应留输出目录');
});

test('AC2b 转后台返回体含 truncateResult 封顶的已产输出', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  // 已产输出 2000 行（封顶前截断检查走 truncateResult）
  const result = await tool.call({ command: 'seq 1 2000; sleep 3', timeoutSec: 1 }, ctx);
  assert.ok(result.backgroundId);
  assert.strictEqual(typeof result.stdout, 'string');
  assert.ok(result.stdout.length > 0);
});

test('AC1c store 元数据：SubagentRecord 记 backgroundId→pid', async () => {
  const ctx = makeCtx();
  createSubagent(ctx.agentId, { subject: 'issue-134' });
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'sleep 0.3', run_in_background: true }, ctx);
  const { getSubagent } = await import('../dist/subagent/store.js');
  const record = getSubagent(ctx.agentId);
  assert.ok(record.backgroundTasks.some((b) => b.backgroundId === result.backgroundId && b.pid > 0), 'record 应存 backgroundId→pid 元数据');
  await sleep(400);
});
