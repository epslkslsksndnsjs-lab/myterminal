# MyTerminal

[中文](README.zh-CN.md) · [Actions tutorial](docs/ACTIONS_SETUP.md) · [GPT instructions](docs/GPT_INSTRUCTIONS.md) · [Prompt playbook](docs/PROMPT_PLAYBOOK.md) · [Privacy](docs/PRIVACY.md)

MyTerminal gives **ChatGPT's normal chat mode a controlled way to work on your local computer**. After you connect MyTerminal through a custom GPT Action or a ChatGPT App, a regular ChatGPT conversation can inspect and edit the authorized local project, run bounded tools, coordinate multiple work sessions, and report progress while you retain control in a local TUI. MyTerminal is the bridge between ChatGPT chat and your computer; it is not a replacement chat client.

MyTerminal 0.1.1 provides that bridge through an auditable, inheritable work-session layer. It supports ChatGPT **Actions** and **Apps (MCP)**, multi-session collaboration, durable messages, declarative extensions, Git-style live diff tracking, and a full-window bilingual OpenTUI interface.

![MyTerminal session hierarchy](docs/assets/tui/sessions-en.svg)

## Install and start

### First installation

You do not need Git, Node.js, Bun, or another programming environment beforehand. The installers download the standalone `v0.1.1` executable for the current operating system and CPU architecture, verify its SHA-256 checksum, register the global `myterminal` command, and start the TUI. Release installations no longer download a source archive or runtime dependencies.

#### macOS

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.1/scripts/install-macos.sh)"
```

#### Linux

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.1/scripts/install-linux.sh)"
```

#### Windows PowerShell

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.1/scripts/install-windows.ps1 | iex"
```

> [!IMPORTANT]
> **Known Windows limitation:** the supported PowerShell TUI path is keyboard-only compatibility mode. Mouse capture is disabled by default because it can become unresponsive or freeze in Windows PowerShell and PowerShell 7. Use arrows, `PgUp/PgDn`, `Home/End`, `Enter`, and page shortcuts; every page and exact session selector is keyboard-operable. `$env:MYTERMINAL_WINDOWS_TUI_MODE='mouse'` is experimental and should not be used for critical work. Remove the variable to restore the stable 20 FPS main-screen profile.

Remote scripts are convenient but security-sensitive. You can inspect [install-macos.sh](scripts/install-macos.sh), [install-linux.sh](scripts/install-linux.sh), or [install-windows.ps1](scripts/install-windows.ps1) before running them.

For local release candidates, offline assets, or step-by-step checksum verification, use the bilingual [manual installation guide](docs/MANUAL_INSTALL.md).

The first-run TUI configures everything: language, theme, authorized workspace, bind address, public URL, limits, Apps connector key, and Actions token. No `.env` or manual configuration-file editing is required.

### Start it again later

Open a new Terminal, PowerShell, or Command Prompt window and use the global command installed for your user account. The launcher resolves the current executable through a versioned `releases/<version>` directory and an atomic `current` pointer. Users of the GitHub `v1.0.1` source-archive installation, an intermediate development installation, or an earlier binary release may run the `v0.1.1` installer directly for a lossless migration. Settings, credentials, workspaces, sessions, messages, and history are preserved.

```text
myterminal
```

MyTerminal reuses the settings saved through the TUI. If ChatGPT connects through a temporary Quick Tunnel, restart that tunnel separately; its random public URL may change.

### Install from source

If you already have Bun 1.3 or newer:

```bash
git clone https://github.com/epslkslsksndnsjs-lab/myterminal.git
cd myterminal
bun install --frozen-lockfile
bun run dev
```

## Choose a connection

| Connection | Use it when | Endpoint shown by MyTerminal |
| --- | --- | --- |
| GPT Actions | You are building a custom GPT with an OpenAPI Action. | `https://YOUR-HOST/openapi.json` |
| ChatGPT Apps | Your eligible workspace supports custom MCP apps/connectors. | `https://YOUR-HOST/mcp/<hidden-connector-key>` |

A GPT can use Apps or Actions, not both at once. For Actions, follow the complete privacy-safe [English tutorial](docs/ACTIONS_SETUP.md) or [Chinese tutorial](docs/ACTIONS_SETUP.zh-CN.md). It covers HTTPS tunneling, schema import, Bearer authentication, GPT setup, Preview testing, and common error messages.

## Connection-specific tool surfaces

GPT Actions sees exactly three stable facade operations:

- `extension_discover`: learn identity, concrete tools, schemas, and extension registration;
- `extension_call`: invoke a concrete workspace, Git, session, message, or custom tool;
- `extension_register`: validate, upsert, or remove a declarative extension.

The small Actions surface keeps the imported OpenAPI configuration stable while concrete capabilities remain discoverable. Operation IDs use camelCase (`extensionDiscover`, `extensionCall`, `extensionRegister`) but preserve the same meanings.

