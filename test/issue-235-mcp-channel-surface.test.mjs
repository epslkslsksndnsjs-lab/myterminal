// Workflows T12（#235）· MCP/Apps 通道面 —— 对外契约锁
//
// 锁的是"对外那一份文本与形状"（ADR-0052 §23②）。三份模型可见面各说各话：
//   ① core-tools 的 canonical 描述 ↔ GPT_INSTRUCTIONS 段（同文锁，归 #234）
//   ② mcp.ts 的对外描述（本文件锁）—— 面向 Apps/MCP 审核独立撰写，刻意不是 ① 的副本
//   ③ 技能文本（第三份，归 #234）
// 防漂移矩阵三分的含义是：任何一份被改成另一份的样子，本文件就该红。
//
// 分区：
//   CHANNEL-1 instructions 行：唯一、逐字、紧随 skill 行且落在末尾
//   CHANNEL-2 direct 清单两条就位：title 与 description 逐字定稿
//   CHANNEL-3 三份互不同文：对外文本与内部 canonical 互不为子串
//   CHANNEL-4 inputSchema 自动派生：属性集与约束由 BUILTIN_INPUT_SCHEMAS 供给，且在协议层真生效
//   CHANNEL-5 extraShape 仅 identity：传输层不加 workflow 专属键
//   CHANNEL-6 _meta 按 title 自动
//   CHANNEL-7 注解集镜像 subagent_abort
//   CHANNEL-8 instructions 行不复用工具描述（每面自己那一句话）

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
import { BUILTIN_INPUT_SCHEMAS } from '../dist/tool-schemas.js';

// ── 定稿文案（ADR-0052 §23② 逐字；本文件是它的锁，不是它的出处）──
const INSTRUCTIONS_WORKFLOW_LINE =
  'Workflows: start a run only when the user asks — load the workflow-authoring skill, call workflow_start, then start a reducer with subagent_start(reduce) and poll it for the final summary; workflow_cancel stops a whole run (idempotent). Runs continue locally after this conversation ends.';
const OUTWARD_DESCRIPTIONS = {
  workflow_start: {
    title: 'Start Workflow',
    description: 'Start a multi-agent workflow run from a script. Asynchronous: returns a runId immediately and runs locally in the background. Start a reducer subagent right after; poll the reducer for the final summary — long runs do not depend on this conversation staying open.',
  },
  workflow_cancel: {
    title: 'Cancel Workflow',
    description: 'Cancel a whole workflow run and stop its local agents. Idempotent — a terminal run returns its current status. The reducer still reports what finished.',
  },
};
const SKILL_LINE = 'Use skill() to list available skills, skill(name) to run one.';
const HINTS = ['readOnlyHint', 'destructiveHint', 'openWorldHint', 'idempotentHint'];

