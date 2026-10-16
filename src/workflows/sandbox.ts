import vm from 'node:vm';
import { runParallel, runPipeline } from './fanout.js';

/**
 * 脚本执行面——脚本在 vm 里跑，宿主对象一个都不过界。
 *
 * 四条边界：
 *   1. 进出 vm 的数据只走 JSON 复活（args 进、每路返回值逐槽出），杜绝跨 realm 引用；
 *   2. 沙箱内没有 Date、没有 Math.random——非确定性调用在源头就不可达；
 *   3. 一切 I/O 只能经注入的 agent()/parallel()/pipeline()/workflow()，
 *      脚本拿不到 fs / 网络 / 环境变量 / 消息面；
 *   4. 出向数据在 vm realm 内**逐槽**复活：某一路交回不可序列化的东西，
 *      只有那一槽变 null，不连坐兄弟。
 * 头部 `export const meta` 在执行前剥掉（真脚本都带它），只按括号行走定位，
 * 绝不求值；括号不平衡即拒——静默截断是最坏的失败模式。
 */

export type AgentCall = (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;

export type SandboxHost = {
  agent: AgentCall;
  /** 只有顶层脚本拿得到；嵌套时刻意不注入，第二层即 reject。 */
  workflow?: (name: unknown, args?: unknown, opts?: unknown) => Promise<unknown>;
  budget?: { total: number | null; spent(): number; remaining(): number };
  log?: (message: string) => void;
  phase?: (title: string) => void;
};

export type SandboxOutcome =
  | { ok: true; value: unknown; logs: string[]; phases: string[] }
  | { ok: false; kind: 'compile' | 'runtime' | 'timeout'; message: string; logs: string[]; phases: string[] };

function throwOnlyDate(): unknown {
  const fail = () => { throw new Error('Date is not available inside a workflow script; it breaks replay determinism.'); };
  const DateShim = function DateShim(this: unknown) { fail(); } as unknown as Record<string, unknown>;
  DateShim.now = fail;
  DateShim.parse = fail;
  DateShim.UTC = fail;
  return DateShim;
}

function safeMath(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(Math)) {
    if (key === 'random' || key === 'constructor') continue;
    out[key] = (Math as unknown as Record<string, unknown>)[key];
  }
  out.random = () => { throw new Error('Math.random() is not available inside a workflow script; it breaks replay determinism.'); };
  return out;
}

/** 出 vm 的值：在宿主侧做一次 JSON 复活，跨 realm 的对象引用到此为止。 */
function revive(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

type WalkMode = 'code' | 'single' | 'double' | 'template' | 'line' | 'block';

/**
 * 定位 `export const meta = {…}` 的收尾括号：注释与三类字符串跳过，
 * 模板里的 `${}` 压栈按嵌套代码计——插值内的 `}` 属于模板体，不算块的收尾。
 * 找不到配对即抛，绝不半截剥掉（静默截断是最坏的失败模式）。
 */
export function findMetaBlockEnd(source: string, opening: number): number {
  let depth = 0;
  let i = opening;
  let mode: WalkMode = 'code';
  /** 模板插值栈：记下回到模板体时应处的深度。 */
  const interpolation: number[] = [];
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; i += 2; continue; }
      if (ch === "'") { mode = 'single'; i += 1; continue; }
      if (ch === '"') { mode = 'double'; i += 1; continue; }
      if (ch === '`') { mode = 'template'; i += 1; continue; }
      if (ch === '{') { depth += 1; i += 1; continue; }
      if (ch === '}') {
        depth -= 1;
        i += 1;
        if (interpolation.length > 0 && depth === interpolation[interpolation.length - 1]) {
          interpolation.pop();
          mode = 'template';
          continue;
        }
        if (depth === 0) return i;
        if (depth < 0) throw new Error('Workflow script has an unbalanced export const meta block.');
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (ch === '\n') mode = 'code';
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue; }
      i += 1;
      continue;
    }
    if (ch === '\\') { i += 2; continue; }
    if (mode === 'template') {
      if (ch === '$' && next === '{') { interpolation.push(depth); mode = 'code'; depth += 1; i += 2; continue; }
      if (ch === '`') { mode = 'code'; i += 1; continue; }
      i += 1;
      continue;
    }
    if ((mode === 'single' && ch === "'") || (mode === 'double' && ch === '"')) mode = 'code';
    i += 1;
  }
  throw new Error('Workflow script has an unbalanced export const meta block.');
}

