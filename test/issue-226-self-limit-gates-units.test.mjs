// Workflows T3（#226）：四重自限闸门与设置节——零件契约
//
// 这一份锁的是"闸门本身的算术"：默认即上限、越硬顶被 clamp、env 只认合法帧、
// 不限制开关只解 token 闸、时钟嵌套不变量可构造违例、设置节键名集中登记且不含端点字段。
// 引擎级验收（两级软检查 / 墙钟到期 / 多 run 各持窗口 / 违例拒启动）在
// issue-226-self-limit-gates.test.mjs。
//
// 数字的唯一账本 = ADR-0052 §6；这里全部写死字面量做锚——改常量必须把本文件弄红。

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GATES,
  ENDPOINT_FIELD_NAMES,
  HARD_AGENT_CAP_CEILING,
  HARD_CONCURRENCY_CEILING,
  HARD_DISPATCH_TURNS_CEILING,
  HARD_DISPATCH_WINDOW_CEILING_MINUTES,
  REDUCE_SLACK_MS,
  WORKFLOW_SETTING_KEYS,
  defaultWorkflowGates,
  describeClockNesting,
  endpointClashInWorkflowSection,
  normalizeWorkflowSettings,
  resolveWorkflowGates,
  validateClockNesting,
} from '../dist/workflows/gates.js';
import { DEFAULT_WORKFLOW_SETTINGS } from '../dist/workflows/gates.js';
import { defaultConcurrencyWindow } from '../dist/workflows/scheduler.js';
import { MAX_RETAINED_SNAPSHOTS, MAX_RETAINED_TERMINAL_RUNS } from '../dist/workflows/schema.js';

/** env 与核数都显式传入，测试绝不读进程环境（家规：跨用例不串味）。 */
function resolve(settings, env = {}, parallelism = 8) {
  return resolveWorkflowGates(settings, env, parallelism);
}

// ═══════════════════════════════════════════════════════════════
// AC1-a 四闸齐备且默认即上限（ADR-0052 §6 统一命名）
// ═══════════════════════════════════════════════════════════════

test('AC1 默认值就是上限：四闸 + 三个时钟全部照 §6 钉死', () => {
  assert.equal(DEFAULT_GATES.tokenCap, 8_000_000, 'tokenCap = 8,000,000 output tokens/run（偏离 ⑦）');
  assert.equal(DEFAULT_GATES.runGateMs, 30 * 60 * 1000, 'runGate = 30 分钟墙钟');
  assert.equal(DEFAULT_GATES.agentCap, 1000, 'agentCap = 1000');
  assert.equal(DEFAULT_GATES.concurrencyWindow, defaultConcurrencyWindow(), '并发窗口 = max(2, min(16, 核数−2))');
  assert.equal(defaultConcurrencyWindow(18), 16, '18 核 → 16（默认公式自己的顶）');
  assert.equal(defaultConcurrencyWindow(3), 2, '3 核 → 2（窗口 1 会把 parallel 静默串行化）');
  assert.equal(DEFAULT_GATES.dispatchWindowMs, 10 * 60 * 1000, '逐路 dispatchWindow = 10 分钟');
  assert.equal(DEFAULT_GATES.dispatchTurns, 50, '逐路 dispatchTurns = 50 轮');
  assert.equal(DEFAULT_GATES.stallMs, 180_000, 'stallWindow = 180 秒');
  assert.equal(DEFAULT_GATES.waitChunkMs, 600_000, 'waitChunk = 600 秒');
  assert.equal(DEFAULT_GATES.reducerBudgetMs, 35 * 60 * 1000, 'reducerBudget = runGate + 5 = 35 分钟');
  assert.equal(DEFAULT_GATES.reducerTimeoutMs, 40 * 60 * 1000, 'reducer timeoutSec = budget + 5 = 40 分钟');
  assert.equal(REDUCE_SLACK_MS, 5 * 60 * 1000, 'reduceSlack = 5 分钟（常量，不是旋钮）');
});

