// Issue #82（ADR-0037）— skill() 经 MCP 指令宣传但未注册为直接工具
//
// CP1（先证后修）：MCP server listTools() 必须含 `skill`，且 `skill()`
// 无参 / 有参经 direct 入口调用时，行为与 core-tools 的 builtin `skill` 一致
// （无参列清单、不存在的 name 返回 NOT_FOUND）。
//
// 修复前：skill 仅经 builtin → extension_call 暴露，direct 清单不含它，
//         直呼 skill() 报 unknown tool → 本测 listTools 断言失败（RED）。
// 修复后：mcp.ts registerDirect('skill', ...) 补齐注册 → GREEN。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer } from '../dist/mcp.js';
import { createBuiltinTools } from '../dist/core-tools.js';
import { ExtensionService } from '../dist/extensions.js';
import { MyTerminalStore } from '../dist/store.js';

function tempDir() {
  const dir = join(tmpdir(), 'issue-82-' + randomBytes(4).toString('hex'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  return dir;
}

function makeConfig(dir) {
  return {
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
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };
}

function setupExt(dir) {
  const store = new MyTerminalStore(join(dir, 'state'));
  const config = makeConfig(dir);
  const builtins = createBuiltinTools(config, store);
  const ext = new ExtensionService(config, store, builtins, () => {});
  const rootResult = store.registerRoot({ name: 'root', role: 'lead' });
  return { store, config, ext, rootIdentity: rootResult.identity };
}

// MCP SDK 把完整 ToolResponse 放在 structuredContent；退化时解析 content text
function body(result) {
  if (result.structuredContent) return result.structuredContent;
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return result;
  }
}

test('CP1: MCP listTools 含 skill，且 skill() direct 调用行为对齐 builtin', async () => {
  const dir = tempDir();
  const { ext, rootIdentity } = setupExt(dir);

  const server = createMcpServer(ext);
  const client = new Client({ name: 'issue-82-client', version: '1.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);

  // ① 发现：skill 必须在 direct 注册清单中
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('skill'), `MCP listTools 必须含 skill；实际前几个: ${names.slice(0, 8).join(',')}…（共 ${names.length}）`);

  // ② 无参调用 → 列清单（空目录返回 []），证明路由到 builtin 的 list 分支
  const listed = await client.callTool({ name: 'skill', arguments: { identity: rootIdentity } });
  assert.equal(listed.isError, false, `skill() 无参应成功: ${JSON.stringify(body(listed))}`);
  const listedBody = body(listed);
  assert.equal(listedBody.ok, true);
  assert.ok(Array.isArray(listedBody.data.result.skills), 'skill() 无参应返回 skills 数组');

  // ③ 有参但不存在 → NOT_FOUND，证明入参透传到 builtin
  const missing = await client.callTool({ name: 'skill', arguments: { name: 'does-not-exist', identity: rootIdentity } });
  assert.equal(missing.isError, true, `skill(name=不存在) 应报错: ${JSON.stringify(body(missing))}`);
  const missingBody = body(missing);
  assert.equal(missingBody.ok, false);
  assert.equal(missingBody.error?.code, 'NOT_FOUND', `应返回 NOT_FOUND，实际: ${JSON.stringify(missingBody)}`);

  await client.close();
});
