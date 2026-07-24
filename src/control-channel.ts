export type ControlChannelFailure =
  | 'backend_502'
  | 'cloudflare_1033'
  | 'timeout'
  | 'backend_unavailable'
  | 'network_error'
  | 'http_error';

export type ControlChannelPhase = 'idle' | 'checking' | 'connected' | 'disconnected' | 'recovering' | 'stopped';

export type ControlChannelState = {
  phase: ControlChannelPhase;
  attempt: number;
  retryDelayMs: number;
  checkedAt?: string;
  connectedAt?: string;
  disconnectedAt?: string;
  recoveredAt?: string;
  classification?: ControlChannelFailure;
  statusCode?: number;
  message?: string;
};

export type ControlChannelProbeResult =
  | { ok: true; statusCode: number }
  | { ok: false; classification: ControlChannelFailure; statusCode?: number; message: string };

export function classifyControlChannelFailure(input: { statusCode?: number; body?: string; error?: unknown }): ControlChannelFailure {
  const body = input.body || '';
  const message = input.error instanceof Error ? `${input.error.name}: ${input.error.message}` : String(input.error || '');
  if (input.statusCode === 502) return 'backend_502';
  if (input.statusCode === 1033 || /\b1033\b|cloudflare tunnel error/i.test(body)) return 'cloudflare_1033';
  if (/abort|timeout|timed out/i.test(message)) return 'timeout';
  if (/econnrefused|connection refused|origin service|backend unavailable|service unavailable|workspace unavailable/i.test(`${message}\n${body}`)) return 'backend_unavailable';
  if (input.error) return 'network_error';
  return 'http_error';
}

export function exponentialBackoffDelay(attempt: number, baseDelayMs = 1_000, maxDelayMs = 60_000, jitter = 0): number {
  const boundedAttempt = Math.max(1, Math.floor(attempt));
  const raw = Math.min(maxDelayMs, baseDelayMs * (2 ** (boundedAttempt - 1)));
  if (!jitter) return raw;
  const ratio = Math.max(-1, Math.min(1, jitter));
  return Math.max(0, Math.min(maxDelayMs, Math.round(raw * (1 + ratio))));
}

