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
  };
}
