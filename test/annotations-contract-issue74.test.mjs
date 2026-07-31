// issue #74 —— tool annotations 契约锁（关系锁 + 语义值锁）
//
// 背景（ADR-0034）：
//   core-tools.ts:190 的共享对象 localCreate 以 idempotentHint:true 为默认撒给 10 个工具；
//   mcp.ts:181 的 safeLocalMutation 以 false 为默认、真幂等者显式 opt-in。
//   两侧默认极性相反 → 4 条确切漂移。且 annotations 经 extensions.ts:300 的
//   extension_discover 目录原样对外公布，同一 MCP 客户端会拿到两份互相矛盾的声明。
//
// 本文件的立锁纪律（ADR-0034 CP2）：
//   此刻锁的是「现状」，必须全绿——因为 idempotentHint 零内部消费，立锁不该惊动任何行为。
//   已知的 4 条漂移登记在 KNOWN_DRIFT，待修的 5 处值登记在 IDEMPOTENCY_LEDGER 并标注 ⚠️。
//   CP3 修复时：allowlist 清空、⚠️ 标注消失、并补上终态锁与结构锁。
//
// 分区：
//   [LOCK-74-1] 关系锁：两侧共有工具的四个 hint 必须逐字相等，例外须登记在 KNOWN_DRIFT。
//   [LOCK-74-2] 语义值锁：每个 core 工具的 idempotentHint 必须与登记的判定 + 理由一致。
//               #41 LOCK-1 已做逐字 fixture 快照，此处刻意不重复——
//               这把锁锁的是「值 + 理由」，防的是共享对象把默认值再次悄悄撒出去。
//
// 变异体清单：
//   N1  某工具单侧改 hint，另一侧忘改      → LOCK-74-1 杀
//   N2  新增工具沿用共享对象、幂等性没想过  → LOCK-74-2 杀（未登记即红）
//   N3  改了 idempotentHint 但没改理由      → LOCK-74-2 杀
//   N4  KNOWN_DRIFT 留了已经不漂移的死条目  → LOCK-74-1 的 stale 检查杀

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectBuiltinSchemasWithTaskPoll, collectMcpTools } from './fixtures/tool-schema-baseline-issue41.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HINTS = ['readOnlyHint', 'destructiveHint', 'openWorldHint', 'idempotentHint'];

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN_DRIFT —— 已知的两侧不一致，逐条登记待修（ADR-0034）
//
// ⚠️ 这张表只能变短，不能变长。加一条 = 把一个新缺陷合法化，必须在 PR 里给理由。
//    ADR-0034 的收敛目标是把它清成空表。
// ─────────────────────────────────────────────────────────────────────────────
const KNOWN_DRIFT = {
  // 空表 —— ADR-0034 CP3 修复完成，两侧 annotations 已完全一致。
  // 立锁时（CP2, commit 13a1621）这里有 4 条：
  //   session_register / session_inherit / session_release / message_send 的 idempotentHint。
};

// ─────────────────────────────────────────────────────────────────────────────
// IDEMPOTENCY_LEDGER —— 每个 core 工具的 idempotentHint 判定 + 理由
//
// 规则（ADR-0034 决策 1）：默认 false，只有确证幂等才 true。
// 新增工具必须在此登记，否则 LOCK-74-2 红。改值必须同步改理由。
// 标 ⚠️ 者为「现状值，ADR-0034 判定应改」，CP3 修复时连值带理由一起更新。
// ─────────────────────────────────────────────────────────────────────────────
const IDEMPOTENCY_LEDGER = {
  // ── 只读：重复调用天然不改变状态 ──
  workspace_info: [true, '纯读运行时信息'],
  list_dir: [true, '纯读目录'],
  find_files: [true, '纯读检索'],
  search_text: [true, '纯读检索'],
  read_file: [true, '纯读文件'],
  read_file_range: [true, '纯读文件区间'],
  blob_read: [true, '纯读 blob'],
  git_status: [true, '纯读 git 状态'],
  git_diff: [true, '纯读 git diff'],
  git_log: [true, '纯读 git log'],
  git_show: [true, '纯读 git 对象'],
  session_list: [true, '纯读会话树'],
  session_context: [true, '纯读上下文投影'],
  session_history: [true, '纯读历史分页'],
  message_list: [true, '纯读消息列表'],
  message_conversation: [true, '纯读会话消息'],
  message_inbox: [true, '读收件箱；readOnlyHint 为 false 但重复调用结果收敛'],
  subagent_status: [true, '纯读 subagent 状态，完成后结果保留至清理'],

  // ── 幂等写：重复调用结果收敛 ──
  blob_create: [true, '内容寻址，同内容重复创建得同一 blob（与 mcp.ts:229 一致）'],
  blob_write_file: [true, '同内容重复写成功，不同内容永不覆盖（与 mcp.ts:231 一致）'],
  session_events_ack: [true, '按事件 ID 确认，重复确认无额外效果（与 mcp.ts:214 一致）'],
  session_tag: [true, 'store.ts:486 用 Set 去重，重复打同一标签结果不变'],
  session_subscribe: [true, 'store.ts:499 用 some() 查重后才 push，重复订阅不产生第二条'],
  task_poll: [true, '轮询后台任务进度，重复轮询结果收敛（与 TASK_POLL_TOOL.annotations / mcp.ts:232 safeRead 默认一致）'],

  // ── 非幂等：每次调用都产生新的不可回收效果 ──
  session_register: [false, '每次调用产出新 session 与新 token；重放会留下孤儿 session'],
  session_inherit: [false, '消耗一次性 claimCode，重放不等价'],
  session_release: [false, '每次签发新的一次性 handoff code'],
  session_unregister: [false, 'session_release 的逐字兼容别名，必须同值'],
  message_send: [false, '每次调用追加一条新的持久消息；重放产生重复消息'],
  session_checkpoint: [false, '每次记录一条新的检查点状态'],
  write_file: [false, '整文件替换，破坏性'],
  apply_patch: [false, '文本替换，重放会打到已变更的内容上'],
  execute_cli: [false, '任意 shell 命令，副作用不可知'],
  run_checks: [false, '执行项目脚本，副作用不可知'],
  skill: [false, 'ADR-0010 决策 8：fork 模式会启动 subagent'],
  subagent_start: [false, '每次调用启动一个新 subagent'],
  subagent_abort: [false, '维持 SUBAGENT_ANNOTATIONS 现状；其 description 自称幂等属已知矛盾，ADR-0034 登记为观察项，不在本刀范围'],
};

