// #29（批5 第 9 刀 / ADR-0032 / G4）TuiController 对话流/字段解析纯函数 seam 锁定
//
// 锁定对象：src/tui/controller-logic.ts —— 自 TuiController 内联块逐字抽出的纯函数：
//   - parseSelectedFields      （原 state.ts:342 字段多选解析）
//   - passiveLockFallback      （原 :330-334 被动锁默认选项）
//   - buildSettingsQuestions   （原 :344-362 字段→表单问题+校验器）
//   - resolveSettingsAnswers   （原 :382-401 票面点名的 (fields, answers, current) 纯块）
//   - splitList / buildChildTaskPackage（原 :204-205 createSession 组装）
//   - sessionActionOptions     （原 :231-232 终态判定与动作列表）
//
// G4 顺序：本测试先对逻辑副本转绿（锁现状）→ 再改 TuiController 调用点 → 本测试原样绿 + 全量绿。
// 行为不变铁律：断言全部按 state.ts 现行内联行为编写，不引入任何新语义。

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  parseSelectedFields,
  passiveLockFallback,
  buildSettingsQuestions,
  resolveSettingsAnswers,
  splitList,
  buildChildTaskPackage,
  sessionActionOptions,
} from '../dist/tui/controller-logic.js';

const text = (en) => en;

const current = {
  schemaVersion: 1,
  workspaceDir: '/tmp/ws-a',
  host: '127.0.0.1',
  port: 4680,
  connectorKey: 'k'.repeat(32),
  actionsToken: 't'.repeat(32),
  publicBaseUrl: '',
  maxOutputChars: 60000,
  commandTimeoutSec: 120,
  uiLanguage: 'zh-CN',
  uiTheme: 'dark',
  passiveLockEnabled: false,
  actionsContinuationMode: 'adaptive',
  nonBlockingTasksEnabled: false,
};

const ALL_FIELDS = ['language', 'theme', 'host', 'port', 'public-url', 'max-output', 'timeout', 'actions-continuation', 'non-blocking-tasks', 'passive-lock'];

describe('#29 parseSelectedFields（:342）', () => {
  test('split/trim/lower/去重/滤空 与内联行为一致', () => {
    assert.deepEqual(parseSelectedFields(' Theme, port ,theme,, PORT ,'), ['theme', 'port']);
    assert.deepEqual(parseSelectedFields(''), []);
    assert.deepEqual(parseSelectedFields('language'), ['language']);
  });
});

describe('#29 passiveLockFallback（:330-334）', () => {
  test('未启用一律 off', () => {
    assert.equal(passiveLockFallback(false, 'armed'), 'off');
    assert.equal(passiveLockFallback(false, 'unsupported'), 'off');
  });
  test('启用时 armed/arming/visible_waiting_for_arm → arm，其余 → standby', () => {
    assert.equal(passiveLockFallback(true, 'armed'), 'arm');
    assert.equal(passiveLockFallback(true, 'arming'), 'arm');
    assert.equal(passiveLockFallback(true, 'visible_waiting_for_arm'), 'arm');
    assert.equal(passiveLockFallback(true, 'stopped'), 'standby');
    assert.equal(passiveLockFallback(true, 'unsupported'), 'standby');
  });
});

