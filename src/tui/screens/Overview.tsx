import { logicalSessionGroups } from '../../tui-model.js';
import type { MyTerminalRuntime } from '../../server.js';
import type { StoredState } from '../../types.js';
import { hiddenAppsUrl, visibleActionsToken, type Theme } from '../state.js';
import { Heading, Line } from './shared.js';

export function Overview({ runtime, state, theme, zh, reveal }: { runtime: MyTerminalRuntime; state: StoredState; theme: Theme; zh: boolean; reveal: boolean }) {
  return (
    <box flexDirection="column" width="100%" padding={1} gap={0}>
      <Heading theme={theme}>{zh ? '服务' : 'Server'}</Heading>
      <Line color={theme.text}>{`${zh ? '监听' : 'Bind'}: ${runtime.config.host}:${runtime.port}`}</Line>
      <Line color={theme.text}>{`${zh ? '工作区' : 'Workspace'}: ${runtime.config.workspaceDir}`}</Line>
      <Line color={theme.text}>{`Apps MCP URL: ${hiddenAppsUrl(runtime, reveal)}`}</Line>
      <Line color={theme.text}>{`Actions OpenAPI: ${runtime.openApiUrl}`}</Line>
      <Line color={theme.text}>{`Actions token: ${visibleActionsToken(runtime, reveal)}`}</Line>
      <text> </text>
      <Heading theme={theme}>{zh ? '实时状态' : 'Live state'}</Heading>
      <Line color={theme.text}>{`${zh ? '逻辑会话' : 'Logical sessions'}: ${logicalSessionGroups(state.sessions).length}`}</Line>
      <Line color={theme.text}>{`${zh ? '工作记录' : 'Work records'}: ${state.sessions.length}`}</Line>
      <Line color={theme.text}>{`MCP transports: ${runtime.activeMcpSessions()}`}</Line>
      <Line color={theme.text}>{`${zh ? '消息' : 'Messages'}: ${state.messages.length}`}</Line>
      <Line color={theme.text}>{`${zh ? '未确认事件' : 'Unacked events'}: ${state.events.filter((event) => !event.acknowledgedAt).length}`}</Line>
      <text> </text>
      <Line color={theme.warn}>{zh ? '模型侧始终只暴露三个 facade 工具。' : 'Only three facade tools are model-visible.'}</Line>
    </box>
  );
}
