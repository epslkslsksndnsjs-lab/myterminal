// ADR-0048 T11（#142）：mock-llm 假网关端到端（3 层压缩全流程完整模拟，最后测）
//
// 验收覆盖（对应 #142 Acceptance criteria）：
//   AC1 mock-llm 可独立起停，剧本化响应（流式/工具调用/4xx/超时(stall)/慢速/挂死）
//   AC2 全链路端到端跑通且零真 key（settings.baseUrl 指向 mock-llm，请求全部落在 mock）
//   AC3 3 层压缩各层端到端用例：微压缩替换 COMPACTABLE_TOOLS 结果 / autocompact 摘要 /
//       连续失败熔断（MAX_COMPACT_FAILURES=3）
//   AC4 autocompact-issue48 回归绿（挂死 provider → watchdog 中断降级——e2e 级：
//       真 adapter 打向挂死的 mock-llm，短 idleTimeoutMs 注入）
//
// 测试方式：MockLlmServer（test/fixtures/mock-llm-server.mjs）+ setRunnerDepsForTesting
// 注入真实 runSubagentImpl（m8/W2-07 手法）——全链路 runner→executor→llm-adapter→mock-llm。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockLlmServer, textReply, toolUseReply, jsonTextReply, httpErrorReply, slowTextReply, stallMidStreamReply, hangReply } from './fixtures/mock-llm-server.mjs';
import { runSubagent, microCompact, autoCompact } from '../dist/subagent/executor.js';
import { LlmError, withReliability, createAdapter, STREAM_IDLE_TIMEOUT_MS } from '../dist/subagent/llm-adapter.js';
import { setRunnerDepsForTesting, resetSubagentRunner, getSubagentRunner } from '../dist/subagent/runner.js';
import { clearAllSubagents } from '../dist/subagent/store.js';
import { clearAllShellTasks } from '../dist/subagent/shell-tracker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let MOCK;
let TMP;

