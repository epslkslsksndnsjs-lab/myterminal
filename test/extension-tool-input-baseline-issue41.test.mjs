// #70 门禁锁测试：MCP 协议层 extension_call/register 入参 schema 必须保持 main 09f2246 基线行为。
// 回归背景：#41 曾把 44 字段 z.object(...).catchall(z.unknown()) 退化为 z.record(z.string(), z.unknown())，
// 使 limit:"abc" / mode:"wildcard" 等 6 类类型错误从「协议层即拒」放宽为「协议层放行」。
// 探针实证见 scripts/probe-41-baseline-vs-seams.mjs（8 用例 6 不一致）。
// 本锁 = 基线快照：已声明字段的类型校验必须生效；未声明字段必须放行（catchall 语义）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionToolInput } from '../dist/mcp.js';

const rejects = [
  ['limit 传字符串', { limit: 'abc' }],
  ['limit 传小数（int 约束）', { limit: 1.5 }],
  ['offset 传小数', { offset: 2.5 }],
  ['mode 传非枚举值', { mode: 'wildcard' }],
  ['phase 传非枚举值', { phase: 'sleeping' }],
  ['markRead 传字符串', { markRead: 'yes' }],
  ['includeAncestors 传数字', { includeAncestors: 1 }],
  ['deliverables 传字符串而非数组', { deliverables: 'a,b' }],
  ['tags 传字符串而非数组', { tags: 'x' }],
  ['name 传数字', { name: 123 }],
  ['task 传数组而非对象', { task: [1, 2] }],
  ['timeoutSec 传字符串', { timeoutSec: '30' }],
];

const accepts = [
  ['空对象', {}],
  ['合法输入', { limit: 10, mode: 'root', markRead: true }],
  ['未声明的额外字段（catchall 放行）', { somethingNew: 42, another: { deep: true } }],
  ['合法 + 未声明字段混合', { limit: 3, unknownKnob: 'ok' }],
  ['phase 合法枚举', { phase: 'blocked' }],
  ['deliverables 合法数组', { deliverables: ['a', 'b'] }],
];

test('PROTO-LOCK-1: 已声明字段的类型错误必须在协议层被拒（main 基线）', () => {
  for (const [label, value] of rejects) {
    const r = extensionToolInput.safeParse(value);
    assert.equal(r.success, false, `应拒绝：${label} ${JSON.stringify(value)}`);
  }
});

test('PROTO-LOCK-2: 合法输入与未声明字段必须放行（catchall 语义，main 基线）', () => {
  for (const [label, value] of accepts) {
    const r = extensionToolInput.safeParse(value);
    assert.equal(r.success, true, `应放行：${label} ${JSON.stringify(value)}`);
  }
});

// A48-W1 低危B-4：note/patch 死字段（37 工具零消费、additionalProperties:false 必拒）已删 → 44→42
test('PROTO-LOCK-3: 基线 42 个已声明字段一个不少（防字段清单腐烂/漂移）', () => {
  const shape = extensionToolInput._def?.shape ?? extensionToolInput.shape;
  const keys = Object.keys(typeof shape === 'function' ? shape() : shape).sort();
  const BASELINE_42 = [
    'acceptanceCriteria', 'artifacts', 'background', 'blockers', 'body', 'claimCode',
    'command', 'constraints', 'content', 'continuesSessionId', 'createParents', 'cwd',
    'deliverables', 'encoding', 'eventIds', 'includeAncestors', 'limit', 'markRead',
    'milestone', 'mode', 'name', 'nextCalls', 'nextSteps', 'objective', 'offset',
    'path', 'phase', 'replanReason', 'role', 'session', 'sessionId', 'sessionToken',
    'sha256', 'summary', 'tags', 'targetSessionId', 'task', 'taskId', 'timeoutSec', 'to',
    'with', 'workspaceId',
  ];
  assert.deepEqual(keys, BASELINE_42, '协议层字段清单偏离 A48-W1 修订基线（44 删 note/patch = 42）');
});
