/**
 * Journal 写盘失败（ADR-0052 §账本卫生 / 审查 finding PER-01）。
 *
 * 钉死的行为：一次没写进盘的行，绝不能在 appendOrdered()/drain() 那里变成"成功"。
 * 失败注入不改 src：把账本所在目录挪走、原位放一个同名普通文件，任何后续 open 都 ENOTDIR，
 * 已落盘的良前缀原样保留（模块禁用 chmod，所以不用权限位模拟）。
 */
import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Journal, JournalWriteError } from '../dist/workflows/journal.js';

let ROOT;

afterEach(() => {
  if (ROOT) {
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 忽略 */ }
    ROOT = undefined;
  }
});

function setup() {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-journal-fail-'));
  const dir = path.join(ROOT, 'run');
  fs.mkdirSync(dir);
  return { dir, file: path.join(dir, 'journal.jsonl') };
}

/** 让 dir 里的写入全部失败；返回恢复函数（把良前缀目录搬回来）。 */
function breakDir(dir) {
  const parked = `${dir}.parked`;
  fs.renameSync(dir, parked);
  fs.writeFileSync(dir, ''); // 同名普通文件占位 → open(dir/journal.jsonl) ENOTDIR
  return () => {
    fs.rmSync(dir, { force: true });
    fs.renameSync(parked, dir);
  };
}

