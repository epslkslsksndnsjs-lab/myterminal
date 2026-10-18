// Workflows PER-02（ADR-0052）：注册表 upsert 的单写者队列。
//
// 锁的是三件事，改了就红：
//   1. 同一文件的并发 upsert 严格串行——N 个不同 runId 同时在飞，最终注册表一条不少，
//      且第 k 个完成者拿到的全量正好是 k 条（证明是排队而不是"刚好没撞上"）；
//   2. 前一手失败不毒化队列——拒绝只归调用方，排在它后面的 upsert 照常执行；
//   3. 队列按 resolve 后的路径归并——同一文件的不同写法排同一条队。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readRegistry, upsertRegistry } from '../dist/workflows/registry.js';

const tempDirs = [];

function tempRegistryFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'per02-registry-'));
  tempDirs.push(dir);
  return path.join(dir, 'registry.json');
}

function entry(runId, extra = {}) {
  return {
    runId,
    status: 'running',
    ownerSessionId: 'sess_per02',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function runIds(registry) {
  return registry.runs.map((item) => item.runId);
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test('并发 upsert：多个不同 runId 同时在飞，最终一条不少', async () => {
  const file = tempRegistryFile();
  const ids = Array.from({ length: 24 }, (_, i) => `wf_per02_${String(i).padStart(2, '0')}`);

  // 同一刻全部发出：不排队的话，后写者各自基于同一份旧值落盘，先写者的条目被整片盖掉。
  const results = await Promise.all(ids.map((runId) => upsertRegistry(file, entry(runId))));

  const final = await readRegistry(file);
  assert.deepEqual([...runIds(final)].sort(), [...ids].sort(), '并发写丢了条目：注册表读-改-写没有串行');

  // 串行才有这个中间态序列：第 k 个完成者看到恰好 k 条（并发时会出现重复的 1、2…）。
  assert.deepEqual(
    results.map((registry) => registry.runs.length),
    ids.map((_, i) => i + 1),
    '每个 upsert 看到的旧值应逐个累加',
  );

  // 原子写纪律没被队列破坏：不留 .tmp 残留。
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '原子写留下了临时文件');
});

test('同一 runId 并发 upsert：最终只留一条（按条目更新，不追加）', async () => {
  const file = tempRegistryFile();
  const runId = 'wf_per02_same';

  await Promise.all([
    upsertRegistry(file, entry(runId, { startedAt: '2026-01-01T00:00:00.000Z' })),
    upsertRegistry(file, entry(runId, { startedAt: '2026-01-01T00:00:01.000Z' })),
    upsertRegistry(file, entry(runId, { startedAt: '2026-01-01T00:00:02.000Z', endedAt: '2026-01-01T00:00:09.000Z', status: 'completed' })),
  ]);

  const final = await readRegistry(file);
  assert.deepEqual(runIds(final), [runId], '同一 runId 的并发 upsert 应就地更新而不是重复追加');
});

test('前一手拒绝不毒化队列：排在后面的 upsert 照常执行', async () => {
  const file = tempRegistryFile();
  const poison = entry('wf_per02_poison');
  // 自引用：JSON.stringify 抛 TypeError，写盘必然失败（磁盘状态不变）。
  poison.self = poison;

  const failed = upsertRegistry(file, poison);
  // 同一刻登记的第二手：若队列把拒绝当成游标继承，它会跟着拒（或永远不跑）。
  const queued = upsertRegistry(file, entry('wf_per02_after_poison'));

  await assert.rejects(failed, TypeError, '写盘失败应原样抛给调用方');
  const written = await queued;
  assert.deepEqual(runIds(written), ['wf_per02_after_poison'], '前一手失败后，队列里的下一手必须照常执行');

  // 队列已排空：失败之后的新请求仍然正常。
  const afterDrain = await upsertRegistry(file, entry('wf_per02_after_drain'));
  assert.deepEqual([...runIds(afterDrain)].sort(), ['wf_per02_after_drain', 'wf_per02_after_poison']);
  assert.deepEqual([...runIds(await readRegistry(file))].sort(), ['wf_per02_after_drain', 'wf_per02_after_poison']);
});

test('队列按 resolve 后的路径归并：同一文件的不同写法共用一条队', async () => {
  const file = tempRegistryFile();
  // dir/./registry.json 与 dir/registry.json 指向同一文件，写法不同。
  const alias = path.join(path.dirname(file), '.', 'registry.json');
  assert.equal(path.resolve(alias), path.resolve(file));

  const ids = ['wf_per02_alias_a', 'wf_per02_alias_b', 'wf_per02_alias_c', 'wf_per02_alias_d', 'wf_per02_alias_e'];
  const results = await Promise.all(ids.map((runId, i) => upsertRegistry(i % 2 === 0 ? file : alias, entry(runId))));

  assert.deepEqual(
    results.map((registry) => registry.runs.length),
    ids.map((_, i) => i + 1),
    '同一文件的两种写法若分成两条队，就会各自从 1 开始',
  );
  assert.deepEqual([...runIds(await readRegistry(file))].sort(), [...ids].sort());
});
