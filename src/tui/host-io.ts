// #29（批5 第 9 刀 / ADR-0032）：TUI 宿主 I/O 薄适配层。
// TuiController 的全部 OS 进程 spawn 收敛于此（剪贴板/提示音/系统通知），
// state.ts 不再直接 import child_process，纯逻辑见 controller-logic.ts。
import { spawn } from 'node:child_process';

async function runWithInput(command: string, args: string[], input: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], shell: false });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
    child.stdin.end(input);
  });
}

export async function copyToHostClipboard(text: string): Promise<boolean> {
  const commands = process.platform === 'darwin'
    ? [['pbcopy', []] as const]
    : process.platform === 'win32'
      ? [['clip', []] as const]
      : [['wl-copy', []] as const, ['xclip', ['-selection', 'clipboard']] as const];
  for (const [command, args] of commands) if (await runWithInput(command, [...args], text)) return true;
  return false;
}

export function playAttentionSound(): void {
  // 提示音已禁用（A48-W1 清理：bestEffortSpawn 死代码删除，原平台命令见 git 历史）。
}

export function notifySystem(title: string, message: string): void {
  // 系统通知已禁用（同上，恢复实现见 git 历史）。
}
