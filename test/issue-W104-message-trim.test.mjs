// ADR-0051 W1-04 (#77)：message_inbox / message_list / message_conversation L1 主动精简 + 分页（0050 A4）
//
// 验收断言：
//   AC1  TOOL_SHAPES 注册三工具 → { reduce }（0050 A4：此前三工具均 passthrough）
//   AC2  成功态：messages 保留 + count === messages.length；非截断无 totalCount；
//        store 页元数据（total/offset/nextOffset）剥除、统一派生字段（D17 静默）
//   AC3  截断态：truncated === true + totalCount === 真实总量（D16.2）；
//        data.continuation.pagination 发射，nextCall 可翻页恢复（不丢数据）
//   AC4  message_conversation 真实键路径：conversation.{sessions,messages} + observations 顶层；
//        派生字段落在 conversation 内（不得用扁平假键）；截断态 nextCall 带 with（对端 name）
//   AC5  结构不符（无 messages 数组 / 无 conversation）→ fail-open 原样，不抛错（D11）
//   AC6  D17 静默：结果内无任何层标记；pagination / __reduction 不泄漏进模型上下文
//   AC7  运行时探测：actions 通道发 120 条消息后 message_list / message_conversation /
//        message_inbox 截断态断言 count/totalCount/pagination，逐页翻回全部消息不丢数据
//
// 测试方式：单测直接驱动 shapeToolResponse（../dist/tool-parse.js，遵循 issue-31 seam）；
// 运行时探测走 MyTerminalRuntime actions 通道（../dist/server.js，遵循 myterminal.test.mjs 手法）。
// 注：任何 src 改动后必须先 bun run build 再跑测试（测试全部从 dist 导入，历史教训见 #43）。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shapeToolResponse, TOOL_SHAPES } from '../dist/tool-parse.js';
import { MyTerminalRuntime } from '../dist/server.js';

// D17 静默契约：任何层都不插自标识标记（复用 issue-31 手法）
const MARKER_KEYS = ['_shapedBy', '_l1Applied', '_l2Applied', '_l3Applied'];

function assertNoShapingMarkers(value, at = 'root') {
  if (Array.isArray(value)) { for (const item of value) assertNoShapingMarkers(item, `${at}[]`); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!MARKER_KEYS.includes(key), `D17 静默契约被破坏：${at}.${key}`);
    assert.ok(key !== '__reduction', `内部提示泄漏进结果：${at}.${key}`);
    if (key === 'pagination') {
      // pagination 仅允许出现在 L2 发射位 data.continuation.pagination；其余位置一律泄漏（D17）
      assert.ok(at.endsWith('data.continuation'), `pagination 泄漏进结果：${at}.${key}`);
    }
    assertNoShapingMarkers(item, `${at}.${key}`);
  }
}

function makeResponse(tool, result) {
  return { ok: true, data: { tool, result } };
}

function makeCtx() {
  let record;
  const ctx = {
    transport: 'actions',
    sessionId: 's-w104',
    resolveTool: () => undefined,
    audit: (r) => { record = r; },
  };
  return { ctx, getRecord: () => record };
}

function pageMessages(count) {
  return Array.from({ length: count }, (_, i) => ({ id: `msg-${i}`, body: `body ${i}` }));
}

test('W1-04-AC1: TOOL_SHAPES 注册 message_inbox / message_list / message_conversation（0050 A4）', () => {
  for (const tool of ['message_inbox', 'message_list', 'message_conversation']) {
    assert.ok(TOOL_SHAPES.has(tool), `${tool} 应注册`);
    assert.equal(typeof TOOL_SHAPES.get(tool).reduce, 'function', `${tool} 应有 L1 reducer`);
  }
});

test('W1-04-AC2: 成功态（message_inbox）— count === messages.length；非截断无 totalCount；页元数据剥除', async () => {
  const { ctx: c } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('message_inbox', {
    session: { id: 's-alice', name: 'alice' },
    total: 2, offset: 0,
    messages: pageMessages(2),
    observations: [{ kind: 'observation' }],
  }), c);

  assert.equal(shaped.data.result.messages.length, 2, 'messages 原样保留');
  assert.equal(shaped.data.result.count, 2, 'count === messages.length（D16.1）');
  assert.equal(shaped.data.result.truncated, false, '非截断 truncated === false');
  assert.equal('totalCount' in shaped.data.result, false, '非截断无 totalCount');
  assert.equal('total' in shaped.data.result, false, 'store 页元数据 total 剥除（D17 统一派生字段）');
  assert.equal('offset' in shaped.data.result, false, 'offset 剥除');
  assert.equal('nextOffset' in shaped.data.result, false, 'nextOffset 剥除');
  assert.equal(shaped.data.result.session.name, 'alice', '其余字段原样保留');
  assert.equal(shaped.data.result.observations.length, 1, 'observations 原样保留');
  assert.equal(shaped.data.continuation, undefined, '非截断无 continuation');
  assertNoShapingMarkers(shaped.data.result);
});

