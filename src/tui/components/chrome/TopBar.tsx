import type { MyTerminalRuntime } from '../../../server.js';
import { CURRENT_VERSION } from '../../../version.js';
import type { Theme } from '../../state.js';

/**
 * TopBar — 顶栏（ADR-0004 决策 2 底部导航相关的顶部 chrome）。
 * 左：MyTerminal（accent 加粗）+ 状态点 + 拓扑摘要 + 版本号；
 * 右：pending > 0 时显示 bad 背景警告条。
 */
export function TopBar({ runtime, theme, pending, zh }: {
  runtime: MyTerminalRuntime;
  theme: Theme;
  pending: number;
  zh: boolean;
}) {
  const topology = runtime.processTopology();
  const degraded = topology.mode === 'degraded';
  const statusDot = degraded ? '●' : '●';
  const statusColor = degraded ? theme.bad : theme.good;

  let topoLabel: string;
  if (degraded) {
    topoLabel = zh
      ? `拓扑异常 · :${topology.sharedPort} · PID ${topology.pid}`
      : `topology degraded · :${topology.sharedPort} · PID ${topology.pid}`;
  } else if (topology.mode === 'single-workspace') {
    topoLabel = zh
      ? `单工作区模式 · :${topology.sharedPort} · PID ${topology.pid}`
      : `single-workspace mode · :${topology.sharedPort} · PID ${topology.pid}`;
  } else {
    topoLabel = `${topology.memberCount} ${zh ? '个终端进程共用' : 'terminal process(es) share'} :${topology.sharedPort} · ${topology.role === 'leader' ? (zh ? '主进程' : 'leader') : (zh ? '成员进程' : 'member')} · PID ${topology.pid}`;
  }

  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={theme.background}>
      <box flexDirection="row" gap={2} paddingLeft={1} paddingRight={1} alignItems="center">
        <text fg={theme.accent}><b>MyTerminal</b></text>
        <text fg={statusColor}>{statusDot} {zh ? '运行中' : 'running'} · {topoLabel}</text>
        <text fg={theme.muted}>v{CURRENT_VERSION}</text>
        <box flexGrow={1} />
        {pending > 0 ? (
          <box backgroundColor={theme.bad} paddingLeft={1} paddingRight={1}>
            <text fg={theme.text} wrapMode="none"><b>! {pending} {zh ? '个 session 等待接管' : 'session(s) need a controller'}</b></text>
          </box>
        ) : null}
      </box>
    </box>
  );
}