ChatGPT Apps exposes both the same generic `extension_call` / `extension_register` capabilities and narrow direct MCP tools. The generic facade preserves arbitrary commands, overwriting writes, patches, and custom extensions as first-class product capabilities. Direct tools give common session, read, Git, messaging, polling, and Blob operations smaller schemas without replacing the generic path. Apps can stage UTF-8 or base64 content with `blob_create`; `blob_write_file` creates a missing file, treats an identical existing file as an idempotent success, and rejects an existing file with different content. Overwriting remains available through `extension_call` → `write_file` or `apply_patch`.

### Agent context (AGENT.md)

Create `~/.config/myterminal/AGENT.md` (or `%APPDATA%\myterminal\AGENT.md` on Windows) with user-authored preferences, habits, or cross-project instructions. MyTerminal injects the full content into every `extension_discover` response via the `agentMd` field so each ChatGPT session reads it automatically — analogous to `CLAUDE.md` in Claude Code. The file is optional; when absent, the field is gracefully omitted.

```text
ChatGPT
  └─ extensionCall
       ├─ tool: session_register
       ├─ input: { mode: "root", name: "main" }
       └─ identity: { sessionId, sessionToken }  # after bootstrap
```

Use the supplied [GPT instructions](docs/GPT_INSTRUCTIONS.md) to prevent schema-layer mistakes, and give users the [short prompt playbook](docs/PROMPT_PLAYBOOK.md) instead of long prompts.

## Auditable collaboration

A MyTerminal session is a work context, not a ChatGPT conversation ID.

- New work creates and claims a root with `session_register(mode=root)`.
- Delegation creates multiple direct child sessions with structured task packages; children cannot create grandchildren. Split work by domain, expertise, and parallel workload rather than assigning one large objective wholesale to one child.
- Collaboration is active: sessions may safely complete non-conflicting work for one another and hand off incorporable results through durable messages.
- `session_inherit` uses a one-time claim code for handed-off/released/revoked unfinished work; the same interrupted ChatGPT conversation may reclaim its stale session with the previous sessionToken.
- Completed work is immutable. Continue it with a same-level `session_register(...continuesSessionId)`, never with `session_inherit`.
- Session state has highest priority. The optional enhanced Actions long-task harness is **off by default**, so the core session harness is unchanged. Settings offers `adaptive` (1-3 calls, recommended for normal testing), plus the diagnostic `next-call` and `lookahead-3` modes used by the A/B test. Enhanced modes reject out-of-order calls and return the next call after each confirmed completion. After a mode change, active sessions receive a `requirements_changed` event instructing the model to run discovery again.
- Optional **Non-blocking tasks** are also off by default and independent of the Actions harness. When enabled, ordinary calls exceeding 200ms detach from the request, continue locally, and return a `taskId`; `task_poll` reports progress. Completed responses are held in a bounded, expiring cache. When disabled, calls stay attached until completion or timeout.
- A root cannot complete until every direct child is terminal and every child message/event has been reviewed. A blocked completion returns child timestamps, last activity, recent operations, message timing, and `mustContinue` guidance.
- Messages are durable. AI messages keep the authenticated session identity; messages typed by the TUI owner are explicitly attributed to `user`. Message reads include send/observation timestamps, age, audited operations since send, and a delay/staleness notice.
- Permanent JSONL history stores task packages, checkpoints, messages, state events, and sanitized tool audits.

## TUI owner control plane

The seven full-window pages are Overview, Sessions, Messages, Diff, Extensions, Settings, and Logs.

![MyTerminal overview](docs/assets/tui/overview-en.svg)

- Mouse-wheel scrolling on macOS/Linux and keyboard scrolling on every platform use OpenTUI ScrollBox viewports; Windows compatibility mode does not capture the mouse by default.
- Drag selection is renderer-owned and copies through OSC 52 plus the host clipboard.
- Continuations remain inside one logical session card; delegated children appear as indented directory-style nodes with phase and presence colors.
- Enter opens complete session history or a two-way message conversation.
- Diff shows staged, unstaged, and untracked workspace changes.
- Logs show Apps and Actions calls through one lifecycle model. A call appears immediately with source, tool name, sanitized complete arguments, start time, and `running`; the same logical record is then completed with the sanitized complete result, duration, and `completed`, `failed`, or `timeout`.
- All settings and credential rotation stay inside the TUI. Finite choices use keyboard/mouse selectors; free-text fields replace prefilled content on first typing and support `Ctrl+U` to clear. Hold `V` to reveal credentials; after key repeats stop, they hide within the 450ms fail-closed deadline. Navigation or opening a form hides them immediately.

Input is routed in one order: modal → focused form control → current page → global shortcuts. OpenTUI owns screen lifecycle, mouse decoding when enabled, layout, wrapping, incremental drawing, and terminal restoration; Windows uses the main-screen compatibility profile by default.

