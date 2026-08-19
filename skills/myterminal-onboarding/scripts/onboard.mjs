#!/usr/bin/env node
/**
 * onboard.mjs — installs MyTerminal and configures its subagent LLM.
 *
 * Design contract: docs/adr/0053-onboarding-skill-adr0045-migration-l3-install.md
 * (this ADR supersedes ADR-0043; the previous design contract, ADR-0043, is retired).
 *
 * Two halves:
 *   1. Pure logic (exported, unit-tested in test/adr43-onboarding-skill.test.mjs)
 *      — path resolution, config merge, keyless connectivity probe, L3 recommendation,
 *        version comparison.
 *   2. Side effects (CLI only) — clone, build, write config.json.
 *
 * Hard rules (ADR-0053):
 *   - The subagent block is written as the app's three-required contract (ADR-0045):
 *     model + baseUrl + apiKey, all in config.json. The key is provided via stdin
 *     (--key -), the file is written at 0600 with a backup, and the value NEVER
 *     appears in any output — dry-run drafts and echoes report `apiKeySet` only.
 *   - No outbound call ever carries the API key: the connectivity probe is keyless
 *     (never sends credentials; expects 401/403 from a real Anthropic-compatible endpoint).
 *   - The `provider` concept is gone (ADR-0045). A leftover `provider` field makes the
 *     app silently ignore the whole subagent block (src/config.ts:142-147) — the merge
 *     deletes it so the written config actually takes effect.
 *   - Optional subagent fields (maxTurns/timeoutSec/...) are NOT written here — the app
 *     applies its own defaults (src/config.ts applySubagentDefaults). No second default
 *     source, no drift.
 *   - Running with no flags is READ-ONLY. Nothing is written until you pass a write flag.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doSelfTest } from './self-test.mjs'; // --self-test logic lives in its own file (test-only code, kept out of this production script)

// ─────────────────────────────────────────────────────────────────────────────
// Facts mirrored from the main repo. If the repo changes, these must change too
// (test/adr43-onboarding-skill.test.mjs locks them).
//   src/config.ts:24-30                    — settingsPath fallback chain
//   src/config.ts:110-120                  — applySubagentDefaults (optional field defaults + clamps)
//   src/config.ts:142-157                  — legacy `provider` block is silently ignored; model/baseUrl/apiKey required
//   src/subagent/llm-adapter.ts:294-295    — baseUrl normalization (strip trailing / and /v1)
//   src/subagent/llm-adapter.ts:364        — request URL is <baseUrl>/v1/messages
//   src/l3/registry.ts:27,63               — DEFAULT_L3_MODEL_PATH + models dir under the install root
// ─────────────────────────────────────────────────────────────────────────────

export const MIN_BUN_VERSION = '1.3.0';
export const REPO_URL = 'https://github.com/epslkslsksndnsjs-lab/myterminal.git';
export const DEFAULT_INSTALL_DIRNAME = 'myterminal';

/**
 * L3 local model file name. Mirrors src/l3/registry.ts:27 (DEFAULT_L3_MODEL_PATH);
 * the app resolves it as <installRoot>/models/<this file> (registry.ts:63).
 */
export const L3_MODEL_FILENAME = 'Qwen3.5-2B-Q4_K_M.gguf';

/**
 * Fixed thresholds for the deterministic L3 recommendation (ADR-0053 D7).
 * freeDisk < 2GB → skip (download peak ~1.2GB .part + headroom);
 * totalMemory < 8GB → skip (1.2GB weights + 32K context + runtime overhead).
 * Threshold changes happen ONLY here; test/adr43-onboarding-skill.test.mjs locks
 * the boundary values by injection.
 */
export const L3_RECOMMEND_THRESHOLDS = {
  minFreeDiskBytes: 2 * 1024 ** 3,
  minTotalMemoryBytes: 8 * 1024 ** 3,
};

/**
 * Optional subagent fields, defaults and clamps — mirrored from
 * src/config.ts:110-120 applySubagentDefaults. The skill does NOT write these;
 * it only reports them so the AI agent can tell the user what is configurable
 * (ADR-0053 D2 — no second default source, no drift).
 */
export const SUBAGENT_OPTIONAL_FIELDS = [
  { field: 'maxTurns', default: 700, min: 1, max: 1600 },
  { field: 'timeoutSec', default: 7200, min: 30, max: 86400 },
  { field: 'maxParallel', default: 2, min: 1, max: 4 },
  { field: 'contextWindow', default: 120_000, min: 1_000, max: 1_000_000 },
  { field: 'maxOutput', default: 32_000, min: 1_000, max: 200_000 },
  { field: 'compactThreshold', default: 80_000, min: 1_000, max: 500_000 },
];

/** Legacy key-like fields inside an existing subagent block. `apiKey` is the canonical
 * field now (ADR-0045 D4) and is intentionally NOT in this list. */
const LEGACY_SECRET_KEYS = ['api_key', 'key', 'token', 'secret'];

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors `optionalEnv` in src/config.ts: blank / whitespace-only means unset. */
function optionalEnv(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return candidate || undefined;
}

/** Same resolution order as `settingsPath` in src/config.ts. */
export function resolveConfigPath(env = process.env, homedir = os.homedir()) {
  const configured = optionalEnv(env.MYTERMINAL_CONFIG_DIR);
  const base = configured
    ? path.resolve(configured)
    : path.join(optionalEnv(env.XDG_CONFIG_HOME) || path.join(homedir, '.config'), 'myterminal');
  return path.join(base, 'config.json');
}