test('W1-04-AC3: 截断态（message_inbox）— truncated + totalCount（D16.2）+ continuation.pagination nextCall', async () => {
  const { ctx: c } = makeCtx();
  const shaped = await shapeToolResponse(makeResponse('message_inbox', {
    session: { id: 's-alice', name: 'alice' },
    total: 150, offset: 100, nextOffset: 150,
    messages: pageMessages(50),
    observations: pageMessages(50),
  }), c);

  assert.equal(shaped.data.result.messages.length, 50, 'messages 原样保留');
  assert.equal(shaped.data.result.count, 50, 'count === 本页实际长度');
  assert.equal(shaped.data.result.truncated, true, '截断态');
  assert.equal(shaped.data.result.totalCount, 150, 'totalCount === 真实总量（D16.2）');
  assert.equal('total' in shaped.data.result, false, '页元数据剥除');
  assert.equal('pagination' in shaped.data.result, false, 'pagination 内部提示不进模型上下文（D17）');
  assert.equal('__reduction' in shaped.data.result, false, '__reduction 只进审计（D17）');
  assert.deepEqual(shaped.data.continuation, {
    pagination: { truncated: true, nextCall: { tool: 'message_inbox', input: { offset: 150, limit: 50 }, purpose: 'fetch next page of inbox messages' } },
  }, 'L2 发射 data.continuation.pagination，nextCall 可翻页恢复');
  assertNoShapingMarkers(shaped.data.result);
});

test('W1-04-AC4: message_list 成功/截断态 — 同平铺形态，nextCall tool 为 message_list', async () => {
  const { ctx: c } = makeCtx();
  const success = await shapeToolResponse(makeResponse('message_list', {
    total: 2, offset: 0, messages: pageMessages(2), observations: [],
  }), c);
  assert.equal(success.data.result.count, 2);
  assert.equal(success.data.result.truncated, false);
  assert.equal('totalCount' in success.data.result, false);

  const truncated = await shapeToolResponse(makeResponse('message_list', {
    total: 120, offset: 20, nextOffset: 120, messages: pageMessages(100), observations: [],
  }), c);
  assert.equal(truncated.data.result.count, 100);
  assert.equal(truncated.data.result.truncated, true);
  assert.equal(truncated.data.result.totalCount, 120, 'totalCount === 真实总量');
  assert.deepEqual(truncated.data.continuation.pagination.nextCall, {
    tool: 'message_list', input: { offset: 120, limit: 100 }, purpose: 'fetch next page of collaboration messages',
  });
});

test('W1-04-AC5: message_conversation 真实键路径 — conversation.{sessions,messages} + observations 顶层；派生字段落 conversation 内', async () => {
  const { ctx: c } = makeCtx();
  const success = await shapeToolResponse(makeResponse('message_conversation', {
    conversation: {
      sessions: [{ id: 's-alice', name: 'alice' }, { id: 's-bob', name: 'bob' }],
      messages: pageMessages(3),
      total: 3, offset: 0,
    },
    observations: [{ kind: 'observation' }],
  }), c);
  const conv = success.data.result.conversation;
  assert.ok(Array.isArray(conv.sessions) && conv.sessions.length === 2, 'conversation.sessions 原样（真实键路径）');
  assert.ok(Array.isArray(conv.messages) && conv.messages.length === 3, 'conversation.messages 原样（不得用扁平假键）');
  assert.equal(conv.count, 3, '派生字段 count 落在 conversation 内');
  assert.equal(conv.truncated, false);
  assert.equal('totalCount' in conv, false);
  assert.equal('total' in conv, false, '页元数据从 conversation 内剥除');
  assert.equal(success.data.result.observations.length, 1, 'observations 顶层原样');
  assert.equal(success.data.continuation, undefined, '非截断无 continuation');

  const truncated = await shapeToolResponse(makeResponse('message_conversation', {
    conversation: {
      sessions: [{ id: 's-alice', name: 'alice' }, { id: 's-bob', name: 'bob' }],
      messages: pageMessages(50),
      total: 120, offset: 70, nextOffset: 120,
    },
    observations: pageMessages(50),
  }), c);
  const tconv = truncated.data.result.conversation;
  assert.equal(tconv.messages.length, 50);
  assert.equal(tconv.count, 50);
  assert.equal(tconv.truncated, true);
  assert.equal(tconv.totalCount, 120, 'totalCount === 真实总量（D16.2）');
  assert.deepEqual(truncated.data.continuation.pagination.nextCall, {
    tool: 'message_conversation', input: { with: 'bob', offset: 120, limit: 50 }, purpose: 'fetch next page of conversation messages',
  }, 'nextCall 带对端 with（sessions[1].name），可翻页恢复');
  assertNoShapingMarkers(truncated.data.result);
});

