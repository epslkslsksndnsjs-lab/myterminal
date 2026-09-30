// Workflows T12（#235）· 两通道演练 —— Actions 与 MCP/Apps 各跑一遍"启动 + 轮询 + 取消"
//
// 演练对象是**通道面**，不是引擎内部（引擎语义归 #224..#231 各自的锁）：
//   · run 用假模型起（adapterFactory 注入），轮询走通道自己的直读面（read_file 直读 index），
//     取消走通道自己的 workflow_cancel —— 三步都在被验的那条通道上发生。
//   · Actions 通道零额外开发：工具经 extension_call 门面自动可达（ADR-0052 §8 通道面）。
//   · MCP 通道两条 direct 工具直呼，同时门面亦可达（AC4 的"门面同时可达"）。
//   · enhanced continuation（nextCalls）只在 actions 生效 —— 既有行为，这里演练确认。
//   · 整形超时 actions 8s / mcp 20s 由 transports 自动选（l3TimeoutMs），演练确认。
//
// 分区：
//   DRILL-A MCP 直连：启动 / 轮询 / 取消 / 幂等重取消 / 门面同时可达
//   DRILL-B Actions 通道：启动 / 轮询 / 取消 走门面
//   DRILL-C enhanced continuation 仅 actions
//   DRILL-D 通道整形超时 8s / 20s

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer } from '../dist/mcp.js';
import { createBuiltinTools } from '../dist/core-tools.js';
import { ExtensionService } from '../dist/extensions.js';
import { MyTerminalStore } from '../dist/store.js';
import { initWorkflowEngine, resetWorkflowEngine } from '../dist/workflows/runtime.js';
import { virtualClock } from '../dist/workflows/clock.js';
import { workflowPaths, runPaths } from '../dist/workflows/paths.js';
import { l3TimeoutMs } from '../dist/l3/engine.js';

const SCRIPT = "const a = await agent('probe'); return { a };";

/** 把一次工具调用摊平成 { ok, data, error } —— MCP SDK 走 structuredContent，退化时解 text。 */
function body(result) {
  if (result?.structuredContent) return result.structuredContent;
  try { return JSON.parse(result.content[0].text); } catch { return result; }
}

const CLEANUP = [];
afterEach(() => {
  resetWorkflowEngine();
  while (CLEANUP.length) {
    const dir = CLEANUP.pop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理尽力而为 */ }
  }
});

async function harness(options = {}) {
  // macOS 的 tmpdir 是 /private/var 的符号链接：不 realpath 就会被工作区词法+realpath
  // 双检判成越界，read_file 轮询这条腿会假红。
  const raw = join(tmpdir(), 'issue-235-drill-' + randomBytes(4).toString('hex'));
  mkdirSync(join(raw, 'config'), { recursive: true });
  mkdirSync(join(raw, 'workspace'), { recursive: true });
  const dir = realpathSync(raw);
  CLEANUP.push(dir);

  const config = {
    settingsPath: join(dir, 'config', 'settings.json'),
    workspaceDir: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'ck_test_' + randomBytes(4).toString('hex'),
    actionsToken: 'at_test_' + randomBytes(4).toString('hex'),
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 10000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: options.actionsContinuationMode ?? 'off',
    nonBlockingTasksEnabled: false,
  };
  const managedRoot = join(config.workspaceDir, '.myterminal');
  const paths = workflowPaths(managedRoot);

  // 假模型：路一直挂在悬而未决的 promise 上，好让"运行中"这一档真的可被轮询到。
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const engine = initWorkflowEngine({
    workspaceDir: config.workspaceDir,
    managedRoot,
    clock: virtualClock(),
    adapterFactory: () => ({ complete: async () => { await gate; return { text: 'answer', outputTokens: 7 }; } }),
  });

  const store = new MyTerminalStore(config.stateDir);
  const builtins = createBuiltinTools(config, store);
  const ext = new ExtensionService(config, store, builtins, () => {});
  const identity = store.registerRoot({ name: 'root-235', role: 'lead' }).identity;

  const server = createMcpServer(ext);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'issue-235-drill', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([client.connect(clientT), server.connect(serverT)]);

  return {
    engine,
    paths,
    identity,
    client,
    ext,
    close: async () => { release(); await client.close().catch(() => undefined); await server.close().catch(() => undefined); },
    /** MCP 直连：直呼注册进 direct 清单的那个工具名。 */
    mcp: (name, args = {}) => client.callTool({ name, arguments: { ...args, identity } }).then(body),
    /** Actions 通道：/actions/extensions/call 的同一入口，transport 写 actions。 */
    actions: (tool, input = {}) => ext.call({ tool, input, identity }, { transport: 'actions' }),
  };
}

