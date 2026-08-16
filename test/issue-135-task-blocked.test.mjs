// ADR-0048 T4 (#135)：task_update 加 blocked 状态 + blockedReason（D12）+ fail-fast 提示词 + 报告帽
//
// 验收覆盖：
//   AC1  blocked + blockedReason 状态机全通（pending/in_progress→blocked 允许、blocked→completed 允许、
//        blocked→in_progress 回转拒绝；blocked 必填 blockedReason ≤1000 字符）
//   AC2  提示词含 fail-fast 纪律 + 最终报告 ≤2000 tokens + 三处零成本加固（*.md/README 禁令、
//        绝对路径正面指令、绝对路径规则补原因）
//   AC3  事故一场景：readOnly=true 派编码任务 → 子置 blocked + 写明哪个参数与任务不符 + 出最终报告；
//        父下一次轮询在 tasks 字段可见（runner.status()）
//
// seam：task_update 工具（tools.ts）call/schema、getSubagentSystemPrompt（executor.ts）、
//       runSubagent（executor.ts）+ SubagentRecord.tasks（store.ts）、runner.status()（runner.ts）
// 测试方式：bun:test + dist/ 导入；build 先行（#43 惯例）。scriptedAdapter/fakeDeps 手法同 m7/m8。

import { test, describe, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { getTool } from '../dist/subagent/tools.js';
import { clearAllSubagents, getSubagent } from '../dist/subagent/store.js';
import { getSubagentSystemPrompt, runSubagent } from '../dist/subagent/executor.js';
import { createSubagentRunner, setRunnerDepsForTesting, resetSubagentRunner, getSubagentRunner } from '../dist/subagent/runner.js';
import { randomBytes } from 'node:crypto';

afterEach(() => {
  clearAllSubagents();
  resetSubagentRunner();
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

/** 创建 N 轮脚本化 fake adapter（m7 手法）——每轮返回文本或 tool_use */
function scriptedAdapter(turns = []) {
  let turnIndex = 0;
  return {
    provider: 'test',
    callCount: 0,
    async *stream(params, signal) {
      this.callCount++;
      const turn = turns[turnIndex] ?? turns[turns.length - 1];
      turnIndex++;
      if (turn.text) yield { type: 'text_delta', text: turn.text };
      if (turn.toolCalls) {
        for (let i = 0; i < turn.toolCalls.length; i++) {
          const tc = turn.toolCalls[i];
          yield { type: 'tool_call_start', index: i, id: tc.id, name: tc.name };
          const json = JSON.stringify(tc.input);
          for (let j = 0; j < json.length; j += 5) {
            yield { type: 'tool_call_delta', index: i, jsonFragment: json.slice(j, j + 5) };
          }
          yield { type: 'tool_call_end', index: i, id: tc.id };
        }
      }
      yield { type: 'message_end', usage: turn.usage ?? { input_tokens: 10, output_tokens: 5 } };
    },
    async create(params, signal) {
      const turn = turns[Math.min(turnIndex, turns.length - 1)];
      return {
        message: { role: 'assistant', content: [{ type: 'text', text: turn?.text ?? '' }] },
        usage: turn?.usage ?? { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
}

describe('issue-135 T4 状态机（blocked + blockedReason）', () => {
  test('schema：status enum 含 blocked；blockedReason 属性 maxLength=1000；描述含 blocked 句', () => {
    const schema = getTool('task_update').inputSchema;
    assert.ok(schema.properties.status.enum.includes('blocked'), 'enum 应含 blocked');
    assert.ok(schema.properties.blockedReason, '应声明 blockedReason 属性');
    assert.equal(schema.properties.blockedReason.maxLength, 1000, 'blockedReason maxLength 应为 1000');
    assert.equal(schema.properties.blockedReason.type, 'string');
    assert.match(getTool('task_update').description, /blocked/, '描述应含 blocked 句');
  });

  test('pending → blocked（带原因）允许，blockedReason 落 store（父侧可见）', async () => {
    const agentId = 'sa-135-p2b';
    const created = await getTool('task_create').call({ subject: '编码任务', description: '改 parser' }, makeCtx(agentId));
    const r = await getTool('task_update').call({ taskId: created.task.id, status: 'blocked', blockedReason: '任务需写文件但 readOnly=true' }, makeCtx(agentId));
    assert.ok(!r.is_error, `不应报错：${r.message ?? ''}`);

    const record = getSubagent(agentId);
    const found = record.tasks.find((t) => t.id === created.task.id);
    assert.equal(found.status, 'blocked');
    assert.equal(found.blockedReason, '任务需写文件但 readOnly=true');
  });

  test('in_progress → blocked（带原因）允许', async () => {
    const agentId = 'sa-135-i2b';
    const created = await getTool('task_create').call({ subject: 'T', description: 'd' }, makeCtx(agentId));
    const t = getTool('task_update');
    await t.call({ taskId: created.task.id, status: 'in_progress' }, makeCtx(agentId));
    const r = await t.call({ taskId: created.task.id, status: 'blocked', blockedReason: '所需工具不在工具集' }, makeCtx(agentId));
    assert.ok(!r.is_error);
    const found = getSubagent(agentId).tasks.find((x) => x.id === created.task.id);
    assert.equal(found.status, 'blocked');
    assert.equal(found.blockedReason, '所需工具不在工具集');
  });

  test('blocked → in_progress 回转禁止（blocked 近终态）', async () => {
    const agentId = 'sa-135-b2i';
    const created = await getTool('task_create').call({ subject: 'T', description: 'd' }, makeCtx(agentId));
    const t = getTool('task_update');
    await t.call({ taskId: created.task.id, status: 'blocked', blockedReason: '卡住' }, makeCtx(agentId));
    const r = await t.call({ taskId: created.task.id, status: 'in_progress' }, makeCtx(agentId));
    assert.equal(r.is_error, true);
    assert.ok(r.message.includes('Invalid transition'));
  });

  test('blocked → completed 允许（blocked 可正常收尾）', async () => {
    const agentId = 'sa-135-b2c';
    const created = await getTool('task_create').call({ subject: 'T', description: 'd' }, makeCtx(agentId));
    const t = getTool('task_update');
    await t.call({ taskId: created.task.id, status: 'blocked', blockedReason: '临时卡住' }, makeCtx(agentId));
    const r = await t.call({ taskId: created.task.id, status: 'completed' }, makeCtx(agentId));
    assert.ok(!r.is_error);
    assert.equal(r.allDone, true);
  });

  test('blocked 必填 blockedReason——缺失报错（写明哪个参数与任务不符）', async () => {
    const agentId = 'sa-135-noreason';
    const created = await getTool('task_create').call({ subject: 'T', description: 'd' }, makeCtx(agentId));
    const r = await getTool('task_update').call({ taskId: created.task.id, status: 'blocked' }, makeCtx(agentId));
    assert.equal(r.is_error, true);
    assert.ok(r.message.includes('blockedReason is required'));
  });

  test('blockedReason 空白字符串同样被拒', async () => {
    const agentId = 'sa-135-blank';
    const created = await getTool('task_create').call({ subject: 'T', description: 'd' }, makeCtx(agentId));
    const r = await getTool('task_update').call({ taskId: created.task.id, status: 'blocked', blockedReason: '   ' }, makeCtx(agentId));
    assert.equal(r.is_error, true);
    assert.ok(r.message.includes('blockedReason is required'));
  });

  test('blockedReason 超 1000 字符报错', async () => {
    const agentId = 'sa-135-long';
    const created = await getTool('task_create').call({ subject: 'T', description: 'd' }, makeCtx(agentId));
    const long = 'x'.repeat(1001);
    const r = await getTool('task_update').call({ taskId: created.task.id, status: 'blocked', blockedReason: long }, makeCtx(agentId));
    assert.equal(r.is_error, true);
    assert.ok(r.message.includes('1000'));
  });

  test('blockedReason 恰 1000 字符通过', async () => {
    const agentId = 'sa-135-exact';
    const created = await getTool('task_create').call({ subject: 'T', description: 'd' }, makeCtx(agentId));
    const exact = 'y'.repeat(1000);
    const r = await getTool('task_update').call({ taskId: created.task.id, status: 'blocked', blockedReason: exact }, makeCtx(agentId));
    assert.ok(!r.is_error);
    const found = getSubagent(agentId).tasks.find((x) => x.id === created.task.id);
    assert.equal(found.blockedReason.length, 1000);
  });

  test('回归：pending → completed 仍禁止（既有迁移不受损）', async () => {
    const agentId = 'sa-135-p2c';
    const created = await getTool('task_create').call({ subject: 'T', description: 'd' }, makeCtx(agentId));
    const r = await getTool('task_update').call({ taskId: created.task.id, status: 'completed' }, makeCtx(agentId));
    assert.equal(r.is_error, true);
    assert.ok(r.message.includes('Invalid transition'));
  });

  test('回归：completed 终态不可变（completed → blocked 拒绝）', async () => {
    const agentId = 'sa-135-c2b';
    const created = await getTool('task_create').call({ subject: 'T', description: 'd' }, makeCtx(agentId));
    const t = getTool('task_update');
    await t.call({ taskId: created.task.id, status: 'in_progress' }, makeCtx(agentId));
    await t.call({ taskId: created.task.id, status: 'completed' }, makeCtx(agentId));
    const r = await t.call({ taskId: created.task.id, status: 'blocked', blockedReason: '迟到原因' }, makeCtx(agentId));
    assert.equal(r.is_error, true);
  });

  test('allDone 语义：一 completed 一 blocked → 列表不误清空（父轮询仍可见 blocked 原因）', async () => {
    const agentId = 'sa-135-alldone';
    const t = getTool('task_update');
    const a = await getTool('task_create').call({ subject: 'A', description: 'done' }, makeCtx(agentId));
    const b = await getTool('task_create').call({ subject: 'B', description: 'stuck' }, makeCtx(agentId));
    await t.call({ taskId: a.task.id, status: 'completed' }, makeCtx(agentId));
    const r = await t.call({ taskId: b.task.id, status: 'blocked', blockedReason: '参数矛盾' }, makeCtx(agentId));

    assert.ok(!r.is_error);
    const record = getSubagent(agentId);
    assert.equal(record.tasks.length, 2, '含 blocked 时不得触发 allDone 清空');
    const blockedTask = record.tasks.find((x) => x.id === b.task.id);
    assert.equal(blockedTask.status, 'blocked');
    assert.equal(blockedTask.blockedReason, '参数矛盾');
  });
});

describe('issue-135 T4 提示词（fail-fast + 报告帽 + 三处加固）', () => {
  const TASK = 'Refactor the auth module';
  const TOOLS = ['read_file', 'write_file', 'edit_file', 'execute_cli', 'glob', 'grep', 'task_create', 'task_update'];
  const CWD = '/workspace/proj';
  function build() {
    return getSubagentSystemPrompt(TASK, TOOLS, CWD);
  }

  test('fail-fast 纪律：置 blocked + blockedReason + 立即出最终报告 + 停止轮转', () => {
    const p = build();
    assert.match(p, /fail fast/i, '应含 fail-fast 纪律');
    assert.match(p, /blockedReason stating which parameter mismatches/, '应写明哪个参数与任务不符');
    assert.match(p, /final report/i, '应要求立即出最终报告');
    assert.match(p, /stop rotating through other tasks/, 'blocked 后停止轮转其余任务');
    assert.match(p, /do not spin, do not burn turns/, '不空转、不烧轮次');
  });

  test('报告帽：最终报告 ≤2000 tokens，细节写文件（A 路线）', () => {
    const p = build();
    assert.match(p, /2000 tokens/, '应含 2000 tokens 报告帽');
    assert.match(p, /write them to\s+a file/i, '细节应写文件');
  });

  test('加固①：*.md/README 创建禁令', () => {
    const p = build();
    assert.match(p, /Never proactively create documentation files/, '应禁止主动创建文档文件');
    assert.match(p, /\.md|README/, '应点名 md/README');
  });

  test('加固②：最终回复正面指令——分享绝对路径，片段仅在必要', () => {
    const p = build();
    assert.match(p, /absolute file paths for everything/, '应要求分享绝对路径');
    assert.match(p, /snippets only when load-bearing|only when load-bearing/, '片段仅在承载信息时');
  });

  test('加固③：绝对路径规则补原因（cwd 每次调用会重置）', () => {
    const p = build();
    assert.match(p, /Use absolute paths for all file operations/, '现句保留');
    assert.match(p, /cwd resets on every call/, '应补原因：cwd 每次调用重置');
  });

  test('既有提示词段落不回归（# Reporting 存在、无孤立 # Rules 标题）', () => {
    const p = build();
    assert.match(p, /# Reporting/);
    assert.match(p, /no emojis/);
    assert.doesNotMatch(p, /# Rules/);
  });
});

// ── 事故一全链路（AC3）──

/** 从对话历史解析 task_create 的 tool_result 中的真实 task.id（tool-executor JSON.stringify 格式） */
function extractCreatedTaskId(messages) {
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      const text = typeof block.content === 'string' ? block.content : block.content?.text;
      if (!text) continue;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.task?.id) return parsed.task.id;
      } catch { /* 非 JSON 结果跳过 */ }
    }
  }
  return undefined;
}

/** 事故一专用 adapter：turn1 task_create → turn2 task_update(blocked+原因) → turn3 最终报告 */
function accidentAdapter() {
  let turn = 0;
  return {
    provider: 'test',
    async *stream(params) {
      turn++;
      const emitTool = function* (id, name, input) {
        yield { type: 'tool_call_start', index: 0, id, name };
        const json = JSON.stringify(input);
        for (let j = 0; j < json.length; j += 5) {
          yield { type: 'tool_call_delta', index: 0, jsonFragment: json.slice(j, j + 5) };
        }
        yield { type: 'tool_call_end', index: 0, id };
      };
      if (turn === 1) {
        yield* emitTool('tc1', 'task_create', { subject: '编码任务', description: '实现 parser 重构' });
      } else if (turn === 2) {
        const taskId = extractCreatedTaskId(params.messages);
        assert.ok(taskId, 'turn2 应能从上一轮 tool_result 解析 task.id');
        yield* emitTool('tc2', 'task_update', {
          taskId,
          status: 'blocked',
          blockedReason: '任务需写文件但 readOnly=true：readOnly 参数与编码任务不符',
        });
      } else {
        yield { type: 'text_delta', text: '无法继续：readOnly=true 与编码任务矛盾。已置 blocked（任务需写文件但 readOnly=true），请以非 readOnly 重派。' };
      }
      yield { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } };
    },
    async create(params) {
      return { message: { role: 'assistant', content: [{ type: 'text', text: 'blocked final report' }] }, usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
}

describe('issue-135 T4 事故一场景（AC3）', () => {
  test('readOnly=true 派编码任务 → 子置 blocked + 原因 + 最终报告；store.tasks 可见', async () => {
    clearAllSubagents();
    const agentId = 'sa-135-accident1';
    const adapter = accidentAdapter();
    const result = await runSubagent({
      agentId,
      task: '实现 parser 重构（需要写文件）',
      cwd: '/tmp',
      settings: defaultSettings(),
      readOnly: true,          // 主理人验收场景：readOnly 错配
      adapter,
    });

    // 子正常收尾（finalize 仍走 completed），但 tasks 里带 blocked + 原因
    assert.equal(result.status, 'completed');
    assert.ok(result.result.includes('blocked'), '最终报告应指明 blocked 与哪个参数不符');

    const record = getSubagent(agentId);
    assert.ok(record, 'store record 应存在');
    const task = record.tasks.find((t) => t.status === 'blocked');
    assert.ok(task, '父侧 tasks 应含 blocked 任务');
    assert.ok(task.blockedReason.includes('readOnly'), 'blockedReason 应写明哪个参数与任务不符');
    assert.match(task.blockedReason, /readOnly=true/);
  });

  test('runner.status() 父轮询可见：tasks 字段含 blocked + blockedReason', async () => {
    clearAllSubagents();
    // fakeDeps（m8 手法）：runSubagentImpl 模拟子 agent 用真实工具置 blocked 后收尾
    const fake = {
      runSubagentImpl: async ({ agentId, cwd }) => {
        const ctx = { cwd, signal: new AbortController().signal, agentId, readOnly: true };
        const created = await getTool('task_create').call({ subject: '编码任务', description: '写 parser' }, ctx);
        const r = await getTool('task_update').call({
          taskId: created.task.id,
          status: 'blocked',
          blockedReason: '任务需写文件但 readOnly=true：参数与任务不符',
        }, ctx);
        if (r.is_error) throw new Error(r.message);
        return { status: 'completed', result: '无法完成：任务需写文件但 readOnly=true，已 blocked。' };
      },
      settings: defaultSettings(),
      workspaceDir: '/tmp',
      notify: async () => {},
      checkpoint: async () => {},
      registerAndClaimChild: (parentId, args) => ({
        session: { id: 'ses_child_accident', name: 'child', phase: 'working', task: args.task },
        identity: { sessionId: 'ses_child_accident', sessionToken: 'tok' },
      }),
    };
    setRunnerDepsForTesting(fake);
    const runner = getSubagentRunner();
    const { taskId } = runner.start('ses_parent_accident', {
      objective: '实现 parser 重构（需要写文件）',
      background: 'test',
      readOnly: true,
    });

    // 有界轮询（issue-120 手法）：等 runSubagentImpl + finalize 落盘
    const deadline = Date.now() + 2000;
    let record = getSubagent(taskId);
    while ((!record || record.status === 'running') && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 10));
      record = getSubagent(taskId);
    }
    assert.ok(record && record.status !== 'running', '子应在有界时间内收尾');

    // 父下一次轮询（subagent_status → runner.status）tasks 字段可见 blocked + 原因
    const status = runner.status(taskId);
    assert.ok(Array.isArray(status.tasks));
    const task = status.tasks.find((t) => t.status === 'blocked');
    assert.ok(task, '父轮询 tasks 应含 blocked 任务');
    assert.equal(task.blockedReason, '任务需写文件但 readOnly=true：参数与任务不符');
    assert.equal(task.subject, '编码任务');
  });
});
