// ADR-0007 决策 26：readFileState 双层隔离——外层按 agentId，内层按 filePath
// compact 后清空（决策 26），防两个 subagent 互相污染
// ADR-0032 #34：状态收敛到 SubagentContext，函数追加可选末参 ctx（缺省 defaultContext）

import { defaultContext } from './context.js';
import type { SubagentContext, FileState } from './context.js';

function ensureAgentMap(agentId: string, ctx: SubagentContext): Map<string, FileState> {
  let agentMap = ctx.readFileStates.get(agentId);
  if (!agentMap) {
    agentMap = new Map();
    ctx.readFileStates.set(agentId, agentMap);
  }
  return agentMap;
}

export function recordFileRead(agentId: string, filePath: string, content: string, ctx: SubagentContext = defaultContext): void {
  const agentMap = ensureAgentMap(agentId, ctx);
  agentMap.set(filePath, { content, timestamp: Date.now() });
}

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

export function validateEdit(
  agentId: string,
  filePath: string,
  oldString: string,
  replaceAll?: boolean,
  ctx: SubagentContext = defaultContext,
): ValidationResult {
  const agentMap = ctx.readFileStates.get(agentId);
  if (!agentMap) {
    return { ok: false, message: 'File has not been read yet. Use read_file first.' };
  }

  const state = agentMap.get(filePath);
  if (!state) {
    return { ok: false, message: 'File has not been read yet. Use read_file first.' };
  }

  // 统计匹配次数
  const matchCount = state.content.split(oldString).length - 1;

  if (matchCount === 0) {
    // 附前 5 行带行号预览（ADR-0007 决策 36）
    const lines = state.content.split('\n').slice(0, 5);
    const preview = lines.map((line, i) => `${i + 1}\t${line}`).join('\n');
    return {
      ok: false,
      message: `String to replace not found in file.\n\nFile preview (first 5 lines):\n${preview}`,
    };
  }

  if (matchCount > 1 && !replaceAll) {
    return {
      ok: false,
      message: `Found ${matchCount} matches. Provide more context or set replace_all=true.`,
    };
  }

  return { ok: true };
}

export function applyEdit(
  agentId: string,
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
  ctx: SubagentContext = defaultContext,
): string {
  const agentMap = ensureAgentMap(agentId, ctx);
  const state = agentMap.get(filePath);

  // 调用方应在调用前做 validateEdit，这里做防御性检查
  if (!state) {
    throw new Error(`File ${filePath} has not been read by agent ${agentId}`);
  }

  let newContent: string;
  if (replaceAll) {
    // split+join 替代全局替换（效果等同于 replaceAll）
    newContent = state.content.split(oldString).join(newString);
  } else {
    newContent = state.content.replace(oldString, newString);
  }

  // 同步更新缓存
  agentMap.set(filePath, { content: newContent, timestamp: Date.now() });
  return newContent;
}

export function clearFileState(agentId: string, ctx: SubagentContext = defaultContext): void {
  ctx.readFileStates.delete(agentId);
}

/** 仅供测试——清空 defaultContext 全部状态 */
export function clearAllFileStates(): void {
  defaultContext.readFileStates.clear();
}
