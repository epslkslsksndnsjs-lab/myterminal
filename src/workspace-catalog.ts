import path from 'node:path';
import type { MyTerminalConfig } from './types.js';
import { readWorkspaceRegistry, releaseWorkspaceRecord, upsertWorkspaceRecord, workspaceId, type WorkspaceRecord } from './instances.js';

/** Single source of truth for workspace catalog access within one config root. */
export class WorkspaceCatalog {
  readonly configDir: string;

  constructor(configDir: string) {
    this.configDir = path.resolve(configDir);
  }

  static fromConfig(config: Pick<MyTerminalConfig, 'settingsPath'>): WorkspaceCatalog {
    return new WorkspaceCatalog(path.dirname(config.settingsPath));
  }

  snapshot(): WorkspaceRecord[] {
    return readWorkspaceRegistry(this.configDir);
  }

  publish(config: MyTerminalConfig, port: number, pid = process.pid): void {
    upsertWorkspaceRecord(this.configDir, {
      id: workspaceId(config.workspaceDir),
      workspaceDir: config.workspaceDir,
      stateDir: config.stateDir,
      lastHost: config.host,
      lastPort: port,
      lastPid: pid,
      lastStartedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
  }

  release(workspaceDir: string, pid = process.pid): void {
    releaseWorkspaceRecord(this.configDir, workspaceId(workspaceDir), pid);
  }
}
