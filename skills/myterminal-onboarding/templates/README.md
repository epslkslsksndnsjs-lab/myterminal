# Templates

## `subagent-config.template.json`

This is a **fragment**, not a config file. It is the shape of the `subagent` block that lives
*inside* `~/.config/myterminal/config.json`, alongside `schemaVersion`, `workspaceDir`,
`connectorKey`, `actionsToken` and the rest.

**Do not copy it to `config.json`.** A config file containing only this block makes MyTerminal
throw on startup and locks the user out of the first-run setup screen, because the connector
credentials would be missing. Let `node scripts/onboard.mjs --write-config` do the merge — it refuses
to write when the base config is absent or incomplete, which is the behaviour you want.

Field meanings and valid ranges are documented in `docs/SUBAGENT_SETUP.md` inside the MyTerminal
checkout. The defaults here match `createDefaultSettings` in `src/config.ts`.
