import { test } from 'bun:test';
import assert from 'node:assert/strict';

// ── Import 构建产物（与仓库其余测试一致，跑 dist）──
import {
  enforceMessageBudget,
  resetReplacementDecisions,
} from '../dist/subagent/result-budget.js';

// ═══════════════════════════════════════════════
// Issue #77 Prove-It：replacement-decisions 跨 agent 串扰
// 旧实现把决策存在 defaultContext 单例上，任何 agent 的
// resetReplacementDecisions() 都会清空全局，导致并发/相继
// 运行的 agent 之间冻结决策互相污染。
// 修复后按 agentId 分桶，reset(agentA) 不得动 agentB 的桶。
//
// 关键：用「round2 内容变小、总字符 ≤ 200K」隔离出"冻结决策"效果——
// 仅当冻结决策仍在时 round2 才会被压；预算路径本身在 ≤200K 时不会压。
// ═══════════════════════════════════════════════

const BIG = 'x'.repeat(300_000); // 超过 MAX_RESULT_SIZE 且超消息组预算，必触发压缩冻结

test('agentB 的 reset 不得清空 agentA 的冻结决策（跨 agent 串扰核心）', () => {
  const agentA = 'agent-A';
  const agentB = 'agent-B';

  // agentA round1：超预算，a1 被冻结为 preview
  const rA1 = [{ tool_use_id: 'a1', content: BIG, is_error: false }];
  enforceMessageBudget(rA1, agentA);
  assert.ok(rA1[0].content.includes('budget-compressed'), 'agentA a1 应被冻结压缩');

  // 模拟 disposeAgent(agentB) —— 只应清 agentB 的桶
  resetReplacementDecisions(agentB);

  // agentA round2：内容变小，总字符 ≤ 200K。
  // 若串扰未修复（共享单例），agentB 的 reset 已清空全局 → a1 冻结决策丢失 → 不被压（错）。
  // 修复后 agentA 的桶完好 → a1 仍被压。
  const rA2 = [{ tool_use_id: 'a1', content: 'small-a1-after', is_error: false }];
  enforceMessageBudget(rA2, agentA);
  assert.ok(rA2[0].content.includes('budget-compressed'), 'agentA 的冻结决策在 agentB reset 后仍应生效');
});

test('resetReplacementDecisions(agentB) 只清空 agentB 自己的桶（且非 no-op）', () => {
  const agentB = 'agent-B2';

  // round1：超预算，b1 被冻结
  const r1 = [{ tool_use_id: 'b1', content: BIG, is_error: false }];
  enforceMessageBudget(r1, agentB);
  assert.ok(r1[0].content.includes('budget-compressed'), 'round1 b1 应被冻结压缩');

  // 清空 agentB 自己的桶
  resetReplacementDecisions(agentB);

  // round2：内容变小，总字符 ≤ 200K。冻结已清 → 不应再被压（若 reset 是 no-op 则会错压）
  const r2 = [{ tool_use_id: 'b1', content: 'small-after-reset', is_error: false }];
  enforceMessageBudget(r2, agentB);
  assert.ok(!r2[0].content.includes('budget-compressed'), 'reset 后 agentB 冻结应失效，小内容不再被压缩');
});