// ─────────────────────────────────────────────────────────────────────────────
// [LOCK-74-1] 关系锁
// ─────────────────────────────────────────────────────────────────────────────

test('[LOCK-74-1] core 与 MCP 两侧共有工具的 annotations 逐字相等（例外须登记在 KNOWN_DRIFT）', async () => {
  const core = collectBuiltinSchemasWithTaskPoll();
  const mcp = await collectMcpTools();
  const shared = Object.keys(core).filter((n) => n in mcp).sort();

  assert.ok(shared.length >= 28, `两侧共有工具只剩 ${shared.length} 个，少于预期 28——工具集合被意外改动`);

  const unexpected = [];
  const staleAllowlist = [];

  for (const name of shared) {
    const a = core[name].annotations ?? {};
    const b = mcp[name].annotations ?? {};
    const differing = HINTS.filter((h) => a[h] !== b[h]);
    const allowed = KNOWN_DRIFT[name] ?? [];

    for (const hint of differing) {
      if (!allowed.includes(hint)) {
        unexpected.push(`${name}.${hint}: core=${a[hint]} mcp=${b[hint]}`);
      }
    }
    for (const hint of allowed) {
      if (!differing.includes(hint)) staleAllowlist.push(`${name}.${hint}`);
    }
  }

  assert.deepEqual(unexpected, [], '出现未登记的 annotations 漂移：\n  ' + unexpected.join('\n  '));
  assert.deepEqual(
    staleAllowlist, [],
    'KNOWN_DRIFT 里有条目已经不漂移了，请从 allowlist 删掉：\n  ' + staleAllowlist.join('\n  '),
  );
});

test('[LOCK-74-1b] KNOWN_DRIFT allowlist 必须为空（ADR-0034 的收敛终态）', () => {
  const remaining = Object.entries(KNOWN_DRIFT).flatMap(([n, hs]) => hs.map((h) => `${n}.${h}`));
  assert.deepEqual(
    remaining, [],
    'annotations 两侧仍有 ' + remaining.length + ' 条漂移。#74 已修复，这张表不该再有条目——'
    + '若确需新增，必须先在 ADR 里说明为什么这条漂移是可接受的：\n  ' + remaining.join('\n  '),
  );
});

test('[LOCK-74-1c] KNOWN_DRIFT 只登记 idempotentHint，其余三个 hint 两侧永不漂移', async () => {
  const core = collectBuiltinSchemasWithTaskPoll();
  const mcp = await collectMcpTools();
  const shared = Object.keys(core).filter((n) => n in mcp);

  const bad = [];
  for (const name of shared) {
    const a = core[name].annotations ?? {};
    const b = mcp[name].annotations ?? {};
    for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
      if (a[hint] !== b[hint]) bad.push(`${name}.${hint}: core=${a[hint]} mcp=${b[hint]}`);
    }
  }
  assert.deepEqual(bad, [], '安全语义 hint 出现两侧漂移（比 idempotentHint 更严重）：\n  ' + bad.join('\n  '));
});

// ─────────────────────────────────────────────────────────────────────────────
// [LOCK-74-2] 语义值锁
// ─────────────────────────────────────────────────────────────────────────────

