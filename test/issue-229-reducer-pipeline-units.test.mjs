// Workflows T6（#229）· 零件契约：终态消息 / durable outbox / 汇总体契约 / wait_for_path
//
// 行为锁定：输入→输出、拒因、时钟边界、失败语义逐条钉死；变则红。
// 覆盖票面口径：KV 首行与 ≤200 码元模板（含超长路径压缩规则）、内容键去重、delivered 标记、
// 等待槽位准入（同一 run 至多一个等待者）、配额与 notice-only 降级、预算推导与等待回合数、
// objective 模板与 digest 形态、wait-timeout 禁止 completed 掩盖、wait_for_path 三态与路径双检。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_NOTICE_CODE_UNITS,
  buildKvFirstLine,
  buildSettledNotice,
  markNoticeDelivered,
  outboxFileName,
  putNotice,
  readOutbox,
  sha256File,
} from '../dist/workflows/notice.js';
import {
  DIGEST_TEMPLATE,
  REDUCER_OBJECTIVE_TEMPLATE,
  claimReducerWaiter,
  concludeReducer,
  countReducerWaiters,
  readReducerWaiter,
  reducerSummaryBudget,
  releaseReducerWaiter,
  reducerWaitRounds,
  resolveReducerBudget,
  decideReducerAdmission,
} from '../dist/workflows/reducer.js';
import { workflowPaths, runPaths } from '../dist/workflows/paths.js';
import { virtualClock } from '../dist/workflows/clock.js';
import { defaultWorkflowGates, validateClockNesting } from '../dist/workflows/gates.js';
import { getTool, WAIT_FOR_PATH_POLL_MS, setWaitForPathTimingForTesting, resetWaitForPathTimingForTesting } from '../dist/subagent/tools.js';

const TMP = [];
const RUN_ID = 'wf_a1b2c3d4e5f6a7b8';
const SHA_A = 'a'.repeat(64);

function tempWorkspace() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-229-')));
  TMP.push(dir);
  const workspaceDir = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const managedRoot = path.join(workspaceDir, '.myterminal');
  const paths = workflowPaths(managedRoot);
  const run = runPaths(paths, RUN_ID);
  fs.mkdirSync(run.outboxDir, { recursive: true });
  return { workspaceDir, managedRoot, paths, run };
}

function writeSnapshot(temp, content = '{"status":"completed"}\n') {
  fs.writeFileSync(temp.run.snapshotFile, content, 'utf8');
  return content;
}

afterEach(() => {
  while (TMP.length) {
    const dir = TMP.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
  }
});

// ═══════════════════════════════════════════════════════════════
// 一、终态消息：KV 首行 + ≤200 码元 + 超长路径压缩规则（随技能模板锁定）
// ═══════════════════════════════════════════════════════════════

test('notice-1: 首行 KV 逐字 = [workflow] kind=<kind> runId=<wf_…> sha256=<hex>', () => {
  assert.equal(
    buildKvFirstLine({ kind: 'settled-notice', runId: RUN_ID, sha256: SHA_A }),
    `[workflow] kind=settled-notice runId=${RUN_ID} sha256=${SHA_A}`,
  );
  assert.equal(
    buildKvFirstLine({ kind: 'digest', runId: RUN_ID, sha256: SHA_A }),
    `[workflow] kind=digest runId=${RUN_ID} sha256=${SHA_A}`,
  );
});

test('notice-2: sha256 = 快照文件字节哈希（与独立算得的对照值逐字相等）', async () => {
  const temp = tempWorkspace();
  const content = writeSnapshot(temp, '{"status":"completed","tokens":{"spent":7}}\n');
  const expected = crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
  assert.equal(await sha256File(temp.run.snapshotFile), expected);
});

test('notice-3: 装得下时用索引绝对路径；必含 status 与 X/Y 读数；整体 ≤200 码元', () => {
  const result = buildSettledNotice({
    runId: RUN_ID, status: 'completed', sha256: SHA_A,
    indexPath: `/w/${RUN_ID}/index.json`, succeeded: 12, total: 15,
  });
  assert.equal(result.ok, true);
  const body = result.body;
  assert.ok(body.length <= MAX_NOTICE_CODE_UNITS, `${body.length} 码元 > ${MAX_NOTICE_CODE_UNITS}`);
  const lines = body.split('\n');
  assert.equal(lines[0], `[workflow] kind=settled-notice runId=${RUN_ID} sha256=${SHA_A}`);
  assert.ok(lines[1].includes('completed'), '必含 status');
  assert.ok(lines[1].includes('12/15'), '一句话读数（X/Y）在通知体里');
  assert.ok(lines[1].includes(`/w/${RUN_ID}/index.json`), `短路径应原样出现：${lines[1]}`);
});

test('notice-3b: 度量口径 = UTF-16 码元（length），不是码点——与 runner.ts 既有 slice 同源', () => {
  const result = buildSettledNotice({
    runId: RUN_ID, status: 'completed', sha256: SHA_A,
    indexPath: `/w/\u{1F600}\u{1F600}\u{1F600}/index.json`, succeeded: 12, total: 15,
  });
  assert.equal(result.ok, true);
  assert.ok(result.body.length > [...result.body].length, ' astral 字符按两个码元计，口径必须是 length');
  assert.ok(result.body.length <= MAX_NOTICE_CODE_UNITS, `按码点算会假绿：${result.body.length}`);
});

test('notice-4: 超长路径压缩规则 = 换公共约定的规范尾段，绝不切 KV 首行', () => {
  const deep = path.join(
    '/' + Array.from({ length: 30 }, (_unused, i) => `segment-${i}`).join('/'),
    '.myterminal', 'workflows', 'runs', RUN_ID, 'index.json',
  );
  const result = buildSettledNotice({
    runId: RUN_ID, status: 'failed', sha256: SHA_A, indexPath: deep, succeeded: 0, total: 3,
  });
  assert.equal(result.ok, true);
  const lines = result.body.split('\n');
  assert.equal(lines[0], `[workflow] kind=settled-notice runId=${RUN_ID} sha256=${SHA_A}`, '首行一字不动');
  assert.ok(result.body.length <= MAX_NOTICE_CODE_UNITS, `${result.body.length} 码元仍超帽`);
  assert.ok(lines[1].includes(`…/workflows/runs/${RUN_ID}/index.json`), `未落到规范尾段：${lines[1]}`);
  assert.ok(!result.body.includes(deep), '超长绝对路径不再出现');
  assert.ok(lines[1].includes('failed 0/3'), 'status 与读数在尾档仍保留');
});

