// ADR-0007 决策 28：agent-scoped shell 进程追踪 + finally 批量清理
// 使用 detached:true 进程组，杀时用 process.kill(-pid) 杀整个组
// ADR-0032 #34：状态收敛到 SubagentContext，函数追加可选末参 ctx（缺省 defaultContext）

import { type ChildProcess } from 'node:child_process';
import { defaultContext } from './context.js';
import type { SubagentContext } from './context.js';

export function trackShellTask(agentId: string, child: ChildProcess, ctx: SubagentContext = defaultContext): void {
  let tasks = ctx.agentShellTasks.get(agentId);
  if (!tasks) {
    tasks = new Set();
    ctx.agentShellTasks.set(agentId, tasks);
  }
  tasks.add(child);

  // 子进程退出时自动从 Set 移除
  child.on('exit', () => {
    const currentTasks = ctx.agentShellTasks.get(agentId);
    if (currentTasks) {
      currentTasks.delete(child);
    }
  });
}

// D8 第四轮修订：backgroundId→ChildProcess 索引——转后台命令的查/杀句柄
// （句柄进 shell-tracker 登记链，SubagentRecord 只存 backgroundId→pid 元数据）
export function registerBackgroundTask(
  agentId: string,
  backgroundId: string,
  child: ChildProcess,
  ctx: SubagentContext = defaultContext,
): void {
  ctx.backgroundTasks.set(backgroundId, { agentId, child });
}

/** 按 backgroundId 查后台进程句柄——供落盘输出文件读取与收尸查/杀 */
export function getBackgroundTask(
  backgroundId: string,
  ctx: SubagentContext = defaultContext,
): ChildProcess | undefined {
  return ctx.backgroundTasks.get(backgroundId)?.child;
}

export function cleanupAgentShellTasks(agentId: string, ctx: SubagentContext = defaultContext): void {
  // D8：backgroundId 索引随 agent 收尸一并清理（进程组杀由下方 tasks 遍历承担）
  for (const [id, entry] of ctx.backgroundTasks) {
    if (entry.agentId === agentId) {
      ctx.backgroundTasks.delete(id);
    }
  }

  const tasks = ctx.agentShellTasks.get(agentId);
  if (!tasks || tasks.size === 0) return;

  for (const child of tasks) {
    // 跳过已退出的进程
    if (child.killed || child.exitCode !== null) continue;

    try {
      // 杀进程组——detached:true 的子进程是新进程组 leader
      // shell:true spawn 的子进程（如 npm run build 的 node）也在进程组内
      if (child.pid) {
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch {
      // 进程组杀失败（可能不是 group leader），降级杀单个进程
      try {
        child.kill('SIGTERM');
      } catch {
        // 已退出，忽略
      }
    }
  }

  // 可选的硬兜底：2 秒后仍未退出的进程发 SIGKILL
  const pendingPids: number[] = [];
  for (const child of tasks) {
    if (!child.killed && child.exitCode === null && child.pid) {
      pendingPids.push(child.pid);
    }
  }

  if (pendingPids.length > 0) {
    setTimeout(() => {
      for (const pid of pendingPids) {
        try {
          process.kill(-pid, 0); // 检查进程组是否存在
          process.kill(-pid, 'SIGKILL');
        } catch {
          // 已退出，忽略
        }
      }
    }, 2000).unref(); // 不阻止进程退出
  }

  ctx.agentShellTasks.delete(agentId);
}

/** 仅供测试——清空 defaultContext 全部状态 */
export function clearAllShellTasks(): void {
  defaultContext.agentShellTasks.clear();
  defaultContext.backgroundTasks.clear();
}

/** 获取 agent 当前追踪的任务数——仅供测试 */
export function getTrackedCount(agentId: string, ctx: SubagentContext = defaultContext): number {
  return ctx.agentShellTasks.get(agentId)?.size ?? 0;
}