test('AC1 默认即上限还覆盖 worktree 配额 / 保留数 / 汇总体并发配额', () => {
  assert.equal(DEFAULT_GATES.keepQuotaCount, 50, '保留量上限 = 50 个 worktree');
  assert.equal(DEFAULT_GATES.keepQuotaBytes, 5 * 1024 * 1024 * 1024, '保留量上限 = 5 GB');
  assert.equal(DEFAULT_GATES.archiveAfterDays, 30, '归档天数默认 30 天');
  assert.equal(DEFAULT_GATES.autoArchive, false, '自动归档默认关');
  assert.equal(DEFAULT_GATES.snapshotRetain, MAX_RETAINED_SNAPSHOTS, '快照保留 30 份（与机器件常量同源）');
  assert.equal(DEFAULT_GATES.terminalRunRetain, MAX_RETAINED_TERMINAL_RUNS, '终态 run 保留 10 个（与注册表常量同源）');
  assert.equal(DEFAULT_GATES.reducerQuota, 3, '同时最多 3 个汇总体（§8 E8）');
  assert.equal(MAX_RETAINED_SNAPSHOTS, 30);
  assert.equal(MAX_RETAINED_TERMINAL_RUNS, 10);
});

test('AC1 未注入任何设置面时得到默认闸，且零告警', () => {
  const { gates, warnings } = resolve(undefined, {});
  assert.deepEqual(gates, defaultWorkflowGates(8), '缺省 = 默认闸（按同一核数口径）');
  assert.deepEqual(warnings, []);
});

// ═══════════════════════════════════════════════════════════════
// AC1-b 硬顶：越顶被 clamp 到硬顶（用例钉最终值 ≤ 硬顶）
// ═══════════════════════════════════════════════════════════════

test('AC1 硬顶用例：concurrencyWindow 越 64 / agentCap 越 10,000 都被压回硬顶', () => {
  assert.equal(HARD_CONCURRENCY_CEILING, 64);
  assert.equal(HARD_AGENT_CAP_CEILING, 10_000);
  assert.equal(HARD_DISPATCH_WINDOW_CEILING_MINUTES, 100, '逐路时间界硬顶 = 100 分钟');
  assert.equal(HARD_DISPATCH_TURNS_CEILING, 500, '逐路轮数硬顶 = 500 轮');

  const over = resolve({ concurrencyWindow: 5000, agentCap: 999_999, dispatchWindowMinutes: 4000, dispatchTurns: 90_000 });
  assert.equal(over.gates.concurrencyWindow, 64);
  assert.equal(over.gates.agentCap, 10_000);
  assert.equal(over.gates.dispatchWindowMs, 100 * 60 * 1000);
  assert.equal(over.gates.dispatchTurns, 500);
  assert.ok(over.gates.concurrencyWindow <= HARD_CONCURRENCY_CEILING, '最终值钉在 ≤ 硬顶');
  assert.ok(over.gates.agentCap <= HARD_AGENT_CAP_CEILING, '最终值钉在 ≤ 硬顶');
  assert.equal(over.warnings.length, 4, '每一次压顶都留一条可见告警');
});

test('AC1 env 越硬顶同样被压回（env 可调不得越硬顶）', () => {
  const { gates, warnings } = resolve(undefined, {
    MYTERMINAL_WORKFLOW_CONCURRENCY: '128',
    MYTERMINAL_WORKFLOW_AGENT_CAP: '50000',
  });
  assert.equal(gates.concurrencyWindow, 64);
  assert.equal(gates.agentCap, 10_000);
  assert.equal(warnings.length, 2);
});

test('AC1 硬顶之下照值生效，不退回默认', () => {
  const { gates, warnings } = resolve({ agentCap: 50, concurrencyWindow: 3 });
  assert.equal(gates.agentCap, 50);
  assert.equal(gates.concurrencyWindow, 3);
  assert.deepEqual(warnings, []);
});

test('AC1 设置面下限守住：并发窗口调不到 1，非正轮数落回默认', () => {
  const low = resolve({ concurrencyWindow: 1 });
  assert.equal(low.gates.concurrencyWindow, 2, '本机设置面的并发下限 = 2（窗口 1 = 静默串行化）');
  assert.equal(low.warnings.length, 1);
  const turns = resolve({ dispatchTurns: 0 });
  assert.equal(turns.gates.dispatchTurns, 50, '0 轮什么都跑不了 → 落回默认');
});

// ═══════════════════════════════════════════════════════════════
// AC1-c 调参入口 = config / env；env 只认合法帧
// ═══════════════════════════════════════════════════════════════

