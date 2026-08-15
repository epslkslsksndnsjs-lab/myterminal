# myterminal-onboarding

A **self-contained install / verification tool** (agent skill): installs MyTerminal on a machine
and steps through configuring its subagent LLM — endpoint (base URL), model, and API key.

It is a standalone **test / verification tool**, independent of the MyTerminal system code
(`src/` etc.), and can be deleted on its own without affecting MyTerminal itself. Removing the
whole skill directory never forces changes to any `src/` file.

## Usage

**1. Install the skill** (it's just a folder — copy it into the agent's skills directory, or use
the one-command installer):

```bash
node skills/myterminal-onboarding/scripts/install.mjs
# or manually:
cp -R skills/myterminal-onboarding ~/.workbuddy/skills/myterminal-onboarding
```

**2. Run onboarding, or self-check that this skill copy is complete:**

```bash
node scripts/onboard.mjs --json          # read-only detection report, writes nothing
node scripts/onboard.mjs --self-test     # self-check: every expected export/flag is present
```

Other commands (write config / keyless probe / health check / repair broken config) — see
`SKILL.md`.

## What the script does automatically vs what you do

| Step | Who |
| --- | --- |
| Detect OS / bun / existing install / existing config / machine disk & memory | script |
| Install bun | **you** (one command, printed by the script) |
| clone + `bun install` + `bun run build` | script (`--install`) |
| First-run setup screen | **you** (interactive; it mints the connector credentials) |
| Write subagent baseUrl/model/apiKey into `config.json` | script (`--write-config`, key via stdin) |
| Fetch the API key from the model provider's console | **you** |
| Keyless connectivity probe of the endpoint | script (`--probe`) |
| Start the service and verify it answers | you start, script verifies (`--healthcheck`) |

## Honest boundaries

- **Single Anthropic-compatible protocol, no provider picker**: fill endpoint (base URL) + model
  + key — the app requires all three (three-required contract, ADR-0045). The `provider` concept
  is gone; a leftover `provider` field makes the app silently ignore the whole subagent block.
- **bun >= 1.3.0 is a hard prerequisite**, no npm fallback.
- **The script never fabricates `config.json`**: the base config carries randomly generated
  connector credentials; a partial file makes MyTerminal crash on startup, so the script refuses
  and asks you to run `bun run dev` once first.
- **The API key lives in `config.json`** (`subagent.apiKey`, the app's contract), provided via
  stdin, written at `0600` with a backup. Its value never appears in any output.
- **No outbound call ever carries the key**: the connectivity probe is keyless and says so
  honestly (it validates connectivity only, not key/model correctness).

## Security

- No flags = read-only. `--dry-run` shows results on any write command without touching disk.
- Writes back up first as `<file>.myterminal-backup`.
- `config.json` stays `0600`.
- Prefer `--key -` (stdin) over putting the key on a command line — never in shell history.
- The shell-profile export mechanism was retired (ADR-0053 D5): no profile is ever edited, and
  the skill no longer has any platform-specific branches.

## Structure

```
myterminal-onboarding/
  SKILL.md                                  instructions for the agent
  scripts/onboard.mjs                       production script (install/configure logic, no test code)
  scripts/self-test.mjs                     ⚠ the only test code: --self-test, in its own file
  scripts/install.mjs                       one-command installer
  templates/subagent-config.template.json   subagent block shape (fragment, not a full config)
```

> The skill depends on no `src/` code (`onboard.mjs` and `self-test.mjs` never read the main
> repo's source). The old provider-list parity guard (`check-provider-sync.mjs`) was removed with
> ADR-0045 along with the provider concept itself.
