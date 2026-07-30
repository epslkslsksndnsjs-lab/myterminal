import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { LOCK_STALE_THRESHOLD_MS } from './lock-thresholds.js';

export type PortOwner = { pid: number; command: string; user?: string };
export type WorkspaceRecord = {
  id: string;
  workspaceDir: string;
  stateDir: string;
  lastHost?: string;
  lastPort?: number;
  lastPid?: number;
  lastStartedAt?: string;
  lastSeenAt: string;
  label?: string;
};

type Registry = { schemaVersion: 1; workspaces: WorkspaceRecord[] };

export function workspaceId(workspaceDir: string): string {
  return createHash('sha256').update(path.resolve(workspaceDir)).digest('hex').slice(0, 16);
}

export function registryPath(configDir: string): string {
  return path.join(configDir, 'workspaces.json');
}

export function workspaceStateDir(configDir: string, workspaceDir: string): string {
  return path.join(configDir, 'workspaces', workspaceId(workspaceDir));
}

export function readWorkspaceRegistry(configDir: string): WorkspaceRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(configDir), 'utf8')) as Registry;
    return Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
  } catch {
    return [];
  }
}

/**
 * Serialize every workspace-catalog mutation across processes and replace the
 * file atomically. Callers must keep durable catalog data and transient runtime
 * lease fields consistent within one update callback.
 */
function updateWorkspaceRegistry(configDir: string, update: (records: WorkspaceRecord[]) => WorkspaceRecord[]): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const file = registryPath(configDir);
  const lock = `${file}.lock`;
  const lockToken = `${process.pid}:${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      writeFileSync(lock, lockToken, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const observed = readFileSync(lock, 'utf8');
        const owner = Number(observed.split(':', 1)[0]);
        const tooOld = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_THRESHOLD_MS;
        let alive = Number.isInteger(owner) && owner > 0;
        if (alive) { try { process.kill(owner, 0); } catch { alive = false; } }
        if ((!alive || tooOld) && readFileSync(lock, 'utf8') === observed) {
          try { unlinkSync(lock); } catch { /* another contender resolved it */ }
          continue;
        }
      } catch { /* a partially observed lock is never safe to remove */ }
      if (Date.now() >= deadline) throw new Error(`Workspace registry lock timeout: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    const records = update(readWorkspaceRegistry(configDir));
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, workspaces: records }, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { if (existsSync(lock) && readFileSync(lock, 'utf8') === lockToken) unlinkSync(lock); } catch { /* best effort */ }
  }
}

export function upsertWorkspaceRecord(configDir: string, record: WorkspaceRecord): void {
  updateWorkspaceRegistry(configDir, (records) => {
    const index = records.findIndex((item) => item.id === record.id);
    if (index >= 0) records[index] = { ...records[index], ...record };
    else records.push(record);
    return records;
  });
}

/** Release only the transient lease owned by the matching workspace and PID. */
export function releaseWorkspaceRecord(configDir: string, id: string, pid: number): void {
  updateWorkspaceRegistry(configDir, (records) => records.map((record) => {
    if (record.id !== id || record.lastPid !== pid) return record;
    const { lastPid: _lastPid, ...released } = record;
    return { ...released, lastSeenAt: new Date().toISOString() };
  }));
}

const MAX_RUNTIME_LOG_BYTES = 5 * 1024 * 1024;
const RUNTIME_LOG_ARCHIVES = 3;

function rotateRuntimeLog(file: string): void {
  if (!existsSync(file) || statSync(file).size < MAX_RUNTIME_LOG_BYTES) return;
  for (let index = RUNTIME_LOG_ARCHIVES; index >= 1; index -= 1) {
    const source = index === 1 ? file : `${file}.${index - 1}`;
    const target = `${file}.${index}`;
    if (!existsSync(source)) continue;
    if (index === RUNTIME_LOG_ARCHIVES) { try { unlinkSync(target); } catch { /* absent archive */ } }
    renameSync(source, target);
  }
}

export function appendWorkspaceLog(stateDir: string, entry: unknown): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'runtime.jsonl');
  rotateRuntimeLog(file);
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function readTailLines(file: string, limit: number, offset = 0): string[] {
  if (!existsSync(file) || limit <= 0) return [];
  const size = statSync(file).size;
  if (!size) return [];
  const fd = openSync(file, 'r');
  try {
    const chunkSize = 64 * 1024;
    let position = size;
    let text = '';
    const wanted = Math.max(1, limit + offset + 1);
    while (position > 0 && text.split('\n').length <= wanted) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      readSync(fd, buffer, 0, length, position);
      text = buffer.toString('utf8') + text;
    }
    const lines = text.split('\n').filter(Boolean);
    const end = Math.max(0, lines.length - offset);
    return lines.slice(Math.max(0, end - limit), end);
  } finally { closeSync(fd); }
}

