// Workflows T1（#224）：run 骨架的单元面（与 issue-224-run-skeleton.test.mjs 同为契约级）
//
// 这一份锁的是"每个零件自己的行为边界"：账本截断、快照只认终态、注册表裁剪、
// 沙箱的三条边界、扫描器的掩蔽规则、saved 的命名与不覆盖纪律、续跑的闸门。
// 行覆盖高而断言弱不算数——每条断言都是"改了就红"的契约。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkflowEngine, WorkflowStartError } from '../dist/workflows/engine.js';
import { virtualClock, systemClock } from '../dist/workflows/clock.js';
import { Journal } from '../dist/workflows/journal.js';
import { isTerminal, isActive, readMachineRecord, withSchemaVersion, VersionMismatchError, SCHEMA_VERSION, MAX_RETAINED_TERMINAL_RUNS } from '../dist/workflows/schema.js';
import { normalizeIndex, readIndex, writeIndex } from '../dist/workflows/run-index.js';
import { hasSnapshot, readSnapshot, writeSnapshot } from '../dist/workflows/snapshot.js';
import { readRegistry, upsertRegistry, writeRegistry } from '../dist/workflows/registry.js';
import { ensureDir, exists, readLines, replaceLinesAtomic, appendLine, readJson, writeJsonAtomic } from '../dist/workflows/atomic.js';
import { describeViolations, scanDeterminism } from '../dist/workflows/lint.js';
import { runInSandbox } from '../dist/workflows/sandbox.js';
import { persistScript, loadScript, scriptMetaName, SCRIPT_NAME_PATTERN } from '../dist/workflows/saved.js';
import { workflowPaths, runPaths, isInsideSavedRoot, managedRootFor } from '../dist/workflows/paths.js';
import { WorkflowEvents } from '../dist/workflows/events.js';
import { workflowAuditSink, validateStartArgs } from '../dist/workflows/start.js';
import { MyTerminalStore } from '../dist/store.js';

const SCRIPT = `const v = await agent('go');\nreturn v;`;

let TMP;

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-224u-'));
  TMP = dir;
  const workspaceDir = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { workspaceDir, managedRoot: path.join(workspaceDir, '.myterminal'), paths: workflowPaths(path.join(workspaceDir, '.myterminal')) };
}

function engine(workspaceDir, managedRoot, extra = {}) {
  const auditLog = extra.auditLog ?? [];
  return new WorkflowEngine({
    workspaceDir,
    managedRoot,
    clock: extra.clock ?? virtualClock(),
    audit: (entry) => auditLog.push(entry),
    adapterFactory: extra.adapterFactory ?? (() => ({ complete: async () => ({ text: 'ok', outputTokens: 2 }) })),
    ...(extra.events ? { events: extra.events } : {}),
    ...(extra.thresholds ? { thresholds: extra.thresholds } : {}),
  });
}

afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

// ── schema：状态判定与版本闸 ──────────────────────────────────

test('schema 状态判定：终态正向枚举、活跃白名单，新状态不静默归类', () => {
  for (const status of ['completed', 'failed', 'cancelled']) assert.equal(isTerminal(status), true);
  for (const status of ['running', 'pausing', 'paused']) assert.equal(isTerminal(status), false);
  for (const status of ['running', 'pausing', 'paused']) assert.equal(isActive(status), true, `${status} 计入活跃`);
  assert.equal(isTerminal('weird-new-status'), false, '未知状态不被当成终态');
  assert.equal(isActive('weird-new-status'), false, '未知状态不被当成活跃');
  assert.equal(withSchemaVersion({ a: 1 }).schemaVersion, SCHEMA_VERSION);
  assert.equal(withSchemaVersion({ a: 1 }, 7).schemaVersion, 7);
});

