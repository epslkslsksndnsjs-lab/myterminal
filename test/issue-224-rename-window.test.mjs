// Workflows T1（#224）补口：机器件的字段重命名双写窗口
//
// 票面 AC4 要求把"重命名走同一 schemaVersion 周期内新旧双写、读出优先新字段、
// 下一版删旧伴随升版"钉成文档化规则并各有测试（新旧双向）。
// 今天没有任何字段需要改名，所以窗口表是空的——本文件同时钉两件事：
// 空表时必须等于没这层（今天形状不变），以及规则本身在两向上都成立。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RENAMED_FIELDS,
  SCHEMA_VERSION,
  VersionMismatchError,
  withDualWrite,
  readWithRenameWindow,
} from '../dist/workflows/schema.js';
import { normalizeIndex, readIndex, writeIndex } from '../dist/workflows/run-index.js';
import { readRegistry, writeRegistry } from '../dist/workflows/registry.js';

let TMP;

function tempFile(name) {
  if (!TMP) TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-224rename-'));
  return path.join(TMP, name);
}

const RENAME = [{ field: 'status', previous: 'state' }];

function baseIndex(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: 'wf_a',
    status: 'completed',
    ownerSessionId: 's',
    scriptPath: 'p.js',
    sourceRef: { id: 'p.js', revision: 'r' },
    argsRecorded: false,
    startedAt: 't',
    dispatches: [],
    failures: [],
    tokens: { spent: 0 },
    ...overrides,
  };
}

afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

// ═══════════════════════════════════════════════════════════════
// 一、写侧：双写窗口
// ═══════════════════════════════════════════════════════════════

test('双写：新键有值时旧键同值并写，让上一发布版的读者仍读得到', () => {
  const record = { status: 'completed', runId: 'wf_a' };
  const written = withDualWrite(record, RENAME);
  assert.deepEqual(written, { status: 'completed', runId: 'wf_a', state: 'completed' });
  assert.equal('state' in record, false, '双写不改调用方的对象');
  assert.equal(written.schemaVersion, undefined, '窗口不升版本——它还在同一个周期内');
});

test('双写：新键缺位就不写旧键（绝不制造 undefined 假字段）', () => {
  assert.deepEqual(withDualWrite({ runId: 'wf_a' }, RENAME), { runId: 'wf_a' });
  const ghost = withDualWrite({ status: undefined }, RENAME);
  assert.equal('state' in ghost, false, '新键缺位就不带旧键');
  assert.equal(JSON.stringify(ghost), '{}', '落盘形态里两个键都不存在');
  assert.deepEqual(withDualWrite({ status: null }, RENAME), { status: null, state: null }, 'null 是合法值，照样双写');
});

test('双写：同名字段只留一份，重复条目不叠加', () => {
  const written = withDualWrite({ status: 'failed' }, [{ field: 'status', previous: 'state' }, { field: 'status', previous: 'state' }]);
  assert.deepEqual(written, { status: 'failed', state: 'failed' });
});

// ═══════════════════════════════════════════════════════════════
// 二、读侧：优先新、抬升旧、两缺不造
// ═══════════════════════════════════════════════════════════════

test('读出优先新字段：两键并存且不同时以新键为准，并显式记账冲突', () => {
  const read = readWithRenameWindow({ status: 'completed', state: 'cancelled' }, RENAME);
  assert.equal(read.value.status, 'completed', '新键赢');
  assert.deepEqual(read.lifted, [], '新键在场就不算抬升');
  assert.deepEqual(read.conflicts, ['status'], '两键打架必须留名，不许静默挑一个');
});

test('新码读旧产物：只有旧键时抬升为新键并记源', () => {
  const read = readWithRenameWindow({ state: 'failed' }, RENAME);
  assert.equal(read.value.status, 'failed', '旧产物的值读得到');
  assert.deepEqual(read.lifted, ['status']);
  assert.equal('state' in read.value, false, '抬升后按新形状交给上层，不留双份');
  assert.deepEqual(read.conflicts, []);
});

test('两键都缺：不凭空造字段（additive 缺省由各自归一处理）', () => {
  const read = readWithRenameWindow({ runId: 'wf_a' }, RENAME);
  assert.deepEqual(read.value, { runId: 'wf_a' });
  assert.deepEqual(read.lifted, []);
  assert.deepEqual(read.conflicts, []);
});

