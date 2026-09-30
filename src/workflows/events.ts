/**
 * 进度事件——热路径（进程内）的最小三事件：run 起 / 每路终态 / run 终态。
 *
 * 冷启动那一半不靠事件：run 目录与索引是持久件，重启后由扫描盘面重建，
 * 所以这里刻意只做进程内广播，不做跨进程投递。
 */

export type WorkflowEventType = 'run_started' | 'dispatch_settled' | 'run_settled';

export type WorkflowEvent = {
  runId: string;
  type: WorkflowEventType;
  at: string;
  data?: Record<string, unknown>;
};

export type WorkflowEventListener = (event: WorkflowEvent) => void;

export class WorkflowEvents {
  private readonly listeners = new Set<WorkflowEventListener>();

  emit(event: WorkflowEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // 订阅者出错绝不影响 run 本身：事件是观测面，不是关键路径。
      }
    }
  }

  on(listener: WorkflowEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  clear(): void {
    this.listeners.clear();
  }
}