test('schema 版本闸：合格放行、缺版本/超前/非整数一律拒', () => {
  assert.deepEqual(readMachineRecord({ schemaVersion: 1 }, 1, 'x'), { schemaVersion: 1 });
  assert.deepEqual(readMachineRecord({ schemaVersion: 1 }, 3, 'x'), { schemaVersion: 1 }, '旧产物对新码可读');
  for (const bad of [undefined, null, [], 'x', {}, { schemaVersion: 0 }, { schemaVersion: 1.5 }, { schemaVersion: '1' }, { schemaVersion: 2 }]) {
    assert.throws(() => readMachineRecord(bad, 1, 'probe'), VersionMismatchError, `应拒：${JSON.stringify(bad)}`);
  }
  assert.throws(() => readMachineRecord({ schemaVersion: 2 }, 1, 'probe'), /found 2, reader understands up to 1/);
});

// ── 索引归一：additive 缺省与逐字段清洗 ────────────────────────

test('run-index 归一：脏字段按缺省清洗，坏条目整体丢弃', () => {
  const index = normalizeIndex({
    schemaVersion: 1,
    runId: 42,
    status: 'completed',
    ownerSessionId: null,
    scriptPath: 7,
    sourceRef: { id: 1, revision: 2 },
    dispatches: [
      { id: 'd0001', label: 'a', status: 'completed', attempts: 3, startedAt: 't', endedAt: 'u', outputTokens: 9, result: 'r' },
      { id: 'd0002', status: 'running' },
      'garbage',
      null,
    ],
    tokens: { spent: 'x' },
  });
  assert.equal(index.runId, '');
  assert.equal(index.ownerSessionId, '');
  assert.equal(index.scriptPath, '');
  assert.deepEqual(index.sourceRef, { id: '', revision: '' });
  assert.equal(index.tokens.spent, 0);
  assert.equal(index.dispatches.length, 2, '坏条目被丢弃');
  assert.equal(index.dispatches[0].attempts, 3);
  assert.equal(index.dispatches[0].result, 'r');
  assert.equal(index.dispatches[1].status, 'running', '未知状态按 running 处理');
  assert.equal(index.dispatches[1].attempts, 1);
  assert.equal(index.dispatches[1].label, 'workflow-agent', '缺 label 有缺省');
  assert.equal('endedAt' in index.dispatches[1], false, '缺 endedAt 不凭空造');
});

// ── 快照：只认终态 ────────────────────────────────────────────

test('snapshot 只认终态：活跃写被拒，读回非终态被拒', async () => {
  const { paths } = temp();
  const run = runPaths(paths, 'wf_abc');
  const running = { schemaVersion: 1, runId: 'wf_abc', status: 'running', ownerSessionId: 's', scriptPath: 'x.js', sourceRef: { id: 'x.js', revision: 'r' }, argsRecorded: false, startedAt: 't', dispatches: [], tokens: { spent: 0 } };
  await assert.rejects(() => writeSnapshot(run.snapshotFile, running), /not terminal/);
  const done = { ...running, status: 'completed', endedAt: 'u' };
  await writeSnapshot(run.snapshotFile, done);
  assert.equal(await hasSnapshot(run.snapshotFile), true);
  assert.equal((await readSnapshot(run.snapshotFile)).status, 'completed');
  assert.equal(await readSnapshot(path.join(run.dir, 'missing.json')), undefined);
  fs.writeFileSync(path.join(run.dir, 'bad.json'), JSON.stringify({ schemaVersion: 1, runId: 'x', status: 'running' }), 'utf8');
  await assert.rejects(() => readSnapshot(path.join(run.dir, 'bad.json')), /not terminal/);
});

// ── journal：单写者、截断至最长良前缀、丢弃记账 ─────────────────

