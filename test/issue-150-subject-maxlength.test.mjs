// ADR-0048 T8 O1（#150）：task_create subject maxLength 120 运行时强制（D9 #139 死声明补执法）
// 方案：handler 层强制（T4 blockedReason 先例，D12 #135 同款）；validateSchema 保持 4 类校验不动。
//
// 验收覆盖：
//   AC1  subject 超 120 字符被运行时拦截（schema 声明锁定 + 121 拒/恰 120 过 + 拒后不落 store + 全链透出）
//
// seam：task_create 工具（tools.ts）call；测试方式：bun:test + dist/ 导入；build 先行（#43 惯例）。

import { test, describe, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { getTool } from '../dist/subagent/tools.js';
import { clearAllSubagents, getSubagent } from '../dist/subagent/store.js';
import { runSubagent } from '../dist/subagent/executor.js';

afterEach(() => {
  clearAllSubagents();
});

function makeCtx(agentId) {
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    agentId,
    readOnly: false,
  };
}

function defaultSettings(overrides = {}) {
  return {
    enabled: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    apiKey: 'sk-test',
    baseUrl: 'http://localhost:9999',
    maxTurns: 10,
    timeoutSec: 60,
    maxParallel: 2,
    ...overrides,
  };
}

/** 从对话历史收集 tool_result 文本（tool-executor JSON.stringify 格式） */
function extractToolResults(messages) {
  const out = [];
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      const text = typeof block.content === 'string' ? block.content : block.content?.text;
      if (text) out.push(text);
    }
  }
  return out;
}

describe('issue-150 subject maxLength 120 运行时强制', () => {
  test('schema：subject 声明 maxLength=120（T8 增厚声明仍在）', () => {
    const schema = getTool('task_create').inputSchema;
    assert.equal(schema.properties.subject.type, 'string');
    assert.equal(schema.properties.subject.maxLength, 120, 'subject maxLength 应为 120');
    assert.match(getTool('task_create').description, /max 120/, '描述应含 max 120 句');
  });

  test('121 字符 → is_error 拦截，不落 store', async () => {
    const agentId = 'sa-150-reject';
    const r = await getTool('task_create').call(
      { subject: 'x'.repeat(121), description: 'd' },
      makeCtx(agentId),
    );
    assert.equal(r.is_error, true, '超长 subject 应被运行时拦截');
    assert.ok(r.message.includes('120'), `报错应含 120：${r.message}`);
    const record = getSubagent(agentId);
    const tasks = record?.tasks ?? [];
    assert.equal(tasks.length, 0, '被拒的 task 不得落入 store');
  });

  test('恰 120 字符 → 通过，全量落 store', async () => {
    const agentId = 'sa-150-exact';
    const subject = 'y'.repeat(120);
    const r = await getTool('task_create').call({ subject, description: 'd' }, makeCtx(agentId));
    assert.ok(!r.is_error, `恰 120 不应报错：${r.message ?? ''}`);
    const record = getSubagent(agentId);
    const found = record.tasks.find((t) => t.id === r.task.id);
    assert.ok(found, 'task 应落 store');
    assert.equal(found.subject.length, 120, 'subject 应全量保留');
  });

  test('全链透出：runSubagent 脚本链中 121 字符 task_create → 子收到 error tool_result，store 无 task', async () => {
    clearAllSubagents();
    const agentId = 'sa-150-chain';
    let sawErrorResult = false;

    let turn = 0;
    const adapter = {
      provider: 'test',
      async *stream(params) {
        turn++;
        if (turn === 1) {
          // turn1：发超长 subject 的 task_create
          const json = JSON.stringify({ subject: 'x'.repeat(121), description: 'd' });
          yield { type: 'tool_call_start', index: 0, id: 'tc1', name: 'task_create' };
          for (let j = 0; j < json.length; j += 5) {
            yield { type: 'tool_call_delta', index: 0, jsonFragment: json.slice(j, j + 5) };
          }
          yield { type: 'tool_call_end', index: 0, id: 'tc1' };
          yield { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } };
          return;
        }

        // turn2+：校验上一轮 tool_result 是否透出拦截错误（LLM 视角锁定），然后文本收尾
        for (const text of extractToolResults(params.messages)) {
          try {
            const parsed = JSON.parse(text);
            if (parsed?.is_error === true && parsed?.message?.includes('120')) sawErrorResult = true;
          } catch { /* 非 JSON 结果跳过 */ }
        }
        yield { type: 'text_delta', text: 'subject 超长被拦，已收尾。' };
        yield { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } };
      },
      async create() {
        return { message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] }, usage: { input_tokens: 10, output_tokens: 5 } };
      },
    };

    const result = await runSubagent({
      agentId,
      task: '建一个任务',
      cwd: '/tmp',
      settings: defaultSettings(),
      readOnly: false,
      adapter,
    });

    assert.equal(result.status, 'completed');
    assert.equal(sawErrorResult, true, '子应看到 is_error 拦截结果');
    const record = getSubagent(agentId);
    const tasks = record?.tasks ?? [];
    assert.equal(tasks.length, 1, '仅存主任务种子，超长 subject 的 task 不得落入 store');
    assert.ok(!tasks.some((t) => t.subject.length > 120), 'store 中不得有超长 subject 的 task');
  });
});
