// ADR-0008 决策 1：14 种 AG-UI 事件（不发 MESSAGES_SNAPSHOT）
// ADR-0008 决策 2：进程内 EventEmitter（同进程，不用 SSE/WebSocket）
// ADR-0008 决策 3：AG-UI @ag-ui/core 事件类型——本地声明，不装依赖
// ADR-0032 #34：EventEmitter 收敛到 SubagentContext，函数追加可选末参 ctx（缺省 defaultContext）

import { defaultContext } from './context.js';
import type { SubagentContext } from './context.js';

// ── 14 种事件类型（决策 1：AG-UI 16 种减去 MESSAGES_SNAPSHOT，再减去未使用的 TEXT_MESSAGE_START/TEXT_MESSAGE_END）──

export type AgUiEventType =
  | 'RUN_STARTED' | 'RUN_FINISHED' | 'RUN_ERROR'
  | 'TEXT_MESSAGE_START' | 'TEXT_MESSAGE_CONTENT' | 'TEXT_MESSAGE_END'
  | 'TOOL_CALL_START' | 'TOOL_CALL_ARGS' | 'TOOL_CALL_END' | 'TOOL_CALL_RESULT'
  | 'STATE_SNAPSHOT' | 'STATE_DELTA'
  | 'STEP_STARTED' | 'STEP_FINISHED';

// ── 事件结构 ──

export type AgUiEvent = {
  subagentId: string;
  type: AgUiEventType;
  data?: Record<string, unknown>;
  timestamp: number;
};

// ── 进程内 EventEmitter（ADR-0032 #34：移入 SubagentContext）──

/** 全局 subagent 事件总线——TUI 多组件监听（defaultContext.events，向后兼容） */
export const subagentEvents = defaultContext.events;

// ── 便捷发射函数 ──

/** 发射 AG-UI 事件到事件总线。executor 和 tool-executor 通过此函数或 onEvent 回调通信 */
export function emitAgUi(
  subagentId: string,
  type: AgUiEventType,
  data?: Record<string, unknown>,
  ctx: SubagentContext = defaultContext,
): void {
  ctx.events.emit('ag-ui', {
    subagentId,
    type,
    data,
    timestamp: Date.now(),
  } satisfies AgUiEvent);
}
