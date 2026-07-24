import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MyTerminalConfig } from './types.js';
import { fileURLToPath } from 'node:url';
import { MyTerminalError } from './store.js';

const PID_DIR = 'session-resources';
const HELPER_APP_NAME = 'MyTerminal Passive Lock.app';
const HELPER_EXECUTABLE = 'MyTerminalPassiveLock';
const HELPER_DEPLOYMENT_TARGET = '13.0';
const HELPER_BUILD_MARKER = '.build-sha256';
const PASSIVE_LOCK_PID = 'passive-lock.pid';
const PASSIVE_LOCK_CONTROL = 'passive-lock-control.json';
const PASSIVE_LOCK_LOG = 'passive-lock.log';

function resourceDir(config: MyTerminalConfig): string {
  const directory = path.join(config.stateDir, PID_DIR);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function globalPassiveLockDir(config: MyTerminalConfig): string {
  const directory = path.join(path.dirname(config.settingsPath), 'passive-lock');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function pidFile(config: MyTerminalConfig, sessionId: string): string {
  return path.join(resourceDir(config), `${sessionId}.pid`);
}

function helperAppPath(config: MyTerminalConfig): string {
  return path.join(globalPassiveLockDir(config), HELPER_APP_NAME);
}

function helperPath(config: MyTerminalConfig): string {
  return path.join(helperAppPath(config), 'Contents', 'MacOS', HELPER_EXECUTABLE);
}


function sourcePath(): string {
  const packaged = path.join(path.dirname(process.execPath), 'mac-one-shot-awake-lock.swift');
  if (existsSync(packaged)) return packaged;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'mac-one-shot-awake-lock.swift');
}



export function verifyRuntimeResources(): { ok: true; platform: NodeJS.Platform; helperSource?: string } {
  if (process.platform !== 'darwin') return { ok: true, platform: process.platform };
  const helperSource = sourcePath();
  if (!existsSync(helperSource)) throw new MyTerminalError('NOT_FOUND', `macOS helper source is missing: ${helperSource}`);
  return { ok: true, platform: process.platform, helperSource };
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function helperProcessAlive(pid: number): boolean {
  if (!processAlive(pid)) return false;
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5_000 });
  return result.status === 0 && result.stdout.includes(HELPER_EXECUTABLE);
}

function existingPid(config: MyTerminalConfig, sessionId: string): number | undefined {
  const file = pidFile(config, sessionId);
  if (!existsSync(file)) return undefined;
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && helperProcessAlive(pid)) return pid;
  } catch { /* stale resource */ }
  rmSync(file, { force: true });
  return undefined;
}

