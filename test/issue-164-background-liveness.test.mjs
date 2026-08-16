// Issue #164（ADR-0048 主理人新增接线）— subagent_status 报后台任务存活状态
// getBackgroundTask 死线获得生产消费方：runner.status() 用 shell-tracker 句柄判活，
// 父代理经 subagent_status 得知后台命令是否还在跑（backgroundId + alive + pid）。
//
// 验收覆盖（对应 #164 Acceptance criteria）：
//   AC1  父可经 subagent_status 得知后台命令存活状态（真实用例：execute_cli 转后台 → MCP 查询）
//   AC2  getBackgroundTask 获得生产消费方（alive 判定消费其返回值）
//   退出后 alive=false（索引保留至收尸）；收尸后索引清空 → alive=false；无后台任务 → 键缺失
//
// 测试方式：issue-136 全 MCP 链（InMemoryTransport + Client.callTool）+ issue-134 直调 execute_cli。
// 注：任何 src 改动后必须先 bun run build 再跑测试（#43）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { setRunnerDepsForTesting, resetSubagentRunner } from '../dist/subagent/runner.js';
import { clearAllSubagents, createSubagent } from '../dist/subagent/store.js';
import { clearAllShellTasks, cleanupAgentShellTasks } from '../dist/subagent/shell-tracker.js';
import { getTool } from '../dist/subagent/tools.js';
import { createBuiltinTools } from '../dist/core-tools.js';
import { ExtensionService } from '../dist/extensions.js';
import { MyTerminalStore } from '../dist/store.js';
import { createMcpServer } from '../dist/mcp.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 测试辅助（issue-136 手法）──

