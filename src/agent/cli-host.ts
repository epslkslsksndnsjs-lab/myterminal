// M2：原生 TUI 宿主——min-agent cli.ts 的形状：输入 → runAgent → 事件 → 渲染。
// 旧 server/TUI 路径不受影响；本模块是 `myterminal run` 子命令的实现。

import type { Terminal } from '../nativetui/terminal.js';
import type { SubagentSettings } from '../types.js';
import type { LlmAdapter } from '../subagent/llm-adapter.js';
import { createAdapter } from '../subagent/llm-adapter.js';
import { defaultContext } from '../subagent/context.js';
import { getAgentOutputDir } from '../subagent/output-dir.js';
import { createBootScreen, type BootScreen } from '../nativetui/boot/screen.js';
import { AgentEventAdapter } from '../nativetui/event-adapter.js';
import { ProcessTerminal } from '../nativetui/terminal.js';
import type { AgentContext, AgentLoopOptions, ToolSchema } from './loop.js';
import { runAgent } from './loop.js';
import { buildAgentSystemPrompt } from './system-prompt.js';
import type { AgentEvent } from '../nativetui/events.js';

export type RunHostOptions = {
  settings: SubagentSettings;
  cwd: string;
  /** 测试/冒烟注入：不进入真实终端。 */
  terminal?: Terminal;
  /** 测试/冒烟注入：替代真实 LLM loop。 */
  runAgentImpl?: (options: AgentLoopOptions) => AsyncGenerator<AgentEvent>;
  /** 测试注入 LLM 通道（缺省由 settings 建适配器）。 */
  adapter?: LlmAdapter;
  toolSchemas?: ToolSchema[];
  wordmark?: string;
  startHint?: string;
  agentId?: string;
};

/** 会话句柄：测试通过它驱动输入、等待轮次结束、退出。 */
export type NativeSession = {
  boot: BootScreen;
  context: AgentContext;
  /** 当前轮结束（或从未开始）时 resolve。 */
  idle(): Promise<void>;
  /** 退出 TUI；`exited` 随后 resolve。 */
  quit(): void;
  exited: Promise<void>;
};

const SYSTEM_AGENT_ID = 'main';

/**
 * 组装原生 TUI 会话。会话是临时的：不落盘，不参与 store 的子代理记录。
 */
export function createNativeSession(options: RunHostOptions): NativeSession {
  const { settings, cwd } = options;
  const agentId = options.agentId ?? SYSTEM_AGENT_ID;
  const adapter = options.adapter ?? createAdapter(settings);

  const context: AgentContext = {
    system: buildAgentSystemPrompt({ cwd }),
    messages: [],
  };

  const terminal = options.terminal ?? new ProcessTerminal();
  const boot = createBootScreen(terminal, {
    model: settings.model,
    cwd,
    wordmark: options.wordmark ?? 'myterminal',
    startHint: options.startHint ?? 'type to start',
  });
  terminal.setTitle('myterminal');
  defaultContext.outputDirs.set(agentId, getAgentOutputDir(cwd, agentId));

  const { tui, input } = boot;
  const events = new AgentEventAdapter(boot.transcript, () => tui.requestRender(), input, boot.footer);

  let busy = false;
  let ctrl: AbortController | null = null;
  let idleWaiters: Array<() => void> = [];
  let resolveExited: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });

  const quit = () => {
    ctrl?.abort();
    tui.stop();
    resolveExited();
  };

  const settleIdle = () => {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  // Runtime: Ctrl+C / Escape aborts the turn. Idle: it exits, since raw mode
  // swallows the signal and there is nothing else to cancel.
  input.onEscape = () => {
    if (ctrl) ctrl.abort();
    else quit();
  };

  const runner = options.runAgentImpl ?? runAgent;

  input.onSubmit = (text) => {
    if (busy) return; // 单轮串行：运行中忽略提交（与 min-agent 一致）
    void runTurn(text);
  };

  async function runTurn(text: string): Promise<void> {
    busy = true;
    events.submit(text);
    context.messages.push({ role: 'user', content: [{ type: 'text', text }] });
    ctrl = new AbortController();
    try {
      const source = runner({
        adapter,
        model: settings.model,
        context,
        cwd,
        agentId,
        signal: ctrl.signal,
        maxTurns: settings.maxTurns,
        maxTokens: settings.maxOutput,
        compactThreshold: settings.compactThreshold,
        fallbackModel: settings.fallbackModel,
        ...(options.toolSchemas ? { toolSchemas: options.toolSchemas } : {}),
      });
      for await (const ev of source) {
        if (ev.type === 'turn_end' && ev.stopReason === 'max_tokens') {
          events.handle({ type: 'assistant_text', delta: '\n[output truncated by max_tokens]' });
        }
        events.handle(ev);
      }
    } catch (err) {
      events.handle({ type: 'assistant_text', delta: `\n[error] ${(err as Error).message}` });
    } finally {
      ctrl = null;
      busy = false;
      settleIdle();
    }
  }

  return {
    boot,
    context,
    idle: () =>
      new Promise<void>((resolve) => {
        if (!busy) return resolve();
        idleWaiters.push(resolve);
      }),
    quit,
    exited,
  };
}

/** 启动原生 TUI 对话；promise 在 TUI 退出时 resolve。 */
export async function runNativeTui(options: RunHostOptions): Promise<void> {
  const session = createNativeSession(options);
  session.boot.tui.start();
  await session.exited;
}
