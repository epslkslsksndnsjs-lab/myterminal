// Workflows T5（#228）：并行子 agent 工具集（只读面）——引擎级验收
//
// 全部跑在假模型 + 虚拟钟上：一条 run 里的每一路经模块自己的循环走工具面，
// 工具真读文件、真起进程、真按进程组收。断言只盯外部行为：
// 面上有哪些工具、越界与禁令怎么被拒、返回的有界与显式截断、每路 system 消息长什么样、
// 三次结构化提交失败即该路无结果、路终结与关机时命令树随组收。零件契约在 -units 文件。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkflowEngine } from '../dist/workflows/engine.js';
import { virtualClock } from '../dist/workflows/clock.js';
import { workflowPaths, runPaths } from '../dist/workflows/paths.js';
import { readIndex } from '../dist/workflows/run-index.js';
import { MODULE_FLOOR_TOOLS } from '../dist/workflows/agent-opts.js';
import {
  FLOOR_FORBIDDEN_PREFIXES,
  FLOOR_FORBIDDEN_TOOL_NAMES,
  WRITE_ONLY_TOOL_NAMES,
} from '../dist/workflows/tool-face.js';
import { listCommands, resetCommandLedger, shutdownCommandTrees } from '../dist/workflows/command-tree.js';

const TMP = [];
const READ_ONLY_FACE = ['read_file', 'read_file_range', 'list_dir', 'find_files', 'search_text', 'execute_cli'];
const skipOnWin = process.platform === 'win32';

/** 命令树账本是进程级状态：每条用例都从零账本与"接单中"起跑。 */
afterEach(() => {
});

function tempWorkspace() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-228-')));
  TMP.push(dir);
  const workspaceDir = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const managedRoot = path.join(workspaceDir, '.myterminal');
  return { workspaceDir, managedRoot, paths: workflowPaths(managedRoot) };
}

/**
 * 假模型：按 prompt 与轮次派发剧本，逐笔记下整笔请求。
 * systemPrompts() 即票面口径——每一路（每一轮）递出去的 system 消息都可点名核验。
 */
function scriptedModel(script) {
  const state = {
    calls: [],
    byPrompt: new Map(),
    signals: [],
    systemPrompts: () => state.calls.map((call) => call.system),
    toolNames: (index = 0) => (state.calls[index]?.tools ?? []).map((tool) => tool.name),
    messagesOf: (index) => state.calls[index]?.messages ?? [],
    sawPrompt: (prompt) => state.calls.some((call) => call.prompt === prompt),
  };
  const factory = () => ({
    complete: async (request) => {
      // 逐轮留一份快照：循环原地加长 messages，直接留引用会让所有轮看到同一份终态。
      state.calls.push({
        ...request,
        messages: (request.messages ?? []).map((message) => ({ role: message.role, content: [...message.content] })),
        tools: request.tools ?? [],
      });
      state.signals.push(request.signal);
      const n = (state.byPrompt.get(request.prompt) ?? 0) + 1;
      state.byPrompt.set(request.prompt, n);
      const reply = script(request, n, state);
      return typeof reply === 'function' ? reply(request, n) : reply ?? { text: 'ok', outputTokens: 2 };
    },
  });
  // 展平一层：用例里直接写 model.calls / model.systemPrompts()（票面口径）。
  return { factory, state, ...state };
}

function engineFor(temp, options = {}) {
  const clock = options.clock ?? virtualClock();
  const engine = new WorkflowEngine({
    workspaceDir: temp.workspaceDir,
    managedRoot: temp.managedRoot,
    clock,
    audit: () => { /* 本票不重述审计契约 */ },
    adapterFactory: options.adapterFactory,
    gates: options.gates,
    concurrencyWindow: options.concurrencyWindow ?? 2,
  });
  return { engine, clock };
}

function gates(over = {}) {
  return { runGateMs: 60_000, dispatchWindowMs: 30_000, dispatchTurns: 12, stallMs: 5_000, reducerBudgetMs: 90_000, reducerTimeoutMs: 120_000, reduceSlackMs: 1_000, ...over };
}

function toolUse(id, name, input) {
  return { text: '', outputTokens: 1, toolUses: [{ id, name, input }] };
}

function done(text, outputTokens = 3) {
  return { text, outputTokens };
}

const NEVER = () => new Promise(() => {});

