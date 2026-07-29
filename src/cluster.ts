import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type ClusterMember = {
  id: string;
  pid: number;
  appVersion: string;
  protocolVersion: number;
  workspaceId: string;
  workspaceDir: string;
  internalPort: number;
  connectorKey: string;
  actionsTokenHash: string;
  secret: string;
  startedAt: string;
  heartbeatAt: string;
};

type ClusterState = { schemaVersion: 1; host: string; port: number; leaderId?: string; members: ClusterMember[] };

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function clusterKey(host: string, port: number): string {
  return createHash('sha256').update(`${host}:${port}`).digest('hex').slice(0, 20);
}

export class PortClusterRegistry {
  readonly memberId = `${process.pid}-${randomBytes(6).toString('hex')}`;
  private readonly file: string;
  private readonly lock: string;
  private localMember?: ClusterMember;
  private lockToken?: string; // ADR-0018: 锁所有权 token

  constructor(private readonly configDir: string, readonly host: string, readonly port: number) {
    const dir = path.join(configDir, 'clusters');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, `${clusterKey(host, port)}.json`);
    this.lock = `${this.file}.lock`;
  }

  read(): ClusterState {
    if (!existsSync(this.file)) return { schemaVersion: 1, host: this.host, port: this.port, members: [] };
    const value = JSON.parse(readFileSync(this.file, 'utf8')) as ClusterState;
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.members)) {
      throw new Error(`Invalid cluster registry: ${this.file}`);
    }
    return { schemaVersion: 1, host: this.host, port: this.port, leaderId: value.leaderId, members: value.members };
  }

  update(mutator: (state: ClusterState) => ClusterState): ClusterState {
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        const token = `${process.pid}:${randomBytes(8).toString('hex')}`;
        writeFileSync(this.lock, token, { flag: 'wx', mode: 0o600 });
        this.lockToken = token;
        break;
      } catch {
        try {
          const lockContent = readFileSync(this.lock, 'utf8');
          const owner = Number(lockContent.split(':')[0]);
          const stale = Date.now() - statSync(this.lock).mtimeMs > 5000;
          let alive = true;
          try { process.kill(owner, 0); } catch { alive = false; }
          if (!alive || stale) { unlinkSync(this.lock); continue; }
        } catch { try { unlinkSync(this.lock); } catch { /* another contender */ } }
        if (Date.now() >= deadline) throw new Error(`Cluster registry lock timeout: ${this.lock}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      const next = mutator(this.prune(this.read()));
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
      return next;
    } finally {
      // ADR-0018: compare-before-unlink——只删自己的锁
      try {
        if (existsSync(this.lock) && this.lockToken) {
          const current = readFileSync(this.lock, 'utf8');
          if (current === this.lockToken) unlinkSync(this.lock);
        }
      } catch { /* best effort */ }
    }
  }

  register(member: Omit<ClusterMember, 'id' | 'heartbeatAt' | 'startedAt'>): ClusterMember {
    const now = new Date().toISOString();
    const record: ClusterMember = { ...member, id: this.memberId, startedAt: now, heartbeatAt: now };
    this.update((state) => {
      const conflictingWorkspace = state.members.find((item) => item.workspaceId === record.workspaceId && item.id !== record.id);
      if (conflictingWorkspace) throw new Error(`Workspace is already active in PID ${conflictingWorkspace.pid}: ${record.workspaceDir}`);
      const protocolMismatch = state.members.find((item) => item.protocolVersion !== record.protocolVersion);
      if (protocolMismatch) throw new Error(`Port ${this.port} uses incompatible MyTerminal cluster protocol ${protocolMismatch.protocolVersion}; this process requires ${record.protocolVersion}. Restart every member on the same release before joining.`);
      const incompatible = state.members.find((item) => item.connectorKey !== record.connectorKey || item.actionsTokenHash !== record.actionsTokenHash);
      if (incompatible) throw new Error(`Port ${this.port} is already used by a MyTerminal cluster with different credentials.`);
      return { ...state, members: [...state.members.filter((item) => item.id !== record.id), record] };
    });
    this.localMember = record;
    return record;
  }

  heartbeat(): void {
    if (!this.localMember) throw new Error('Cluster member has not been registered.');
    const refreshed = { ...this.localMember, heartbeatAt: new Date().toISOString() };
    this.update((state) => ({
      ...state,
      members: [...state.members.filter((item) => item.id !== this.memberId), refreshed],
    }));
    this.localMember = refreshed;
  }

  /**
   * Repair the local membership invariant after a missing or externally
   * truncated registry. This persists the actual member record; callers never
   * synthesize a display-only count.
   */
  ensureRegistered(): ClusterState {
    if (!this.localMember) throw new Error('Cluster member has not been registered.');
    const current = this.read();
    if (current.members.some((item) => item.id === this.memberId)) return current;
    this.heartbeat();
    return this.read();
  }

  setLeader(): void {
    this.update((state) => ({ ...state, leaderId: this.memberId }));
  }

  unregister(): void {
    this.update((state) => ({ ...state, leaderId: state.leaderId === this.memberId ? undefined : state.leaderId, members: state.members.filter((item) => item.id !== this.memberId) }));
    this.localMember = undefined;
  }

  private prune(state: ClusterState): ClusterState {
    const cutoff = Date.now() - 6000;
    const members = state.members.filter((member) => {
      if (Date.parse(member.heartbeatAt) < cutoff) return false;
      try { process.kill(member.pid, 0); return true; } catch { return false; }
    });
    return { ...state, leaderId: members.some((item) => item.id === state.leaderId) ? state.leaderId : undefined, members };
  }
}
