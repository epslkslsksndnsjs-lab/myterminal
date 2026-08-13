// issue #41 —— tool schema 单源：契约测试（双向）+ G4 锁定测试
//
// 决策块要求：
//   · G4 先锁定 → 再动 → 再跑测试（锁定测试先绿锁现状，重构后快照 diff 为零）
//   · 契约测试必须双向：① 逐工具 diff JSON Schema ↔ zod 一致
//                       ② 负向用例：非法输入必须被拒
//   · 派生器遇不支持关键字禁止静默回退 z.any()/passthrough
//
// 分区：
//   [LOCK]     重构前后都必须绿的锁定不变量（源 schema / MCP 展示层 / 参数转发）
//   [CONTRACT] 派生正确性：源 JSON Schema ↔ 派生 zod 双向一致
//   [NEGATIVE] 负向：非法输入必须被拒；派生器遇不支持关键字必须抛
//
// 变异体清单：
//   M1  搬运 schema 时抄错一个约束            → LOCK-1 杀
//   M2  MCP 侧 title/description/annotations 被派生覆盖 → LOCK-2/3 杀
//   M3  default 被实现成 zod .default()（运行期注入）   → LOCK-4 杀
//   M4  漏掉 cluster 路由字段 workspaceId               → LOCK-5 杀
//   M5  派生器丢约束（minLength/maxItems/enum/required）→ CONTRACT-1 + NEGATIVE-1 杀
//   M6  派生器对不支持关键字静默回退 z.any()/passthrough → NEGATIVE-2 杀
//   M7  派生必须 strip（未知字段静默通，匹配 main 基线）；误 strict 化拒绝未知字段属行为回归

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectBuiltinSchemas, collectMcpTools } from './fixtures/tool-schema-baseline-issue41.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const readFixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const BUILTIN_BASELINE = readFixture('builtin-schemas-issue41.json');
const MCP_BASELINE = readFixture('mcp-tools-issue41.json');

const FACADE_TOOLS = new Set(['extension_discover', 'extension_register', 'extension_call']);

// ─────────────────────────────────────────────────────────────────────────────
// [LOCK] 重构前后都必须绿
// ─────────────────────────────────────────────────────────────────────────────

test('[LOCK-1] builtin inputSchema 全量与基线逐字一致（搬运不得改一个字符）', () => {
  const actual = collectBuiltinSchemas();
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(BUILTIN_BASELINE).sort(), 'builtin 工具集合变了');
  for (const name of Object.keys(BUILTIN_BASELINE)) {
    assert.deepEqual(actual[name].inputSchema, BUILTIN_BASELINE[name].inputSchema, `${name}.inputSchema 与基线不一致`);
    assert.deepEqual(actual[name].annotations, BUILTIN_BASELINE[name].annotations, `${name}.annotations 与基线不一致`);
    assert.equal(actual[name].title, BUILTIN_BASELINE[name].title, `${name}.title 与基线不一致`);
    assert.equal(actual[name].description, BUILTIN_BASELINE[name].description, `${name}.description 与基线不一致`);
    assert.deepEqual(actual[name].aliases, BUILTIN_BASELINE[name].aliases, `${name}.aliases 与基线不一致`);
  }
});

test('[LOCK-2] MCP 暴露的工具集合不变', async () => {
  const actual = await collectMcpTools();
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(MCP_BASELINE).sort());
});

test('[LOCK-3] MCP 展示层（title / description / annotations / _meta）逐字不变', async () => {
  const actual = await collectMcpTools();
  for (const name of Object.keys(MCP_BASELINE)) {
    assert.equal(actual[name].title, MCP_BASELINE[name].title, `${name}.title 变了`);
    assert.equal(actual[name].description, MCP_BASELINE[name].description, `${name}.description 变了`);
    assert.deepEqual(actual[name].annotations, MCP_BASELINE[name].annotations, `${name}.annotations 变了`);
    assert.deepEqual(actual[name]._meta, MCP_BASELINE[name]._meta, `${name}._meta 变了`);
  }
});