/**
 * Normalize a vendor Anthropic-compatible base URL exactly the way the app does
 * (src/subagent/llm-adapter.ts:294-295): strip trailing slashes and a trailing /v1,
 * since the app appends /v1/messages itself. `https://api.anthropic.com/v1/` → `https://api.anthropic.com`.
 */
export function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  return raw.endsWith('/v1') ? raw.slice(0, -3) : raw;
}

function fmtBytes(n) {
  if (n == null) return 'unknown';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${n} B`;
}

/**
 * Deterministic L3 install recommendation from read-only machine facts (ADR-0053 D7).
 * The recommendation is a computed fact, not the agent's judgment; the user decides.
 * Always returns reasons. `freeDiskBytes`/`totalMemoryBytes` in bytes; pass the raw
 * numbers (the boundary test injects 2GB/8GB edges).
 */
export function recommendL3({ freeDiskBytes, totalMemoryBytes } = {}) {
  const reasons = [];
  let verdict = 'install';
  const disk = fmtBytes(freeDiskBytes);
  const memory = fmtBytes(totalMemoryBytes);

  if (freeDiskBytes == null) {
    verdict = 'skip';
    reasons.push('free disk could not be measured — no guarantee of room for the ~1.2 GB download');
  } else if (freeDiskBytes < L3_RECOMMEND_THRESHOLDS.minFreeDiskBytes) {
    verdict = 'skip';
    reasons.push(`free disk is ${disk} (< 2 GB) — not enough room for the ~1.2 GB download plus headroom`);
  }

  if (totalMemoryBytes == null) {
    verdict = 'skip';
    reasons.push('total memory could not be measured');
  } else if (totalMemoryBytes < L3_RECOMMEND_THRESHOLDS.minTotalMemoryBytes) {
    verdict = 'skip';
    reasons.push(`total memory is ${memory} (< 8 GB) — the 1.2 GB local model would strain this machine`);
  }

  if (verdict === 'install') {
    reasons.push(`disk ${disk} ≥ 2 GB and memory ${memory} ≥ 8 GB — the local model fits`);
  }
  return { verdict, reasons };
}

/**
 * Whether the L3 local model file is actually present in the checkout's models dir.
 * Matches the app's resolution (src/l3/registry.ts:63: <installRoot>/models/<file>).
 * The exact final path must exist as a regular file — a half-downloaded `.part` or a
 * locked download does not count.
 */
export function detectL3ModelPresent(installDir) {
  if (!installDir) return false;
  const target = path.join(installDir, 'models', L3_MODEL_FILENAME);
  try {
    return fs.existsSync(target) && fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Merge baseUrl/model/apiKey into an existing config object (ADR-0053 D2).
 * - Writes exactly the three required fields + anything the user already had +
 *   fallbackModel (passthrough). Optional fields are NOT filled in — the app applies
 *   its own defaults.
 * - Deletes a legacy `provider` field: with it present, the app silently ignores the
 *   whole subagent block (src/config.ts:142-147) — the written config would never work.
 * - Strips legacy key aliases (api_key/key/token/secret); apiKey is canonical.
 * - Throws when the merge cannot satisfy the three-required contract.
 */
export function mergeSubagentConfig(existing, patch) {
  const source = existing && typeof existing === 'object' ? existing : {};
  const cloned = structuredClone(source);
  const current = cloned.subagent && typeof cloned.subagent === 'object' ? cloned.subagent : {};
  const preserved = { ...current };

  // Legacy `provider` field: the app silently ignores the whole block (config.ts:142-147).
  delete preserved.provider;
  for (const secret of LEGACY_SECRET_KEYS) delete preserved[secret];

  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  const model = clean(patch?.model) || clean(preserved.model) || undefined;
  const baseUrl = clean(patch?.baseUrl) || clean(preserved.baseUrl) || undefined;
  const apiKey = clean(patch?.apiKey) || clean(preserved.apiKey) || undefined;

  const missing = [];
  if (!model) missing.push('model');
  if (!baseUrl) missing.push('baseUrl');
  if (!apiKey) missing.push('apiKey');
  if (missing.length) {
    throw new Error(
      `Cannot write subagent settings: missing required ${missing.join(', ')}. ` +
      'The app rejects a subagent block without all of model/baseUrl/apiKey ' +
      '(src/config.ts validateSettings, ADR-0045 three-required contract). ' +
      'Pass --base-url <url> --model <m> and, if the config does not have a key yet, --key -.',
    );
  }

  const subagent = {
    ...preserved,
    model,
    baseUrl,
    apiKey,
  };
  // fallbackModel (types.ts:222) — optional overload-degradation model, passed through
  // verbatim. Empty string / undefined both mean "unset" and stay omitted.
  const fallbackModel = (clean(patch?.fallbackModel) || clean(preserved.fallbackModel)) || undefined;
  if (fallbackModel) subagent.fallbackModel = fallbackModel;

  return { ...cloned, subagent };
}

/** Pull "1.3.2" out of whatever `bun --version` printed. Returns null if there is no version. */
export function parseBunVersion(stdout) {
  if (!stdout || typeof stdout !== 'string') return null;
  const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * Fields that `validateSettings` (src/config.ts:122) requires. A config missing any of
 * them makes MyTerminal throw on startup.
 */
export const REQUIRED_CONFIG_FIELDS = [
  'workspaceDir',
  'host',
  'port',
  'publicBaseUrl',
  'connectorKey',
  'actionsToken',
  'maxOutputChars',
  'commandTimeoutSec',
];

/**
 * The eight fields MyTerminal's first-run setup screen mints / asks for.
 * Mirrors REQUIRED_CONFIG_FIELDS (src/config.ts validateSettings). Surfaced verbatim
 * in FIRST_RUN_GUIDANCE so a first-time user knows what the blank screen expects and
 * what "done" looks like.
 */
export const FIRST_RUN_FIELDS = [
  { field: 'workspaceDir', what: 'working directory MyTerminal stores projects & state in' },
  { field: 'host', what: 'address the server binds to (usually 127.0.0.1)' },
  { field: 'port', what: 'port the server listens on' },
  { field: 'publicBaseUrl', what: 'publicly reachable base URL (used for connector callbacks)' },
  { field: 'connectorKey', what: 'connector secret — randomly generated on first run, 24+ chars' },
  { field: 'actionsToken', what: 'Actions API token — randomly generated on first run, 24+ chars' },
  { field: 'maxOutputChars', what: 'max characters per command output' },
  { field: 'commandTimeoutSec', what: 'command timeout in seconds' },
];

const FIRST_RUN_GUIDANCE =
  'MyTerminal has no valid config yet, and this script must not invent one.\n' +
  'The base config carries randomly generated connector credentials ' +
  '(connectorKey / actionsToken, 24+ chars each) that only MyTerminal itself may mint. ' +
  'Writing a partial file here would make startup throw and lock you out of the setup screen ' +
  '(src/cli.ts refuses to fall back to defaults when the config is invalid, to avoid ' +
  'silently replacing stable credentials).\n\n' +
  'First-run setup screen asks for (fill every one):\n' +
  FIRST_RUN_FIELDS.map((f) => `  - ${f.field}: ${f.what}`).join('\n') + '\n' +
  '\nSuccess looks like: config.json written with schemaVersion: 1 and all eight fields above ' +
  'present. Verify with: node scripts/onboard.mjs --json  (look for "config.writability.ok": true).\n\n' +
  'Do this:\n' +
  '  1. cd <your MyTerminal checkout>\n' +
  '  2. bun run dev            # complete the first-run setup screen once\n' +
  '  3. re-run: node scripts/onboard.mjs --write-config --base-url <url> --model <m> --key -';

/**
 * Decide whether it is safe to write the subagent section into an existing config.
 * `config` is null when the file is absent, or { __parseError } when it is corrupt.
 */
export function assessConfigWritability(config) {
  if (config === null || config === undefined) {
    return { ok: false, reason: 'missing', guidance: FIRST_RUN_GUIDANCE };
  }
  if (config.__parseError) {
    return {
      ok: false,
      reason: 'unparsable',
      guidance:
        `The existing config is not valid JSON (${config.__parseError}). ` +
        'Refusing to overwrite it — fix or move the file, then re-run.',
    };
  }
  if (config.schemaVersion !== 1) {
    return {
      ok: false,
      reason: 'unsupported-schema',
      guidance:
        'The config has no supported schemaVersion (expected 1). MyTerminal would refuse to ' +
        'load it. Do not hand-edit — let MyTerminal migrate or regenerate it first.',
    };
  }
  const missing = REQUIRED_CONFIG_FIELDS.filter((field) => config[field] === undefined || config[field] === null);
  if (missing.length) {
    return {
      ok: false,
      reason: 'incomplete',
      missing,
      guidance:
        `The config is missing required fields: ${missing.join(', ')}. ` +
        'MyTerminal would reject it on startup. Run `bun run dev` once to complete setup, then re-run.',
    };
  }
  return { ok: true, reason: 'ok', missing: [] };
}

/**
 * Back up and remove a broken config so the first-run setup screen can re-mint one.
 * Pure decision + side effect gated by --repair (never runs by default). A healthy config
 * is left untouched. Destructive only on the specific broken states assessConfigWritability
 * already flags: unparsable / unsupported-schema / incomplete.
 */
export function repairConfig(configPath, { dryRun = false } = {}) {
  if (!fs.existsSync(configPath)) {
    return { ok: false, reason: 'absent', message: `No config at ${configPath} — nothing to repair.` };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    parsed = { __parseError: error instanceof Error ? error.message : String(error) };
  }
  const assessment = assessConfigWritability(parsed);
  if (assessment.ok) {
    return { ok: false, reason: 'healthy', message: `Config at ${configPath} is valid — nothing to repair.` };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${configPath}.repair-backup-${stamp}`;
  if (dryRun) {
    return {
      ok: true,
      reason: assessment.reason,
      dryRun: true,
      backup,
      message: `[dry-run] would back up ${configPath} -> ${backup} and remove the broken file.`,
    };
  }
  fs.copyFileSync(configPath, backup);
  fs.chmodSync(backup, 0o600); // the repair backup may hold credentials too (R4)
  fs.unlinkSync(configPath);
  return {
    ok: true,
    reason: assessment.reason,
    backup,
    message: `Backed up ${configPath} -> ${backup} and removed the broken file. Re-run 'bun run dev' to mint a fresh config.`,
  };
}

