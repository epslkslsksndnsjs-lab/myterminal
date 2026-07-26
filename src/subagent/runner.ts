// M8：SubagentRunner——接入层控制面（ADR-0009 决策 1/2/7/10/11/12）
// 复用 delegate session + 后台 runSubagent + 三层通知链

import { randomUUID } from 'node:crypto';
import type { MyTerminalSession, SubagentSettings, TaskPackage } from '../types.js';
import type { runSubagent as RunSubagentFn } from './executor.js';
import type { SubagentRunResult } from './executor.js';
import {
  createSubagent, getSubagent, updateSubagentStatus, updateSubagentCost,
  collectSubagentResult, countRunning, getRecentAuditLogs, listAllSubagents,
} from './store.js';
import type { SubagentRecord, SubagentTask } from './store.js';
import type { UsageSummary } from './cost-tracker.js';

// ── 类型 ──

export type SubagentStartInput = {
  objective: string;
  background?: string;
  deliverables?: string[];
  acceptanceCriteria?: string[];
  constraints?: string[];
  provider?: 'openai' | 'anthropic' | 'deepseek';
  model?: string;
  maxTurns?: number;
  timeoutSec?: number;
  readOnly?: boolean;
};

/** 可注入依赖——生产用 store 真实实现，测试用 fake */
export type SubagentRunnerDeps = {
  runSubagentImpl: typeof RunSubagentFn;
  settings: SubagentSettings;
  workspaceDir: string;
  /** 发送消息给 parent session。内部走 callSubagent(message_send)。需要 child identity 用于认证 */
  notify: (childSessionId: string, childIdentity: { sessionId: string; sessionToken: string }, parentSessionId: string, body: string) => Promise<void>;
  /** checkpoint child session。内部走 callSubagent(session_checkpoint) */
  checkpoint: (childSessionId: string, childIdentity: { sessionId: string; sessionToken: string }, phase: string, summary: string) => Promise<void>;
  /** 创建并认领 delegate child session（等价 registerDelegate + claimFresh） */
  registerAndClaimChild: (parentId: string, args: { name: string; task: TaskPackage }) => {
    session: MyTerminalSession;
    identity: { sessionId: string; sessionToken: string };
  };
};

export type SubagentStatusResult = {
  status: string;
  sessionId?: string;
  tasks: SubagentTask[];
  cost: UsageSummary;
  error?: string;
  result?: string;
  auditLogs: unknown[];
};

export type SubagentStartResult = {
  sessionId: string;
  taskId: string;
  status: 'running';
};

// ── 辅助：组装任务文本 ──

function assembleTask(input: SubagentStartInput): string {
  const parts: string[] = [];
  parts.push(`## Objective\n${input.objective}`);
  if (input.background) parts.push(`## Background\n${input.background}`);
  if (input.deliverables?.length) parts.push(`## Deliverables\n${input.deliverables.map((d) => `- ${d}`).join('\n')}`);
  if (input.acceptanceCriteria?.length) parts.push(`## Acceptance Criteria\n${input.acceptanceCriteria.map((a) => `- ${a}`).join('\n')}`);
  if (input.constraints?.length) parts.push(`## Constraints\n${input.constraints.map((c) => `- ${c}`).join('\n')}`);
  return parts.join('\n\n');
}

/** 组装 TaskPackage（用于 registerDelegate）。background 不能为空，缺失时用 objective 前 100 字充填 */
function toTaskPackage(input: SubagentStartInput): TaskPackage {
  const bg = input.background?.trim() || input.objective.slice(0, 100);
  return {
    objective: input.objective,
    background: bg,
    deliverables: input.deliverables?.length ? input.deliverables : ['Complete the assigned task'],
    acceptanceCriteria: input.acceptanceCriteria?.length ? input.acceptanceCriteria : ['Task is complete'],
    constraints: input.constraints?.length ? input.constraints : ['Stay within scope'],
  };
}

// ── Runner 工厂 ──

