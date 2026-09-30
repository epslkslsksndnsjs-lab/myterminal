import vm from 'node:vm';

/**
 * 脚本执行面——脚本在 vm 里跑，宿主对象一个都不过界。
 *
 * 三条边界：
 *   1. 进出 vm 的数据只走 JSON 复活（args 进、返回值出），杜绝跨 realm 引用；
 *   2. 沙箱内没有 Date、没有 Math.random——非确定性调用在源头就不可达；
 *   3. 一切 I/O 只能经注入进来的 agent()（模型侧），脚本拿不到 fs / 网络 / 环境变量。
 */

export type AgentCall = (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;

export type SandboxHost = {
  agent: AgentCall;
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

  const bridge = {
    agent: async (prompt: string, opts?: Record<string, unknown>) => await options.host.agent(prompt, opts),
    parallel: async (items: Array<() => Promise<unknown>>) => {
      if (!Array.isArray(items)) throw new Error('parallel() expects an array of thunks.');
      return await Promise.all(items.map((item) => Promise.resolve().then(item)));
    },
    log,
    phase,
  };

  const sandbox: Record<string, unknown> = {
    __bridge: bridge,
    __argsJson: argsJson,
    Math: safeMath(),
    Date: throwOnlyDate(),
    console: { log, warn: log, error: log },
  };
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

  // 首行固定，行号偏移恒为 1——编译错误回显按此折算。
  const init = `(() => {\n'use strict';\nconst {agent, parallel, log, phase} = __bridge;\nconst args = JSON.parse(__argsJson);\ndelete globalThis.__bridge;\ndelete globalThis.__argsJson;\nreturn (async () => {\n${options.source}\n})();\n})()`;

  let script: vm.Script;
  try {
    script = new vm.Script(init, { filename: 'workflow.js' });
  } catch (error) {
    return { ok: false, kind: 'compile', message: (error as Error).message, logs, phases };
  }

  let running: Promise<unknown>;
  try {
    running = Promise.resolve(script.runInContext(sandbox, { timeout: options.timeoutMs ?? 30_000 }) as Promise<unknown>);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const kind = code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || code === 'ERR_SCRIPT_EXECUTION_INTERRUPTED' ? 'timeout' : 'runtime';
    return { ok: false, kind, message: (error as Error).message, logs, phases };
  }

  try {
    const value = await running;
    return { ok: true, value: revive(value), logs, phases };
  } catch (error) {
    return { ok: false, kind: 'runtime', message: (error as Error)?.message ?? String(error), logs, phases };
  }
}