test('notice-5: 阶梯第二档 = 尾段仍装不下时先去掉 X/Y 读数（status 不动）', () => {
  const longRunId = `wf_${'d'.repeat(19)}`;
  const tail = `…/workflows/runs/${longRunId}/index.json`;
  const kv = buildKvFirstLine({ kind: 'settled-notice', runId: longRunId, sha256: SHA_A });
  assert.equal(kv.length + 1 + `cancelled 1/4 index=${tail}`.length > MAX_NOTICE_CODE_UNITS, true, '用例前提不成立：带读数的尾档应超帽');
  assert.equal(kv.length + 1 + `cancelled index=${tail}`.length <= MAX_NOTICE_CODE_UNITS, true, '用例前提不成立：去掉读数后应装得下');
  const result = buildSettledNotice({
    runId: longRunId, status: 'cancelled', sha256: SHA_A,
    indexPath: `/${Array.from({ length: 40 }, (_unused, i) => `seg-${i}`).join('/')}/${longRunId}/index.json`,
    succeeded: 1, total: 4,
  });
  assert.equal(result.ok, true);
  const lines = result.body.split('\n');
  assert.equal(lines[0], kv);
  assert.ok(result.body.length <= MAX_NOTICE_CODE_UNITS, `${result.body.length} 码元仍超帽`);
  assert.ok(!/\d+\/\d+/.test(lines[1]), `X/Y 读数应已被降档去掉：${lines[1]}`);
  assert.ok(lines[1].includes('cancelled'), 'status 是必需段，降档也不动它');
  assert.ok(lines[1].includes(tail), '第三档仍保留规范尾段路径');
});

test('notice-6: 末档 = 第二行按码元硬切且不留半个代理对；首行永不裁', () => {
  const longRunId = `wf_${'f'.repeat(70)}`;
  const result = buildSettledNotice({
    runId: longRunId, status: 'completed', sha256: SHA_A,
    indexPath: `/a/very/long/path/\u{1F600}${longRunId}/index.json`, succeeded: 1, total: 1,
  });
  assert.equal(result.ok, true);
  const lines = result.body.split('\n');
  assert.equal(lines[0], `[workflow] kind=settled-notice runId=${longRunId} sha256=${SHA_A}`, '身份段宁可不发也不裁');
  assert.ok(result.body.length <= MAX_NOTICE_CODE_UNITS, `${result.body.length} 码元仍超帽`);
  const tail = lines[1];
  const last = tail.charCodeAt(tail.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), `截断留下孤立高位：${JSON.stringify(tail.slice(-4))}`);
  assert.ok(tail.length < `completed index=…/workflows/runs/${longRunId}/index.json`.length, '确实走到了硬切档');
});

test('notice-7: KV 首行自身超帽 = 拒发（fail-closed），不发半截身份', () => {
  const result = buildSettledNotice({
    runId: `wf_${'0'.repeat(300)}`,
    status: 'completed',
    sha256: SHA_A,
    indexPath: '/x/index.json',
    succeeded: 1,
    total: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'kv-too-long');
});

test('notice-8: 一切终态路径都出得了通知体（completed / failed / cancelled 三态逐条）', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const result = buildSettledNotice({
      runId: RUN_ID, status, sha256: SHA_A, indexPath: `/w/${RUN_ID}/index.json`, succeeded: 2, total: 2,
    });
    assert.equal(result.ok, true, `${status} 被拒发了`);
    assert.ok(result.body.split('\n')[1].includes(status), `${status} 未出现在通知体`);
  }
});

// ═══════════════════════════════════════════════════════════════
// 二、durable outbox：内容键、写-if-absent、delivered 标记、排空可读
// ═══════════════════════════════════════════════════════════════

function draft(temp, sha = SHA_A, body = `x ${sha}`) {
  return { kind: 'settled-notice', runId: RUN_ID, sha256: sha, status: 'completed', index: temp.run.indexFile, body, at: '2026-10-01T00:00:00.000Z' };
}

test('outbox-1: 项名 = kind + 完整 sha256（内容键即文件名，同键同文件）', () => {
  const name = outboxFileName({ kind: 'settled-notice', runId: RUN_ID, sha256: SHA_A });
  assert.equal(name, `settled-notice-${SHA_A}.json`);
  assert.equal(name, outboxFileName({ kind: 'settled-notice', runId: RUN_ID, sha256: SHA_A }), '同键必落同一文件');
  assert.notEqual(name, outboxFileName({ kind: 'settled-notice', runId: RUN_ID, sha256: 'b'.repeat(64) }), '异 sha 是另一条（更新版另有其物）');
});

test('outbox-2: putNotice 原子写、初值未投递，且无 .tmp 残留', async () => {
  const temp = tempWorkspace();
  const { created, item } = await putNotice(temp.run, draft(temp));
  assert.equal(created, true);
  assert.equal(item.delivered, false);
  assert.equal(item.attempts, 0);
  assert.equal(item.schemaVersion, 1);
  assert.equal(item.at, '2026-10-01T00:00:00.000Z');
  const file = path.join(temp.run.outboxDir, outboxFileName(item));
  assert.ok(fs.existsSync(file), 'outbox 项未落盘');
  assert.deepEqual(fs.readdirSync(temp.run.outboxDir).filter((n) => n.endsWith('.tmp')), [], 'outbox 目录留了临时文件');
});

test('outbox-3: 同键重投忽略——已 delivered 的项不被覆回未投递', async () => {
  const temp = tempWorkspace();
  const { item: first } = await putNotice(temp.run, draft(temp));
  await markNoticeDelivered(temp.run, first, '2026-10-01T00:00:05.000Z');
  const again = await putNotice(temp.run, draft(temp));
  assert.equal(again.created, false, '同键第二次必须识别为已存在');
  assert.equal(again.item.delivered, true, '重投把已投递项抹回未投递 = 双份投递的根源');
  assert.equal(again.item.deliveredAt, '2026-10-01T00:00:05.000Z');
});

