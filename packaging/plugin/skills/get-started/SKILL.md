---
name: get-started
description: Bootstrap and drive a MyTerminal plugin session correctly — identity rules, the three facade operations, checkpoints, and safe work practice.
when_to_use: Load first in every new conversation that uses the MyTerminal plugin, before any file, command, or session operation.
mode: inline
---

# MyTerminal plugin quick start

You are connected to MyTerminal through the ChatGPT plugin channel. MyTerminal exposes one generic facade plus narrow direct tools. The facade is the stable surface; direct tools are conveniences with the same semantics.

## Action surface

- `extension_discover`: learn the identity workflow, available concrete tools, and their input schemas. Call it without identity before new work.
- `extension_call`: invoke one concrete tool. A bootstrap request is exactly `{tool, input}`; after identity is established, send `{tool, input, identity}`. Put concrete tool arguments inside `input`, never beside it.
- `extension_register`: validate, add, edit, or remove a custom extension. It is not used to create sessions. For validate/upsert, `spec` must be an object.

## Identity

- A MyTerminal session is an auditable work context, not a ChatGPT conversation ID.
- "Without identity" means the identity key is completely absent from the request object. Never send `identity:null` or `identity:{}`.
- Establish identity in exactly one way:
  - New work: `extension_call({tool:"session_register", input:{mode:"root", name:"...", role:"lead"}})`.
  - Claim handed-off unfinished work: `extension_call({tool:"session_inherit", input:{sessionId:"...", claimCode:"..."}})`. If this conversation was interrupted and its identity became stale, reclaim the original session with `session_inherit({sessionId, sessionToken:<previous token>})`.
- Save the returned `sessionId` and `sessionToken` for this conversation. Include `identity:{sessionId,sessionToken}` at the top level of every later `extension_discover`, `extension_call`, and `extension_register` request. Never print the token in prose.
- Continue completed work with `session_register(mode="root", continuesSessionId:"...")`.
- If identity is missing or invalid, do not guess or retry blindly. Re-establish it through the correct claim flow.

## Discovery and calling

- After identity is established, call `extension_discover` with `includeSchemas:true` before using an unfamiliar tool.
- Use the exact discovered tool name and exact input field names.
- Do not call `extension_register` when you mean the concrete `session_register` tool; `session_register` always goes through `extension_call`.
- Treat each response as authoritative. Report failure codes instead of claiming success.

## Agent context

- The `extension_discover` response may include an `agentMd` field with user-authored instructions. Always read and follow these instructions; they supplement or override the defaults here.

## Checkpoints and continuation

- Use `phase="working"` when more work remains. A working checkpoint is never a stopping point.
- Use `"waiting"` only when genuinely awaiting external input, `"blocked"` with blockers when progress cannot continue safely, and `"completed"` only after verification.
- `completed` and `cancelled` are immutable. A root cannot complete until every direct child is completed/cancelled and every child message/event has been reviewed.
- Before all work is complete, do not send a completion-style or summary-style final answer. Record progress through `message_send`/events and `session_checkpoint`.
- Every authenticated response may contain up to five unacknowledged events. Process relevant events, then acknowledge their IDs with `session_events_ack`.

## Work practice

- Inspect before changing: `workspace_info`, `list_dir`, `find_files`, `search_text`, `read_file` or `read_file_range` first.
- Keep all work inside the authorized workspace. Prefer `apply_patch` for precise edits and `run_checks` before declaring completion.
- A root session may delegate multiple direct children with `session_register(mode="delegate", task={objective,background,deliverables,acceptanceCriteria,constraints})`. A child cannot delegate another child.
- After delegation, give the user the returned `handoffPrompt` and remind them to paste it into a separate ChatGPT conversation.
- `subagent_start` runs a complex, long-running task in isolation with its own context and token budget. Poll `subagent_status` until completed/failed/aborted. `readOnly:true` restricts to read-only tools.
- `skill()` without arguments lists installed skills; `skill(name="...")` loads one. `mode:inline` returns the content for this turn; `mode:fork` starts an isolated subagent.
- Workflows run only when the user asks. Load the `workflow-authoring` skill for the script contract, then `workflow_start({script|scriptPath, args?})` returns a `runId` immediately. Start one reducer with `subagent_start({objective:<the skill's reducer template>, reduce:{runId}})` and poll it.

## Security

- The selected workspace is a real security boundary. Never attempt to read or write outside it.
- Sensitive values are redacted before persistence, but redaction is a safety layer, not permission to send unnecessary credentials or private content. Never include a token in ordinary tool input or prose.
