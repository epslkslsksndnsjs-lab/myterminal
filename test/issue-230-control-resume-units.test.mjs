// Workflows T7（#230）单元：缓存重放投影 / resume 排他锁 / 取消工具面契约
//
// 覆盖（对应 #230 的单元级验收）：
//   AC5/AC6  缓存 = journal 重放投影：只有"最终为 result"的键可复用；started/failed 作废同键
//   AC4      resume 排他锁：独占、他人存活拒、死锁/复用 pid 由 pid+epoch 判定接管、读不出拒
//   AC1/AC10 workflow_cancel 描述三句逐字、schema 形状、GPT 面不含 pause 入口、错误码归类
//
// 测试方式：直调 dist/workflows/{cache,lock}.js（纯函数 + 真 fs）+ 直调工具条目契约。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildReplayCache, replayChainSeed, retainedCompletedKeys } from '../dist/workflows/cache.js';
import { acquireResumeLock, releaseResumeLock, isLockStale } from '../dist/workflows/lock.js';
import { argsChainSeed, deriveAgentKey } from '../dist/workflows/keys.js';
import { BUILTIN_INPUT_SCHEMAS } from '../dist/tool-schemas.js';
import { validateStartArgs, mapStartError } from '../dist/workflows/start.js';
import { WorkflowStartError } from '../dist/workflows/engine.js';
import { createBuiltinTools } from '../dist/core-tools.js';
import { MyTerminalStore } from '../dist/store.js';

const TMP = [];

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-230-'));
  TMP.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  for (const dir of TMP.splice(0)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
});

// ═══════════════════════════════════════════════════════════════
// 缓存重放投影（§17：存储单位 = 每条调用结果；failed/在飞不进缓存；last-write-wins）
// ═══════════════════════════════════════════════════════════════

const rec = (o) => ({ version: 1, at: '2026-01-01T00:00:00.000Z', ...o });
const RES = 'v2:' + 'a'.repeat(64);
const OTHER = 'v2:' + 'b'.repeat(64);

test('缓存：result 行进缓存、按 key 取回值', () => {
  const cache = buildReplayCache([rec({ type: 'started', seq: 1, key: RES }), rec({ type: 'result', seq: 1, key: RES, value: { answer: 42 } })]);
  assert.equal(cache.has(RES), true);
  assert.deepEqual(cache.get(RES), { answer: 42 });
  assert.equal(cache.size, 1);
});

test('缓存：在飞路（只有 started 无 result）不进缓存', () => {
  const cache = buildReplayCache([rec({ type: 'started', seq: 1, key: RES })]);
  assert.equal(cache.has(RES), false, '被断路没有 result，续跑要从它起重跑');
  assert.equal(cache.size, 0);
});

test('缓存：失败路的 result 行不进缓存（§17）', () => {
  const cache = buildReplayCache([
    rec({ type: 'started', seq: 1, key: RES }),
    rec({ type: 'failed', seq: 1, key: RES, error: { kind: 'stalled', message: 'no progress' } }),
  ]);
  assert.equal(cache.has(RES), false, 'failed 行不作废即误复用失败');
});

test('缓存：同名键后到的 started/failed 作废旧 result（last-write-wins，重试语义）', () => {
  const cache = buildReplayCache([
    rec({ type: 'result', seq: 1, key: RES, value: 'first' }),
    rec({ type: 'started', seq: 1, key: RES }),
  ]);
  assert.equal(cache.has(RES), false, '后一张 started 把旧结果作废——这一路正被重跑');
  const cache2 = buildReplayCache([
    rec({ type: 'result', seq: 1, key: RES, value: 'first' }),
    rec({ type: 'failed', seq: 1, key: RES, error: { kind: 'error', message: 'boom' } }),
  ]);
  assert.equal(cache2.has(RES), false);
});

test('缓存：无 key 的记录（launched / 裸 started）被跳过，不污染投影', () => {
  const cache = buildReplayCache([
    rec({ type: 'launched', runId: 'wf_x' }),
    rec({ type: 'started', seq: 1 }),
    rec({ type: 'result', seq: 2, key: RES, value: 'v' }),
  ]);
  assert.equal(cache.size, 1);
  assert.equal(cache.has(RES), true);
});

test('缓存：result 值为 null 仍算命中（沉默与成功值两回事，按 has 判定）', () => {
  const cache = buildReplayCache([rec({ type: 'result', seq: 1, key: RES, value: null })]);
  assert.equal(cache.has(RES), true, 'completed-but-null 也是结算出来的结果');
});

test('retainedCompletedKeys：只挑出良前缀里"可复用结果"的键', () => {
  const records = [
    rec({ type: 'started', seq: 1, key: RES }),
    rec({ type: 'result', seq: 1, key: RES, value: 'a' }),
    rec({ type: 'started', seq: 2, key: OTHER }), // 在飞被打断，无 result
  ];
  const keepable = retainedCompletedKeys(records);
  assert.equal(keepable.has(RES), true);
  assert.equal(keepable.has(OTHER), false);
});

