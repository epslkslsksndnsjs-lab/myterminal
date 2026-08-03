# myterminal-onboarding

An agent skill that installs [MyTerminal](https://github.com/epslkslsksndnsjs-lab/myterminal) on a
machine and configures its subagent LLM — provider, model and API key — one step at a time.

Give this skill to your coding agent (Claude Code, WorkBuddy, Cursor, Codex, ...) and it will do
everything a script is allowed to do, and hand you the exact command for the few things it is not.

## Install

```bash
./install.sh                      # -> ~/.workbuddy/skills, plus the myterminal-onboard command
./install.sh --target claude      # -> ~/.claude/skills
./install.sh --all                # -> every agent skills directory found on this machine
./install.sh --dry-run            # show what would happen, change nothing
```

Windows (PowerShell):

```powershell
.\install.ps1
```

The installer also puts a `myterminal-onboard` command in `~/.local/bin` (a `.cmd` shim on
Windows), so the trigger is identical across agents. If that directory is not on your `PATH`, the
installer tells you what to add.

## Use

```bash
myterminal-onboard
```

That is the whole trigger. It prints an environment report and **writes nothing**. Show the output
to your agent — the skill takes it from there.

Machine-readable version for agents:

```bash
myterminal-onboard --json
```

## What it automates, and what it cannot

| Step | Who does it |
| --- | --- |
| Detect OS, shell, bun, existing install, existing config | script |
| Install bun | **you** — one command, printed for you |
| Clone + `bun install` + `bun run build` | script (`--install`) |
| First-run setup screen | **you** — it is interactive, and it mints the connector credentials |
| Write `subagent` provider/model into `config.json` | script (`--write-config`) |
| Fetch an API key from the provider console | **you** |
| Put the key in your shell profile | script (`--key - --write-profile`) |
| Restart the terminal | **you** |

## Honest limits

- **Five providers, no more:** `openai`, `anthropic`, `deepseek`, `glm`, `qwen`. The list is
  compiled into `createAdapter`. Gemini, Mistral, Ollama, OpenRouter, llama.cpp and every other
  "OpenAI-compatible" endpoint need a code change — a new adapter subclass plus a factory case.
  There is no `baseUrl` setting that would let you point an existing provider elsewhere.
- **bun >= 1.3.0 is mandatory.** MyTerminal builds with bun; there is no npm fallback.
- **The script never invents a `config.json`.** The base config carries randomly generated
  connector credentials. Writing a partial file would make MyTerminal throw on startup *and* lock
  you out of the setup screen, so the script refuses and tells you to run `bun run dev` once.
- **The API key never lands in `config.json`.** Environment variables only. Key-like fields are
  stripped during the merge.
- **Native Windows gets manual steps.** The script prints `setx` instructions rather than editing
  your environment. WSL is the smoother path.

## Safety

- No flags = read-only. `--dry-run` on any write command shows the result without touching disk.
- Config and profile writes are backed up to `<file>.myterminal-backup` first.
- Profile edits live in a marked block and are idempotent — re-running with the same key is a
  no-op, a new key replaces the old line in place instead of stacking a second one.
- `config.json` keeps `0600` permissions, matching what the app itself writes.
- Prefer `--key -` (stdin) over `--key <value>` so the key never enters shell history.

## Layout

```
myterminal-onboarding/
  SKILL.md                              the agent-facing instructions
  install.sh / install.ps1              installer + myterminal-onboard command
  scripts/onboard.mjs                   the command itself
  templates/subagent-config.template.json   shape of the subagent block (a fragment, not a config)
```

Behaviour is locked by `test/adr43-onboarding-skill.test.mjs` in the MyTerminal repo (51 tests
covering the provider list, config-path resolution, shell detection, config merge, profile
idempotency and the symlink entrypoint). Design rationale lives in the maintainer's ADR-0043,
which is git-ignored and may be absent from a fresh clone.
