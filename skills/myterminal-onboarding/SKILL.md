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

这是纯文件夹技能，无需 `npm install`、无构建步骤。一条命令即可安装——运行后会出现一个极简安装向导，
自动检测已装的 Agent（WorkBuddy / Claude Code / Cursor），按 **Enter** 即全部装好，带进度条：

```bash
# 一条命令，从任意目录直接运行（把路径换成你机器上 MyTerminal 的实际位置）
node <myterminal-path>/skills/myterminal-onboarding/scripts/install.mjs
```

> ⚠️ 必须用**绝对路径**（或 `~/...` 这种 home 展开路径）。不要写 `node skills/.../install.mjs` 这种相对路径——
> 相对路径会从你「当前所在目录」找文件，在 `~` 或别处运行时就会 `Cannot find module`。

- **一条命令 + 回车**：无需选择、无方向键、无多余步骤。检测到的 Agent 全部安装，进度条走完即结束。
- **幂等**：重复运行只会用当前副本覆盖，更新技能后随时再跑一次，不会重复或残留。
- **目标目录**：默认装到 `~/.workbuddy/skills/myterminal-onboarding/`（检测到其他 Agent 也会一起装）。
- **立即生效**：装完无需重启，Agent 里输入 `/myterminal-onboarding` 即可开始配置。
- **无交互模式**：`node <myterminal-path>/skills/myterminal-onboarding/scripts/install.mjs --yes` 直接装；`--target claude` 只装指定 Agent。
- **卸载**：删除 `~/.workbuddy/skills/myterminal-onboarding` 即可。

这与参考技能（mattpocock/skills）的设计哲学一致：技能是被 Agent 加载的文件夹，而不是要注册的包。
（参考技能用 `npx skills add` 从 registry 复制；本安装器做同样的复制，但完全本地、无需发布到任何地方。）

# MyTerminal Onboarding

Get a user from "nothing installed" to "MyTerminal running with a working subagent LLM":

- **Prerequisites** — bun >= 1.3.0 (hard requirement, the build needs it)
- **The app** — clone + `bun install` + `bun run build`
- **Base config** — the first-run setup screen, which mints the connector credentials
- **Subagent LLM** — endpoint (base URL) + model + API key written into `config.json`
- **API key** — exported from the shell profile, never stored in a file MyTerminal reads

This is a prompt-driven skill, not a deterministic script. Explore, present what you found,
confirm with the user one decision at a time, then write.

Do all the work you are able to do. Hand the user only the steps a script genuinely cannot
perform, and hand them one at a time with the exact command to run.

## Non-negotiables

Read these before doing anything. Violating one of them breaks the user's machine or lies to them.

1. **One protocol, no provider picker.** MyTerminal now speaks a single Anthropic-compatible
   protocol — ADR-0045 removed the `provider` concept. You fill three things: an **endpoint**
   (base URL), a **model** id, and an **API key**. There is no provider selection; do not pretend
   a config field enables a specific vendor. The app only reads `baseUrl` + `model` + `apiKey`.
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
| `config.subagent` | The current model / endpoint, if any — use it as the default |
| `apiKeysPresent` | Booleans only. Which keys are already in this shell |
| `shell.profilePath` / `shell.manual` | Where the export line goes, or that this is native Windows |

Do not guess any of this from the filesystem yourself; the report already resolved
`MYTERMINAL_CONFIG_DIR` / `XDG_CONFIG_HOME` exactly the way the app does.

### 2. Present findings and ask

Summarise what is present and what is missing in a few lines. Then take the decisions in order —
one decision, one answer, then the next. Lead each with the recommended answer so the user can
accept it in a single word. Skip any decision that exploration already settled.

**Decision A — Endpoint & model.** Skip if `config.subagent.model` already exists and the user has not
asked to change it; just confirm you are keeping it. Lead with the recommended endpoint + model in
the table below. **Note:** the current `onboard.mjs` build still takes a `--provider <p>` flag on
its `--write-config` / `--key` commands — that flag is legacy and inert (the app ignores the
`provider` field; it only reads endpoint + model + key). A later cleanup drops it.

Recommend Anthropic native (`https://api.anthropic.com` + `claude-3-5-sonnet-20241022`) for a fresh install, or a Chinese gateway if the user is in China. Present the options honestly:

