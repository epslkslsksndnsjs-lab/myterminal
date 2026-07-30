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

function bestEffortSpawn(command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: 'ignore', shell: false });
  child.on('error', () => undefined);
}

export function playAttentionSound(): void {
  // 暂时关闭提醒声音 —— 恢复时取消注释下方三行
  // if (process.platform === 'darwin') bestEffortSpawn('afplay', ['/System/Library/Sounds/Ping.aiff']);
  // else if (process.platform === 'win32') bestEffortSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[console]::beep(880,180)']);
  // else bestEffortSpawn('canberra-gtk-play', ['--id=dialog-warning']);
}

export function notifySystem(title: string, message: string): void {
  // 暂时关闭系统通知 —— 恢复时取消注释下方三行
  // if (process.platform === 'darwin') bestEffortSpawn('osascript', ['-e', `display notification "${message.replace(/["\\]/g, '')}" with title "${title.replace(/["\\]/g, '')}"`]);
  // else if (process.platform === 'linux') bestEffortSpawn('notify-send', [title, message]);
  // else if (process.platform === 'win32') bestEffortSpawn('msg.exe', ['*', `${title}: ${message}`]);
}