function tempDir() {
  const dir = join(tmpdir(), 'issue-235-' + randomBytes(4).toString('hex'));
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

/** 起一台真 MCP server（挂真 ExtensionService），拉 tools/list 与 instructions。 */
async function mcpFace() {
  const dir = tempDir();
  const config = makeConfig(dir);
  const store = new MyTerminalStore(join(dir, 'state'));
  const builtins = createBuiltinTools(config, store);
  const ext = new ExtensionService(config, store, builtins, () => {});
  const server = createMcpServer(ext);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'issue-235', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const instructions = String(client.getInstructions() ?? '');
  return {
    client,
    server,
    builtins,
    byName,
    names: tools.map((t) => t.name),
    instructions,
    instructionLines: instructions.split('\n'),
  };
}

// ═══════════════════════════════════════════════════════════════
// CHANNEL-1 · server instructions 数组那一条
// ═══════════════════════════════════════════════════════════════

test('CHANNEL-1a: instructions 有且只有一条 Workflows 行，逐字定稿', async () => {
  const face = await mcpFace();
  try {
    const hits = face.instructionLines.filter((l) => l.includes('Workflows:'));
    assert.equal(hits.length, 1, `Workflows 行必须恰好一条，实际 ${hits.length} 条：\n${hits.join('\n')}`);
    assert.equal(hits[0], INSTRUCTIONS_WORKFLOW_LINE, 'Workflows 行与定稿文案逐字之差即红');
  } finally {
    await face.client.close(); await face.server.close();
  }
});

test('CHANNEL-1b: Workflows 行紧随 skill 行，且落在数组末尾', async () => {
  const face = await mcpFace();
  try {
    const skillAt = face.instructionLines.indexOf(SKILL_LINE);
    assert.ok(skillAt >= 0, 'skill 行是本条的锚，锚不在说明 instructions 数组被动过');
    assert.equal(face.instructionLines[skillAt + 1], INSTRUCTIONS_WORKFLOW_LINE, '必须紧随 skill 行');
    assert.equal(skillAt + 1, face.instructionLines.length - 1, '必须落在末尾（数组尾部追加一条）');
  } finally {
    await face.client.close(); await face.server.close();
  }
});

test('CHANNEL-1c: skill 行本身不被改写（新增是追加不是替换）', async () => {
  const face = await mcpFace();
  try {
    assert.ok(face.instructionLines.includes(SKILL_LINE), 'skill 行原文必须在');
    // 既有的两条老行同样要在：防止"加一条"被写成"改几条"
    assert.ok(face.instructionLines.some((l) => l.startsWith('MyTerminal sessions are auditable work contexts')), '首行锚');
    assert.ok(face.instructionLines.some((l) => l.startsWith('Apps exposes both the full extension_call')), '直连/门面双可达那句');
  } finally {
    await face.client.close(); await face.server.close();
  }
});

// ═══════════════════════════════════════════════════════════════
// CHANNEL-2 · direct 清单两条就位
// ═══════════════════════════════════════════════════════════════

test('CHANNEL-2: workflow_start / workflow_cancel 在 direct 清单，title 与 description 逐字定稿', async () => {
  const face = await mcpFace();
  try {
    for (const [name, pinned] of Object.entries(OUTWARD_DESCRIPTIONS)) {
      assert.ok(face.names.includes(name), `${name} 必须在 MCP direct 清单中`);
      assert.equal(face.byName[name].title, pinned.title, `${name} title 漂移`);
      assert.equal(face.byName[name].description, pinned.description, `${name} 对外描述漂移`);
    }
  } finally {
    await face.client.close(); await face.server.close();
  }
});

// ═══════════════════════════════════════════════════════════════
// CHANNEL-3 · 防漂移矩阵三分（对外 ≠ 内部）
// ═══════════════════════════════════════════════════════════════

test('CHANNEL-3: 对外文本独立成文 —— 与 core canonical 互不为子串、非逐字同文', async () => {
  const face = await mcpFace();
  try {
    for (const name of Object.keys(OUTWARD_DESCRIPTIONS)) {
      const internal = face.builtins.get(name)?.description;
      assert.ok(internal, `${name} 的内部 canonical 必须存在`);
      const outward = face.byName[name].description;
      assert.notEqual(outward, internal.trim(), `${name}：对外版与内部版逐字同文 = 矩阵三分破防`);
      assert.ok(!outward.includes(internal.trim().slice(0, 60)), `${name}：对外版以内部版开头 = 跨份同文`);
      assert.ok(!internal.includes(outward.slice(0, 60)), `${name}：内部版含对外版长段 = 反向同文`);
      // 两份必须仍谈同一件事：说不同的话，但都指着同一个 run
      for (const token of ['workflow', 'run']) {
        assert.ok(outward.toLowerCase().includes(token), `${name} 对外版丢了 "${token}"`);
        assert.ok(internal.toLowerCase().includes(token), `${name} 内部版丢了 "${token}"`);
      }
    }
  } finally {
    await face.client.close(); await face.server.close();
  }
});

test('CHANNEL-3b: 共享常量只有技能名 —— 指令行引用的技能名不得被改写', async () => {
  const face = await mcpFace();
  try {
    const line = face.instructionLines.find((l) => l.includes('Workflows:'));
    assert.ok(line.includes('workflow-authoring'), 'instructions 行必须点名 workflow-authoring 技能');
    assert.ok(!/workflow[- ]author/i.test(line.replace('workflow-authoring', '')), '不得出现第二种拼写');
  } finally {
    await face.client.close(); await face.server.close();
  }
});

// ═══════════════════════════════════════════════════════════════
// CHANNEL-4 · inputSchema 自动派生（不另写副本）
// ═══════════════════════════════════════════════════════════════

test('CHANNEL-4a: 对外属性集 = 单源表的属性集 ∪ identity', async () => {
  const face = await mcpFace();
  try {
    for (const name of Object.keys(OUTWARD_DESCRIPTIONS)) {
      const table = BUILTIN_INPUT_SCHEMAS[name];
      assert.ok(table, `${name} 必须先进 BUILTIN_INPUT_SCHEMAS 才能派生`);
      const derived = Object.keys(table.properties).sort();
      const outward = Object.keys(face.byName[name].inputSchema.properties).sort();
      assert.deepEqual(outward, [...derived, 'identity'].sort(), `${name}：对外面属性与表不一致（另写副本即红）`);
    }
  } finally {
    await face.client.close(); await face.server.close();
  }
});

test('CHANNEL-4b: 表里的字符串约束在对外面逐项存活', async () => {
  const face = await mcpFace();
  try {
    const KEYS = ['minLength', 'maxLength'];
    for (const name of Object.keys(OUTWARD_DESCRIPTIONS)) {
      for (const [prop, spec] of Object.entries(BUILTIN_INPUT_SCHEMAS[name].properties)) {
        if (typeof spec !== 'object' || spec.type !== 'string') continue;
        for (const key of KEYS) {
          if (spec[key] === undefined) continue;
          assert.equal(
            face.byName[name].inputSchema.properties[prop]?.[key],
            spec[key],
            `${name}.${prop}.${key}：表里是 ${spec[key]}，对外面没跟上`,
          );
        }
      }
    }
  } finally {
    await face.client.close(); await face.server.close();
  }
});

test('CHANNEL-4c: 派生出来的约束在协议层真拦（不是摆着好看）', async () => {
  const face = await mcpFace();
  try {
    // workflow_cancel.runId：minLength 4 / maxLength 128 / required
    for (const [label, args] of [
      ['缺 runId', {}],
      ['runId 过短', { runId: 'x' }],
      ['runId 过长', { runId: 'w'.repeat(200) }],
    ]) {
      const r = await face.client.callTool({ name: 'workflow_cancel', arguments: args });
      assert.equal(r.isError, true, `workflow_cancel ${label} 应被拒`);
    }
    // workflow_start.script：maxLength 200000
    const over = await face.client.callTool({ name: 'workflow_start', arguments: { script: 'a'.repeat(200001) } });
    assert.equal(over.isError, true, 'workflow_start 超 maxLength 应被协议层拒');
  } finally {
    await face.client.close(); await face.server.close();
  }
});

// ═══════════════════════════════════════════════════════════════
// CHANNEL-5 / 6 / 7 · 形状、_meta、注解
// ═══════════════════════════════════════════════════════════════

test('CHANNEL-5: extraShape 仅 identity —— 传输层不给 workflow 工具加专属键', async () => {
  const face = await mcpFace();
  try {
    for (const name of Object.keys(OUTWARD_DESCRIPTIONS)) {
      const extra = Object.keys(face.byName[name].inputSchema.properties)
        .filter((p) => !(p in BUILTIN_INPUT_SCHEMAS[name].properties));
      assert.deepEqual(extra, ['identity'], `${name}：除 identity 外不得有传输层专属键，实际 ${extra.join(',')}`);
    }
  } finally {
    await face.client.close(); await face.server.close();
  }
});

test('CHANNEL-6: _meta invoking / invoked 按 title 自动，不另写一份', async () => {
  const face = await mcpFace();
  try {
    for (const [name, pinned] of Object.entries(OUTWARD_DESCRIPTIONS)) {
      const meta = face.byName[name]._meta ?? {};
      assert.equal(meta['openai/toolInvocation/invoking'], `Running ${pinned.title}…`, `${name} invoking 非按 title 生成`);
      assert.equal(meta['openai/toolInvocation/invoked'], `${pinned.title} ready`, `${name} invoked 非按 title 生成`);
    }
  } finally {
    await face.client.close(); await face.server.close();
  }
});

// 上一例只锁住两个 workflow 工具的值；把同一算式当预期写出来，手写死值也可能凑对。
// 这一例锁机制：凡走 direct 注册的工具，_meta 必须是 title 的纯函数——任何工具单独特化一份，即红。
test('CHANNEL-6b: 整张 direct 名单的 _meta 都是 title 的纯函数（机制而非取值）', async () => {
  const face = await mcpFace();
  try {
    // 三个门面工具是 registerTool 直写的，不吃 registerDirect 的 title 算式，列名除外。
    const FACADE = new Set(['extension_discover', 'extension_register', 'extension_call']);
    const direct = Object.keys(face.byName).filter((n) => !FACADE.has(n));
    assert.ok(direct.length >= 30, `direct 名单异常收缩（只剩 ${direct.length} 个），本例失去意义`);
    assert.ok(direct.includes('workflow_start') && direct.includes('workflow_cancel'), '两个 workflow 工具必须在名单内');
    for (const name of direct) {
      const { title, _meta } = face.byName[name];
      const meta = _meta ?? {};
      assert.equal(
        meta['openai/toolInvocation/invoking'],
        `Running ${title}…`,
        `${name}：invoking 不再由 title 派生（有人给它单写了一份文案）`,
      );
      assert.equal(
        meta['openai/toolInvocation/invoked'],
        `${title} ready`,
        `${name}：invoked 不再由 title 派生`,
      );
    }
  } finally {
    await face.client.close(); await face.server.close();
  }
});

test('CHANNEL-7: 注解集镜像 subagent_abort（幂等语义只在描述里声明）', async () => {
  const face = await mcpFace();
  try {
    const abort = face.byName['subagent_abort'].annotations;
    for (const name of Object.keys(OUTWARD_DESCRIPTIONS)) {
      const got = face.byName[name].annotations;
      assert.equal(
        JSON.stringify(pick(got, HINTS)),
        JSON.stringify(pick(abort, HINTS)),
        `${name} 注解集与 subagent_abort 先例不一致`,
      );
    }
    // 幂等在描述里说了、但没被写成 idempotentHint 约束（§19 括注不采纳）
    assert.equal(face.byName['workflow_cancel'].annotations.idempotentHint, false);
    assert.match(face.byName['workflow_cancel'].description, /Idempotent/);
  } finally {
    await face.client.close(); await face.server.close();
  }
});

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

// ═══════════════════════════════════════════════════════════════
// CHANNEL-8 · 两份对外文本互不同文
// ═══════════════════════════════════════════════════════════════

test('CHANNEL-8: instructions 行不复用工具描述原文', async () => {
  const face = await mcpFace();
  try {
    for (const { description } of Object.values(OUTWARD_DESCRIPTIONS)) {
      const head = description.slice(0, 60);
      assert.ok(!INSTRUCTIONS_WORKFLOW_LINE.includes(head), '指令行是短指针，不是工具描述的拼接');
    }
    // 三个面各说各话：workflow_start 的对外描述 ≠ 指令行 ≠ 内部描述
    assert.notEqual(face.byName['workflow_start'].description, INSTRUCTIONS_WORKFLOW_LINE);
  } finally {
    await face.client.close(); await face.server.close();
  }
});