test('W1-04-AC6: 结构不符 → fail-open 原样返回，不抛错（D11）', async () => {
  const { ctx: c, getRecord } = makeCtx();

  const noMessages = await shapeToolResponse(makeResponse('message_inbox', { session: { id: 's' } }), c);
  assert.deepEqual(noMessages.data.result, { session: { id: 's' } }, '无 messages 数组 → 原样');
  assert.equal(getRecord().shaping.applied, true, 'L1 路径执行（reducer fail-open 不抛）');

  const noConversation = await shapeToolResponse(makeResponse('message_conversation', { unexpected: true }), c);
  assert.deepEqual(noConversation.data.result, { unexpected: true }, '无 conversation 对象 → 原样');

  const conversationNoMessages = await shapeToolResponse(makeResponse('message_conversation', { conversation: { sessions: [{ id: 's-alice' }] } }), c);
  assert.deepEqual(conversationNoMessages.data.result, { conversation: { sessions: [{ id: 's-alice' }] } }, 'conversation 内无 messages 数组 → 原样');

  const noNext = await shapeToolResponse(makeResponse('message_inbox', { foo: 'bar' }), c);
  assert.deepEqual(noNext.data.result, { foo: 'bar' }, '任意无消息结构 → 原样');
});

test('W1-04-AC7: D17 静默 — 结果内无任何层标记 / 内部提示（递归扫描）', async () => {
  const { ctx: c } = makeCtx();
  const truncated = await shapeToolResponse(makeResponse('message_conversation', {
    conversation: {
      sessions: [{ id: 's-alice', name: 'alice' }, { id: 's-bob', name: 'bob' }],
      messages: pageMessages(50),
      total: 120, offset: 70, nextOffset: 120,
    },
    observations: pageMessages(50),
  }), c);
  assertNoShapingMarkers(truncated);

  const success = await shapeToolResponse(makeResponse('message_inbox', {
    session: { id: 's-alice', name: 'alice' }, total: 2, offset: 0, messages: pageMessages(2), observations: [],
  }), c);
  assertNoShapingMarkers(success);
});

// ── 运行时探测（AC8）：actions 通道真实调用 ──────────────────────────────────────

const CONNECTOR_KEY = 'w104-connector-key-123456';
const ACTIONS_TOKEN = 'w104-actions-token-1234567890123456';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-w104-'));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  return { workspaceDir, stateDir };
}

async function createRuntime(overrides = {}) {
  const dirs = tempWorkspace();
  const runtime = new MyTerminalRuntime({
    ...dirs,
    settingsPath: path.join(dirs.stateDir, 'test-settings.json'),
    host: '127.0.0.1', port: 0,
    connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN,
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 20_000, commandTimeoutSec: 10,
    uiLanguage: 'zh-CN', uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    ...overrides,
  });
  await runtime.start();
  return {
    runtime, dirs,
    baseUrl: `http://127.0.0.1:${runtime.port}`,
    async close() { await runtime.close(); fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); },
  };
}

