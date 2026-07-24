import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CURRENT_VERSION } from './version.js';
import {
  executeUpdateTransaction,
  type UpdateAuditRecord,
  type UpdateRestoreResult,
} from './update-transaction.js';

export { CURRENT_VERSION } from './version.js';
export { readUpdateHistory, type UpdateAuditRecord } from './update-transaction.js';
const REPOSITORY = 'epslkslsksndnsjs-lab/myterminal';

export type UpdateStatus = {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  checkedAt?: string;
  checking: boolean;
  error?: string;
  restartRequired?: boolean;
  runningClusterVersions?: string[];
};

export type UpdateSnapshot = { backupDir: string; files: string[] };
export type InstallUpdateOptions = {
  root?: string;
  oldVersion?: string;
  pid?: number;
  restartReason?: string;
  migrate?: () => Promise<void>;
  restart?: () => Promise<void>;
  runtimeLog?: (message: string, level?: 'info' | 'error') => void;
  installer?: (tag: string) => Promise<void>;
  installationRoot?: string;
  installerTimeoutMs?: number;
};

function versionParts(value: string): number[] {
  return value.replace(/^v/, '').split('.').map((item) => Number.parseInt(item, 10) || 0);
}

export function isNewerVersion(latest: string, current = CURRENT_VERSION): boolean {
  const left = versionParts(latest);
  const right = versionParts(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  }
  return false;
}

export async function checkForUpdate(fetcher: typeof fetch = fetch): Promise<UpdateStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `myterminal/${CURRENT_VERSION}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub release check failed with HTTP ${response.status}.`);
    const data = await response.json() as { tag_name?: string };
    if (!data.tag_name) throw new Error('Latest GitHub release did not contain a tag name.');
    return { currentVersion: CURRENT_VERSION, latestVersion: data.tag_name.replace(/^v/, ''), updateAvailable: isNewerVersion(data.tag_name), checkedAt: new Date().toISOString(), checking: false };
  } catch (error) {
    return { currentVersion: CURRENT_VERSION, updateAvailable: false, checkedAt: new Date().toISOString(), checking: false, error: error instanceof Error ? error.message : String(error) };
  } finally { clearTimeout(timeout); }
}

export function installationRoot(): string {
  if (process.env.MYTERMINAL_HOME) return path.resolve(process.env.MYTERMINAL_HOME);
  const executableName = path.basename(process.execPath).toLowerCase();
  if (executableName === 'myterminal' || executableName === 'myterminal.exe') {
    const releaseDir = path.dirname(process.execPath);
    const releasesDir = path.dirname(releaseDir);
    if (path.basename(releasesDir) === 'releases') return path.dirname(releasesDir);
    return releaseDir;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}


function configRoot(): string {
  return path.resolve(process.env.MYTERMINAL_CONFIG_DIR || path.join(os.homedir(), '.config', 'myterminal'));
}

export function snapshotUpdateData(root = configRoot()): UpdateSnapshot {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const backupRoot = path.join(root, 'update-backups');
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backupDir = path.join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (dir === root && (name === 'update-backups' || name === 'update-history.jsonl' || name === 'update.lock')) continue;
      const source = path.join(dir, name);
      const relative = path.relative(root, source);
      const stat = statSync(source);
      if (stat.isDirectory()) walk(source);
      else if (stat.isFile()) {
        files.push(relative);
        const destination = path.join(backupDir, relative);
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        cpSync(source, destination, { recursive: false });
      }
    }
  };
  try {
    walk(root);
    return { backupDir, files };
  } catch (error) {
    rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }
}

function credentialsMatch(target: string, backup: string): boolean {
  if (path.basename(target) !== 'config.json' || !existsSync(target) || !existsSync(backup)) return true;
  try {
    const before = JSON.parse(readFileSync(backup, 'utf8')) as { connectorKey?: unknown; actionsToken?: unknown };
    const after = JSON.parse(readFileSync(target, 'utf8')) as { connectorKey?: unknown; actionsToken?: unknown };
    return before.connectorKey === after.connectorKey && before.actionsToken === after.actionsToken;
  } catch { return false; }
}

