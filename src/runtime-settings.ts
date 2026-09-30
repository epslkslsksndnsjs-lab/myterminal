import type { MyTerminalRuntime } from './server.js';
import type { MyTerminalSettings } from './types.js';

export function runtimeSettingsSnapshot(runtime: MyTerminalRuntime, persisted?: MyTerminalSettings): MyTerminalSettings {
  const config = runtime.config;
  return {
    schemaVersion: 1,
    workspaceDir: config.workspaceDir,
    host: config.host,
    port: runtime.port,
    connectorKey: config.connectorKey,
    actionsToken: config.actionsToken,
    publicBaseUrl: config.publicBaseUrl,
    maxOutputChars: config.maxOutputChars,
    commandTimeoutSec: config.commandTimeoutSec,
    uiLanguage: config.uiLanguage,
    uiTheme: config.uiTheme,
    passiveLockEnabled: persisted?.passiveLockEnabled ?? config.passiveLockEnabled,
    actionsContinuationMode: persisted?.actionsContinuationMode ?? config.actionsContinuationMode,
    nonBlockingTasksEnabled: persisted?.nonBlockingTasksEnabled ?? config.nonBlockingTasksEnabled,
    // 可选段只能从盘面带过来：config 里没有它们。漏一条，TUI 保存就会把整段抹掉——
    // 编辑端口不该顺手删掉用户的端点三元组，也不该删掉他调好的闸门。
    ...(persisted?.subagent ? { subagent: persisted.subagent } : {}),
    ...(persisted?.workflows ? { workflows: persisted.workflows } : {}),
  };
}