/** 读回某一轮里模型新收到的那批 tool_result 的第一条（含解析后的载荷）。 */
function firstToolResult(model, callIndex) {
  const messages = model.messagesOf(callIndex);
  const block = messages[messages.length - 1]?.content?.[0];
  return block ? { ...block, payload: JSON.parse(block.content) } : undefined;
}

async function until(condition, what, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) assert.fail(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 该路终态文件（每路一件）——读该路结果的既有口径。 */
function agentRecord(temp, runId, slot = 'd0001') {
  return JSON.parse(fs.readFileSync(path.join(runPaths(temp.paths, runId).agentsDir, `${slot}.json`), 'utf8'));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function settle(temp, engine, script, ownerSessionId = 'sess-a') {
  const started = await engine.start({ script, ownerSessionId });
  const index = await started.completion;
  return { started, index };
}

// ═══════════════════════════════════════════════════════════════
// AC1 只读工具集齐备：读 / 列 / 搜 / glob / 执行，执行有界且只放 safe 读命令
// ═══════════════════════════════════════════════════════════════

test('AC1 一路经工具面读真文件再交回结论：最终文本即该路返回值', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(path.join(temp.workspaceDir, 'note.txt'), 'the note says 42');
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('u1', 'read_file', { path: 'note.txt' }) : done('answered from the note')));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { index, started } = await settle(temp, engine, `const a = await agent('read the note', { label: 'reader' });\nreturn a;`);
  assert.equal(index.status, 'completed');
  assert.equal(index.dispatches[0].status, 'completed');
  assert.equal(agentRecord(temp, started.runId).result, 'answered from the note', '该路结果 = 模型最后一轮的文本');
  const seen = firstToolResult(model, 1);
  assert.equal(seen.is_error, false);
  assert.equal(seen.payload.ok, true);
  assert.equal(seen.payload.chars, 16);
  assert.match(seen.payload.text, /the note says 42/);
});

test('AC1 列目录 / glob / 搜索 / 读段四个动词在这一跑里各回一条真结果', async () => {
  const temp = tempWorkspace();
  fs.mkdirSync(path.join(temp.workspaceDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(temp.workspaceDir, 'src', 'a.ts'), 'one\ntwo\nthree');
  const verbs = [
    ['list_dir', { path: 'src' }],
    ['find_files', { path: 'src', pattern: '**/*.ts' }],
    ['search_text', { path: 'src', pattern: 'two' }],
    ['read_file_range', { path: 'src/a.ts', firstLine: 2, lineCount: 1 }],
  ];
  const model = scriptedModel((request, n) => (n <= verbs.length ? toolUse(`u${n}`, verbs[n - 1][0], verbs[n - 1][1]) : done('all four worked')));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { started } = await settle(temp, engine, `const a = await agent('survey the tree', { label: 'survey' });\nreturn a;`);
  assert.equal(agentRecord(temp, started.runId).result, 'all four worked');
  assert.equal(model.calls.length, verbs.length + 1, '四轮各用一个动词，第五轮收尾');
  const payloads = [1, 2, 3, 4].map((round) => firstToolResult(model, round).payload);
  assert.deepEqual(payloads.map((payload) => payload.ok), [true, true, true, true], JSON.stringify(payloads));
  assert.match(payloads[0].entries, /a\.ts/);
  assert.equal(payloads[1].files, 'a.ts');
  assert.equal(payloads[2].text, 'a.ts:2:two');
  assert.equal(payloads[3].text, '2\ttwo');
});

test('AC1 执行面：safe 读命令放行，写副作用与越权形态各回自己的具名拒因', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(path.join(temp.workspaceDir, 'keep.txt'), 'x');
  const commands = ['ls', 'touch planted.txt', 'echo hi > planted.txt', 'rm -f keep.txt', 'echo $(id)'];
  const model = scriptedModel((request, n) => (n <= commands.length ? toolUse(`u${n}`, 'execute_cli', { command: commands[n - 1] }) : done('reported')));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { started } = await settle(temp, engine, `const a = await agent('work the workspace', { label: 'exec' });\nreturn a;`);
  assert.equal(agentRecord(temp, started.runId).result, 'reported');
  const payloads = [1, 2, 3, 4, 5].map((round) => firstToolResult(model, round).payload);
  assert.equal(payloads[0].ok, true, `ls 放行：${JSON.stringify(payloads[0])}`);
  assert.deepEqual(payloads.slice(1).map((payload) => payload.reason), ['not-in-read-only-allowlist', 'not-in-read-only-allowlist', 'dangerous-command', 'command-substitution']);
  assert.equal(fs.existsSync(path.join(temp.workspaceDir, 'planted.txt')), false, '被拒的命令一个字都不落地');
  assert.equal(fs.existsSync(path.join(temp.workspaceDir, 'keep.txt')), true, '危险表挡住了删除');
});