test('outbox-4: markNoticeDelivered 只推进投递位，其余字段原样', async () => {
  const temp = tempWorkspace();
  const { item } = await putNotice(temp.run, draft(temp));
  const delivered = await markNoticeDelivered(temp.run, item, '2026-10-01T00:00:09.000Z');
  assert.equal(delivered.delivered, true);
  assert.equal(delivered.deliveredAt, '2026-10-01T00:00:09.000Z');
  assert.equal(delivered.attempts, 1);
  assert.equal(delivered.body, item.body);
  assert.equal(delivered.sha256, SHA_A);
  assert.equal(delivered.runId, RUN_ID);
});

test('outbox-5: readOutbox 列出全部项（排空趟的判据来源），目录缺失 = 空表非抛错', async () => {
  const temp = tempWorkspace();
  const { item } = await putNotice(temp.run, draft(temp));
  const items = await readOutbox(temp.run);
  assert.equal(items.length, 1);
  assert.equal(items[0].delivered, false);
  assert.equal(items[0].runId, item.runId);
  assert.deepEqual(await readOutbox(runPaths(temp.paths, 'wf_0000000000000000')), [], '目录不存在应回空表');
});

test('outbox-6: digest 落点 = runs/<runId>/digest、终态标记 = runs/<runId>/terminal（公共约定，无换算层）', () => {
  const temp = tempWorkspace();
  assert.ok(temp.run.digestFile.endsWith(path.join('runs', RUN_ID, 'digest')));
  assert.ok(temp.run.terminalFile.endsWith(path.join('runs', RUN_ID, 'terminal')));
  assert.deepEqual(runPaths(temp.paths, RUN_ID), temp.run, '同一 run 的路径件集合是单源派生的');
});

test('outbox-8: digest 项与 settled-notice 项分账（kind 不同、不是重复）', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(temp.run.digestFile, '# digest\n', 'utf8');
  const sha = await sha256File(temp.run.digestFile);
  assert.equal(outboxFileName({ kind: 'digest', sha256: sha }), `digest-${sha}.json`);
  const { item: notice } = await putNotice(temp.run, draft(temp));
  await putNotice(temp.run, { ...draft(temp, sha), kind: 'digest', body: `d ${sha}` });
  const items = await readOutbox(temp.run);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.kind).sort(), ['digest', 'settled-notice']);
  assert.equal(notice.kind, 'settled-notice');
});

// ═══════════════════════════════════════════════════════════════
// 三、汇总体预算：恒取 reducerBudget、timeoutSec 推导、等待回合数
// ═══════════════════════════════════════════════════════════════

test('budget-1: 默认档三者对齐——runGate 30 / budget 35 = gate + slack / timeoutSec 40 = budget + slack', () => {
  const gates = defaultWorkflowGates(8);
  assert.equal(gates.runGateMs, 30 * 60_000);
  assert.equal(gates.reducerBudgetMs, 35 * 60_000);
  assert.equal(gates.reducerBudgetMs, gates.runGateMs + gates.reduceSlackMs, 'reducerBudget = runGate + reduceSlack');
  assert.equal(gates.reducerTimeoutMs, gates.reducerBudgetMs + gates.reduceSlackMs, '默认档 = reducerBudget + reduceSlack（40 分钟）');
  assert.equal(gates.reduceSlackMs, 5 * 60_000, '+5 分钟防"结算在闸内、标记稍后才落地"的竞态');
  const budget = resolveReducerBudget(gates, { startedAt: 1_000_000, now: () => 1_000_000 });
  assert.equal(budget.timeoutSec, 40 * 60, '模型面无可传旋钮，runner 恒取这里');
  assert.equal(budget.budgetEndsAt, 1_000_000 + 35 * 60_000, 'budgetEndsAt = 起时 + reducerBudget');
});

test('budget-2: 嵌套不变量把调错的档位挡在启动前（fail-closed，不留两套权威）', () => {
  const gates = { ...defaultWorkflowGates(8), reducerTimeoutMs: 30 * 60_000 };
  assert.equal(validateClockNesting(gates).ok, false, 'timeoutSec 低于 budget + slack 必须被拒');
});

test('budget-3: 等待回合数 = floor(budget / waitChunk) 个整回合 + 1 个末回合（35min/600s → 3 + 1 = 4 次调用）', () => {
  assert.deepEqual(reducerWaitRounds(defaultWorkflowGates(8)), { fullRounds: 3, finalRound: 1, calls: 4, waitChunkSec: 600 });
});

test('budget-3b: 整除时刻不白送一个空回合——余数为 0 时末回合 = 0', () => {
  const gates = { ...defaultWorkflowGates(8), reducerBudgetMs: 20 * 60_000 };
  assert.deepEqual(reducerWaitRounds(gates), { fullRounds: 2, finalRound: 0, calls: 2, waitChunkSec: 600 });
});

test('budget-4: 逐回合 timeoutSec——整回合 = waitChunk，末回合 = 余数，预算尽即 0', () => {
  const gates = defaultWorkflowGates(8);
  const clock = virtualClock();
  const budget = resolveReducerBudget(gates, { startedAt: clock.now(), now: clock.now });
  assert.equal(budget.waitChunkSec, 600);
  assert.equal(budget.roundTimeoutSec(0), 600, '第 1 回合 = 整 waitChunk');
  assert.equal(budget.roundTimeoutSec(1), 600);
  assert.equal(budget.roundTimeoutSec(2), 600);
  assert.equal(budget.roundTimeoutSec(3), 5 * 60, '末回合 = 35min − 3×600s = 5 分钟');
  assert.equal(budget.roundTimeoutSec(4), 0, '预算已尽：不再有回合');
});

test('budget-5: 等待永不吃掉聚合余量——末回合跟着当前时刻裁剪', () => {
  const gates = { ...defaultWorkflowGates(8), reducerBudgetMs: 700_000 };
  const clock = virtualClock();
  const startedAt = clock.now();
  const budget = resolveReducerBudget(gates, { startedAt, now: () => clock.now() });
  assert.equal(budget.roundTimeoutSec(0), 600, '整回合照 waitChunk');
  clock.advance(600_000);
  assert.equal(budget.roundTimeoutSec(1), 100, '已等 10 分钟，剩 100 秒 → 本回合只等 100 秒');
  clock.advance(50_000);
  assert.equal(budget.roundTimeoutSec(1), 50, '裁剪跟着当前时刻走');
  clock.advance(50_000);
  assert.equal(budget.roundTimeoutSec(1), 0, '预算末端止步');
});

