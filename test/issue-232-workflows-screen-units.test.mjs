// Workflows T9（#232）：Workflows 屏的装配层 —— 零件契约
//
// 这块屏只有两个数据源：热 = 进程内进度事件，冷 = 扫 run 目录读持久件（ADR-0052 §21#5）。
// 本文件锁的是"从两源拼出人看得懂的一屏"的契约：列表排序与计数口径、活跃 / 被打断 /
// 终态三个谓词各是什么、每路状态与用量怎么读、被打断的 run 怎么提示、resume 调用文本
// 怎么拼、读不动的那一条怎么留名。渲染与接线在 issue-232-workflows-screen.test.mjs。
// 票面"行为锁定从简"指不追渲染快照，不是放宽这里的断言——变则红。

import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';

import {
  EMPTY_RUN_BOARD,
  WORKFLOW_SCREEN_ACTIONS,
  applyWorkflowEvent,
  buildRunBoard,
  describeInterruptedRuns,
  interruptedRuns,
  isRunAbandoned,
  isRunUiActive,
  renderRunDetailRows,
  resumeCallText,
  runElapsed,
  runStatusTone,
  stripControlChars,
} from '../dist/tui/workflow-runs.js';
import { SCHEMA_VERSION } from '../dist/workflows/schema.js';

const NOW_ISO = '2026-10-01T10:00:00.000Z';
const NOW = Date.parse(NOW_ISO);

function index(overrides) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'running',
    ownerSessionId: 'ses_owner',
    scriptPath: '/ws/.myterminal/workflows/saved/research.js',
    sourceRef: { id: '/ws/.myterminal/workflows/saved/research.js', revision: 'r1' },
    argsRecorded: false,
    startedAt: '2026-10-01T09:50:00.000Z',
    dispatches: [],
    failures: [],
    tokens: { spent: 0 },
    ...overrides,
  };
}

/** 假源：只给"盘 / 内存"两本账，不碰真实 fs——排序与判定不能依赖 I/O 时序。 */
function fakeSource(input) {
  const ids = input.ids ?? Object.keys(input.indexes ?? {});
  return {
    listRunIds: async () => ids,
    readRun: async (runId) => {
      if (input.failing && Object.hasOwn(input.failing, runId)) throw input.failing[runId];
      return input.indexes?.[runId];
    },
    hasMarker: async (runId) => (input.markers ?? []).includes(runId),
    isLive: (runId) => (input.live ?? []).includes(runId),
    indexPath: (runId) => `/runs/${runId}/index.json`,
  };
}

function rowOf(board, runId) {
  const row = board.rows.find((item) => item.runId === runId);
  if (!row) throw new Error(`no row ${runId}`);
  return row;
}

