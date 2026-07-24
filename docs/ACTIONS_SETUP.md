# Set up MyTerminal as a GPT Action

[中文](ACTIONS_SETUP.zh-CN.md) · [Recommended GPT instructions](GPT_INSTRUCTIONS.md) · [Short prompt playbook](PROMPT_PLAYBOOK.md) · [Privacy](PRIVACY.md)

This guide takes a new computer from installation to a tested private GPT. It uses MyTerminal 0.1.1 and the ChatGPT web editor. OpenAI currently makes GPT creation available to paid users, subject to workspace role and policy controls; Actions may also be restricted by allowed domains. A GPT can use **Apps or Actions, not both at the same time**. Actions are not available while the GPT uses ChatGPT's Pro mode, so the editor offers compatible non-Pro models for an Actions GPT. See OpenAI's [GPT creation guide](https://help.openai.com/en/articles/8554397-creating-a-gpt) and [Actions configuration guide](https://help.openai.com/en/articles/9442513).

> The ChatGPT screenshots are privacy-safe crops from local UI snapshots. They contain no conversation text, account identity, real endpoint, or real credential. ChatGPT's labels may move over time.

## The complete path

```mermaid
flowchart LR
  A["Run MyTerminal locally"] --> B["Open an HTTPS tunnel"]
  B --> C["Set Public URL in TUI"]
  C --> D["Create a GPT"]
  D --> E["Import /openapi.json"]
  E --> F["Set Bearer authentication"]
  F --> G["Paste GPT instructions"]
  G --> H["Test identity + checkpoint"]
```

## 1. Install and start MyTerminal

No Git, Node.js, or Bun installation is required beforehand.

### macOS

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.1/scripts/install-macos.sh)"
```

### Linux

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.1/scripts/install-linux.sh)"
```

### Windows PowerShell

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.1/scripts/install-windows.ps1 | iex"
```

The installer downloads the matching standalone executable and SHA-256 file, verifies the checksum, installs the executable into a versioned release directory, registers `myterminal` in the current user's PATH, and opens the TUI. It does not install Git, Node.js, Bun, or package dependencies. Review the scripts before running them if your organization restricts remote scripts. For every later launch, open a new terminal and run only:

```text
myterminal
```

On first launch, complete the TUI form:

1. choose `en` or `zh-CN` and a theme;
2. choose the project directory ChatGPT may access;
3. keep host `127.0.0.1` and port `3210` unless that port is occupied;
4. leave the public URL local for now;
5. accept or adjust output and command limits;
6. keep the generated Apps connector key and Actions token.

All later configuration is available from **6 Settings** with `c`. Do not edit a configuration file manually.

![MyTerminal overview](assets/tui/overview-en.svg)

Visual check: the header says `running`; the Overview page shows exactly three exposed facade tools and masked connection credentials.

![MyTerminal settings](assets/tui/settings-en.svg)

The Settings page is the single source of truth for the workspace, listening address, public URL, limits, masked credentials, optional **Long-task harness**, and optional **Non-blocking tasks**. Both features default off and are independent. Use `adaptive` for a flexible 1-3-call plan, or `next-call` / `lookahead-3` for strict A/B diagnostics. Changing either setting restarts MyTerminal and regenerates the matching OpenAPI schema; a harness change also emits `requirements_changed` to active sessions. Call discovery again and re-import `/openapi.json` because Actions caches the schema.

## 2. Give Actions an HTTPS endpoint

ChatGPT cannot call `127.0.0.1`. For a quick private test, run a Cloudflare Quick Tunnel in a second terminal. Cloudflare documents Quick Tunnels as development/testing only; use a named tunnel and stable hostname for long-lived use.

### Install cloudflared on macOS without Homebrew

```bash
case "$(uname -m)" in
  arm64) CF_ARCH=arm64 ;;
  x86_64) CF_ARCH=amd64 ;;
  *) echo "Unsupported macOS architecture"; exit 1 ;;