test('AC1 env 只认纯十进制正整数：空 / 0 / 负 / 小数 / 字母一律落回默认并告警', () => {
  for (const junk of ['', '   ', '0', '-3', '1.5', 'abc', '1e3', '+8', '  12  x']) {
    const { gates, warnings } = resolve(undefined, { MYTERMINAL_WORKFLOW_RUN_GATE_MINUTES: junk });
    assert.equal(gates.runGateMs, 30 * 60 * 1000, `${JSON.stringify(junk)} 必须落回默认墙钟`);
    assert.equal(warnings.length, 1, `${JSON.stringify(junk)} 要留下告警，不静默`);
    assert.match(warnings[0], /MYTERMINAL_WORKFLOW_RUN_GATE_MINUTES/);
  }
  const good = resolve(undefined, { MYTERMINAL_WORKFLOW_RUN_GATE_MINUTES: ' 45 ' });
  assert.equal(good.gates.runGateMs, 45 * 60 * 1000, '前后空白 trim 后认得');
  assert.deepEqual(good.warnings, []);
});

test('AC1 优先级：env > 本机设置文件 > 默认；未设的键不告警', () => {
  assert.equal(resolve({ runGateMinutes: 20 }).gates.runGateMs, 20 * 60 * 1000, '文件值照值生效');
  const fromEnv = resolve({ runGateMinutes: 20 }, { MYTERMINAL_WORKFLOW_RUN_GATE_MINUTES: '12' });
  assert.equal(fromEnv.gates.runGateMs, 12 * 60 * 1000, 'env 压过文件');
  assert.deepEqual(fromEnv.warnings, [], 'env 未出现的键不算非法值');
});

test('AC1 单位换算只在设置面出门一次：分钟 / 秒 / tokens 进，毫秒出', () => {
  const { gates } = resolve({ stallSeconds: 45, waitChunkSeconds: 90, reducerBudgetMinutes: 50, reducerTimeoutMinutes: 60, tokenCap: 1234 });
  assert.equal(gates.stallMs, 45_000);
  assert.equal(gates.waitChunkMs, 90_000);
  assert.equal(gates.reducerBudgetMs, 50 * 60 * 1000);
  assert.equal(gates.reducerTimeoutMs, 60 * 60 * 1000);
  assert.equal(gates.tokenCap, 1234, 'tokenCap 无单位换算');
});

// ═══════════════════════════════════════════════════════════════
// AC1-d "不限制" = 显式开关（默认关），只解 token 闸
// ═══════════════════════════════════════════════════════════════

test('AC1 不限制开关默认关；开启只解 token 闸，其余三闸仍有值', () => {
  assert.equal(DEFAULT_GATES.tokenCap, 8_000_000, '默认有顶（偏离 ⑦）');
  const on = resolve({ unlimited: true });
  assert.equal(on.gates.tokenCap, null, '开 = 无顶哨兵 null');
  assert.equal(on.gates.runGateMs, 30 * 60 * 1000, '墙钟不跟着放开');
  assert.equal(on.gates.agentCap, 1000, 'agent 数不跟着放开');
  assert.equal(on.gates.concurrencyWindow, defaultConcurrencyWindow(8), '并发窗口不跟着放开');
});

test('AC1 不限制开关可被显式关掉，且认得仓库那几种布尔写法', () => {
  assert.equal(resolve({ unlimited: false }).gates.tokenCap, 8_000_000);
  const envOff = resolve({ unlimited: true }, { MYTERMINAL_WORKFLOW_UNLIMITED: '0' });
  assert.equal(envOff.gates.tokenCap, 8_000_000, 'env 明确关 → 压过文件里的开');
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.equal(resolve(undefined, { MYTERMINAL_WORKFLOW_UNLIMITED: on }).gates.tokenCap, null, `${on} = 开`);
  }
  for (const junk of ['', 'maybe', '2']) {
    assert.equal(resolve(undefined, { MYTERMINAL_WORKFLOW_UNLIMITED: junk }).gates.tokenCap, 8_000_000, `${JSON.stringify(junk)} 不是开`);
  }
});

test('AC1 开了不限制仍不越硬顶：并发窗口与 agentCap 的顶是钉死的', () => {
  const { gates } = resolve({ unlimited: true, concurrencyWindow: 600, agentCap: 600 });
  assert.equal(gates.tokenCap, null);
  assert.equal(gates.concurrencyWindow, 64);
  assert.equal(gates.agentCap, 600, 'agentCap 未越 10,000，照值生效');
});