test('journal 单写者按行追加：并发写不交错，每行是完整 JSON', async () => {
  const { paths } = temp();
  const run = runPaths(paths, 'wf_abc');
  const journal = Journal.open(run.journalFile);
  await Promise.all([
    journal.append({ type: 'started', seq: 1, at: 'a' }),
    journal.append({ type: 'started', seq: 2, at: 'b' }),
    journal.append({ type: 'started', seq: 3, at: 'c' }),
  ]);
  await journal.drain();
  const lines = await readLines(run.journalFile);
  assert.equal(lines.length, 3);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.deepEqual((await journal.read()).map((r) => r.seq), [1, 2, 3]);
  assert.equal((await Journal.open(path.join(run.dir, 'missing.jsonl')).read()).length, 0);
});

test('journal 截断至最长良前缀并记账（撕裂尾行与中间损坏同规则）', async () => {
  const { paths } = temp();
  const run = runPaths(paths, 'wf_abc');
  const journal = Journal.open(run.journalFile);
  await journal.append({ type: 'launched', runId: 'wf_abc', at: 'a' });
  await journal.append({ type: 'started', seq: 1, at: 'b' });
  await journal.drain();
  fs.appendFileSync(run.journalFile, '{"broken":\n', 'utf8');
  const report = await journal.truncateToGoodPrefix();
  assert.deepEqual(report, { kept: 2, dropped: 1 }, '丢弃段显式记账');
  assert.equal((await readLines(run.journalFile)).length, 2);
  const clean = await Journal.open(path.join(run.dir, 'clean.jsonl')).truncateToGoodPrefix();
  assert.deepEqual(clean, { kept: 0, dropped: 0 });
});

// ── 原子写与盘面卫生 ──────────────────────────────────────────

test('atomic：整文件替换、逐行读、存在性判定、建目录', async () => {
  const dir = path.join(temp().workspaceDir, 'io');
  await ensureDir(path.join(dir, 'a', 'b'));
  assert.ok(fs.existsSync(path.join(dir, 'a', 'b')));
  const file = path.join(dir, 'lines.jsonl');
  assert.deepEqual(await readLines(file), [], '缺失文件 = 空账，不是错误');
  await appendLine(file, '{"a":1}');
  await appendLine(file, '{"a":2}');
  assert.deepEqual(await readLines(file), ['{"a":1}', '{"a":2}']);
  await replaceLinesAtomic(file, ['{"a":1}']);
  assert.deepEqual(await readLines(file), ['{"a":1}']);
  await replaceLinesAtomic(file, []);
  assert.equal(fs.readFileSync(file, 'utf8'), '', '空账留 0 字节文件');
  assert.equal(await exists(file), true);
  assert.equal(await exists(path.join(dir, 'nope')), false);
  assert.deepEqual(await readJson(path.join(dir, 'nope')), undefined);
});

// ── 确定性扫描：掩蔽规则 ──────────────────────────────────────

test('lint 掩蔽：字符串与注释不算违例，模板串与转义不误伤', () => {
  assert.deepEqual(scanDeterminism(''), []);
  assert.deepEqual(scanDeterminism('const a = 1; return a;'), []);
  assert.deepEqual(scanDeterminism('const s = `Date.now() ${x}`; return s;'), []);
  assert.deepEqual(scanDeterminism("const s = 'Math.random()'; return s;"), []);
  assert.deepEqual(scanDeterminism('/* new Date() */ return 1;'), []);
  assert.deepEqual(scanDeterminism('const s = "a\\"Date.now()"; return s;'), []);
  assert.deepEqual(scanDeterminism('const t = new Date; return t;'), [], '不带括号的裸构造不算（需成对括号）');
  assert.deepEqual(scanDeterminism('const t = new Date(); return t;').map((v) => v.literal), ['new Date()']);
  assert.deepEqual(scanDeterminism('Date . UTC(1)').map((v) => v.literal), ['Date.UTC()'], '点号与空白极宽松');
  assert.deepEqual(scanDeterminism('const x = obj.Date.now(); return x;'), [], '成员访问不算调用');
  const many = scanDeterminism('Date.now();Date.now();Date.now();Date.now();Date.now();Date.now();');
  assert.equal(many.length, 6);
  assert.match(describeViolations(many), /and 1 more/);
  assert.equal(describeViolations([]), '');
});

