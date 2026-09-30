import { WorkflowEngine, type EngineDeps } from './engine.js';

/**
 * 引擎宿主——与会话执行器、消息库同进程（模块只有一个宿主进程）。
 * 构造参数全部来自接线方，测试可整体替换。
 *
 * "停接单"是进程级的关机状态：关机流程先拒新命令、再收在飞命令树。
 * 重新开闸由新建引擎承担（见 engine.ts 构造器），这里不再另设一份。
 */

let engine: WorkflowEngine | undefined;

export function initWorkflowEngine(deps: EngineDeps): WorkflowEngine {
  engine = new WorkflowEngine(deps);
  return engine;
}

export function getWorkflowEngine(): WorkflowEngine | undefined {
  return engine;
}

/** 测试缝：把上一轮注入的引擎摘掉，避免跨用例串味。 */
export function resetWorkflowEngine(): void {
  engine = undefined;
}