// ═══════════════════════════════════════════════════════════════
// AC2 工具 floor：无扇出 / 消息 / 控制面 / 自管理工具；调用被拒；写请求在只读面即拒
// ═══════════════════════════════════════════════════════════════

test('AC2 递给模型的工具面就是只读六件套：floor 禁令里的名字一个都不在场上', async () => {
  const temp = tempWorkspace();
  const model = scriptedModel(() => done('quiet'));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  await settle(temp, engine, `await agent('just answer', { label: 'idle' });\nreturn 1;`);
  assert.deepEqual(model.toolNames(), READ_ONLY_FACE);
  const declared = new Set(model.toolNames());
  for (const banned of FLOOR_FORBIDDEN_TOOL_NAMES) assert.equal(declared.has(banned), false, `${banned} 不可见`);
  for (const name of declared) {
    assert.equal(FLOOR_FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix)), false, `${name} 落在禁用前缀里`);
    assert.equal(WRITE_ONLY_TOOL_NAMES.includes(name), false, `${name} 是写工具`);
    assert.equal(MODULE_FLOOR_TOOLS.some((tool) => tool.name === name), true, `${name} 未在模块发布名单里`);
  }
});

test('AC2 模型硬要扇出即被当面拒：错误载荷回给模型，这一路照常收尾', async () => {
  const temp = tempWorkspace();
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('u1', 'subagent_start', { task: 'fan out' }) : done('refused and moved on')));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { started } = await settle(temp, engine, `const a = await agent('try to fan out', { label: 'floor' });\nreturn a;`);
  assert.equal(agentRecord(temp, started.runId).result, 'refused and moved on');
  const refused = firstToolResult(model, 1).payload;
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'floor-tool-forbidden');
  assert.match(refused.error, /cannot spawn subagents/);
  assert.match(refused.available, /read_file/);
});

test('AC2 只读面点名要写工具 = 形状错：零 token、不占缓存键位、不进失败清单', async () => {
  const temp = tempWorkspace();
  const model = scriptedModel(() => done('only the clean path ran'));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { index } = await settle(temp, engine, `let why = 'no-throw';\ntry { await agent('wanting writes', { tools: ['write_file'], label: 'W' }); } catch (error) { why = String(error.message); }\nconst a = await agent('caught ' + why.slice(0, 60), { label: 'C' });\nreturn { a, why };`);
  assert.equal(model.sawPrompt('wanting writes'), false, '烧 token 之前就拒了');
  assert.equal(model.calls.length, 1, '只有合规的那一路跑了');
  assert.deepEqual(index.dispatches.map((record) => record.label), ['C'], '被拒的形状错不占键位');
  assert.deepEqual(index.failures, [], '形状错不进失败清单');
  assert.match(model.calls[0].prompt, /caught agent\(\): write_file cannot run/, '拒因走得到脚本侧');
});

test('AC2 收窄只减不增：tools / disallowedTools / agentType 都落到派发面，越上界即拒', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(path.join(temp.workspaceDir, 'tiny.txt'), 't');
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('u1', 'read_file', { path: 'tiny.txt' }) : done('narrowed')));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { index, started } = await settle(temp, engine, `const a = await agent('read only', { tools: ['read_file'], disallowedTools: ['search_text'], label: 'N' });\nlet b = 'no-throw';\ntry { await agent('over the ceiling', { agentType: 'reader', tools: ['execute_cli'], label: 'X' }); } catch (error) { b = 'refused'; }\nreturn { a, b };`);
  assert.deepEqual(model.toolNames(0), ['read_file'], '白名单把面收到一件');
  assert.equal(agentRecord(temp, started.runId).result, 'narrowed');
  assert.equal(model.sawPrompt('over the ceiling'), false, 'agentType 上界不可被 tools 抬高');
  assert.deepEqual(index.dispatches.map((record) => record.label), ['N']);
});

