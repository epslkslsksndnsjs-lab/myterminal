// M8：SubagentRunner——接入层控制面（ADR-0009 决策 1/2/7/10/11/12）
// 复用 delegate session + 后台 runSubagent + 三层通知链

import { randomUUID } from 'node:crypto';
import type { MyTerminalSession, SubagentSettings, TaskPackage } from '../types.js';
import type { runSubagent as RunSubagentFn } from './executor.js';
import type { SubagentRunResult } from './executor.js';
import {
  createSubagent, getSubagent, updateSubagentStatus, updateSubagentCost, markResultFetched,
  countRunning, listAllSubagents,
} from './store.js';
import { getBackgroundTask } from './shell-tracker.js';
import { MyTerminalError } from '../store.js';
import type { ReducerLink, SubagentRecord, SubagentTask } from './store.js';
import { SUBAGENT_STATUS_PAGE_CHARS, SUBAGENT_STATUS_PAGE_MAX_CHARS } from '../tool-schemas.js';
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
  /**
   * ADR-0052 §8：汇总体场景必填。runId 由工具层校验过（形状 / 归属 / 无旋钮），
   * digestPath 是 workflows 模块给出的不透明路径——本模块只透传，不解释布局。
   */
  reduce?: ReducerLink;
};

/** ADR-0052 接线 #9：汇总体准入与收场由接线方（host）给出，subagent 侧不 import workflows 模块。 */
export type ReducerAdmit =
  | { ok: true; timeoutSec: number; budgetEndsAt: number }
  | { ok: false; noticeOnly: boolean; reason: string; message: string };

export type ReducerSettlement =
  | { status: 'completed'; firstLine: string }
  | { status: 'failed'; reason: string; report: string };

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
  /**
   * ADR-0052 §8：汇总体接缝。缺省 = 本机没接 workflows 模块，带 reduce 的启动按拒绝处理。
   *   admit —— 起 subagent 之前占等待位（同一 run 至多一个等待者）并取回推导好的预算；
   *   conclude —— 收场判定：认盘面证据（终态标记 + digest），给出摘要消息首行，并释放位。
   */
  reducer?: {
    admit(info: { agentId: string; runId: string; ownerSessionId: string }): Promise<ReducerAdmit>;
    conclude(info: { agentId: string; reducerOutputTokens?: number } & ReducerLink): Promise<ReducerSettlement>;
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
  /** ADR-0048 票B（#130）：分页内部记账字段——仅 completed + string result 时附；
   *  shaper 层（reduceSubagentStatusResult）按契约剥除/保留，store 全量不动。 */
  taskId?: string;
  resultOffset?: number;
  resultTotalChars?: number;
  truncated?: boolean;
  /** ADR-0048 #164：后台任务存活状态——getBackgroundTask 生产消费方。
   *  仅 record.backgroundTasks 非空时附；退出后条目保留（收尸才清）但 alive=false。 */
  backgroundTasks?: Array<{ backgroundId: string; alive: boolean; pid?: number }>;
};