test('[LOCK-4] direct tool 调用转发的 input 逐字等于客户端所传（default 不得在 MCP 层注入）', async () => {
  const { createMcpServer } = await import('../dist/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  const calls = [];
  const facade = {
    discover: async () => ({ ok: true }),
    register: async () => ({ ok: true }),
    call: async (input) => { calls.push(structuredClone(input)); return { ok: true, data: {} }; },
    mcpSessionClosed: () => {},
  };
  const server = createMcpServer(facade);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lock4', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    // list_dir.path 在源 schema 里有 default '.'——不得被 MCP 层填充进转发参数
    await client.callTool({ name: 'list_dir', arguments: {} });
    assert.deepEqual(calls.at(-1), { tool: 'list_dir', input: {} }, 'list_dir 空参转发被污染');

    // search_text.regex(default false) / path(default '.') / limit 同理
    await client.callTool({ name: 'search_text', arguments: { query: 'x' } });
    assert.deepEqual(calls.at(-1), { tool: 'search_text', input: { query: 'x' } }, 'search_text 转发被污染');

    // message_inbox 三个字段全带 default
    await client.callTool({ name: 'message_inbox', arguments: {} });
    assert.deepEqual(calls.at(-1), { tool: 'message_inbox', input: {} }, 'message_inbox 转发被污染');

    // identity 被剥离出 input，单独放顶层
    await client.callTool({ name: 'session_list', arguments: { identity: { sessionId: 's1', sessionToken: 't1' } } });
    assert.deepEqual(calls.at(-1), { tool: 'session_list', input: {}, identity: { sessionId: 's1', sessionToken: 't1' } });
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test('[LOCK-5] session_register 保留 cluster 路由字段 workspaceId', async () => {
  const actual = await collectMcpTools();
  const props = actual.session_register.inputSchema.properties;
  assert.ok(props.workspaceId, 'workspaceId 丢失 —— cluster-router 的多工作区 root 注册会瞎');
  assert.equal(props.workspaceId.type, 'string');
});

// ─────────────────────────────────────────────────────────────────────────────
// [CONTRACT] ① 逐工具 diff：源 JSON Schema ↔ MCP 暴露的 zod 派生结果
// ─────────────────────────────────────────────────────────────────────────────

/** zod4 的 integer 会附带 safe-int 边界；源 schema 未声明时归一化掉，避免把工具产物当成漂移。 */
const SAFE_INT = 9007199254740991;
function normalize(node, source) {
  if (!node || typeof node !== 'object') return node;
  const out = Array.isArray(node) ? node.map((item, i) => normalize(item, Array.isArray(source) ? source?.[i] : undefined)) : { ...node };
  if (Array.isArray(node)) return out;
  delete out.$schema;
  if (node.type === 'integer') {
    if (out.maximum === SAFE_INT && source?.maximum === undefined) delete out.maximum;
    if (out.minimum === -SAFE_INT && source?.minimum === undefined) delete out.minimum;
  }
  if (node.type === 'object') {
    if (source?.additionalProperties === true && source?.properties === undefined) {
      // 开放 record：源写 additionalProperties:true，z.record 往返输出
      // { propertyNames:{type:'string'}, additionalProperties:{} }——语义等价，归一化回源形态。
      if (out.propertyNames && out.propertyNames.type === 'string' && Object.keys(out.propertyNames).length === 1) delete out.propertyNames;
      if (typeof out.additionalProperties === 'object' && Object.keys(out.additionalProperties).length === 0) out.additionalProperties = true;
    } else {
      // strip 模式（匹配 main 基线 raw-shape 注册）：未知字段在到达 invokeTool 前被静默丢弃，
      // 运行期不强制 additionalProperties:false。往返测试不应要求 derived 保留它，
      // 否则会把「恢复 strip 以匹配 main」误判成漂移。
      delete out.additionalProperties;
    }
  }
  if (out.properties) {
    const props = {};
    for (const [k, v] of Object.entries(out.properties)) props[k] = normalize(v, source?.properties?.[k]);
    out.properties = props;
  }
  if (out.items) out.items = normalize(out.items, source?.items);
  if (out.required) out.required = [...out.required].sort();
  return out;
}

/** MCP 侧只在传输层附加 identity；session_register 另有 cluster 路由字段 workspaceId。 */
const TRANSPORT_ONLY_PROPERTIES = { '*': ['identity'], session_register: ['identity', 'workspaceId'] };

test('[CONTRACT-1] 30 个 direct tool 的 MCP inputSchema 与源 JSON Schema 逐字段一致', async () => {
  const mcp = await collectMcpTools();
  const builtins = collectBuiltinSchemas();
  const { BUILTIN_INPUT_SCHEMAS } = await import('../dist/tool-schemas.js');

  let checked = 0;
  for (const [name, tool] of Object.entries(mcp)) {
    if (FACADE_TOOLS.has(name)) continue;
    const source = BUILTIN_INPUT_SCHEMAS[name];
    assert.ok(source, `${name} 在 BUILTIN_INPUT_SCHEMAS 里没有源 schema`);

    // 源单源必须与运行时校验用的 schema 是同一份（task_poll 不是 builtin，跳过这一步）
    if (builtins[name]) assert.equal(builtins[name].inputSchema, source, `${name} 运行时 schema 不是从单源取的（引用不同一）`);

    const allowedExtra = TRANSPORT_ONLY_PROPERTIES[name] ?? TRANSPORT_ONLY_PROPERTIES['*'];
    const actualProps = { ...(tool.inputSchema.properties ?? {}) };
    for (const key of allowedExtra) delete actualProps[key];
    const actualRequired = (tool.inputSchema.required ?? []).filter((key) => !allowedExtra.includes(key));

    const expectedProps = source.properties ?? {};
    assert.deepEqual(Object.keys(actualProps).sort(), Object.keys(expectedProps).sort(), `${name} 属性集合不一致`);
    for (const key of Object.keys(expectedProps)) {
      assert.deepEqual(normalize(actualProps[key], expectedProps[key]), normalize(expectedProps[key], expectedProps[key]), `${name}.${key} 约束不一致`);
    }
    assert.deepEqual(actualRequired.sort(), [...(source.required ?? [])].sort(), `${name} required 不一致`);
    // strip 模式匹配 main 基线：顶层对象不 strict 收口（未知字段被静默吞掉而非协议拒绝）。
    assert.notEqual(tool.inputSchema.additionalProperties, false, `${name} 顶层不应 strict 收口——strip 以匹配 main 基线`);
    checked += 1;
  }
  assert.equal(checked, 30, `direct tool 数量应为 30（#82 新增 skill direct 入口），实际 ${checked}`);
});

test('[CONTRACT-2] 派生器对源 schema 的往返：jsonSchemaToZod → toJSONSchema 等价于源', async () => {
  const { jsonSchemaToZod } = await import('../dist/mcp-schema.js');
  const { BUILTIN_INPUT_SCHEMAS } = await import('../dist/tool-schemas.js');
  const { z } = await import('zod');

  for (const [name, source] of Object.entries(BUILTIN_INPUT_SCHEMAS)) {
    const derived = z.toJSONSchema(jsonSchemaToZod(source, name), { io: 'input' });
    assert.deepEqual(normalize(derived, source), normalize(structuredClone(source), source), `${name} 往返不等价`);
  }
});

test('[CONTRACT-3] task_poll 的 schema 与 extension_discover 目录里公布的是同一份', async () => {
  const { BUILTIN_INPUT_SCHEMAS } = await import('../dist/tool-schemas.js');
  const { TASK_POLL_TOOL } = await import('../dist/tool-schemas.js');
  assert.equal(TASK_POLL_TOOL.inputSchema, BUILTIN_INPUT_SCHEMAS.task_poll, 'task_poll schema 未同源');
});

test('[CONTRACT-4] #04：subagent_start 契约不再含 provider/model 键（全局配置是唯一模型真相源）', async () => {
  const { BUILTIN_INPUT_SCHEMAS } = await import('../dist/tool-schemas.js');
  const props = BUILTIN_INPUT_SCHEMAS.subagent_start.properties ?? {};
  assert.ok(!('provider' in props), 'subagent_start 不应再暴露 provider 键');
  assert.ok(!('model' in props), 'subagent_start 不应再暴露 model 键');

  // OpenAPI 共享属性池同步移除
  const { buildOpenApi } = await import('../dist/openapi.js');
  const toolInput = buildOpenApi({ publicBaseUrl: 'http://127.0.0.1:0' }).components.schemas.ExtensionToolInput;
  const tprops = toolInput.properties ?? {};
  assert.ok(!('provider' in tprops), 'OpenAPI toolInput 不应再含 provider');
  assert.ok(!('model' in tprops), 'OpenAPI toolInput 不应再含 model');
});

// ─────────────────────────────────────────────────────────────────────────────
// [NEGATIVE] ② 非法输入必须被拒；派生器不得静默放行
// ─────────────────────────────────────────────────────────────────────────────

test('[NEGATIVE-1] 派生出来的 zod 必须拒绝非法输入（枚举/长度/边界/缺必填/类型）', async () => {
  const { jsonSchemaToZod } = await import('../dist/mcp-schema.js');
  const { BUILTIN_INPUT_SCHEMAS } = await import('../dist/tool-schemas.js');
  const of = (name) => jsonSchemaToZod(BUILTIN_INPUT_SCHEMAS[name], name);

  const rejects = [
    ['缺必填 query', of('find_files'), {}],
    ['类型错 query', of('find_files'), { query: 42 }],
    ['枚举越界 encoding', of('blob_create'), { content: 'x', encoding: 'utf-16' }],
    ['枚举越界 mode', of('session_register'), { mode: 'sideways', name: 'n' }],
    ['枚举越界 phase', of('session_checkpoint'), { phase: 'napping', summary: 's' }],
    ['minLength 违例 query', of('search_text'), { query: '' }],
    ['maxLength 违例 objective', of('subagent_start'), { objective: 'x'.repeat(4001) }],
    ['minimum 违例 limit', of('session_history'), { limit: 0 }],
    ['maximum 违例 limit', of('session_history'), { limit: 501 }],
    ['非整数 limit', of('session_history'), { limit: 1.5 }],
    ['maxItems 违例 deliverables', of('subagent_start'), { objective: 'o', deliverables: Array.from({ length: 21 }, () => 'd') }],
    ['minItems 违例 eventIds', of('session_events_ack'), { eventIds: [] }],
    ['数组元素类型错', of('session_events_ack'), { eventIds: [1] }],
    ['嵌套对象缺必填', of('session_register'), { mode: 'delegate', name: 'n', task: { objective: 'o' } }],
    ['sha256 长度违例', of('blob_read'), { sha256: 'abc' }],
  ];
  for (const [label, schema, value] of rejects) {
    assert.equal(schema.safeParse(value).success, false, `本应被拒却放行了：${label}`);
  }

  // 正向对照：合法输入必须通过，避免"全拒"式假绿
  const accepts = [
    [of('find_files'), { query: 'a' }],
    [of('workspace_info'), {}],
    [of('blob_create'), { content: 'x', encoding: 'base64' }],
    [of('session_history'), { offset: 0, limit: 500, includeAncestors: false }],
    [of('subagent_start'), { objective: 'o', maxTurns: 3 }],
    [of('session_register'), { mode: 'delegate', name: 'n', task: { objective: 'o', background: 'b', deliverables: ['d'], acceptanceCriteria: ['a'], constraints: ['c'] } }],
    // strip 模式（匹配 main 基线）：未知字段被静默接受，不拒绝
    [of('find_files'), { query: 'a', nope: 1 }],
    [of('session_register'), { mode: 'delegate', name: 'n', task: { objective: 'o', background: 'b', deliverables: ['d'], acceptanceCriteria: ['a'], constraints: ['c'], sneaky: true } }],
  ];
  for (const [schema, value] of accepts) {
    const result = schema.safeParse(value);
    assert.equal(result.success, true, `本应通过却被拒：${JSON.stringify(value)} → ${JSON.stringify(result.error?.issues)}`);
  }
});

test('[NEGATIVE-2] 派生器遇到不支持的关键字必须抛错，禁止静默回退 z.any()/passthrough', async () => {
  const { jsonSchemaToZod, UnsupportedSchemaError } = await import('../dist/mcp-schema.js');
  const bad = [
    ['缺 type', {}],
    ['未知 type', { type: 'tuple' }],
    ['null type', { type: 'null' }],
    ['未知关键字 pattern', { type: 'string', pattern: '^a$' }],
    ['未知关键字 oneOf', { type: 'object', properties: {}, additionalProperties: false, oneOf: [] }],
    ['未知关键字 $ref', { type: 'object', properties: {}, additionalProperties: false, $ref: '#/x' }],
    ['array 缺 items', { type: 'array' }],
    ['object 缺 properties', { type: 'object', additionalProperties: false }],
    ['object 未声明 additionalProperties', { type: 'object', properties: {} }],
    ['嵌套里藏不支持关键字', { type: 'object', properties: { a: { type: 'string', format: 'uri' } }, additionalProperties: false }],
    ['required 指向不存在的属性', { type: 'object', properties: { a: { type: 'string' } }, required: ['b'], additionalProperties: false }],
    ['enum 与 type 不符', { type: 'string', enum: [1, 2] }],
  ];
  for (const [label, schema] of bad) {
    assert.throws(() => jsonSchemaToZod(schema, 'probe'), UnsupportedSchemaError, `本应抛错却静默放行：${label}`);
  }
});

test('[NEGATIVE-3] 派生器抛错信息带上出错路径，便于定位', async () => {
  const { jsonSchemaToZod } = await import('../dist/mcp-schema.js');
  assert.throws(
    () => jsonSchemaToZod({ type: 'object', properties: { outer: { type: 'object', properties: { inner: { type: 'string', pattern: 'x' } }, additionalProperties: false } }, additionalProperties: false }, 'probe'),
    /probe\.outer\.inner/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// [LOCK-6] 协议层 inputSchema 对 main 基线的全量守卫（二轮审查补锁）
//
// 背景：MCP_BASELINE（main 09f2246 全量快照）一直存有 inputSchema，但 LOCK-1~5
// 从不断言它——正是这个盲区让 #2a（extension_call 放宽）一轮漏网、19 处漂移长期
// 隐形。本锁逐工具 diff inputSchema，除下方【显式 allowlist】外任何差异立即红灯。
//
// allowlist 的 19 处均已逐项审阅并实证（scripts/probe-mcp-schema-drift.mjs）：
//   A 类（11 处）default 仅进展示层——派生器用 .meta({default}) 而非 .default()，
//     实测 parse({}) => {}，服务端行为零变化，仅客户端可见契约新增广告；
//   B 类（8 处）约束收紧——与运行期单源一致，invokeTool 的 validateJsonSchema
//     本就会拒，判定结果不变，仅错误通道由 INVALID_INPUT 变为协议层校验错误。
// 两类均记为 #41 的显式契约变更（方向=协议层向运行期单源靠拢，即 #41 设计目标）。
// ─────────────────────────────────────────────────────────────────────────────

// 形如 `${tool} :: ${path}` → { baseline, current, reason }
const INPUT_SCHEMA_ALLOWLIST = new Map([
  // ── A 类：展示层 default 广告（parse 行为不变）──
  ['session_register :: properties.mode.default', { baseline: undefined, current: 'root', reason: 'A:展示层default' }],
  ['session_history :: properties.includeAncestors.default', { baseline: undefined, current: true, reason: 'A:展示层default' }],
  ['message_inbox :: properties.markRead.default', { baseline: undefined, current: false, reason: 'A:展示层default' }],
  ['message_inbox :: properties.limit.default', { baseline: undefined, current: 50, reason: 'A:展示层default' }],
  ['list_dir :: properties.path.default', { baseline: undefined, current: '.', reason: 'A:展示层default' }],
  ['find_files :: properties.path.default', { baseline: undefined, current: '.', reason: 'A:展示层default' }],
  ['search_text :: properties.path.default', { baseline: undefined, current: '.', reason: 'A:展示层default' }],
  ['search_text :: properties.regex.default', { baseline: undefined, current: false, reason: 'A:展示层default' }],
  ['blob_create :: properties.encoding.default', { baseline: undefined, current: 'utf-8', reason: 'A:展示层default' }],
  ['blob_read :: properties.encoding.default', { baseline: undefined, current: 'utf-8', reason: 'A:展示层default' }],
  ['blob_write_file :: properties.createParents.default', { baseline: undefined, current: false, reason: 'A:展示层default' }],
  // ── A 类（续）：T07 #35 为 session_list 新增可选分页入参 offset/limit ──
  //   实测 parse({}) => {}（两字段均非 required，服务端按缺省 offset=0/limit=20 切片），
  //   既有调用方零行为变化；limit.default=20 仅展示层广告（同 message_inbox 模式）。
  //   offset.maximum / limit.maximum 中 9007199254740991 为 zod4 派生器对 integer 型
  //   必带的 safe-int 边界（源 schema 未声明，派生往返 faithfully 还原），非行为变更。
  ['session_list :: properties.offset.type', { baseline: undefined, current: 'integer', reason: 'A:T07新增可选分页入参offset' }],
  ['session_list :: properties.offset.minimum', { baseline: undefined, current: 0, reason: 'A:T07新增可选分页入参offset' }],
  ['session_list :: properties.offset.maximum', { baseline: undefined, current: 9007199254740991, reason: 'A:派生器safe-int边界(整数型必带)' }],
  ['session_list :: properties.limit.type', { baseline: undefined, current: 'integer', reason: 'A:T07新增可选分页入参limit' }],
  ['session_list :: properties.limit.minimum', { baseline: undefined, current: 1, reason: 'A:T07新增可选分页入参limit' }],
  ['session_list :: properties.limit.maximum', { baseline: undefined, current: 200, reason: 'A:T07新增可选分页入参limit(上限200)' }],
  ['session_list :: properties.limit.default', { baseline: undefined, current: 20, reason: 'A:展示层default(服务端默认20,parse不变)' }],
  // ── A 类（续续）：T08 #36 为 read_file_range 新增可选 maxBytes 入参（与 read_file 对称）
  //   实测 parse({}) => {}（maxBytes 非 required，服务端按缺省 256_000 截断），既有调用方零行为变化；
  //   maximum=1_000_000 与 read_file 同源对齐，非行为变更。
  ['read_file_range :: properties.maxBytes.type', { baseline: undefined, current: 'integer', reason: 'A:T08新增可选maxBytes入参' }],
  ['read_file_range :: properties.maxBytes.minimum', { baseline: undefined, current: 1, reason: 'A:T08新增可选maxBytes入参' }],
  ['read_file_range :: properties.maxBytes.maximum', { baseline: undefined, current: 1000000, reason: 'A:T08新增可选maxBytes(上限1_000_000,与read_file同源)' }],
  // ── B 类：约束收紧（运行期本就拒，判定结果不变，错误通道前移）──
  ['session_inherit :: properties.claimCode.minLength', { baseline: undefined, current: 1, reason: 'B:收紧对齐运行期' }],
  ['session_inherit :: properties.sessionToken.minLength', { baseline: undefined, current: 1, reason: 'B:收紧对齐运行期' }],
  ['session_checkpoint :: properties.replanReason.minLength', { baseline: undefined, current: 1, reason: 'B:收紧对齐运行期' }],
  ['subagent_start :: properties.objective.maxLength', { baseline: undefined, current: 4000, reason: 'B:收紧对齐运行期' }],
  ['subagent_start :: properties.background.maxLength', { baseline: undefined, current: 4000, reason: 'B:收紧对齐运行期' }],
  ['subagent_start :: properties.deliverables.maxItems', { baseline: undefined, current: 20, reason: 'B:收紧对齐运行期' }],
  ['subagent_start :: properties.acceptanceCriteria.maxItems', { baseline: undefined, current: 20, reason: 'B:收紧对齐运行期' }],
  ['subagent_start :: properties.constraints.maxItems', { baseline: undefined, current: 20, reason: 'B:收紧对齐运行期' }],
]);

function flattenSchema(node, path, out) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.set(path, node);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    flattenSchema(value, path ? `${path}.${key}` : key, out);
  }
}

test('[LOCK-6] 全部 32 工具 inputSchema 对 main 基线快照零静默漂移（allowlist 外必红）', async () => {
  const actual = await collectMcpTools();
  const names = Object.keys(MCP_BASELINE);
  const seen = new Set();
  const violations = [];

  for (const name of names) {
    const base = new Map();
    const cur = new Map();
    flattenSchema(MCP_BASELINE[name].inputSchema ?? null, '', base);
    flattenSchema(actual[name]?.inputSchema ?? null, '', cur);
    for (const path of new Set([...base.keys(), ...cur.keys()])) {
      const b = base.get(path);
      const c = cur.get(path);
      if (Object.is(b, c) || JSON.stringify(b) === JSON.stringify(c)) continue;
      const key = `${name} :: ${path}`;
      const allowed = INPUT_SCHEMA_ALLOWLIST.get(key);
      if (allowed && JSON.stringify(allowed.baseline) === JSON.stringify(b) && JSON.stringify(allowed.current) === JSON.stringify(c)) {
        seen.add(key);
        continue;
      }
      violations.push(`${key}  [${JSON.stringify(b)} -> ${JSON.stringify(c)}]`);
    }
  }

  assert.deepEqual(violations, [], `协议层 inputSchema 出现 allowlist 之外的漂移：\n${violations.join('\n')}`);
  // 反向守卫：allowlist 条目若已不存在（如某处被还原），必须从清单删除，防清单腐烂
  const stale = [...INPUT_SCHEMA_ALLOWLIST.keys()].filter((k) => !seen.has(k));
  assert.deepEqual(stale, [], `allowlist 存在已失效条目（差异已消失，请删除）：\n${stale.join('\n')}`);
});
