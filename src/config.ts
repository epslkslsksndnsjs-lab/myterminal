import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { describePortOwner, portOwner, upsertWorkspaceRecord, workspaceId, workspaceStateDir } from './instances.js';
import { migrateWorkspaceState } from './migration.js';
import os from 'node:os';
import path from 'node:path';
import type { MyTerminalConfig, MyTerminalSettings, SubagentSettings } from './types.js';

const WORKSPACE_PLACEHOLDERS = new Set(['/absolute/path/to/project']);
const PUBLIC_URL_PLACEHOLDERS = new Set(['https://replace-with-your-tunnel.example']);

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function optionalEnv(value: string | undefined, placeholders: Set<string> = new Set()): string | undefined {
  const candidate = value?.trim();
  return candidate && !placeholders.has(candidate) ? candidate : undefined;
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = optionalEnv(env.MYTERMINAL_CONFIG_DIR);
  const base = configured
    ? path.resolve(configured)
    : path.join(optionalEnv(env.XDG_CONFIG_HOME) || path.join(os.homedir(), '.config'), 'myterminal');
  return path.join(base, 'config.json');
}

export function defaultWorkspaceForCwd(cwd = process.cwd()): string {
  const resolved = path.resolve(cwd);
  if (path.basename(resolved) === 'myterminal') {
    const parent = path.dirname(resolved);
    if (existsSync(path.join(parent, 'package.json'))) return realpathSync(parent);
  }
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

export function isDirectory(candidate: string): boolean {
  try { return existsSync(candidate) && statSync(candidate).isDirectory(); }
  catch { return false; }
}

export type RuntimeEnvironmentStatus =
  | { status: 'valid' }
  | { status: 'workspace_missing' | 'volume_unmounted' | 'permission_denied' | 'state_dir_unavailable'; message: string };

export function assessRuntimeEnvironment(settings: MyTerminalSettings, env: NodeJS.ProcessEnv = process.env): RuntimeEnvironmentStatus {
  const workspaceDir = path.resolve(settings.workspaceDir);
  try {
    if (!existsSync(workspaceDir)) {
      const volumeRoot = workspaceDir.startsWith('/Volumes/') ? workspaceDir.split('/').slice(0, 3).join('/') : undefined;
      return volumeRoot && !existsSync(volumeRoot)
        ? { status: 'volume_unmounted', message: `Workspace volume is not mounted: ${volumeRoot}` }
        : { status: 'workspace_missing', message: `Workspace is unavailable: ${workspaceDir}` };
    }
    if (!statSync(workspaceDir).isDirectory()) return { status: 'workspace_missing', message: `Workspace is not a directory: ${workspaceDir}` };
  } catch (error) {
    const detail = error as NodeJS.ErrnoException;
    if (detail.code === 'EACCES' || detail.code === 'EPERM') return { status: 'permission_denied', message: `Workspace permission denied: ${workspaceDir}` };
    return { status: 'workspace_missing', message: `Workspace is unavailable: ${detail.message}` };
  }
  try {
    const configDir = path.dirname(settingsPath(env));
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { status: 'state_dir_unavailable', message: `Settings directory is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { status: 'valid' };
}


export function isValidPublicBaseUrl(value: string): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname));
  } catch {
    return false;
  }
}

export function createDefaultSettings(workspaceDir = defaultWorkspaceForCwd()): MyTerminalSettings {
  return {
    schemaVersion: 1,
    workspaceDir,
    host: '127.0.0.1',
    port: 3210,
    connectorKey: randomBytes(24).toString('hex'),
    actionsToken: randomBytes(32).toString('hex'),
    publicBaseUrl: '',
    maxOutputChars: 120_000,
    commandTimeoutSec: 60,
    uiLanguage: 'zh-CN',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
  };
}


// ADR-0045（spine）：subagent 可选字段默认值集中施加。
// validateSettings（校验/保存归一化）与 server 运行时加载路径（server.ts 重读 settings、
// 不经 validateSettings）共用同一实现；否则最小配置（只填 model/baseUrl/apiKey）下
// maxTurns/timeoutSec 等为 undefined → executor 在 AbortSignal.timeout(undefined*1000)
// 抛 RangeError、while(turns<undefined) 永不循环，subagent 静默崩溃（code-review S#5，合并阻断）。
export function applySubagentDefaults(sub: SubagentSettings): SubagentSettings {
  return {
    ...sub,
    maxTurns: boundedInteger(sub.maxTurns != null ? String(sub.maxTurns) : undefined, 50, 1, 200),
    timeoutSec: boundedInteger(sub.timeoutSec != null ? String(sub.timeoutSec) : undefined, 300, 30, 3600),
    maxParallel: boundedInteger(sub.maxParallel != null ? String(sub.maxParallel) : undefined, 2, 1, 4),
    contextWindow: boundedInteger(sub.contextWindow != null ? String(sub.contextWindow) : undefined, 120_000, 1_000, 1_000_000),
    maxOutput: boundedInteger(sub.maxOutput != null ? String(sub.maxOutput) : undefined, 32_000, 1_000, 200_000),
    compactThreshold: boundedInteger(sub.compactThreshold != null ? String(sub.compactThreshold) : undefined, 80_000, 1_000, 500_000),
  };
}

export function validateSettings(settings: MyTerminalSettings): string[] {
  const errors: string[] = [];
  if (typeof settings.workspaceDir !== 'string' || !settings.workspaceDir.trim()) errors.push('Workspace cannot be empty.');
  if (typeof settings.host !== 'string' || !settings.host.trim()) errors.push('Host cannot be empty.');
  if (!Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535) errors.push('Port must be an integer from 0 to 65535.');
  if (typeof settings.publicBaseUrl !== 'string' || !isValidPublicBaseUrl(settings.publicBaseUrl)) errors.push('Public URL must use HTTPS (localhost may use HTTP).');
  if (typeof settings.connectorKey !== 'string' || typeof settings.actionsToken !== 'string' || settings.connectorKey.length < 24 || settings.actionsToken.length < 24) errors.push('Connector and Actions credentials must contain at least 24 characters.');
  if (!Number.isInteger(settings.maxOutputChars) || settings.maxOutputChars < 4_000 || settings.maxOutputChars > 1_000_000) errors.push('Maximum output must be from 4000 to 1000000 characters.');
  if (!Number.isInteger(settings.commandTimeoutSec) || settings.commandTimeoutSec < 1 || settings.commandTimeoutSec > 3600) errors.push('Command timeout must be from 1 to 3600 seconds.');
  if (!['en', 'zh-CN'].includes(settings.uiLanguage)) errors.push('UI language must be en or zh-CN.');
  if (!['dark', 'light'].includes(settings.uiTheme)) errors.push('UI theme must be dark or light.');
  if (typeof settings.passiveLockEnabled !== 'boolean') errors.push('Passive lock enabled must be boolean.');
  if (!['off', 'adaptive', 'next-call', 'lookahead-3'].includes(settings.actionsContinuationMode)) errors.push('Actions continuation mode must be off, adaptive, next-call, or lookahead-3.');
  if (typeof settings.nonBlockingTasksEnabled !== 'boolean') errors.push('Non-blocking tasks enabled must be boolean.');

  // ADR-0045（spine）：subagent 配置校验——零默认、缺配即拒。
  if (settings.subagent) {
    const sub = settings.subagent;
    // 遗留 `provider` 配置：provider 概念已废弃，整段静默忽略（不报错、不启用），
    // 交由后续迁移工单转换为新契约（model/baseUrl/apiKey）。见 ticket 01 项 14。
    const legacyProvider = (sub as { provider?: string }).provider;
    if (legacyProvider === undefined) {
      if (typeof sub.enabled !== 'boolean') {
        if (sub.enabled !== undefined) errors.push('Subagent enabled must be boolean.');
        sub.enabled = true;
      }
      // 三必填：model / baseUrl / apiKey 缺任一即报错（零默认铁律，代码永不猜）
      if (typeof sub.model !== 'string' || !sub.model.trim()) {
        errors.push('Subagent model is required.');
      }
      if (typeof sub.baseUrl !== 'string' || !sub.baseUrl.trim()) {
        errors.push('Subagent baseUrl is required.');
      }
      if (typeof sub.apiKey !== 'string' || !sub.apiKey.trim()) {
        errors.push('Subagent apiKey is required.');
      }
      // 三可选：带默认（有配置用配置，无配置用默认）
      // 默认值集中由 applySubagentDefaults 施加（见下方函数），validateSettings 与
      // server 运行时加载路径共用同一实现，避免 server 重读 settings 漏默认值（code-review S#5）。
      Object.assign(sub, applySubagentDefaults(sub));

      // fallbackModel 可选，默认无；空串视为未设置
      if (sub.fallbackModel !== undefined && (typeof sub.fallbackModel !== 'string' || !sub.fallbackModel.trim())) {
        delete sub.fallbackModel;
      }
    }
  }

  return errors;
}


export async function validateSettingsFeasibility(settings: MyTerminalSettings, current?: { host: string; port: number }): Promise<string[]> {
  const errors = validateSettings(settings);
  const environment = assessRuntimeEnvironment(settings);
  if (environment.status !== 'valid') errors.push(environment.message);
  if (errors.length || settings.port === 0 || (current && current.host === settings.host && current.port === settings.port)) return errors;
  const portError = await new Promise<string | undefined>((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        const owner = portOwner(settings.port);
        if (owner?.pid === process.pid) { resolve(undefined); return; }
        const request = http.get({ host: settings.host, port: settings.port, path: '/health', timeout: 1000 }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => {
            try {
              const health = JSON.parse(body) as { product?: string; clustered?: boolean };
              if (response.statusCode === 200 && health.product === 'myterminal' && health.clustered === true) { resolve(undefined); return; }
            } catch { /* unrelated service */ }
            resolve(`Port ${settings.port} is already in use on ${settings.host} (${describePortOwner(settings.port)}).`);
          });
        });
        request.setTimeout(1000, () => {
          request.destroy();
          resolve(`Port ${settings.port} is already in use on ${settings.host} (${describePortOwner(settings.port)}).`);
        });
        request.once('error', () => resolve(`Port ${settings.port} is already in use on ${settings.host} (${describePortOwner(settings.port)}).`));
        return;
      }
      resolve(`Cannot listen on ${settings.host}:${settings.port}: ${error.message}`);
    });
    probe.listen(settings.port, settings.host, () => probe.close(() => resolve(undefined)));
  });
  return portError ? [...errors, portError] : errors;
}

export function parseMyTerminalSettings(env: NodeJS.ProcessEnv = process.env): MyTerminalSettings | undefined {
  const configPath = settingsPath(env);
  if (!existsSync(configPath)) return undefined;
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<MyTerminalSettings>;
  if (parsed.schemaVersion !== 1) throw new Error(`Unsupported MyTerminal settings format: ${configPath}`);
  const settings = { uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false, actionsContinuationMode: 'off', nonBlockingTasksEnabled: false, ...parsed } as MyTerminalSettings;
  const errors = validateSettings(settings);
  if (errors.length) throw new Error(`Invalid MyTerminal settings: ${errors.join(' ')}`);
  return settings;
}

export const readMyTerminalSettings = parseMyTerminalSettings;

export function saveMyTerminalSettings(settings: MyTerminalSettings, env: NodeJS.ProcessEnv = process.env): void {
  const normalized: MyTerminalSettings = {
    ...settings,
    workspaceDir: realpathSync(path.resolve(settings.workspaceDir)),
    host: settings.host.trim(),
    publicBaseUrl: settings.publicBaseUrl.trim().replace(/\/$/, ''),
  };
  const errors = validateSettings(normalized);
  if (errors.length) throw new Error(errors.join(' '));
  const configPath = settingsPath(env);
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${configPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, configPath);
    chmodSync(configPath, 0o600);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* best effort */ }
    throw error;
  }
}

export function rotateMyTerminalCredentials(settings: MyTerminalSettings): MyTerminalSettings {
  return {
    ...settings,
    connectorKey: randomBytes(24).toString('hex'),
    actionsToken: randomBytes(32).toString('hex'),
  };
}

function envWorkspace(env: NodeJS.ProcessEnv): string | undefined {
  return optionalEnv(env.MYTERMINAL_WORKSPACE_DIR, WORKSPACE_PLACEHOLDERS);
}

export function settingsWithEnvironment(settings: MyTerminalSettings, env: NodeJS.ProcessEnv = process.env): MyTerminalSettings {
  return {
    ...settings,
    workspaceDir: path.resolve(envWorkspace(env) || settings.workspaceDir),
    host: optionalEnv(env.MYTERMINAL_HOST) || settings.host,
    port: boundedInteger(env.MYTERMINAL_PORT, settings.port, 0, 65535),
    publicBaseUrl: optionalEnv(env.MYTERMINAL_PUBLIC_BASE_URL, PUBLIC_URL_PLACEHOLDERS) ?? settings.publicBaseUrl,
    actionsToken: optionalEnv(env.MYTERMINAL_ACTIONS_TOKEN) || settings.actionsToken,
    connectorKey: optionalEnv(env.MYTERMINAL_CONNECTOR_KEY) || settings.connectorKey,
    maxOutputChars: boundedInteger(env.MYTERMINAL_MAX_OUTPUT_CHARS, settings.maxOutputChars, 4_000, 1_000_000),
    commandTimeoutSec: boundedInteger(env.MYTERMINAL_COMMAND_TIMEOUT_SEC, settings.commandTimeoutSec, 1, 3600),
    actionsContinuationMode: ['off', 'adaptive', 'next-call', 'lookahead-3'].includes(String(env.MYTERMINAL_ACTIONS_CONTINUATION_MODE))
      ? env.MYTERMINAL_ACTIONS_CONTINUATION_MODE as MyTerminalSettings['actionsContinuationMode']
      : settings.actionsContinuationMode,
    nonBlockingTasksEnabled: env.MYTERMINAL_NON_BLOCKING_TASKS === undefined
      ? settings.nonBlockingTasksEnabled
      : /^(1|true|yes|on)$/i.test(env.MYTERMINAL_NON_BLOCKING_TASKS),
    // ADR-0045（spine）：fallbackModel 支持 env 覆盖配置文件（默认无，env 可临时切换）
    subagent: settings.subagent
      ? {
          ...settings.subagent,
          fallbackModel: optionalEnv(env.MYTERMINAL_SUBAGENT_FALLBACK_MODEL) ?? settings.subagent.fallbackModel,
        }
      : undefined,
  };
}


function archivedLegacyStateDirs(configDir: string): string[] {
  const root = path.join(configDir, 'install-backups');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, '.myterminal'))
    .filter((candidate) => existsSync(candidate));
}

function draftAgentMd(configDir: string): void {
  try {
    const file = path.join(configDir, 'AGENT.md');
    if (existsSync(file)) return;
    const template = [
      '# MyTerminal Agent 指令',
      '#',
      '# 在这里写入你的自定义规则。每次 ChatGPT 连接时，这些内容',
      '# 会自动注入，模型会读取并遵循。',
      '#',
      '# 示例:',
      '# - 永远使用 pnpm，不要用 npm',
      '# - 修改文件前先检查 git_status',
      '# - 完成后自动提交代码',
      '# - 用中文回复',
      '',
    ].join('\n');
    writeFileSync(file, template, 'utf8');
  } catch {
    // best-effort: AGENT.md creation must never block startup
  }
}

function draftSkillDirs(configDir: string, workspaceDir: string): void {
  try {
    for (const dir of [path.join(configDir, 'skills'), path.join(workspaceDir, '.myterminal', 'skills')]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  } catch {
    // best-effort: skill directory creation must never block startup
  }
}

export function loadMyTerminalConfig(env: NodeJS.ProcessEnv = process.env): MyTerminalConfig {
  const stored = readMyTerminalSettings(env);
  const base = stored || createDefaultSettings(path.resolve(envWorkspace(env) || defaultWorkspaceForCwd()));
  const settings = settingsWithEnvironment(base, env);
  const errors = validateSettings(settings);
  if (errors.length) throw new Error(errors.join(' '));
  const environment = assessRuntimeEnvironment(settings, env);
  if (environment.status !== 'valid') throw new Error(environment.message);
  const workspaceDir = realpathSync(settings.workspaceDir);
  const configDir = path.dirname(settingsPath(env));
  draftAgentMd(configDir);
  draftSkillDirs(configDir, workspaceDir);
  const stateDir = workspaceStateDir(configDir, workspaceDir);
  const legacyGlobalStateDir = path.join(configDir, 'state');
  const migratedGlobalStateDir = path.join(configDir, 'state.migrated');
  const legacyStateDir = path.join(workspaceDir, '.myterminal');
  migrateWorkspaceState(stateDir, [legacyGlobalStateDir, migratedGlobalStateDir, legacyStateDir, ...archivedLegacyStateDirs(configDir)]);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  upsertWorkspaceRecord(configDir, { id: workspaceId(workspaceDir), workspaceDir, stateDir, lastHost: settings.host, lastPort: settings.port, lastSeenAt: new Date().toISOString() });
  const publicBaseUrl = settings.publicBaseUrl || `http://${settings.host}:${settings.port}`;
  return {
    settingsPath: settingsPath(env),
    workspaceDir,
    stateDir,
    host: settings.host,
    port: settings.port,
    connectorKey: settings.connectorKey,
    actionsToken: settings.actionsToken,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ''),
    maxOutputChars: settings.maxOutputChars,
    commandTimeoutSec: settings.commandTimeoutSec,
    uiLanguage: settings.uiLanguage,
    uiTheme: settings.uiTheme,
    passiveLockEnabled: settings.passiveLockEnabled,
    actionsContinuationMode: settings.actionsContinuationMode,
    nonBlockingTasksEnabled: settings.nonBlockingTasksEnabled,
  };
}

export function maskCredential(value: string): string {
  if (value.length < 12) return '••••••••';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