export function readWorkspaceLogs(configDir: string, limitPerWorkspace = 500, offsetPerWorkspace = 0, beforeAt?: string): Array<{ workspace: WorkspaceRecord; entries: unknown[] }> {
  return readWorkspaceRegistry(configDir).map((workspace) => {
    const file = path.join(workspace.stateDir, 'runtime.jsonl');
    const requested = beforeAt ? Math.max(limitPerWorkspace + offsetPerWorkspace, 5000) : limitPerWorkspace + offsetPerWorkspace;
    const files = [3, 2, 1].map((index) => `${file}.${index}`).concat(file);
    const parsed = files.flatMap((candidate) => readTailLines(candidate, requested, 0))
      .flatMap((line) => { try { return [JSON.parse(line) as { at?: string }]; } catch { return []; } });
    const filtered = beforeAt ? parsed.filter((entry) => !entry.at || entry.at <= beforeAt) : parsed;
    const end = Math.max(0, filtered.length - offsetPerWorkspace);
    return { workspace, entries: filtered.slice(Math.max(0, end - limitPerWorkspace), end) };
  });
}



export function isWorkspaceRecordActive(record: WorkspaceRecord): boolean {
  if (!record.lastPid || record.lastPid === process.pid) return false;
  try { process.kill(record.lastPid, 0); return true; } catch { return false; }
}

/**
 * Count distinct live MyTerminal runtime processes recorded in the global
 * workspace catalog. Runtime ownership is process-scoped, so multiple stale or
 * duplicate workspace rows for the same PID must count only once.
 */
export function activeWorkspaceRuntimePids(configDir: string, excludePid?: number): number[] {
  const pids = new Set<number>();
  for (const record of readWorkspaceRegistry(configDir)) {
    const pid = record.lastPid;
    if (!pid || pid === excludePid || pids.has(pid)) continue;
    try { process.kill(pid, 0); pids.add(pid); } catch { /* stale lease */ }
  }
  return [...pids].sort((left, right) => left - right);
}

export function resolveWorkspaceInput(input: string, records: WorkspaceRecord[]): string {
  const trimmed = input.trim();
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && index <= records.length) return records[index - 1].workspaceDir;
  return path.resolve(trimmed);
}

export function workspaceChoiceHint(records: WorkspaceRecord[]): string {
  if (!records.length) return '';
  return records.map((record, index) => `${index + 1}=${record.label || path.basename(record.workspaceDir) || record.workspaceDir} (${record.workspaceDir})`).join(' · ');
}

export function portOwner(port: number): PortOwner | undefined {
  if (!Number.isInteger(port) || port <= 0) return undefined;
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcu'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const fields = output.split('\n').filter(Boolean);
    const pid = Number(fields.find((item) => item.startsWith('p'))?.slice(1));
    const command = fields.find((item) => item.startsWith('c'))?.slice(1) || 'unknown';
    const user = fields.find((item) => item.startsWith('u'))?.slice(1);
    return Number.isInteger(pid) && pid > 0 ? { pid, command, user } : undefined;
  } catch {
    return undefined;
  }
}

export function describePortOwner(port: number): string {
  const owner = portOwner(port);
  return owner ? `PID ${owner.pid} · ${owner.command}${owner.user ? ` · user ${owner.user}` : ''}` : 'process information unavailable';
}

export async function findAvailablePort(host: string, preferred: number): Promise<number> {
  for (let port = Math.max(1, preferred + 1); port <= Math.min(65535, preferred + 100); port += 1) {
    const available = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.unref();
      probe.once('error', () => resolve(false));
      probe.listen(port, host, () => probe.close(() => resolve(true)));
    });
    if (available) return port;
  }
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export async function terminatePortOwner(port: number): Promise<PortOwner> {
  const owner = portOwner(port);
  if (!owner) throw new Error(`No listening process could be identified on port ${port}.`);
  if (owner.pid === process.pid) throw new Error(`Refusing to terminate the current MyTerminal process (${owner.pid}).`);
  process.kill(owner.pid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 400));
  return owner;
}
