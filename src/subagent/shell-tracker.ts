// ADR-0007 决策 28：agent-scoped shell 进程追踪 + finally 批量清理
// 使用 detached:true 进程组，杀时用 process.kill(-pid) 杀整个组

import { type ChildProcess } from 'node:child_process';

const agentShellTasks = new Map<string, Set<ChildProcess>>();

export function trackShellTask(agentId: string, child: ChildProcess): void {
  let tasks = agentShellTasks.get(agentId);
  if (!tasks) {
    tasks = new Set();
    agentShellTasks.set(agentId, tasks);
  }
  tasks.add(child);

  // 子进程退出时自动从 Set 移除
  child.on('exit', () => {
    const currentTasks = agentShellTasks.get(agentId);
    if (currentTasks) {
      currentTasks.delete(child);
    }
  });
}

export function cleanupAgentShellTasks(agentId: string): void {
  const tasks = agentShellTasks.get(agentId);
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

  agentShellTasks.delete(agentId);
}

/** 仅供测试——清空全部状态 */
export function clearAllShellTasks(): void {
  agentShellTasks.clear();
}

/** 获取 agent 当前追踪的任务数——仅供测试 */
export function getTrackedCount(agentId: string): number {
  return agentShellTasks.get(agentId)?.size ?? 0;
}