## Security and privacy

MyTerminal is local-first and has no project telemetry. The selected workspace is a real read/write security boundary: use a dedicated project, review Diff and Logs, keep credentials masked, and stop public tunnels when not needed.

- Connection credentials live in the operating-system user configuration directory.
- Only session-token hashes are persisted.
- Identity, authorization, claim-code, credential, secret, password, API-key, message-body, content, and sensitive URL-query fields are redacted from persisted argument and result snapshots.
- Only the TUI owner can permanently delete sessions and history.

Read the [privacy notice and deployment template](docs/PRIVACY.md). Public GPTs with Actions need a privacy policy that accurately covers the publisher's own endpoint and data flow.

Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), never through a public issue containing credentials or private source.

## Documentation map

| Document | English | 中文 |
| --- | --- | --- |
| Full GPT Actions setup | [Open](docs/ACTIONS_SETUP.md) | [打开](docs/ACTIONS_SETUP.zh-CN.md) |
| Recommended GPT preset instructions | [Open](docs/GPT_INSTRUCTIONS.md) | [打开](docs/GPT_INSTRUCTIONS.zh-CN.md) |
| Short scenario prompts | [Open](docs/PROMPT_PLAYBOOK.md) | [打开](docs/PROMPT_PLAYBOOK.zh-CN.md) |
| Privacy and deployment template | [Open](docs/PRIVACY.md) | [打开](docs/PRIVACY.zh-CN.md) |
| Manual/offline installation | [Open](docs/MANUAL_INSTALL.md) | [打开](docs/MANUAL_INSTALL.md#中文说明) |
| Architecture and ownership | [Open](docs/architecture.md) | — |

## Development and verification

Requirements: Bun 1.3 or newer.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run dev
```

The test suite covers OpenAPI 3.1, Actions and Apps identity, controller takeover, fixed checkpoint timing, parent/child completion, event ACK, subscriptions, durable history, redaction, migration, deletion, continuation, OpenTUI wheel scrolling, and drag selection.

Headless mode is available only after first-run TUI setup:

```bash
bun run build
bun run start -- --headless
```

## Updates

MyTerminal checks the latest GitHub release when the TUI starts. The Settings tab shows the installed and latest versions; press `U` to install an available release. The updater downloads the precompiled executable and SHA-256 file for the current platform, installs it into a new version directory, and atomically switches the `current` pointer. The old version remains available for rollback. Git source checkouts are never overwritten by one-click update. See the [v0.1.1 release notes](RELEASE_NOTES.md) for migration and future-update details.

Workspace state migration is additive and idempotent: existing target state, legacy global state, `state.migrated`, and the workspace `.myterminal` directory are merged by stable IDs, while session history files are deduplicated and retained.
## Shared ports and workspace routing

Multiple MyTerminal processes may use the same `host:port` when they share the same Apps connector key and Actions token. Each process keeps its own workspace, state, sessions, history, and logs. One member is elected as the public network leader; the other members use private loopback listeners. If the leader exits, a remaining member automatically takes over the public port.

On a shared port, `extension_discover` lists the active workspace IDs. A new root session must pass `workspaceId` in the `session_register` input. Later calls are routed by MyTerminal session identity, and Apps calls may continue through their verified `openai/session` binding. The same workspace cannot be active in two processes. Unrelated programs occupying the port still trigger the normal kill/change/cancel flow. Different ports form independent groups and keep their aggregated logs separate.
### macOS passive-lock protection

The Settings page exposes a macOS-only passive-lock control with three actions: `arm`, `standby`, and `off`. `arm` keeps the display awake, shows a full-screen protection overlay, and sends the system `Control–Command–Q` shortcut on the first keyboard or mouse event. After locking, the helper remains alive in `standby`, releases its power assertion and input monitors, and lets the user operate the Mac normally. The user may later choose `arm` again or `off` to terminate the helper. The installation-global helper is terminated only when the last MyTerminal process exits; closing one workspace runtime does not interrupt other active processes.

The feature currently supports macOS only. It requires Accessibility permission for the terminal or host process that launched MyTerminal (for example Terminal or iTerm2). Some macOS versions may also list `MyTerminal Passive Lock`. The permission dialog and Settings page state exactly which permission is required and where to grant it.

### Cluster updates

Installing an update never terminates running TUI processes. Existing Apps/Actions traffic continues on the currently loaded code, and workspace state remains on disk. Restart members one at a time to adopt the installed release; restart the current network leader last to minimize the brief handover window. Members with different application versions may coexist only when they use the same cluster protocol version. An incompatible protocol is rejected before the process joins, preventing mixed-version state or routing corruption. A pre-cluster release already occupying the port is treated as a normal port conflict and cannot be joined; use another port for testing or restart it on the cluster-capable release first.