test('空表（今天的真实形状）：窗口等于不存在，读写原样过去', () => {
  const record = { status: 'completed', runId: 'wf_a' };
  assert.deepEqual(withDualWrite(record, []), record);
  const read = readWithRenameWindow(record, []);
  assert.deepEqual(read.value, record);
  assert.deepEqual(read.lifted, []);
  assert.deepEqual(read.conflicts, []);
  for (const table of Object.values(RENAMED_FIELDS)) {
    assert.deepEqual(table, [], '本票没有需要改名的字段；表若非空就必须有对应的双写测试');
  }
});

test('窗口不削弱 fail-closed：版本超前照旧拒，旧产物照旧可读', () => {
  assert.throws(() => normalizeIndex({ schemaVersion: SCHEMA_VERSION + 1, status: 'completed' }, SCHEMA_VERSION, RENAME), VersionMismatchError);
  const older = normalizeIndex({ schemaVersion: 1, runId: 'wf_old', status: 'completed', ownerSessionId: 's', scriptPath: 'o.js', sourceRef: { id: 'o.js', revision: 'r' }, argsRecorded: false, startedAt: 't', dispatches: [], tokens: { spent: 0 } }, SCHEMA_VERSION, RENAME);
  assert.equal(older.runId, 'wf_old');
  assert.deepEqual(older.failures, [], '老产物的缺字段仍按缺省补，不因窗口而变');
});

test('旧码读新产物同样拒（双向的第二向由 readerVersion 承载）', () => {
  const future = { schemaVersion: SCHEMA_VERSION + 1, runId: 'wf_a', status: 'completed' };
  assert.throws(() => normalizeIndex(future, SCHEMA_VERSION, RENAME), /schema version mismatch/);
  assert.equal(normalizeIndex({ ...future, schemaVersion: SCHEMA_VERSION + 1 }, SCHEMA_VERSION + 1, RENAME).runId, 'wf_a', '同一份产物对认识它的读者可读');
});

// ═══════════════════════════════════════════════════════════════
// 三、接线：索引与注册表真的走这套
// ═══════════════════════════════════════════════════════════════

test('索引落盘走双写、读回走优先新（带临时表，证明接的不是空转）', async () => {
  const file = tempFile('index.json');
  await writeIndex(file, baseIndex(), RENAME);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.status, 'completed');
  assert.equal(raw.state, 'completed', '旧键随新键一起在场');
  assert.equal(raw.schemaVersion, SCHEMA_VERSION, '双写窗口不 bump 版本');

  const read = await readIndex(file, SCHEMA_VERSION, RENAME);
  assert.equal(read.status, 'completed');

  // 只有旧键的产物（上一发布版写的）：新码照样读得到
  fs.writeFileSync(file, JSON.stringify({ ...raw, state: 'failed', status: undefined }), 'utf8');
  const lifted = await readIndex(file, SCHEMA_VERSION, RENAME);
  assert.equal(lifted.status, 'failed', '新码读旧产物：从旧键抬升');
});

test('默认表为空：索引读写不因窗口多写一个键', async () => {
  const file = tempFile('index-default.json');
  await writeIndex(file, baseIndex());
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), Object.keys(baseIndex()).sort(), '今天写出去的就是今天读回来的形状');
  assert.equal('state' in raw, false);
  assert.equal((await readIndex(file)).status, 'completed');
});

test('注册表同样接线：双写落盘、旧产物抬升', async () => {
  const file = tempFile('registry.json');
  const renames = [{ field: 'status', previous: 'state' }];
  await writeRegistry(file, { schemaVersion: SCHEMA_VERSION, runs: [{ runId: 'wf_a', status: 'completed', ownerSessionId: 's', startedAt: 't', endedAt: 'u' }] }, renames);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.runs[0].state, 'completed', '每条记录都随新键带一份旧键');
  const registry = await readRegistry(file, SCHEMA_VERSION, renames);
  assert.equal(registry.runs[0].status, 'completed');

  fs.writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, runs: [{ runId: 'wf_b', state: 'failed', ownerSessionId: 's', startedAt: 't', endedAt: 'u' }] }), 'utf8');
  const lifted = await readRegistry(file, SCHEMA_VERSION, renames);
  assert.equal(lifted.runs[0].status, 'failed', '旧注册表条目照样读得到');
});

test('默认表下注册表读写形状不变（空表等于不存在）', async () => {
  const file = tempFile('registry-default.json');
  await writeRegistry(file, { schemaVersion: SCHEMA_VERSION, runs: [{ runId: 'wf_a', status: 'running', ownerSessionId: 's', startedAt: 't' }] });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal('state' in raw.runs[0], false);
  assert.equal((await readRegistry(file)).runs[0].status, 'running');
});