export function createSubagentRunner(deps: SubagentRunnerDeps) {
  const { runSubagentImpl, settings, workspaceDir, notify, checkpoint, registerAndClaimChild } = deps;

  // 存储 child identities，供 notify/checkpoint 认证使用
  const childIdentities = new Map<string, { sessionId: string; sessionToken: string }>();

  async function finalize(
    agentId: string,
    childSessionId: string,
    parentSessionId: string,
    result: SubagentRunResult,
  ): Promise<void> {
    const childIdentity = childIdentities.get(agentId);
    // 决策 7/10：更新 subagent store 状态 + checkpoint + message_send
    if (result.status === 'completed') {
      const summary = result.result.slice(0, 200) || 'Subagent completed.';
      updateSubagentStatus(agentId, 'completed', { result: result.result });
      if (childIdentity) {
        await checkpoint(childSessionId, childIdentity, 'completed', result.result.length > 500
          ? `${result.result.slice(0, 500)}...`
          : result.result);
        await notify(childSessionId, childIdentity, parentSessionId, `subagent completed: ${summary}`);
      }
    } else {
      const reason = result.error || 'unknown error';
      updateSubagentStatus(agentId, 'failed', { error: reason });
      if (childIdentity) {
        await checkpoint(childSessionId, childIdentity, 'cancelled', reason);
        await notify(childSessionId, childIdentity, parentSessionId, `subagent failed: ${reason}`);
      }
    }
    // 清理 identity
    childIdentities.delete(agentId);
  }

  const runner = {
    /** 启动 subagent——异步立即返回（决策 2） */
    start(parentSessionId: string, input: SubagentStartInput): SubagentStartResult {
      // 决策 11：并发限制
      const running = countRunning();
      if (running >= settings.maxParallel) {
        throw new Error(`Max parallel subagents reached (${settings.maxParallel}). Wait for existing subagents to complete or abort one.`);
      }

      // 组装任务
      const task = assembleTask(input);
      const taskPkg = toTaskPackage(input);

      // 决策 1：复用 delegate session
      const childName = `subagent-${randomUUID().slice(0, 8)}`;
      const { session: child, identity: childIdentity } = registerAndClaimChild(parentSessionId, {
        name: childName,
        task: taskPkg,
      });

      // M2 store 记录
      const subagentId = `sa_${randomUUID().slice(0, 8)}`;
      createSubagent(subagentId, {
        subject: input.objective.slice(0, 200),
        description: input.background?.slice(0, 500),
      });

      // 存储 child identity 供 notify/checkpoint 使用
      childIdentities.set(subagentId, childIdentity);

      // 回填 sessionId
      const record = getSubagent(subagentId);
      if (record) record.sessionId = child.id;

      // 合并运行时配置
      const mergedSettings: SubagentSettings = {
        ...settings,
        provider: input.provider ?? settings.provider,
        model: input.model ?? settings.model,
        maxTurns: input.maxTurns ?? settings.maxTurns,
        timeoutSec: input.timeoutSec ?? settings.timeoutSec,
      };

      // 决策 2：后台启动
      void runSubagentImpl({
        agentId: subagentId,
        task,
        cwd: workspaceDir,
        settings: mergedSettings,
        readOnly: input.readOnly,
      }).then((result) => finalize(subagentId, child.id, parentSessionId, result))
        .catch((err: unknown) => {
          const error = err instanceof Error ? err.message : String(err);
          const storedIdentity = childIdentities.get(subagentId);
          if (storedIdentity) {
            void notify(child.id, storedIdentity, parentSessionId, `subagent failed: ${error}`).catch(() => { /* best effort */ });
          }
          childIdentities.delete(subagentId);
        });

      return { sessionId: child.id, taskId: subagentId, status: 'running' };
    },

    /** 查询 subagent 状态（决策 9） */
    status(taskId: string): SubagentStatusResult {
      const record = getSubagent(taskId);
      if (!record) throw Object.assign(new Error(`Subagent not found: ${taskId}`), { code: 'NOT_FOUND' });

      // 决策 7：completed 后取走即清理——第一次 status 返回 result 并清理
      if (record.status === 'completed' && record.result !== undefined) {
        const result: SubagentStatusResult = {
          status: record.status,
          sessionId: record.sessionId,
          tasks: record.tasks,
          cost: record.cost,
          result: record.result,
          auditLogs: getRecentAuditLogs(taskId),
        };
        collectSubagentResult(taskId); // 取走即清理
        return result;
      }

      return {
        status: record.status,
        sessionId: record.sessionId,
        tasks: record.tasks,
        cost: record.cost,
        error: record.error,
        result: record.status === 'completed' ? record.result : undefined,
        auditLogs: getRecentAuditLogs(taskId),
      };
    },

    /** 中止 subagent（幂等） */
    abort(taskId: string): { status: string } {
      const record = getSubagent(taskId);
      if (!record) throw Object.assign(new Error(`Subagent not found: ${taskId}`), { code: 'NOT_FOUND' });

      // 幂等：已终态直接返回
      if (record.status === 'completed' || record.status === 'failed' || record.status === 'aborted') {
        return { status: record.status };
      }

      // 发送 abort 信号
      record.abortController.abort();
      return { status: 'aborting' };
    },

    /** M8 Step 6：TUI 列表页数据——返回所有 subagent 摘要 */
    listSubagents(): SubagentRecord[] {
      return listAllSubagents();
    },
  };

  return runner;
}

export type SubagentRunner = ReturnType<typeof createSubagentRunner>;

// ── 模块级单例 ──

let singleton: SubagentRunner | null = null;

/** 生产启动时调用——在 ExtensionService 构造之后装配 */
export function initSubagentRunner(deps: SubagentRunnerDeps): void {
  singleton = createSubagentRunner(deps);
}

/** 获取单例——core-tools 的 invoke 无类上下文，用单例 */
export function getSubagentRunner(): SubagentRunner {
  if (!singleton) throw new Error('SubagentRunner not initialized. Call initSubagentRunner() at runtime startup.');
  return singleton;
}

/** 仅供测试——注入 fake deps */
export function setRunnerDepsForTesting(deps: SubagentRunnerDeps): void {
  singleton = createSubagentRunner(deps);
}

/** 仅供测试——重置单例 */
export function resetSubagentRunner(): void {
  singleton = null;
}