function healthUrl(baseUrl: string, workspaceId?: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/health`.replace(/\/+/g, '/');
  url.search = '';
  if (workspaceId) url.searchParams.set('workspaceId', workspaceId);
  url.hash = '';
  return url.toString();
}

async function readBoundedBody(response: Response, maxBytes = 8_192): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let used = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = Math.max(0, maxBytes - used);
      if (!remaining) break;
      const accepted = value.subarray(0, remaining);
      used += accepted.byteLength;
      text += decoder.decode(accepted, { stream: used < maxBytes });
      if (accepted.byteLength < value.byteLength || used >= maxBytes) break;
    }
    text += decoder.decode();
    return text;
  } finally {
    try { await reader.cancel(); } catch { /* response already completed */ }
  }
}

function validateHealthBody(body: string, expectedWorkspaceId?: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { return 'Public health endpoint did not return valid JSON.'; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'Public health endpoint returned an invalid payload.';
  const record = parsed as Record<string, unknown>;
  if (record.ok !== true || record.product !== 'myterminal') return 'Public health endpoint did not identify a healthy MyTerminal runtime.';
  if (!expectedWorkspaceId) return undefined;
  if (record.workspaceId === expectedWorkspaceId) return undefined;
  const workspaces = Array.isArray(record.workspaces) ? record.workspaces : [];
  if (workspaces.some((item) => item && typeof item === 'object' && (item as Record<string, unknown>).id === expectedWorkspaceId)) return undefined;
  return `Public health endpoint does not route workspace ${expectedWorkspaceId}.`;
}

export function isExternalControlUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(host);
  } catch { return false; }
}

export class ControlChannelMonitor {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private probing?: Promise<ControlChannelProbeResult>;
  private cycling?: Promise<void>;
  private state: ControlChannelState = { phase: 'idle', attempt: 0, retryDelayMs: 0 };

  constructor(private readonly options: {
    baseUrl: string;
    expectedWorkspaceId?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    healthyIntervalMs?: number;
    onState?: (state: ControlChannelState) => void;
    onRecovered?: () => void | Promise<void>;
  }) {}

  snapshot(): ControlChannelState { return { ...this.state }; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.transition({ phase: 'idle', attempt: 0, retryDelayMs: 0, message: 'Control channel monitor started.' });
    void this.cycle();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.transition({ ...this.state, phase: 'stopped', retryDelayMs: 0, message: 'Control channel monitor stopped.' });
  }

  async recheck(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.cycling) await this.cycling;
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.cycle();
  }

  async probeNow(): Promise<ControlChannelProbeResult> {
    if (this.probing) return this.probing;
    this.probing = this.probe().finally(() => { this.probing = undefined; });
    return this.probing;
  }

  private async cycle(): Promise<void> {
    if (this.cycling) return this.cycling;
    const run = this.runCycle();
    this.cycling = run;
    try { await run; }
    finally { if (this.cycling === run) this.cycling = undefined; }
  }

  private async runCycle(): Promise<void> {
    if (this.stopped) return;
    const previousPhase = this.state.phase;
    if (previousPhase !== 'connected') {
      this.transition({ ...this.state, phase: previousPhase === 'disconnected' || previousPhase === 'recovering' ? 'recovering' : 'checking', checkedAt: new Date().toISOString() });
    }
    const result = await this.probeNow();
    if (this.stopped) return;
    if (result.ok) {
      const recovered = previousPhase === 'disconnected' || previousPhase === 'recovering' || this.state.attempt > 0;
      this.transition({
        phase: 'connected',
        attempt: 0,
        retryDelayMs: 0,
        statusCode: result.statusCode,
        checkedAt: new Date().toISOString(),
        connectedAt: recovered ? new Date().toISOString() : this.state.connectedAt || new Date().toISOString(),
        recoveredAt: recovered ? new Date().toISOString() : this.state.recoveredAt,
        message: recovered ? 'Control channel recovered.' : 'Control channel connected.',
      });
      if (recovered) await this.options.onRecovered?.();
      this.schedule(this.options.healthyIntervalMs ?? 60_000);
      return;
    }
    const attempt = this.state.attempt + 1;
    const retryDelayMs = exponentialBackoffDelay(attempt, this.options.baseDelayMs ?? 1_000, this.options.maxDelayMs ?? 60_000);
    this.transition({
      phase: 'disconnected',
      attempt,
      retryDelayMs,
      checkedAt: new Date().toISOString(),
      disconnectedAt: this.state.disconnectedAt || new Date().toISOString(),
      classification: result.classification,
      statusCode: result.statusCode,
      message: result.message,
    });
    this.schedule(retryDelayMs);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.cycle(), delayMs);
    this.timer.unref?.();
  }

  private async probe(): Promise<ControlChannelProbeResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Control channel probe timed out.')), this.options.timeoutMs ?? 5_000);
    try {
      const response = await (this.options.fetcher ?? fetch)(healthUrl(this.options.baseUrl, this.options.expectedWorkspaceId), {
        headers: { Accept: 'application/json', 'User-Agent': 'myterminal/control-channel' },
        signal: controller.signal,
      });
      const body = await readBoundedBody(response);
      if (response.ok) {
        const invalid = validateHealthBody(body, this.options.expectedWorkspaceId);
        if (!invalid) return { ok: true, statusCode: response.status };
        return { ok: false, classification: 'backend_unavailable', statusCode: response.status, message: invalid };
      }
      return {
        ok: false,
        classification: classifyControlChannelFailure({ statusCode: response.status, body }),
        statusCode: response.status,
        message: `Control channel returned HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : '.'}`,
      };
    } catch (error) {
      return { ok: false, classification: classifyControlChannelFailure({ error }), message: error instanceof Error ? error.message : String(error) };
    } finally { clearTimeout(timeout); }
  }

  private transition(next: ControlChannelState): void {
    const previous = this.state;
    this.state = { ...next };
    const meaningfulChange = previous.phase !== next.phase
      || previous.attempt !== next.attempt
      || previous.retryDelayMs !== next.retryDelayMs
      || previous.classification !== next.classification
      || previous.statusCode !== next.statusCode
      || previous.message !== next.message
      || previous.connectedAt !== next.connectedAt
      || previous.disconnectedAt !== next.disconnectedAt
      || previous.recoveredAt !== next.recoveredAt;
    if (meaningfulChange) this.options.onState?.(this.snapshot());
  }
}
