import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type RuntimeLifecyclePhase = 'starting' | 'active' | 'revalidating' | 'degraded' | 'shutting_down' | 'stopped';

export type RuntimeLifecycleState = {
  schemaVersion: 1;
  workspace: string;
  pid: number;
  phase: RuntimeLifecyclePhase;
  at: string;
  reason?: string;
  pendingActions: number;
  controlChannel?: string;
};

export function runtimeLifecyclePath(stateDir: string): string {
  return path.join(stateDir, 'runtime-state.json');
}

export function writeRuntimeLifecycle(stateDir: string, state: Omit<RuntimeLifecycleState, 'schemaVersion' | 'at'>): RuntimeLifecycleState {
  const value: RuntimeLifecycleState = { schemaVersion: 1, at: new Date().toISOString(), ...state };
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = runtimeLifecyclePath(stateDir);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
    return value;
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

export function readRuntimeLifecycle(stateDir: string): RuntimeLifecycleState | undefined {
  const file = runtimeLifecyclePath(stateDir);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RuntimeLifecycleState;
    return parsed.schemaVersion === 1 && typeof parsed.phase === 'string' ? parsed : undefined;
  } catch { return undefined; }
}