export function restoreUpdateData(snapshot: UpdateSnapshot, root = configRoot(), force = false): UpdateRestoreResult {
  const result: UpdateRestoreResult = { restored: [], skipped: [], failed: [], credentialsPreserved: true };
  for (const relative of snapshot.files) {
    const target = path.join(root, relative);
    const backup = path.join(snapshot.backupDir, relative);
    try {
      let restore = force || !existsSync(target);
      if (!restore) {
        const targetSize = statSync(target).size;
        const backupSize = statSync(backup).size;
        if (relative.endsWith('.json')) {
          try {
            const before = JSON.parse(readFileSync(backup, 'utf8')) as { revision?: number; sessions?: unknown[]; messages?: unknown[]; connectorKey?: unknown; actionsToken?: unknown };
            const after = JSON.parse(readFileSync(target, 'utf8')) as { revision?: number; sessions?: unknown[]; messages?: unknown[]; connectorKey?: unknown; actionsToken?: unknown };
            restore = Number(after.revision || 0) < Number(before.revision || 0)
              || (after.sessions?.length || 0) < (before.sessions?.length || 0)
              || (after.messages?.length || 0) < (before.messages?.length || 0)
              || before.connectorKey !== after.connectorKey
              || before.actionsToken !== after.actionsToken;
          } catch { restore = true; }
        } else if (relative.endsWith('.jsonl')) restore = targetSize < backupSize;
      }
      if (restore) {
        mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        cpSync(backup, target);
        result.restored.push(relative);
      } else result.skipped.push(relative);
      if (path.basename(relative) === 'config.json') result.credentialsPreserved = credentialsMatch(target, backup) && result.credentialsPreserved;
    } catch (error) {
      result.failed.push({ file: relative, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export function restoreMissingUpdateData(snapshot: UpdateSnapshot, root = configRoot()): UpdateRestoreResult {
  return restoreUpdateData(snapshot, root, false);
}

function pruneUpdateBackups(root = configRoot()): void {
  const backupRoot = path.join(root, 'update-backups');
  if (!existsSync(backupRoot)) return;
  const dirs = readdirSync(backupRoot).map((name) => path.join(backupRoot, name)).filter((item) => statSync(item).isDirectory()).sort().reverse();
  for (const old of dirs.slice(3)) rmSync(old, { recursive: true, force: true });
}

export function installedVersion(root = installationRoot()): string | undefined {
  try {
    const current = readFileSync(path.join(root, 'current'), 'utf8').trim();
    return current.replace(/^v/, '') || undefined;
  } catch { return undefined; }
}

export function isSourceCheckout(packageRoot = installationRoot()): boolean {
  return existsSync(path.join(packageRoot, '.git'));
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireUpdateLock(root: string): () => void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'update.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try { writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`); }
      finally { closeSync(fd); }
      return () => { try { unlinkSync(file); } catch { /* already removed */ } };
    } catch (error) {
      const detail = error as NodeJS.ErrnoException;
      if (detail.code !== 'EEXIST') throw error;
      let holderPid: number | undefined;
      try {
        const holder = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number };
        const parsedPid = Number(holder.pid);
        if (!Number.isInteger(parsedPid) || parsedPid <= 0) throw new Error('Update lock has no valid PID.');
        holderPid = parsedPid;
      } catch {
        const ageMs = Date.now() - statSync(file).mtimeMs;
        if (ageMs < 30_000) throw new Error('Another MyTerminal update lock is being initialized.');
      }
      if (holderPid && processAlive(holderPid)) throw new Error(`Another MyTerminal update is active in PID ${holderPid}.`);
      try { unlinkSync(file); } catch { /* retry */ }
    }
  }
  throw new Error('Unable to acquire MyTerminal update lock.');
}

function releaseBinaryPath(root: string, version: string): string {
  const normalized = version.startsWith('v') ? version : `v${version}`;
  return path.join(root, 'releases', normalized, process.platform === 'win32' ? 'myterminal.exe' : 'myterminal');
}

function restoreInstalledVersion(root: string, version: string): void {
  const normalized = version.startsWith('v') ? version : `v${version}`;
  if (!existsSync(releaseBinaryPath(root, normalized))) throw new Error(`Rollback release is unavailable: ${normalized}`);
  const temporary = path.join(root, `current.rollback.${process.pid}.tmp`);
  writeFileSync(temporary, `${normalized}\n`, { mode: 0o600 });
  renameSync(temporary, path.join(root, 'current'));
}

async function verifyInstalledRelease(root: string, tag: string): Promise<void> {
  const expected = tag.replace(/^v/, '');
  const actual = installedVersion(root);
  if (actual !== expected) throw new Error(`Installed version verification failed: expected ${expected}, found ${actual || 'none'}.`);
  const binary = releaseBinaryPath(root, tag);
  if (!existsSync(binary)) throw new Error(`Installed binary is missing: ${binary}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_500);
      killTimer.unref?.();
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 1000) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 1000) stderr += chunk.toString('utf8'); });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (timedOut) finish(new Error('Installed binary verification timed out.'));
      else if (code !== 0 || stdout.trim().replace(/^v/, '') !== expected) finish(new Error(`Installed binary verification failed: ${stderr.trim() || stdout.trim() || `exit ${code}`}`));
      else finish();
    });
  });
}

async function terminateInstallerTree(child: ChildProcess, force: boolean): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
      const killer = spawn('taskkill.exe', args, { stdio: 'ignore', windowsHide: true });
      let settled = false;
      const finish = (): void => { if (!settled) { settled = true; resolve(); } };
      killer.once('error', () => { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already exited */ } finish(); });
      killer.once('close', finish);
    });
    return;
  }
  try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); }
  catch { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already exited */ } }
}

async function runInstaller(tag: string, root = installationRoot(), timeoutMs = 10 * 60_000): Promise<void> {
  const normalized = tag.startsWith('v') ? tag : `v${tag}`;
  const rawBase = `https://raw.githubusercontent.com/${REPOSITORY}/${normalized}/scripts`;
  const script = process.platform === 'win32'
    ? 'install-windows.ps1'
    : process.platform === 'linux' ? 'install-linux.sh' : 'install-macos.sh';
  const command = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$env:MYTERMINAL_INSTALL_ONLY='1'; irm '${rawBase}/${script}' | iex`]
    : ['-lc', `export MYTERMINAL_INSTALL_ONLY=1; curl -fsSL '${rawBase}/${script}' | /bin/bash`];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: { ...process.env, MYTERMINAL_HOME: root },
      detached: process.platform !== 'win32',
    });
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateInstallerTree(child, false);
      killTimer = setTimeout(() => { void terminateInstallerTree(child, true); }, 1_500);
      killTimer.unref?.();
    }, timeoutMs);
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (timedOut) {
        void terminateInstallerTree(child, true).finally(() => finish(new Error(`Updater timed out after ${timeoutMs}ms.`)));
      } else if (code === 0) finish();
      else finish(new Error(`Updater exited with code ${code ?? 'unknown'}.`));
    });
  });
}

export async function installUpdate(tag: string, options: InstallUpdateOptions = {}): Promise<UpdateAuditRecord> {
  const root = path.resolve(options.root || configRoot());
  const packageRoot = path.resolve(options.installationRoot || installationRoot());
  const previousInstalledVersion = installedVersion(packageRoot);
  const releaseLock = acquireUpdateLock(root);
  try {
    return await executeUpdateTransaction({
      historyRoot: root,
      oldVersion: (options.oldVersion || previousInstalledVersion || CURRENT_VERSION).replace(/^v/, ''),
      newVersion: tag.replace(/^v/, ''),
      pid: options.pid,
      restartReason: options.restartReason,
      snapshot: () => snapshotUpdateData(root),
      install: async () => {
        if (options.installer) await options.installer(tag);
        else {
          await runInstaller(tag, packageRoot, options.installerTimeoutMs);
          await verifyInstalledRelease(packageRoot, tag);
        }
      },
      migrate: options.migrate,
      restart: options.restart,
      restore: (snapshot, force) => {
        const result = restoreUpdateData(snapshot, root, force);
        if (force && previousInstalledVersion) {
          try { restoreInstalledVersion(packageRoot, previousInstalledVersion); }
          catch (error) { result.failed.push({ file: path.join(packageRoot, 'current'), error: error instanceof Error ? error.message : String(error) }); }
        }
        return result;
      },
      runtimeLog: options.runtimeLog,
    });
  } finally {
    releaseLock();
    try { pruneUpdateBackups(root); }
    catch (error) { options.runtimeLog?.(`Update backup pruning failed: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
  }
}