esac
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${CF_ARCH}.tgz" -o /tmp/cloudflared.tgz
tar -xzf /tmp/cloudflared.tgz -C /tmp
sudo install /tmp/cloudflared /usr/local/bin/cloudflared
cloudflared --version
```

If Homebrew is already installed, `brew install cloudflared` is the shorter official command.

### Install cloudflared on Windows PowerShell

```powershell
$CloudflaredDir = Join-Path $env:LOCALAPPDATA "cloudflared"
New-Item -ItemType Directory -Force -Path $CloudflaredDir | Out-Null
Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile (Join-Path $CloudflaredDir "cloudflared.exe")
& (Join-Path $CloudflaredDir "cloudflared.exe") --version
```

Start the tunnel. Replace `3210` only if the TUI shows another port.

```bash
cloudflared tunnel --url http://127.0.0.1:3210
```

Windows, if the executable is not on `PATH`:

```powershell
& "$env:LOCALAPPDATA\cloudflared\cloudflared.exe" tunnel --url http://127.0.0.1:3210
```

Copy the generated `https://...trycloudflare.com` URL. In MyTerminal, open **6 Settings**, press `c`, set **Public HTTPS URL** to that URL, and complete the form. MyTerminal restarts safely with the new base URL. Cloudflare's official [Quick Tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) explains the random hostname and testing-only limitation.

> Keep both MyTerminal and `cloudflared` running. A Quick Tunnel URL changes after restart; update the TUI public URL and re-import the Action schema when it changes.

## 3. Create and describe the GPT