// ═══════════════════════════════════════════════════════════════
// AC3 键名集中登记 + 设置节不含端点字段
// ═══════════════════════════════════════════════════════════════

test('AC3 键名集中登记：口径覆盖闸门 / 并发窗口 / worktree 配额 / 保留数 / 汇总体配额', () => {
  const groups = Object.fromEntries(WORKFLOW_SETTING_KEYS.map((key) => [key.name, key.group]));
  assert.deepEqual(groups, {
    tokenCap: 'gate',
    unlimited: 'gate',
    runGateMinutes: 'gate',
    agentCap: 'gate',
    concurrencyWindow: 'window',
    dispatchWindowMinutes: 'dispatch',
    dispatchTurns: 'dispatch',
    stallSeconds: 'dispatch',
    waitChunkSeconds: 'reducer',
    reducerBudgetMinutes: 'reducer',
    reducerTimeoutMinutes: 'reducer',
    keepQuotaCount: 'worktree-quota',
    keepQuotaBytes: 'worktree-quota',
    archiveAfterDays: 'worktree-quota',
    autoArchive: 'worktree-quota',
    snapshotRetain: 'retention',
    terminalRunRetain: 'retention',
    reducerQuota: 'reducer',
  });
  const names = WORKFLOW_SETTING_KEYS.map((key) => key.name);
  const envs = WORKFLOW_SETTING_KEYS.map((key) => key.env);
  const fields = WORKFLOW_SETTING_KEYS.map((key) => key.field);
  assert.equal(new Set(names).size, names.length, '键名不重复');
  assert.equal(new Set(envs).size, envs.length, 'env 名不重复');
  assert.equal(new Set(fields).size, fields.length, 'TUI 字段名不重复');
  for (const key of WORKFLOW_SETTING_KEYS) {
    assert.match(key.env, /^MYTERMINAL_WORKFLOW_[A-Z0-9_]+$/, `${key.name} 的 env 名照仓库惯例`);
    assert.match(key.field, /^wf-[a-z0-9-]+$/, `${key.name} 的 TUI 字段名照既有短横线惯例`);
  }
});

test('AC3 每一个运行时闸门值都由某个登记键管着，且登记默认值 = 默认闸（一份账）', () => {
  const managed = new Set(WORKFLOW_SETTING_KEYS.map((key) => key.gate));
  assert.deepEqual([...managed].sort(), Object.keys(DEFAULT_GATES).filter((name) => name !== 'reduceSlackMs').sort(), '除那条常量余量外，每个闸门值都由某个登记键管着');
  const round = resolve(DEFAULT_WORKFLOW_SETTINGS, {}, 8);
  assert.deepEqual(round.gates, defaultWorkflowGates(8), '设置面默认值换算后就是运行时默认闸');
  assert.deepEqual(round.warnings, []);
});

test('AC3 设置节不含端点字段：登记表与端点三元组零交集，混进来一律点名拒', () => {
  assert.deepEqual([...ENDPOINT_FIELD_NAMES].sort(), ['apiKey', 'baseUrl', 'endpoint', 'model']);
  const registered = [...WORKFLOW_SETTING_KEYS.map((k) => k.name), ...WORKFLOW_SETTING_KEYS.map((k) => k.field)];
  for (const endpoint of ENDPOINT_FIELD_NAMES) {
    assert.equal(registered.some((name) => name.toLowerCase() === endpoint.toLowerCase()), false, `${endpoint} 不得成为 workflows 设置键`);
  }
  assert.deepEqual(endpointClashInWorkflowSection({ tokenCap: 1, runGateMinutes: 30 }), []);
  assert.deepEqual(endpointClashInWorkflowSection({ baseUrl: 'https://x', model: 'm', apiKey: 'k' }).sort(), ['apiKey', 'baseUrl', 'model']);
});