// ── 沙箱：三条边界 ────────────────────────────────────────────

test('sandbox 边界：无 Date / 无 Math.random / 返回值 JSON 复活', async () => {
  let seen = null;
  const outcome = await runInSandbox({
    source: 'return { ok: true, n: 1 };',
    args: { target: 'x' },
    host: { agent: async (prompt) => { seen = prompt; return 'agent-text'; } },
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.value, { ok: true, n: 1 });
  assert.equal(outcome.logs.length, 0);

  const usesArgs = await runInSandbox({ source: 'return args.target;', args: { target: 'hello' }, host: { agent: async () => 'x' } });
  assert.equal(usesArgs.value, 'hello');

  const callsAgent = await runInSandbox({ source: "const r = await agent('ping', {label:'a'}); return r;", host: { agent: async (prompt) => { seen = prompt; return 'agent-text'; } } });
  assert.equal(callsAgent.value, 'agent-text');
  assert.equal(seen, 'ping');

  const parallel = await runInSandbox({ source: "const [a, b] = await parallel([async () => 1, async () => 2]); return a + b;", host: { agent: async () => 'x' } });
  assert.equal(parallel.value, 3);

  const badParallel = await runInSandbox({ source: 'return await parallel("nope");', host: { agent: async () => 'x' } });
  assert.equal(badParallel.ok, false);
  assert.equal(badParallel.kind, 'runtime');

  const logging = await runInSandbox({ source: "log('l1'); phase('p1'); phase('p1'); return 1;", host: { agent: async () => 'x' } });
  assert.deepEqual(logging.logs, ['l1']);
  assert.deepEqual(logging.phases, ['p1'], '连续相同 phase 折叠');

  const noDate = await runInSandbox({ source: 'return Date.now();', host: { agent: async () => 'x' } });
  assert.equal(noDate.ok, false);
  assert.match(noDate.message, /Date is not available/);

  const noRandom = await runInSandbox({ source: 'return Math.random();', host: { agent: async () => 'x' } });
  assert.equal(noRandom.ok, false);
  assert.match(noRandom.message, /Math.random\(\) is not available/);

  const mathStillWorks = await runInSandbox({ source: 'return Math.max(1, 2);', host: { agent: async () => 'x' } });
  assert.equal(mathStillWorks.value, 2);

  const unserializable = await runInSandbox({ source: 'return { f: () => 1, u: undefined };', host: { agent: async () => 'x' } });
  assert.deepEqual(unserializable.value, {});
});

test('sandbox 编译错误与同步超时各有归类，不混为运行时失败', async () => {
  const compile = await runInSandbox({ source: 'return (((;', host: { agent: async () => 'x' } });
  assert.equal(compile.ok, false);
  assert.equal(compile.kind, 'compile');
  const blocked = await runInSandbox({ source: 'while (true) {}', host: { agent: async () => 'x' }, timeoutMs: 50 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.kind, 'timeout');
});

// ── saved：命名与不覆盖 ───────────────────────────────────────

test('saved 命名：meta.name 优先、非法名退回 runId、同名不同内容不覆盖', async () => {
  const { paths } = temp();
  const withMeta = `export const meta = { name: 'research-pass' };\nreturn 1;`;
  assert.equal(scriptMetaName(withMeta), 'research-pass');
  assert.equal(scriptMetaName('export const meta = { name: "Bad Name" };'), undefined, '非法命名退回缺省');
  assert.equal(scriptMetaName('const meta = { name: "x" };'), undefined, '非 export 不认');
  assert.equal(scriptMetaName('return 1;'), undefined);
  assert.equal(SCRIPT_NAME_PATTERN.test('a'), true);
  assert.equal(SCRIPT_NAME_PATTERN.test('1abc'), false);

  const first = await persistScript(paths, withMeta, 'wf_deadbeef');
  assert.equal(first.name, 'research-pass');
  assert.equal(first.path, path.join(paths.savedRoot, 'research-pass.js'));
  assert.equal(first.sourceRef.id, 'research-pass.js');
  assert.equal(first.sourceRef.revision.length, 16);

  const same = await persistScript(paths, withMeta, 'wf_other');
  assert.equal(same.path, first.path, '同内容同名 → 复用同一文件');

  const different = await persistScript(paths, `${withMeta}\nreturn 2;`, 'wf_cafe');
  assert.notEqual(different.path, first.path, '同名不同内容 → 退回唯一名，绝不覆盖');
  assert.equal(fs.readFileSync(first.path, 'utf8'), withMeta, '已有脚本一动不动');
  assert.equal(different.name, 'wf_cafe');

  const loaded = await loadScript(paths, first.path);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.content, withMeta);
  assert.equal(loaded.sourceRef.revision, first.sourceRef.revision);
  const outside = await loadScript(paths, path.join(TMP, 'elsewhere.js'));
  assert.deepEqual(outside, { ok: false, reason: 'outside-root' });
  assert.equal(isInsideSavedRoot(paths, path.join(paths.savedRoot, 'x.js')), true);
  assert.equal(isInsideSavedRoot(paths, `${paths.savedRoot}-evil/x.js`), false, '前缀相同但不是子路径');
});

// ── registry：活跃全留、终态保留 10 ──────────────────────────

test('registry 保留：活跃全留、终态最多 10 条、按结束时间升序裁剪', async () => {
  const { paths } = temp();
  const file = paths.registryFile;
  assert.deepEqual(await readRegistry(file), { schemaVersion: SCHEMA_VERSION, runs: [] });
  let registry = { schemaVersion: SCHEMA_VERSION, runs: [] };
  for (let i = 1; i <= 14; i++) {
    registry = await upsertRegistry(file, { runId: `wf_${String(i).padStart(2, '0')}`, status: 'completed', ownerSessionId: 's', startedAt: `t${i}`, endedAt: `u${String(i).padStart(2, '0')}` });
  }
  await upsertRegistry(file, { runId: 'wf_zz', status: 'running', ownerSessionId: 's', startedAt: 't0' });
  registry = await readRegistry(file);
  const terminal = registry.runs.filter((r) => r.status === 'completed');
  assert.equal(terminal.length, MAX_RETAINED_TERMINAL_RUNS);
  assert.equal(terminal[0].runId, 'wf_05', '最旧的终态被裁掉');
  assert.ok(registry.runs.some((r) => r.runId === 'wf_zz' && r.status === 'running'), '活跃永不裁剪');
  const written = await writeRegistry(file, { schemaVersion: SCHEMA_VERSION, runs: [] });
  assert.deepEqual(written.runs, []);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 9, runs: [] }), 'utf8');
  await assert.rejects(() => readRegistry(file), VersionMismatchError);
});