export type SubagentStartResult = {
  /** notice-only 降级时没有 child session，也没有 taskId。 */
  sessionId: string | null;
  taskId: string | null;
  status: 'running' | 'notice-only';
  /** 降级详情：汇总体没起成，结果改走终态消息 + 落盘可达（可稍后同 runId 补起）。 */
  reduce?: { runId: string; reason: string; message: string };
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

/** 组装 TaskPackage（用于 registerDelegate）。D3/重拷 Q2：四字段兜底统一 objective 派生（background 用完整 objective，三数组兜底同源），机器代填路径无硬编码文案 */
function toTaskPackage(input: SubagentStartInput): TaskPackage {
  return {
    objective: input.objective,
    background: input.background?.trim() || input.objective,
    deliverables: input.deliverables?.length ? input.deliverables : [input.objective],
    acceptanceCriteria: input.acceptanceCriteria?.length ? input.acceptanceCriteria : [input.objective],
    constraints: input.constraints?.length ? input.constraints : [input.objective],
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
    const reduce = getSubagent(agentId)?.reduce;
    // 汇总体用量（ADR-0052 §19 第三档）：把本汇总体这次的输出 token 回写 run 索引，累加记账。
    const reducerOutputTokens = getSubagent(agentId)?.usage.outputTokens;
    // 汇总体收场：判定权在盘面证据（终态标记 + digest），不在模型的自述——
    // 同时这一步释放等待位，死亡后同 runId 才补得起来。
    const settlement = reduce && deps.reducer
      ? await deps.reducer.conclude({ agentId, runId: reduce.runId, digestPath: reduce.digestPath, ...(reducerOutputTokens !== undefined ? { reducerOutputTokens } : {}) })
        .catch((err: unknown) => ({ status: 'failed' as const, reason: 'conclude-failed', report: err instanceof Error ? err.message : String(err) }))
      : undefined;
    // 决策 7/10：更新 subagent store 状态 + checkpoint + message_send
    // ADR-0010 决策 14：notify 带 taskId + origin——skill fork 与直接启动格式不同
    // ADR-0052 §14：汇总体禁止用 completed 掩盖未结算——收场判败就是判败。
    const failed = result.status !== 'completed' || settlement?.status === 'failed';
    if (!failed && result.status === 'completed') {
      const text = settlement?.status === 'completed' ? `${settlement.firstLine}\n${result.result}` : result.result;
      updateSubagentStatus(agentId, 'completed', { result: text });
      if (childIdentity) {
        await checkpoint(childSessionId, childIdentity, 'completed', text.length > 500
          ? `${text.slice(0, 500)}...`
          : text).catch(() => { /* best-effort：失败必须静默，否则 finalize 抛错会被外层 .catch 误把 completed 覆盖为 failed */ });
        // 汇总体：通知体就是交付物本身——首行 KV 是身份（§15），不带"谁替谁转达"的前缀。
        const body = settlement?.status === 'completed'
          ? text.slice(0, 200) || 'Reducer completed.'
          : origin?.type === 'skill'
            ? `skill '${origin.skillName}' fork completed (taskId=${agentId}): ${text.slice(0, 200) || 'Subagent completed.'}`
            : `subagent completed (taskId=${agentId}): ${text.slice(0, 200) || 'Subagent completed.'}`;
        await notify(childSessionId, childIdentity, parentSessionId, body).catch(() => { /* best-effort */ });
      }
    } else {
      const reason = settlement?.status === 'failed'
        ? settlement.report
        : (result.status === 'failed' || result.status === 'aborted' ? result.error : undefined) || 'unknown error';
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

  async function admitReducerStart(agentId: string, runId: string, ownerSessionId: string): Promise<ReducerAdmit> {
    if (!deps.reducer) {
      return { ok: false, noticeOnly: true, reason: 'reducer-not-wired', message: 'No workflows module is wired into this runtime, so nothing can wait for a run; the account stays on disk.' };
    }
    return await deps.reducer.admit({ agentId, runId, ownerSessionId });
  }

  const runner = {
    /** 启动 subagent——受理后立即返回（决策 2）；汇总体场景准入先于起 session。 */
    async start(parentSessionId: string, input: SubagentStartInput, origin?: SubagentOrigin): Promise<SubagentStartResult> {
      // 决策 11：并发限制——池闸先于等待位（池满时不该留下一半占着的位）
      const running = countRunning();
      if (running >= settings.maxParallel) {
        throw new MyTerminalError('FORBIDDEN', `Max parallel subagents reached (${settings.maxParallel}). Wait for existing subagents to complete or abort one.`);
      }

      // M2 store 记录（ADR-0042 #78 选项 A：透传 origin，使其落 SubagentRecord）
      const subagentId = `sa_${randomUUID().slice(0, 8)}`;

      // ADR-0052 §8：汇总体准入——等待位（同一 run 至多一个等待者）与并发配额，
      // 拒在起 subagent 之前；配额满是 notice-only 降级，不是失败。
      let waiting: { timeoutSec: number; budgetEndsAt: number } | undefined;
      if (input.reduce) {
        const admitted = await admitReducerStart(subagentId, input.reduce.runId, parentSessionId);
        if (!admitted.ok) {
          if (!admitted.noticeOnly) {
            throw new MyTerminalError('FORBIDDEN', admitted.message, { reason: admitted.reason } as unknown as import('../types.js').JsonObject);
          }
          return {
            sessionId: null,
            taskId: null,
            status: 'notice-only',
            reduce: { runId: input.reduce.runId, reason: admitted.reason, message: admitted.message },
          };
        }
        waiting = { timeoutSec: admitted.timeoutSec, budgetEndsAt: admitted.budgetEndsAt };
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

      createSubagent(subagentId, {
        subject: input.objective.slice(0, 200),
        description: input.background?.slice(0, 500),
        origin,
        ...(input.reduce ? { reduce: { runId: input.reduce.runId, digestPath: input.reduce.digestPath } } : {}),
      });

      // 存储 child identity 供 notify/checkpoint 使用
      childIdentities.set(subagentId, childIdentity);

      // 回填 sessionId
      const record = getSubagent(subagentId);
      if (record) record.sessionId = child.id;

      // 合并运行时配置（ADR-0045 #04：provider/model 已移除——模型只来自全局配置 settings）
      // ADR-0052 §8 I11：汇总体 timeoutSec 由等待预算推导，模型传不进来（带了即被工具层拒）。
      const mergedSettings: SubagentSettings = {
        ...settings,
        maxTurns: input.maxTurns ?? settings.maxTurns,
        timeoutSec: waiting ? waiting.timeoutSec : (input.timeoutSec ?? settings.timeoutSec),
      };

      // 决策 2：后台启动
      void runSubagentImpl({
        agentId: subagentId,
        task,
        cwd: workspaceDir,
        settings: mergedSettings,
        readOnly: input.readOnly,
        ...(waiting ? { budgetEndsAt: waiting.budgetEndsAt } : {}),
      }).then((result) => finalize(subagentId, child.id, parentSessionId, result, origin))
        .catch((err: unknown) => {
          const error = err instanceof Error ? err.message : String(err);
          // 核心修复（issue #90）：runSubagentImpl 抛错时 .then(finalize) 被跳过，原代码只 notify 不更新 store
          // 状态 → SubagentRecord 永久 status=running（僵尸），父代理被永久阻塞，checkpoint 永不落盘。
          // 现补：无条件置 failed（无论是否有 childIdentity，先杀僵尸），再 best-effort checkpoint + notify。
          updateSubagentStatus(subagentId, 'failed', { error });
          // 汇总体死在路上：等待位必须随之释放（否则同 runId 永远补不起来），判定结果在这里用不上。
          if (input.reduce && deps.reducer) {
            const deadReducerTokens = getSubagent(subagentId)?.usage.outputTokens;
            void deps.reducer.conclude({ agentId: subagentId, runId: input.reduce.runId, digestPath: input.reduce.digestPath, ...(deadReducerTokens !== undefined ? { reducerOutputTokens: deadReducerTokens } : {}) }).catch(() => {});
          }
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
    status(taskId: string, offset?: number, limit?: number): SubagentStatusResult {
      const record = getSubagent(taskId);
      if (!record) throw Object.assign(new Error(`Subagent not found: ${taskId}`), { code: 'NOT_FOUND' });

      // ADR-0048 D5（#136）：父首次取终态结果即置「已验收」标记（completed 取 result；failed/aborted 看过 error 即验收）。
      // 幂等：重复轮询不删记录、不重置标记（ADR-0007 决策 7/13，读完即删违 D5 红线）。
      // #173-1：先组装后置位——组装/切片抛错不烧闸门（置位统一在各 return 前）。
      const markIfUnreviewed = (): void => {
        if (record.status !== 'running' && !record.resultFetched) markResultFetched(taskId);
      };

      // ADR-0048 #164：后台任务存活——record 元数据（backgroundId→pid）+ shell-tracker 句柄判活。
      // getBackgroundTask 自此获得生产消费方（此前仅测试断言保活）。
      const backgroundTasks = record.backgroundTasks?.map(({ backgroundId, pid }) => {
        const child = getBackgroundTask(backgroundId);
        const alive = child !== undefined && !child.killed && child.exitCode === null && child.signalCode === null;
        return { backgroundId, pid, alive };
      });

      const base: SubagentStatusResult = {
        status: record.status,
        sessionId: record.sessionId,
        tasks: record.tasks,
        usage: record.usage,
        error: record.error,
        result: record.status === 'completed' ? record.result : undefined,
        origin: record.origin,
        ...(backgroundTasks?.length ? { backgroundTasks } : {}),
      };

      // ADR-0048 票B（#130）：completed + string result 才附分页记账字段与切片。
      // offset 下界钳制（负值/非整数回 0）；显式 offset>0 才切片——首查返回全量
      // （超门截断由 shaper 层 token 感知完成），store 全量保留不动。
      if (record.status === 'completed' && typeof record.result === 'string') {
        const totalChars = record.result.length;
        const pageOffset = Math.max(0, Math.floor(offset ?? 0));
        if (pageOffset > 0) {
          const pageLimit = Math.min(Math.max(1, Math.floor(limit ?? SUBAGENT_STATUS_PAGE_CHARS)), SUBAGENT_STATUS_PAGE_MAX_CHARS);
          const page = record.result.slice(pageOffset, pageOffset + pageLimit);
          markIfUnreviewed();
          return {
            ...base,
            result: page,
            taskId,
            resultOffset: pageOffset,
            resultTotalChars: totalChars,
            truncated: pageOffset + page.length < totalChars,
          };
        }
        markIfUnreviewed();
        return { ...base, taskId, resultOffset: 0, resultTotalChars: totalChars, truncated: false };
      }
      markIfUnreviewed();
      return base;
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
      // A48-W1 低危B-1：'aborting' 是瞬时确认值（abort 已发出、终态未落），
      // 不在 SubagentStatus 联合内（store.ts:13 的 running/completed/failed/aborted）——
      // 持久状态由终结路径置 'aborted'（本窗测试 subagent-m8/status-color 锁定该值，勿改）。
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
