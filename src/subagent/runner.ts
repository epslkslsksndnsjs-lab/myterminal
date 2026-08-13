// M8：SubagentRunner——接入层控制面（ADR-0009 决策 1/2/7/10/11/12）
// 复用 delegate session + 后台 runSubagent + 三层通知链

import { randomUUID } from 'node:crypto';
import type { MyTerminalSession, SubagentSettings, TaskPackage } from '../types.js';
import type { runSubagent as RunSubagentFn } from './executor.js';
import type { SubagentRunResult } from './executor.js';
import {
  createSubagent, getSubagent, updateSubagentStatus, updateSubagentCost,
  countRunning, getRecentAuditLogs, listAllSubagents,
} from './store.js';
import { MyTerminalError } from '../store.js';
import type { SubagentRecord, SubagentTask } from './store.js';
import { defaultContext, type SubagentContext } from './context.js';
import type { UsageSummary } from './cost-tracker.js';

// ── 类型 ──

export type SubagentStartInput = {
  objective: string;
  background?: string;
  deliverables?: string[];
  acceptanceCriteria?: string[];
  constraints?: string[];
  maxTurns?: number;
  timeoutSec?: number;
  readOnly?: boolean;
};

/** ADR-0010 决策 14：subagent 来源——skill(fork) 启动时传入，notify 消息据此区分格式 */
export type SubagentOrigin = { type: 'skill'; skillName: string };

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
  usage: UsageSummary;
  error?: string;
  result?: string;
  /** ADR-0042 #78 选项 A：来源（skill fork 时标注 skillName；direct start 为 undefined） */
  origin?: SubagentOrigin;
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
    origin?: SubagentOrigin,
  ): Promise<void> {
    const childIdentity = childIdentities.get(agentId);
    // 决策 7/10：更新 subagent store 状态 + checkpoint + message_send
    // ADR-0010 决策 14：notify 带 taskId + origin——skill fork 与直接启动格式不同
    if (result.status === 'completed') {
      const summary = result.result.slice(0, 200) || 'Subagent completed.';
      updateSubagentStatus(agentId, 'completed', { result: result.result });
      if (childIdentity) {
        await checkpoint(childSessionId, childIdentity, 'completed', result.result.length > 500
          ? `${result.result.slice(0, 500)}...`
          : result.result).catch(() => { /* best-effort：失败必须静默，否则 finalize 抛错会被外层 .catch 误把 completed 覆盖为 failed */ });
        const body = origin?.type === 'skill'
          ? `skill '${origin.skillName}' fork completed (taskId=${agentId}): ${summary}`
          : `subagent completed (taskId=${agentId}): ${summary}`;
        await notify(childSessionId, childIdentity, parentSessionId, body).catch(() => { /* best-effort */ });
      }
    } else {
      const reason = result.error || 'unknown error';
      updateSubagentStatus(agentId, 'failed', { error: reason });
      if (childIdentity) {
        await checkpoint(childSessionId, childIdentity, 'cancelled', reason).catch(() => { /* best-effort */ });
        const body = origin?.type === 'skill'
          ? `skill '${origin.skillName}' fork failed (taskId=${agentId}): ${reason}`
          : `subagent failed (taskId=${agentId}): ${reason}`;
        await notify(childSessionId, childIdentity, parentSessionId, body).catch(() => { /* best-effort */ });
      }
    }
    // 清理 identity（best-effort 化后此行必然可达，不再有 Map 泄漏）
    childIdentities.delete(agentId);
  }

  const runner = {
    /** 启动 subagent——异步立即返回（决策 2） */
    start(parentSessionId: string, input: SubagentStartInput, origin?: SubagentOrigin): SubagentStartResult {
      // 决策 11：并发限制
      const running = countRunning();
      if (running >= settings.maxParallel) {
        throw new MyTerminalError('FORBIDDEN', `Max parallel subagents reached (${settings.maxParallel}). Wait for existing subagents to complete or abort one.`);
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

      // M2 store 记录（ADR-0042 #78 选项 A：透传 origin，使其落 SubagentRecord）
      const subagentId = `sa_${randomUUID().slice(0, 8)}`;
      createSubagent(subagentId, {
        subject: input.objective.slice(0, 200),
        description: input.background?.slice(0, 500),
        origin,
      });

      // 存储 child identity 供 notify/checkpoint 使用
      childIdentities.set(subagentId, childIdentity);

      // 回填 sessionId
      const record = getSubagent(subagentId);
      if (record) record.sessionId = child.id;

      // 合并运行时配置（ADR-0045 #04：provider/model 已移除——模型只来自全局配置 settings）
      const mergedSettings: SubagentSettings = {
        ...settings,
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
      }).then((result) => finalize(subagentId, child.id, parentSessionId, result, origin))
        .catch((err: unknown) => {
          const error = err instanceof Error ? err.message : String(err);
          // 核心修复（issue #90）：runSubagentImpl 抛错时 .then(finalize) 被跳过，原代码只 notify 不更新 store
          // 状态 → SubagentRecord 永久 status=running（僵尸），父代理被永久阻塞，checkpoint 永不落盘。
          // 现补：无条件置 failed（无论是否有 childIdentity，先杀僵尸），再 best-effort checkpoint + notify。
          updateSubagentStatus(subagentId, 'failed', { error });
          const storedIdentity = childIdentities.get(subagentId);
          if (storedIdentity) {
            const body = origin?.type === 'skill'
              ? `skill '${origin.skillName}' fork failed (taskId=${subagentId}): ${error}`
              : `subagent failed (taskId=${subagentId}): ${error}`;
            // best-effort：checkpoint/notify 失败必须静默，否则 async .catch 自身 reject →
            // unhandledRejection → cli.ts process.exit(1) 杀进程（#90 之前改坏引入的回归）
            void checkpoint(child.id, storedIdentity, 'cancelled', error).catch(() => {});
            void notify(child.id, storedIdentity, parentSessionId, body).catch(() => {});
          }
          // 清理 identity——best-effort 化后必然可达，不再有 Map 泄漏
          childIdentities.delete(subagentId);
        });

      return { sessionId: child.id, taskId: subagentId, status: 'running' };
    },

    /** 查询 subagent 状态（决策 9；ADR-0010 决策 13 修订：idempotent——completed 后可多次查，清理只靠 1 小时超时定时器 store.ts） */
    status(taskId: string): SubagentStatusResult {
      const record = getSubagent(taskId);
      if (!record) throw Object.assign(new Error(`Subagent not found: ${taskId}`), { code: 'NOT_FOUND' });

      return {
        status: record.status,
        sessionId: record.sessionId,
        tasks: record.tasks,
        usage: record.usage,
        error: record.error,
        result: record.status === 'completed' ? record.result : undefined,
        origin: record.origin,
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

// ── 装配单例（#34 第 7 项：状态收进 SubagentContext，缺省 defaultContext 向后兼容）──

/** 生产启动时调用——在 ExtensionService 构造之后装配 */
export function initSubagentRunner(deps: SubagentRunnerDeps, ctx: SubagentContext = defaultContext): void {
  ctx.runner = createSubagentRunner(deps);
}

/** 获取单例——core-tools 的 invoke 无类上下文，用单例 */
export function getSubagentRunner(ctx: SubagentContext = defaultContext): SubagentRunner {
  if (!ctx.runner) throw new Error('SubagentRunner not initialized. Call initSubagentRunner() at runtime startup.');
  return ctx.runner;
}

/** 仅供测试——注入 fake deps */
export function setRunnerDepsForTesting(deps: SubagentRunnerDeps, ctx: SubagentContext = defaultContext): void {
  ctx.runner = createSubagentRunner(deps);
}

/** 仅供测试——重置单例 */
export function resetSubagentRunner(ctx: SubagentContext = defaultContext): void {
  ctx.runner = null;
}