const DIRS = [];
afterEach(() => {
  clearAllSubagents();
  clearAllShellTasks();
  resetSubagentRunner();
  for (const d of DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  DIRS.length = 0;
});

function tempDir() {
  const dir = join(tmpdir(), 'issue-164-' + randomBytes(4).toString('hex'));
  mkdirSync(dir, { recursive: true });
  DIRS.push(dir);
  return dir;
}

function makeConfig(dir) {
  return {
    settingsPath: join(dir, 'config', 'settings.json'),
    workspaceDir: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    host: '127.0.0.1',
    port: 0,
    connectorKey: 'ck_164_' + randomBytes(4).toString('hex'),
    actionsToken: 'at_164_' + randomBytes(4).toString('hex'),
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 10000,
    commandTimeoutSec: 10,
    uiLanguage: 'en',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };
}

function defaultSubagentSettings(overrides = {}) {
  return {
    enabled: true,
    provider: 'openai',
    model: 'gpt-4o',
    maxTurns: 50,
    timeoutSec: 300,
    maxParallel: 2,
    ...overrides,
  };
}

/** 装 fake runner deps——本测试手动建 record + 直调 execute_cli，runSubagentImpl 不会真正执行 */
function installFakeRunner(dir) {
  clearAllSubagents();
  resetSubagentRunner();
  setRunnerDepsForTesting({
    runSubagentImpl: async () => ({ status: 'completed', result: 'unused' }),
    settings: defaultSubagentSettings(),
    workspaceDir: dir,
    notify: async () => {},
    checkpoint: async () => {},
    registerAndClaimChild: () => {
      throw new Error('registerAndClaimChild 不应在本测试被调用');
    },
  });
}

async function makeClient(dir) {
  const store = new MyTerminalStore(join(dir, 'state'));
  const config = makeConfig(dir);
  const builtins = createBuiltinTools(config, store);
  const ext = new ExtensionService(config, store, builtins, () => {});
  const rootIdentity = store.registerRoot({ name: 'root', role: 'lead' }).identity;
  const server = createMcpServer(ext);
  const client = new Client({ name: 'issue-164-client', version: '1.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return { client, rootIdentity };
}

/** 经 MCP 直查 subagent_status 并解析返回 JSON（父代理视角，带会话身份）。
 *  toToolResult：content[0].text = summary 句；真数据嵌套在 structuredContent.data.result。 */
async function queryStatus(client, rootIdentity, taskId) {
  const res = await client.callTool({ name: 'subagent_status', arguments: { taskId, identity: rootIdentity } });
  assert.equal(res.isError, false, JSON.stringify(res));
  return res.structuredContent?.data?.result ?? res.structuredContent?.data;
}

/** 建 record + 转后台一条命令（真实链路：registerBackgroundTask + record.backgroundTasks 推入） */
async function spawnBackground(agentId, dir, command) {
  const cwd = join(dir, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const ctx = { cwd, signal: new AbortController().signal, agentId };
  const result = await getTool('execute_cli').call({ command, run_in_background: true }, ctx);
  assert.ok(result.backgroundId, `execute_cli 应返回 backgroundId（实返: ${JSON.stringify(result)}）`);
  return result;
}

// ── 用例 ──

test('s1 真实链路：转后台后 subagent_status 报 alive=true（backgroundId+pid 齐全）', async () => {
  const dir = tempDir();
  installFakeRunner(dir);
  const { client, rootIdentity } = await makeClient(dir);
  const rec = createSubagent('agent-164-s1', { subject: 'bg liveness s1' });

  const bg = await spawnBackground(rec.id, dir, 'sleep 3');
  const st = await queryStatus(client, rootIdentity, rec.id);

  assert.ok(Array.isArray(st.backgroundTasks), '返回体应含 backgroundTasks 数组');
  assert.strictEqual(st.backgroundTasks.length, 1, '应恰有一条后台任务');
  const [entry] = st.backgroundTasks;
  assert.strictEqual(entry.backgroundId, bg.backgroundId, 'backgroundId 应对上 execute_cli 返回值');
  assert.strictEqual(entry.alive, true, '命令在跑应报 alive=true');
  assert.strictEqual(typeof entry.pid, 'number', '应附 pid');
});

test('s2 命令退出后 alive=false（索引保留至收尸）', async () => {
  const dir = tempDir();
  installFakeRunner(dir);
  const { client, rootIdentity } = await makeClient(dir);
  const rec = createSubagent('agent-164-s2', { subject: 'bg liveness s2' });

  await spawnBackground(rec.id, dir, 'sleep 1');
  // 等命令退出（exit 事件 → exitCode 非 null）——有界轮询替代固定 sleep：
  // Windows runner 进程启动/杀毒扫描延迟显著（#176 CI 实测 1800ms 不够）
  let st;
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    st = await queryStatus(client, rootIdentity, rec.id);
    if (st.backgroundTasks.length === 1 && st.backgroundTasks[0].alive === false) break;
  }

  assert.strictEqual(st.backgroundTasks.length, 1, '收尸前索引条目应保留');
  assert.strictEqual(st.backgroundTasks[0].alive, false, '已退出应报 alive=false');
});

test('s3 无后台任务：backgroundTasks 键缺失', async () => {
  const dir = tempDir();
  installFakeRunner(dir);
  const { client, rootIdentity } = await makeClient(dir);
  const rec = createSubagent('agent-164-s3', { subject: 'bg liveness s3' });

  const st = await queryStatus(client, rootIdentity, rec.id);
  assert.ok(!('backgroundTasks' in st), '无后台任务不应出现 backgroundTasks 键');
});

test('s4 收尸后索引清空 → alive=false', async () => {
  const dir = tempDir();
  installFakeRunner(dir);
  const { client, rootIdentity } = await makeClient(dir);
  const rec = createSubagent('agent-164-s4', { subject: 'bg liveness s4' });

  await spawnBackground(rec.id, dir, 'sleep 5');
  cleanupAgentShellTasks(rec.id);
  const st = await queryStatus(client, rootIdentity, rec.id);

  assert.strictEqual(st.backgroundTasks[0].alive, false, '收尸清索引后应报 alive=false');
});