function compileHelper(config: MyTerminalConfig): string {
  if (process.platform !== 'darwin') throw new MyTerminalError('UNSUPPORTED_PLATFORM', 'The one-shot awake lock tool is available only on macOS.');
  const source = sourcePath();
  if (!existsSync(source)) throw new MyTerminalError('NOT_FOUND', `macOS helper source is missing: ${source}`);
  const sourceBytes = readFileSync(source);
  const buildHash = createHash('sha256')
    .update(sourceBytes)
    .update(`\nmacos-target=${HELPER_DEPLOYMENT_TARGET}\nbundle=io.myterminal.passive-lock\n`)
    .digest('hex');
  const app = helperAppPath(config);
  const contents = path.join(app, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const output = helperPath(config);
  const marker = path.join(contents, HELPER_BUILD_MARKER);
  try {
    if (existsSync(output) && readFileSync(marker, 'utf8').trim() === buildHash) return output;
  } catch { /* rebuild invalid or legacy app */ }
  rmSync(app, { recursive: true, force: true });
  mkdirSync(macos, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>MyTerminal Passive Lock</string>
<key>CFBundleExecutable</key><string>${HELPER_EXECUTABLE}</string>
<key>CFBundleIdentifier</key><string>io.myterminal.passive-lock</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>MyTerminal Passive Lock</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>${HELPER_DEPLOYMENT_TARGET}</string>
<key>LSUIElement</key><false/>
<key>NSAccessibilityUsageDescription</key><string>Send the macOS lock-screen shortcut after the next user input.</string>
</dict></plist>
`, { mode: 0o600 });
  const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64';
  const target = `${architecture}-apple-macosx${HELPER_DEPLOYMENT_TARGET}`;
  const result = spawnSync('xcrun', ['swiftc', '-O', '-target', target, source, '-o', output, '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'CoreGraphics', '-framework', 'IOKit'], {
    cwd: config.workspaceDir,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    throw new MyTerminalError('HELPER_BUILD_FAILED', result.stderr?.trim() || result.error?.message || 'Failed to compile the macOS helper.');
  }
  const signing = spawnSync('codesign', ['--force', '--sign', '-', '--identifier', 'io.myterminal.passive-lock', app], { encoding: 'utf8', timeout: 30_000 });
  if (signing.error || signing.status !== 0) {
    throw new MyTerminalError('HELPER_SIGN_FAILED', signing.stderr?.trim() || signing.error?.message || 'Failed to sign the macOS helper app.');
  }
  writeFileSync(marker, `${buildHash}\n`, { mode: 0o600 });
  return output;
}

function passiveLockPidFile(config: MyTerminalConfig): string { return path.join(globalPassiveLockDir(config), PASSIVE_LOCK_PID); }
function passiveLockControlFile(config: MyTerminalConfig): string { return path.join(globalPassiveLockDir(config), PASSIVE_LOCK_CONTROL); }
function passiveLockLogFile(config: MyTerminalConfig): string { return path.join(globalPassiveLockDir(config), PASSIVE_LOCK_LOG); }

function nextPassiveLockRevision(config: MyTerminalConfig): number {
  try {
    const current = JSON.parse(readFileSync(passiveLockControlFile(config), 'utf8')) as { revision?: unknown };
    const revision = Number(current.revision);
    if (Number.isSafeInteger(revision) && revision >= 0) return revision + 1;
  } catch { /* first command or invalid legacy control file */ }
  return 1;
}

export function passiveLockStatus(config: MyTerminalConfig): { supported: boolean; running: boolean; state: string; pid?: number } {
  if (process.platform !== 'darwin') return { supported: false, running: false, state: 'unsupported' };
  let pid: number | undefined;
  try { pid = Number(readFileSync(passiveLockPidFile(config), 'utf8').trim()); } catch { /* absent */ }
  if (!pid || !helperProcessAlive(pid)) { rmSync(passiveLockPidFile(config), { force: true }); return { supported: true, running: false, state: 'stopped' }; }
  let state = 'running';
  try {
    const lines = readFileSync(passiveLockLogFile(config), 'utf8').trim().split('\n');
    state = lines.at(-1)?.split(' ').slice(1).join(' ') || state;
  } catch { /* no log yet */ }
  return { supported: true, running: true, state, pid };
}

export function startPassiveLockService(config: MyTerminalConfig, command: 'arm' | 'standby' = 'arm'): { running: true; pid: number; command: string } {
  if (process.platform !== 'darwin') throw new MyTerminalError('UNSUPPORTED_PLATFORM', 'Passive lock is available only on macOS.');
  const current = passiveLockStatus(config);
  const control = { command, revision: nextPassiveLockRevision(config) };
  writeFileSync(passiveLockControlFile(config), `${JSON.stringify(control)}\n`, { mode: 0o600 });
  if (current.running && current.pid) return { running: true, pid: current.pid, command };
  const helper = compileHelper(config);
  rmSync(passiveLockLogFile(config), { force: true });
  const child = spawn(helper, ['--service', passiveLockControlFile(config), passiveLockLogFile(config)], { cwd: config.workspaceDir, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  child.unref();
  if (!child.pid) throw new MyTerminalError('HELPER_START_FAILED', 'The passive lock helper did not return a process ID.');
  writeFileSync(passiveLockPidFile(config), `${child.pid}\n`, { mode: 0o600 });
  return { running: true, pid: child.pid, command };
}

export function commandPassiveLock(config: MyTerminalConfig, command: 'arm' | 'standby' | 'stop'): { command: string; pid?: number } {
  const current = passiveLockStatus(config);
  if (command === 'stop') {
    if (current.pid) { try { process.kill(current.pid, 'SIGTERM'); } catch { /* already exited */ } }
    rmSync(passiveLockPidFile(config), { force: true });
    return { command, pid: current.pid };
  }
  const started = startPassiveLockService(config, command);
  return { command, pid: started.pid };
}

export function armMacOneShotAwakeLock(config: MyTerminalConfig, sessionId: string): { launched: true; oneShot: true; pid: number; sessionId: string; state: 'waiting_for_permission_or_armed' } {
  const existing = existingPid(config, sessionId);
  if (existing) return { launched: true, oneShot: true, pid: existing, sessionId, state: 'waiting_for_permission_or_armed' };
  const helper = compileHelper(config);
  const logFile = path.join(resourceDir(config), `${sessionId}.log`);
  rmSync(logFile, { force: true });
  const child = spawn(helper, [path.join(config.stateDir, 'state.json'), sessionId, logFile], {
    cwd: config.workspaceDir,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  if (!child.pid) throw new MyTerminalError('HELPER_START_FAILED', 'The macOS helper did not return a process ID.');
  writeFileSync(pidFile(config, sessionId), `${child.pid}\n`, { mode: 0o600 });
  writeFileSync(logFile, `${new Date().toISOString()} launched pid=${child.pid}\n`, { mode: 0o600 });
  return { launched: true, oneShot: true, pid: child.pid, sessionId, state: 'waiting_for_permission_or_armed' };
}

export function disarmSessionResources(config: MyTerminalConfig, sessionId: string): { disarmed: boolean; pid?: number } {
  const file = pidFile(config, sessionId);
  const pid = existingPid(config, sessionId);
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  rmSync(file, { force: true });
  return { disarmed: Boolean(pid), pid };
}


export function disarmAllSessionResources(config: MyTerminalConfig): { disarmed: number; pids: number[] } {
  const directory = resourceDir(config);
  const pids: number[] = [];
  for (const entry of existsSync(directory) ? readdirSync(directory) : []) {
    if (!entry.endsWith('.pid')) continue;
    const sessionId = entry.slice(0, -4);
    const result = disarmSessionResources(config, sessionId);
    if (result.pid) pids.push(result.pid);
  }
  return { disarmed: pids.length, pids };
}

export function reapSessionResources(config: MyTerminalConfig): void {
  const directory = resourceDir(config);
  for (const entry of existsSync(directory) ? readdirSync(directory) : []) {
    if (!entry.endsWith('.pid')) continue;
    const sessionId = entry.slice(0, -4);
    existingPid(config, sessionId);
  }
}
