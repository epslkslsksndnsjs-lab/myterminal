import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// 时间指标回退阈值（主回归指标）
const TIME_THRESHOLD_PCT = 30;

// 直接走 PATH 上的 bun（setup-bun 已注入 PATH），跨平台一致；
// 不再硬编码 ~/.bun/bin/bun 绝对路径，避免 Windows runner 上路径不存在而崩溃。
const BUN = 'bun';

// 多次采样取中位数，抑制共享 CI runner 的噪声（单次采样在异构 runner 上抖动可达 ±30%+）
const ITERATIONS = 3;

const baselinePath = 'scripts/perf-baseline.json';
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

console.log('Running performance regression...');

function runOnce() {
  const out = execSync(`${BUN} scripts/performance-regression.mjs 2>/dev/null`, { encoding: 'utf8', cwd: process.cwd() });
  const jsonStart = out.indexOf('{');
  if (jsonStart === -1) throw new Error('No JSON found in performance-regression output');
  return JSON.parse(out.slice(jsonStart));
}

const samples = [];
for (let i = 0; i < ITERATIONS; i++) {
  samples.push(runOnce());
}

// 对嵌套指标（如 'history.elapsedMs'）取多次采样的中位数
function medianOf(key) {
  const vals = samples
    .map((s) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), s))
    .filter((v) => typeof v === 'number');
  if (vals.length === 0) return 0;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

const current = {
  history: { elapsedMs: medianOf('history.elapsedMs'), rssDeltaBytes: medianOf('history.rssDeltaBytes') },
  inbox: { elapsedMs: medianOf('inbox.elapsedMs'), rssDeltaBytes: medianOf('inbox.rssDeltaBytes') },
  tui: { snapshotMs: medianOf('tui.snapshotMs') },
  issue63: {
    context: { firstMs: medianOf('issue63.context.firstMs'), repeat50Ms: medianOf('issue63.context.repeat50Ms') },
    microCompact: { elapsedMs: medianOf('issue63.microCompact.elapsedMs') },
    timeline: { elapsedMs: medianOf('issue63.timeline.elapsedMs') },
  },
};

// 时间基准低于此值的指标视为微基准，测量噪声大，只做信息提示不阻断 CI
const NOISE_FLOOR_MS = 50;

function check(name, baseVal, curVal, higherIsWorse = true, isMemory = false, customThreshold = null, informational = false) {
  if (baseVal === 0) return { ok: true, warn: false, info: informational, name, base: baseVal, cur: curVal, pct: 0 };
  const pct = higherIsWorse ? ((curVal - baseVal) / baseVal) * 100 : ((baseVal - curVal) / baseVal) * 100;
  const threshold = customThreshold ?? TIME_THRESHOLD_PCT;
  // 内存指标、微基准（<50ms）只做信息提示，不计入失败（即使超阈值也不阻断 CI）
  const info = informational || isMemory || (higherIsWorse && baseVal < NOISE_FLOOR_MS);
  const ok = info ? true : pct <= threshold;
  const warn = isMemory && pct > 50;
  return { ok, warn, info, name, base: baseVal, cur: curVal, pct: Math.round(pct * 100) / 100 };
}

const checks = [
  // history - 时间指标 (主要回归指标)
  check('history.elapsedMs', baseline.history.elapsedMs, current.history.elapsedMs),
  // history - 内存指标（只警告）
  check('history.rssDeltaBytes', baseline.history.rssDeltaBytes, current.history.rssDeltaBytes, true, true),
  // inbox - 时间指标 (主要回归指标)
  check('inbox.elapsedMs', baseline.inbox.elapsedMs, current.inbox.elapsedMs),
  // inbox - 内存指标（只警告）
  check('inbox.rssDeltaBytes', baseline.inbox.rssDeltaBytes, current.inbox.rssDeltaBytes, true, true),
  // tui snapshot - 时间指标 (微基准 ~1ms，仅信息)
  check('tui.snapshotMs', baseline.tui.snapshotMs, current.tui.snapshotMs),
  // issue63: context - 时间指标 (主要)
  check('issue63.context.firstMs', baseline.issue63.context.firstMs, current.issue63.context.firstMs),
  // issue63: context.repeat50Ms - 微基准 ~14ms，仅信息
  check('issue63.context.repeat50Ms', baseline.issue63.context.repeat50Ms, current.issue63.context.repeat50Ms),
  // issue63: microCompact - 微基准 ~1ms，仅信息
  check('issue63.microCompact.elapsedMs', baseline.issue63.microCompact.elapsedMs, current.issue63.microCompact.elapsedMs),
  // issue63: timeline - 微基准 ~0.07ms，仅信息
  check('issue63.timeline.elapsedMs', baseline.issue63.timeline.elapsedMs, current.issue63.timeline.elapsedMs),
];

let anyFail = false;
let anyWarn = false;
console.log(`\n=== Performance Regression Check (median of ${ITERATIONS} samples) ===`);
for (const c of checks) {
  let mark = c.ok ? '✅' : '❌';
  if (c.info || c.warn) mark = 'ⓘ';
  const warnMark = c.warn ? ' ⚠️' : '';
  const infoMark = c.info ? ' (informational)' : '';
  console.log(`${mark} ${c.name}: baseline=${c.base} current=${c.cur} Δ=${c.pct}%${warnMark}${infoMark}`);
  if (!c.ok && !c.info && !c.warn) anyFail = true;
  if (c.warn) anyWarn = true;
}

if (anyWarn) {
  console.log('\n⚠️  Memory metrics exceeded 50% threshold (informational only)');
}

if (anyFail) {
  console.log('\n❌ PERFORMANCE REGRESSION DETECTED');
  process.exit(1);
} else {
  console.log('\n✅ All time metrics within threshold');
  process.exit(0);
}