test('replayChainSeed：续跑起点 = args 种子，与首跑同串（改 args 即全量重跑的根）', () => {
  assert.equal(replayChainSeed(undefined), argsChainSeed(undefined));
  assert.notEqual(replayChainSeed({ x: 1 }), replayChainSeed({ x: 2 }), 'args 变 → 种子变 → 全链错位');
  assert.equal(
    deriveAgentKey(replayChainSeed(undefined), 'p', '{}'),
    deriveAgentKey(argsChainSeed(undefined), 'p', '{}'),
    '续跑第 1 路键与首跑第 1 路键逐字节相同（重放对齐的前提）',
  );
});

// ═══════════════════════════════════════════════════════════════
// resume 排他锁（§17：owner pid + epoch；崩溃接管；读不出拒）
// ═══════════════════════════════════════════════════════════════

function probe(pid, epoch, alivePids) {
  const set = alivePids instanceof Set ? alivePids : new Set(alivePids ?? []);
  return { pid, epoch, isAlive: (p) => set.has(p), now: () => 1_700_000_000_000, iso: () => '2026-01-01T00:00:00.000Z' };
}

test('锁：空闲即独占取到', async () => {
  const file = tempFile('resume.lock');
  const got = await acquireResumeLock(file, 'sess-a', probe(100, 1, [100]));
  assert.equal(got.ok, true);
  assert.equal(got.record.pid, 100);
  assert.equal(got.record.epoch, 1);
});

test('锁：他人存活持着 → 第二个被拒（双会话同 runId 第二拒）', async () => {
  const file = tempFile('resume.lock');
  await acquireResumeLock(file, 'sess-a', probe(100, 1, [100, 200]));
  const second = await acquireResumeLock(file, 'sess-b', probe(200, 1, [100, 200]));
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'held');
  assert.equal(second.holder.pid, 100);
});

test('锁：持有者进程已死 → 可接管（崩溃后同 runId 续跑）', async () => {
  const file = tempFile('resume.lock');
  await acquireResumeLock(file, 'sess-a', probe(100, 1, [100]));
  // 100 号进程没了（alivePids 不含 100）
  const takeover = await acquireResumeLock(file, 'sess-b', probe(200, 1, [200]));
  assert.equal(takeover.ok, true, '死锁不挡接管');
});

test('锁：pid 复用窗口由 epoch 兜底——同 pid 更低 epoch 判失效，更高即接管', async () => {
  const file = tempFile('resume.lock');
  await acquireResumeLock(file, 'sess-a', probe(100, 5, [100]));
  // pid 100 仍"存活"（被复用），但当前实例 epoch 更高 → 旧锁判失效
  const reused = await acquireResumeLock(file, 'sess-a', probe(100, 9, [100]));
  assert.equal(reused.ok, true, 'pid 复用：epoch 单调兜底，接管');
});

test('锁：同 pid 同 epoch 是"我自己还持着" → 幂等拒重复占（不双持）', async () => {
  const file = tempFile('resume.lock');
  await acquireResumeLock(file, 'sess-a', probe(100, 7, [100]));
  const again = await acquireResumeLock(file, 'sess-a', probe(100, 7, [100]));
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'held');
});

test('isLockStale：三条判据各自成立', () => {
  const alive = (p) => p === 100;
  assert.equal(isLockStale({ pid: 999, epoch: 1, at: '', ownerSessionId: 'x' }, { pid: 100, epoch: 1 }, alive), true, 'pid 不在 → 失效');
  assert.equal(isLockStale({ pid: 100, epoch: 1, at: '', ownerSessionId: 'x' }, { pid: 100, epoch: 2 }, alive), true, '同 pid 更低 epoch → 复用，失效');
  assert.equal(isLockStale({ pid: 100, epoch: 2, at: '', ownerSessionId: 'x' }, { pid: 100, epoch: 2 }, alive), false, '同 pid 同 epoch → 我自己持，有效');
  assert.equal(isLockStale({ pid: 100, epoch: 5, at: '', ownerSessionId: 'x' }, { pid: 100, epoch: 4 }, alive), false, '同 pid 更高 epoch → 有效（不误接自己的新锁）');
});

test('锁：读不出来的锁 fail-closed 拒接管（误判成失效会双跑）', async () => {
  const file = tempFile('resume.lock');
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const got = await acquireResumeLock(file, 'sess-b', probe(200, 1, [200]));
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'unreadable');
});

