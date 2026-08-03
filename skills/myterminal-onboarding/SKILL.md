---
name: myterminal-onboarding
description: Install MyTerminal on this machine and configure its subagent LLM provider, model and API key, step by step. Run once per machine.
license: MIT
disable: false
---

> **Invocation:** User-invoked only. Do not auto-trigger this skill; run it only when the user
> explicitly requests it by name (`myterminal-onboarding`), or asks to install or configure
> MyTerminal (or its subagent LLM). When triggered, run `node scripts/onboard.mjs` from this
> skill's directory.

# MyTerminal Onboarding

Get a user from "nothing installed" to "MyTerminal running with a working subagent LLM":

- **Prerequisites** — bun >= 1.3.0 (hard requirement, the build needs it)
- **The app** — clone + `bun install` + `bun run build`
- **Base config** — the first-run setup screen, which mints the connector credentials
- **Subagent LLM** — provider + model written into `config.json`
- **API key** — exported from the shell profile, never stored in a file MyTerminal reads

This is a prompt-driven skill, not a deterministic script. Explore, present what you found,
confirm with the user one decision at a time, then write.

Do all the work you are able to do. Hand the user only the steps a script genuinely cannot
perform, and hand them one at a time with the exact command to run.

## Non-negotiables

Read these before doing anything. Violating one of them breaks the user's machine or lies to them.

1. **Only five providers exist.** `openai`, `anthropic`, `deepseek`, `glm`, `qwen`. This is a
   closed list compiled into `createAdapter` (`src/subagent/llm-adapter.ts`). If the user asks
   for Gemini, Mistral, Ollama, OpenRouter, llama.cpp or anything else — including
   "OpenAI-compatible" endpoints — say plainly that it is not supported by this build and that
   adding it requires a code change (a new adapter subclass plus a case in the factory).
   Do not pretend a config field can enable it. There is no `baseUrl` setting.
2. **Never write the API key into `config.json`.** Keys are read from environment variables only.
   The script strips key-like fields on merge; do not add them back by hand.
3. **Never hand-write a fresh `config.json`.** A base config carries randomly generated
   `connectorKey` / `actionsToken`. A partial file makes MyTerminal throw on startup *and* locks
   the user out of the setup screen. If `--write-config` refuses, that refusal is correct —
   follow the guidance it prints instead of working around it.
4. **Order matters.** bun → build → **first run** → write subagent config → API key. Never write
   the subagent config before the user has completed the first-run setup screen.
5. **Read-only until told otherwise.** `node scripts/onboard.mjs` with no flags writes nothing.
   Use `--dry-run` when you want to show the user what a write would do.

## Process

### 1. Explore

Run the detector and read the report. It writes nothing:

```bash
node scripts/onboard.mjs --json
```

The JSON tells you everything you need:

| Field | What it decides |
| --- | --- |
| `bun.satisfiesMinimum` | Whether the build can proceed at all |
| `myterminal.installed` / `.built` | Whether to clone / build, and where it already lives |
| `config.exists` / `config.writability` | Whether the first-run setup screen still has to happen |
| `config.subagent` | The current provider/model, if any — use it as the default |
| `apiKeysPresent` | Booleans only. Which keys are already in this shell |
| `shell.profilePath` / `shell.manual` | Where the export line goes, or that this is native Windows |

Do not guess any of this from the filesystem yourself; the report already resolved
`MYTERMINAL_CONFIG_DIR` / `XDG_CONFIG_HOME` exactly the way the app does.

### 2. Present findings and ask

Summarise what is present and what is missing in a few lines. Then take the decisions in order —
one decision, one answer, then the next. Lead each with the recommended answer so the user can
accept it in a single word. Skip any decision that exploration already settled.

**Decision A — Provider.** Skip if `config.subagent.provider` already exists and the user has not
asked to change it; just confirm you are keeping it.

Recommend `openai` for a fresh install. Present the full list honestly:

| Provider | Env var | Recommended model | Console |
| --- | --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | `gpt-4o` | platform.openai.com/api-keys |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-3-5-sonnet-20241022` | console.anthropic.com |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat` | platform.deepseek.com |
| `glm` | `GLM_API_KEY` | `glm-4` (`glm-4-flash` is the cheap tier) | open.bigmodel.cn |
| `qwen` | `DASHSCOPE_API_KEY` | `qwen-max` | dashscope.console.aliyun.com |

If `apiKeysPresent` already shows a key for one of them, lead with that provider — the user
clearly has an account there.

If the user names anything outside the table, apply Non-negotiable 1. Offer the closest
supported alternative and let them choose from the five.