test('AC3 设置节归一化：类型不符 / 未知键 / 端点字段都报错，越顶 clamp 后放行', () => {
  const clean = normalizeWorkflowSettings({ tokenCap: 5000, unlimited: true, concurrencyWindow: 12 });
  assert.deepEqual(clean.errors, []);
  assert.deepEqual(clean.value, { tokenCap: 5000, unlimited: true, concurrencyWindow: 12 }, '合法段原样留下（additive，不静默增删）');

  const junk = normalizeWorkflowSettings({ tokenCap: 'many', unlimited: 'yes', runGateMinutes: 1.5 });
  assert.ok(junk.errors.some((e) => e.includes('tokenCap')), '非整数报键名');
  assert.ok(junk.errors.some((e) => e.includes('unlimited')), '开关不是布尔也报');
  assert.ok(junk.errors.some((e) => e.includes('runGateMinutes')), '小数不是整数');

  const unknown = normalizeWorkflowSettings({ tokenCapFloor: 10 });
  assert.equal(unknown.errors.length, 1, '未知键不许静默通过（typo 会静默失效）');
  assert.match(unknown.errors[0], /tokenCapFloor/);

  const endpoint = normalizeWorkflowSettings({ baseUrl: 'https://x' });
  assert.ok(endpoint.errors.some((e) => /endpoint/i.test(e) && e.includes('baseUrl')), '端点字段进 workflows 节 = 拒');

  const over = normalizeWorkflowSettings({ agentCap: 100_000, concurrencyWindow: 999 });
  assert.deepEqual(over.errors, []);
  assert.equal(over.value.agentCap, 10_000, '归一化即压回硬顶（与运行期同口径）');
  assert.equal(over.value.concurrencyWindow, 64);
  assert.equal(over.clamped.length, 2, '压顶要留名');

  const under = normalizeWorkflowSettings({ concurrencyWindow: 1 });
  assert.equal(under.value.concurrencyWindow, 2, '下限同口径');
});

// ═══════════════════════════════════════════════════════════════
// AC4 时钟嵌套不变量（含有效余量）
// ═══════════════════════════════════════════════════════════════

test('AC4 默认值满足严格嵌套，且每一层都留出 ≥ reduceSlack 的有效余量', () => {
  assert.deepEqual(validateClockNesting(DEFAULT_GATES), { ok: true });
  const slack = REDUCE_SLACK_MS;
  assert.equal(DEFAULT_GATES.reducerBudgetMs - DEFAULT_GATES.runGateMs, slack, 'runGate → reducerBudget 余量恰为 slack');
  assert.equal(DEFAULT_GATES.reducerTimeoutMs - DEFAULT_GATES.reducerBudgetMs, slack, 'budget → timeoutSec 余量恰为 slack');
  assert.ok(DEFAULT_GATES.runGateMs - DEFAULT_GATES.dispatchWindowMs > slack, '逐路 → 墙钟留的比 slack 还多');
  assert.ok(DEFAULT_GATES.runGateMs - DEFAULT_GATES.stallMs > slack, 'stall → 墙钟同理');
  assert.ok(DEFAULT_GATES.dispatchWindowMs > DEFAULT_GATES.stallMs, '同层两钟也在序上（逐路窗 > 无进展窗）');
});

test('AC4 违例构造：内层顶穿外层（逐路顶墙钟）→ 点名报哪一对、上限是多少', () => {
  const punched = validateClockNesting({ ...DEFAULT_GATES, dispatchWindowMs: 30 * 60 * 1000 - 1_000 });
  assert.equal(punched.ok, false);
  assert.equal(punched.violations.length, 1);
  assert.deepEqual(punched.violations[0], {
    inner: 'dispatchWindow',
    outer: 'runGate',
    innerMs: 30 * 60 * 1000 - 1_000,
    outerMs: DEFAULT_GATES.runGateMs,
    slackMs: REDUCE_SLACK_MS,
    maxAllowedMs: DEFAULT_GATES.runGateMs - REDUCE_SLACK_MS,
  });
});