test('锁：释放只放自己那一把（pid+epoch 对得上）', async () => {
  const file = tempFile('resume.lock');
  await acquireResumeLock(file, 'sess-a', probe(100, 1, [100, 200]));
  const wrongOwner = await releaseResumeLock(file, { pid: 200, epoch: 1 });
  assert.equal(wrongOwner.released, false, '拿别人的锁释放是结构性错误，不放');
  assert.equal(fs.existsSync(file), true, '锁仍在');
  const mine = await releaseResumeLock(file, { pid: 100, epoch: 1 });
  assert.equal(mine.released, true);
  assert.equal(fs.existsSync(file), false);
});

// ═══════════════════════════════════════════════════════════════
// workflow_cancel 工具面契约：描述三句逐字 + schema 形状 + 面分账（无 pause 入口）
// ═══════════════════════════════════════════════════════════════

function makeConfig(workspaceDir, stateDir) {
  return {
    settingsPath: path.join(stateDir, 'settings.json'), workspaceDir, stateDir,
    host: '127.0.0.1', port: 8787, connectorKey: 'k'.repeat(32), actionsToken: 't'.repeat(32),
    publicBaseUrl: 'http://127.0.0.1:8787', maxOutputChars: 4000, commandTimeoutSec: 120,
    uiLanguage: 'en', uiTheme: 'dark', passiveLockEnabled: false, actionsContinuationMode: 'off', nonBlockingTasksEnabled: false,
  };
}

function toolHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-230-tools-'));
  TMP.push(dir);
  const workspaceDir = path.join(dir, 'workspace');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const store = new MyTerminalStore(stateDir);
  const tools = createBuiltinTools(makeConfig(workspaceDir, stateDir), store);
  return { tools, store };
}

test('workflow_cancel 描述 = 三句逐字（每句承载一个适用理由），与 MCP 对外版互不混用', () => {
  const { tools } = toolHarness();
  const desc = tools.get('workflow_cancel').description;
  assert.equal(desc.trim(), 'Cancel a running workflow run started by this session. Idempotent; a terminal run returns its current status. The reducer will report partial results.');
  // 三句各一理由：归属前置 / 防把"已终态"误判成错误 / 防重复催结果。
  assert.ok(desc.includes('started by this session'), '① 适用对象 + 归属前置');
  assert.ok(desc.includes('a terminal run returns its current status'), '② 幂等语义');
  assert.ok(desc.includes('The reducer will report partial results'), '③ 取消 ≠ 无结果');
});

test('workflow_cancel schema：参数仅 runId，required runId，additionalProperties false', () => {
  const schema = BUILTIN_INPUT_SCHEMAS.workflow_cancel;
  assert.deepEqual(Object.keys(schema.properties), ['runId']);
  assert.deepEqual(schema.required, ['runId']);
  assert.equal(schema.additionalProperties, false);
});

test('workflow_cancel 注解镜像 subagent_abort（safeLocalMutation 集）', () => {
  const { tools } = toolHarness();
  const cancel = tools.get('workflow_cancel').annotations;
  const abort = tools.get('subagent_abort').annotations;
  assert.deepEqual(cancel, abort, 'ADR-0052 §23②：注解集镜像既有 abort 先例');
});

test('GPT 面（root 工具清单）不含任何 pause / resume 入口（负向断言）', () => {
  const { tools } = toolHarness();
  for (const banned of ['workflow_pause', 'workflow_resume', 'workflow_status', 'workflow_list']) {
    assert.equal(tools.has(banned), false, `${banned} 不得出现在 root 工具清单`);
  }
  const wfNames = [...tools.keys()].filter((n) => n.startsWith('workflow_')).sort();
  assert.deepEqual(wfNames, ['workflow_cancel', 'workflow_start']);
});

test('workflow_cancel 走 mapStartError 归类：VALIDATION→EXTENSION_ERROR，FORBIDDEN/NOT_FOUND 原样', () => {
  assert.equal(mapStartError(new WorkflowStartError('VALIDATION', 'r', 'm')).code, 'EXTENSION_ERROR');
  assert.equal(mapStartError(new WorkflowStartError('FORBIDDEN', 'run-not-owned', 'm')).code, 'FORBIDDEN');
  assert.equal(mapStartError(new WorkflowStartError('NOT_FOUND', 'run-not-found', 'm')).code, 'NOT_FOUND');
  assert.equal(mapStartError(new Error('plain')), undefined);
});

test('validateStartArgs 仍是三互斥形态（cancel 是独立工具，不并入 start，§19）', () => {
  assert.deepEqual(validateStartArgs({ script: 'x' }), { ok: true, form: 'inline' });
  assert.deepEqual(validateStartArgs({ scriptPath: '/a.js', resumeFromRunId: 'wf_abc' }), { ok: true, form: 'resume' });
  // cancel 的参数不该让 start 的互斥矩阵变四选一
  const bad = validateStartArgs({ script: 'x', resumeFromRunId: 'wf_abc' });
  assert.equal(bad.ok, false);
});