describe('#29 buildSettingsQuestions（:344-362）', () => {
  test('全字段问题顺序、fallback、options 与内联一致', () => {
    const result = buildSettingsQuestions(ALL_FIELDS, { current, passiveFallback: 'off', text });
    assert.equal(result.ok, true);
    const q = result.questions;
    assert.equal(q.length, ALL_FIELDS.length);
    assert.deepEqual(q[0], { label: 'UI language', fallback: 'zh-CN', options: ['zh-CN', 'en'] });
    assert.deepEqual(q[1], { label: 'UI theme', fallback: 'dark', options: ['dark', 'light'] });
    assert.equal(q[2].label, 'Listen host'); assert.equal(q[2].fallback, '127.0.0.1');
    assert.equal(q[3].label, 'Listen port'); assert.equal(q[3].fallback, '4680');
    assert.equal(q[4].label, 'Public HTTPS URL (local clears)'); assert.equal(q[4].fallback, 'local');
    assert.equal(q[5].fallback, '60000');
    assert.equal(q[6].fallback, '120');
    assert.deepEqual(q[7].options, ['off', 'adaptive', 'next-call', 'lookahead-3']);
    assert.deepEqual(q[8], { label: 'Non-blocking tasks', fallback: 'off', options: ['off', 'on'] });
    assert.deepEqual(q[9], { label: 'macOS passive lock', fallback: 'off', options: ['off', 'arm', 'standby'] });
  });

  test('workspace 字段：目录不可用返回错误标记（原 log+return 中止路径）', () => {
    const result = buildSettingsQuestions(['workspace'], { current, passiveFallback: 'off', text });
    assert.deepEqual(result, { ok: false, error: 'workspace-unavailable' });
  });

  test('workspace 字段：目录可用时透传选择器问题', () => {
    const workspaceQuestion = { label: 'Workspace', options: ['1'] };
    const result = buildSettingsQuestions(['workspace', 'theme'], { current, workspaceQuestion, passiveFallback: 'off', text });
    assert.equal(result.ok, true);
    assert.equal(result.questions[0], workspaceQuestion);
    assert.equal(result.questions[1].label, 'UI theme');
  });

  test('校验器行为与内联一致（host/port/public-url/max-output/timeout）', () => {
    const { questions: q } = buildSettingsQuestions(ALL_FIELDS, { current, passiveFallback: 'off', text });
    // host 非空
    assert.equal(q[2].validate('  '), 'Host cannot be empty.');
    assert.equal(q[2].validate('0.0.0.0'), undefined);
    // port 0-65535 整数
    assert.equal(q[3].validate('65535'), undefined);
    assert.equal(q[3].validate('65536'), 'Port must be an integer from 0 to 65535.');
    assert.equal(q[3].validate('abc'), 'Port must be an integer from 0 to 65535.');
    // public-url：local 放行、https 放行、普通 http 拒绝、末尾斜杠先剥再验
    assert.equal(q[4].validate('LOCAL'), undefined);
    assert.equal(q[4].validate('https://example.com/'), undefined);
    assert.equal(q[4].validate('http://example.com'), 'Use HTTPS; localhost may use HTTP.');
    assert.equal(q[4].validate('http://127.0.0.1:8080'), undefined);
    // max-output 4000-1000000
    assert.equal(q[5].validate('4000'), undefined);
    assert.equal(q[5].validate('3999'), 'Use an integer from 4000 to 1000000.');
    // timeout 1-3600
    assert.equal(q[6].validate('3600'), undefined);
    assert.equal(q[6].validate('0'), 'Use an integer from 1 to 3600.');
  });
});