// ── 事件总线：订阅可退订、订阅者抛错被隔离 ────────────────────

test('events：退订生效、订阅者抛错不影响其余订阅者', () => {
  const events = new WorkflowEvents();
  const seen = [];
  const off = events.on((e) => seen.push(e.type));
  events.on(() => { throw new Error('boom'); });
  events.emit({ runId: 'wf_1', type: 'run_started', at: 't' });
  assert.deepEqual(seen, ['run_started']);
  off();
  events.emit({ runId: 'wf_1', type: 'run_settled', at: 't' });
  assert.deepEqual(seen, ['run_started'], '退订后不再收到');
  events.on(() => seen.push('late'));
  events.clear();
  events.emit({ runId: 'wf_1', type: 'run_started', at: 't' });
  assert.deepEqual(seen, ['run_started'], 'clear 后全清');
});

// ── 续跑闸门：同 runId、sourceRef、终态、归属 ────────────────

/** 造一个"未结算的 run"：有索引与账、无终态标记（进程半路死的那一帧）。 */
async function seedUnsettledRun(paths, owner, source, { torn = false } = {}) {
  const saved = await persistScript(paths, source, 'wf_seed');
  const runId = 'wf_abc123';
  const run = runPaths(paths, runId);
  fs.mkdirSync(run.agentsDir, { recursive: true });
  await writeIndex(run.indexFile, {
    schemaVersion: SCHEMA_VERSION, runId, status: 'running', ownerSessionId: owner,
    scriptPath: saved.path, sourceRef: saved.sourceRef, argsRecorded: false,
    startedAt: '2026-01-01T00:00:00.000Z', dispatches: [], tokens: { spent: 0 },
  });
  fs.writeFileSync(run.journalFile, torn ? '{"type":"launched","runId":"wf_abc123","at":"a"}\n{"tor' : '{"type":"launched","runId":"wf_abc123","at":"a"}\n', 'utf8');
  return { runId, run, saved };
}

