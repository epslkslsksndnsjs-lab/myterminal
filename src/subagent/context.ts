// ADR-0032 批5 第2刀 #34：七全局单例收敛为可注入 context
// 本文件定义 SubagentContext 类型与工厂函数——后续所有 subagent 单测的地基
//
// 设计原则：
// - 各模块函数追加可选末参 ctx?: SubagentContext，缺省走 defaultContext（向后兼容）
// - 测试可创建多个隔离 context，同进程内互不干扰
// - 生产调用方零改动

import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { SubagentRecord } from './store.js';
import type { SubagentRunner } from './runner.js';

// ── FileState（file-state.ts 内部类型，此处公开供 context 持有）──

export interface FileState {
  content: string;
  timestamp: number;
}

// ── SubagentContext 类型 ──

/**
 * 可注入的 subagent 运行时上下文。
 * 收敛账目（#34 七项清单）：localTasks 已于批4 #47 删除，故实收 6 个
 * = 下方 5 个状态容器 + runner 装配单例。
 * 生产用 defaultContext；测试用 createSubagentContext() 创建隔离实例。
 */
export interface SubagentContext {
  /** store.ts — subagent 记录表（原模块级 subagents Map） */
  readonly subagents: Map<string, SubagentRecord>;

  /** file-state.ts — 按 agentId → filePath → FileState 双层隔离（原模块级 readFileStates） */
  readonly readFileStates: Map<string, Map<string, FileState>>;

  /** shell-tracker.ts — 按 agentId 追踪的 shell 子进程（原模块级 agentShellTasks） */
  readonly agentShellTasks: Map<string, Set<ChildProcess>>;

  /** shell-tracker.ts — backgroundId→{agentId,child} 索引（D8 第四轮修订：转后台命令查/杀句柄） */
  readonly backgroundTasks: Map<string, { agentId: string; child: ChildProcess }>;

  /** result-budget.ts — 跨 turn 冻结替换决策（原模块级 replacementDecisions） */
  readonly replacementDecisions: Map<string, 'full' | 'preview'>;

  /** tui-bridge.ts — AG-UI 事件总线（原模块级 subagentEvents EventEmitter） */
  readonly events: EventEmitter;

  /** runner.ts — SubagentRunner 装配实例（原模块级 let singleton），init 前为 null */
  runner: SubagentRunner | null;
}

// ── 工厂函数 ──

/**
 * 创建一个全新的隔离 SubagentContext。
 * 每次调用返回独立实例，同进程内可并行运行多个互不干扰的 subagent 系统。
 */
export function createSubagentContext(): SubagentContext {
  const events = new EventEmitter();
  events.setMaxListeners(50); // 与原 tui-bridge.ts 全局设置一致
  return {
    subagents: new Map(),
    readFileStates: new Map(),
    agentShellTasks: new Map(),
    backgroundTasks: new Map(),
    replacementDecisions: new Map(),
    events,
    runner: null,
  };
}

// ── 默认全局 context（向后兼容）──

/**
 * 模块级默认 context——生产路径与现有测试的 clearAll* 函数均操作此实例。
 * 所有模块函数的可选末参缺省时走这里。
 */
export const defaultContext: SubagentContext = createSubagentContext();
