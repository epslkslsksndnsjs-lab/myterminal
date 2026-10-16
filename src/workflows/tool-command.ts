/**
 * 命令面闸——危险表、只读白名单、链切分、替换检测、退出码语义。
 *
 * 四段判定按固定次序，顺序即语义：
 *   1. 命令替换先判——`$(rm -rf /)` 的拒因是"这段根本不可审计"，不是"里面那条危险"；
 *   2. 危险表——系统级毁伤与远程可见动作，两种模式都挡（写模式也不例外）；
 *   3. 解释器套壳递归——`sh -c "…"` / `node -e "…"` 的内容算数，深度越限按拒处理（fail-closed）；
 *   4. 只读面的白名单——不在表上即拒，写重定向（`>`）与带写副作用的旗标（find -delete、sed -i）不放行。
 *
 * 只读面为什么不含测试器与包管理器：它们会写盘，还会经 package.json 里的脚本执行任意代码；
 * 几十路无人看管的并发里，"读命令"就只算读命令。要跑测试的路走隔离面（isolation: 'worktree'）。
 */

export type ToolMode = 'read-only' | 'worktree';

export type CommandVerdict = { allowed: true } | { allowed: false; reason: string };

/** 只读白名单：command 是基令，subcommands 限定第一个参数，deniedFlags 是该命令的写副作用形态。 */
export const SAFE_READ_COMMANDS: ReadonlyArray<{ command: string; subcommands?: readonly string[]; deniedFlags?: readonly string[] }> = [
  { command: 'ls' },
  { command: 'cat' },
  { command: 'head' },
  { command: 'tail' },
  { command: 'wc' },
  { command: 'grep' },
  { command: 'rg' },
  { command: 'find', deniedFlags: ['-delete', '-exec', '-execdir', '-ok', '-okdir'] },
  { command: 'pwd' },
  { command: 'echo' },
  { command: 'printf' },
  { command: 'sort' },
  { command: 'uniq' },
  { command: 'cut' },
  { command: 'tr' },
  { command: 'diff' },
  { command: 'cmp' },
  { command: 'du' },
  { command: 'df' },
  { command: 'stat' },
  { command: 'file' },
  { command: 'basename' },
  { command: 'dirname' },
  { command: 'realpath' },
  { command: 'readlink' },
  { command: 'which' },
  { command: 'whoami' },
  { command: 'date' },
  { command: 'tree' },
  { command: 'jq' },
  { command: 'sed', deniedFlags: ['-i', '--in-place'] },
  { command: 'git', subcommands: ['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'describe', 'remote'] },
  { command: 'node', subcommands: ['--version'] },
  { command: 'bun', subcommands: ['--version'] },
  { command: 'npm', subcommands: ['ls', '--version'] },
];

/** 危险表：命中即拒，两种模式都拒。 */
export const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\b|--recursive\b|--force\b)/i,
  /\brmdir\b/i,
  /\bunlink\b/i,
  /\bsudo\b/i,
  /\bdoas\b/i,
  /\bchmod\b.*\b[0-7]{3}777\b|\bchmod\b.*\s777\b/i,
  /\bchown\b.*\s-R\b/i,
  /\bmkfs(\.|\s)/i,
  /\bdd\b.*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i,
  /\bkill\s+-9\s+1\b/,
  /\b(pkill|killall)\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+(reset|clean)\s+--?(hard|f)\b/i,
  /\btruncate\b.*\s-s\b/i,
];

/** 套壳解释器：shell 的内容可以再切链，按链递归判；语言解释器只能扫危险表。 */
const SHELL_INTERPRETERS = ['sh', 'bash', 'zsh', 'dash', 'ksh'];
const LANG_INTERPRETERS = ['node', 'bun', 'python', 'python3', 'perl', 'ruby', 'php', 'deno'];
const EVAL_FLAGS = ['-c', '-e', '--eval', '--exec', '--command'];

/** 递归深度上限：越限即拒，不猜。 */
export const MAX_INTERPRETER_DEPTH = 3;

const SINGLE_QUOTED = /'[^']*'/g;

/** 剥掉单引号内容——那是数据不是命令（grep 一个含 rm -rf 的字符串不算危险命令）。 */
function stripSingleQuoted(value: string): string {
  return value.replace(SINGLE_QUOTED, "''");
}

/** 把 && || ; | 换行当分隔符切开；引号内与转义的分隔符留在段内。 */
export function splitCommandChain(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | undefined;
  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = '';
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === '\\' && index + 1 < command.length) {
      current += char + command[index + 1];
      index++;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === '&&' || pair === '||') {
      push();
      index++;
      continue;
    }
    if (char === ';' || char === '|' || char === '\n' || char === '\r') {
      push();
      continue;
    }
    current += char;
  }
  push();
  return segments;
}

/** 命令替换 / 进程替换 / 花括号展开：单引号内是字面量，双引号不抑制。 */
export function hasCommandSubstitution(command: string): boolean {
  let inSingleQuote = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false;
      continue;
    }
    if (char === "'") {
      inSingleQuote = true;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === '$(' || pair === '${' || pair === '<(' || pair === '>(' || char === '`') return true;
  }
  return false;
}