test('续跑：同 runId 续跑，账本截断丢弃段显式记账', async () => {
  const { workspaceDir, managedRoot, paths } = temp();
  const { runId, run, saved } = await seedUnsettledRun(paths, 'me', SCRIPT, { torn: true });
  const engineInstance = engine(workspaceDir, managedRoot);
  const started = await engineInstance.start({ scriptPath: saved.path, resumeFromRunId: runId, ownerSessionId: 'me' });
  assert.equal(started.runId, runId, '续跑沿用同一 runId');
  assert.equal(started.journalDropped, 1, '撕裂行被丢弃且记账');
  const index = await started.completion;
  assert.equal(index.status, 'completed');
  assert.equal(index.startedAt, '2026-01-01T00:00:00.000Z', '沿用原启动时间');
  assert.equal(fs.existsSync(run.terminalFile), true);
  const journal = await readLines(run.journalFile);
  for (const line of journal) assert.doesNotThrow(() => JSON.parse(line));
});

test('续跑闸门：脚本引用不同 / 已终态 / 不属于本会话，各自明确拒', async () => {
  const { workspaceDir, managedRoot, paths } = temp();
  const engineInstance = engine(workspaceDir, managedRoot);
  const { runId, saved } = await seedUnsettledRun(paths, 'me', SCRIPT);

  const otherScript = await persistScript(paths, `const v = await agent('other');\nreturn v;`, 'wf_other');
  const mismatch = await engineInstance.start({ scriptPath: otherScript.path, resumeFromRunId: runId, ownerSessionId: 'me' }).catch((e) => e);
  assert.equal(mismatch.code, 'VALIDATION');
  assert.equal(mismatch.reason, 'source-mismatch', '改脚本 = 新 run');

  const notMine = await engineInstance.start({ scriptPath: saved.path, resumeFromRunId: runId, ownerSessionId: 'someone' }).catch((e) => e);
  assert.equal(notMine.code, 'FORBIDDEN');
  assert.equal(notMine.reason, 'run-not-owned');

  const ghost = await engineInstance.start({ scriptPath: saved.path, resumeFromRunId: 'wf_999999', ownerSessionId: 'me' }).catch((e) => e);
  assert.equal(ghost.code, 'NOT_FOUND');
  assert.equal(ghost.reason, 'run-not-found');

  // 造终态后再续：必须明确拒（重开终态 run 的规则不属本票，不许静默再结算一次）
  const { runId: doneId, run: doneRun, saved: doneScript } = await seedUnsettledRun(paths, 'me', SCRIPT);
  fs.writeFileSync(doneRun.terminalFile, JSON.stringify({ schemaVersion: SCHEMA_VERSION, runId: doneId, status: 'completed' }) + '\n', 'utf8');
  const terminal = await engineInstance.start({ scriptPath: doneScript.path, resumeFromRunId: doneId, ownerSessionId: 'me' }).catch((e) => e);
  assert.equal(terminal.code, 'VALIDATION');
  assert.equal(terminal.reason, 'run-already-terminal');
});

// ── 审计汇：走既有审计通道落盘 ────────────────────────────────