// ═══════════════════════════════════════════════════════════════
// AC3 schema 模式：自动提供 structured_output；三次校验失败 = 该路无结果
// ═══════════════════════════════════════════════════════════════

const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };

test('AC3 schema 模式自动把 structured_output 放上面，合格提交即该路结果', async () => {
  const temp = tempWorkspace();
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('u1', 'structured_output', { verdict: 'pass' }) : done('ignored')));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { index, started } = await settle(temp, engine, `const a = await agent('judge it', { schema: ${JSON.stringify(SCHEMA)}, label: 'J' });\nreturn a;`);
  assert.deepEqual(model.toolNames().slice(-1), ['structured_output'], '出口自动补在最后');
  assert.deepEqual(agentRecord(temp, started.runId).result, { verdict: 'pass' });
  assert.equal(model.calls.length, 1, '合格提交即收尾，不再多问一轮');
  const declaration = model.calls[0].tools.find((tool) => tool.name === 'structured_output');
  assert.deepEqual(declaration.input_schema, SCHEMA, '出口的入参形状就是这一路的 schema');
});

test('AC3 三次不合格提交 = 该路无结果并具名记账，另一路照常交付（T2 三态衔接）', async () => {
  const temp = tempWorkspace();
  const bad = toolUse('u', 'structured_output', { verdict: 7 });
  const model = scriptedModel((request, n) => {
    if (request.prompt === 'schema path') return n <= 3 ? bad : done('unreachable');
    return done('sibling delivered');
  });
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { index, started } = await settle(temp, engine, `const out = await parallel([() => agent('schema path', { schema: ${JSON.stringify(SCHEMA)}, label: 'S' }), () => agent('plain path', { label: 'P' })]);\nreturn { count: out.filter(Boolean).length };`);
  const failed = index.dispatches.find((record) => record.label === 'S');
  const sibling = index.dispatches.find((record) => record.label === 'P');
  assert.equal(agentRecord(temp, started.runId, 'd0002').result, 'sibling delivered', '另一路照常在盘上');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.kind, 'no_structured_output');
  assert.match(failed.error.message, /refused 3 structured submissions/);
  assert.equal(failed.attempts, 1, '缺结构化输出不重试');
  assert.equal(sibling.status, 'completed');
  assert.equal(index.failures.length, 1);
  assert.equal(index.failures[0].kind, 'no_structured_output');
  assert.equal(index.status, 'completed', '部分失败仍是 completed（带警告交付）');
  const schemaCalls = model.calls.filter((call) => call.prompt === 'schema path');
  assert.equal(schemaCalls.length, 3, '第三次失败即收手，不再问第四次');
  const firstError = JSON.parse(schemaCalls[1].messages[schemaCalls[1].messages.length - 1].content[0].content);
  assert.equal(firstError.reason, 'bad-structured-submission');
  assert.match(firstError.error, /Submission 1 of 3/);
});

// ═══════════════════════════════════════════════════════════════
// AC4 每路 system prompt：假模型侧逐路核验 + 模式追加项
// ═══════════════════════════════════════════════════════════════