// ═══════════════════════════════════════════════════════════════
// 四、等待槽位准入与配额：同一 run 至多一个等待者；超出 notice-only 降级
// ═══════════════════════════════════════════════════════════════

test('slot-1: claim 独占创建——同一 run 第二次补起被拒（已有等待者）', async () => {
  const temp = tempWorkspace();
  const first = await claimReducerWaiter(temp.paths, { runId: RUN_ID, agentId: 'sa_1', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:00.000Z' });
  assert.equal(first.ok, true);
  const second = await claimReducerWaiter(temp.paths, { runId: RUN_ID, agentId: 'sa_2', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:01.000Z' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'reducer-waiter-exists');
  assert.equal(second.waiter.agentId, 'sa_1', '拒因要指得出是谁占着');
  const waiter = await readReducerWaiter(temp.paths, RUN_ID);
  assert.equal(waiter.agentId, 'sa_1', '抢占不得改写已有登记');
});

test('slot-2: 释放后可再起；释放按 agentId 对齐，别人的位不放', async () => {
  const temp = tempWorkspace();
  await claimReducerWaiter(temp.paths, { runId: RUN_ID, agentId: 'sa_1', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:00.000Z' });
  const wrong = await releaseReducerWaiter(temp.paths, { runId: RUN_ID, agentId: 'sa_2' });
  assert.equal(wrong.released, false, '拿别人的 agentId 释放 = 结构性错误，不放');
  const ok = await releaseReducerWaiter(temp.paths, { runId: RUN_ID, agentId: 'sa_1' });
  assert.equal(ok.released, true);
  assert.equal(await readReducerWaiter(temp.paths, RUN_ID), undefined);
  const again = await claimReducerWaiter(temp.paths, { runId: RUN_ID, agentId: 'sa_3', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:09.000Z' });
  assert.equal(again.ok, true, '释放后同 runId 补起必须能起');
});

test('slot-3: 等待者登记 = run 记录标记（盘上件，进程死后可由启动扫描清理）', async () => {
  const temp = tempWorkspace();
  await claimReducerWaiter(temp.paths, { runId: RUN_ID, agentId: 'sa_1', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:00.000Z' });
  const file = path.join(temp.run.dir, 'reducer-waiter.json');
  assert.ok(fs.existsSync(file), '登记没落盘 = 重启后无从清理');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.runId, RUN_ID);
  assert.equal(raw.ownerSessionId, 'sess-a');
  assert.equal(await countReducerWaiters(temp.paths), 1);
});

test('slot-3b: 登记读不动也占位——配额宁少不多（多占一个槽只是少走一个汇总体）', async () => {
  const temp = tempWorkspace();
  const run = runPaths(temp.paths, RUN_ID);
  fs.writeFileSync(run.waiterFile, '{ 坏掉的登记', 'utf8');
  assert.equal(await countReducerWaiters(temp.paths), 1, '解析不动的登记必须仍占位');
  assert.equal(run.waiterFile, path.join(run.dir, 'reducer-waiter.json'), '登记件名属公共约定');
});

test('slot-8: 并发补起同 runId —— 恰一个赢，输的那个报"已有等待者"（线性化点 = 独占创建）', async () => {
  const temp = tempWorkspace();
  const gates = defaultWorkflowGates(8);
  const input = (agentId) => ({ runId: RUN_ID, agentId, ownerSessionId: 'sess-a', at: '2026-10-01T00:00:00.000Z', gates });
  const [a, b] = await Promise.all([
    decideReducerAdmission(temp.paths, input('sa_a')),
    decideReducerAdmission(temp.paths, input('sa_b')),
  ]);
  assert.equal([a, b].filter((decision) => decision.ok).length, 1, '同 run 至多一个等待者：并发也只能赢一个');
  const loser = [a, b].find((decision) => !decision.ok);
  assert.equal(loser.reason, 'reducer-waiter-exists');
  assert.equal(loser.noticeOnly, false, '同 run 冲突不是配额降级');
  assert.equal(await countReducerWaiters(temp.paths), 1);
});

test('slot-4: 计数跨 run 汇总，释放即减（配额读的就是这个数）', async () => {
  const temp = tempWorkspace();
  const other = 'wf_0000000000000001';
  await claimReducerWaiter(temp.paths, { runId: RUN_ID, agentId: 'sa_1', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:00.000Z' });
  await claimReducerWaiter(temp.paths, { runId: other, agentId: 'sa_2', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:00.000Z' });
  assert.equal(await countReducerWaiters(temp.paths), 2);
  await releaseReducerWaiter(temp.paths, { runId: other, agentId: 'sa_2' });
  assert.equal(await countReducerWaiters(temp.paths), 1);
});

test('slot-5: 配额默认 3——池上限里最多 3 槽被等待体占用', async () => {
  const temp = tempWorkspace();
  const gates = defaultWorkflowGates(8);
  assert.equal(gates.reducerQuota, 3);
  const runs = ['wf_0000000000000001', 'wf_0000000000000002', 'wf_0000000000000003'];
  for (const runId of runs) {
    await claimReducerWaiter(temp.paths, { runId, agentId: `sa_${runId}`, ownerSessionId: 'sess-a', at: '2026-10-01T00:00:00.000Z' });
  }
  assert.equal(await countReducerWaiters(temp.paths), 3);
  const decision = await decideReducerAdmission(temp.paths, { runId: 'wf_0000000000000004', agentId: 'sa_x', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:04.000Z', gates });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'reducer-quota');
  assert.equal(decision.noticeOnly, true, '配额满 = notice-only 降级，不是硬失败');
});

test('slot-6: notice-only 降级不阻塞 run 启动，且指得出结果仍可达', async () => {
  const temp = tempWorkspace();
  const gates = { ...defaultWorkflowGates(8), reducerQuota: 1 };
  await claimReducerWaiter(temp.paths, { runId: 'wf_0000000000000001', agentId: 'sa_1', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:00.000Z' });
  const decision = await decideReducerAdmission(temp.paths, { runId: 'wf_0000000000000002', agentId: 'sa_2', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:02.000Z', gates });
  assert.equal(decision.noticeOnly, true);
  assert.equal(decision.runBlocked, false, 'run 启动与在飞的路不受汇总体配额影响');
  assert.ok(decision.indexPath.includes('index.json'), '降级告知必须给出索引去处');
  assert.equal(await countReducerWaiters(temp.paths), 1, '被拒的补起不占用位');
});

test('slot-7: 同一 run 已有等待者时，补起在配额判定之前就被拒（两条闸各判各的）', async () => {
  const temp = tempWorkspace();
  const gates = { ...defaultWorkflowGates(8), reducerQuota: 3 };
  await claimReducerWaiter(temp.paths, { runId: RUN_ID, agentId: 'sa_1', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:00.000Z' });
  const decision = await decideReducerAdmission(temp.paths, { runId: RUN_ID, agentId: 'sa_2', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:01.000Z', gates });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'reducer-waiter-exists');
  assert.equal(decision.noticeOnly, false, '已有等待者不是配额降级：那一个等待者就是它的');
});

// ═══════════════════════════════════════════════════════════════
// 五、objective 模板与 digest 形态（本票定义并锁定，T11 原样发布）
// ═══════════════════════════════════════════════════════════════

test('template-1: objective 模板字段齐全——终态标记 / 索引 / digest / 回合上限 / 三段上报纪律', () => {
  const gates = defaultWorkflowGates(8);
  const clock = virtualClock();
  const temp = tempWorkspace();
  const budget = resolveReducerBudget(gates, { startedAt: clock.now(), clock });
  const text = REDUCER_OBJECTIVE_TEMPLATE({
    runId: RUN_ID,
    terminalPath: runPaths(temp.paths, RUN_ID).terminalFile,
    indexPath: temp.run.indexFile,
    digestPath: runPaths(temp.paths, RUN_ID).digestFile,
    rounds: reducerWaitRounds(gates).calls,
    waitChunkSec: budget.waitChunkSec,
  });
  for (const needle of [RUN_ID, runPaths(temp.paths, RUN_ID).terminalFile, temp.run.indexFile, runPaths(temp.paths, RUN_ID).digestFile, 'wait_for_path', '600']) {
    assert.ok(text.includes(String(needle)), `模板缺字段 ${needle}`);
  }
  assert.ok(/do not poll more than once per turn/i.test(text), '一回合一次调用是钉死的节奏');
  assert.ok(/partial/i.test(text) && /never report a run you did not settle/i.test(text), '不美化不静默：假完整红线写进模板');
  assert.ok(text.includes(String(reducerSummaryBudget(RUN_ID))), '正文预算插值自同一处算术（发布件与投递管线同源）');
});

test('template-2: 模板逐字稳定（T11 原样发布 = 改一个字即红）', () => {
  const base = {
    runId: RUN_ID,
    terminalPath: '/w/.myterminal/workflows/runs/wf_a1b2c3d4e5f6a7b8/terminal',
    indexPath: '/w/.myterminal/workflows/runs/wf_a1b2c3d4e5f6a7b8/index.json',
    digestPath: '/w/.myterminal/workflows/runs/wf_a1b2c3d4e5f6a7b8/digest',
    rounds: 4,
    waitChunkSec: 600,
  };
  const first = REDUCER_OBJECTIVE_TEMPLATE(base);
  assert.equal(first, REDUCER_OBJECTIVE_TEMPLATE(base));
  assert.equal(first.split('\n').length, 12, '模板行数即契约（发布件按行核对）');
  assert.ok(first.includes(`${base.rounds}`), '回合上限插值自计算，不手写数字');
  assert.ok(!first.includes('${'), '模板不残留未替换的占位符');
});

test('template-3: digest 形态 = 三段（结论 X/Y / 失败清单 / 路径 + 索引提醒）且明写不作机器契约', () => {
  assert.deepEqual(DIGEST_TEMPLATE.sections.map((s) => s.title), ['结论', '失败清单', '产物与索引']);
  assert.deepEqual(DIGEST_TEMPLATE.sections[1].fields, ['label', 'error', '相关性']);
  assert.equal(DIGEST_TEMPLATE.machineContract, false, 'digest 是模板级形状，程序化解析一律回索引');
  assert.equal(DIGEST_TEMPLATE.file, 'digest');
});

// ═══════════════════════════════════════════════════════════════
// 六、conclude：摘要交付首行 KV；wait-timeout 禁止 completed 掩盖
// ═══════════════════════════════════════════════════════════════

test('conclude-1: run 已终态 + digest 齐 → completed，首行 KV 带 digest 文件字节哈希', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(temp.run.terminalFile, '{"status":"completed"}\n', 'utf8');
  fs.writeFileSync(temp.run.digestFile, '# digest body\n', 'utf8');
  const expected = crypto.createHash('sha256').update(Buffer.from('# digest body\n', 'utf8')).digest('hex');
  const verdict = await concludeReducer(temp.paths, {
    runId: RUN_ID, agentId: 'sa_1', digestPath: temp.run.digestFile,
  });
  assert.equal(verdict.status, 'completed');
  assert.equal(verdict.firstLine, `[workflow] kind=digest runId=${RUN_ID} sha256=${expected}`);
  assert.equal(verdict.firstLine, buildKvFirstLine({ kind: 'digest', runId: RUN_ID, sha256: expected }), 'KV 口径单源');
  assert.equal(verdict.digestSha, expected);
});

test('conclude-2: run 未终态 → failed(wait-timeout) 三段报告，不许 completed 掩盖', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(temp.run.digestFile, '半成品\n', 'utf8');
  const verdict = await concludeReducer(temp.paths, {
    runId: RUN_ID, agentId: 'sa_1', digestPath: temp.run.digestFile,
  });
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.reason, 'wait-timeout');
  const lines = verdict.report.split('\n');
  assert.equal(lines.length, 3, '三段报告 = 结论 / 失败清单 / 路径 + 索引');
  assert.ok(lines[0].includes('未结算'), `第一段必须如实写未结算：${lines[0]}`);
  assert.ok(lines[2].includes('无摘要'), '超时场景如实写无摘要（半成品文件不算摘要）');
  assert.ok(lines[1].includes(temp.run.indexFile) || lines[2].includes(temp.run.indexFile), '三段报告须给出索引去处');
});

test('conclude-3: run 已终态但 digest 缺失 = 不冒充交付，如实 failed', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(temp.run.terminalFile, '{"status":"completed"}\n', 'utf8');
  const verdict = await concludeReducer(temp.paths, { runId: RUN_ID, agentId: 'sa_1', digestPath: temp.run.digestFile });
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.reason, 'no-digest');
});

test('conclude-4: 收场即释放等待位（死亡后可同 runId 补起）', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(temp.run.terminalFile, '{}', 'utf8');
  fs.writeFileSync(temp.run.digestFile, 'doc', 'utf8');
  await claimReducerWaiter(temp.paths, { runId: RUN_ID, agentId: 'sa_1', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:00.000Z' });
  const verdict = await concludeReducer(temp.paths, { runId: RUN_ID, agentId: 'sa_1', digestPath: temp.run.digestFile });
  assert.equal(verdict.released, true);
  assert.equal(await readReducerWaiter(temp.paths, RUN_ID), undefined);
  assert.equal(await countReducerWaiters(temp.paths), 0);
});

test('conclude-6: digest 位读不动 = IO 故障原样抛出，不许被当成"没有摘要"；等待位照放', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(temp.run.terminalFile, '{}', 'utf8');
  fs.mkdirSync(temp.run.digestFile, { recursive: true });
  await claimReducerWaiter(temp.paths, { runId: RUN_ID, agentId: 'sa_io', ownerSessionId: 'sess-a', at: '2026-10-01T00:00:00.000Z' });
  const error = await concludeReducer(temp.paths, { runId: RUN_ID, agentId: 'sa_io', digestPath: temp.run.digestFile }).catch((err) => err);
  assert.ok(error instanceof Error, '读摘要失败必须抛出（IO 错误不吞不重试）');
  assert.notEqual(error.reason, 'no-digest', '缺件与读不动是两件事');
  assert.equal(await readReducerWaiter(temp.paths, RUN_ID), undefined, '判败也要先释放等待位，别钉死到下次启动');
});

test('conclude-5: 重跑（同 runId 再起）产出的新 digest 是不同 sha —— 异 sha 以最新为准', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(temp.run.terminalFile, '{}', 'utf8');
  fs.writeFileSync(temp.run.digestFile, 'v1', 'utf8');
  const first = await concludeReducer(temp.paths, { runId: RUN_ID, agentId: 'sa_1', digestPath: temp.run.digestFile });
  fs.writeFileSync(temp.run.digestFile, 'v2', 'utf8');
  const second = await concludeReducer(temp.paths, { runId: RUN_ID, agentId: 'sa_2', digestPath: temp.run.digestFile });
  assert.notEqual(first.digestSha, second.digestSha, '内容变了 sha 必须变（否则去重键失效）');
  assert.equal(second.status, 'completed');
});

// ═══════════════════════════════════════════════════════════════
// 七、wait_for_path 契约（工具面 8→9 的新工具）
// ═══════════════════════════════════════════════════════════════

const skipOnWin = process.platform === 'win32';
const REGULAR = { isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false, size: 3 };
const ENOENT = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });

function makeCtx(temp, over = {}) {
  return { cwd: temp.workspaceDir, signal: new AbortController().signal, agentId: 'sa_wait', readOnly: false, ...over };
}

function waitTool() {
  const tool = getTool('wait_for_path');
  assert.ok(tool, 'wait_for_path 未注册进 subagent 工具表');
  return tool;
}

/** 虚拟时钟驱动的等待：sleep 即推进钟；lstat 不给就用真实 fs（缺件本身就是 ENOENT）。 */
function fakeTiming(clock, { pollIntervalMs = 2_000, lstat } = {}) {
  setWaitForPathTimingForTesting({
    now: () => clock.now(),
    pollIntervalMs,
    sleep: (ms) => { clock.advance(ms); return Promise.resolve(); },
    ...(lstat ? { lstat } : {}),
  });
}

afterEach(() => resetWaitForPathTimingForTesting());

test('wait-1: 文件已存在且是普通文件 → ready（首探测即返回，一次都不等）', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(temp.run.terminalFile, 'x', 'utf8');
  fakeTiming(virtualClock());
  const result = await waitTool().call({ path: temp.run.terminalFile, timeoutSec: 600 }, makeCtx(temp));
  assert.equal(result.ok, true);
  assert.equal(result.state, 'ready');
  assert.equal(result.path, temp.run.terminalFile);
  assert.equal(result.waitedSec, 0);
});

test('wait-2: 到点未出现 → timeout（三态之二），并报出等了多久', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  fakeTiming(clock);
  const result = await waitTool().call({ path: temp.run.terminalFile, timeoutSec: 60 }, makeCtx(temp));
  assert.equal(result.state, 'timeout');
  assert.equal(result.waitedSec, 60);
  assert.equal(result.cappedBy, undefined, '没被预算裁过就不许记账');
});

test('wait-2b: 轮询间隔钉死 2 秒——60 秒 = 31 次探测（首探测 + 每 2 秒一次）', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  let probes = 0;
  fakeTiming(clock, { lstat: () => { probes += 1; return Promise.reject(ENOENT()); } });
  const result = await waitTool().call({ path: temp.run.terminalFile, timeoutSec: 60 }, makeCtx(temp));
  assert.equal(result.state, 'timeout');
  assert.equal(probes, 31, '间隔改粗或改细都会挪动这个数——2s 是票面钉的');
});

test('wait-2c: 默认轮询间隔 = 2000ms（不经测试缝时也按它走）', () => {
  assert.equal(WAIT_FOR_PATH_POLL_MS, 2_000);
});

test('wait-3: 非普通文件一律拒——目录 / FIFO / socket 都走 error 态，不排队不重试', async () => {
  const temp = tempWorkspace();
  fakeTiming(virtualClock());
  const dirResult = await waitTool().call({ path: temp.run.dir, timeoutSec: 5 }, makeCtx(temp));
  assert.equal(dirResult.state, 'error');
  assert.equal(dirResult.reason, 'not-a-regular-file');
});

test(skipOnWin ? 'wait-3b(skip): socket 与 FIFO' : 'wait-3b: socket / FIFO 一律拒（非普通文件同一条闸）', async () => {
  if (skipOnWin) return;
  const temp = tempWorkspace();
  fakeTiming(virtualClock());

  const socket = path.join(temp.run.dir, 'sock');
  const server = net.createServer();
  await new Promise((resolveListen) => server.listen(socket, resolveListen));
  try {
    const result = await waitTool().call({ path: socket, timeoutSec: 5 }, makeCtx(temp));
    assert.equal(result.state, 'error');
    assert.equal(result.reason, 'not-a-regular-file', 'socket 不许被 open 挂住');
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }

  const fifo = path.join(temp.run.dir, 'pipe');
  try {
    execFileSync('mkfifo', [fifo]);
  } catch {
    assert.fail('本用例需要 mkfifo（macOS / Linux 自带）');
  }
  const fifoResult = await waitTool().call({ path: fifo, timeoutSec: 5 }, makeCtx(temp));
  assert.equal(fifoResult.state, 'error');
  assert.equal(fifoResult.reason, 'not-a-regular-file', 'FIFO 不许把等待体挂死在 open 上');
});

test(skipOnWin ? 'wait-3c(skip): /dev' : 'wait-3c: /dev/* 一律拒（cwd 外边界先拦住）', async () => {
  if (skipOnWin) return;
  const temp = tempWorkspace();
  fakeTiming(virtualClock());
  const result = await waitTool().call({ path: '/dev/stdin', timeoutSec: 5 }, makeCtx(temp));
  assert.equal(result.state, 'error');
  assert.equal(result.reason, 'outside-cwd');
});

test('wait-4: 路径双检 = 词法 + realpath；symlink 指向 cwd 外一律拒', async () => {
  const temp = tempWorkspace();
  const outside = path.join(path.dirname(temp.workspaceDir), 'outside-target');
  fs.writeFileSync(outside, 'x', 'utf8');
  const link = path.join(temp.run.dir, 'escape');
  fs.symlinkSync(outside, link);
  fakeTiming(virtualClock());
  const result = await waitTool().call({ path: link, timeoutSec: 5 }, makeCtx(temp));
  assert.equal(result.state, 'error');
  assert.equal(result.reason, 'outside-cwd');
});

test('wait-4b: 词法越界（.. 形态）先于任何 stat 被拒', async () => {
  const temp = tempWorkspace();
  let probed = false;
  fakeTiming(virtualClock(), { lstat: () => { probed = true; return Promise.reject(ENOENT()); } });
  const result = await waitTool().call({ path: '../../../etc/passwd', timeoutSec: 5 }, makeCtx(temp));
  assert.equal(result.state, 'error');
  assert.equal(result.reason, 'outside-cwd');
  assert.equal(probed, false, '越界路径一次都不该碰磁盘');
});

test('wait-5: 预算裁剪 = min(timeoutSec, budgetEndsAt − now)——等待不吃聚合余量，余数也精确等到', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  const budgetEndsAt = clock.now() + 9_000;   // 9 秒不是 2 秒的整数倍：末步必须只睡余下的 1 秒
  fakeTiming(clock);
  const result = await waitTool().call(
    { path: temp.run.terminalFile, timeoutSec: 600 },
    makeCtx(temp, { budgetEndsAt }),
  );
  assert.equal(result.state, 'timeout');
  assert.equal(result.waitedSec, 9, '600 秒的请求被预算裁到 9 秒，一秒不多');
  assert.equal(result.cappedBy, 'budgetEndsAt', '裁剪要留名');
});

test('wait-6: IO 错误不吞不重试——立即返回 error 并带上原始错误码', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  let probes = 0;
  fakeTiming(clock, {
    lstat: () => {
      probes += 1;
      return Promise.reject(Object.assign(new Error('EIO: simulated disk failure'), { code: 'EIO' }));
    },
  });
  const result = await waitTool().call({ path: temp.run.terminalFile, timeoutSec: 60 }, makeCtx(temp));
  assert.equal(result.state, 'error');
  assert.equal(result.reason, 'io-error');
  assert.equal(result.code, 'EIO');
  assert.equal(probes, 1, 'IO 错误重试第二次 = 把同一故障当瞬态吞掉');
});

test('wait-6b: ENOTDIR（父段不是目录）= "未出现"家族，不升级为 error', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  fakeTiming(clock, {
    lstat: () => Promise.reject(Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })),
  });
  const result = await waitTool().call({ path: temp.run.terminalFile, timeoutSec: 6 }, makeCtx(temp));
  assert.equal(result.state, 'timeout');
});

test('wait-7: 文件出现后被删除 = 回到"未出现"语义——不凭上次在场假报 ready', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(temp.run.terminalFile, 'x', 'utf8');
  const first = virtualClock();
  fakeTiming(first);
  const ready = await waitTool().call({ path: temp.run.terminalFile, timeoutSec: 8 }, makeCtx(temp));
  assert.equal(ready.state, 'ready');

  fs.rmSync(temp.run.terminalFile);
  const second = virtualClock();
  fakeTiming(second);
  const again = await waitTool().call({ path: temp.run.terminalFile, timeoutSec: 8 }, makeCtx(temp));
  assert.equal(again.state, 'timeout', '删掉的标记不许被记成"已经见过"');
  assert.notEqual(again.state, 'error', '消失是未出现，不是 IO 故障');
});

test('wait-8: paused 期间等待冻结——暂停 20 分钟不误报 wait-timeout', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(temp.run.indexFile, JSON.stringify({ schemaVersion: 1, status: 'paused' }), 'utf8');
  const clock = virtualClock();
  const startedAt = clock.now();
  let woke = false;
  fakeTiming(clock, {
    lstat: () => {
      if (clock.now() - startedAt > 20 * 60_000) {
        woke = true;
        fs.writeFileSync(temp.run.indexFile, JSON.stringify({ schemaVersion: 1, status: 'running' }), 'utf8');
        return Promise.resolve(REGULAR);
      }
      return Promise.reject(ENOENT());
    },
  });
  const result = await waitTool().call({ path: temp.run.terminalFile, timeoutSec: 60 }, makeCtx(temp));
  assert.equal(result.state, 'ready', '暂停 20 分钟后仍必须等得到（timeoutSec 只有 60 秒）');
  assert.equal(woke, true);
  assert.ok(result.frozenMs >= 20 * 60_000, `冻结时长未记账：${result.frozenMs}`);
  assert.ok(result.waitedSec <= 2, `冻结的时间不许算进等待：${result.waitedSec}`);
});

test('wait-8b: 冻结同样不吃掉 budgetEndsAt——30 秒余量只被未暂停的时间消耗', async () => {
  const temp = tempWorkspace();
  const startedAt = Date.now();
  fs.writeFileSync(temp.run.indexFile, JSON.stringify({ schemaVersion: 1, status: 'running' }), 'utf8');
  const clock = virtualClock(startedAt);
  // 10:00–30:00 之间暂停（写侧属 T7，这里按 index.json 契约直写模拟）。
  setWaitForPathTimingForTesting({
    now: () => clock.now(),
    pollIntervalMs: 2_000,
    sleep: (ms) => {
      clock.advance(ms);
      const t = clock.now() - startedAt;
      const status = t >= 10_000 && t < 30_000 ? 'paused' : 'running';
      fs.writeFileSync(temp.run.indexFile, JSON.stringify({ schemaVersion: 1, status }), 'utf8');
      return Promise.resolve();
    },
    lstat: () => Promise.reject(ENOENT()),
  });
  const result = await waitTool().call(
    { path: temp.run.terminalFile, timeoutSec: 600 },
    makeCtx(temp, { budgetEndsAt: startedAt + 30_000 }),
  );
  assert.equal(result.state, 'timeout');
  assert.equal(result.waitedSec, 30, '30 秒预算全花在未暂停的探测上');
  assert.equal(result.frozenMs, 20_000, '暂停的 20 秒记为冻结，不进等待账');
  assert.equal(result.cappedBy, 'budgetEndsAt');
});

test('wait-9: pausing 不算暂停（与 run 墙钟同一规则）', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(temp.run.indexFile, JSON.stringify({ schemaVersion: 1, status: 'pausing' }), 'utf8');
  const clock = virtualClock();
  fakeTiming(clock);
  const result = await waitTool().call({ path: temp.run.terminalFile, timeoutSec: 30 }, makeCtx(temp));
  assert.equal(result.state, 'timeout');
  assert.equal(result.frozenMs, 0, 'pausing 期间等待照走——只有 paused 冻结');
});

test('wait-10: 索引读不出（缺件 / 坏 JSON）按未暂停继续等，不许当成 IO 错误中断', async () => {
  const temp = tempWorkspace();
  const clock = virtualClock();
  fakeTiming(clock);
  const missing = await waitTool().call({ path: temp.run.terminalFile, timeoutSec: 10 }, makeCtx(temp));
  assert.equal(missing.state, 'timeout');
  assert.equal(missing.paused, false, '没有索引就没有暂停证据');
  assert.equal(missing.indexUnreadable, undefined, '目录里没有索引文件是常态，不记账');

  const temp2 = tempWorkspace();
  fs.writeFileSync(temp2.run.indexFile, '{ this is not json', 'utf8');
  const clock2 = virtualClock();
  fakeTiming(clock2);
  const broken = await waitTool().call({ path: temp2.run.terminalFile, timeoutSec: 10 }, makeCtx(temp2));
  assert.equal(broken.state, 'timeout', '坏索引不许升级为 error');
  assert.equal(broken.indexUnreadable, true, '读不动要留名，不静默');
});

test('wait-11: 入参形状——path 必填、timeoutSec 必为正整数；budgetEndsAt 不在模型可传面里', () => {
  const schema = waitTool().inputSchema;
  assert.deepEqual(schema.required, ['path', 'timeoutSec']);
  assert.equal(schema.additionalProperties, false, '模型面零预算旋钮：传未声明的键即拒');
  assert.ok(!('budgetEndsAt' in schema.properties), 'budgetEndsAt 由执行器注入，不在模型可传面里');
});

test('wait-11b: path 非字符串 / timeoutSec 越界 → invalid-input（形状闸先于边界闸）', async () => {
  const temp = tempWorkspace();
  fakeTiming(virtualClock());
  const bad = await waitTool().call({ path: 42, timeoutSec: 60 }, makeCtx(temp));
  assert.equal(bad.state, 'error');
  assert.equal(bad.reason, 'invalid-input');
  const zero = await waitTool().call({ path: temp.run.terminalFile, timeoutSec: 0 }, makeCtx(temp));
  assert.equal(zero.reason, 'invalid-input');
});

test('wait-13: 等待体被中止时立即醒——死掉的汇总体不许把 promise 挂到预算尽头', async () => {
  const temp = tempWorkspace();
  const controller = new AbortController();
  const clock = virtualClock();
  setWaitForPathTimingForTesting({
    now: () => clock.now(),
    pollIntervalMs: 2_000,
    // 睡死：只有中止能把这一次调用救出来（上级硬杀 + 工具自觉同一条纪律）。
    sleep: () => new Promise(() => {}),
    lstat: () => Promise.reject(ENOENT()),
  });
  setTimeout(() => controller.abort(), 10);
  const result = await waitTool().call({ path: temp.run.terminalFile, timeoutSec: 600 }, makeCtx(temp, { signal: controller.signal }));
  assert.equal(result.state, 'error');
  assert.equal(result.reason, 'aborted');
});

test('wait-14: 已中止的调用不进循环——一进门就返回，不等首个探测', async () => {
  const temp = tempWorkspace();
  const controller = new AbortController();
  controller.abort();
  let probes = 0;
  setWaitForPathTimingForTesting({
    now: () => Date.now(),
    sleep: () => Promise.resolve(),
    lstat: () => { probes += 1; return Promise.reject(ENOENT()); },
  });
  const result = await waitTool().call({ path: temp.run.terminalFile, timeoutSec: 600 }, makeCtx(temp, { signal: controller.signal }));
  assert.equal(result.reason, 'aborted');
  assert.ok(probes <= 1, `中止后的调用只该碰一次盘，实际 ${probes}`);
});

test('wait-12: 等待期零 token —— 工具自己阻塞，不经模型回合', () => {
  const tool = waitTool();
  assert.equal(tool.isReadOnly, true, '它是只读面的一员：等待不动盘、不动账');
  assert.equal(tool.isConcurrencySafe, false, '阻塞式等待不许与其他调用并发批处理');
  for (const word of ['ready', 'timeout', 'error']) {
    assert.ok(tool.description.includes(word), `描述须写明三态之 ${word}`);
  }
});
