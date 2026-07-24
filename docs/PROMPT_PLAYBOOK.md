# Short prompt playbook

[中文](PROMPT_PLAYBOOK.zh-CN.md) · [Recommended GPT instructions](GPT_INSTRUCTIONS.md) · [Actions setup](ACTIONS_SETUP.md)

Replace only the text in angle brackets. Keep the prompt short; the GPT instructions already define the tool workflow.

| Goal | Prompt |
| --- | --- |
| Start new work | `Start a new root session for <goal>. Inspect the project, then proceed.` |
| Claim a handoff | `Take over this MyTerminal session: <paste the TUI handoff prompt>.` |
| Continue completed work | `Continue completed session <name or ID> with this new goal: <goal>. Create a continuation; do not inherit it.` |
| Delegate one slice | `Delegate <task> to a child session and give me the handoff prompt for a second ChatGPT chat.` |
| Check collaboration | `Show the session tree, blockers, unread messages, and pending events.` |
| Send a message | `Tell <session name>: <message>. Then show our two-way conversation.` |
| Use or create an extension | `Find a tool for <goal>. If none exists, validate the smallest safe extension spec before registering it.` |
| Hand off current work | `Release the current session and give me the one-time handoff prompt.` |
| Finish safely | `Run the project checks. If they pass, checkpoint the verified result as completed.` |

## What not to paste

Avoid long “act as an expert” prompts, copied API schemas, tokens, session identities, or internal tool JSON. The GPT preset already carries the stable rules; a user prompt should state only the goal, scope, and any decision that matters.

## One useful correction

If the GPT chooses the wrong session flow, send one sentence:

`This is <unfinished handoff / completed continuation>; use <session_inherit / session_register with continuesSessionId>.`