test('AC4 每路 system 消息各自成文：角色 / 工具用法 / 环境 / 输出约束按这一路的形状写', async () => {
  const temp = tempWorkspace();
  const model = scriptedModel(() => done('answered'));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  await settle(temp, engine, `const out = await parallel([() => agent('first task', { label: 'one' }), () => agent('second task', { label: 'two', tools: ['read_file'] })]);\nreturn out.length;`);
  const prompts = model.systemPrompts();
  assert.equal(prompts.length, 2);
  assert.notEqual(prompts[0], prompts[1], '两路不共用一份提示词');
  const escaped = temp.workspaceDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [text, label] of [[prompts[0], 'one'], [prompts[1], 'two']]) {
    assert.match(text, new RegExp(`# Path "${label}"`), '角色与任务框架点名这一路');
    assert.match(text, /one path inside a local workflow run/i);
    assert.match(text, /sibling paths/i);
    assert.match(text, /# Tools on this path/);
    assert.match(text, new RegExp(`Working directory: ${escaped}`), '环境 = 这一跑的边界');
    assert.match(text, /# How you hand back/);
    assert.match(text, /the text you finish on is the value the script receives/i);
    assert.match(text, /no acknowledgement/i, '禁确认语');
    assert.match(text, /write it bare: no code fence/i, 'JSON 裸出');
  }
  assert.match(prompts[0], /Available here: read_file, read_file_range, list_dir, find_files, search_text, execute_cli/);
  assert.match(prompts[1], /Available here: read_file\./, '收窄后的面也照实写进提示词');
});

test('AC4 schema 路与隔离路各拿到自己的追加项', async () => {
  const temp = tempWorkspace();
  const model = scriptedModel((request, n) => (request.prompt === 'schema path' && n === 1 ? toolUse('u1', 'structured_output', { verdict: 'ok' }) : done('plain')));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { index } = await settle(temp, engine, `const out = await parallel([() => agent('schema path', { schema: ${JSON.stringify(SCHEMA)}, label: 'S' }), () => agent('write path', { isolation: 'worktree', label: 'W' })]);\nreturn out.length;`);
  assert.equal(index.status, 'completed');
  assert.equal(index.dispatches.find((record) => record.label === 'W').isolation, 'worktree');
  const prompts = model.systemPrompts();
  const schemaPrompt = prompts.find((text) => text.includes('# Path "S"'));
  const writePrompt = prompts.find((text) => text.includes('# Path "W"'));
  assert.match(schemaPrompt, /hands back its result through the structured_output tool/i);
  assert.equal(writePrompt.includes('structured_output'), false);
  assert.match(writePrompt, /# If you change files/);
  assert.match(writePrompt, /Report the absolute directory and the branch you changed/i, '声明隔离的那一路要回报目录 + 分支');
});

// ═══════════════════════════════════════════════════════════════
// AC5 返回一律结构化 JSON + 有界 + 显式截断；错误显式字段
// ═══════════════════════════════════════════════════════════════

test('AC5 超限的读取回显式截断三读数，绝不满份灌回模型', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(path.join(temp.workspaceDir, 'huge.txt'), 'q'.repeat(70_000));
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('u1', 'read_file', { path: 'huge.txt' }) : done('saw the bound')));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { index, started } = await settle(temp, engine, `const a = await agent('read the huge file', { label: 'B' });\nreturn a;`);
  assert.equal(agentRecord(temp, started.runId).result, 'saw the bound');
  const block = firstToolResult(model, 1);
  assert.equal(block.content.length <= 50_000, true, '单条工具结果有界');
  const payload = block.payload;
  assert.equal(payload.ok, true);
  assert.equal(payload.chars, 70_000);
  assert.equal(payload.truncated, true);
  assert.equal(payload.text.length, payload.shown);
  assert.equal(payload.shown < payload.chars, true);
});

test('AC5 失败一律带 error + reason：找不到、越界、形状不合各说各话', async () => {
  const temp = tempWorkspace();
  const calls = [
    toolUse('u1', 'read_file', { path: 'ghost.txt' }),
    toolUse('u2', 'read_file', { path: '../../etc/passwd' }),
    toolUse('u3', 'read_file', { path: 42 }),
    toolUse('u4', 'list_dir', { nope: true }),
    done('all reported'),
  ];
  const model = scriptedModel((request, n) => calls[Math.min(n, calls.length) - 1]);
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { index, started } = await settle(temp, engine, `const a = await agent('probe the edges', { label: 'E' });\nreturn a;`);
  assert.equal(agentRecord(temp, started.runId).result, 'all reported');
  const payloads = [1, 2, 3, 4].map((round) => firstToolResult(model, round).payload);
  assert.deepEqual(payloads.map((payload) => payload.reason), ['not-found', 'outside-boundary', 'bad-tool-input', 'bad-tool-input']);
  for (const payload of payloads) {
    assert.equal(payload.ok, false);
    assert.equal(typeof payload.error, 'string');
    assert.equal(payload.error.length > 0, true, '不静默');
  }
});

// ═══════════════════════════════════════════════════════════════
// AC6 路径双检在引擎侧同样成立（symlink 逃逸）
// ═══════════════════════════════════════════════════════════════

test.skipIf(skipOnWin)('AC6 界内 symlink 指向界外：这一跑读不到它，拒因点名 symlink', async () => {
  const temp = tempWorkspace();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-228-out-')));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not read me');
  fs.symlinkSync(outside, path.join(temp.workspaceDir, 'link'));
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('u1', 'read_file', { path: 'link/secret.txt' }) : done('blocked')));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { index, started } = await settle(temp, engine, `const a = await agent('escape attempt', { label: 'L' });\nreturn a;`);
  assert.equal(agentRecord(temp, started.runId).result, 'blocked');
  const payload = firstToolResult(model, 1).payload;
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'outside-boundary');
  assert.match(payload.error, /symlink/);
});

