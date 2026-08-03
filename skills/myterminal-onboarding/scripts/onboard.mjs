#!/usr/bin/env node
/**
 * onboard.mjs — installs MyTerminal and configures its subagent LLM.
 *
 * Design contract: docs/adr/0043-myterminal-onboarding-skill.md
 *
 * Two halves:
 *   1. Pure logic (exported, unit-tested in test/adr43-onboarding-skill.test.mjs)
 *      — provider validation, path resolution, shell detection, config merge,
 *        idempotent profile append, version comparison.
 *   2. Side effects (CLI only) — clone, build, write config.json, append profile.
 *
 * Hard rules:
 *   - The API key is NEVER written into config.json. Environment variables only.
 *   - Running with no flags is READ-ONLY. Nothing is written until you pass a write flag.
 *   - Only the 5 providers that `createAdapter` actually supports are offered. No pretending.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// Facts mirrored from the main repo. If the repo changes, these must change too
// (test/adr43-onboarding-skill.test.mjs locks them).
//   src/types.ts:185                       — SUBAGENT_PROVIDERS (closed list of 5)
//   src/subagent/llm-adapter.ts:1099-1147  — env var name per provider
//   src/config.ts:24-30                    — settingsPath fallback chain
//   src/config.ts:101-108                  — subagent defaults
// ─────────────────────────────────────────────────────────────────────────────

export const SUPPORTED_PROVIDERS = [
  {
    provider: 'openai',
    envVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o',
    consoleUrl: 'https://platform.openai.com/api-keys',
    note: 'Default. Native OpenAI protocol.',
  },
  {
    provider: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-3-5-sonnet-20241022',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    note: 'Native Anthropic protocol.',
  },
  {
    provider: 'deepseek',
    envVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    note: 'Cheapest. OpenAI-compatible protocol.',
  },
  {
    provider: 'glm',
    envVar: 'GLM_API_KEY',
    defaultModel: 'glm-4',
    consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: 'Zhipu AI. OpenAI-compatible protocol. `glm-4-flash` is the cheap tier.',
  },
  {
    provider: 'qwen',
    envVar: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-max',
    consoleUrl: 'https://dashscope.console.aliyun.com/apiKey',
    note: 'Alibaba DashScope. Optional DASHSCOPE_BASE_URL override. Up to 1M context.',
  },
];

export const SUBAGENT_DEFAULTS = {
  enabled: true,
  maxTurns: 50,
  timeoutSec: 300,
  maxParallel: 2,
};

export const MIN_BUN_VERSION = '1.3.0';
export const REPO_URL = 'https://github.com/epslkslsksndnsjs-lab/myterminal.git';
export const DEFAULT_INSTALL_DIRNAME = 'myterminal';

export const PROFILE_MARKER_BEGIN = '# >>> myterminal-onboarding >>>';
export const PROFILE_MARKER_END = '# <<< myterminal-onboarding <<<';

/** Keys that must never survive into config.json. */
const SECRET_KEYS = ['apiKey', 'api_key', 'key', 'token', 'secret'];

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors `optionalEnv` in src/config.ts: blank / whitespace-only means unset. */
function optionalEnv(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return candidate || undefined;
}

/**
 * Validate a provider name against the closed list the runtime actually supports.
 * Returns { ok: true, entry } or { ok: false, supported, message } — never throws.
 */
