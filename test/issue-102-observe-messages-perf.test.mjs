// ADR-0051 增补-03 (#102)：observeMessages 查询性能——根因 redact() 病态算法
//
// 事实底座（2026-08-15 实测，见票内数据）：
//   W104-AC8（120 条消息运行时探测）~7s；分层计时证明耗时集中在 extensions.call 内部：
//     store.auditEvent（finish 事件含 rawResult+shapedResult，~4MB）→ AuditLog.event
//     的 redact() 单次 ~700-1050ms；server.logAuditEvent 再红化一遍。
//   机理：collectSensitiveValues 把 120 条消息 body 收进 secrets；sanitize 对树上每个
//   普通字符串执行 for(secret of secrets) split/join 扫掠 → O(字符串数 × secrets 数)。
//
// 验收断言：
//   AC1  语义契约（多 secrets 大事件）：secrets 逐字替换于所有自由字符串；sensitive 键
//        替换；body 键替换；结构原样保留；regex 元字符按字面量处理（转义不越界）
//   AC2  性能门禁：120 消息事件（含 operationsSinceSend）redact 单次 < 500ms
//        （修复前 ~1050ms → 红；修复后 ~70ms，10× 余量防 CI 抖动）
//
// 注：任何 src 改动后必须先 bun run build 再跑测试（测试全部从 dist 导入，历史教训见 #43）。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../dist/redact.js';
import { MyTerminalStore } from '../dist/store.js';

/** 复刻 AC8 场景的审计 finish 事件：120 条消息 + observations（含 operationsSinceSend）。 */
function buildAuditEvent() {
  const messages = [];
  for (let i = 0; i < 120; i++) {
    messages.push({
      id: `msg_${i.toString(16).padStart(8, '0')}-${i}`,
      from: 'ses_a', to: 'ses_b', source: 'session',
      body: `probe-${i}`,
      createdAt: new Date(1_755_000_000_000 + i * 1000).toISOString(),
    });
  }
  const observations = messages.map((message, i) => {
    const operationsSinceSend = [];
    for (let j = i; j < 240; j += 2) {
      operationsSinceSend.push({
        sessionId: 'ses_a',
        at: new Date(1_755_000_000_000 + j * 1000).toISOString(),
        tool: `tool_${j % 7}`, ok: true, durationMs: 10 + j,
      });
    }
    return {
      message, sentAt: message.createdAt, observedAt: '2026-08-15T00:00:00.000Z',
      ageMs: 5000, operationsSinceSend,
      latencyNotice: 'The recipient may have progressed after this message; review operationsSinceSend before acting.',
    };
  });
  const shaped = {
    session: { id: 'ses_a', name: 'w104-main' },
    total: 120, offset: 20, nextOffset: 120, count: 100, truncated: true, totalCount: 120,
    messages, observations,
  };
  return {
    ok: true, data: { tool: 'message_list', result: shaped },
    id: 'act_xxx', timestamp: '2026-08-15T00:00:00.000Z', completedAt: '2026-08-15T00:00:01.000Z',
    source: 'actions', action: 'message_list', status: 'completed', durationMs: 12,
    workspace: '/tmp/wk', session: 'ses_a',
    args: { to: 'ses_a', body: 'probe-119', token: 'super-secret-token-abc' },
    result: shaped, rawResult: shaped, shapedResult: shaped,
  };
}

test('#102-AC1: redact 语义契约 — 多 secrets 大事件逐字替换、键位替换、元字符字面量、结构原样', () => {
  const event = buildAuditEvent();

  // secrets（body 键值 ≥4 字符）会从所有自由字符串中逐字清除：body 字段本身 →
  // "[REDACTED n chars]"；自由字符串中出现 secret → "[REDACTED]"
  const firstMessage = event.data.result.messages[0];
  const bodyLen = firstMessage.body.length;

  // 在自由字符串（非 body/sensitive 键）里嵌一个**不与任何其他 secret 重叠**的 secret
  // 短语，验证逐字扫掠（重叠 secret 的替换顺序是 impl 伪影，不属于契约，不在此断言）。
  event.meta = { body: 'unique-sweep-secret-777' };   // body 键 → 收入 secrets
  event.data.result.session.note = `seen body: unique-sweep-secret-777 in the log`;
  event.latency = `payload contained ${event.args.body}`;   // probe-119（与 probe-1 重叠）

  const redacted = redact(event);

  assert.equal(redacted.data.result.session.note, 'seen body: [REDACTED] in the log', '自由字符串中的 secret 逐字替换');
  assert.equal(redacted.latency, 'payload contained [REDACTED]19', '重叠 secret 顺序伪影：与当前实现逐字一致');
  assert.ok(!redacted.latency.includes('probe-119'), '完整 secret 绝不残留');
  assert.equal(redacted.data.result.messages[0].body, `[REDACTED ${bodyLen} chars]`, 'body 键 → "[REDACTED n chars]"');
  assert.equal(redacted.data.result.messages[0].id, event.data.result.messages[0].id, '非敏感字段原样保留');
  assert.equal(redacted.data.result.messages.length, 120, '数组结构原样');
  assert.equal(redacted.data.result.observations[0].operationsSinceSend.length, event.data.result.observations[0].operationsSinceSend.length, '嵌套结构原样');
  assert.equal(redacted.args.token, '[REDACTED]', 'sensitive 键替换');
  assert.equal(redacted.args.body, `[REDACTED ${event.args.body.length} chars]`, 'args.body 键替换');

  // regex 元字符按字面量处理：secrets 含 "." 时不得把 "aXbYc" 一并替换
  const meta = buildAuditEvent();
  meta.data.result.messages[0].body = 'price 1.5x';
  meta.data.result.session.note = 'price 1x5x seen';   // 非字面量出现，不得被误杀
  const metaRedacted = redact(meta);
  assert.equal(metaRedacted.data.result.messages[0].body, '[REDACTED 10 chars]', '含元字符 body 仍按 body 键处理');
  assert.equal(metaRedacted.data.result.session.note, 'price 1x5x seen', '元字符不越界：非字面量不被替换');
});