/** 粗切成词：引号内的空格不切（够判基令、首参与旗标了）。 */
function tokens(segment: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (current) out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/** 这一段有没有往文件里写：fd 合并与丢 /dev/null 不算写文件。 */
function writesToDisk(segment: string): boolean {
  const scannable = stripSingleQuoted(segment)
    .replace(/\b\d*>&\d+\b/g, '')
    .replace(/\b\d*>\s*\/dev\/null\b/g, '');
  return scannable.includes('>');
}

function unescapeDouble(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '\\' && index + 1 < value.length) {
      const next = value[index + 1];
      if (next === '"' || next === '\\') {
        out += next;
        index++;
        continue;
      }
    }
    out += char;
  }
  return out;
}

/** 取出 -c / -e 后面被引起来的那段内容；取不到返回 undefined（不是套壳形态）。 */
function innerCommand(segment: string): string | undefined {
  const parts = segment.match(/(?:'[^']*'|"(?:[^"\\]|\\.)*")|[^\s]+/g) ?? [];
  for (let index = 0; index < parts.length; index++) {
    if (!EVAL_FLAGS.includes(parts[index])) continue;
    const next = parts[index + 1];
    if (!next) return undefined;
    const quote = next[0];
    if ((quote !== "'" && quote !== '"') || next.length < 2 || next[next.length - 1] !== quote) return undefined;
    const inner = next.slice(1, -1);
    return quote === '"' ? unescapeDouble(inner) : inner;
  }
  return undefined;
}

function allowlistVerdict(segment: string): CommandVerdict {
  if (writesToDisk(segment)) return { allowed: false, reason: 'not-in-read-only-allowlist' };
  const parts = tokens(segment);
  const entry = SAFE_READ_COMMANDS.find((item) => item.command === (parts[0] ?? ''));
  if (!entry) return { allowed: false, reason: 'not-in-read-only-allowlist' };
  if (entry.subcommands && !entry.subcommands.includes(parts[1] ?? '')) return { allowed: false, reason: 'not-in-read-only-allowlist' };
  if (entry.deniedFlags?.some((flag) => parts.includes(flag) || parts.some((part) => part.startsWith(`${flag}=`)))) {
    return { allowed: false, reason: 'not-in-read-only-allowlist' };
  }
  return { allowed: true };
}

/**
 * 命令可否在这一跑里执行。read-only 只放白名单里的读命令；
 * worktree 放开未知命令（边界由那一跑的 worktree 目录与写工具面守住），危险表照挡。
 *
 * 危险表与替换面在整串上扫——`curl x | sh` 与叉弹的形态跨着管道符，
 * 切段之后再扫就看不见它们了。
 */
export function classifyCommand(command: string, mode: ToolMode, depth = 0): CommandVerdict {
  if (depth > MAX_INTERPRETER_DEPTH) return { allowed: false, reason: 'interpreter-recursion' };
  if (hasCommandSubstitution(command)) return { allowed: false, reason: 'command-substitution' };
  const scannable = stripSingleQuoted(command);
  if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(scannable))) return { allowed: false, reason: 'dangerous-command' };
  for (const segment of splitCommandChain(command)) {
    const base = tokens(segment)[0] ?? '';
    const shell = SHELL_INTERPRETERS.includes(base);
    const lang = LANG_INTERPRETERS.includes(base);
    if (shell || lang) {
      const inner = innerCommand(segment);
      if (inner !== undefined) {
        // 语言解释器的内容切不成命令链，只读面一律不放；写模式仍扫危险表。
        if (lang && mode === 'read-only') return { allowed: false, reason: 'not-in-read-only-allowlist' };
        const verdict = classifyCommand(inner, mode, depth + 1);
        if (!verdict.allowed) return verdict;
        continue;
      }
    }
    if (mode === 'read-only') {
      const verdict = allowlistVerdict(segment);
      if (!verdict.allowed) return verdict;
    }
  }
  return { allowed: true };
}

/** 基令取链里最后一段——管道尾才决定这次动作成不成。 */
function mainCommand(command: string): string {
  const segments = splitCommandChain(command);
  return tokens(segments[segments.length - 1] ?? '')[0] ?? '';
}

/** 退出码语义：无匹配 / 条件为假 / 文件有差异 / 路径读不到都不是错误，其余非零才是。 */
export function interpretExitCode(command: string, code: number | null): { isError: boolean; message?: string } {
  if (code === null) return { isError: true, message: 'Command was terminated before it exited' };
  if (code === 0) return { isError: false };
  const base = mainCommand(command);
  if ((base === 'grep' || base === 'rg') && code === 1) return { isError: false, message: 'No matches found' };
  if ((base === 'grep' || base === 'rg') && code >= 2) return { isError: true, message: `search tool error (exit code ${code})` };
  if ((base === 'test' || base === '[') && code === 1) return { isError: false, message: 'Condition evaluated to false' };
  if ((base === 'test' || base === '[') && code === 2) return { isError: true, message: 'Syntax error in test expression' };
  if (base === 'diff' && code === 1) return { isError: false, message: 'Files differ' };
  if (base === 'find' && code === 1) return { isError: false, message: 'Some paths were not accessible' };
  if (base === 'find') return { isError: true, message: `find error (exit code ${code})` };
  return { isError: true, message: `Command exited with code ${code}` };
}
