/**
 * command-router — 输入栏 / 命令路由（ADR-0004 决策 4）。
 * 纯函数模块，无副作用。命令 = 现有页面动作的别名映射，不引入新的后端能力。
 * / 开头 → 命令；纯文本 → 消息。Tab 补全走 commandCompletions。
 */

export type PageActionName = 'createSession' | 'sendMessage' | 'refreshDiff';

export type CommandAction =
  | { kind: 'navigate'; tab: number }
  | { kind: 'pageAction'; action: PageActionName }
  | { kind: 'message'; body: string }
  | { kind: 'help' }
  | { kind: 'unknown'; input: string; suggestion?: string };

/** 命令表：命令名 → 目标 */
const COMMANDS: Record<string, CommandAction> = {
  '/home': { kind: 'navigate', tab: 0 },
  '/overview': { kind: 'navigate', tab: 0 },
  '/概览': { kind: 'navigate', tab: 0 },
  '/sessions': { kind: 'navigate', tab: 1 },
  '/会话': { kind: 'navigate', tab: 1 },
  '/messages': { kind: 'navigate', tab: 2 },
  '/消息': { kind: 'navigate', tab: 2 },
  '/timeline': { kind: 'navigate', tab: 3 },
  '/时间线': { kind: 'navigate', tab: 3 },
  '/diff': { kind: 'navigate', tab: 4 },
  '/extensions': { kind: 'navigate', tab: 5 },
  '/扩展': { kind: 'navigate', tab: 5 },
  '/settings': { kind: 'navigate', tab: 6 },
  '/设置': { kind: 'navigate', tab: 6 },
  '/logs': { kind: 'navigate', tab: 7 },
  '/日志': { kind: 'navigate', tab: 7 },
  '/new': { kind: 'pageAction', action: 'createSession' },
  '/send': { kind: 'pageAction', action: 'sendMessage' },
  '/refresh': { kind: 'pageAction', action: 'refreshDiff' },
  '/help': { kind: 'help' },
  '/帮助': { kind: 'help' },
};

const COMMAND_NAMES = Object.keys(COMMANDS);

/**
 * 路由输入文本到命令动作。
 * - 非 / 开头 → message
 * - 匹配命令表 → 对应动作
 * - / 开头但无匹配 → unknown，附最长公共前缀建议
 */
export function routeCommand(input: string): CommandAction {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { kind: 'message', body: trimmed };

  const lower = trimmed.toLowerCase();
  const exact = COMMANDS[lower];
  if (exact) return exact;

  // 无精确匹配：找最长公共前缀的命令作为建议
  let bestPrefixMatch = '';
  for (const name of COMMAND_NAMES) {
    if (lower.length > 1 && name.startsWith(lower) && name.length > bestPrefixMatch.length) {
      bestPrefixMatch = name;
    }
  }

  return { kind: 'unknown', input: trimmed, suggestion: bestPrefixMatch || undefined };
}

/**
 * 返回以给定前缀开头的命令名列表（Tab 补全用）。
 * prefix='/' 返回全部命令。
 */
export function commandCompletions(prefix: string): string[] {
  const lower = prefix.toLowerCase();
  return COMMAND_NAMES.filter((name) => name.startsWith(lower)).sort();
}