describe('#29 resolveSettingsAnswers（:382-401）', () => {
  const ws = { items: [] };

  test('逐字段映射与内联一致', () => {
    const fields = ['language', 'theme', 'host', 'port', 'public-url', 'max-output', 'timeout', 'actions-continuation', 'non-blocking-tasks'];
    const answers = ['en', 'light', '0.0.0.0', '5000', 'https://ex.com/', '80000', '300', 'off', 'on'];
    const { next, passiveAction } = resolveSettingsAnswers(fields, answers, current, ws);
    assert.equal(next.uiLanguage, 'en');
    assert.equal(next.uiTheme, 'light');
    assert.equal(next.host, '0.0.0.0');
    assert.equal(next.port, 5000);
    assert.equal(next.publicBaseUrl, 'https://ex.com'); // 末尾斜杠剥除
    assert.equal(next.maxOutputChars, 80000);
    assert.equal(next.commandTimeoutSec, 300);
    assert.equal(next.actionsContinuationMode, 'off');
    assert.equal(next.nonBlockingTasksEnabled, true);
    assert.equal(passiveAction, undefined);
    // 未选字段保持原值
    assert.equal(next.workspaceDir, current.workspaceDir);
    assert.equal(next.connectorKey, current.connectorKey);
  });

  test('数字字段坏输入回退 current（integer fallback）', () => {
    const { next } = resolveSettingsAnswers(['port', 'max-output', 'timeout'], ['abc', 'x', ''], current, ws);
    assert.equal(next.port, current.port);
    assert.equal(next.maxOutputChars, current.maxOutputChars);
    assert.equal(next.commandTimeoutSec, current.commandTimeoutSec);
  });

  test('public-url：LOCAL（任意大小写）清空', () => {
    const { next } = resolveSettingsAnswers(['public-url'], ['LOCAL'], { ...current, publicBaseUrl: 'https://old.com' }, ws);
    assert.equal(next.publicBaseUrl, '');
  });

  test('passive-lock：arm/standby 置 enabled=true，off 置 false，passiveAction 透出', () => {
    const armed = resolveSettingsAnswers(['passive-lock'], ['ARM'], current, ws);
    assert.equal(armed.next.passiveLockEnabled, true);
    assert.equal(armed.passiveAction, 'arm');
    const off = resolveSettingsAnswers(['passive-lock'], ['off'], { ...current, passiveLockEnabled: true }, ws);
    assert.equal(off.next.passiveLockEnabled, false);
    assert.equal(off.passiveAction, 'off');
  });

  test('workspace：目录项按 1 起始序号解析；添加项取 addedWorkspaceDir；未命中 throw', () => {
    const items = [
      { id: 'w1', title: 'A', workspaceDir: '/tmp/ws-a', status: '', activity: 'current', active: true, disabled: false },
      { id: '__add_workspace__', title: 'Add', workspaceDir: '', status: '', activity: 'inactive', active: false, disabled: false },
    ];
    const picked = resolveSettingsAnswers(['workspace'], ['1'], current, { items });
    assert.equal(picked.next.workspaceDir, '/tmp/ws-a');
    const added = resolveSettingsAnswers(['workspace'], ['2'], current, { items, addedWorkspaceDir: '/tmp/ws-new' });
    assert.equal(added.next.workspaceDir, '/tmp/ws-new');
    assert.throws(() => resolveSettingsAnswers(['workspace'], ['9'], current, { items }), /did not resolve to a catalog entry/);
  });
});

describe('#29 splitList / buildChildTaskPackage（:204-205）', () => {
  test('分号分隔、trim、滤空', () => {
    assert.deepEqual(splitList(' a ; b;; c '), ['a', 'b', 'c']);
    assert.deepEqual(splitList(''), []);
  });
  test('TaskPackage 组装取 answers[3..7]', () => {
    const answers = ['root-id', 'child', 'developer', 'obj', 'bg', 'd1;d2', 'ac1', 'c1; c2'];
    assert.deepEqual(buildChildTaskPackage(answers), {
      objective: 'obj',
      background: 'bg',
      deliverables: ['d1', 'd2'],
      acceptanceCriteria: ['ac1'],
      constraints: ['c1', 'c2'],
    });
  });
});

describe('#29 sessionActionOptions（:231-232）', () => {
  test('终态（completed/cancelled）→ context/delete/continue', () => {
    assert.deepEqual(sessionActionOptions({ phase: 'completed' }), { terminal: true, actions: ['context', 'delete', 'continue'] });
    assert.deepEqual(sessionActionOptions({ phase: 'cancelled' }), { terminal: true, actions: ['context', 'delete', 'continue'] });
  });
  test('活动态 → copy/revoke/cancel/context/delete', () => {
    assert.deepEqual(sessionActionOptions({ phase: 'working' }), { terminal: false, actions: ['copy', 'revoke', 'cancel', 'context', 'delete'] });
    assert.deepEqual(sessionActionOptions({ phase: 'blocked' }), { terminal: false, actions: ['copy', 'revoke', 'cancel', 'context', 'delete'] });
  });
});