const META_HEAD = /^\s*export\s+const\s+meta\s*=\s*\{/;

/** 剥掉头部的 meta 块：整段抹成等长空白，行号与列号一律不动。 */
export function stripWorkflowMeta(source: string): string {
  const match = META_HEAD.exec(source);
  if (!match) return source;
  const opening = match.index + match[0].length - 1;
  const end = findMetaBlockEnd(source, opening);
  const head = source.slice(0, end);
  const blanked = head.replace(/[^\n]/g, ' ');
  // 尾随的可选分号一起吃掉，免得留下 " ;" 这种无害但难看的行首。
  const rest = source.slice(end);
  const withSemicolon = /^\s*;/.test(rest) ? rest.replace(/^\s*;/, (m) => ' '.repeat(m.length)) : rest;
  return blanked + withSemicolon;
}

/**
 * 沙箱内的注入体。刻意全部写在**一行**上：用户脚本因此从第 2 行起，
 * 行号偏移恒为 1，编译/运行错误回显的行号才对得上脚本本身。
 * 体内不得出现反引号与模板插值（沙箱禁 codeGeneration.strings，注入体也不给自己留口子）。
 */
const PRELUDE_STATEMENTS = [
  "'use strict'",
  'const __b = globalThis.__workflowBridge',
  'const args = JSON.parse(globalThis.__workflowArgs)',
  'delete globalThis.__workflowBridge',
  'delete globalThis.__workflowArgs',
  'const revive = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value))',
  'const reviveSlot = (value, where) => { let out; try { out = revive(value); } catch (error) { __b.log("unserializable " + where); out = null; } return out; }',
  'const reviveList = (list, where) => list.map((slot, index) => reviveSlot(slot, where + " " + index))',
  'const agent = (prompt, opts) => Promise.resolve().then(() => __b.agent(prompt, opts === undefined || opts === null ? undefined : revive(opts))).then((value) => reviveSlot(value, "agent() result"))',
  'const parallel = (thunks) => Promise.resolve().then(() => __b.parallel(thunks)).then((out) => reviveList(out, "parallel() slot"))',
  'const pipeline = (items, ...stages) => Promise.resolve().then(() => __b.pipeline(items, stages)).then((out) => reviveList(out, "pipeline() slot"))',
  'const workflow = typeof __b.workflow === "function" ? (name, nestedArgs, opts) => Promise.resolve().then(() => __b.workflow(name, nestedArgs, opts)).then((value) => reviveSlot(value, "workflow() result")) : () => Promise.reject(new Error("workflow() is not available inside a nested workflow script: nesting is limited to one level."))',
  'const budget = typeof __b.budgetSpent === "function" ? { total: __b.budgetTotal, spent: () => __b.budgetSpent(), remaining: () => __b.budgetRemaining() } : { total: null, spent: () => { throw new Error("budget is not wired for this script"); }, remaining: () => { throw new Error("budget is not wired for this script"); } }',
  'const log = (message) => __b.log(typeof message === "string" ? message : String(message))',
  'const phase = (title) => __b.phase(typeof title === "string" ? title : String(title))',
  'const console = { log, warn: log, error: log }',
  'return (async () => {',
];

/** 拼出沙箱内的一次执行体：meta 已抹平，脚本首行落在第 2 行（偏移恒 1）。 */
export function buildSandboxSource(source: string): string {
  return `(() => { ${PRELUDE_STATEMENTS.join('; ')}\n${source}\n})();\n})()`;
}

export async function runInSandbox(options: {
  source: string;
  args?: unknown;
  host: SandboxHost;
  /** 同步段硬上限（只杀死循环）；异步段由宿主自己的时钟兜底。 */
  timeoutMs?: number;
}): Promise<SandboxOutcome> {
  const logs: string[] = [];
  const phases: string[] = [];
  const log = (message: string) => {
    const text = typeof message === 'string' ? message : String(message);
    logs.push(text);
    options.host.log?.(text);
  };
  const phase = (title: string) => {
    const text = typeof title === 'string' ? title : String(title);
    if (phases[phases.length - 1] !== text) phases.push(text);
    options.host.phase?.(text);
  };

  let argsJson = 'null';
  try {
    argsJson = JSON.stringify(options.args ?? null);
  } catch {
    argsJson = 'null';
  }

  const bridge: Record<string, unknown> = {
    agent: options.host.agent,
    log,
    phase,
    // 扇出语义是脚本面的一部分，由模块自带：宿主只需交出 agent() 这一条 I/O 缝。
    parallel: async (thunks: unknown) => await runParallel(thunks),
    pipeline: async (items: unknown, stages: unknown[]) => await runPipeline(items, stages),
  };
  if (options.host.workflow) bridge.workflow = options.host.workflow;
  const budget = options.host.budget;
  if (budget) {
    bridge.budgetTotal = budget.total;
    bridge.budgetSpent = () => budget.spent();
    bridge.budgetRemaining = () => budget.remaining();
  }

  const sandbox: Record<string, unknown> = {
    __workflowBridge: bridge,
    __workflowArgs: argsJson,
    Math: safeMath(),
    Date: throwOnlyDate(),
  };
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

  let prepared: string;
  try {
    prepared = stripWorkflowMeta(options.source);
  } catch (error) {
    return { ok: false, kind: 'compile', message: (error as Error).message, logs, phases };
  }

  let script: vm.Script;
  try {
    script = new vm.Script(buildSandboxSource(prepared), { filename: 'workflow.js' });
  } catch (error) {
    return { ok: false, kind: 'compile', message: (error as Error).message, logs, phases };
  }

  let running: Promise<unknown>;
  try {
    running = Promise.resolve(script.runInContext(sandbox, { timeout: options.timeoutMs ?? 30_000 }) as Promise<unknown>);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 惰性解析的引擎（bun 1.3.x 的 vm）把语法错推迟到 runInContext 才同步抛出——
    // SyntaxError 一律按编译面归类，不随引擎的解析时机漂移。
    const kind = code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || code === 'ERR_SCRIPT_EXECUTION_INTERRUPTED'
      ? 'timeout'
      : (error as Error)?.name === 'SyntaxError'
        ? 'compile'
        : 'runtime';
    return { ok: false, kind, message: (error as Error).message, logs, phases };
  }

  try {
    const value = await running;
    return { ok: true, value: revive(value), logs, phases };
  } catch (error) {
    return { ok: false, kind: 'runtime', message: (error as Error)?.message ?? String(error), logs, phases };
  }
}
