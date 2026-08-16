---
name: myterminal-onboarding
description: Install MyTerminal on this machine and configure its subagent LLM — fill an Anthropic-compatible endpoint (base URL), a model id, and an API key. Run once per machine.
license: MIT
disable: false
---

> **Invocation:** User-invoked only. Do not auto-trigger this skill; run it only when the user
> explicitly requests it by name (`myterminal-onboarding`), or asks to install or configure
> MyTerminal (or its subagent LLM). When triggered, run `node scripts/onboard.mjs` from this
> skill's directory.

## Install

This is a pure-folder skill — no `npm install`, no build step. A single command installs it:
it auto-detects installed agents (WorkBuddy / Claude Code / Cursor) and installs to all of them
with a progress bar — just press **Enter**:

```bash
# One command, runnable from any directory (use the actual MyTerminal path on this machine)
node <myterminal-path>/skills/myterminal-onboarding/scripts/install.mjs
```

> ⚠️ Use an **absolute path** (or a `~/...` home-expanded path). Do not write `node skills/.../install.mjs` —
> a relative path resolves from your *current directory* and fails with `Cannot find module`
> when run from `~` or anywhere else.

- **One command + Enter**: no selection, no arrow keys, no extra steps. Detected agents are all
  installed; the progress bar runs to the end and it's done.
- **Idempotent**: re-running overwrites with the current copy — safe to re-run any time after a
  skill update, with no duplicates or leftovers.
- **Target directory**: defaults to `~/.workbuddy/skills/myterminal-onboarding/` (other detected
  agents get a copy too).
- **Works immediately**: no restart needed — type `/myterminal-onboarding` in the agent to start.
- **Non-interactive**: `node <myterminal-path>/skills/myterminal-onboarding/scripts/install.mjs --yes`
  installs directly; `--target claude` installs to one agent only.
- **Uninstall**: delete `~/.workbuddy/skills/myterminal-onboarding`.

No checkout yet? The repo ships a one-line remote installer (downloads the skill folder and runs the
same install.mjs above). macOS / Linux:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/main/scripts/install-skill.sh)"
```

Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/main/scripts/install-skill.ps1 | iex"
```

This follows the same design philosophy as reference skills (mattpocock/skills): a skill is a
folder an agent loads, not a package to register. (Reference skills use `npx skills add` to copy
from a registry; this installer does the same copy, but fully locally — nothing is published.)

# MyTerminal Onboarding

Get a user from "nothing installed" to "MyTerminal running with a working subagent LLM":

- **Prerequisites** — bun >= 1.3.0 (hard requirement, the build needs it)
- **The app** — clone + `bun install` + `bun run build`
- **Base config** — the first-run setup screen, which mints the connector credentials
- **Subagent LLM** — a user decision: configure (base URL + model + API key written into
  `config.json`) or skip, with the impact of skipping stated plainly
- **L3 local model** — an optional install decision with a size- and machine-based
  recommendation
- **Connectivity** — a keyless probe of the endpoint, never touching the key

This is a prompt-driven skill, not a deterministic script. Explore, present what you found,
confirm with the user one decision at a time, then write.

Do all the work you are able to do. Hand the user only the steps a script genuinely cannot
perform, and hand them one at a time with the exact command to run.

