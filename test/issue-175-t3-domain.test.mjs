import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupAgentOutputDir } from '../dist/subagent/output-dir.js';
import { createSubagent, clearAllSubagents } from '../dist/subagent/store.js';
import { registerBackgroundTask, clearAllShellTasks } from '../dist/subagent/shell-tracker.js';
import { clearAllOutputDirs } from '../dist/subagent/output-dir.js';
import { defaultContext } from '../dist/subagent/context.js';

// #175：T3 域簇（可单元断言部分：输出目录延迟收尸；其余由 execute_cli 契约回归兜底）

test('175-2a: 后台子进程在世时目录不删（延迟收尸窗口）', () => {
  clearAllSubagents();
  clearAllOutputDirs();
  clearAllShellTasks();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-175-'));
  const dir = path.join(root, 'out');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'partial.output'), 'data');

  const rec = createSubagent('agent-175', { subject: 'bg work' });
  rec.status = 'failed'; // 非 running——记录层面已终态，但后台子还在写
  rec.backgroundTasks = [{ backgroundId: 'bg-1', pid: 4242 }];
  registerBackgroundTask('agent-175', 'bg-1', { killed: false, exitCode: null, signalCode: null, pid: 4242 });
  defaultContext.outputDirs.set('agent-175', dir);

  cleanupAgentOutputDir('agent-175');
  assert.equal(fs.existsSync(dir), true, '后台子仍在写——目录不得同步删除');

  // 1s 时模拟子进程已死（早于 2s 重试），重试应删目录
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      defaultContext.subagents.get('agent-175').backgroundTasks = [];
      setTimeout(() => {
        try {
          assert.equal(fs.existsSync(dir), false, '子进程消亡后目录应被延迟删除');
          assert.equal(defaultContext.outputDirs.has('agent-175'), false, '延迟删除后登记应同步清除');
          fs.rmSync(root, { recursive: true, force: true });
          resolve();
        } catch (e) {
          reject(e);
        }
      }, 1800);
    }, 1000);
  });
});

test('175-2b: 无后台子时同步删除不回归', () => {
  clearAllSubagents();
  clearAllOutputDirs();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-175b-'));
  const dir = path.join(root, 'out');
  fs.mkdirSync(dir, { recursive: true });
  const rec = createSubagent('agent-175b', { subject: 'done work' });
  rec.status = 'completed';
  defaultContext.outputDirs.set('agent-175b', dir);

  cleanupAgentOutputDir('agent-175b');
  assert.equal(fs.existsSync(dir), false);
  assert.equal(defaultContext.outputDirs.has('agent-175b'), false, '同步删除后登记应同步清除');
  fs.rmSync(root, { recursive: true, force: true });
});

test('175-2c（#177）：双重清理幂等——重试路径再删已删目录不抛', async () => {
  clearAllSubagents();
  clearAllOutputDirs();
  clearAllShellTasks();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-175c-'));
  const dir = path.join(root, 'out');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'partial.output'), 'data');

  const rec = createSubagent('agent-175c', { subject: 'race work' });
  rec.status = 'failed';
  rec.backgroundTasks = [{ backgroundId: 'bg-2', pid: 4243 }];
  registerBackgroundTask('agent-175c', 'bg-2', { killed: false, exitCode: null, signalCode: null, pid: 4243 });
  defaultContext.outputDirs.set('agent-175c', dir);

  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);

  cleanupAgentOutputDir('agent-175c'); // 第一调：子在世 → 挂 2s 重试
  defaultContext.subagents.get('agent-175c').backgroundTasks = []; // 子已死
  cleanupAgentOutputDir('agent-175c'); // 第二调：同步删（force 幂等）
  assert.equal(fs.existsSync(dir), false, '同步清理应删除目录');

  await new Promise((resolve) => setTimeout(resolve, 2600)); // 等 2s 重试到期（目录已不存在）
  process.removeListener('uncaughtException', onUncaught);
  assert.equal(uncaught.length, 0, '重试路径对已删目录应幂等不抛（force:true 铁律）');
  assert.equal(defaultContext.outputDirs.has('agent-175c'), false, '登记应已清除');

  cleanupAgentOutputDir('agent-175c'); // 第三调：全链路再入不抛（同步路径幂等）
  assert.equal(fs.existsSync(dir), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('175-2d（#177）：登记未落盘的目录同步清理幂等不抛', () => {
  clearAllSubagents();
  clearAllOutputDirs();
  clearAllShellTasks();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-175d-'));
  const dir = path.join(root, 'never-created'); // 只登记不 mkdir（执行层仅在转后台时懒建）
  const rec = createSubagent('agent-175d', { subject: 'never bg' });
  rec.status = 'completed';
  defaultContext.outputDirs.set('agent-175d', dir);

  assert.doesNotThrow(() => cleanupAgentOutputDir('agent-175d'), '目录从未存在——force:true 幂等不抛');
  assert.equal(defaultContext.outputDirs.has('agent-175d'), false, '登记应清除');
  fs.rmSync(root, { recursive: true, force: true });
});