export function validateProvider(name) {
  const normalized = String(name ?? '').trim().toLowerCase();
  const entry = SUPPORTED_PROVIDERS.find((p) => p.provider === normalized);
  if (entry) return { ok: true, entry };

  const supported = SUPPORTED_PROVIDERS.map((p) => p.provider);
  return {
    ok: false,
    supported,
    message:
      `Provider "${name}" is not supported by this build of MyTerminal.\n` +
      `Supported providers: ${supported.join(', ')}.\n` +
      'Any other endpoint (including OpenAI-compatible ones such as OpenRouter, Ollama or ' +
      'llama.cpp) requires a code change: add an adapter subclass and a new case in ' +
      '`createAdapter` (src/subagent/llm-adapter.ts). It cannot be enabled by configuration alone.',
  };
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
 * Work out which shell profile holds the user's environment variables.
 * Native Windows is reported as manual — we never inject into the registry.
 */
export function detectShellProfile({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (platform === 'win32') {
    return {
      kind: 'windows-native',
      path: null,
      manual: true,
      wsl: false,
      manualHint:
        'Native Windows detected. Set the key manually, then restart your terminal:\n' +
        '  setx <ENV_VAR> "<your-api-key>"\n' +
        'Or: System Properties -> Advanced -> Environment Variables -> New (User variables).\n' +
        'WSL is the smoother path if you have it: run this command inside WSL instead.',
    };
  }

  const wsl = Boolean(optionalEnv(env.WSL_DISTRO_NAME) || optionalEnv(env.WSLENV));
  const shell = String(env.SHELL ?? '');
  const base = { manual: false, wsl, manualHint: null };

  if (shell.includes('fish')) {
    return { ...base, kind: 'fish', path: path.join(homedir, '.config', 'fish', 'config.fish') };
  }
  if (shell.includes('zsh')) {
    return { ...base, kind: 'zsh', path: path.join(homedir, '.zshrc') };
  }
  if (shell.includes('bash')) {
    // macOS login shells read .bash_profile; Linux interactive shells read .bashrc.
    const file = platform === 'darwin' ? '.bash_profile' : '.bashrc';
    return { ...base, kind: 'bash', path: path.join(homedir, file) };
  }

  // SHELL unset or unrecognised — fall back to the platform default.
  if (platform === 'darwin') {
    return { ...base, kind: 'zsh', path: path.join(homedir, '.zshrc') };
  }
  return { ...base, kind: 'bash', path: path.join(homedir, '.bashrc') };
}

function escapeForDoubleQuotes(value) {
  return String(value).replace(/([\\"$`])/g, '\\$1');
}

/** Render the exact line the user needs in their shell profile. */
export function buildExportLine(provider, key, shellKind = 'bash') {
  const check = validateProvider(provider);
  if (!check.ok) throw new Error(check.message);

  const name = check.entry.envVar;
  const value = escapeForDoubleQuotes(key);
  return shellKind === 'fish' ? `set -gx ${name} "${value}"` : `export ${name}="${value}"`;
}

function stripSecrets(obj) {
  const clean = { ...obj };
  for (const secret of SECRET_KEYS) delete clean[secret];
  return clean;
}

/**
 * Known model-name prefixes per provider. Used to catch the silent failure where an
 * agent writes e.g. `qwen3.7-plus` under `provider: openai` — the config writes fine
 * but the subagent crashes at runtime (review gap P1-3). Heuristic, not a registry:
 * it only flags *clear* mismatches and *unknown* prefixes (advisory), never invents support.
 */
export const MODEL_PREFIXES = {
  openai: ['gpt-', 'o1', 'o3', 'o4', 'chatgpt-', 'ft:gpt-'],
  anthropic: ['claude-'],
  deepseek: ['deepseek-'],
  glm: ['glm-', 'charglm-'],
  qwen: ['qwen-'],
};

// Infix keywords that strongly imply a provider. Used (in addition to prefixes) to catch
// mismatches the prefix check misses — e.g. "qwen3.7-plus" has no "qwen-" prefix but is clearly qwen.
export const PROVIDER_MODEL_KEYWORDS = {
  openai: ['gpt', 'o1', 'o3', 'o4', 'chatgpt'],
  anthropic: ['claude'],
  deepseek: ['deepseek'],
  glm: ['glm'],
  qwen: ['qwen'],
};

/**
 * Decide whether `model` is plausible for `provider`.
 * Returns { ok, reason, message, warning }.
 *   ok:false  → clear mismatch (belongs to another provider) — caller must throw.
 *   ok:true   → matches this provider, or empty (use default), or unknown model (advisory warning).
 * Never returns "supported" for an unknown provider — validateProvider handles that upstream.
 */
export function validateModelForProvider(provider, model) {
  const check = validateProvider(provider);
  if (!check.ok) return { ok: false, reason: 'bad-provider', message: check.message };
  const modelId = String(model ?? '').trim();
  if (!modelId) return { ok: true, warning: null, message: 'empty model — will use provider default' };

  const lower = modelId.toLowerCase();
  const ownPrefixes = MODEL_PREFIXES[check.entry.provider] || [];
  const ownKeywords = PROVIDER_MODEL_KEYWORDS[check.entry.provider] || [];
  const matchesOwn =
    ownPrefixes.some((p) => lower.startsWith(p.toLowerCase())) ||
    ownKeywords.some((k) => lower.includes(k.toLowerCase()));
  if (matchesOwn) return { ok: true, warning: null, message: 'model matches provider' };

  for (const [other, keywords] of Object.entries(PROVIDER_MODEL_KEYWORDS)) {
    if (other === check.entry.provider) continue;
    const hit = keywords.find((k) => lower.includes(k.toLowerCase()));
    if (hit) {
      return {
        ok: false,
        reason: 'mismatch',
        message:
          `Model "${modelId}" looks like a ${other} model (keyword "${hit}"), but the chosen provider ` +
          `is ${check.entry.provider}. This would write a config that fails at runtime. ` +
          `Pass --provider ${other}, or pick a ${check.entry.provider} model (e.g. ${check.entry.defaultModel}).`,
      };
    }
  }

  return {
    ok: true,
    warning: `Model "${modelId}" does not match a known ${check.entry.provider} model; proceeding — make sure it is valid for this provider.`,
    message: 'unknown model (advisory)',
  };
}

/**
 * Merge provider/model into an existing config object.
 * Preserves every other key the user already has; fills in repo defaults for
 * anything missing; refuses to carry an API key.
 */
export function mergeSubagentConfig(existing, patch) {
  const check = validateProvider(patch?.provider);
  if (!check.ok) throw new Error(check.message);

  const modelId = String(patch.model ?? check.entry.defaultModel);
  const modelCheck = validateModelForProvider(check.entry.provider, modelId);
  if (!modelCheck.ok) throw new Error(`Model/provider mismatch: ${modelCheck.message}`);

  const source = existing && typeof existing === 'object' ? existing : {};
  const cloned = structuredClone(source);
  const currentSubagent = cloned.subagent && typeof cloned.subagent === 'object' ? cloned.subagent : {};
  const preserved = stripSecrets(currentSubagent);

  const subagent = {
    ...preserved,
    enabled: preserved.enabled ?? SUBAGENT_DEFAULTS.enabled,
    provider: check.entry.provider,
    model: modelId,
    maxTurns: preserved.maxTurns ?? SUBAGENT_DEFAULTS.maxTurns,
    timeoutSec: preserved.timeoutSec ?? SUBAGENT_DEFAULTS.timeoutSec,
    maxParallel: preserved.maxParallel ?? SUBAGENT_DEFAULTS.maxParallel,
  };

  return { ...cloned, subagent };
}

/**
 * Append (or update in place) our marked block in a shell profile.
 * Running this twice with the same lines is a no-op — that is the whole point.
 */
export function appendProfileBlock(content, lines) {
  const body = Array.isArray(lines) ? lines : [lines];
  const block = `${PROFILE_MARKER_BEGIN}\n${body.join('\n')}\n${PROFILE_MARKER_END}\n`;
  const current = typeof content === 'string' ? content : '';

  const startIdx = current.indexOf(PROFILE_MARKER_BEGIN);
  const endMarkerIdx = startIdx === -1 ? -1 : current.indexOf(PROFILE_MARKER_END, startIdx);

  if (startIdx !== -1 && endMarkerIdx !== -1) {
    let endIdx = endMarkerIdx + PROFILE_MARKER_END.length;
    if (current[endIdx] === '\n') endIdx += 1;

    const existingBlock = current.slice(startIdx, endIdx);
    if (existingBlock === block) return { content: current, changed: false };

    return { content: current.slice(0, startIdx) + block + current.slice(endIdx), changed: true };
  }

  const base = current && !current.endsWith('\n') ? `${current}\n` : current;
  return { content: base + block, changed: true };
}

/** Pull "1.3.2" out of whatever `bun --version` printed. Returns null if there is no version. */
export function parseBunVersion(stdout) {
  if (!stdout || typeof stdout !== 'string') return null;
  const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * Fields that `validateSettings` (src/config.ts:113) requires. A config missing any of
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
 * what "done" looks like — the old flow just said "run bun run dev" and left them
 * staring at an empty prompt (review gap P0-2).
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
  '  3. re-run: node scripts/onboard.mjs --write-config --provider <p> [--model <m>]';

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
 * already flags (review gap P2-6): unparsable / unsupported-schema / incomplete.
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
// Provider key verification (P0-1)
//
// A real, minimal round-trip against the provider. Base URLs mirror
// src/subagent/llm-adapter.ts:298/869/882/1140. A 1-token chat completion is the
// strongest proof that the key is valid, reachable, and the model actually
// responds — exactly what the old flow lacked (it only echoed $ENV_VAR, so a
// revoked key sailed through to a runtime crash). `fetchImpl` is injectable so the
// lock suite can assert request construction without touching the network.
// ─────────────────────────────────────────────────────────────────────────────

export const VERIFY_ENDPOINTS = {
  openai: { baseUrl: 'https://api.openai.com/v1', kind: 'openai-compatible', defaultModel: 'gpt-4o' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', kind: 'anthropic', defaultModel: 'claude-3-5-sonnet-20241022' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', kind: 'openai-compatible', defaultModel: 'deepseek-chat' },
  glm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', kind: 'openai-compatible', defaultModel: 'glm-4' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', kind: 'openai-compatible', defaultModel: 'qwen-max' },
};

/**
 * Prove a provider key works by making a real, minimal API call.
 * Returns { ok, status, message } — never throws. `fetchImpl` must match the
 * global fetch signature: (url, opts) => Promise<{ ok, status, text() }>.
 */
export async function verifyProviderKey(provider, key, { model, baseUrl, fetchImpl = fetch } = {}) {
  const check = validateProvider(provider);
  if (!check.ok) return { ok: false, status: 0, message: check.message };
  if (!key) return { ok: false, status: 0, message: `No API key supplied for ${check.entry.provider}. Set ${check.entry.envVar} or pass --key.` };

  const endpoint = VERIFY_ENDPOINTS[check.entry.provider];
  const resolvedBase = baseUrl || endpoint.baseUrl;
  const modelId = model || endpoint.defaultModel;

  let url;
  let headers;
  let bodyObj;
  if (endpoint.kind === 'anthropic') {
    url = `${resolvedBase}/messages`;
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    bodyObj = { model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
  } else {
    url = `${resolvedBase}/chat/completions`;
    headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    bodyObj = { model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 };
  }

  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(bodyObj) });
    if (res.ok) return { ok: true, status: res.status, message: `${check.entry.provider} key valid; model ${modelId} responded.` };
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    return { ok: false, status: res.status, message: `${check.entry.provider} rejected the key (HTTP ${res.status}). ${detail}` };
  } catch (err) {
    return { ok: false, status: 0, message: `Network error reaching ${check.entry.provider}: ${err instanceof Error ? err.message : String(err)}` };
  }
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
 * avoid wrongly concluding "not installed" and cloning a fresh copy next to an existing one
 * (review gap P1-4). Explicit --install-dir always wins.
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

function detect({ env = process.env, installDir, homedir = os.homedir() } = {}) {
  const platform = process.platform;
  const profile = detectShellProfile({ platform, env, homedir });

  const bunProbe = tryExec('bun', ['--version']);
  const bunVersion = parseBunVersion(bunProbe.stdout);

  const foundDir = lookupInstallDir(homedir, installDir);

  const configPath = resolveConfigPath(env, homedir);
  const config = readJsonIfExists(configPath);

  return {
    platform,
    homedir,
    wsl: profile.wsl,
    shell: { kind: profile.kind, profilePath: profile.path, manual: profile.manual, manualHint: profile.manualHint },
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
      subagent: config && !config.__parseError ? (config.subagent ?? null) : null,
      // Whether it is safe to write the subagent section right now, and if not, why.
      writability: assessConfigWritability(config),
    },
    // Booleans only. The values themselves are never read, logged or echoed.
    apiKeysPresent: Object.fromEntries(
      SUPPORTED_PROVIDERS.map((p) => [p.provider, Boolean(optionalEnv(env[p.envVar]))]),
    ),
    providers: SUPPORTED_PROVIDERS,
  };
}

function printReport(report) {
  const yn = (b) => (b ? 'yes' : 'no');
  const out = [];
  out.push('MyTerminal onboarding — environment report');
  out.push('');
  out.push(`  OS               ${report.platform}${report.wsl ? ' (WSL)' : ''}`);
  out.push(`  Shell            ${report.shell.kind}`);
  out.push(`  Shell profile    ${report.shell.profilePath ?? '(manual — native Windows)'}`);
  out.push(`  bun              ${report.bun.installed ? report.bun.version : 'not found'}` +
    `${report.bun.installed && !report.bun.satisfiesMinimum ? `  (needs >= ${report.bun.minimum})` : ''}`);
  out.push(`  MyTerminal       ${report.myterminal.installed ? report.myterminal.installDir : 'not found'}`);
  out.push(`  Built (dist)     ${yn(report.myterminal.built)}`);
  out.push(`  Config file      ${report.config.path} (exists: ${yn(report.config.exists)})`);
  if (report.config.parseError) out.push(`  Config parse     FAILED: ${report.config.parseError}`);
  if (report.config.subagent) {
    out.push(`  Current subagent provider=${report.config.subagent.provider} model=${report.config.subagent.model}`);
  }
  out.push('');
  out.push('  API keys present in this shell:');
  for (const p of SUPPORTED_PROVIDERS) {
    out.push(`    ${p.provider.padEnd(10)} ${p.envVar.padEnd(20)} ${yn(report.apiKeysPresent[p.provider])}`);
  }
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
  if (report.shell.manual) {
    out.push(report.shell.manualHint.split('\n').map((l) => `  ${l}`).join('\n'));
    out.push('');
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

/**
 * Decide whether `bun run build` must run. Pure (reads the target dir only).
 * A present dist/cli.js is not enough — a half-broken build (cli.js there but
 * node_modules gone, or the artifact older than the manifest/src) would otherwise
 * let the app crash later. `--force` overrides everything (review gap P2-5).
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

function doWriteConfig(report, { provider, model, dryRun }) {
  const check = validateProvider(provider);
  if (!check.ok) throw new Error(check.message);

  const modelId = model ?? check.entry.defaultModel;
  const modelCheck = validateModelForProvider(check.entry.provider, modelId);
  if (!modelCheck.ok) throw new Error(`Model/provider mismatch: ${modelCheck.message}`);

  const configPath = report.config.path;
  const existing = report.config.exists ? readJsonIfExists(configPath) : null;

  // Never fabricate a config. See LOCK-43-8 / ADR-0043 D9.
  const writability = assessConfigWritability(existing);
  if (!writability.ok) {
    throw new Error(`Cannot write ${configPath} (${writability.reason}).\n\n${writability.guidance}`);
  }

  const merged = mergeSubagentConfig(existing, { provider: check.entry.provider, model: modelId });
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;

  if (dryRun) {
    process.stdout.write(`[dry-run] would write ${configPath}:\n${serialized}`);
    if (modelCheck.warning) process.stdout.write(`Warning: ${modelCheck.warning}\n`);
    return merged;
  }

  // Match the permissions the app itself uses (src/config.ts saveMyTerminalSettings).
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(configPath, `${configPath}.myterminal-backup`);
  fs.writeFileSync(configPath, serialized, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  process.stdout.write(`Wrote ${configPath} (backup: ${configPath}.myterminal-backup)\n  subagent.provider = ${merged.subagent.provider}\n  subagent.model    = ${merged.subagent.model}\n`);
  process.stdout.write('The API key is deliberately NOT stored here — it is read from the environment.\n');
  if (modelCheck.warning) process.stdout.write(`Warning: ${modelCheck.warning}\n`);
  return merged;
}

function doKey(report, { provider, key, writeProfile, dryRun }) {
  const check = validateProvider(provider);
  if (!check.ok) throw new Error(check.message);

  const line = buildExportLine(check.entry.provider, key, report.shell.kind);

  if (report.shell.manual) {
    process.stdout.write(
      `${report.shell.manualHint}\n\nFor ${check.entry.provider}, the variable is ${check.entry.envVar}:\n` +
      `  setx ${check.entry.envVar} "<your-api-key>"\n`,
    );
    return;
  }

  if (!writeProfile) {
    process.stdout.write(`Add this line to ${report.shell.profilePath}, then restart your terminal:\n\n  ${line}\n\n`);
    process.stdout.write(`Verify with: echo $${check.entry.envVar}\n`);
    return;
  }

  const profilePath = report.shell.profilePath;
  const current = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';
  const result = appendProfileBlock(current, [line]);

  if (dryRun) {
    process.stdout.write(`[dry-run] would ${result.changed ? 'update' : 'leave unchanged'} ${profilePath}\n`);
    return;
  }

  if (!result.changed) {
    process.stdout.write(`${profilePath} already up to date, nothing to do.\n`);
  } else {
    if (current) fs.copyFileSync(profilePath, `${profilePath}.myterminal-backup`);
    fs.writeFileSync(profilePath, result.content, 'utf8');
    process.stdout.write(`Updated ${profilePath}${current ? ' (backup: ' + profilePath + '.myterminal-backup)' : ''}\n`);
  }
  process.stdout.write(
    `\nRestart your terminal (or run: source ${profilePath}), then verify:\n` +
    `  echo $${check.entry.envVar}\n`,
  );
}

async function doVerify(report, { provider, model, key, dryRun } = {}) {
  const resolvedProvider = provider || report.config.subagent?.provider;
  if (!resolvedProvider) {
    throw new Error('No provider specified and no current subagent provider found. Pass --provider <p>.');
  }
  const check = validateProvider(resolvedProvider);
  if (!check.ok) throw new Error(check.message);

  const resolvedKey = key || optionalEnv(process.env[check.entry.envVar]);
  const resolvedBase = check.entry.provider === 'qwen' ? optionalEnv(process.env.DASHSCOPE_BASE_URL) : undefined;

  if (!resolvedKey) {
    throw new Error(`No API key for ${check.entry.provider}. Set ${check.entry.envVar} in your environment, or pass --key.`);
  }

  if (dryRun) {
    const target = resolvedBase || VERIFY_ENDPOINTS[check.entry.provider].baseUrl;
    process.stdout.write(`[dry-run] would verify ${check.entry.provider} key (model ${model || check.entry.defaultModel}) against ${target}\n`);
    return { ok: null, status: 0, message: 'dry-run' };
  }

  process.stdout.write(`Verifying ${check.entry.provider} key against the live API (model ${model || check.entry.defaultModel})...\n`);
  const result = await verifyProviderKey(check.entry.provider, resolvedKey, { model, baseUrl: resolvedBase });
  process.stdout.write(`${result.ok ? '✓ PASS' : '✗ FAIL'} ${result.message} (HTTP ${result.status})\n`);
  return result;
}

const HELP = `onboard.mjs — install MyTerminal and configure its subagent LLM

USAGE
  node scripts/onboard.mjs                    Detect and report. Read-only, writes nothing.
  node scripts/onboard.mjs --json             Same report as JSON (for AI agents to parse).
  node scripts/onboard.mjs --install          Clone + bun install + bun run build.
  node scripts/onboard.mjs --write-config --provider <p> [--model <m>]
                                              Write subagent settings to config.json.
  node scripts/onboard.mjs --key <API_KEY> --provider <p> [--write-profile]
                                              Print (or append) the export line for the key.
  node scripts/onboard.mjs --verify [--provider <p>] [--model <m>] [--key <k>]
                                              Prove the key works: real 1-token API call to the provider.
  node scripts/onboard.mjs --test-call        Alias for --verify.

OPTIONS
  --install-dir <path>   Where to clone MyTerminal. Default: ~/myterminal
  --provider <name>      One of: ${SUPPORTED_PROVIDERS.map((p) => p.provider).join(', ')}
  --model <name>         Model id. Defaults to the provider's recommended model.
  --key <value>          API key. Use "--key -" to read it from stdin instead
                         (avoids leaving the key in your shell history).
  --write-profile        Append the export line to your shell profile (idempotent, backed up).
  --verify               Prove the key works: make a real 1-token API call to the provider.
                         Reads the key from the provider env var (or --key). Network call; opt-in.
  --test-call            Alias for --verify.
  --force                Force a rebuild even if dist/cli.js already exists (use after a
                         half-broken build — e.g. node_modules was wiped).
  --repair               Back up and remove a broken config.json so the first-run setup
                         screen can re-mint one (use when the file is corrupt or credentials
                         were lost). Safe: a healthy config is left untouched.
  --dry-run              Show what would change; write nothing.
  --help                 This text.

NOTES
  - Only ${SUPPORTED_PROVIDERS.length} providers are supported. Anything else needs a code change
    in createAdapter (src/subagent/llm-adapter.ts). See docs/adr/0043.
  - The API key is never written to config.json. Environment variables only.
  - bun >= ${MIN_BUN_VERSION} is a hard prerequisite for building MyTerminal.
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
    const valueFlags = ['install-dir', 'provider', 'model', 'key'];
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

  if (args.verify || args['test-call']) {
    const keyArg = args.key === '-' ? readStdin() : (args.key ? String(args.key) : undefined);
    if (args.key && args.key !== '-') {
      process.stderr.write('Warning: the key was passed on the command line and may be stored in your shell history. Use "--key -" to pipe it via stdin instead.\n');
    }
    const result = await doVerify(report, { provider: args.provider, model: args.model, key: keyArg, dryRun });
    if (dryRun) return 0;
    return result.ok === false ? 1 : 0;
  }

  const wantsWork = args.install || args['write-config'] || args.key;
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
    doWriteConfig(report, { provider: args.provider, model: args.model, dryRun });
  }

  if (args.key) {
    const key = args.key === '-' ? readStdin() : String(args.key);
    if (!key) throw new Error('Empty API key.');
    if (args.key !== '-') {
      process.stderr.write('Warning: the key was passed on the command line and may be stored in your shell history. Use "--key -" to pipe it via stdin instead.\n');
    }
    doKey(report, { provider: args.provider, key, writeProfile: Boolean(args['write-profile']), dryRun });
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
 * Locked by test/adr43-onboarding-skill.test.mjs [LOCK-43-9].
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

export { detect, main };