test('审计汇：start / settle 两条落进既有审计链（含 runId + actor + 结果）', () => {
  const { workspaceDir } = temp();
  const stateDir = path.join(TMP, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const store = new MyTerminalStore(stateDir);
  const { session } = store.registerRoot({ name: 'root' });
  const sink = workflowAuditSink(store, workspaceDir);
  sink({ runId: 'wf_1', action: 'workflow_start', actor: session.id, status: 'running', at: new Date().toISOString() });
  sink({ runId: 'wf_1', action: 'workflow_settle', actor: session.id, status: 'failed', reason: 'run-gate', at: new Date().toISOString() });
  const facts = store.auditFacts(50).filter((f) => f.tool.startsWith('workflow_'));
  assert.equal(facts.length, 2);
  assert.deepEqual(facts.map((f) => f.action), ['workflow_start', 'workflow_settle']);
  assert.equal(facts[1].sessionId, session.id);
  assert.equal(facts[1].errorCode, undefined);
  // 会话不存在时审计失败不得外溢
  assert.doesNotThrow(() => sink({ runId: 'wf_x', action: 'workflow_start', actor: 'ghost', status: 'running', at: new Date().toISOString() }));
});

// ── 时钟：虚拟钟与系统钟各自成立 ──────────────────────────────

test('clock：虚拟钟只随 advance 前进，定时器按到期时刻触发并可取消', () => {
  const clock = virtualClock(1_000_000);
  assert.equal(clock.now(), 1_000_000);
  assert.equal(clock.iso(), new Date(1_000_000).toISOString());
  let fired = 0;
  const handle = clock.setTimeout(() => { fired += 1; }, 10);
  assert.equal(clock.pending(), 1);
  clock.advance(9);
  assert.equal(fired, 0);
  clock.advance(1);
  assert.equal(fired, 1);
  assert.equal(clock.pending(), 0);
  clock.setTimeout(() => { fired += 1; }, 5);
  clock.clearTimeout(handle);
  clock.advance(100);
  assert.equal(fired, 2, '被取消的句柄不再触发');
  const system = systemClock();
  assert.ok(Math.abs(system.now() - Date.now()) < 5_000);
  assert.ok(system.iso().endsWith('Z'));
  const sysHandle = system.setTimeout(() => {}, 1000);
  system.clearTimeout(sysHandle);
});

test('引擎 settled：受理过的 run 返回其终态索引，未知 runId 返回 undefined', async () => {
  const { workspaceDir, managedRoot } = temp();
  const engineInstance = engine(workspaceDir, managedRoot);
  const started = await engineInstance.start({ script: SCRIPT, ownerSessionId: 'me' });
  const settled = await engineInstance.settled(started.runId);
  assert.equal(settled.status, 'completed');
  assert.equal(settled.runId, started.runId);
  assert.equal(await engineInstance.settled('wf_neverstarted'), undefined);
});

test('参数面：非字符串来源按形状拒（present 但类型不对）', () => {
  assert.equal(validateStartArgs({ script: 123 }).reason, 'script-not-string');
  assert.equal(validateStartArgs({ scriptPath: 123 }).reason, 'script-path-not-string');
  assert.equal(validateStartArgs({ script: 123 }).code, 'VALIDATION');
});

test('sandbox 复活失败（循环引用）按 null 返回，不把宿主对象抛出界', async () => {
  const outcome = await runInSandbox({ source: 'const a = {}; a.self = a; return a;', host: { agent: async () => 'x' } });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value, null, '不可序列化的返回值归 null，不连坐整 run');
});

