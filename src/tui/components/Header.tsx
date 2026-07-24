import type { MyTerminalRuntime } from '../../server.js';
import { CURRENT_VERSION } from '../../version.js';
import type { Theme } from '../state.js';

export function Header({ runtime, theme, pending, zh }: { runtime: MyTerminalRuntime; theme: Theme; pending: number; zh: boolean }) {
  const topology = runtime.processTopology();
  const status = topology.mode === 'degraded'
    ? (zh ? `拓扑异常 · :${topology.sharedPort} · PID ${topology.pid}` : `topology degraded · :${topology.sharedPort} · PID ${topology.pid}`)
    : topology.mode === 'single-workspace'
      ? (zh ? `单工作区模式 · :${topology.sharedPort} · PID ${topology.pid}` : `single-workspace mode · :${topology.sharedPort} · PID ${topology.pid}`)
      : `${topology.memberCount} ${zh ? '个终端进程共用' : 'terminal process(es) share'} :${topology.sharedPort} · ${topology.role === 'leader' ? (zh ? '主进程' : 'leader') : (zh ? '成员进程' : 'member')} · PID ${topology.pid}`;
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={theme.background}>
      <box flexDirection="row" gap={2} paddingLeft={1} paddingRight={1}>
        <text fg={theme.accent}><b>MyTerminal</b></text>
        <text fg={topology.mode === 'degraded' ? theme.bad : theme.good}>● {zh ? '运行中' : 'running'} · {status}</text>
        <text fg={theme.muted}>v{CURRENT_VERSION}</text>
      </box>
      {pending > 0 ? (
        <box backgroundColor={theme.bad} paddingLeft={1} paddingRight={1}>
          <text fg="#ffffff" wrapMode="word"><b>! {pending} {zh ? '个 session 等待接管' : 'session(s) need a controller'}</b></text>
        </box>
      ) : null}
    </box>
  );
}
