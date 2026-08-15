// ADR-0032 批5 #38：SessionResourceManager 统一 agent/session 作用域资源的注册与清理
//
// 背景：agent 资源清理散落在 executor.finally 的硬编码列表（cleanupAgentShellTasks /
// clearFileState / resetReplacementDecisions），session 资源散落在 server.ts 与 core-tools.ts
// 多处直接调用（reapSessionResources / disarmSessionResources / disarmAllSessionResources）。
// 新增资源类型时极易漏改控制循环。
//
// 本模块将"注册"与"收口"集中：新增资源类型只需在下方单例 registerXxx 一处登记，
// 控制循环（finally / 启动 / session 结束 / 退出）统一走 disposeAgent / reap / disposeSession /
// disarmAll，不再硬编码列表。
//
// 行为铁律：本类仅为原直调的 1:1 透传——
//   · 不做异常吞没（disposeAgent 内不包 try/catch，与现状 finally 一致：某清理抛错即向上传播）；
//   · 注册顺序即执行顺序（与现状 finally 的 ①②③ 顺序一致）；
//   · 不改变任何清理函数的入参/语义。

import type { MyTerminalConfig } from './types.js';
import { cleanupAgentShellTasks } from './subagent/shell-tracker.js';
import { clearFileState } from './subagent/file-state.js';
import { resetReplacementDecisions } from './subagent/result-budget.js';
import { cleanupAgentOutputDir } from './subagent/output-dir.js';
import { cleanupSubagentRecord } from './subagent/store.js';
import {
  disarmSessionResources,
  disarmAllSessionResources,
  reapSessionResources,
} from './session-resources.js';

export type AgentDisposer = (agentId: string) => void;
export type SessionDisposer = (config: MyTerminalConfig, sessionId: string) => void;
export type GlobalDisposer = (config: MyTerminalConfig) => void;

interface NamedDisposer<T extends (...args: never[]) => void> {
  name: string;
  dispose: T;
}

export class SessionResourceManager {
  private readonly agentDisposers: NamedDisposer<AgentDisposer>[] = [];
  private readonly sessionDisposers: NamedDisposer<SessionDisposer>[] = [];
  private readonly globalDisposers: NamedDisposer<GlobalDisposer>[] = [];

  registerAgentResource(name: string, dispose: AgentDisposer): void {
    this.agentDisposers.push({ name, dispose });
  }

  registerSessionResource(name: string, dispose: SessionDisposer): void {
    this.sessionDisposers.push({ name, dispose });
  }

  registerGlobalResource(name: string, dispose: GlobalDisposer): void {
    this.globalDisposers.push({ name, dispose });
  }

  /** 只读：已注册的 agent 资源名（顺序即执行顺序）。供审计与锁定测试。 */
  agentResourceNames(): string[] {
    return this.agentDisposers.map((d) => d.name);
  }

  /** 决策 8：清理顺序固定 = 注册顺序。无 try/catch，与现状 finally 一致。 */
  disposeAgent(agentId: string): void {
    for (const { dispose } of this.agentDisposers) {
      dispose(agentId);
    }
  }

  /** session 结束（phase completed/cancelled）时收口该 session 资源。 */
  disposeSession(config: MyTerminalConfig, sessionId: string): void {
    for (const { dispose } of this.sessionDisposers) {
      dispose(config, sessionId);
    }
  }

  /** 服务启动：回收遗留的 stale session 资源（原 reapSessionResources）。 */
  reap(config: MyTerminalConfig): void {
    const d = this.globalDisposers.find((x) => x.name === 'reap');
    if (d) d.dispose(config);
  }

  /** 进程退出/整体关闭：解除全部 session 资源（原 disarmAllSessionResources）。 */
  disarmAll(config: MyTerminalConfig): void {
    const d = this.globalDisposers.find((x) => x.name === 'disarm-all');
    if (d) d.dispose(config);
  }
}

// ── 生产单例：集中登记全部 agent/session 作用域资源 ──

export const sessionResourceManager = new SessionResourceManager();

// agent 作用域（executor.finally 原 3 项 + #152 收口 ④ + #143 收口 ⑤，注册顺序即执行顺序）
sessionResourceManager.registerAgentResource('agent-shell-tasks', cleanupAgentShellTasks);
sessionResourceManager.registerAgentResource('file-state', clearFileState);
sessionResourceManager.registerAgentResource('replacement-decisions', (agentId) => resetReplacementDecisions(agentId));
sessionResourceManager.registerAgentResource('subagent-outputs', cleanupAgentOutputDir);
sessionResourceManager.registerAgentResource('subagent-records', (agentId) => cleanupSubagentRecord(agentId));

// session 作用域（session 结束收口）
sessionResourceManager.registerSessionResource('session-resources', (config, sessionId) =>
  disarmSessionResources(config, sessionId),
);

// global 作用域（启动回收 stale / 退出解除全部）
sessionResourceManager.registerGlobalResource('reap', (config) => reapSessionResources(config));
sessionResourceManager.registerGlobalResource('disarm-all', (config) => disarmAllSessionResources(config));