function readRecords(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function recordSeqs(file) {
  return readRecords(file).map((record) => (record.type === 'result' || record.type === 'started' ? record.seq : record.type));
}

const launched = { type: 'launched', runId: 'wf_a', at: 't0' };
const result = (seq, value) => ({ type: 'result', seq, value, at: 't1' });

/** 断言是一个真实错误（注入点的 errno 随平台而定，不钉具体 code）。 */
function isIoError(error) {
  assert.ok(error instanceof Error, `期望 Error，实际: ${String(error)}`);
  assert.equal(typeof error.code, 'string');
  return true;
}

// ═══════════════════════════════════════════════════════════════
// 一、失败传播：appendOrdered 拒绝，drain 汇总抛出
// ═══════════════════════════════════════════════════════════════

test('PER-01 写盘失败：appendOrdered 以原始 IO 错误拒绝，不再 resolve 掉', async () => {
  const { dir, file } = setup();
  const journal = Journal.open(file);
  await journal.append(launched); // 良前缀：launched 已落盘

  const restore = breakDir(dir);
  try {
    const promise = journal.appendOrdered(1, result(1, 'v1'));
    await assert.rejects(() => promise, isIoError);
    // 失败被记账（不是静默丢弃）
    assert.deepEqual(journal.writeFailures().map((failure) => failure.seq), [1]);
  } finally {
    restore();
  }

  // 良前缀没被半截文件污染
  await assert.rejects(() => journal.drain(), (error) => {
    assert.equal(error.name, 'JournalWriteError');
    assert.match(error.message, /1 line\(s\) not persisted/);
    assert.match(error.message, /seq 1/);
    assert.equal(error.failures.length, 1);
    return true;
  });
  assert.equal(journal.writeFailures().length, 1);
  assert.deepEqual(recordSeqs(file), ['launched']);
  assert.equal(journal.pendingCount(), 0);
});

test('PER-01 写盘失败：drain 必须先等内容全部落底再拒，不留下在飞的写', async () => {
  const { dir, file } = setup();
  const journal = Journal.open(file);
  await journal.append(launched);

  const restore = breakDir(dir);
  try {
    // 缓冲里压着两行（等 seq 1）
    const two = journal.appendOrdered(2, result(2, 'v2'));
    const three = journal.appendOrdered(3, result(3, 'v3'));
    assert.equal(journal.pendingCount(), 2);

    const one = journal.appendOrdered(1, result(1, 'v1'));
    const settled = await Promise.allSettled([one, two, three]);
    // 三行一起失败，且每一行的调用方都拿到拒绝——没有一个被 resolve 悄悄放过
    assert.deepEqual(settled.map((outcome) => outcome.status), ['rejected', 'rejected', 'rejected']);

    await assert.rejects(() => journal.drain(), (error) => {
      assert.equal(error.name, 'JournalWriteError');
      assert.deepEqual(error.failures.map((failure) => failure.seq), [1, 2, 3]);
      return true;
    });
  } finally {
    restore();
  }

  assert.equal(journal.pendingCount(), 0);
  assert.deepEqual(journal.writeFailures().map((failure) => failure.seq), [1, 2, 3]);
});

test('PER-01 无序行（append）写失败同样传播，并被 drain 记账', async () => {
  const { dir, file } = setup();
  const journal = Journal.open(file);
  const restore = breakDir(dir);
  try {
    await assert.rejects(() => journal.append(launched), isIoError);
    await assert.rejects(() => journal.drain(), (error) => {
      assert.equal(error.name, 'JournalWriteError');
      assert.match(error.message, /unordered record/);
      return true;
    });
  } finally {
    restore();
  }
  // 没有任何一行被假装写成
  assert.equal(fs.existsSync(file), false);
});

// ═══════════════════════════════════════════════════════════════
// 二、失败之后队列的明确语义：后续行照写、失败粘住、恢复才清零
// ═══════════════════════════════════════════════════════════════

test('PER-01 失败后：后续行照常落盘（单写者链不断），但 drain 仍拒（不假报成功）', async () => {
  const { dir, file } = setup();
  const journal = Journal.open(file);
  await journal.append(launched);

  const restore = breakDir(dir);
  try {
    await assert.rejects(() => journal.appendOrdered(1, result(1, 'v1')), isIoError);
  } finally {
    restore();
  }

  // 队列后续状态：链没有断，seq 2 照写；seq 1 的缺口留成"缺失段"
  await journal.appendOrdered(2, result(2, 'v2'));
  assert.deepEqual(recordSeqs(file), ['launched', 2]);

  // 结算侧每次都看到失败——粘性，不会被第二行写成功洗白
  await assert.rejects(() => journal.drain(), (error) => error.name === 'JournalWriteError');
  await assert.rejects(() => journal.drain(), (error) => error.name === 'JournalWriteError');

  // 恢复不能只检查 JSON 语法：seq 1 丢失意味着 seq 2 也是无效后缀，
  // 必须显式丢弃，不能洗白序号缺口。
  const report = await journal.truncateToGoodPrefix();
  assert.deepEqual(report, { kept: 1, dropped: 1 });
  assert.deepEqual(recordSeqs(file), ['launched']);
  assert.equal(journal.writeFailures().length, 0);
  await journal.drain();
  await journal.appendOrdered(1, result(1, 'v1-after-recovery'));
  await journal.appendOrdered(2, result(2, 'v2-after-recovery'));
  await journal.drain();
  assert.deepEqual(recordSeqs(file), ['launched', 1, 2]);
});

test('PER-01 flushPending 写失败也拒，不把待补行算成写过', async () => {
  const { dir, file } = setup();
  const journal = Journal.open(file);
  await journal.append(launched);

  const two = journal.appendOrdered(2, result(2, 'v2')); // 等 seq 1，压在缓冲里
  assert.equal(journal.pendingCount(), 1);

  const restore = breakDir(dir);
  try {
    await assert.rejects(() => journal.flushPending(), (error) => {
      assert.equal(error.name, 'JournalWriteError');
      return true;
    });
    await assert.rejects(() => two, isIoError);
  } finally {
    restore();
  }
  assert.equal(journal.pendingCount(), 0);
});

// ═══════════════════════════════════════════════════════════════
// 三、缓冲被判死的行必须收到拒绝（不许无限等一个不会来的落盘）
// ═══════════════════════════════════════════════════════════════

test('PER-01 截断把缓冲里的行判死：调用方拿到拒绝，不是悬挂 promise', async () => {
  const { file } = setup();
  const journal = Journal.open(file);
  await journal.append(launched);

  const held = journal.appendOrdered(2, result(2, 'v2')); // 等一个不会来的 seq 1
  assert.equal(journal.pendingCount(), 1);

  const report = await journal.truncateToGoodPrefix();
  assert.deepEqual(report, { kept: 1, dropped: 0 });
  await assert.rejects(() => held, (error) => {
    assert.equal(error.name, 'JournalWriteError');
    assert.match(error.message, /truncated to good prefix/);
    return true;
  });
  assert.equal(journal.pendingCount(), 0);
});

// ═══════════════════════════════════════════════════════════════
// 四、对照组：没有失败时 drain 照旧兑现、失败表为空
// ═══════════════════════════════════════════════════════════════

test('PER-01 对照：无失败时 drain 正常兑现，writeFailures 为空', async () => {
  const { file } = setup();
  const journal = Journal.open(file);
  await journal.append(launched);
  const one = journal.appendOrdered(1, result(1, 'v1'));
  const two = journal.appendOrdered(2, result(2, 'v2'));
  await Promise.all([one, two]);
  await journal.drain();
  assert.equal(journal.writeFailures().length, 0);
  assert.deepEqual(recordSeqs(file), ['launched', 1, 2]);
});

test('PER-01 JournalWriteError 可被调用方按 name/failures 识别（跨 realm 不靠 instanceof）', () => {
  const error = new JournalWriteError('boom', [{ seq: 3, cause: new Error('ENOSPC') }]);
  assert.equal(error.name, 'JournalWriteError');
  assert.equal(error.message, 'boom');
  assert.equal(error.failures.length, 1);
  assert.equal(error.failures[0].seq, 3);
  assert.ok(error instanceof Error);
});