**Decision B — Model.** Recommend the model from the table for the chosen provider. The script
**enforces** model↔provider consistency: a model that clearly belongs to another provider
(e.g. `qwen3.7-plus` under `openai`) is rejected with an error, not silently written. Unknown
prefixes are allowed but flagged with a warning. If the user names a model from another provider's
row, switch `--provider` to match it.

**Decision C — Install location.** Skip if `myterminal.installed` is true; say where it was found.
Otherwise recommend `~/myterminal` and accept any path.

### 3. Confirm and edit

Show a draft before writing anything:

- The `subagent` block that will be merged into `config.json` — use
  [subagent-config.template.json](./templates/subagent-config.template.json) as the shape, and
  show it filled in with the chosen provider and model. Point out that everything else in the
  file is preserved and that no key appears in it.
- The exact `export` line that will go into their shell profile, with the key redacted.

`node scripts/onboard.mjs --write-config --provider <p> --model <m> --dry-run` prints the exact merged
file without touching disk. Prefer showing that over describing it.

Let the user edit before you write.

### 4. Write

Work through the stages in this order. Stop at the first one that needs the user, hand them the
single command, and wait.

**Stage 1 — bun.** If `bun.satisfiesMinimum` is false, this is a hard stop. Give them the one line:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then have them reopen the shell and re-run the detector. Do not attempt the build without bun.

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

**Stage 4 — Subagent config.** You can do this one:

```bash
node scripts/onboard.mjs --write-config --provider <p> --model <m>
```

It merges into the existing file, preserves every other setting, backs the file up first, and
keeps `0600` permissions. If it refuses, see Non-negotiable 3.

**Stage 5 — API key.** The user has to fetch the key from the provider console themselves —
send them to the URL from the table. Once they paste it to you, prefer stdin so the key never
reaches shell history:

```bash
printf '%s' '<KEY>' | node scripts/onboard.mjs --key - --provider <p> --write-profile
```

This appends a marked block to their shell profile, backs it up, and is idempotent — running it
again with the same key is a no-op, and running it with a new key replaces the old line in place
rather than stacking a second one.

On native Windows the script refuses to touch the environment and prints the `setx` steps
instead. Read them to the user; do not try to work around it. WSL is the smoother path and worth
suggesting.

If the user would rather paste the line themselves, drop `--write-profile` and the script just
prints the line for their profile.

### 5. Done

Tell them to restart the terminal (or `source` the profile), then verify:

```bash
echo $<ENV_VAR>          # should print the key
cd <install-dir> && bun start
# confirm the service is actually up (not just "started without crashing"):
node scripts/onboard.mjs --healthcheck     # expect: ✓ PASS  MyTerminal is healthy at http://127.0.0.1:3210/health
```

The `--healthcheck` makes a real `GET /health` call and requires `200 + product:'myterminal'`
(matches the app's own health contract in `src/server.ts:549`). If it reports `✗ FAIL`, the service
isn't listening — usually a wrong port or a crashed `bun start`; re-check before telling them it works.
Custom host/port: `node scripts/onboard.mjs --healthcheck --host <h> --port <p>`.

Mention that they can change provider or model later by re-running
`node scripts/onboard.mjs --write-config`, and that the key lives in their shell profile inside the
`# >>> myterminal-onboarding >>>` block if they ever need to rotate it.

## Reference

This skill is installed into an agent's skills directory, **not** into the MyTerminal repo, so
none of the paths below are relative to this file. They are paths *inside the user's MyTerminal
checkout* — read them only once you know where that checkout is (the detector reports it as
`myterminal.installDir`).

| Path in the checkout | What it settles |
| --- | --- |
| `docs/SUBAGENT_SETUP.md` / `docs/SUBAGENT_SETUP.zh-CN.md` | The full manual setup document — provider table, every config field, troubleshooting |
| `src/subagent/llm-adapter.ts` | `createAdapter` — the closed provider list, and the env var each one reads |
| `src/config.ts` | `settingsPath`, `createDefaultSettings`, `validateSettings` — why a partial config is fatal |
| `src/types.ts` | `SUBAGENT_PROVIDERS`, `SubagentSettings` — the authoritative field list |
| `test/adr43-onboarding-skill.test.mjs` | The locks on this skill's own logic; read it if you suspect a behaviour changed |

If the user has no checkout yet, the online copy of the setup document is at
<https://github.com/epslkslsksndnsjs-lab/myterminal/blob/main/docs/SUBAGENT_SETUP.md>.

The design rationale for this skill lives in the maintainer's ADR-0043
(`docs/adr/0043-node scripts/onboard.mjsing-skill.md`). That directory is git-ignored, so it may be
absent from a fresh clone — do not treat a missing file there as an error.