test('[LOCK-74-2] 每个 core 工具的 idempotentHint 与 IDEMPOTENCY_LEDGER 登记值一致', () => {
  const core = collectBuiltinSchemasWithTaskPoll();
  const names = Object.keys(core).sort();

  const unregistered = names.filter((n) => !(n in IDEMPOTENCY_LEDGER));
  assert.deepEqual(
    unregistered, [],
    '新增工具未在 IDEMPOTENCY_LEDGER 登记幂等判定（新增工具必须显式想清楚幂等性）：\n  ' + unregistered.join('\n  '),
  );

  const stale = Object.keys(IDEMPOTENCY_LEDGER).filter((n) => !names.includes(n));
  assert.deepEqual(stale, [], 'IDEMPOTENCY_LEDGER 里有已不存在的工具：\n  ' + stale.join('\n  '));

  const mismatched = [];
  for (const name of names) {
    const [expected, reason] = IDEMPOTENCY_LEDGER[name];
    const actual = (core[name].annotations ?? {}).idempotentHint;
    if (actual !== expected) {
      mismatched.push(`${name}: 实际=${actual} 登记=${expected}（登记理由：${reason}）`);
    }
  }
  assert.deepEqual(
    mismatched, [],
    'idempotentHint 与登记判定不符——改值必须同步改理由：\n  ' + mismatched.join('\n  '),
  );
});

test('[LOCK-74-2b] 四个 hint 必须全部显式为布尔值（不得缺字段）', () => {
  const core = collectBuiltinSchemasWithTaskPoll();
  const bad = [];
  for (const [name, tool] of Object.entries(core)) {
    const a = tool.annotations ?? {};
    for (const hint of HINTS) {
      if (typeof a[hint] !== 'boolean') bad.push(`${name}.${hint} = ${a[hint]}`);
    }
  }
  assert.deepEqual(bad, [], 'annotations 存在缺失或非布尔的 hint：\n  ' + bad.join('\n  '));
});

test('[LOCK-74-2c] readOnlyHint 为 true 的工具必须同时 idempotentHint 为 true', () => {
  const core = collectBuiltinSchemasWithTaskPoll();
  const bad = [];
  for (const [name, tool] of Object.entries(core)) {
    const a = tool.annotations ?? {};
    if (a.readOnlyHint === true && a.idempotentHint !== true) {
      bad.push(`${name}: readOnly=true 但 idempotent=${a.idempotentHint}`);
    }
  }
  assert.deepEqual(bad, [], '只读工具不可能非幂等：\n  ' + bad.join('\n  '));
});

// ─────────────────────────────────────────────────────────────────────────────
// [LOCK-74-3] 结构锁 —— 防的是根因复发，不是症状
// ─────────────────────────────────────────────────────────────────────────────

test('[LOCK-74-3] core-tools.ts 不得再出现「非只读 + idempotentHint:true 预设」的共享注解对象', () => {
  const source = readFileSync(join(here, '..', 'src', 'core-tools.ts'), 'utf8').replace(/\r\n/g, '\n');

  // #74 根因：形如
  //   const localCreate = { readOnlyHint: false, ..., idempotentHint: true };
  // 的共享对象被多个工具原样引用，等于把一个「乐观且需要论证」的幂等判断当默认值撒出去。
  //
  // 只禁 true，不禁 false：ADR-0034 决策 1 定的就是「默认 false、真幂等才 opt-in」。
  // 共享 idempotentHint:false（如 `mutating`、`SUBAGENT_ANNOTATIONS`）是保守侧，
  // 误报方向无害——客户端只是少一次重试优化。把它们一并判红属于锁过严。
  const pattern = /const\s+(\w+)\s*=\s*\{([^}]*readOnlyHint:\s*false[^}]*idempotentHint:\s*true[^}]*)\}/g;

  const offenders = [];
  for (const match of source.matchAll(pattern)) {
    const identifier = match[1];
    // 只有被当作 annotations 直接复用才构成问题；单点内联字面量不算。
    const reuse = source.split(new RegExp(`annotations:\\s*${identifier}\\b`)).length - 1;
    if (reuse > 0) offenders.push(`${identifier}（被 ${reuse} 处直接用作 annotations）`);
  }

  assert.deepEqual(
    offenders, [],
    '共享注解对象把 idempotentHint 当默认值撒出去了（#74 根因，ADR-0034）：\n  '
    + offenders.join('\n  ')
    + '\n  非只读工具请写成 { ...localWrite, idempotentHint: <显式判断> }，并在 IDEMPOTENCY_LEDGER 登记理由。',
  );
});

test('[LOCK-74-3b] localWrite 本身不得含 idempotentHint（强制使用者显式表态）', () => {
  const source = readFileSync(join(here, '..', 'src', 'core-tools.ts'), 'utf8');
  const match = source.match(/const\s+localWrite\s*=\s*\{([^}]*)\}/);
  assert.ok(match, 'localWrite 定义不见了——若已重命名，请同步本锁');
  assert.ok(
    !/idempotentHint/.test(match[1]),
    'localWrite 里出现了 idempotentHint。它的存在意义就是「不替使用者做幂等性判断」，'
    + '一旦带上默认值，#74 的根因就复活了。',
  );
});