describe('冷启动重建 run 列表（AC1 后半：无事件也从盘面重建）', () => {
  test('一个事件都没有，也能只靠盘面条目拼出列表与状态', async () => {
    const board = await buildRunBoard(fakeSource({
      indexes: { wf_a: index({ runId: 'wf_a', status: 'completed', endedAt: '2026-10-01T09:55:00.000Z' }) },
    }));
    assert.equal(board.rows.length, 1);
    assert.equal(board.rows[0].runId, 'wf_a');
    assert.equal(board.rows[0].status, 'completed');
    assert.equal(board.rows[0].live, false, '冷启动没有任何一路在本进程活着');
  });

  test('运行态与用量字段取自 index.json，不是从事件里猜的', async () => {
    const board = await buildRunBoard(fakeSource({
      indexes: { wf_a: index({ runId: 'wf_a', status: 'paused', tokens: { spent: 1234 }, reducerTokens: { spent: 77 } }) },
    }));
    const [row] = board.rows;
    assert.equal(row.status, 'paused');
    assert.equal(row.tokens, 1234);
    assert.equal(row.reducerTokens, 77, '汇总体用量是累加记账的第三档，屏上必须看得见');
    assert.equal(row.scriptPath, '/ws/.myterminal/workflows/saved/research.js');
    assert.equal(row.ownerSessionId, 'ses_owner');
  });

  test('投影不揣每路正文：全文留在盘上，屏只是索引视图', async () => {
    const board = await buildRunBoard(fakeSource({
      indexes: {
        wf_a: index({
          runId: 'wf_a',
          dispatches: [{ id: 'd0001', label: 'a', status: 'completed', attempts: 1, startedAt: NOW_ISO, outputTokens: 1, result: { answer: '几十路各带一份结构化输出，屏就成了第二个结果面' } }],
        }),
      },
    }));
    const [record] = board.rows[0].index.dispatches;
    assert.equal('result' in record, false, '正文不进投影');
    assert.equal(record.outputTokens, 1, '用量与状态照留——去掉的只是结果体');
  });

  test('排序 = 活跃置顶按起跑倒序、终态随后按收场倒序，两桶不互相插队', async () => {
    const board = await buildRunBoard(fakeSource({
      indexes: {
        wf_b002: index({ runId: 'wf_b002', status: 'failed', startedAt: '2026-10-01T06:00:00.000Z', endedAt: '2026-10-01T09:59:00.000Z' }),
        wf_b001: index({ runId: 'wf_b001', status: 'completed', startedAt: '2026-10-01T08:00:00.000Z', endedAt: '2026-10-01T10:00:00.000Z' }),
        wf_a001: index({ runId: 'wf_a001', status: 'running', startedAt: '2026-10-01T09:30:00.000Z' }),
        wf_a002: index({ runId: 'wf_a002', status: 'paused', startedAt: '2026-10-01T07:00:00.000Z' }),
      },
    }));
    assert.deepEqual(board.rows.map((row) => row.runId), [
      'wf_a001', 'wf_a002', 'wf_b001', 'wf_b002',
    ]);
  });

  test('X/Y 只数已完成的路；在飞与失败各记各的，失败清单照索引读', async () => {
    const board = await buildRunBoard(fakeSource({
      indexes: {
        wf_a: index({
          runId: 'wf_a',
          dispatches: [
            { id: 'd0001', label: 'a', status: 'completed', attempts: 1, startedAt: NOW_ISO, outputTokens: 10 },
            { id: 'd0002', label: 'b', status: 'failed', attempts: 3, startedAt: NOW_ISO, outputTokens: 5 },
            { id: 'd0003', label: 'c', status: 'running', attempts: 1, startedAt: NOW_ISO, outputTokens: 0 },
          ],
          failures: [{ label: 'b', kind: 'stalled', message: 'no progress' }],
        }),
      },
    }));
    const [row] = board.rows;
    assert.equal(row.total, 3);
    assert.equal(row.finished, 1);
    assert.equal(row.running, 1);
    assert.equal(row.failedPaths, 1);
    assert.equal(row.failures, 1, '失败清单是索引的一等字段，屏上照它报，不去遍历拼');
  });

  test('不合 runId 形态的目录名不进列表（防穿越的口在装配层也守住）', async () => {
    const board = await buildRunBoard(fakeSource({
      ids: ['..', 'wf_cafe', 'not-a-run', 'wf'],
      indexes: { wf_cafe: index({ runId: 'wf_cafe' }) },
    }));
    assert.deepEqual(board.rows.map((row) => row.runId), ['wf_cafe']);
    assert.deepEqual(board.unreadable, [], '不合形态的目录名压根不是 run，不该占用"读不动"那一格（那是给真 run 留名的）');
  });

  test('读不动的那一条留名带原因，其余照旧成屏（不静默丢、也不整屏红）', async () => {
    const board = await buildRunBoard(fakeSource({
      ids: ['wf_beef', 'wf_f00d'],
      indexes: { wf_beef: index({ runId: 'wf_beef' }) },
      failing: { wf_f00d: new Error('schemaVersion 2 is newer than 1; refusing to read index.json') },
    }));
    assert.equal(board.rows.length, 1);
    assert.equal(board.unreadable.length, 1);
    assert.equal(board.unreadable[0].runId, 'wf_f00d');
    assert.match(board.unreadable[0].message, /newer than/);
  });

  test('盘上没有索引的目录算读不动，不算一条 completed', async () => {
    const board = await buildRunBoard(fakeSource({ ids: ['wf_a'], indexes: {} }));
    assert.equal(board.rows.length, 0);
    assert.deepEqual(board.unreadable.map((item) => item.runId), ['wf_a']);
  });

  test('整个 run 目录读不动（权限一类目录级故障）说成 sourceError，不读成"一条 run 都没有"', async () => {
    const board = await buildRunBoard({
      ...fakeSource({ indexes: {} }),
      listRunIds: async () => { throw Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' }); },
    });
    assert.equal(board.rows.length, 0);
    assert.match(board.sourceError ?? '', /permission denied/);
  });
});

describe('三个谓词：UI 活跃 / 被打断 / 终态（ADR-0052 §10 状态机 / §19 暂停不是终态）', () => {
  test('running 与 pausing、paused 都算 UI 活跃（暂停不是终态）', async () => {
    const board = await buildRunBoard(fakeSource({
      indexes: {
        wf_e1: index({ runId: 'wf_e1' }),
        wf_e2: index({ runId: 'wf_e2', status: 'paused' }),
        wf_e3: index({ runId: 'wf_e3', status: 'pausing' }),
        wf_e4: index({ runId: 'wf_e4', status: 'completed' }),
        wf_e5: index({ runId: 'wf_e5', status: 'failed' }),
        wf_e6: index({ runId: 'wf_e6', status: 'cancelled' }),
      },
    }));
    const byId = (id) => rowOf(board, id);
    assert.deepEqual(['wf_e1', 'wf_e2', 'wf_e3'].filter((id) => isRunUiActive(byId(id))), ['wf_e1', 'wf_e2', 'wf_e3']);
    assert.equal(['wf_e4', 'wf_e5', 'wf_e6'].some((id) => isRunUiActive(byId(id))), false);
  });

  test('被打断 = 还挂在活跃态但本进程没在跑它（或已被认领成 failed/interrupted）', async () => {
    const board = await buildRunBoard(fakeSource({
      indexes: {
        wf_d001: index({ runId: 'wf_d001' }),
        wf_d002: index({ runId: 'wf_d002' }),
        wf_d003: index({ runId: 'wf_d003', status: 'paused' }),
        wf_d004: index({ runId: 'wf_d004', status: 'failed', reason: 'interrupted' }),
        wf_d005: index({ runId: 'wf_d005', status: 'completed' }),
      },
      live: ['wf_d001'],
      markers: ['wf_d005', 'wf_d004'],
    }));
    assert.deepEqual(interruptedRuns(board).map((row) => row.runId), ['wf_d003', 'wf_d002', 'wf_d004']);
    assert.equal(isRunAbandoned(rowOf(board, 'wf_d001')), false, '本进程在跑的不算被打断');
    assert.equal(isRunAbandoned(rowOf(board, 'wf_d002')), true);
  });

  test('有终态标记的活跃态记录不算被打断（标记在 = 账已定，不该再判一次）', async () => {
    const board = await buildRunBoard(fakeSource({
      indexes: { wf_a: index({ runId: 'wf_a', status: 'running' }) },
      markers: ['wf_a'],
    }));
    assert.deepEqual(interruptedRuns(board), []);
  });

  test('终态原因具名回显：墙钟到期与结算超期各说各的，不塌成一句 failed', async () => {
    const board = await buildRunBoard(fakeSource({
      indexes: {
        wf_c001: index({ runId: 'wf_c001', status: 'failed', reason: 'run-gate', endedAt: '2026-10-01T09:52:00.000Z' }),
        wf_c002: index({ runId: 'wf_c002', status: 'failed', reason: 'settle-timeout', endedAt: '2026-10-01T09:53:00.000Z' }),
        wf_c003: index({ runId: 'wf_c003', status: 'failed', endedAt: '2026-10-01T09:51:00.000Z' }),
      },
    }));
    assert.deepEqual(
      board.rows.map((row) => `${row.status}:${row.reason ?? '-'}`),
      ['failed:settle-timeout', 'failed:run-gate', 'failed:-'],
    );
  });
});

describe('每路状态与用量（AC2）', () => {
  const detail = index({
    runId: 'wf_a',
    status: 'completed',
    dispatches: [
      { id: 'd0001', seq: 1, label: 'survey', status: 'completed', attempts: 1, startedAt: '2026-10-01T09:50:00.000Z', endedAt: '2026-10-01T09:51:00.000Z', outputTokens: 1200, phase: 'research', model: 'qwen3.5-2b' },
      { id: 'd0002', seq: 2, label: 'audit', status: 'failed', attempts: 3, startedAt: '2026-10-01T09:51:00.000Z', endedAt: '2026-10-01T09:57:00.000Z', outputTokens: 80, error: { kind: 'stalled', message: 'no progress for 180s', reason: 'stalled' }, isolation: 'worktree', worktree: { path: '/ws/.myterminal/worktrees/wf_a-d0002', branch: 'wf/wf_a-d0002', preserved: true } },
    ],
    failures: [{ seq: 2, label: 'audit', kind: 'stalled', message: 'no progress for 180s', reason: 'stalled' }],
  });

  test('逐路给 label / 状态 / 尝试次数 / 用量 / 阶段与模型，顺序 = admission 序', () => {
    const rows = renderRunDetailRows(detail);
    assert.deepEqual(rows.map((row) => row.label), ['survey', 'audit']);
    assert.equal(rows[0].status, 'completed');
    assert.equal(rows[0].tokens, 1200);
    assert.equal(rows[0].phase, 'research');
    assert.equal(rows[0].model, 'qwen3.5-2b');
    assert.equal(rows[1].attempts, 3, '重试次数进本路终态记账，屏上要查得到这一路试了几次');
    assert.equal(rows[1].errorKind, 'stalled');
    assert.equal(rows[1].errorMessage, 'no progress for 180s');
  });

  test('有改动待处置的那一路把路径与分支带出来（§11 回报 path + branch）', () => {
    const rows = renderRunDetailRows(detail);
    assert.equal(rows[1].worktreePath, '/ws/.myterminal/worktrees/wf_a-d0002');
    assert.equal(rows[1].worktreeBranch, 'wf/wf_a-d0002');
    assert.equal(rows[1].preserved, true);
    assert.equal(rows[0].preserved, false);
  });

  test('老产物缺 seq 时退回槽位序号，缺 phase / model 不编造', () => {
    const rows = renderRunDetailRows(index({
      runId: 'wf_fe',
      dispatches: [{ id: 'd0007', label: 'solo', status: 'running', attempts: 1, startedAt: NOW_ISO, outputTokens: 0 }],
    }));
    assert.equal(rows[0].seq, 7);
    assert.equal(rows[0].phase, undefined);
    assert.equal(rows[0].model, undefined);
  });

  test('run 也可能死在脚本自身：那时逐路清单是空的（不是"零路都成功"）', () => {
    const dying = index({ runId: 'wf_ce', status: 'failed', scriptError: { kind: 'script-failed', message: 'ReferenceError: x is not defined' } });
    assert.deepEqual(renderRunDetailRows(dying), []);
    assert.equal(dying.scriptError.kind, 'script-failed');
  });
});

describe('resume 调用文本（AC4 / §8 唯一合法组合）', () => {
  test('带 scriptPath 的 run 给出可粘贴的 workflow_start 调用', async () => {
    const board = await buildRunBoard(fakeSource({ indexes: { wf_a: index({ runId: 'wf_a' }) } }));
    assert.equal(resumeCallText(board.rows[0]), 'workflow_start {"scriptPath":"/ws/.myterminal/workflows/saved/research.js","resumeFromRunId":"wf_a"}');
  });

  test('原 args 记在索引里就一起带上（args 是链的种子，不带 = 全量重跑）', async () => {
    const board = await buildRunBoard(fakeSource({
      indexes: { wf_a: index({ runId: 'wf_a', argsRecorded: true, args: { topic: 'adr', n: 3 } }) },
    }));
    assert.equal(
      resumeCallText(board.rows[0]),
      'workflow_start {"scriptPath":"/ws/.myterminal/workflows/saved/research.js","resumeFromRunId":"wf_a","args":{"topic":"adr","n":3}}',
    );
  });

  test('args 没记档时明说"补上原 args"，不给一条会静默全量重跑的假便利', async () => {
    const board = await buildRunBoard(fakeSource({
      indexes: { wf_a: index({ runId: 'wf_a', args: { topic: 'adr' }, argsRecorded: false }) },
    }));
    const call = resumeCallText(board.rows[0], { annotate: true });
    assert.match(call, /"resumeFromRunId":"wf_a"/);
    assert.doesNotMatch(call, /"args"/, '没记档的 args 绝不冒充原 args');
    assert.match(call, /original args/);
  });

  test('脚本引用丢了就没有 resume 可给（宁可不给，不给一条必然被拒的调用）', async () => {
    const board = await buildRunBoard(fakeSource({ indexes: { wf_a: index({ runId: 'wf_a', scriptPath: '' }) } }));
    assert.equal(resumeCallText(board.rows[0]), undefined);
  });
});

function abandoned(runId, extra) {
  const merged = { runId, scriptPath: '/p.js', ...extra };
  return {
    status: 'running', reason: undefined, ownerSessionId: 'ses',
    startedAt: NOW_ISO, endedAt: undefined, finished: 2, total: 5, running: 1, failedPaths: 1, failures: 1,
    tokens: 900, reducerTokens: 0, live: false, hasMarker: false, indexPath: '/idx', ...merged,
    index: index(merged),
  };
}

describe('启动提示：上次被打断的 run（AC4 / §12）', () => {
  const en = (english) => english;
  const opts = { now: NOW, maxListed: 3 };

  test('没有被打断的 run 就没有提示（空态不是提示）', () => {
    assert.equal(describeInterruptedRuns([], en, opts), undefined);
  });

  test('一条：单数首行 + runId 与 X/Y 进度，另附可粘贴的 resume 调用', () => {
    const notice = describeInterruptedRuns([abandoned('wf_1ce')], en, opts);
    assert.ok(notice);
    assert.match(notice.head, /1 interrupted workflow run\b/);
    assert.match(notice.lines[0], /wf_1ce .*2\/5 agents finished/);
    assert.match(notice.resume('wf_1ce'), /workflow_start \{"scriptPath":"\/p\.js","resumeFromRunId":"wf_1ce"\}/);
  });

  test('多条用复数首行', () => {
    const notice = describeInterruptedRuns([abandoned('wf_a'), abandoned('wf_b')], en, opts);
    assert.ok(notice);
    assert.match(notice.head, /2 interrupted workflow runs/);
  });

  test('多于上限只列三行，其余折成 and N more（提示不许变成刷屏）', () => {
    const many = ['wf_a', 'wf_b', 'wf_e4', 'wf_d', 'wf_e'].map((id) => abandoned(id));
    const notice = describeInterruptedRuns(many, en, opts);
    assert.ok(notice);
    assert.equal(notice.lines.filter((line) => line.includes('agents finished')).length, 3);
    assert.match(notice.lines[notice.lines.length - 1], /and 2 more/);
  });

  test('一路都没派出去的 run 不显示进度段（0/0 读起来像坏了）', () => {
    const notice = describeInterruptedRuns([abandoned('wf_0', { total: 0, finished: 0 })], en, opts);
    assert.ok(notice);
    assert.doesNotMatch(notice.lines[0], /\d+\/\d+ agents/);
    assert.match(notice.lines[0], /wf_0/);
  });

  test('提示永不抛：条目形状再怪也只折成没提示（一条提示不值得把启动搭进去）', () => {
    const junk = [{ runId: 123 }, null, undefined];
    assert.doesNotThrow(() => describeInterruptedRuns(junk, en, opts));
    assert.equal(describeInterruptedRuns(junk, en, opts), undefined);
  });
});

describe('口径与负向（AC5）', () => {
  test('时长：在跑的按 now 计、终态按 endedAt 计、坏时间戳回破折号（不出现 NaN）', () => {
    assert.equal(runElapsed('2026-10-01T09:50:00.000Z', undefined, NOW), '10m00s');
    assert.equal(runElapsed('2026-10-01T09:50:00.000Z', '2026-10-01T09:50:45.000Z', NOW), '45s');
    assert.equal(runElapsed('2026-10-01T09:00:00.000Z', '2026-10-01T10:00:00.000Z', NOW), '1h00m');
    assert.equal(runElapsed('not-a-date', undefined, NOW), '-');
    assert.equal(runElapsed(undefined, undefined, NOW), '-');
  });

  test('控制字符一律剥掉（runId 出自目录名，屏上不能让它自己染色）', () => {
    const esc = String.fromCharCode(27);
    assert.equal(stripControlChars('wf_' + esc + '[31mRED'), 'wf_RED');
    assert.equal(stripControlChars('wf_cafe'), 'wf_cafe');
    assert.equal(stripControlChars(undefined), '');
  });

  test('六个状态各有色带，未知状态归中性（不得被误染成错误红）', () => {
    assert.equal(runStatusTone('running'), 'accent');
    assert.equal(runStatusTone('pausing'), 'warn');
    assert.equal(runStatusTone('paused'), 'warn');
    assert.equal(runStatusTone('completed'), 'good');
    assert.equal(runStatusTone('failed'), 'bad');
    assert.equal(runStatusTone('cancelled'), 'muted');
    assert.equal(runStatusTone('bogus'), 'muted');
  });

  test('v1 负向：这块屏只有看与三个控制动作，没有聊天与发提醒的口子', () => {
    assert.deepEqual(WORKFLOW_SCREEN_ACTIONS, ['open', 'cancel', 'pause', 'resume', 'copyResume']);
  });
});

describe('热路径：事件到投影（AC1 前半）', () => {
  const boardOf = async (runId, overrides) => buildRunBoard(fakeSource({ indexes: { [runId]: index({ runId, ...overrides }) } }));
  const event = (runId, type, data) => ({ runId, type, at: NOW_ISO, ...(data ? { data } : {}) });

  const ctx = { indexPath: (runId) => `/runs/${runId}/index.json` };

  test('run_started 带上活索引 → 新行置顶，且算本进程在跑', async () => {
    const board = await boardOf('wf_a');
    const next = applyWorkflowEvent(board, event('wf_b', 'run_started'), { ...ctx, liveIndex: () => index({ runId: 'wf_b' }) });
    assert.equal(next.rows[0].runId, 'wf_b');
    assert.equal(next.rows[0].live, true);
    assert.equal(next.rows[0].status, 'running');
    assert.equal(next.rows[0].indexPath, '/runs/wf_b/index.json', '新行的索引路径出自布局，不是拼出来的字符串');
  });

  test('run_started 没有活索引可给（别的进程起的）→ 不动投影，等下一次扫盘', async () => {
    const board = await boardOf('wf_a');
    assert.equal(applyWorkflowEvent(board, event('wf_b', 'run_started'), ctx), board);
  });

  test('dispatch_settled 只改那一路的状态，X/Y 与失败数随之重算', async () => {
    const board = await boardOf('wf_a', {
      dispatches: [
        { id: 'd0001', label: 'a', status: 'completed', attempts: 1, startedAt: NOW_ISO, outputTokens: 1 },
        { id: 'd0002', label: 'b', status: 'running', attempts: 1, startedAt: NOW_ISO, outputTokens: 0 },
      ],
    });
    const next = applyWorkflowEvent(board, event('wf_a', 'dispatch_settled', { dispatchId: 'd0002', status: 'failed' }));
    assert.equal(next.rows[0].finished, 1);
    assert.equal(next.rows[0].failedPaths, 1);
    assert.equal(next.rows[0].running, 0);
    assert.equal(next.rows[0].index.dispatches[1].status, 'failed');
    assert.equal(board.rows[0].index.dispatches[1].status, 'running', '原投影不被就地改（缓存要能对比出变化）');
  });

  test('pause / pausing / resume 三个事件各把状态推到投影上', async () => {
    const board = await boardOf('wf_a');
    let next = applyWorkflowEvent(board, event('wf_a', 'run_pausing'));
    assert.equal(next.rows[0].status, 'pausing');
    next = applyWorkflowEvent(next, event('wf_a', 'run_paused'));
    assert.equal(next.rows[0].status, 'paused');
    assert.equal(isRunUiActive(next.rows[0]), true, '暂停的行仍算活跃（还在跳）');
    next = applyWorkflowEvent(next, event('wf_a', 'run_resumed'));
    assert.equal(next.rows[0].status, 'running');
  });

  test('run_settled 把终态、具名原因、收场时刻与标记位一起落地', async () => {
    const board = await boardOf('wf_a');
    const next = applyWorkflowEvent(board, event('wf_a', 'run_settled', { status: 'failed', reason: 'run-gate', markerWritten: true }));
    const [row] = next.rows;
    assert.equal(row.status, 'failed');
    assert.equal(row.reason, 'run-gate');
    assert.equal(row.endedAt, NOW_ISO);
    assert.equal(row.hasMarker, true);
    assert.equal(row.live, false, '终态了就不再是"本进程在跑"');
    assert.equal(isRunAbandoned(row), false);
  });

  test('标记没写成的那一拍如实呈现（后到者退让时盘面确实无标记）', () => {
    const next = applyWorkflowEvent(EMPTY_RUN_BOARD, event('wf_a', 'run_settled', { status: 'cancelled', markerWritten: false }));
    assert.equal(next.rows.length, 0, '空投影里凭空一条终态 run 不该造行');
  });

  test('认不出的事件类型不动投影（模块后面加事件不至于把屏搞坏）', async () => {
    const board = await boardOf('wf_a');
    assert.equal(applyWorkflowEvent(board, event('wf_a', 'run_wobbled')), board);
  });

  test('投影握着的是取到的那一拍：引擎随后原地改账，屏上不许跟着自己动', async () => {
    const board = await boardOf('wf_a');
    const mutable = index({ runId: 'wf_b', dispatches: [] });
    const started = applyWorkflowEvent(board, event('wf_b', 'run_started'), { ...ctx, liveIndex: () => mutable });
    assert.equal(started.rows.find((row) => row.runId === 'wf_b').total, 0);
    // 引擎就是这么写的：context.index.dispatches = [...新数组] 落回同一个对象。
    mutable.dispatches = [{ id: 'd0001', label: 'a', status: 'completed', attempts: 1, startedAt: NOW_ISO, outputTokens: 1 }];
    mutable.status = 'completed';
    const held = started.rows.find((row) => row.runId === 'wf_b');
    assert.equal(held.total, 0, '投影必须自持一份账，否则屏会在无人通知的情况下自己变');
    assert.equal(held.index.dispatches.length, 0);
    assert.equal(held.status, 'running');
  });
});