/** Numeric (not lexicographic) version comparison. 1.10.0 is newer than 1.3.0. */
export function satisfiesMinVersion(version, minimum) {
  if (!version) return false;
  const toParts = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const actual = toParts(version);
  const required = toParts(minimum);
  const len = Math.max(actual.length, required.length);

  for (let i = 0; i < len; i += 1) {
    const a = actual[i] ?? 0;
    const r = required[i] ?? 0;
    if (a > r) return true;
    if (a < r) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyless connectivity probe (ADR-0053 D4)
//
// Replaces the old `--verify` (which sent the user's API key to a provider to
// "prove" it — a security red line). The probe sends NO credentials: a minimal
// Anthropic-shape request to <baseUrl>/v1/messages (the exact URL the app uses,
// llm-adapter.ts:364), expecting 401/403 — proof the endpoint is reachable and
// speaks the protocol. It validates connectivity only, never key/model correctness,
// and it is honest about that. `fetchImpl` is injectable for the lock suite.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keyless probe of an Anthropic-compatible endpoint.
 * Returns { ok, reachable, status, kind, message } — never throws.
 *   ok:true   → endpoint reachable (401/403 = auth required as expected, or 2xx = open endpoint)
 *   ok:false  → network failure (status 0) or an unexpected HTTP answer
 * The request carries NO Authorization / x-api-key header and never includes the API key.
 */
export async function probeEndpoint(baseUrl, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return { ok: false, reachable: false, status: 0, kind: 'no-base-url', message: 'No base URL given. Pass --base-url <url>.' };
  }
  const url = `${normalized}/v1/messages`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      // No authorization header, no key, anywhere.
      body: JSON.stringify({ model: '', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      status: 0,
      kind: 'network',
      message: `Network error reaching ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: true,
      reachable: true,
      status: res.status,
      kind: 'auth-required',
      message:
        `Endpoint reachable and speaking the Anthropic protocol (HTTP ${res.status} — authentication required, exactly as expected for a keyless probe). ` +
        'Connectivity only: this does NOT validate the API key or the model.',
    };
  }
  if (res.status >= 200 && res.status < 300) {
    return {
      ok: true,
      reachable: true,
      status: res.status,
      kind: 'open',
      message:
        `Endpoint reachable and accepted the request without authentication (HTTP ${res.status}) — typical for a local server. ` +
        'Connectivity only: this does NOT validate the API key or the model.',
    };
  }
  return {
    ok: false,
    reachable: true,
    status: res.status,
    kind: 'unexpected',
    message:
      `Endpoint reachable but answered HTTP ${res.status} to the keyless probe. ` +
      "Check the base URL: it must be the vendor's Anthropic-compatible base (e.g. https://api.anthropic.com — no /v1, no /messages).",
  };
}

/**
 * Confirm a running MyTerminal instance answers its health endpoint.
 * Contract mirrors the app itself: a healthy server returns HTTP 200 with a JSON body
 * whose `product` field equals 'myterminal' (see src/server.ts:549 and the handshake in
 * src/config.ts:170). Returns { ok, reachable, status, product, message } — never throws.
 *
 * `ok`   = fully healthy (200 + product marker)
 * `reachable` = the process is listening and identifies as myterminal (any status)
 * This split lets the CLI tell "service not running" apart from "running but degraded".
 *
 * `fetchImpl` must match the global fetch signature: (url, opts) => Promise<Response>.
 */
export async function checkHealth({ host = '127.0.0.1', port = 3210, fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  const url = `http://${host}:${port}/health`;
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { ok: false, reachable: false, status: 0, product: null, message: `Cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let product = null;
  try {
    const body = await res.json();
    product = body && body.product ? String(body.product) : null;
  } catch {
    product = null;
  }
  const reachable = product === 'myterminal';
  const healthy = res.status === 200 && reachable;
  const message = healthy
    ? `MyTerminal is healthy at ${url} (product=${product}).`
    : reachable
      ? `MyTerminal is reachable at ${url} but degraded (HTTP ${res.status}) — give it a moment, then re-run --healthcheck.`
      : `No MyTerminal instance at ${url} (HTTP ${res.status}${product ? `, product=${product}` : ', no product marker'}). Is the service running? Try 'bun start'.`;
  return { ok: healthy, reachable, status: res.status, product, message };
}

// ─────────────────────────────────────────────────────────────────────────────
// Side effects (CLI only)
// ─────────────────────────────────────────────────────────────────────────────

function tryExec(cmd, args, options = {}) {
  try {
    return { ok: true, stdout: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }) };
  } catch (error) {
    return { ok: false, stdout: '', error: error instanceof Error ? error.message : String(error) };
  }
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { __parseError: error instanceof Error ? error.message : String(error) };
  }
}

function isMyTerminalCheckout(dir) {
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name === 'myterminal';
  } catch {
    return false;
  }
}

/**
 * Standard places a MyTerminal checkout is likely to live. Purely heuristic — the goal is to
 * avoid wrongly concluding "not installed" and cloning a fresh copy next to an existing one.
 * Explicit --install-dir always wins.
 */
export const INSTALL_CANDIDATE_DIRS = [
  'myterminal',
  'Desktop/myterminal',
  'projects/myterminal',
  'code/myterminal',
  'dev/myterminal',
  'src/myterminal',
  'git/myterminal',
  'repos/myterminal',
];

/** Find an existing MyTerminal checkout among the candidate dirs. Returns the path or null. */
export function lookupInstallDir(homedir, installDir) {
  const candidates = [
    installDir,
    ...INSTALL_CANDIDATE_DIRS.map((rel) => path.join(homedir, rel)),
    '/opt/myterminal',
    '/usr/local/myterminal',
  ].filter(Boolean);
  return candidates.find((dir) => isMyTerminalCheckout(dir)) ?? null;
}

/**
 * Nearest existing ancestor of `dir` (itself included). A statfs probe target
 * must exist, otherwise ENOENT degrades the disk fact to null — and on a fresh
 * machine neither the checkout nor `~/myterminal` exists yet, so the very first
 * `--json` would report "could not be measured" for a fact that is perfectly
 * measurable (the volume of $HOME). Falls back upward until a path exists; the
 * filesystem root always terminates the loop.
 */
export function nearestExistingAncestor(dir) {
  let cur = dir;
  for (;;) {
    try {
      fs.accessSync(cur);
      return cur;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return cur; // filesystem root reached (e.g. "/" or "C:\")
      cur = parent;
    }
  }
}

/**
 * Free bytes on the volume containing `dir`, or null when unmeasurable.
 * R2 (three-platform requirement): fs.statfsSync is POSIX-only — on Windows it
 * throws ENOENT/ENOTSUP, which would silently degrade the disk fact to null and
 * make l3.recommend skip on every Windows machine. Windows instead asks
 * PowerShell for the PSDrive's free space (`platform` is injectable so the test
 * lock can prove the branch is live on a POSIX runner too).
 */
function readFreeDiskBytes(dir, platform = process.platform) {
  if (platform === 'win32') return readFreeDiskBytesWindows(dir);
  try {
    const stats = fs.statfsSync(dir);
    const free = stats.bavail * stats.bsize;
    if (free > 0) return free;
    // Some macOS x64 runners report bavail*bsize as 0 for certain volumes;
    // fall back to `df -k` so the probe never degrades to "unmeasurable".
    const out = execFileSync('df', ['-k', dir], { encoding: 'utf8', timeout: 10_000 });
    const line = out.trim().split('\n').pop();
    const kb = Number((line.trim().split(/\s+/)[3] ?? 'NaN'));
    if (Number.isFinite(kb) && kb > 0) return kb * 1024;
    return null;
  } catch {
    return null;
  }
}

/** Windows: PowerShell `Get-PSDrive -Name <letter>` free-space probe. */
function readFreeDiskBytesWindows(dir) {
  try {
    // 'C:\foo' → 'C:\' (drive); '\\server\share\...' → UNC root without a local
    // drive letter. PSDrive letters are the only reliably present volumes, so
    // UNC / drive-less paths fall back to null instead of guessing.
    const m = /^([A-Za-z]):\\/.exec(path.parse(dir).root);
    if (!m) return null;
    // PowerShell writes UTF-16LE to a pipe; decode that (with a utf8 fallback
    // for environments that re-encode), strip BOM, then parse the long.
    // The drive letter is interpolated into the -Command string — safe because
    // it comes from the whitelist regex above (a single [A-Za-z] character, no
    // quoting or metacharacters) and execFileSync never goes through a shell.
    // (PowerShell 5.1's -Command does NOT inject $args — pwsh 7+ only — so an
    // argv-passed letter would be appended as a bare token and fail to parse.)
    const buf = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-PSDrive -Name ${m[1]} | Select-Object -ExpandProperty Free)`],
      { encoding: 'buffer', timeout: 10_000 },
    );
    for (const enc of ['utf16le', 'utf8']) {
      const text = buf.toString(enc).replace(/^\uFEFF/, '').trim();
      const bytes = Number(text);
      if (Number.isFinite(bytes) && bytes >= 0) return bytes;
    }
    return null;
  } catch {
    return null;
  }
}

function detect({ env = process.env, installDir, homedir = os.homedir(), platform = process.platform } = {}) {
  const activePlatform = platform;

  const bunProbe = tryExec('bun', ['--version']);
  const bunVersion = parseBunVersion(bunProbe.stdout);

  const foundDir = lookupInstallDir(homedir, installDir);

  const configPath = resolveConfigPath(env, homedir);
  const config = readJsonIfExists(configPath);
  const subagent = config && !config.__parseError && config.subagent && typeof config.subagent === 'object'
    ? config.subagent
    : null;

  // Read-only machine facts (ADR-0053 D6/D7). The agent must declare "read-only
  // scan, nothing modified or deleted" before triggering these.
  // R1: probe the nearest existing ancestor — on a fresh machine the checkout
  // (and ~/myterminal) doesn't exist yet, but the volume of $HOME is measurable.
  const diskProbeDir = nearestExistingAncestor(foundDir ?? path.join(homedir, DEFAULT_INSTALL_DIRNAME));
  // Honest degradation: a null freeDiskBytes means "not measurable on this
  // platform" (never a fabricated number) — recommendL3's null semantics then
  // conservatively skip with the reason spelled out in its `reasons` array.
  const machine = {
    platform: activePlatform,
    freeDiskBytes: readFreeDiskBytes(diskProbeDir, activePlatform),
    totalMemoryBytes: os.totalmem(),
  };

  return {
    platform: activePlatform,
    homedir,
    machine,
    bun: {
      installed: Boolean(bunVersion),
      version: bunVersion,
      satisfiesMinimum: satisfiesMinVersion(bunVersion, MIN_BUN_VERSION),
      minimum: MIN_BUN_VERSION,
      installCommand: 'curl -fsSL https://bun.sh/install | bash',
    },
    myterminal: {
      installDir: foundDir,
      installed: Boolean(foundDir),
      built: foundDir ? fs.existsSync(path.join(foundDir, 'dist', 'cli.js')) : false,
      suggestedInstallDir: foundDir ?? installDir ?? path.join(homedir, DEFAULT_INSTALL_DIRNAME),
      repoUrl: REPO_URL,
    },
    config: {
      path: configPath,
      exists: fs.existsSync(configPath),
      parseError: config?.__parseError ?? null,
      // Projection only — the key value is never read, logged or echoed (ADR-0053 D3/D6).
      subagent: subagent
        ? { baseUrl: subagent.baseUrl ?? null, model: subagent.model ?? null, apiKeySet: Boolean(subagent.apiKey) }
        : null,
      // Whether it is safe to write the subagent section right now, and if not, why.
      writability: assessConfigWritability(config),
    },
    l3: {
      recommend: recommendL3({ freeDiskBytes: machine.freeDiskBytes, totalMemoryBytes: machine.totalMemoryBytes }),
      modelPresent: detectL3ModelPresent(foundDir),
    },
  };
}

function printReport(report) {
  const yn = (b) => (b ? 'yes' : 'no');
  const out = [];
  out.push('MyTerminal onboarding — environment report');
  out.push('');
  out.push(`  OS               ${report.platform}`);
  out.push(`  Machine          free disk ${fmtBytes(report.machine.freeDiskBytes)}, total memory ${fmtBytes(report.machine.totalMemoryBytes)}`);
  out.push(`  bun              ${report.bun.installed ? report.bun.version : 'not found'}` +
    `${report.bun.installed && !report.bun.satisfiesMinimum ? `  (needs >= ${report.bun.minimum})` : ''}`);
  out.push(`  MyTerminal       ${report.myterminal.installed ? report.myterminal.installDir : 'not found'}`);
  out.push(`  Built (dist)     ${yn(report.myterminal.built)}`);
  out.push(`  Config file      ${report.config.path} (exists: ${yn(report.config.exists)})`);
  if (report.config.parseError) out.push(`  Config parse     FAILED: ${report.config.parseError}`);
  if (report.config.subagent) {
    out.push(`  Current subagent baseUrl=${report.config.subagent.baseUrl} model=${report.config.subagent.model} apiKeySet=${yn(report.config.subagent.apiKeySet)}`);
  }
  out.push(`  L3 local model   ${report.l3.modelPresent ? 'present' : 'not present'}`);
  out.push(`  L3 recommend     ${report.l3.recommend.verdict}: ${report.l3.recommend.reasons.join('; ')}`);
  out.push('');

  const blockers = [];
  if (!report.bun.satisfiesMinimum) {
    blockers.push(`bun >= ${report.bun.minimum} is required. Install it, then re-run:\n    ${report.bun.installCommand}`);
  }
  if (!report.config.writability.ok) {
    blockers.push(`config not writable yet (${report.config.writability.reason}):\n      ` +
      report.config.writability.guidance.split('\n').join('\n      '));
  }
  if (blockers.length) {
    out.push('  Blocking prerequisites:');
    for (const b of blockers) out.push(`    - ${b}`);
    out.push('');
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

/**
 * Decide whether `bun run build` must run. Pure (reads the target dir only).
 * A present dist/cli.js is not enough — a half-broken build (cli.js there but
 * node_modules gone, or the artifact older than the manifest/src) would otherwise
 * let the app crash later. `--force` overrides everything.
 */
export function shouldRebuild(target, { force = false } = {}) {
  if (force) return true;
  const cli = path.join(target, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) return true;
  if (!fs.existsSync(path.join(target, 'node_modules'))) return true;
  const cliMtime = fs.statSync(cli).mtimeMs;
  for (const probe of [path.join(target, 'package.json'), path.join(target, 'src')]) {
    if (fs.existsSync(probe) && fs.statSync(probe).mtimeMs > cliMtime) return true;
  }
  return false;
}

function doInstall(report, { installDir, dryRun, force } = {}) {
  const target = installDir ?? report.myterminal.suggestedInstallDir;

  if (!report.bun.satisfiesMinimum) {
    throw new Error(
      `bun >= ${MIN_BUN_VERSION} is required to build MyTerminal, found ${report.bun.version ?? 'nothing'}.\n` +
      `Install it and re-run:\n  ${report.bun.installCommand}`,
    );
  }

  if (dryRun) {
    process.stdout.write(
      `[dry-run] would clone ${REPO_URL} into ${target}\n` +
      `[dry-run] would run: bun install && bun run build\n`,
    );
    return target;
  }

  if (!isMyTerminalCheckout(target)) {
    process.stdout.write(`Cloning ${REPO_URL} -> ${target}\n`);
    execFileSync('git', ['clone', '--depth', '1', REPO_URL, target], { stdio: 'inherit' });
  } else {
    process.stdout.write(`MyTerminal already present at ${target}, skipping clone.\n`);
  }

  process.stdout.write('Installing dependencies (bun install)...\n');
  execFileSync('bun', ['install'], { cwd: target, stdio: 'inherit' });

  if (shouldRebuild(target, { force })) {
    process.stdout.write('Building (bun run build)...\n');
    execFileSync('bun', ['run', 'build'], { cwd: target, stdio: 'inherit' });
  } else {
    process.stdout.write('dist/cli.js present and build looks intact, skipping build.\n');
  }

  process.stdout.write(`Done. Run it with: bun run ${path.join(target, 'dist', 'cli.js')}\n`);
  return target;
}

const OPTIONAL_FIELDS_NOTE =
  '\nOptional subagent fields are NOT written by this script — the app applies its own defaults\n' +
  '(src/config.ts applySubagentDefaults; out-of-range values are clamped). To override one,\n' +
  'edit the subagent block in config.json directly:\n' +
  SUBAGENT_OPTIONAL_FIELDS.map((f) =>
    `  ${f.field.padEnd(16)} default ${String(f.default).padStart(7)}  range [${f.min}-${f.max}]`,
  ).join('\n') + '\n';

/** JSON draft with the apiKey value redacted — the key must never appear in any output (ADR-0053 D3). */
function redactDraft(obj, indent) {
  const clone = structuredClone(obj);
  if (clone.subagent && typeof clone.subagent === 'object' && clone.subagent.apiKey) {
    clone.subagent.apiKey = '<redacted>';
  }
  return JSON.stringify(clone, null, indent);
}

function doWriteConfig(report, { baseUrl, model, key, fallbackModel, dryRun }) {
  const configPath = report.config.path;
  const existing = report.config.exists ? readJsonIfExists(configPath) : null;

  // Never fabricate a config. See assessConfigWritability / the missing-config guidance.
  const writability = assessConfigWritability(existing);
  if (!writability.ok) {
    throw new Error(`Cannot write ${configPath} (${writability.reason}).\n\n${writability.guidance}`);
  }

  const merged = mergeSubagentConfig(existing, { baseUrl, model, apiKey: key, fallbackModel });

  if (dryRun) {
    process.stdout.write(`[dry-run] would write ${configPath}:\n${redactDraft(merged, 2)}\n`);
    process.stdout.write(OPTIONAL_FIELDS_NOTE);
    return merged;
  }

  // Match the permissions the app itself uses (src/config.ts saveMyTerminalSettings).
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(configPath, `${configPath}.myterminal-backup`);
  // The backup carries connectorKey/actionsToken — copyFileSync inherits the umask
  // (typically 0644), so force it to the same 0600 as the main file (R4).
  fs.chmodSync(`${configPath}.myterminal-backup`, 0o600);
  fs.writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(configPath, 0o600);

  // The key value is never echoed — booleans only (ADR-0053 D3).
  process.stdout.write(`Wrote ${configPath} (backup: ${configPath}.myterminal-backup)\n`);
  process.stdout.write(
    `  subagent.baseUrl  = ${merged.subagent.baseUrl}\n` +
    `  subagent.model    = ${merged.subagent.model}\n` +
    `  subagent.apiKey   = ${merged.subagent.apiKey ? 'set (value never echoed)' : 'MISSING'}\n`,
  );
  process.stdout.write(OPTIONAL_FIELDS_NOTE);
  return merged;
}

async function doProbe(report, { baseUrl, fetchImpl, dryRun } = {}) {
  const resolvedBase = baseUrl || report.config.subagent?.baseUrl;
  if (!resolvedBase) {
    throw new Error('No base URL. Pass --base-url <url>, or run after --write-config has recorded one.');
  }
  const target = `${normalizeBaseUrl(resolvedBase)}/v1/messages`;
  if (dryRun) {
    process.stdout.write(
      `[dry-run] would send a KEYLESS probe POST to ${target}\n` +
      '  (no Authorization header, no API key; expect 401/403 from a real Anthropic-compatible endpoint).\n',
    );
    return { ok: null, reachable: null, status: 0, kind: 'dry-run', message: 'dry-run' };
  }
  process.stdout.write(`Probing ${target} (keyless — no API key is sent)...\n`);
  const result = await probeEndpoint(resolvedBase, { fetchImpl });
  process.stdout.write(`${result.ok ? '✓ REACHABLE' : '✗ UNREACHABLE'} ${result.message}\n`);
  return result;
}

async function doHealthCheck(report, { host, port, fetchImpl, dryRun } = {}) {
  const targetHost = host || '127.0.0.1';
  const targetPort = port || 3210;
  if (dryRun) {
    process.stdout.write(`[dry-run] would check http://${targetHost}:${targetPort}/health\n`);
    return { ok: null, reachable: null, status: 0, product: null, message: 'dry-run', dryRun: true };
  }
  process.stdout.write(`Checking MyTerminal health at http://${targetHost}:${targetPort}/health...\n`);
  const result = await checkHealth({ host: targetHost, port: targetPort, fetchImpl });
  process.stdout.write(`${result.ok ? '✓ PASS' : (result.reachable ? '⚠ DEGRADED' : '✗ FAIL')} ${result.message}\n`);
  return result;
}

export const HELP = `onboard.mjs — install MyTerminal and configure its subagent LLM

USAGE
  node scripts/onboard.mjs                    Detect and report. Read-only, writes nothing.
  node scripts/onboard.mjs --json             Same report as JSON (for AI agents to parse).
  node scripts/onboard.mjs --install          Clone + bun install + bun run build.
  node scripts/onboard.mjs --write-config --base-url <url> --model <m> [--fallback-model <f>] [--key -]
                                              Write subagent settings (model/baseUrl/apiKey) to config.json.
  node scripts/onboard.mjs --probe [--base-url <url>]
                                              Keyless connectivity probe: POST <baseUrl>/v1/messages with NO
                                              credentials; expect 401/403 (endpoint reachable + Anthropic shape).
  node scripts/onboard.mjs --healthcheck [--host <h>] [--port <p>]
                                              Confirm the running service answers GET /health
                                              (HTTP 200 + product:'myterminal'). Use after 'bun start'.

OPTIONS
  --install-dir <path>   Where to clone MyTerminal. Default: ~/myterminal
  --base-url <url>       Anthropic-compatible base URL for --write-config / --probe. The app appends
                         /v1/messages itself — give the vendor base (e.g. https://api.anthropic.com),
                         no /v1, no /messages.
  --model <name>         Model id (required for --write-config unless already set in the config).
  --fallback-model <m>   Optional overload-degradation model (subagent.fallbackModel, types.ts:222).
                         Omit to leave it unset.
  --key -                API key from stdin (required for --write-config unless the config already
                         has one). The key IS stored in config.json (app contract), written at 0600
                         with a backup, and never echoed in any output.
  --probe                Keyless connectivity check (see USAGE). Never sends the API key.
  --healthcheck          Probe the local service: GET http://<host>:<port>/health and expect
                         200 + product:'myterminal'. Defaults host=127.0.0.1 port=3210.
  --host <host>          Health-check host (with --healthcheck). Default 127.0.0.1.
  --port <port>          Health-check port (with --healthcheck). Default 3210.
  --force                Force a rebuild even if dist/cli.js already exists (use after a
                         half-broken build — e.g. node_modules was wiped).
  --repair               Back up and remove a broken config.json so the first-run setup
                         screen can re-mint one (use when the file is corrupt or credentials
                         were lost). Safe: a healthy config is left untouched.
  --self-test            Self-diagnostic for a deployed copy: verify every expected export/flag is
                         present (no repo, no network). Run after install to catch a stale copy.
  --dry-run              Show what would change; write nothing.
  --help                 This text.

NOTES
  - The subagent block is written as the app's three-required contract (ADR-0045):
    model + baseUrl + apiKey. A legacy 'provider' field is deleted on write — the app silently
    ignores the whole block when it is present (src/config.ts:142-147).
  - Optional subagent fields (maxTurns/timeoutSec/maxParallel/contextWindow/maxOutput/
    compactThreshold) are NOT written here — the app applies its own defaults.
  - The API key is provided via '--key -' (stdin), written at 0600 with a backup, and never
    echoed. No outbound call ever carries it — the probe is keyless.
  - The shell-profile export mechanism was retired (ADR-0053 D5): no profile is ever edited.
  - bun >= ${MIN_BUN_VERSION} is a hard prerequisite for building MyTerminal.
  - Design contract: docs/adr/0053-onboarding-skill-adr0045-migration-l3-install.md.
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const name = token.slice(2);
    const valueFlags = ['install-dir', 'base-url', 'model', 'key', 'host', 'port', 'fallback-model'];
    if (valueFlags.includes(name)) {
      args[name] = argv[i + 1];
      i += 1;
    } else {
      args[name] = true;
    }
  }
  return args;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (args['self-test']) {
    return doSelfTest();
  }

  if (args.key !== undefined && !args['write-config']) {
    // --key without --write-config is a silent no-op path; warn instead of
    // swallowing it (and the key may already sit in shell history).
    process.stderr.write('Warning: --key has no effect without --write-config. Use "onboard.mjs --write-config --base-url <url> --model <m> --key -".\n');
  }

  const installDir = args['install-dir'] ? path.resolve(args['install-dir']) : undefined;
  const dryRun = Boolean(args['dry-run']);
  let report = detect({ installDir });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  if (args.repair) {
    const result = repairConfig(report.config.path, { dryRun });
    process.stdout.write(`${result.ok ? '✓' : '•'} ${result.message}\n`);
    return 0;
  }

  if (args.healthcheck) {
    const portArg = args.port ? Number(args.port) : undefined;
    if (args.port && Number.isNaN(portArg)) {
      throw new Error(`Invalid --port value: ${args.port}. Expected a number.`);
    }
    const result = await doHealthCheck(report, { host: args.host, port: portArg, dryRun });
    if (dryRun) return 0;
    return result.ok === false ? 1 : 0;
  }

  if (args.probe) {
    const result = await doProbe(report, { baseUrl: args['base-url'], dryRun });
    if (dryRun) return 0;
    return result.ok === false ? 1 : 0;
  }

  const wantsWork = args.install || args['write-config'];
  if (!wantsWork) {
    printReport(report);
    process.stdout.write('Nothing was written. Pass --help to see the write commands.\n');
    return 0;
  }

  if (args.install) {
    const target = doInstall(report, { installDir, dryRun, force: Boolean(args.force) });
    report = detect({ installDir: target });
  }

  if (args['write-config']) {
    let key = args.key === '-' ? readStdin() : (args.key ? String(args.key) : undefined);
    if (args.key && args.key !== '-') {
      process.stderr.write('Warning: the key was passed on the command line and may be stored in your shell history. Use "--key -" to pipe it via stdin instead.\n');
    }
    doWriteConfig(report, { baseUrl: args['base-url'], model: args.model, key, fallbackModel: args['fallback-model'], dryRun });
  }

  return 0;
}

/**
 * Was this file run as a command, rather than imported?
 *
 * Must compare *real* paths: the entrypoint can be a symlink (a PATH shim, for example), and
 * Node resolves `import.meta.url` to the link target while leaving `process.argv[1]` as
 * the link itself. A naive string compare therefore never matches and the command silently
 * does nothing. (Bun happens to behave differently, which is exactly how this stayed hidden.)
 * Locked by test/adr43-onboarding-skill.test.mjs.
 */
function isInvokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(entry) === real(self);
}

if (isInvokedDirectly()) {
  (async () => {
    try {
      process.exitCode = await main();
    } catch (error) {
      process.stderr.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  })();
}

export { detect, main, doHealthCheck, doWriteConfig, doProbe };
