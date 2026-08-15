// ADR-0048 #156（R4）：显式后台 spawn 失败——不登记死进程、不泄漏句柄、不留空 .output
//
// 触发手法（票内三种触发变体取二）：
//   AC1   cwd 被删：input.cwd 指向已删除目录 → spawn 必 'error'（ENOENT），
//         outputDir 在 ctx.cwd 下正常 → createOutputFile 成功 → 精确复现
//         「error 先 settle、.then 照跑」的 R4 窗口。
//   AC2   signal aborted：ctx.signal 注入已中止 AbortSignal → spawn 'error'（AbortError）。
// 断言口径：is_error + 无 backgroundId/outputPath、backgroundTasks 索引空、
// 输出目录无 .output 残留。
// 注：句柄关闭无直接 fd 观测口径（bun getActiveResourcesInfo 不列 FileHandle），
// 由 unlink 成功 + 无残留间接覆盖（close 经 closeOutputHandle 幂等执行）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTool } from '../dist/subagent/tools.js';
import { clearAllShellTasks } from '../dist/subagent/shell-tracker.js';
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
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue156-'));
  return {
    cwd: TMP,
    signal: new AbortController().signal,
    agentId: 'test-agent-156',
    ...overrides,
  };
}

function outDirFor(ctx) {
  return path.join(ctx.cwd, '.myterminal', 'subagent-outputs', ctx.agentId);
}

test('AC1 cwd 被删（显式后台）：is_error、不登记死进程、不留空 .output', async () => {
  const ctx = makeCtx();
  const gone = path.join(ctx.cwd, 'gone');
  fs.mkdirSync(gone);
  fs.rmdirSync(gone); // 已删除目录作为 cwd → spawn ENOENT，outputDir（ctx.cwd 下）不受影响
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'sleep 30', cwd: gone, run_in_background: true }, ctx);

  assert.ok(result.is_error, `spawn 失败应报 is_error: ${JSON.stringify(result)}`);
  assert.ok(result.message.includes('Command execution failed'), `消息应可诊断: ${result.message}`);
  assert.strictEqual(result.backgroundId, undefined, 'spawn 失败不得返回 backgroundId');
  assert.strictEqual(result.outputPath, undefined, 'spawn 失败不得返回 outputPath');
  assert.strictEqual(result.exitCode, null);

  // 竞态口径：R4 缺陷异步显现——error resolve 先返回，.then 链晚数百 ms 才建文件/登记
  // （实测 600ms 后死登记 + 空文件才出现）。等 .then 链落定再断言索引与文件。
  await sleep(500);
  // 不登记死进程：backgroundTasks 索引无条目（修复前 registerBackground 照跑留死 child）
  assert.strictEqual(defaultContext.backgroundTasks.size, 0, 'backgroundTasks 索引不得有死条目');

  // 不残留空 .output（修复前 createOutputFile.then 建完文件不删）
  const outDir = outDirFor(ctx);
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  assert.deepStrictEqual(files, [], `不得残留 .output 文件: ${files.join(',')}`);
});

test('AC2 signal aborted（显式后台）：is_error、不登记、不残留', async () => {
  const ac = new AbortController();
  ac.abort(); // 预先中止：spawn 必 'error'（AbortError），建文件路径不受影响
  const ctx = makeCtx({ signal: ac.signal });
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'sleep 30', run_in_background: true }, ctx);

  assert.ok(result.is_error, `spawn 失败应报 is_error: ${JSON.stringify(result)}`);
  assert.strictEqual(result.backgroundId, undefined);
  assert.strictEqual(result.outputPath, undefined);
  await sleep(500); // 同 AC1：等 .then 链落定
  assert.strictEqual(defaultContext.backgroundTasks.size, 0, 'backgroundTasks 索引不得有死条目');
  const outDir = outDirFor(ctx);
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  assert.deepStrictEqual(files, [], `不得残留 .output 文件: ${files.join(',')}`);
});

test('AC3 前台 spawn 失败语义不变：is_error + message，零背景副作用', async () => {
  const ctx = makeCtx();
  const gone = path.join(ctx.cwd, 'gone');
  fs.mkdirSync(gone);
  fs.rmdirSync(gone);
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'echo hi', cwd: gone }, ctx);

  assert.ok(result.is_error, '前台 spawn 失败应报 is_error');
  assert.ok(result.message.includes('Command execution failed'), `消息应可诊断: ${result.message}`);
  assert.strictEqual(result.backgroundId, undefined);
  assert.strictEqual(result.outputPath, undefined);
  assert.strictEqual(defaultContext.backgroundTasks.size, 0, '前台不得登记索引');
  assert.ok(!fs.existsSync(outDirFor(ctx)), '前台不得创建输出目录');
});

test('AC4 守卫不误伤：显式后台正常命令仍登记 + 输出落盘', async () => {
  const ctx = makeCtx();
  const tool = getTool('execute_cli');
  const result = await tool.call({ command: 'echo alive', run_in_background: true }, ctx);
  assert.ok(!result.is_error, `正常后台不得误报错: ${JSON.stringify(result)}`);
  assert.ok(result.backgroundId, '正常后台应返回 backgroundId');
  await sleep(300);
  const content = fs.readFileSync(result.outputPath, 'utf-8');
  assert.ok(content.includes('alive'), `输出应落盘: ${content}`);
  assert.strictEqual(defaultContext.backgroundTasks.size, 1, '正常后台应登记索引');
});
