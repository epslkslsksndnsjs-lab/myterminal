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
  fs.rmSync(root, { recursive: true, force: true });
});