/** 轮询 = 在被验通道上直读 run 的 index（ADR-0052 §8：GPT 直查面 = read_file 直读 index）。 */
async function pollStatus(h, which, runId) {
  const indexFile = runPaths(h.paths, runId).indexFile;
  const res = which === 'mcp'
    ? await h.mcp('read_file', { path: indexFile })
    : await h.actions('read_file', { path: indexFile });
  assert.equal(res.ok, true, `${which} 通道轮询读 index 失败：${JSON.stringify(res.error)}`);
  return JSON.parse(res.data.result.content);
}

async function untilTerminal(h, which, runId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const index = await pollStatus(h, which, runId);
    if (index.status !== 'running' && index.status !== 'pausing' && index.status !== 'paused') return index;
    if (Date.now() > deadline) throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内离开在跑状态`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ═══════════════════════════════════════════════════════════════
// DRILL-A · MCP 直连通道
// ═══════════════════════════════════════════════════════════════

test('DRILL-A: MCP 直连 启动→轮询→取消 各一次，门面同时可达', async () => {
  const h = await harness();
  try {
    // ① 启动：直呼 direct 工具名，异步即返
    const started = await h.mcp('workflow_start', { script: SCRIPT });
    assert.equal(started.ok, true, `workflow_start 应成功：${JSON.stringify(started.error)}`);
    const runId = started.data.result.runId;
    assert.ok(typeof runId === 'string' && runId.startsWith('wf_'), `响应带 runId，实际 ${runId}`);
    assert.equal(started.data.result.status, 'running');
    assert.ok(started.data.result.scriptPath?.endsWith('.js'), '内联脚本自动落盘并回报 scriptPath');

    // ② 轮询：仍在跑（假模型挂在 gate 上）
    const running = await pollStatus(h, 'mcp', runId);
    assert.equal(running.status, 'running', '轮询应看见在跑这一档');

    // ③ 取消：整 run，小对象响应
    const cancelled = await h.mcp('workflow_cancel', { runId });
    assert.equal(cancelled.ok, true, `workflow_cancel 应成功：${JSON.stringify(cancelled.error)}`);
    assert.equal(cancelled.data.result.runId, runId);
    assert.equal(cancelled.data.result.status, 'cancelled');

    // 轮询收尾：终态真的落到了盘上
    const settled = await untilTerminal(h, 'mcp', runId);
    assert.equal(settled.status, 'cancelled');

    // ④ 幂等：终态再取消 → 返回当前状态，不是错误
    const again = await h.mcp('workflow_cancel', { runId });
    assert.equal(again.ok, true, '终态重取消必须 no-op 成功');
    assert.equal(again.data.result.status, 'cancelled');

    // ⑤ 门面同时可达：extension_call 起的是同一条 builtin 通路
    const viaFacade = await h.mcp('extension_call', { tool: 'workflow_start', input: { script: SCRIPT } });
    assert.equal(viaFacade.ok, true, `门面也应能启动：${JSON.stringify(viaFacade.error)}`);
    assert.ok(viaFacade.data.result.runId !== runId, '门面起的是另一条 run');
    const facadeCancel = await h.mcp('extension_call', { tool: 'workflow_cancel', input: { runId: viaFacade.data.result.runId } });
    assert.equal(facadeCancel.data.result.status, 'cancelled');

    // ⑥ discover 把两个工具都对外公布
    const discovered = await h.mcp('extension_discover', {});
    const advertised = JSON.stringify(discovered.data);
    assert.match(advertised, /workflow_start/);
    assert.match(advertised, /workflow_cancel/);
  } finally {
    await h.close();
  }
});

// ═══════════════════════════════════════════════════════════════
// DRILL-B · Actions 通道（零额外开发，全走门面）
// ═══════════════════════════════════════════════════════════════

test('DRILL-B: Actions 通道 启动→轮询→取消 各一次', async () => {
  const h = await harness();
  try {
    const started = await h.actions('workflow_start', { script: SCRIPT });
    assert.equal(started.ok, true, `actions 通道启动应成功：${JSON.stringify(started.error)}`);
    const runId = started.data.result.runId;
    assert.equal(started.data.result.status, 'running');

    const running = await pollStatus(h, 'actions', runId);
    assert.equal(running.status, 'running');

    const cancelled = await h.actions('workflow_cancel', { runId });
    assert.equal(cancelled.ok, true, `actions 通道取消应成功：${JSON.stringify(cancelled.error)}`);
    assert.equal(cancelled.data.result.status, 'cancelled');

    const settled = await untilTerminal(h, 'actions', runId);
    assert.equal(settled.status, 'cancelled');
  } finally {
    await h.close();
  }
});

test('DRILL-B2: 两通道行为纪律一致 —— subagent 通道在两边都进不来', async () => {
  const h = await harness();
  try {
    // 入口闸是工具层的，与对外通道无关：同一 handler，subagent 上下文一律 FORBIDDEN
    for (const tool of ['workflow_start', 'workflow_cancel']) {
      const denied = await h.ext.call(
        { tool, input: tool === 'workflow_start' ? { script: SCRIPT } : { runId: 'wf_not_a_run' }, identity: h.identity },
        { transport: 'subagent' },
      );
      assert.equal(denied.ok, false, `${tool} 经 subagent 通道必须被拒`);
      assert.equal(denied.error.code, 'FORBIDDEN', `${tool} 拒因必须是入口闸，实际 ${denied.error.code}`);
    }
  } finally {
    await h.close();
  }
});

// ═══════════════════════════════════════════════════════════════
// DRILL-C · enhanced continuation（nextCalls）仅 actions 生效
// ═══════════════════════════════════════════════════════════════

test('DRILL-C: working checkpoint 的 nextCalls 强制只在 actions 生效，MCP 同一调用不受管', async () => {
  const h = await harness({ actionsContinuationMode: 'adaptive' });
  try {
    // actions：working 档缺 nextCalls → 强制门拦下，并把 mustContinue 摊给调用方
    const blocked = await h.actions('session_checkpoint', { phase: 'working', summary: 'still going' });
    assert.equal(blocked.ok, false, 'actions 通道 adaptive 下必须要求 nextCalls');
    assert.equal(blocked.error.code, 'CONTINUATION_PLAN_REQUIRED');
    assert.equal(blocked.error.details.mustContinue, true);

    // 补齐 nextCalls 后放行 —— 证明拦的是"缺计划"，不是整条通道
    const passed = await h.actions('session_checkpoint', {
      phase: 'working',
      summary: 'still going',
      nextCalls: [{ tool: 'workspace_info', input: {}, purpose: 'next step' }],
    });
    assert.equal(passed.ok, true, `带 nextCalls 的 actions checkpoint 应放行：${JSON.stringify(passed.error)}`);

    // MCP：同一工具、同样缺 nextCalls → 不受该门管辖（enhanced continuation 是 actions-only）
    const viaMcp = await h.mcp('session_checkpoint', { phase: 'working', summary: 'still going' });
    assert.equal(viaMcp.ok, true, `MCP 通道不该吃 actions 的 nextCalls 门：${JSON.stringify(viaMcp.error)}`);
  } finally {
    await h.close();
  }
});

// ═══════════════════════════════════════════════════════════════
// DRILL-D · 通道整形超时（transports 自动选）
// ═══════════════════════════════════════════════════════════════

test('DRILL-D: 整形超时按通道自动取 —— actions 8s / mcp 20s', () => {
  // K5（Actions 45s 单调用窗）逼出更紧的整形窗；MCP/Apps 无此约束走宽档。
  assert.equal(l3TimeoutMs('actions'), 8000, 'Actions 通道整形超时 8s');
  assert.equal(l3TimeoutMs('mcp'), 20000, 'MCP 通道整形超时 20s');
  assert.ok(l3TimeoutMs('actions') < l3TimeoutMs('mcp'), 'actions 必须比 mcp 紧');
});
