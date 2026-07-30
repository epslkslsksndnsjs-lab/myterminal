// ADR-0029 集成测试——MCP transport 身份绑定 + 会话生命周期闭环
// 覆盖四场景验收（issue #42 不可谈判项）：
//   1. 绑定   —— register/直连携带 identity 后，同 mcpSessionId 后续调用免重认证
//   2. 解绑   —— transport close 触发 unbind，再调即 IDENTITY_REQUIRED
//   3. 串号   —— session 释放后旧 mcpSessionId 被复用，不得继承旧身份
//   4. 崩溃重启 —— 内存表不落盘，新进程零僵尸绑定（主理人拍板方案）
//
// 变异体清单：
//   M1 call() 未对 mcp transport 绑定 identity            → 用例 1 杀
//   M2 mcpSessionClosed 未解绑                            → 用例 2 杀
//   M3 session 释放未清绑定导致串号                       → 用例 3 杀
//   M4 绑定落盘导致重启僵尸                               → 用例 4 杀

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { createBuiltinTools } from '../dist/core-tools.js';
import { ExtensionService } from '../dist/extensions.js';
import { MyTerminalStore } from '../dist/store.js';

// ── 测试辅助（参照 skill-v2-integration 脚手架，轻量直驱 ext.call）──

function tempDir() {
  const dir = join(tmpdir(), 'mcp-identity-' + randomBytes(4).toString('hex'));
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

const MCP_CTX = (mcpSessionId) => ({ transport: 'mcp', mcpSessionId });

// ═══════════════════════════════════════════════════════
// 用例 1：绑定（杀 M1）
// ═══════════════════════════════════════════════════════

test('01: MCP transport 绑定后同 mcpSessionId 免重认证（杀 M1）', async () => {
  const dir = tempDir();
  const { store, ext, rootIdentity } = setupExt(dir);
  const SID = 'mcp-session-bind-1';

  // 携带 identity 的首次 MCP 调用 → authenticate() 绑定 SID→root
  const first = await ext.call({ tool: 'session_list', identity: rootIdentity }, MCP_CTX(SID));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(store.hasMcpBinding(SID), true);
  assert.equal(store.resolveMcpBinding(SID)?.id, rootIdentity.sessionId);

  // 同 SID 后续调用不携带 identity → 经 resolveMcpBinding 解析，免重认证
  const second = await ext.call({ tool: 'session_list' }, MCP_CTX(SID));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.error, undefined);
});

// ═══════════════════════════════════════════════════════
// 用例 2：解绑（杀 M2）
// ═══════════════════════════════════════════════════════

test('02: transport close 解绑后同 mcpSessionId 再调即 IDENTITY_REQUIRED（杀 M2）', async () => {
  const dir = tempDir();
  const { store, ext, rootIdentity } = setupExt(dir);
  const SID = 'mcp-session-unbind-1';

  const first = await ext.call({ tool: 'session_list', identity: rootIdentity }, MCP_CTX(SID));
  assert.equal(first.ok, true);
  assert.equal(store.hasMcpBinding(SID), true);

  // 模拟 MCP transport close（mcp.ts onsessionclosed / onclose / close 均走此路径）
  ext.mcpSessionClosed(SID);
  assert.equal(store.hasMcpBinding(SID), false);

  const after = await ext.call({ tool: 'session_list' }, MCP_CTX(SID));
  assert.equal(after.ok, false);
  assert.equal(after.error?.code, 'IDENTITY_REQUIRED');
});

// ═══════════════════════════════════════════════════════
// 用例 3：串号防护（杀 M3）
// ═══════════════════════════════════════════════════════

test('03: session 释放后旧 mcpSessionId 被复用不得继承旧身份（杀 M3）', async () => {
  const dir = tempDir();
  const { store, ext, rootIdentity } = setupExt(dir);
  const SID = 'mcp-session-hijack-1';

  // A 绑定 SID
  const bindA = await ext.call({ tool: 'session_list', identity: rootIdentity }, MCP_CTX(SID));
  assert.equal(bindA.ok, true);
  assert.equal(store.resolveMcpBinding(SID)?.id, rootIdentity.sessionId);

  // 第二个独立 session B（用于验证"合法重绑"与"非法继承"的边界）
  const B = store.registerRoot({ name: 'worker', role: 'worker' });
  assert.notEqual(B.identity.sessionId, rootIdentity.sessionId);

  // A 的 controller 释放/回收 → unbindMcpForSession 清掉 SID 绑定
  store.unbindMcpForSession(rootIdentity.sessionId);
  assert.equal(store.hasMcpBinding(SID), false);

  // 关键安全属性：复用旧 SID 但不出示身份 → 必须 IDENTITY_REQUIRED，不得继承 A
  const hijack = await ext.call({ tool: 'session_list' }, MCP_CTX(SID));
  assert.equal(hijack.ok, false);
  assert.equal(hijack.error?.code, 'IDENTITY_REQUIRED');

  // 合法路径：B 显式出示身份重绑 SID → 绑定指向 B，而非 A
  const rebind = await ext.call({ tool: 'session_list', identity: B.identity }, MCP_CTX(SID));
  assert.equal(rebind.ok, true, JSON.stringify(rebind));
  assert.equal(store.resolveMcpBinding(SID)?.id, B.identity.sessionId);
  assert.notEqual(store.resolveMcpBinding(SID)?.id, rootIdentity.sessionId);
});

// ═══════════════════════════════════════════════════════
// 用例 4：崩溃重启零僵尸（杀 M4）—— 内存表不落盘
// ═══════════════════════════════════════════════════════

test('04: 进程重启后 mcp 绑定表为空（内存表不落盘，杀 M4）', async () => {
  const dir = tempDir();
  const { store: store1, ext: ext1, rootIdentity } = setupExt(dir);
  const SID = 'mcp-session-restart-1';

  const first = await ext1.call({ tool: 'session_list', identity: rootIdentity }, MCP_CTX(SID));
  assert.equal(first.ok, true);
  assert.equal(store1.hasMcpBinding(SID), true, '进程1 应有绑定');

  // 模拟进程崩溃/kill -9：新建一个全新 Store（全新内存 mcpBindings），state 目录复用同一磁盘位置
  const store2 = new MyTerminalStore(join(dir, 'state'));
  const config2 = makeConfig(dir);
  const builtins2 = createBuiltinTools(config2, store2);
  const ext2 = new ExtensionService(config2, store2, builtins2, () => {});

  // 新进程从空表起步 → 无僵尸绑定（若落地持久化，此处会读到 store1 的绑定）
  assert.equal(store2.hasMcpBinding(SID), false, '重启后不应残留僵尸绑定');
  assert.equal(store2.resolveMcpBinding(SID), undefined);

  // 新进程对旧 SID 调用必须重新认证
  const orphan = await ext2.call({ tool: 'session_list' }, MCP_CTX(SID));
  assert.equal(orphan.ok, false);
  assert.equal(orphan.error?.code, 'IDENTITY_REQUIRED');
});
