// ADR-0048 D8 中（#152）：subagent 输出目录收口清理
//
// 背景：.myterminal/subagent-outputs/<agentId>（tools.ts execute_cli 转后台落盘）只写不删——
// disposeAgent/cleanupAgentShellTasks 杀进程、清索引，不删文件，磁盘只涨不跌。
// 本模块把输出目录纳入 agent 资源收口：executor 起跑时登记 outputDir（单一真相源，
// 容忍 workspaceDir ≠ process.cwd()），agent 终结（disposeAgent）时按登记删除。
//
// 闸门：record 在世（running）不删（AC2）；record 已被 1h 兜底/#143 收口清除（无 record）
// 仍删目录——孤儿目录收尸。未验收不设 resultFetched 闸门：目录无 1h 兜底，设闸门即永久泄漏。
// 行为铁律：rmSync recursive+force——目录不存在不抛（幂等）；其余异常向上传播（不吞）。

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { defaultContext } from './context.js';
import type { SubagentContext } from './context.js';
import { getSubagent } from './store.js';

/** D8 落盘目录公式——executor 注入与 tools.ts 兜底共用单一真相源 */
export function getAgentOutputDir(cwd: string, agentId: string): string {
  return join(cwd, '.myterminal', 'subagent-outputs', agentId);
}

export function cleanupAgentOutputDir(agentId: string, ctx: SubagentContext = defaultContext): void {
  const record = getSubagent(agentId, ctx);
  if (record && record.status === 'running') return; // AC2：在世 agent 目录不误删
  const dir = ctx.outputDirs.get(agentId);
  if (!dir) return;
  rmSync(dir, { recursive: true, force: true });
  ctx.outputDirs.delete(agentId);
}

/** 仅供测试——清空 defaultContext 全部目录登记 */
export function clearAllOutputDirs(): void {
  defaultContext.outputDirs.clear();
}