// ═══════════════════════════════════════════════════════════════
// AC7 执行工具随路 / 随关机按进程组收（含后台命令）
// ═══════════════════════════════════════════════════════════════

// 收尸用例需要一个可预期的慢命令，而只读白名单里没有 sleep——`tail -f /dev/null`
// 是放行的读命令（读空设备、永不返回），不必借道写模式就能把进程挂着。
function waitingCommand() {
  return 'tail -f /dev/null';
}

test.skipIf(skipOnWin)('AC7 该路收尾即收后台命令的进程组，run 结算时账本已空', async () => {
  const temp = tempWorkspace();
  const command = waitingCommand();
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('u1', 'execute_cli', { command, run_in_background: true }) : done('started it')));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const started = await engine.start({ script: `const a = await agent('start a long command', { label: 'BG' });\nreturn a;`, ownerSessionId: 'sess-a' });
  const index = await started.completion;
  assert.equal(index.dispatches[0].status, 'completed');
  const background = firstToolResult(model, 1).payload;
  const pid = background.pid;
  assert.equal(typeof pid, 'number', `后台句柄应回 pid：${JSON.stringify(background)}`);
  await until(async () => !alive(pid), '该路收尾即按进程组收掉');
  assert.deepEqual(listCommands({ runId: started.runId }), [], '随路收完不留账');
});

test.skipIf(skipOnWin)('AC7 关机三步在 run 在飞时成立：停接单、按组收在飞树、有限宽限', async () => {
  const temp = tempWorkspace();
  const command = waitingCommand();
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('u1', 'execute_cli', { command, run_in_background: true }) : NEVER));
  const clock = virtualClock();
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates({ runGateMs: 60_000, dispatchWindowMs: 4_000, stallMs: 30_000 }), clock });
  const started = await engine.start({ script: `const a = await agent('start then hang', { label: 'HANG' });\nreturn a;`, ownerSessionId: 'sess-a' });
  await until(async () => listCommands({ runId: started.runId }).length === 1, '在飞那一路的命令登记上账');
  const pid = listCommands({ runId: started.runId })[0].pid;
  assert.equal(alive(pid), true);
  const summary = await shutdownCommandTrees({ graceMs: 300 });
  assert.equal(summary.collected, 1);
  assert.equal(alive(pid), false, '在飞那一路的命令树随关机收掉');
  // 该路还在等下一轮：dispatch 窗口到点后判败收尾，账本此时必须已空。
  clock.advance(4_000);
  const index = await started.completion;
  assert.equal(index.dispatches[0].error.kind, 'timeout');
  assert.deepEqual(listCommands({ runId: started.runId }), []);
});

// ═══════════════════════════════════════════════════════════════
// AC8 与既有 subagent 体系零直接 import（结构断言）+ 独立行为锁
// ═══════════════════════════════════════════════════════════════

test('AC8 模块不 import 既有 subagent 的 runner / store / executor / 工具栈——只继承 LlmAdapter', () => {
  const directory = path.join(import.meta.dirname, '..', 'src', 'workflows');
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.ts'));
  assert.equal(files.length > 30, true, '本票的新文件也在这张清单里');
  const forbidden = /\.\.\/subagent\/(runner|store|executor|tools|tool-executor|permissions|shell-tracker|result-budget|grep-utils|file-state|output-dir)\.js/;
  for (const name of files) {
    const source = fs.readFileSync(path.join(directory, name), 'utf8');
    const offenders = source.split('\n').filter((line) => forbidden.test(line));
    assert.deepEqual(offenders, [], `${name} 不该 import 会话侧执行线：${offenders.join(' | ')}`);
    // 唯一的例外是模型通道本身（ADR-0052 §1：只继承 LlmAdapter）。
    const external = source.split('\n').filter((line) => line.includes("from '../") && !line.includes("from '../types.js") && !line.includes("from '../store.js") && !line.includes("from '../audit-log.js"));
    for (const line of external) assert.match(line, /subagent\/llm-adapter\.js/, `${name} 只允许继承 llm-adapter：${line.trim()}`);
  }
});