test('AC4 违例构造：外层被调小、同层多对一起越界都逐条列名（不合并、不静默挑一个）', () => {
  const runGateRaised = validateClockNesting({ ...DEFAULT_GATES, runGateMs: 60 * 60 * 1000 });
  assert.equal(runGateRaised.ok, false);
  assert.deepEqual(runGateRaised.violations.map((v) => `${v.inner}>${v.outer}`), ['runGate>reducerBudget']);

  const budgetRaised = validateClockNesting({ ...DEFAULT_GATES, reducerBudgetMs: 45 * 60 * 1000 });
  assert.deepEqual(budgetRaised.violations.map((v) => `${v.inner}>${v.outer}`), ['reducerBudget>reducerTimeout']);

  const stallPunched = validateClockNesting({ ...DEFAULT_GATES, stallMs: 29 * 60 * 1000 });
  assert.deepEqual(stallPunched.violations.map((v) => `${v.inner}>${v.outer}`), ['stall>runGate']);

  const both = validateClockNesting({ ...DEFAULT_GATES, stallMs: 29 * 60 * 1000, dispatchWindowMs: 29 * 60 * 1000 });
  assert.deepEqual(both.violations.map((v) => `${v.inner}>${v.outer}`).sort(), ['dispatchWindow>runGate', 'stall>runGate']);

  const allOut = validateClockNesting({ ...DEFAULT_GATES, runGateMs: 200 * 60 * 1000, reducerBudgetMs: 201 * 60 * 1000, reducerTimeoutMs: 202 * 60 * 1000 });
  assert.deepEqual(allOut.violations.map((v) => `${v.inner}>${v.outer}`), ['runGate>reducerBudget', 'reducerBudget>reducerTimeout']);
});

test('AC4 越硬顶不双重收费：clamp 在先，校验只对最终值判一次', () => {
  const { gates } = resolve({ dispatchWindowMinutes: 4000, reducerBudgetMinutes: 4000, reducerTimeoutMinutes: 4000 });
  assert.equal(gates.dispatchWindowMs, 100 * 60 * 1000, '逐路时间界被压到硬顶 100 分钟');
  assert.equal(gates.reducerBudgetMs, 4000 * 60 * 1000, '预算本身没有硬顶，照值');
  assert.equal(gates.reducerTimeoutMs, 4000 * 60 * 1000);
  const check = validateClockNesting(gates);
  assert.equal(check.ok, false);
  assert.deepEqual(check.violations.map((v) => `${v.inner}>${v.outer}`).sort(), ['dispatchWindow>runGate', 'reducerBudget>reducerTimeout']);
});

test('AC4 恰等号放行：内层 = 外层 − reduceSlack 是允许的边界（实现口径钉死）', () => {
  assert.deepEqual(validateClockNesting({ ...DEFAULT_GATES, dispatchWindowMs: DEFAULT_GATES.runGateMs - REDUCE_SLACK_MS }), { ok: true });
});

test('AC4 违例归因文案单源：启动校验与工具面报错读同一份', () => {
  const { violations } = validateClockNesting({ ...DEFAULT_GATES, dispatchWindowMs: 29 * 60 * 1000 });
  const text = describeClockNesting(violations);
  assert.match(text, /dispatchWindow \(1740000ms\) must stay at least 300000ms below runGate \(1800000ms\); allowed max 1500000ms/);
  assert.equal(violations.length, 1);
});

test('AC4 reduceSlack 是常量不是旋钮：设置面与 env 都摸不到它', () => {
  assert.equal(DEFAULT_GATES.reduceSlackMs, REDUCE_SLACK_MS, '默认闸带的就是那条钉死余量');
  assert.equal(WORKFLOW_SETTING_KEYS.some((k) => /slack/i.test(`${k.name}${k.env}${k.field}${k.gate}`)), false, '登记表里没有 slack 键');
  const tried = resolve({ reduceSlackMinutes: 1 }, { MYTERMINAL_WORKFLOW_REDUCE_SLACK_MINUTES: '1' });
  assert.equal(tried.gates.reduceSlackMs, REDUCE_SLACK_MS, '未知键进不了闸门');
  assert.equal(normalizeWorkflowSettings({ reduceSlackMinutes: 1 }).errors.length, 1, '想调它 = 未知键报错');
});

test('AC4 虚拟钟要缩就整栈一起缩：单层调参会被嵌套校验拒掉（既有票的用例口径）', () => {
  const oneSecond = { ...DEFAULT_GATES, runGateMs: 1000 };
  assert.equal(validateClockNesting(oneSecond).ok, false, '只把墙钟缩到 1 秒 = 逐路顶穿它');
  const scaled = {
    ...oneSecond,
    dispatchWindowMs: 300,
    stallMs: 100,
    reducerBudgetMs: 2000,
    reducerTimeoutMs: 3000,
    reduceSlackMs: 100,
  };
  assert.deepEqual(validateClockNesting(scaled), { ok: true });
});
