// Workflows T10（#233）：账目保留与清扫——retention.ts 的单元行为锁
//
// 三条独立预算分列命名、互不混用：temp 按 1h 宽限无脑清孤儿、快照裁到预算、终态注册表由 registry 自裁。
// 保护集（active ∪ starting ∪ persistence-active）里的 run 绝不整目录删。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runRetentionSweep,
  RESULT_READABLE_WINDOW_MS,
  SUBAGENT_RECORD_TTL_MS,
  TEMP_SWEEP_GRACE_MS,
  DEFAULT_SNAPSHOT_RETAIN,
} from '../dist/workflows/retention.js';
import { workflowPaths, runPaths } from '../dist/workflows/paths.js';

const HOUR = 60 * 60 * 1000;
let TMP;

function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-233ret-'));
  TMP = dir;
  const managedRoot = path.join(dir, '.myterminal');
  fs.mkdirSync(path.join(managedRoot, 'workflows', 'runs'), { recursive: true });
  return workflowPaths(managedRoot);
}

afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

// ── 三个 1h 窗分列命名、互不混用 ──────────────────────────────────

test('三个 1 小时窗口是三个独立具名，值都是 1h、彼此不共用一个绑定', () => {
  assert.equal(RESULT_READABLE_WINDOW_MS, HOUR);
  assert.equal(SUBAGENT_RECORD_TTL_MS, HOUR);
  assert.equal(TEMP_SWEEP_GRACE_MS, HOUR);
  // 快照预算与 temp 宽限是两把尺，别把它俩当一回事。
  assert.equal(DEFAULT_SNAPSHOT_RETAIN, 30);
});

test('temp 清扫只按它自己那一格宽限计时，绝不用快照预算或别的窗去解释', async () => {
  const paths = freshRoot();
  const nowMs = Date.now();
  const run = runPaths(paths, 'wf_aaaa');
  fs.mkdirSync(run.dir, { recursive: true });
  const old = path.join(run.dir, 'index.json.ffffffff.tmp');
  const young = path.join(run.dir, 'index.json.eeeeeeee.tmp');
  fs.writeFileSync(old, 'stale');
  fs.writeFileSync(young, 'fresh');
  // 一老一新：老的超过 1h 宽限、新的在宽限内。
  const past = new Date(nowMs - 2 * HOUR);
  const recent = new Date(nowMs - 1000);
  fs.utimesSync(old, past, past);
  fs.utimesSync(young, recent, recent);

  const report = await runRetentionSweep({ paths, nowMs });
  assert.deepEqual(report.snapshotsRemoved, [], '没有终态标记就不裁快照');
  assert.deepEqual(report.tempRemoved.sort(), ['runs/wf_aaaa/index.json.ffffffff.tmp']);
  assert.equal(fs.existsSync(old), false, '超宽限的孤儿 temp 被清');
  assert.equal(fs.existsSync(young), true, '宽限内的 temp 不动（可能正被在飞写）');
});

test('temp 清扫递归到顶层与 outbox，目录读不动不炸', async () => {
  const paths = freshRoot();
  const nowMs = Date.now();
  const past = new Date(nowMs - 3 * HOUR);
  const run = runPaths(paths, 'wf_bbbb');
  fs.mkdirSync(path.join(run.dir, 'outbox'), { recursive: true });
  const topTmp = path.join(paths.workflowsRoot, 'registry.json.abcdef12.tmp');
  const outboxTmp = path.join(run.outboxDir, 'x.json.12345678.tmp');
  fs.writeFileSync(topTmp, 'z');
  fs.writeFileSync(outboxTmp, 'z');
  fs.utimesSync(topTmp, past, past);
  fs.utimesSync(outboxTmp, past, past);

  const report = await runRetentionSweep({ paths, nowMs });
  assert.deepEqual(report.tempRemoved.sort(), ['registry.json.abcdef12.tmp', 'runs/wf_bbbb/outbox/x.json.12345678.tmp']);
});

// ── 快照裁到预算：只动终态、按 settle 时刻升序删最旧、保护集跳过 ──

function makeTerminal(paths, runId, { endedAtMs }) {
  const run = runPaths(paths, runId);
  fs.mkdirSync(run.dir, { recursive: true });
  fs.writeFileSync(run.terminalFile, JSON.stringify({ schemaVersion: 1, runId, status: 'completed', reason: 'completed' }) + '\n');
  fs.writeFileSync(run.snapshotFile, JSON.stringify({ schemaVersion: 1, runId, status: 'completed' }));
  const stamp = new Date(endedAtMs);
  fs.utimesSync(run.terminalFile, stamp, stamp);
  return run;
}

test('快照超预算 → 整目录删最旧的终态 run，保留最新的 retain 份', async () => {
  const paths = freshRoot();
  const base = 1_000_000;
  const ids = ['wf_0001', 'wf_0002', 'wf_0003', 'wf_0004', 'wf_0005'];
  ids.forEach((id, i) => makeTerminal(paths, id, { endedAtMs: base + i * 1000 }));
  const report = await runRetentionSweep({ paths, nowMs: base + 99999, snapshotRetain: 2 });
  assert.deepEqual(report.snapshotsRemoved.sort(), ['wf_0001', 'wf_0002', 'wf_0003']);
  assert.equal(fs.existsSync(runPaths(paths, 'wf_0004').dir), true, '最新之一保留');
  assert.equal(fs.existsSync(runPaths(paths, 'wf_0005').dir), true, '最新之一保留');
  assert.equal(fs.existsSync(runPaths(paths, 'wf_0001').dir), false, '最旧被整目录删');
  assert.deepEqual(report.snapshotsProtected, []);
});

test('超限但落在保护集内的终态 run → 不删，进 snapshotsProtected', async () => {
  const paths = freshRoot();
  const base = 1_000_000;
  ['wf_0001', 'wf_0002', 'wf_0003'].forEach((id, i) => makeTerminal(paths, id, { endedAtMs: base + i * 1000 }));
  // retain=2 → 最旧的 wf_0001 超限；把它保护住，于是什么都不删。
  const report = await runRetentionSweep({ paths, nowMs: base + 99999, snapshotRetain: 2, protect: new Set(['wf_0001']) });
  assert.deepEqual(report.snapshotsRemoved, [], '唯一超限的那条被保护，没删');
  assert.deepEqual(report.snapshotsProtected, ['wf_0001']);
  assert.equal(fs.existsSync(runPaths(paths, 'wf_0001').dir), true);
});

test('非终态 run（无标记）永不计入快照预算', async () => {
  const paths = freshRoot();
  const run = runPaths(paths, 'wf_cccc');
  fs.mkdirSync(run.dir, { recursive: true });
  fs.writeFileSync(run.indexFile, '{}'); // 在飞，没标记
  const report = await runRetentionSweep({ paths, nowMs: Date.now(), snapshotRetain: 0 });
  assert.deepEqual(report.snapshotsRemoved, []);
  assert.equal(fs.existsSync(run.dir), true);
});

test('runs 根不存在 → 快照裁剪空跑、不抛', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-233retno-'));
  TMP = dir;
  const paths = workflowPaths(path.join(dir, '.myterminal')); // runs/ 从未建
  const report = await runRetentionSweep({ paths, nowMs: Date.now() });
  assert.deepEqual(report.snapshotsRemoved, []);
  assert.deepEqual(report.tempRemoved, []);
});