| Endpoint (base URL) | Recommended model | Notes |
| --- | --- | --- |
| `https://api.anthropic.com` | `claude-3-5-sonnet-20241022` | Anthropic native |
| Chinese gateways (Moonshot / Qwen / …) | vendor model id | use the gateway's `ANTHROPIC_BASE_URL`; the base URL already carries the vendor |

The API key is read from the environment (see Stage 5); there is no provider field to pick.

If `apiKeysPresent` already shows a key for one of them, lead with that endpoint/model — the user
clearly has an account there.

If the user names a model or endpoint outside the table, apply Non-negotiable 1. Offer the
closest supported alternative (a different Anthropic-compatible endpoint or model).

**Decision B — Model.** Recommend a model for the chosen endpoint (see the table in Decision A).
The script keeps a light model-prefix sanity check; an unknown prefix is allowed with a warning.
If the user names a model that clearly belongs to a different vendor's endpoint, suggest the
matching endpoint instead of a provider flag.

**Decision C — Install location.** Skip if `myterminal.installed` is true; say where it was found.
Otherwise recommend `~/myterminal` and accept any path.

### 3. Confirm and edit

Show a draft before writing anything:

- The `subagent` block that will be merged into `config.json` — use
  [subagent-config.template.json](./templates/subagent-config.template.json) as the shape, and
  show it filled in with the chosen endpoint and model. Point out that everything else in the
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
node scripts/onboard.mjs --write-config --provider <p> --model <m> [--fallback-model <f>]
```

It merges into the existing file, preserves every other setting, backs the file up first, and
keeps `0600` permissions. If it refuses, see Non-negotiable 3.

`--fallback-model <f>` is optional and writes `subagent.fallbackModel` (types.ts:194, the 529
overload-degradation model). Same-provider family recommended. Omit to leave it unset. The value
is passed through verbatim — no provider validation is applied to it (the app doesn't validate it
either), so a typo there fails later at runtime, not at write time.

**Stage 5 — API key.** The user has to fetch the key from their model provider's console themselves —
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

Mention that they can change endpoint or model later by re-running
`node scripts/onboard.mjs --write-config`, and that the key lives in their shell profile inside the
`# >>> myterminal-onboarding >>>` block if they ever need to rotate it.

### 6. Keep the copy current (self-check)

This skill is a *copy* of the one in the MyTerminal repo. A stale copy won't error at import —
it just silently rejects a model the repo now supports, or lacks a flag you expect. After install
(or any time you suspect drift), run the built-in self-test:

```bash
node scripts/onboard.mjs --self-test    # expect: SELF-TEST PASSED: N checks OK
```

It checks that every critical export and CLI flag (`--verify`, `--base-url`, `--healthcheck`,
`--fallback-model`) is present — no repo, no network. Non-zero exit means the copy is stale;
re-sync it from the MyTerminal repo. Repo-level provider-list parity is no longer enforced —
the `scripts/check-provider-sync.mjs` guard was removed with ADR-0045 (the `provider` concept was
deleted). Keep your copy current by re-running `--self-test` and pulling updates from the repo.

## Reference

This skill is installed into an agent's skills directory, **not** into the MyTerminal repo, so
none of the paths below are relative to this file. They are paths *inside the user's MyTerminal
checkout* — read them only once you know where that checkout is (the detector reports it as
`myterminal.installDir`).

| Path in the checkout | What it settles |
| --- | --- |
| `docs/SUBAGENT_SETUP.md` / `docs/SUBAGENT_SETUP.zh-CN.md` | The full manual setup document — endpoint/model/key fields, every config field, troubleshooting |
| `src/subagent/llm-adapter.ts` | `createAdapter` — the single Anthropic-compatible adapter; reads `apiKey`/`baseUrl` from settings |
| `src/config.ts` | `settingsPath`, `createDefaultSettings`, `validateSettings` — why a partial config is fatal |
| `src/types.ts` | `SubagentSettings` — the authoritative field list (single Anthropic entry; no provider enum) |
| `test/adr43-onboarding-skill.test.mjs` | The locks on this skill's own logic; read it if you suspect a behaviour changed |

If the user has no checkout yet, the online copy of the setup document is at
<https://github.com/epslkslsksndnsjs-lab/myterminal/blob/main/docs/SUBAGENT_SETUP.md>.

The design rationale for this skill lives in the maintainer's ADR-0043
(`docs/adr/0043-myterminal-onboarding-skill.md`). That directory is git-ignored, so it may be
absent from a fresh clone — do not treat a missing file there as an error.