**Language.** Match the user's language: from here on, respond in whatever language the user is
using. If the user only invokes the skill by name with no language signal, default to English
(the skill's own text is English).

## Non-negotiables

Read these before doing anything. Violating one of them breaks the user's machine or lies to them.

1. **One protocol, no provider picker.** MyTerminal speaks a single Anthropic-compatible
   protocol — the `provider` concept was removed (ADR-0045). You fill three things: an
   **endpoint** (base URL), a **model** id, and an **API key** — all three are required by the
   app. There is no provider selection; do not pretend a config field enables a specific vendor.
   The app only reads `baseUrl` + `model` + `apiKey`.
2. **The API key lives in `config.json` — and never leaves it.** The app requires the key in
   `subagent.apiKey` (three-required contract). It must be provided via stdin (`--key -`), never
   pasted on a command line; the script writes it at `0600` with a backup. The value must never
   appear in any output (dry-run drafts, echoes, reports) and never in any outbound call — the
   connectivity probe is keyless by design. If you ever see the key in an output, that is a bug;
   stop and re-check.
3. **Never hand-write a fresh `config.json`.** A base config carries randomly generated
   `connectorKey` / `actionsToken`. A partial file makes MyTerminal throw on startup *and* locks
   the user out of the setup screen. If `--write-config` refuses, that refusal is correct —
   follow the guidance it prints instead of working around it.
4. **Order matters.** bun → build → **first run** → (decision: configure the subagent or skip it) →
   verify connectivity. Never write the subagent config before the user has completed the
   first-run setup screen — and never write it unless the user chose to configure it.
5. **Read-only until told otherwise.** `node scripts/onboard.mjs` with no flags writes nothing.
   Use `--dry-run` when you want to show the user what a write would do.

## Process

### 1. Explore

Before running anything that scans the machine, tell the user: **"I'm now doing a read-only
check of this machine's disk and memory — nothing is modified, deleted or written."** Then run
the detector. It writes nothing:

```bash
node scripts/onboard.mjs --json
```

The JSON tells you everything you need:

| Field | What it decides |
| --- | --- |
| `machine.freeDiskBytes` / `machine.totalMemoryBytes` | Read-only machine facts (disk/memory) |
| `bun.satisfiesMinimum` | Whether the build can proceed at all |
| `myterminal.installed` / `.built` | Whether to clone / build, and where it already lives |
| `config.exists` / `config.writability` | Whether the first-run setup screen still has to happen |
| `config.subagent` | `baseUrl` / `model` / `apiKeySet` (boolean only — the key value is never read) |
| `l3.recommend` | Deterministic install recommendation for the L3 local model (computed from the machine facts, always with a reason) |
| `l3.modelPresent` | Whether the local model file already sits in the checkout's `models/` dir |

Do not guess any of this from the filesystem yourself; the report already resolved
`MYTERMINAL_CONFIG_DIR` / `XDG_CONFIG_HOME` exactly the way the app does.

### 2. Present findings and ask

Summarise what is present and what is missing in a few lines. Then take the decisions in order —
one decision, one answer, then the next. Lead each with the recommended answer so the user can
accept it in a single word. Skip any decision that exploration already settled.

**Decision A — Endpoint & model** (only relevant if the user chooses "configure" at Stage 4;
otherwise skip it entirely). Skip if `config.subagent.model` already exists and the user has
not asked to change it; just confirm you are keeping it. Lead with the recommended endpoint +
model in the table below. Recommend Anthropic native (`https://api.anthropic.com` +
`claude-3-5-sonnet-20241022`) for a fresh install, or a Chinese gateway if the user is in China.
Present the options honestly:

| Endpoint (base URL) | Recommended model | Notes |
| --- | --- | --- |
| `https://api.anthropic.com` | `claude-3-5-sonnet-20241022` | Anthropic native |
| Chinese gateways (Moonshot / Qwen / …) | vendor model id | use the gateway's `ANTHROPIC_BASE_URL`; the base URL already carries the vendor |

The base URL is the vendor's Anthropic-compatible base — **without** `/v1` and **without**
`/messages`; the app appends `/v1/messages` itself.

If `config.subagent.apiKeySet` is already `true`, you only need to confirm the endpoint/model —
the key is in place. If the user names a model or endpoint outside the table, apply
Non-negotiable 1: offer the closest supported alternative (a different Anthropic-compatible
endpoint or model).

**Decision B — Install location.** Skip if `myterminal.installed` is true; say where it was found.
Otherwise recommend `~/myterminal` and accept any path.

### 3. Confirm and edit (only the "configure" branch of Stage 4)

Show a draft before writing anything:

- The `subagent` block that will be merged into `config.json` — use
  [subagent-config.template.json](./templates/subagent-config.template.json) as the shape, and
  show it filled in with the chosen endpoint and model. Point out that everything else in the
  file is preserved. The key appears in the draft only as a redacted placeholder — never as its
  real value.
- The three optional-decision inputs: endpoint, model, and (if the user wants it) a fallback
  model.

`node scripts/onboard.mjs --write-config --base-url <url> --model <m> --key - --dry-run` prints
the exact merged file (with the key redacted) without touching disk. Prefer showing that over
describing it.

Let the user edit before you write.

### 4. Write

Work through the stages in this order. Stop at the first one that needs the user, hand them the
single command, and wait.

**Stage 1 — bun.** If `bun.satisfiesMinimum` is false, this is a hard stop. Give them the one line:

```bash
curl -fsSL https://bun.sh/install | bash
```

On native Windows (PowerShell), the official installer is:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

(In WSL, the `curl | bash` form works normally.) Either way, have them reopen the shell and
re-run the detector afterwards. Do not attempt the build without bun.

**Stage 2 — Install.** You can do this one:

```bash
node scripts/onboard.mjs --install --install-dir <path>
```

Clones (depth 1), runs `bun install`, and builds only when `dist/cli.js` is missing. Safe to
re-run — it skips whatever is already done.

**Stage 3 — First run.** *You cannot do this one.* The setup screen is interactive and it is what
mints the connector credentials. Hand the user:

```bash
cd <install-dir> && bun run dev
```

The first-run screen asks for **all eight** of these (fill every one — leaving any blank makes
MyTerminal reject the config on startup):

| Field | What to put |
| --- | --- |
| `workspaceDir` | a directory MyTerminal stores projects & state in |
| `host` | usually `127.0.0.1` |
| `port` | a free port |
| `publicBaseUrl` | publicly reachable base URL (connector callbacks use it) |
| `connectorKey` | **leave to the screen** — it generates a 24+ char secret |
| `actionsToken` | **leave to the screen** — it generates a 24+ char token |
| `maxOutputChars` | max characters per command output |
| `commandTimeoutSec` | command timeout in seconds |

Success looks like: the screen writes `config.json` with `schemaVersion: 1` and all eight fields
present, then you quit. **Verify before moving on** — re-run `node scripts/onboard.mjs --json` and
check that `config.writability.ok` is now `true`. If it is not, read the `guidance` field aloud
rather than improvising; do not hand-write a config.json.

**Stage 4 — Subagent config (a decision; the same decision pattern applies to the L3
local-model stage).** The subagent
is the delegated LLM the app calls for subagent work. Whether to configure it is the user's
choice — you report the facts, ask once, and both branches move on.

Facts: the subagent is the app's delegated model over an Anthropic-compatible endpoint; it needs
exactly three things — endpoint (base URL), model, and API key (the app's three-required
contract, ADR-0045).

Ask one decision: **configure the subagent, or skip it?**

- **Configure** — you do this one, with the user's key:
  [the write command below].
- **Skip** — tell the user the impact, then move on (nothing is written): subagent delegation
  will be unavailable — `subagent_start` / `subagent_status` / `subagent_abort` and skill fork
  report "needs `subagent.apiKey` / `baseUrl` / `model` to be configured". The main conversation,
  tool shaping, Actions, and L3 are unaffected. They can configure it later by re-running this
  stage.

If the user chooses **configure**, here is the write:

```bash
printf '%s' '<KEY>' | node scripts/onboard.mjs --write-config --base-url <url> --model <m> [--fallback-model <f>] --key -
```

On native Windows (PowerShell), the same stdin pipe looks like this — the `|` works in
PowerShell too:

```powershell
'<KEY>' | node scripts/onboard.mjs --write-config --base-url <url> --model <m> [--fallback-model <f>] --key -
```

(If you are in WSL, the first form — `printf '%s' '<KEY>' |` — reads more naturally, and
the skill behaves identically there: same script, same probe, same write path.)

The user fetches the key from their model provider's console themselves. The key is piped via
stdin so it never reaches shell history. The script merges into the existing file, preserves
every other setting, deletes any leftover `provider` field (the app silently ignores the block
if one is present), backs the file up first, and keeps `0600` permissions. It echoes the base URL
and model and reports `apiKeySet` — never the key itself. If it refuses, see Non-negotiable 3.

`--fallback-model <f>` is optional and writes `subagent.fallbackModel` (types.ts:222, the 529
overload-degradation model). Omit to leave it unset; the value is passed through verbatim.

After the write succeeds, the script prints the optional subagent fields (defaults and ranges)
that it deliberately does *not* write — the app applies its own defaults for them
(`maxTurns`/`timeoutSec`/`maxParallel`/`contextWindow`/`maxOutput`/`compactThreshold`, see
`src/config.ts applySubagentDefaults`). Relay that list to the user: these are the knobs they can
tune later by editing the `subagent` block in `config.json` directly.

Then verify connectivity — keyless, no credentials are ever sent:

```bash
node scripts/onboard.mjs --probe [--base-url <url>]
```

Expect `✓ REACHABLE` with an honest note that this validates connectivity only — a 401/403 from
a real endpoint is the expected, healthy answer. Report the result verbatim to the user,
including the "connectivity only" caveat.

**Stage 5 — L3 local model (a decision).** The L3 local model is a small on-device model
(Qwen3.5-2B-Q4_K_M, GGUF, about 1.2 GB) that shapes the small, noisy outputs of a few tools
on the machine itself. It is not the main model and not the subagent model — those stay
cloud-side. It is fail-open: if it is missing, those few tools return their raw output
unshaped, and everything else keeps working.

The facts are already in the probe report — report them, do not re-judge:
`l3.modelPresent` (whether the model file already sits in the checkout's `models/` dir) and
`l3.recommend` (the deterministic verdict, always with a reason, computed from the machine's
disk and memory). If you re-run the probe here, declare the read-only scan first with the
Stage 1 wording ("I'm now doing a read-only check of this machine's disk and memory — nothing
is modified, deleted or written.").

If `l3.modelPresent` is `true`, the model is already installed — state that and move on to
Stage 6. Otherwise ask one decision, presenting the three answers in this order:

1. **Recommended** — relay the probe's verdict (`l3.recommend.verdict`) with its reasons
   (e.g. "install: disk 335.9 GB ≥ 2 GB and memory 32.0 GB ≥ 8 GB — the local model fits").
   The user may override it.
2. **Skip** — impact: the few tools that shape small dirty outputs locally keep returning
   them unshaped (fail-open); nothing else is affected. Nothing is downloaded.
3. **Install** — you run the app's own fetch CLI (idempotent, sha256-pinned, concurrency-safe
   via `.part`/`.lock` — never re-implement downloads):

```bash
cd <install-dir> && bun run dist/cli.js l3-model fetch
```

The model lands in `<install-dir>/models/` (git-ignored). If the file already exists with the
matching checksum, the command reports `ready` and downloads nothing.

### 6. Done

Ask the user whether to start MyTerminal now or later. If now, verify the service is
actually up (not just "started without crashing"):

```bash
cd <install-dir> && bun start
node scripts/onboard.mjs --healthcheck     # expect: ✓ PASS  MyTerminal is healthy at http://127.0.0.1:3210/health
```

The `--healthcheck` makes a real `GET /health` call and requires `200 + product:'myterminal'`
(matches the app's own health contract in `src/server.ts:549`). If it reports `✗ FAIL`, the service
isn't listening — usually a wrong port or a crashed `bun start`; re-check before telling them it works.
Custom host/port: `node scripts/onboard.mjs --healthcheck --host <h> --port <p>`.

There is no warm-up verification in this skill: warm-up runs automatically when the system
starts, and the keep-alive lifecycle is out of scope.

Mention that they can change endpoint or model later by re-running
`node scripts/onboard.mjs --write-config --base-url <url> --model <m> --key -` (the key can be
omitted when the config already has one), and that the key lives in `config.json` under
`subagent.apiKey` if they ever need to rotate it (re-write with a new key via stdin, or edit the
file — it is `0600`).

### 7. Keep the copy current (self-check)

This skill is a *copy* of the one in the MyTerminal repo. A stale copy won't error at import —
it just lacks a flag you expect, or still carries the retired provider machinery. After install
(or any time you suspect drift), run the built-in self-test:

```bash
node scripts/onboard.mjs --self-test    # expect: SELF-TEST PASSED: N checks OK
```

It checks that every critical export and CLI flag (`--write-config`, `--base-url`, `--model`,
`--fallback-model`, `--probe`, `--healthcheck`, `--repair`) is present — no repo, no network —
and that the retired API (`provider` family, shell-profile exports) is *gone*. Non-zero exit
means the copy is stale or pre-ADR-0053; re-sync it from the MyTerminal repo.

## Reference

This skill is installed into an agent's skills directory, **not** into the MyTerminal repo, so
none of the paths below are relative to this file. They are paths *inside the user's MyTerminal
checkout* — read them only once you know where that checkout is (the detector reports it as
`myterminal.installDir`).

| Path in the checkout | What it settles |
| --- | --- |
| `docs/SUBAGENT_SETUP.md` / `docs/SUBAGENT_SETUP.zh-CN.md` | The full manual setup document — endpoint/model/key fields, every config field, troubleshooting |
| `src/subagent/llm-adapter.ts` | `createAdapter` — the single Anthropic-compatible adapter; reads `apiKey`/`baseUrl` from settings, appends `/v1/messages` |
| `src/config.ts` | `settingsPath`, `createDefaultSettings`, `validateSettings`, `applySubagentDefaults` — the three-required contract and the optional-field defaults |
| `src/types.ts` | `SubagentSettings` — the authoritative field list (no provider enum) |
| `src/l3/registry.ts` | `DEFAULT_L3_MODEL_PATH` — the local model's file name under `<installRoot>/models/` |
| `src/l3/model-fetch.ts` | The `l3-model fetch` CLI (Stage 5) — idempotent download, sha256-pinned, `.part`/`.lock` concurrency, atomic land |
| `test/adr43-onboarding-skill.test.mjs` | The locks on this skill's own logic; read it if you suspect a behaviour changed |
| `test/issue-W302-fetch.test.mjs` | The locks on the fetch CLI — idempotency, checksum, atomic land (AC1–AC8) |

If the user has no checkout yet, the online copy of the setup document is at
<https://github.com/epslkslsksndnsjs-lab/myterminal/blob/main/docs/SUBAGENT_SETUP.md>.

The design rationale for this skill lives in ADR-0053
(`docs/adr/0053-onboarding-skill-adr0045-migration-l3-install.md`, which supersedes ADR-0043).
That directory is git-ignored, so it may be absent from a fresh clone — do not treat a missing
file there as an error.
