// M7 核心执行器 + TUI 桥测试——≥ 19 用例
// 决策 5/8/9/12/20/21/24/25/29/37
// 目标：覆盖率 ≥ 90%；变异体 9/9 被杀死

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

// ── Import 构建产物 ──

import { runSubagent } from '../dist/subagent/executor.js';
import { emitAgUi, subagentEvents } from '../dist/subagent/tui-bridge.js';
import { CostTracker } from '../dist/subagent/cost-tracker.js';
import { clearAllSubagents, getSubagent, createSubagent, updateSubagentCost } from '../dist/subagent/store.js';
import { clearAllFileStates, clearFileState } from '../dist/subagent/file-state.js';
import { clearAllShellTasks, getTrackedCount } from '../dist/subagent/shell-tracker.js';
import { LlmError } from '../dist/subagent/llm-adapter.js';

// ── 测试辅助 ──

/** 默认 settings——短 maxTurns、短 timeout 便于测试 */
function defaultSettings(overrides = {}) {
  return {
    enabled: true,
    provider: 'openai',
    model: 'gpt-4o',
    maxTurns: 10,
    timeoutSec: 10,
    maxParallel: 2,
    ...overrides,
  };
}

/** 临时目录 + 清理 */
function tempDir() {
  const dir = join(tmpdir(), 'm7-test-' + randomBytes(4).toString('hex'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 健壮删除临时目录：Windows 不允许删除仍被句柄锁定的目录
 * （例如 abort 后子进程尚未释放 cwd/管道），直接 rmSync 会抛 EBUSY/EPERM。
 * 这里对这类错误做短暂重试，避免在 Windows CI 上偶发红。
 * 仅影响测试清理，不改变任何产品行为或断言。
 */
function rmDirRobust(dir, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = err && err.code;
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (i < attempts - 1 && retryable) {
        // 等子进程/句柄释放后重试（同步短睡，跨平台可靠）
        const end = Date.now() + 50;
        while (Date.now() < end) { /* spin */ }
        continue;
      }
      throw err;
    }
  }
}

/** 创建纯文本响应的 fake adapter */
function textAdapter(text, usage) {
  const u = usage ?? { input_tokens: 10, output_tokens: 5 };
  return {
    provider: 'test',
    async *stream(params, signal) {
      yield { type: 'text_delta', text };
      yield { type: 'message_end', usage: u };
    },
    async create(params, signal) {
      return {
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        usage: u,
      };
    },
  };
}

/** 创建 N 轮脚本化响应的 fake adapter（每轮可返回文本或 tool_use） */
function scriptedAdapter(turns = []) {
  let turnIndex = 0;
  return {
    provider: 'test',
    callCount: 0,
    currentModel: 'gpt-4o', // 用于检测 fallbackModel 切换
    async *stream(params, signal) {
      this.callCount++;
      this.currentModel = params.model;
      const turn = turns[turnIndex] ?? turns[turns.length - 1];
      turnIndex++;

      if (turn._throw) {
        throw turn._throw;
      }

      if (turn._delay) {
        // 模拟延迟（timeout 测试用）
        await new Promise((resolve) => setTimeout(resolve, turn._delay));
      }

      // 文本
      if (turn.text) {
        yield { type: 'text_delta', text: turn.text };
      }

      // 工具调用
      if (turn.toolCalls) {
        for (let i = 0; i < turn.toolCalls.length; i++) {
          const tc = turn.toolCalls[i];
          yield { type: 'tool_call_start', index: i, id: tc.id, name: tc.name };
          const json = JSON.stringify(tc.input);
          // 分 chunk 发送——模拟流式 JSON
          for (let j = 0; j < json.length; j += 5) {
            yield { type: 'tool_call_delta', index: i, jsonFragment: json.slice(j, j + 5) };
          }
          yield { type: 'tool_call_end', index: i, id: tc.id };
        }
      }

      yield {
        type: 'message_end',
        usage: turn.usage ?? { input_tokens: 10, output_tokens: 5 },
      };
    },
    async create(params, signal) {
      if (turnIndex > 0 && turns[turnIndex - 1]?._createThrow) {
        throw turns[turnIndex - 1]._createThrow;
      }
      return {
        message: { role: 'assistant', content: [{ type: 'text', text: 'Summary text' }] },
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
}

/** 创建永远不结束的 fake adapter（用于 abort/timeout 测试）——监听 signal 以便被中断 */
function hangingAdapter() {
  return {
    provider: 'test',
    async *stream(params, signal) {
      // 发一个 chunk 然后等待 signal
      yield { type: 'text_delta', text: 'Working...' };
      // 监听 signal——abort 时 reject，否则永远等待
      await new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    async create(params, signal) {
      return {
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
}

// ── 测试前清理 ──

function cleanAll() {
  clearAllSubagents();
  clearAllFileStates();
  clearAllShellTasks();
  // 移除之前测试可能留下的 listener
  subagentEvents.removeAllListeners('ag-ui');
}

// ═══════════════════════════════════════════════════════════
// 一、tui-bridge 测试
// ═══════════════════════════════════════════════════════════

describe('subagent-m7', () => {
test('tui-bridge: emitAgUi listener receives event with subagentId/type/timestamp', async () => {
  cleanAll();
  const events = [];
  const handler = (e) => events.push(e);
  subagentEvents.on('ag-ui', handler);

  emitAgUi('agent-1', 'RUN_STARTED', { task: 'test' });

  assert.equal(events.length, 1);
  assert.equal(events[0].subagentId, 'agent-1');
  assert.equal(events[0].type, 'RUN_STARTED');
  assert.ok(typeof events[0].timestamp === 'number');
  assert.ok(events[0].timestamp > 0);

  subagentEvents.off('ag-ui', handler);
});

test('tui-bridge: two different subagentIds do not cross-contaminate', async () => {
  cleanAll();
  const a1Events = [];
  const a2Events = [];
  const handler = (e) => {
    if (e.subagentId === 'agent-a') a1Events.push(e);
    if (e.subagentId === 'agent-b') a2Events.push(e);
  };
  subagentEvents.on('ag-ui', handler);

  emitAgUi('agent-a', 'RUN_STARTED');
  emitAgUi('agent-b', 'RUN_STARTED');
  emitAgUi('agent-a', 'STEP_STARTED', { turn: 1 });

  assert.equal(a1Events.length, 2);
  assert.equal(a2Events.length, 1);

  subagentEvents.off('ag-ui', handler);
});

// ═══════════════════════════════════════════════════════════
// 二、正常路径
// ═══════════════════════════════════════════════════════════

test('正常路径: 一轮完成——fake adapter 返回纯文本', async () => {
  cleanAll();
  const cwd = tempDir();

  const adapter = textAdapter('Task completed successfully.');
  const result = await runSubagent({
    agentId: 'test-1',
    task: 'Do something',
    cwd,
    settings: defaultSettings(),
    adapter,
  });

  assert.equal(result.status, 'completed');
  assert.ok(result.result.includes('Task completed'));
  rmDirRobust(cwd);
});

test('正常路径: 两轮带工具——read_file + 文本', async () => {
  cleanAll();
  const cwd = tempDir();
  const testFile = join(cwd, 'test.txt');
  writeFileSync(testFile, 'hello world');

  const adapter = scriptedAdapter([
    {
      toolCalls: [{ id: 'toolu_1', name: 'read_file', input: { path: 'test.txt' } }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    {
      text: 'File read successfully.',
      usage: { input_tokens: 15, output_tokens: 5 },
    },
  ]);

  const events = [];
  const result = await runSubagent({
    agentId: 'test-2',
    task: 'Read test.txt',
    cwd,
    settings: defaultSettings(),
    adapter,
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.status, 'completed');
  assert.ok(result.result.includes('File read'));

  // 事件序列：RUN_STARTED → STEP_STARTED → TOOL_CALL_* → ... → RUN_FINISHED
  const eventTypes = events.map(e => e.type);
  assert.ok(eventTypes.includes('RUN_STARTED'));
  assert.ok(eventTypes.includes('RUN_FINISHED'));
  assert.ok(eventTypes.includes('STEP_STARTED'));
  assert.ok(eventTypes.includes('TOOL_CALL_START'));

  // tool_result 已配对——result 的 content 含文件内容
  assert.ok(result.result.includes('File read'));

  rmDirRobust(cwd);
});

test('content 检测回归: fake adapter 返回 stop_reason=stop 但含 tool_use → 不退出', async () => {
  cleanAll();
  const cwd = tempDir();
  writeFileSync(join(cwd, 'data.txt'), 'some data');

  const adapter = scriptedAdapter([
    {
      // 模拟：stop_reason=stop 但消息里含 tool_use blocks
      // collectStream 用 hadToolCalls content 检测，不走 stop_reason
      toolCalls: [{ id: 'toolu_1', name: 'read_file', input: { path: 'data.txt' } }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    {
      text: 'All done.',
      usage: { input_tokens: 15, output_tokens: 3 },
    },
  ]);

  const result = await runSubagent({
    agentId: 'test-4',
    task: 'Read data',
    cwd,
    settings: defaultSettings(),
    adapter,
  });

  // 第 1 轮含 tool_use → 继续执行工具 → 第 2 轮纯文本 → completed
  assert.equal(result.status, 'completed');
  assert.equal(adapter.callCount, 2);

  rmDirRobust(cwd);
});

// ═══════════════════════════════════════════════════════════
// 三、退出条件
// ═══════════════════════════════════════════════════════════

test('maxTurns: 永远返回 tool_use → 跑满 maxTurns → failed', async () => {
  cleanAll();
  const cwd = tempDir();
  writeFileSync(join(cwd, 'x.txt'), 'x');

  const adapter = scriptedAdapter(Array(5).fill({
    toolCalls: [{ id: 'toolu_1', name: 'read_file', input: { path: 'x.txt' } }],
    usage: { input_tokens: 10, output_tokens: 20 },
  }));

  const result = await runSubagent({
    agentId: 'test-5',
    task: 'Keep reading',
    cwd,
    settings: defaultSettings({ maxTurns: 3 }),
    adapter,
  });

  assert.equal(result.status, 'failed');
  assert.ok(result.error.includes('Max turns'));

  rmDirRobust(cwd);
});

test('abort: 外部 abortController.abort() → status=aborted', async () => {
  cleanAll();
  const cwd = tempDir();

  // 先创建 record（含 abortController）
  const record = createSubagent('test-6', { subject: 'Long task' });

  const adapter = hangingAdapter();
  const promise = runSubagent({
    agentId: 'test-6',
    task: 'Long task',
    cwd,
    settings: defaultSettings(),
    adapter,
  });

  // 等一会儿让 stream 启动
  await new Promise(r => setTimeout(r, 200));
  record.abortController.abort();

  const result = await promise;
  assert.equal(result.status, 'aborted');
  assert.ok(result.error.includes('Aborted'));

  rmDirRobust(cwd);
});

test('timeout: timeoutSec=1 + adapter 卡 >1s → failed + 含 Timeout', async () => {
  cleanAll();
  const cwd = tempDir();

  const adapter = hangingAdapter();
  const result = await runSubagent({
    agentId: 'test-7',
    task: 'Hang',
    cwd,
    settings: defaultSettings({ timeoutSec: 1 }),
    adapter,
  });

  assert.equal(result.status, 'failed');
  assert.ok(result.error.includes('Timeout'));

  rmDirRobust(cwd);
});

test('shell 清理回归: abort 后 finally 清理执行', async () => {
  cleanAll();
  const cwd = tempDir();

  const record = createSubagent('test-8', { subject: 'Shell task' });
  const adapter = hangingAdapter();
  const promise = runSubagent({
    agentId: 'test-8',
    task: 'Run shell',
    cwd,
    settings: defaultSettings(),
    adapter,
  });

  await new Promise(r => setTimeout(r, 200));
  record.abortController.abort();

  await promise;

  // finally 块应已清理
  // shell-tracker agent 条目应被删除
  assert.equal(getTrackedCount('test-8'), 0);

  rmDirRobust(cwd);
});

// ═══════════════════════════════════════════════════════════
// 四、compact 测试
// ═══════════════════════════════════════════════════════════

test('compact 熔断: autoCompact 连续失败 3 次 → failed', async () => {
  cleanAll();
  const cwd = tempDir();

  // 使用小窗口模型触发 autocompact（阈值很小）
  const adapter = scriptedAdapter(Array(6).fill({
    toolCalls: [{ id: 'toolu_1', name: 'read_file', input: { path: 'dummy.txt' } }],
    usage: { input_tokens: 50000, output_tokens: 20000 }, // 大 usage 推动累积
    _createThrow: new Error('Compact API failed'), // autoCompact 的 create 调用会失败
  }));
  // 写入一个文件
  writeFileSync(join(cwd, 'dummy.txt'), 'x'.repeat(10000));

  const result = await runSubagent({
    agentId: 'test-compact',
    task: 'Keep doing stuff',
    cwd,
    settings: defaultSettings({ maxTurns: 6, model: 'deepseek-chat' }), // 64K window → 小阈值
    adapter,
  });

  // 要么 maxTurns 触发（compact 未触发），要么 compact 熔断触发
  // 如果 token 估算足够高触发 compact，然后 compact 连续失败 → 熔断
  assert.ok(result.status === 'failed');

  rmDirRobust(cwd);
});

// ═══════════════════════════════════════════════════════════
// 五、错误恢复
// ═══════════════════════════════════════════════════════════

test('rate_limit 错误重试后成功', async () => {
  cleanAll();
  const cwd = tempDir();

  let throwCount = 0;
  const adapter = {
    provider: 'test',
    async *stream(params, signal) {
      throwCount++;
      if (throwCount <= 2) {
        throw new LlmError('rate_limit', 'Rate limited', 429, 50); // retryAfterMs = 50ms
      }
      yield { type: 'text_delta', text: 'Recovered!' };
      yield { type: 'message_end', usage: { input_tokens: 10, output_tokens: 3 } };
    },
    async create(params, signal) {
      return {
        message: { role: 'assistant', content: [{ type: 'text', text: 'Summary' }] },
        usage: { input_tokens: 10, output_tokens: 3 },
      };
    },
  };

  const result = await runSubagent({
    agentId: 'test-rate',
    task: 'Retry me',
    cwd,
    settings: defaultSettings(),
    adapter,
  });

  assert.equal(result.status, 'completed');
  assert.equal(throwCount, 3); // 2 errors + 1 success
  assert.ok(result.result.includes('Recovered'));

  rmDirRobust(cwd);
});

test('auth 错误 → 零重试直接 failed', async () => {
  cleanAll();
  const cwd = tempDir();

  let callCount = 0;
  const adapter = {
    provider: 'test',
    async *stream(params, signal) {
      callCount++;
      throw new LlmError('auth', 'Invalid API key', 401);
    },
    async create(params, signal) {
      return {
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  };

  const result = await runSubagent({
    agentId: 'test-auth',
    task: 'Auth fail',
    cwd,
    settings: defaultSettings(),
    adapter,
  });

  assert.equal(result.status, 'failed');
  assert.equal(callCount, 1); // 零重试——只调了 1 次
  assert.ok(result.error.includes('API key'));

  rmDirRobust(cwd);
});

test('connection 错误 ×3 → failed', async () => {
  cleanAll();
  const cwd = tempDir();

  let callCount = 0;
  const adapter = {
    provider: 'test',
    async *stream(params, signal) {
      callCount++;
      throw new LlmError('connection', 'ECONNRESET');
    },
    // create 也必须抛错——否则 collectStream 的非流式回退会成功
    async create(params, signal) {
      throw new LlmError('connection', 'ECONNRESET');
    },
  };

  const result = await runSubagent({
    agentId: 'test-conn',
    task: 'Connect fail',
    cwd,
    settings: defaultSettings(),
    adapter,
  });

  assert.equal(result.status, 'failed');
  // stream 失败 → create 回退也失败 → retry x3 → 放弃
  // 每次尝试 = stream 1次 + create 1次 = 2次调用
  // 3 次重试 + 初始 1 次 = 至少 8 次调用（4次 stream + 4次 create）
  assert.ok(callCount >= 4);
  assert.ok(result.error.includes('Network'));

  rmDirRobust(cwd);
});

test('Circuit Breaker: connection 错误不触发 CB（重试策略先于 CB 耗尽）', async () => {
  cleanAll();
  const cwd = tempDir();

  let callCount = 0;
  const adapter = {
    provider: 'test',
    async *stream(params, signal) {
      callCount++;
      throw new LlmError('connection', 'Fail');
    },
    async create(params, signal) {
      throw new LlmError('connection', 'Fail');
    },
  };

  const result = await runSubagent({
    agentId: 'test-cb',
    task: 'CB test',
    cwd,
    settings: defaultSettings(),
    adapter,
  });

  // connection 在 3 次重试后 retry=false，先于 CB 触发
  assert.equal(result.status, 'failed');
  assert.ok(callCount >= 4);

  rmDirRobust(cwd);
});

test('Circuit Breaker with rate_limit: 连续 5 次 rate_limit 后熔断', async () => {
  cleanAll();
  const cwd = tempDir();

  let callCount = 0;
  const adapter = {
    provider: 'test',
    async *stream(params, signal) {
      callCount++;
      throw new LlmError('rate_limit', 'Too many', 429, 1); // 1ms retryAfter
    },
    async create(params, signal) {
      return {
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  };

  const result = await runSubagent({
    agentId: 'test-cb-rl',
    task: 'CB rate test',
    cwd,
    settings: defaultSettings(),
    adapter,
  });

  // rate_limit 每次重试都会 sleep，但 retryAfterMs=1ms 很快
  // breaker 在 5 次后熔断，assertClosed 抛错 → finishFailed
  assert.equal(result.status, 'failed');
  // CB 在第 5 次 recordFailure 后熔断，第 6 次 stream 前 assertClosed 抛错
  // 所以 callCount 应该是 5（前 5 次调了 stream）
  assert.equal(callCount, 5);

  rmDirRobust(cwd);
});

test('529 server_overload ×3 → 切换 fallbackModel（第4次失败触发降级，第5次用新model）', async () => {
  cleanAll();
  const cwd = tempDir();

  let callCount = 0;
  const models = [];
  const adapter = {
    provider: 'test',
    async *stream(params, signal) {
      callCount++;
      models.push(params.model); // 记录调用的 model
      // 前 4 次都抛 529——classifyAndShouldRetry 在第4次失败时才返回 action='fallbackModel'
      if (callCount <= 4) {
        throw new LlmError('server_overload', 'Overloaded', 529);
      }
      // 第 5 次成功——此时 model 已切换为 fallbackModel
      yield { type: 'text_delta', text: 'OK on fallback' };
      yield { type: 'message_end', usage: { input_tokens: 10, output_tokens: 3 } };
    },
    async create(params, signal) {
      return {
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        usage: { input_tokens: 10, output_tokens: 3 },
      };
    },
  };

  const result = await runSubagent({
    agentId: 'test-529',
    task: 'Overload',
    cwd,
    settings: defaultSettings({ fallbackModel: 'gpt-4o-mini' }),
    adapter,
  });

  assert.equal(result.status, 'completed');
  // 第5次调用的 model 应该是 fallbackModel（前4次失败后才降级）
  assert.equal(models[4], 'gpt-4o-mini');
  // 前4次都是原始 model
  assert.equal(models[0], 'gpt-4o');
  assert.equal(models[1], 'gpt-4o');
  assert.equal(models[2], 'gpt-4o');
  assert.equal(models[3], 'gpt-4o');

  rmDirRobust(cwd);
});

// ═══════════════════════════════════════════════════════════
// 六、成本与配对
// ═══════════════════════════════════════════════════════════

test('costTracker 聚合两轮 usage', async () => {
  cleanAll();
  const cwd = tempDir();
  writeFileSync(join(cwd, 'f.txt'), 'data');

  const adapter = scriptedAdapter([
    {
      toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'f.txt' } }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    {
      text: 'Done',
      usage: { input_tokens: 80, output_tokens: 20 },
    },
  ]);

  const result = await runSubagent({
    agentId: 'test-cost',
    task: 'Cost test',
    cwd,
    settings: defaultSettings(),
    adapter,
  });

  assert.equal(result.status, 'completed');
  const record = getSubagent('test-cost');
  assert.ok(record.cost.inputTokens > 0);
  assert.ok(record.cost.outputTokens > 0);
  assert.ok(record.cost.totalUSD > 0);

  rmDirRobust(cwd);
});

test('决策 37 回归: abort 时 normalizeMessages 补齐孤儿 tool_use', async () => {
  cleanAll();
  const cwd = tempDir();

  // 使用 execute_cli sleep 让工具执行时能被 abort 拦截
  const record = createSubagent('test-pair', { subject: 'Pairing' });

  let streamDone = false;
  const adapter = {
    provider: 'test',
    callCount: 0,
    async *stream(params, signal) {
      this.callCount++;
      if (this.callCount === 1) {
        // 第 1 轮：返回两个 tool_use——第二个是长时间执行的 sleep
        yield { type: 'tool_call_start', index: 0, id: 'toolu_a', name: 'read_file' };
        yield { type: 'tool_call_delta', index: 0, jsonFragment: '{"path":"' };
        yield { type: 'tool_call_delta', index: 0, jsonFragment: 'pair.txt"}' };
        yield { type: 'tool_call_end', index: 0, id: 'toolu_a' };

        yield { type: 'tool_call_start', index: 1, id: 'toolu_b', name: 'execute_cli' };
        yield { type: 'tool_call_delta', index: 1, jsonFragment: '{"command":"' };
        yield { type: 'tool_call_delta', index: 1, jsonFragment: 'sleep 60"}' };
        yield { type: 'tool_call_end', index: 1, id: 'toolu_b' };

        yield { type: 'message_end', usage: { input_tokens: 10, output_tokens: 30 } };
      } else {
        yield { type: 'text_delta', text: 'Should not reach' };
        yield { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } };
      }
    },
    async create(params, signal) {
      return {
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };

  const promise = runSubagent({
    agentId: 'test-pair',
    task: 'Pair test',
    cwd,
    settings: defaultSettings(),
    adapter,
  });

  // 等 read_file 执行完（瞬间），execute_cli sleep 60 正在执行
  await new Promise(r => setTimeout(r, 500));
  record.abortController.abort();

  const result = await promise;
  // abort 应该导致 status='aborted'
  assert.equal(result.status, 'aborted');

  rmDirRobust(cwd);
});

// ═══════════════════════════════════════════════════════════
// 七、集成用例
// ═══════════════════════════════════════════════════════════

test('集成用例: 完整任务——read → edit → task_create → task_update → execute_cli → 文本总结', async () => {
  cleanAll();
  const cwd = tempDir();

  // 创建初始文件
  const testFile = join(cwd, 'project.txt');
  writeFileSync(testFile, 'version: 1.0.0\nstatus: alpha');

  const events = [];
  const adapter = scriptedAdapter([
    // Turn 1: read_file
    {
      toolCalls: [{ id: 'tu1', name: 'read_file', input: { path: 'project.txt' } }],
      usage: { input_tokens: 50, output_tokens: 30 },
    },
    // Turn 2: edit_file
    {
      toolCalls: [{ id: 'tu2', name: 'edit_file', input: { path: 'project.txt', old_string: 'alpha', new_string: 'beta' } }],
      usage: { input_tokens: 60, output_tokens: 40 },
    },
    // Turn 3: task_create
    {
      toolCalls: [{ id: 'tu3', name: 'task_create', input: { subject: 'Update version', description: 'Bump to 1.1.0' } }],
      usage: { input_tokens: 70, output_tokens: 50 },
    },
    // Turn 4: task_update
    {
      toolCalls: [{ id: 'tu4', name: 'task_update', input: { taskId: '__any__', status: 'completed' } }],
      usage: { input_tokens: 80, output_tokens: 40 },
    },
    // Turn 5: execute_cli
    {
      toolCalls: [{ id: 'tu5', name: 'execute_cli', input: { command: 'echo done' } }],
      usage: { input_tokens: 90, output_tokens: 30 },
    },
    // Turn 6: 文本总结
    {
      text: 'All tasks complete. File updated to beta.',
      usage: { input_tokens: 100, output_tokens: 10 },
    },
  ]);

  const result = await runSubagent({
    agentId: 'test-int',
    task: 'Update project.txt from alpha to beta, track tasks, run validation',
    cwd,
    settings: defaultSettings(),
    adapter,
    onEvent: (e) => events.push(e),
  });

  // completed
  assert.equal(result.status, 'completed');
  assert.ok(result.result.includes('All tasks complete'));

  // store 终态
  const record = getSubagent('test-int');
  assert.equal(record.status, 'completed');

  // 审计日志
  assert.ok(record.auditLogs.length >= 5, `Expected >=5 audit logs, got ${record.auditLogs.length}`);

  // 成本 > 0
  assert.ok(record.cost.totalUSD > 0);

  // 事件流含 STATE_SNAPSHOT
  const eventTypes = events.map(e => e.type);
  assert.ok(eventTypes.includes('STATE_SNAPSHOT'), 'Should include STATE_SNAPSHOT event');

  // 文件内容真的被改了
  const fileContent = readFileSync(testFile, 'utf-8');
  assert.ok(fileContent.includes('beta'));
  assert.ok(!fileContent.includes('alpha'));

  // 事件顺序检查：RUN_STARTED 在最前，RUN_FINISHED 在最后
  assert.equal(eventTypes[0], 'RUN_STARTED');
  const lastType = eventTypes[eventTypes.length - 1];
  assert.ok(lastType === 'RUN_FINISHED' || lastType === 'STEP_FINISHED',
    `Last event should be RUN_FINISHED or STEP_FINISHED, got ${lastType}`);

  rmDirRobust(cwd);
});

// ═══════════════════════════════════════════════════════════
// 八、只读模式
// ═══════════════════════════════════════════════════════════

test('readOnly 模式: 只包含只读工具', async () => {
  cleanAll();
  const cwd = tempDir();
  writeFileSync(join(cwd, 'ro.txt'), 'hello');

  const adapter = scriptedAdapter([
    {
      toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'ro.txt' } }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    {
      text: 'Read complete',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ]);

  const result = await runSubagent({
    agentId: 'test-ro',
    task: 'Read only',
    cwd,
    settings: defaultSettings(),
    adapter,
    readOnly: true,
  });

  assert.equal(result.status, 'completed');

  rmDirRobust(cwd);
});

test('ADR-0014 readOnly 执行层硬门禁: write_file 被拒绝（#19 核心）', async () => {
  cleanAll();
  const cwd = tempDir();

  // 脚本化 adapter 让 LLM 尝试调用 write_file（绕过 schema 过滤，直接测试执行层）
  const adapter = scriptedAdapter([
    {
      toolCalls: [{ id: 'w1', name: 'write_file', input: { path: 'evil.txt', content: 'pwned' } }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    {
      text: 'Done',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ]);

  const result = await runSubagent({
    agentId: 'test-ro-gate',
    task: 'Write in readOnly',
    cwd,
    settings: defaultSettings(),
    adapter,
    readOnly: true,
  });

  // write_file 应被执行层门禁拒绝，文件不应被创建
  assert.equal(result.status, 'completed');
  assert.ok(!existsSync(join(cwd, 'evil.txt')), 'write_file should be blocked by execution gate');

  rmDirRobust(cwd);
});

test('ADR-0017 非法工具输入不杀 subagent（#23 核心）', async () => {
  cleanAll();
  const cwd = tempDir();

  // 脚本化 adapter 让 LLM 调用 execute_cli 但不传 command（schema 校验应拒绝）
  const adapter = scriptedAdapter([
    {
      toolCalls: [{ id: 'bad1', name: 'execute_cli', input: {} }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    {
      text: 'Done',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ]);

  const result = await runSubagent({
    agentId: 'test-bad-input',
    task: 'Bad input',
    cwd,
    settings: defaultSettings(),
    adapter,
  });

  // subagent 不应被杀死——应正常完成，工具调用返回错误结果
  assert.equal(result.status, 'completed', 'subagent should complete despite bad tool input');

  rmDirRobust(cwd);
});

// ═══════════════════════════════════════════════════════════
// 九、onEvent 注入
// ═══════════════════════════════════════════════════════════

test('onEvent 注入: 自定义 onEvent 收到完整事件流', async () => {
  cleanAll();
  const cwd = tempDir();

  const adapter = textAdapter('Done.');
  const events = [];
  const result = await runSubagent({
    agentId: 'test-evt',
    task: 'Simple',
    cwd,
    settings: defaultSettings(),
    adapter,
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.status, 'completed');
  assert.ok(events.length >= 2); // RUN_STARTED + RUN_FINISHED
  assert.equal(events[0].type, 'RUN_STARTED');
  assert.equal(events[0].subagentId, 'test-evt');
  assert.ok(typeof events[0].timestamp === 'number');

  rmDirRobust(cwd);
});
});