Open [chatgpt.com/gpts/editor](https://chatgpt.com/gpts/editor) in a desktop browser. Choose the configuration view and enter a clear name and description.

![GPT configuration fields](assets/actions/gpt-config-en.jpg)

1. **Name:** `MyTerminal Developer`
2. **Description:** `Works on one local project through auditable MyTerminal sessions, collaboration messages, checkpoints, and extensions.`
3. **Instructions:** paste the complete block from [Recommended GPT instructions](GPT_INSTRUCTIONS.md).
4. **Conversation starters:** add two or three entries from the [short prompt playbook](PROMPT_PLAYBOOK.md).

## 4. Create the Action

Scroll to **Actions** and choose **Create new action**.

![Create a new GPT Action](assets/actions/add-action-en.jpg)

The Action surface intentionally has only three operations:

| Action operation | Meaning |
| --- | --- |
| `extensionDiscover` | Bootstrap identity or discover the authenticated concrete-tool catalog. |
| `extensionCall` | Run one concrete tool such as `session_register`, `read_file`, or `message_send`. |
| `extensionRegister` | Validate/upsert/remove a declarative custom extension; never create a session. |

## 5. Import the OpenAPI schema

Choose **Import from URL** and enter:

```text
https://YOUR-PUBLIC-HOST/openapi.json
```

For a Quick Tunnel this looks like:

```text
https://random-words.trycloudflare.com/openapi.json
```

![Import the OpenAPI schema](assets/actions/import-schema-en.jpg)

The current document is OpenAPI `3.1.0`; `components.schemas` is a JSON object. The editor should show the three operation IDs above. Do not paste the Apps MCP URL here, and do not append the hidden Apps connector key.

## 6. Configure Bearer authentication

In the Action editor, open **Authentication**:

1. choose **API Key**;
2. paste the **Actions token** from MyTerminal's Settings page;
3. choose **Bearer**;
4. save.

![Configure the Actions Bearer token](assets/actions/authentication-en.jpg)

Press `v` in MyTerminal Settings only when you intend to reveal credentials. The screenshot uses `[HIDDEN]`; never commit a real token.

Three values serve different purposes:

| Value | Where it goes | Purpose |
| --- | --- | --- |
| Actions token | GPT editor → Authentication → API Key/Bearer | Authenticates HTTP requests to the three facade endpoints. |
| `sessionId + sessionToken` | Top-level `identity` in authenticated Action calls | Identifies the current auditable MyTerminal work session. |
| `claimCode` | `input` of one `session_inherit` call | One-time claim or handoff; it is not a reusable token. |

Never put a session token or claim code into the GPT editor's Authentication field.

## 7. Test in Preview

Keep the GPT private while testing. Send:

```text
Start a new root session for inspecting this project. Report the workspace summary, then checkpoint as waiting.
```

Expected sequence:

1. `extensionDiscover` with the `identity` key entirely omitted returns bootstrap guidance only.
2. `extensionCall` invokes `session_register` with `input.mode="root"`, again with no `identity` key.
3. The GPT retains the returned `sessionId + sessionToken` internally.
4. Authenticated discovery exposes the concrete catalog.
5. `workspace_info` runs through `extensionCall` with top-level `identity`.
6. `session_checkpoint` records a summary and `waiting` phase before the answer ends.

The MyTerminal Logs page shows each call as one evolving record: source (`ACTIONS`), tool name, sanitized complete arguments, `running` state and start time, followed by the sanitized complete result, duration, and `completed`, `failed`, or `timeout` state.

Then test unfinished-work continuation in the three enhanced Settings modes:

```text
Inspect three different parts of the project. Record a working checkpoint after the first observation, then keep working without sending me an intermediate answer.
```

In `adaptive`, a working checkpoint contains 1-3 `nextCalls`: prefer three predictable calls, but use one when test output or a background task may force replanning. `next-call` requires exactly one; `lookahead-3` requires exactly three. Enhanced modes return `continuation.mustContinue=true` and an exact `nextCall`; the GPT must issue it immediately. A different call is rejected with `NEXT_CALL_REQUIRED`. Separately enable **Non-blocking tasks** to make operations exceeding 200ms return `status=running` plus `taskId`; the HTTP request is then released and `task_poll` reads progress until terminal. With it off, calls wait normally. Switch both settings back to off to verify core behavior.

Next, test collaboration:

```text
Delegate a read-only project-structure review and give me the handoff prompt for a second ChatGPT chat.
```

Paste the returned handoff prompt into a separate GPT conversation. The child must call `session_inherit` before work. MyTerminal's Sessions page should show the continuation chain inside one logical card and delegated children as indented nodes.

![Auditable session hierarchy](assets/tui/sessions-en.svg)

## 8. Save and share deliberately

Create/save the GPT as **Only me** first. OpenAI may ask users to approve Actions before execution. If you later share by link or publish to the GPT Store, OpenAI requires a valid privacy-policy URL for a GPT with Actions. Adapt the [privacy template](PRIVACY.md) to the way you operate the GPT and host it at a stable public URL; the repository policy describes the unhosted MyTerminal software, not every third-party deployment.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Input should be '3.1.1' or '3.1.0'` | Update MyTerminal, import the exact `/openapi.json` URL, and remove any stale pasted schema. |
| `components.schemas ... is not an object` | You are using an older or altered schema. MyTerminal 0.1.1 returns a concrete object. Re-import from the running service. |
| `ApiTypeError: Expected identity to be a dict` | Re-import `/openapi.json` and paste the current GPT instructions. Bootstrap calls should omit the `identity` key, not send `identity:null` or `identity:{}`. After updating to a build containing this compatibility fix, explicit null is also treated as an absent bootstrap identity. |
| `spec must be an object` | `extensionRegister` needs top-level `spec:{...}`. Session creation belongs to `extensionCall` with `tool:"session_register"`. |
| `input.name is required`, `input.to is required`, or `input.body is required` | Put concrete arguments inside `extensionCall.input`, for example `{tool:"message_send", input:{to:"reviewer", body:"Ready"}, identity:{...}}`. |
| `IDENTITY_REQUIRED` | Create a root or inherit a handed-off session, then include the returned identity on every authenticated call. |
| `INVALID_IDENTITY` | If the same conversation became stale after interruption, call session_inherit with the previous sessionToken to reclaim the original session. For release/revoke/handoff, obtain a fresh claimCode from the TUI. Do not create a new root for the same unfinished task. |
| `CHECKPOINT_REQUIRED` | Call `session_checkpoint` immediately. In `off`, nextCalls is optional and ordinary work continues; in an enhanced mode, provide the exact count declared by discovery and immediately execute the returned nextCall. |
| `CONTINUATION_PLAN_REQUIRED` | Check the Long-task harness in Settings: `adaptive` accepts 1-3 items, `next-call` requires 1, and `lookahead-3` requires 3. Call discovery again after switching; the static OpenAPI schema does not need to be re-imported. |
| `NEXT_CALL_REQUIRED` | Execute the returned exact nextCall. If the plan is genuinely invalid, checkpoint with replanReason and a complete replacement plan. |
| Tool returns `status=running` | The operation continues locally. Call `task_poll` with its taskId until completed, failed, or timeout; do not treat the fast response as task completion. |
| `CHILD_REVIEW_REQUIRED` | Review the returned child summaries/messages/events and finish or cancel every child. |
| Schema URL cannot be reached | Verify MyTerminal and the tunnel are both running, then open `https://YOUR-HOST/health` and `/openapi.json` in a browser. |
| HTTP 401 | Re-enter the MyTerminal **Actions token** as API Key → Bearer. Do not use the Apps connector key. |

## Security boundary

The selected workspace is writable by the GPT through the facade. Use a dedicated project directory, review the Diff and Logs pages, keep credentials masked, and stop the tunnel when remote access is not needed. Quick Tunnels publish the local HTTP service to a public random hostname; the Actions Bearer token is therefore mandatory.