function actionsHeaders() { return { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' }; }

async function action(server, endpoint, body) {
  const response = await fetch(`${server.baseUrl}/actions/extensions/${endpoint}`, { method: 'POST', headers: actionsHeaders(), body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function call(server, tool, input = {}, identity) { return action(server, 'call', { tool, input, ...(identity ? { identity } : {}) }); }

/** 注册 root 会话，返回完整结果（session + identity）。 */
async function root(server, name = 'w104-main') {
  const reg = await call(server, 'session_register', { mode: 'root', name, role: 'lead' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  return reg.body.data.result;
}

/** 委托 + 继承出子会话（照 myterminal.test.mjs 手法）。 */
async function spawnChild(server, main, name = 'w104-child') {
  const task = { objective: 'Implement the assigned slice.', background: 'The root session delegated bounded work.', deliverables: ['Code and summary'], acceptanceCriteria: ['Checks pass'], constraints: ['Stay within scope'] };
  const delegate = await call(server, 'session_register', { mode: 'delegate', name, role: 'developer', task }, main.identity);
  assert.equal(delegate.status, 200, JSON.stringify(delegate.body));
  const info = delegate.body.data.result;
  const child = await call(server, 'session_inherit', { sessionId: info.session.id, claimCode: info.claimCode });
  assert.equal(child.status, 200, JSON.stringify(child.body));
  return child.body.data.result.identity;
}

test('W1-04-AC8: 运行时探测 — 发 120 条消息后三工具截断态 count/totalCount/分页，翻页恢复不丢数据', async () => {
  const server = await createRuntime();
  try {
    const main = await root(server);
    const child = await spawnChild(server, main);
    for (let i = 0; i < 120; i++) {
      const sent = await call(server, 'message_send', { to: main.session.id, body: `probe-${i}` }, child);
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.equal(sent.body.ok, true, JSON.stringify(sent.body));
    }

    // message_list（child 身份，默认 limit 100 → 截断）
    const list = await call(server, 'message_list', {}, child);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const listResult = list.body.data.result;
    assert.equal(listResult.messages.length, 100, '默认 limit 100 帽');
    assert.equal(listResult.count, 100, 'count === messages.length');
    assert.equal(listResult.truncated, true, '截断态（本页非全集）');
    assert.equal(listResult.totalCount, 120, 'totalCount === 真实总量（D16.2）');
    assert.deepEqual(list.body.data.continuation.pagination.nextCall, {
      tool: 'message_list', input: { offset: 0, limit: 100 }, purpose: 'fetch next page of collaboration messages',
    }, '缺省最新页已无后继 → nextCall 回 offset 0 取最旧段');
    assertNoShapingMarkers(listResult);

    // message_list 翻页（offset 0 起向前取回最旧段）：并集不丢数据
    const listPage1 = await call(server, 'message_list', { offset: 0, limit: 100 }, child);
    assert.equal(listPage1.status, 200, JSON.stringify(listPage1.body));
    const listPage1Result = listPage1.body.data.result;
    assert.equal(listPage1Result.messages.length, 100, 'offset 0 页 100 条');
    assert.equal(listPage1Result.count, 100);
    assert.equal(listPage1Result.truncated, true, 'offset 0 页仍有后继（nextOffset 100）');
    assert.deepEqual(listPage1.body.data.continuation.pagination.nextCall, {
      tool: 'message_list', input: { offset: 100, limit: 100 }, purpose: 'fetch next page of collaboration messages',
    }, '有后继 → nextCall 就近续读');

    const listPage2 = await call(server, 'message_list', { offset: 100, limit: 100 }, child);
    assert.equal(listPage2.status, 200, JSON.stringify(listPage2.body));
    const listPage2Result = listPage2.body.data.result;
    assert.equal(listPage2Result.messages.length, 20, '末段 20 条');
    assert.equal(listPage2Result.count, 20);
    assert.equal(listPage2Result.truncated, true, '末段本页非全集（120 条中的 20 条）→ 仍标截断 + totalCount');
    assert.equal(listPage2Result.totalCount, 120, '末段仍附真实总量');
    const listBodies = [...listResult.messages, ...listPage1Result.messages, ...listPage2Result.messages].map((m) => m.body);
    assert.equal(new Set(listBodies).size, 120, 'message_list 三页并集 120 条不重复、不丢数据');

    // message_conversation（child 身份，显式 limit 50 → 截断）
    const conv = await call(server, 'message_conversation', { with: 'w104-main', limit: 50 }, child);
    assert.equal(conv.status, 200, JSON.stringify(conv.body));
    const convResult = conv.body.data.result;
    assert.equal(convResult.conversation.messages.length, 50, 'limit 50 帽');
    assert.equal(convResult.conversation.count, 50);
    assert.equal(convResult.conversation.truncated, true, '截断态');
    assert.equal(convResult.conversation.totalCount, 120, 'totalCount === 真实总量');
    assert.equal(convResult.observations.length, 50, 'observations 与页一致');
    assert.deepEqual(conv.body.data.continuation.pagination.nextCall, {
      tool: 'message_conversation', input: { with: 'w104-main', offset: 0, limit: 50 }, purpose: 'fetch next page of conversation messages',
    }, 'nextCall 带对端 name（真实键路径取 sessions[1].name）；缺省最新页已无后继 → 回 offset 0 取最旧段');

    // message_conversation 翻三页（0/50/100）：并集覆盖全集、不丢数据
    const convPage1 = await call(server, 'message_conversation', { with: 'w104-main', offset: 0, limit: 50 }, child);
    const convPage2 = await call(server, 'message_conversation', { with: 'w104-main', offset: 50, limit: 50 }, child);
    const convPage3 = await call(server, 'message_conversation', { with: 'w104-main', offset: 100, limit: 50 }, child);
    assert.equal(convPage1.body.data.result.conversation.count, 50, 'offset 0 页 50 条');
    assert.equal(convPage1.body.data.result.conversation.truncated, true, 'offset 0 页仍有后继（nextOffset 50）');
    assert.equal(convPage2.body.data.result.conversation.count, 50, 'offset 50 页 50 条');
    assert.equal(convPage2.body.data.result.conversation.truncated, true, 'offset 50 页仍有后继（nextOffset 100）');
    assert.equal(convPage3.body.data.result.conversation.count, 20, '末段 20 条');
    assert.equal(convPage3.body.data.result.conversation.truncated, true, '末段本页非全集（120 条中的 20 条）→ 仍标截断 + totalCount');
    assert.equal(convPage3.body.data.result.conversation.totalCount, 120, '末段仍附真实总量');
    const convBodies = [
      ...convResult.conversation.messages,
      ...convPage1.body.data.result.conversation.messages,
      ...convPage2.body.data.result.conversation.messages,
      ...convPage3.body.data.result.conversation.messages,
    ].map((m) => m.body);
    assert.equal(new Set(convBodies).size, 120, 'message_conversation 四页并集 120 条不重复、不丢数据');

    // message_inbox（main 身份，默认 limit 50 → 截断）
    const inbox = await call(server, 'message_inbox', {}, main.identity);
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    const inboxResult = inbox.body.data.result;
    assert.equal(inboxResult.messages.length, 50, '默认 limit 50 帽');
    assert.equal(inboxResult.count, 50, 'count === messages.length');
    assert.equal(inboxResult.truncated, true, '截断态');
    assert.equal(inboxResult.totalCount, 120, 'totalCount === 真实总量');
    assert.deepEqual(inbox.body.data.continuation.pagination.nextCall, {
      tool: 'message_inbox', input: { offset: 0, limit: 50 }, purpose: 'fetch next page of inbox messages',
    }, '缺省最新页已无后继 → 回 offset 0 取最旧段');
    assertNoShapingMarkers(inboxResult);

    // message_inbox 翻三页（0/50/100）：并集覆盖全集、不丢数据
    const inboxPage1 = await call(server, 'message_inbox', { offset: 0 }, main.identity);
    const inboxPage2 = await call(server, 'message_inbox', { offset: 50 }, main.identity);
    const inboxPage3 = await call(server, 'message_inbox', { offset: 100 }, main.identity);
    assert.equal(inboxPage1.body.data.result.count, 50, 'offset 0 页 50 条');
    assert.equal(inboxPage1.body.data.result.truncated, true, 'offset 0 页仍有后继（nextOffset 50）');
    assert.equal(inboxPage2.body.data.result.count, 50, 'offset 50 页 50 条');
    assert.equal(inboxPage2.body.data.result.truncated, true, 'offset 50 页仍有后继（nextOffset 100）');
    assert.equal(inboxPage3.body.data.result.count, 20, '末段 20 条');
    assert.equal(inboxPage3.body.data.result.truncated, true, '末段本页非全集（120 条中的 20 条）→ 仍标截断 + totalCount');
    assert.equal(inboxPage3.body.data.result.totalCount, 120, '末段仍附真实总量');
    const inboxBodies = [...inboxResult.messages, ...inboxPage1.body.data.result.messages, ...inboxPage2.body.data.result.messages, ...inboxPage3.body.data.result.messages].map((m) => m.body);
    assert.equal(new Set(inboxBodies).size, 120, 'message_inbox 四页并集 120 条不重复、不丢数据');
  } finally {
    await server.close();
  }
});