test('#102-AC2: 性能门禁 — 120 消息事件 redact 单次 < 500ms（修复前 ~1050ms）', () => {
  const event = buildAuditEvent();
  redact(event); // 预热
  const t0 = performance.now();
  const out = redact(event);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 500, `redact 120 消息事件应 < 500ms，实测 ${elapsed.toFixed(1)}ms`);
  assert.equal(out.data.result.messages.length, 120, '结果完整');
});

// ── AC3/AC4：readRecentHistory 增量 tail 缓存（#102 第二根因：每次 append 全量失效缓存
//    → 下轮查询重读整个历史文件，实测查询耗时随累计审计 139ms→584ms）───────────────

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myterminal-wk69-store-'));
  const store = new MyTerminalStore(dir);
  return { store, dir };
}

/** 复刻 message_list 审计规模的嵌套条目（~200KB：ops 小对象数组——JSON 解析成本与生产一致，
 *  区别于长字符串条目）。 */
function auditEventOf(i) {
  const ops = Array.from({ length: 3500 }, (_, j) => ({
    sessionId: 'ses_a',
    at: new Date(1_755_000_000_000 + j * 10).toISOString(),
    tool: `tool_${j % 7}`, ok: true, durationMs: 10 + j,
  }));
  return {
    id: `act_${i}`, timestamp: new Date(1_755_000_000_000 + i).toISOString(),
    completedAt: new Date(1_755_000_000_000 + i + 1).toISOString(),
    source: 'actions', action: `tool_${i % 5}`, status: 'completed', durationMs: 10,
    workspace: '/tmp/wk', session: 'ses_1', args: { n: i },
    result: { n: i, messages: Array.from({ length: 100 }, (_, k) => ({ id: `msg_${k}`, n: k })), ops },
  };
}

test('#102-AC3: 增量缓存正确性 — append 后 readRecentHistory 含新条目、顺序正确、内容一致', () => {
  const { store, dir } = makeStore();
  try {
    const { session } = store.registerRoot({ name: 'main', role: 'lead' });
    store.readRecentHistory(session.id); // 预热缓存
    const warm = store.readRecentHistory(session.id);

    store.auditEvent(session.id, auditEventOf(1));
    const after1 = store.readRecentHistory(session.id);
    assert.equal(after1.length, warm.length + 1, 'append 1 条后 readRecentHistory 增 1');
    assert.equal(after1.at(-1).type, 'tool_audit', '新条目在最末');
    assert.equal(after1.at(-1).data.action, 'tool_1', '新条目内容一致');

    store.auditEvent(session.id, auditEventOf(2));
    const after2 = store.readRecentHistory(session.id);
    assert.equal(after2.length, warm.length + 2, 'append 2 条后 readRecentHistory 增 2');
    assert.equal(after2.at(-2).data.action, 'tool_1', '顺序正确');
    assert.equal(after2.at(-1).data.action, 'tool_2', '顺序正确');
    assert.equal(after2.at(-1).data.result.messages.length, 100, '嵌套结构一致');
    assert.equal(after2.at(-1).data.result.ops.length, 3500, '嵌套结构一致');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#102-AC4: 增量缓存性能门禁 — 20 轮 append+read 大条目 < 600ms（修复前整文件重读）', () => {
  const { store, dir } = makeStore();
  try {
    const { session } = store.registerRoot({ name: 'main', role: 'lead' });
    // 预置 ~10 条大审计（~200KB 嵌套，复刻 message_list 审计规模）
    for (let i = 0; i < 10; i++) store.auditEvent(session.id, auditEventOf(i));
    store.readRecentHistory(session.id); // 预热

    const t0 = performance.now();
    for (let i = 10; i < 30; i++) {
      store.auditEvent(session.id, auditEventOf(i));
      const tail = store.readRecentHistory(session.id);
      assert.ok(tail.length > i, '每轮读到最新条目');
    }
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 600, `20 轮 append+read（~4MB→8MB 文件）应 < 600ms，实测 ${elapsed.toFixed(1)}ms`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