test('saved 唯一名：连号冲突时继续往后找，不覆盖任何已有文件', async () => {
  const { paths } = temp();
  fs.mkdirSync(paths.savedRoot, { recursive: true });
  fs.writeFileSync(path.join(paths.savedRoot, 'dup.js'), 'return 1;', 'utf8');
  fs.writeFileSync(path.join(paths.savedRoot, 'dup-2.js'), 'return 2;', 'utf8');
  const third = await persistScript(paths, 'return 3;', 'dup');
  assert.equal(third.name, 'dup-3');
  assert.equal(fs.readFileSync(path.join(paths.savedRoot, 'dup.js'), 'utf8'), 'return 1;');
  assert.equal(fs.readFileSync(path.join(paths.savedRoot, 'dup-2.js'), 'utf8'), 'return 2;');
});

test('atomic exists：不可读但存在的文件按存在处理', async () => {
  const dir = path.join(temp().workspaceDir, 'perm');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, 'x', { mode: 0o000 });
  try {
    assert.equal(await exists(file), true);
  } finally {
    fs.chmodSync(file, 0o600);
  }
});

test('atomic 失败出口：临时文件清干净后原样抛出', async () => {
  const dir = path.join(temp().workspaceDir, 'io2');
  fs.mkdirSync(dir, { recursive: true });
  await replaceLinesAtomic(path.join(dir, 'lines.jsonl'), ['a']);
  await assert.rejects(() => replaceLinesAtomic(dir, ['a']), '目标是目录 → rename 失败');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp')), [], '失败出口同样无残留');

  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.chmodSync(locked, 0o500);
  try {
    await assert.rejects(() => writeJsonAtomic(path.join(locked, 'x.json'), { a: 1 }));
    assert.deepEqual(fs.readdirSync(locked), [], '不可写目录下不留 temp');
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test('adapter：llmBackedFactory 组装请求、拼接文本、透传 output token', async () => {
  const { llmBackedFactory } = await import('../dist/workflows/adapter.js');
  const seen = [];
  const factory = llmBackedFactory(
    { enabled: true, model: 'test-model', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', maxTurns: 700, timeoutSec: 7200, maxParallel: 2 },
    () => ({
      provider: 'fake',
      stream: async function* () { /* 不走流式 */ },
      create: async (params) => {
        seen.push(params);
        return { message: { role: 'assistant', content: [{ type: 'text', text: '  answer part  ' }, { type: 'text', text: 'more' }] }, usage: { input_tokens: 5, output_tokens: 17 } };
      },
    }),
  );
  const first = factory({ runId: 'wf_1', dispatchId: 'd0001' });
  const second = factory({ runId: 'wf_1', dispatchId: 'd0002' });
  assert.notEqual(first, second, '每路一个独立 adapter 实例（工厂每次新建）');
  const result = await first.complete({ system: 'sys', prompt: 'do it', maxTokens: 1234, signal: new AbortController().signal });
  assert.equal(result.text, 'answer part  more', '文本块拼接 + 首尾 trim');
  assert.equal(result.outputTokens, 17);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].model, 'test-model');
  assert.deepEqual(seen[0].system, 'sys');
  assert.deepEqual(seen[0].tools, [], '格子工具面 v1 不带工具');
  assert.equal(seen[0].maxTokens, 1234);
  assert.equal(seen[0].messages.length, 1);
  assert.equal(seen[0].messages[0].content[0].text, 'do it');
});

test('paths：managed 根与 run 布局按约定，非法槽位不进路径', () => {
  assert.equal(managedRootFor('/ws'), '/ws/.myterminal');
  const paths = workflowPaths('/ws/.myterminal');
  assert.equal(paths.savedRoot, '/ws/.myterminal/workflows/saved');
  assert.equal(paths.registryFile, '/ws/.myterminal/workflows/registry.json');
  const run = runPaths(paths, 'wf_1');
  assert.equal(run.terminalFile, '/ws/.myterminal/workflows/runs/wf_1/terminal');
  assert.equal(run.agentsDir, '/ws/.myterminal/workflows/runs/wf_1/agents');
  assert.equal(run.outboxDir, '/ws/.myterminal/workflows/runs/wf_1/outbox');
  assert.throws(() => runPaths(paths, 'wf_..'), /runId must match/);
});