afterEach(async () => {
  resetSubagentRunner();
  clearAllSubagents();
  clearAllShellTasks();
  if (MOCK) { await MOCK.stop().catch(() => {}); MOCK = undefined; }
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

async function startMock() {
  MOCK = new MockLlmServer();
  await MOCK.start();
  return MOCK;
}

/** 指向 mock-llm 的真实 adapter（零真 key——apiKey 为占位）。 */
function mockAdapter(mock, { baseUrl } = {}) {
  return createAdapter({ baseUrl: baseUrl ?? mock.url, apiKey: 'test-mock-key', provider: 'anthropic', model: 'claude-mock' });
}

/** 指向 mock-llm 的 settings（全链路用）。 */
function mockSettings(mock, overrides = {}) {
  return {
    enabled: true,
    provider: 'anthropic',
    model: 'claude-mock',
    maxTurns: 20,
    timeoutSec: 30,
    maxParallel: 2,
    baseUrl: mock.url,
    apiKey: 'test-mock-key',
    compactThreshold: 1_000_000, // 默认不触发 autocompact
    maxOutput: 32000,
    ...overrides,
  };
}

/** 真实 runner 链的 fake deps（W2-07 手法）——runSubagentImpl 用真实现。 */
function realChainDeps(settings, workspaceDir) {
  return {
    runSubagentImpl: runSubagent,
    settings,
    workspaceDir,
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: (parentId, args) => {
      const sid = `ses_child_${Math.random().toString(36).slice(2, 10)}`;
      return {
        session: { id: sid, name: args.name, role: 'worker', phase: 'working', presence: 'claimed', parentSessionId: parentId, task: args.task, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        identity: { sessionId: sid, sessionToken: `tok_${Math.random().toString(36).slice(2, 10)}` },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// AC1：mock-llm 独立起停 + 剧本化响应冒烟
// ═══════════════════════════════════════════════════════════════

test('142-AC1: mock-llm 独立起停 + 各剧本可经真实 adapter 消费', async () => {
  const mock = await startMock();

  // 流式文本
  mock.queue.push(textReply('hello stream'));
  {
    const adapter = mockAdapter(mock);
    const chunks = [];
    for await (const c of adapter.stream({ model: 'claude-mock', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 100 }, new AbortController().signal)) chunks.push(c);
    const text = chunks.filter((c) => c.type === 'text_delta').map((c) => c.text).join('');
    assert.equal(text, 'hello stream', 'SSE 流式剧本可消费');
  }

  // 工具调用
  mock.queue.push(toolUseReply('read_file', { path: 'a.txt' }));
  {
    const adapter = mockAdapter(mock);
    const chunks = [];
    for await (const c of adapter.stream({ model: 'claude-mock', messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }], tools: [], maxTokens: 100 }, new AbortController().signal)) chunks.push(c);
    const start = chunks.find((c) => c.type === 'tool_call_start');
    const deltas = chunks.filter((c) => c.type === 'tool_call_delta').map((c) => c.jsonFragment).join('');
    assert.equal(start?.name, 'read_file', 'tool_use 块解析出工具名');
    assert.equal(JSON.parse(deltas).path, 'a.txt', 'input_json_delta 增量拼装正确');
  }

  // 429 → rate_limit 分类（#165 收窄口径：429 与 cache_control 无关——不重试、不碰缓存开关）
  mock.queue.push(httpErrorReply(429, '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'));
  {
    const adapter = mockAdapter(mock);
    await assert.rejects(
      (async () => { for await (const _ of adapter.stream({ model: 'claude-mock', system: 'You are a mock probe.', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 100 }, new AbortController().signal)) {} })(),
      (err) => err instanceof LlmError && err.kind === 'rate_limit',
      '429 → rate_limit 分类',
    );
    const before = mock.requests.length;
    const reqBodies = mock.requests.slice(-1).map((r) => JSON.stringify(r.body));
    assert.equal(reqBodies.length, 1, '#165：429 不触发去断点重试（单请求落 mock）');
    assert.ok(reqBodies[0].includes('cache_control'), '429 不碰缓存开关——请求仍带断点');
    assert.equal(before, mock.requests.length, '无额外请求');
  }

  // 慢速流式（进度在动——不触发 watchdog）
  mock.queue.push(slowTextReply('slow but alive', { chunkSize: 5, delayMs: 20 }));
  {
    const adapter = withReliability(mockAdapter(mock), { idleTimeoutMs: 2000 });
    const chunks = [];
    for await (const c of adapter.stream({ model: 'claude-mock', messages: [{ role: 'user', content: [{ type: 'text', text: 'slow' }] }], tools: [], maxTokens: 100 }, new AbortController().signal)) chunks.push(c);
    const text = chunks.filter((c) => c.type === 'text_delta').map((c) => c.text).join('');
    assert.equal(text, 'slow but alive', '慢速剧本不触发空闲 watchdog');
  }

  // 中途断流（stall）→ 空闲 watchdog 中断
  mock.queue.push(stallMidStreamReply());
  {
    const adapter = withReliability(mockAdapter(mock), { idleTimeoutMs: 400 });
    await assert.rejects(
      (async () => { for await (const _ of adapter.stream({ model: 'claude-mock', messages: [{ role: 'user', content: [{ type: 'text', text: 'stall' }] }], tools: [], maxTokens: 100 }, new AbortController().signal)) {} })(),
      LlmError,
      'stall 剧本 → watchdog 中断抛 LlmError',
    );
  }

  // 挂死（响应头都不发）→ 总超时 watchdog 中断（create 路径）
  mock.queue.push(hangReply());
  {
    const adapter = withReliability(mockAdapter(mock), { idleTimeoutMs: 400 });
    await assert.rejects(
      adapter.create({ model: 'claude-mock', messages: [{ role: 'user', content: [{ type: 'text', text: 'hang' }] }], tools: [], maxTokens: 100 }, new AbortController().signal),
      LlmError,
      '挂死剧本 → watchdog 中断抛 LlmError',
    );
  }

  await mock.stop();
  MOCK = undefined;
}, { timeout: 30000 });

// ═══════════════════════════════════════════════════════════════
// AC2：全链路端到端零真 key（请求全部落在 mock-llm）
// ═══════════════════════════════════════════════════════════════

test('142-AC2: 全链路（runner→executor→llm-adapter→mock-llm）跑通且零真 key', async () => {
  const mock = await startMock();
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue142-e2e-'));
  mock.queue.push(toolUseReply('read_file', { path: 'a.txt' })); // 第 1 轮：工具调用（文件不存在 → is_error tool_result，无妨）
  mock.queue.push(textReply('final report: e2e done'));           // 第 2 轮：收工

  const settings = mockSettings(mock);
  setRunnerDepsForTesting(realChainDeps(settings, TMP));
  const runner = getSubagentRunner();
  const started = runner.start('ses_parent_142', { objective: 'probe e2e', readOnly: false });
  assert.equal(started.status, 'running');

  let st = runner.status(started.taskId);
  for (let i = 0; i < 100 && st.status === 'running'; i++) {
    await sleep(50);
    st = runner.status(started.taskId);
  }
  assert.equal(st.status, 'completed', `全链路跑通（status=${st.status}${st.error ? `, error=${st.error}` : ''}）`);
  assert.ok(st.result?.includes('e2e done'), '最终报告落 store');

  // 零真 key：所有 LLM 请求都打在 mock-llm（adapter baseUrl 只可能指向 mock）
  assert.ok(mock.requests.length >= 2, `请求全落 mock-llm（实测 ${mock.requests.length} 个）`);
  for (const r of mock.requests) {
    assert.equal(r.headers['x-api-key'], 'test-mock-key', '请求携带占位 key（非真 key）');
  }
}, { timeout: 30000 });

// ═══════════════════════════════════════════════════════════════
// AC3：3 层压缩各层端到端用例
// ═══════════════════════════════════════════════════════════════

test('142-AC3a: 微压缩端到端——7 次 execute_cli 后旧结果被替换、最近 5 个保留', async () => {
  const mock = await startMock();
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue142-micro-'));
  // 连续 7 轮 execute_cli（COMPACTABLE_TOOLS 之一），最后 1 轮文本收工
  for (let i = 0; i < 7; i++) mock.queue.push(toolUseReply('execute_cli', { command: `echo turn${i}` }));
  mock.queue.push(textReply('final report: micro done'));

  const settings = mockSettings(mock);
  setRunnerDepsForTesting(realChainDeps(settings, TMP));
  const runner = getSubagentRunner();
  const started = runner.start('ses_parent_142', { objective: 'probe micro compact' });
  let st = runner.status(started.taskId);
  for (let i = 0; i < 120 && st.status === 'running'; i++) { await sleep(50); st = runner.status(started.taskId); }
  assert.equal(st.status, 'completed');

  // 收工请求体（最后一条）出现微压缩占位文本，恰 2 个（7 - 最近 5 保留）
  const allBodies = mock.requests.map((r) => JSON.stringify(r.body));
  const placeholder = '[此工具结果已被微压缩清理]';
  const hit = allBodies.find((b) => (b.match(/此工具结果已被微压缩清理/g) ?? []).length === 2);
  assert.ok(hit, '某个 LLM 请求体包含恰 2 个微压缩占位文本');
  // 最近的结果原样保留（echo turn6 的 stdout 在请求体里）
  assert.ok(hit.includes('turn6'), '最近结果原样保留（未压缩）');
}, { timeout: 30000 });

test('142-AC3b: autocompact 端到端——超阈值触发摘要请求，摘要入 Compact Boundary 后继续', async () => {
  const mock = await startMock();
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue142-auto-'));
  fs.writeFileSync(path.join(TMP, 'big.txt'), 'x'.repeat(2000)); // 2KB 结果 → 撑爆 100 token 阈值
  // 第 1 轮工具调用撑大对话；此后按请求内容路由：摘要请求 → JSON 摘要；主聊天 → 文本收工
  mock.queue.push(toolUseReply('read_file', { path: 'big.txt' }));
  mock.defaultHandler = (req, res) => {
    const sys = JSON.stringify(req.body?.system ?? '');
    if (sys.includes('Summarize the conversation')) return jsonTextReply('summary: read one file')(req, res);
    return textReply('final report: auto done')(req, res);
  };

  const settings = mockSettings(mock, { compactThreshold: 100 }); // 低阈值强制触发
  setRunnerDepsForTesting(realChainDeps(settings, TMP));
  const runner = getSubagentRunner();
  const started = runner.start('ses_parent_142', { objective: 'probe autocompact' });
  let st = runner.status(started.taskId);
  for (let i = 0; i < 120 && st.status === 'running'; i++) { await sleep(50); st = runner.status(started.taskId); }
  assert.equal(st.status, 'completed', `autocompact 后继续到完成（${st.error ?? ''}）`);

  // 摘要请求发生过（system 为 summaryPrompt；system 是块数组——序列化后匹配）
  const summaryReq = mock.requests.find((r) => JSON.stringify(r.body?.system ?? '').includes('Summarize the conversation'));
  assert.ok(summaryReq, 'autocompact 发出摘要请求（LLM 摘要走 mock-llm）');
  // 摘要落地为 Compact Boundary：后续请求的第一条 user 消息以 [对话摘要] 开头
  const boundaryHit = mock.requests.some((r) => {
    const msgs = r.body?.messages ?? [];
    const first = msgs[0]?.content?.[0];
    return first?.type === 'text' && String(first.text).startsWith('[对话摘要]');
  });
  assert.ok(boundaryHit, 'Compact Boundary（[对话摘要]）进入后续请求');
}, { timeout: 30000 });

test('142-AC3c: 熔断器端到端——连续 3 次 compact 失败 → 子 fail-fast 报电路熔断', async () => {
  const mock = await startMock();
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue142-breaker-'));
  fs.writeFileSync(path.join(TMP, 'big.txt'), 'x'.repeat(2000));
  mock.queue.push(toolUseReply('read_file', { path: 'big.txt' }));
  // 摘要请求一律 500（server_overload → compact 失败）；主聊天也回工具调用维持循环
  mock.defaultHandler = (req, res) => {
    const sys = JSON.stringify(req.body?.system ?? '');
    if (sys.includes('Summarize the conversation')) return httpErrorReply(500)(req, res);
    return toolUseReply('read_file', { path: 'a.txt' })(req, res);
  };

  const settings = mockSettings(mock, { compactThreshold: 100 });
  setRunnerDepsForTesting(realChainDeps(settings, TMP));
  const runner = getSubagentRunner();
  const started = runner.start('ses_parent_142', { objective: 'probe breaker' });
  let st = runner.status(started.taskId);
  for (let i = 0; i < 120 && st.status === 'running'; i++) { await sleep(50); st = runner.status(started.taskId); }
  assert.equal(st.status, 'failed', '连续 compact 失败 → fail-fast');
  assert.ok(st.error?.includes('Compact circuit breaker: 3 consecutive failures'), `熔断文案准确（${st.error}）`);
  const summaryCount = mock.requests.filter((r) => JSON.stringify(r.body?.system ?? '').includes('Summarize the conversation')).length;
  assert.equal(summaryCount, 3, '恰 3 次摘要请求触发 MAX_COMPACT_FAILURES=3');
}, { timeout: 30000 });

// ═══════════════════════════════════════════════════════════════
// AC4：autocompact-issue48 回归（e2e 级挂死 → watchdog 中断降级）
// ═══════════════════════════════════════════════════════════════

test('142-AC4: 挂死 mock-llm 上 autoCompact → watchdog 中断抛 LlmError（issue48 机制 e2e 级）', async () => {
  const mock = await startMock();
  mock.queue.push(hangReply()); // 摘要请求永远挂起

  const adapter = mockAdapter(mock);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'long conversation to summarize' }] }];
  await assert.rejects(
    autoCompact(messages, adapter, 'claude-mock', () => {}, 500), // 短 idleTimeoutMs 注入（不拖 60s）
    LlmError,
    '挂死 → watchdog 中断 → autoCompact 抛 LlmError（调用方降级）',
  );
  assert.equal(mock.requests.length, 1, '摘要请求确实发出并落在 mock-llm');
}, { timeout: 30000 });
