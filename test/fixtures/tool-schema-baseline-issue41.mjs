// issue #41 G4 锁定基线采集器
//
// 用途：把「重构前」两张事实快照固化成 JSON fixture，作为 tool schema 单源重构的锁定基线。
//   1. builtin-schemas —— createBuiltinTools() 产出的每个 builtin 的 inputSchema（运行时校验的唯一真相）
//   2. mcp-tools       —— 内存 MCP client 拉到的 tools/list 全量（客户端可见面）
//
// 重新生成：bun run build && bun test/fixtures/tool-schema-baseline-issue41.mjs <builtin|mcp>
// 正常情况下不应重新生成——fixture 变了就意味着行为变了，必须先说清楚为什么。
// 必须显式指定目标：mcp-tools-issue41.json 冻结于 main 基线供 #70 LOCK-6 对照，
// 顺手重生成会抹掉 allowlist 证据（详见文件末尾说明）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { createBuiltinTools } from '../../dist/core-tools.js';
import { MyTerminalStore } from '../../dist/store.js';
import { createMcpServer } from '../../dist/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const here = dirname(fileURLToPath(import.meta.url));

export function collectBuiltinSchemas() {
  const dir = join(tmpdir(), 'issue41-baseline-' + randomBytes(4).toString('hex'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  const config = {
    settingsPath: join(dir, 'config', 'settings.json'),
    workspaceDir: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    host: '127.0.0.1', port: 0,
    connectorKey: 'ck_baseline', actionsToken: 'at_baseline', publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 10000, commandTimeoutSec: 10,
    uiLanguage: 'en', uiTheme: 'dark',
    passiveLockEnabled: false, actionsContinuationMode: 'off', nonBlockingTasksEnabled: false,
  };
  const store = new MyTerminalStore(join(dir, 'state'));
  const builtins = createBuiltinTools(config, store);
  const out = {};
  for (const [name, tool] of builtins) {
    out[name] = { title: tool.title, description: tool.description, annotations: tool.annotations, aliases: tool.aliases, inputSchema: tool.inputSchema };
  }
  return out;
}

const inertFacade = {
  discover: async () => ({ ok: true }),
  register: async () => ({ ok: true }),
  call: async () => ({ ok: true }),
  mcpSessionClosed: () => {},
};

export async function collectMcpTools() {
  const server = createMcpServer(inertFacade);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'issue41-baseline', version: '1.0.0' }, { capabilities: {} });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const out = {};
    for (const tool of tools) {
      out[tool.name] = { title: tool.title, description: tool.description, annotations: tool.annotations, _meta: tool._meta, inputSchema: tool.inputSchema };
    }
    return out;
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

// ⚠️ mcp-tools-issue41.json 是**刻意冻结**在 main 基线形态的，不要顺手重生成。
//    #70 的 LOCK-6 用 INPUT_SCHEMA_ALLOWLIST 逐条登记了 19 处协议层 inputSchema
//    漂移，并带 stale 反向守卫。一旦重生成，那些差异会「消失」，allowlist 全体
//    失效 → LOCK-6 当场红，且 #70 的证据链被抹掉。
//
//    因此这里要求显式指定重生成哪一份，不再一次性覆盖两个文件（ADR-0034 施工时
//    差点因为默认重生成两份而误伤 mcp fixture）。
//
//    用法：
//      bun test/fixtures/tool-schema-baseline-issue41.mjs builtin
//      bun test/fixtures/tool-schema-baseline-issue41.mjs mcp     # 需要充分理由
if (import.meta.main) {
  const target = process.argv[2];
  if (target === 'builtin') {
    writeFileSync(join(here, 'builtin-schemas-issue41.json'), JSON.stringify(collectBuiltinSchemas(), null, 2) + '\n');
    console.log('builtin-schemas-issue41.json rewritten');
  } else if (target === 'mcp') {
    writeFileSync(join(here, 'mcp-tools-issue41.json'), JSON.stringify(await collectMcpTools(), null, 2) + '\n');
    console.log('mcp-tools-issue41.json rewritten —— 请确认 LOCK-6 的 allowlist 是否需要同步清理');
  } else {
    console.error('必须显式指定重生成目标：builtin | mcp');
    console.error('  mcp-tools-issue41.json 冻结于 main 基线，供 #70 LOCK-6 做 allowlist 对照，除非有充分理由否则不要重生成。');
    process.exit(1);
  }
}