test('AC8 本票交付的每一路都跑在模块自己的循环与工具面上（行为锁）', async () => {
  const temp = tempWorkspace();
  fs.writeFileSync(path.join(temp.workspaceDir, 'lock.txt'), 'locked');
  const model = scriptedModel((request, n) => (n === 1 ? toolUse('u1', 'read_file', { path: 'lock.txt' }) : done('locked in')));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const started = await engine.start({ script: `const a = await agent('lock the behaviour', { label: 'LOCK' });\nreturn a;`, ownerSessionId: 'sess-a' });
  const index = await started.completion;
  const run = runPaths(temp.paths, started.runId);
  const perPath = await readIndex(run.indexFile);
  assert.equal(perPath.dispatches[0].status, index.dispatches[0].status, '索引与盘面一致');
  const record = agentRecord(temp, started.runId);
  assert.equal(record.result, 'locked in');
  assert.equal(record.schemaVersion, 1);
  assert.equal(model.calls[0].system.includes('# Path "LOCK"'), true, '系统提示词由模块拼接，不取会话侧那份');
});

// ═══════════════════════════════════════════════════════════════
// 评审补口：写权限的 fail-closed、交付口径的两条腿、关机接线的归属
// ═══════════════════════════════════════════════════════════════

test('AC2 声明 isolation:worktree 不等于拿到写权限：命令闸仍按只读执法（fail-closed）', async () => {
  const temp = tempWorkspace();
  const commands = ['touch planted.txt', 'echo hi > planted.txt', 'rm -f keep.txt'];
  const model = scriptedModel((request, n) => (n <= commands.length ? toolUse(`u${n}`, 'execute_cli', { command: commands[n - 1] }) : done('all refused')));
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { started } = await settle(temp, engine, `const a = await agent('try to write', { label: 'ISO', isolation: 'worktree' });\nreturn a;`);
  const reasons = [1, 2, 3].map((round) => firstToolResult(model, round).payload.reason);
  assert.deepEqual(reasons, ['not-in-read-only-allowlist', 'not-in-read-only-allowlist', 'dangerous-command']);
  assert.equal(fs.existsSync(path.join(temp.workspaceDir, 'planted.txt')), false, '声明隔离不是放开写盘的凭据');
  assert.equal(agentRecord(temp, started.runId).result, 'all refused');
});

test('AC3 交付口径两条腿都锁住：经出口的提交与纯文本兜底各有其位', async () => {
  const temp = tempWorkspace();
  const model = scriptedModel((request, n) => {
    if (request.prompt === 'submitted') return toolUse('u1', 'structured_output', { verdict: 'via-tool' });
    if (request.prompt === 'textual') return done('{ "verdict": "via-text" }');
    return done('unused');
  });
  const { engine } = engineFor(temp, { adapterFactory: model.factory, gates: gates() });
  const { index } = await settle(temp, engine, `const out = await parallel([() => agent('submitted', { schema: ${JSON.stringify(SCHEMA)}, label: 'T' }), () => agent('textual', { schema: ${JSON.stringify(SCHEMA)}, label: 'X' })]);\nreturn out.filter(Boolean).length;`);
  const dir = runPaths(temp.paths, index.runId).agentsDir;
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'd0001.json'), 'utf8')).result, { verdict: 'via-tool' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'd0002.json'), 'utf8')).result, { verdict: 'via-text' }, '没有提交时纯文本仍是既有兜底（#225 锁过的口径）');
  const shipped = model.systemPrompts().find((text) => text.includes('# Path "T"'));
  assert.match(shipped, /structured_output/g, '提示词说清出口');
  assert.equal(shipped.includes('is not read as the result'), false, '但提示词不谎称引擎拒收文本');
});

test('AC7 关机接线的归属锁：SIGHUP → runtime close → 收 Workflows 的在飞命令树', () => {
  const cli = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
  const server = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'server.ts'), 'utf8');
  assert.match(cli, /process\.once\('SIGHUP', \(\) => gracefulSignalShutdown\('SIGHUP'\)\)/, '关终端走优雅关机（既有链路）');
  assert.match(server, /await this\.extensions\.shutdown\(\);\n[^]*?await shutdownCommandTrees\(\);/, 'Workflows 的命令树属 close() 的收尸面');
});
