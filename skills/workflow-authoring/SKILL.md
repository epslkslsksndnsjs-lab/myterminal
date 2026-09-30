---
name: workflow-authoring
description: Load before writing or starting a workflow run — the script contract, fan-out shapes, write isolation, the reducer (汇总体) objective template and the polling rules. Reference only; reading it does not itself authorize running a workflow, which starts only when the user asks for one.
when_to_use: Load when the user asks for a workflow run — by naming workflows, or with a task that needs real breadth (wide research, a full-repo audit, a large sweep). If the user only names workflows with no task, ask what to run first instead of loading this and launching. Never load on your own initiative.
mode: inline
---

## 触发与使用 / Trigger and use

- **Named.** The user names workflows — load this skill, then write the script and start the run in the same conversation.
- **Name only, no task.** The user says "workflows" and nothing else: ask what to run first. Do not start a run on a guess about what they meant.
- **Task attached.** The request needs real breadth that one conversation cannot hold (research, audits, sweeps): scout first, then write the script and start.
- **Opt-in is absolute.** Never start a run on your own initiative. This skill teaches how a run is written; it does not itself authorize running one — only the user's request does. There is no approval prompt and no confirmation gate locally: the gate is you, and it is the user's ask.
- **No command entry point.** There is no slash command and no CLI launcher for workflows. A run starts only through `workflow_start` called in conversation.
- **Scripts are saved.** An inline script is persisted and `workflow_start` answers with its `scriptPath`, so "the one from last time" works: find saved scripts under `<workspace>/.myterminal/workflows/saved/` with `list_dir` / `find_files`, or read the path back out of the conversation. Reusing a saved script is `scriptPath`; a resume is `scriptPath` + `resumeFromRunId` — the only legal combination.
- **Two calls, one turn.** Reconnoiter the target before you write anything, then in the same turn start the run and its reducer: `workflow_start({script|scriptPath, args?})` and `subagent_start({objective: the reducer template below, reduce:{runId}})`. Only the root session that owns the run can start its reducer.
- **Limits are local settings, never arguments.** Nothing on the model-facing surface raises a gate; the defaults are the ceiling. Concurrency window `max(2, min(16, cores-2))` (hard ceiling 64); 1000 agents per run (hard ceiling 10,000); 30-minute wall clock; 8,000,000 output tokens per run; stall window 180 seconds with at most 3 attempts including the first; per-path dispatch 10 minutes / 50 turns. Widen anything only when the user explicitly asks, and widen it in the settings surface (`workflows` config section or `MYTERMINAL_WORKFLOW_*` env), not in the call.
- **Scale guidance 5/15/50.** A handful of paths for a focused job, 15 as a default shape, 50 when the breadth is the point. This is advice, not a limit.

## 作者参考 / Authoring reference

The script contract lives here and nowhere else; the tool description deliberately does not repeat it, so the numbers cannot drift between two faces.

### Shape of a script

- Plain JavaScript. The source is wrapped in an async function body, so top-level `await` and `return` are legal — but the last expression is **not** the result: return explicitly on the success path. No `import`.
- An optional leading `export const meta = { name, description, phases }` must be a pure literal; it is located and blanked before execution (line and column numbers are preserved), and an unbalanced block rejects the script.
- **Determinism is a launch gate.** `Math.random()` and every `Date` accessor (`Date()`, `Date.now()`, `Date.parse()`, `Date.UTC()`, `new Date()`) are rejected before a single token is spent, and the sandbox makes them throw as well. Resume replay depends on deterministic scripts, so a non-deterministic script can never be continued honestly.
- The sandbox has no fs, shell, network, or environment. Every byte of I/O goes through `agent()`. Values crossing back out are revived per slot, so one path returning something unserializable loses only that slot, and the loss is logged.
- Globals: `agent()`, `parallel()`, `pipeline()`, `workflow()`, `args`, `budget`, `log()`, `phase()`. `console.log/warn/error` route into the run log.
- The script's return value is the run result; per-path results are on disk regardless, and the index is the machine-readable account.

### agent(prompt, opts)

Option keys are exactly these twelve; an unknown option (including a typo) is rejected at the call rather than silently ignored:
`stepId`, `label`, `phase`, `schema`, `model`, `effort`, `agentType`, `isolation`, `workingDir`, `stallMs`, `disallowedTools`, `tools`.

- Behaviour-affecting — each one changes this call's cache key: `schema`, `model`, `effort`, `isolation`, `agentType`, `workingDir`, `disallowedTools`, `tools`.
- Presentation and timing only — they never change the key: `label`, `phase`, `stepId`, `stallMs`.
- `effort` tiers: `low` | `medium` | `high` | `xhigh` | `max` (aliases `med`, `mid`, `x-high`). Changing tier changes the key.
- `stepId` is capped at 128 characters and is deliberately not part of the key.
- `tools` / `disallowedTools` only ever narrow the tool face; they cannot add a tool the face does not offer, `tools` may not be an empty array, and wildcards are refused.
- `schema` mode: that path must finish through `structured_output`. A submission that does not fit the schema is refused with the reason, and the third failed submission ends the path with no result.
- `workingDir` pins an existing worktree and is mutually exclusive with `isolation`.
- A path can never fan out another path, message a human, or touch its own run: the fan-out, message, and control surfaces are absent from its tool face. `workflow()` nests at most one level.

### Three outcomes

- `null` — that path failed and it is accounted: turn cap, time cap, model or launch error, missing structured output, stall retries exhausted, or death before the first response. Each failure is recorded in the index with its label, kind, and reason. Check for `null` everywhere, including on a bare `await agent()`.
- reject — the call itself was written wrong (unknown option, `parallel()` given a non-array or an already-started promise instead of a thunk, a stage that is not a function). Shape errors are not path failures and do not consume a cache key.
- throw — run-level end: token gate, agent cap, cancel. The whole batch refuses and the run terminates.
- `parallel(thunks)` starts the whole batch and bars at the end of the batch. `pipeline(items, ...stages)` flows each item through the stages independently with no bar between stages, and short-circuits an item when a stage returns `null` (`0`, `''`, and `false` are legitimate values to pass along). Prefer `pipeline`. Paths never talk to each other: data moves only through script variables, and a barrier between groups exists only when the script itself writes one.

### 写必隔离 / Write requires isolation

- read-only by default: an ordinary path gets `read_file`, `read_file_range`, `list_dir`, `find_files`, `search_text`, and `execute_cli` limited to safe read commands.
- `write_file` and `apply_patch` appear only on a path marked `isolation: 'worktree'`. Asking for a write tool without that mark fails the dispatch before any token is spent, and the write tools refuse again on their own if the mode is wrong.
- The worktree is the boundary: its own cwd, path checks done lexically and with realpath, symlinks and escapes refused. The main checkout and the main `.git` are outside the boundary and unreachable; worktrees cannot see each other.
- A clean worktree is deleted. Anything uncommitted is kept and reported as path + branch — losing work is not an option. The same worktree is shared by all retries of one dispatch.
- Disk is bounded by refusing new worktrees, never by deleting old ones: kept worktrees are capped at 50 and 5 GB; at 80% the TUI warns, at the cap (or below 2 GB free) creation is refused and the offending path fails with reason `worktree-quota`. Only a human subtracts, in the TUI Worktrees panel.

### Budget, cache, resume

- `budget.total`, `budget.spent()`, `budget.remaining()`. Check `budget.total` before looping: with no target, `remaining()` is `Infinity` and a loop runs to the agent cap. Exceeding the cap ends the run; the gate is checked on admission and again when a slot is acquired.
- A new run always runs everything live; there is no cross-run memory.
- Resume replays one run's journal: `workflow_start({scriptPath, resumeFromRunId})` with the script's original reference and, ideally, its original `args`. Keys roll forward in call order from the args, so the first changed or missing call and everything after it runs live while the unchanged prefix is served from cache without spending any tokens. Changing `args` changes the seed and the whole run re-runs; changing a comment, whitespace, or trailing post-processing keeps the whole prefix.
- A journal row torn by a crash is repaired by truncating to the longest well-formed prefix, and what was dropped is reported — never silently.
- A second resume of the same run is refused by an exclusive lock, from this session or any other.
- `workflow_cancel({runId})` stops the whole run; finished work is still delivered, and a reducer reports it as partial.

## 汇总体模板与轮询规则 / Reducer template and polling rules

### Reducer objective — publish verbatim, line by line

Substitute the real values for the angle-bracket placeholders and pass the result as `subagent_start`'s `objective`, with `reduce:{runId}`. The waiting budget is internal: there is no knob for it on the model-facing surface, and the reducer's own timeout is derived from it.

```text
You are the reducer (汇总体) for workflow run <runId>: wait for it to settle, then send back a pointer, never the full result.
Terminal marker: <terminal>
Run index: <index>
Digest document: <digest>
Wait loop: call wait_for_path({ path: "<terminal>", timeoutSec: <waitChunkSec> }) and do not poll more than once per turn; when it returns timeout, make the next call in the next turn.
When it returns ready: read the index first, then open only the per-path files you need for the failure account.
Write the digest document in exactly three sections: 结论 (X/Y succeeded), 失败清单 (one line per failed path: label / error / 相关性), 产物与索引 (absolute paths plus the index reminder).
Report honestly: partial appears as partial — never report a run you did not settle, never drop a failure, never soften a count.
If the budget expires before the marker appears: write no digest and exit with the same three sections, stating the run did not settle, that there is no digest, and where the index is.
Final message: one sentence with X/Y, the digest path, and the index reminder — <summaryBudget> code units is all you get, so render paths in the canonical tail form when they do not fit.
This budget allows <rounds> wait calls of up to <waitChunkSec>s each. The waiting budget comes from local settings; the model-facing surface has no knob for it.
Delivery is your normal completion: your final text is checkpointed and sent to the requesting session, so do not call any messaging tool.
```

### Digest shape — a document template, not a machine contract

The three sections above are the shape, declared here so a reducer and a reader agree on it:

```json
{
  "file": "digest",
  "machineContract": false,
  "sections": [
    {
      "title": "结论",
      "fields": [
        "status",
        "X/Y",
        "reason"
      ]
    },
    {
      "title": "失败清单",
      "fields": [
        "label",
        "error",
        "相关性"
      ]
    },
    {
      "title": "产物与索引",
      "fields": [
        "digestPath",
        "indexPath"
      ]
    }
  ]
}
```

- This shape is a template, not a machine contract. Anything that needs to parse it programmatically must go back to the index (`index.json`), which is the versioned machine artifact.
- An old run's digest is a historical document: never rewritten, and never promised to a machine reader.

### Terminal message — the template is locked here

Delivery is at most 200 code units, and the first line is identity, not formatting:

```text
[workflow] kind=settled-notice runId=<runId> sha256=<hex>
[workflow] kind=digest runId=<runId> sha256=<hex>
```

- `settled-notice` comes from the module when the run settles; `digest` comes from the reducer's delivery. They are not duplicates of each other: `kind` says which.
- The second line of a settled-notice carries `status X/Y index=<absolute path>`. When an absolute path will not fit, the ladder drops detail in this order: the canonical tail form `…/workflows/runs/<runId>/index.json`, then the `X/Y` reading, then a hard cut by code unit. The first line is never compressed — if identity does not fit, the notice is not sent, because the disk and the index are still the truth.
- `sha256` is the byte hash of the file (the snapshot for a settled-notice, the digest for a digest message), and `(runId, sha256)` is the deduplication key.

### Polling rules

- Poll the reducer with `subagent_status` until terminal. Keep at most 10 minutes of continuous polling inside one turn.
- For a run of more than 20 paths, do not poll at all: start it, confirm once that it is running, and let go.
- When your polling budget is up, keep the runId and end the turn, with the query wording the user can repeat. Nobody is obliged to wait for a run to bottom out; the run does not depend on this conversation staying open.
- Polling is activity: it keeps refreshing `lastActivityAt`, so a session that polls does not go stale. The stale window itself is 15 minutes and is not changed for workflows.
- Closing discipline: when the reducer reads `NOT_FOUND` or has failed, read the settled-notice in the inbox — the record lives an hour and the notice is permanent. If the run settled but no digest exists, start another reducer with the same runId; the marker is already on disk, so it wakes immediately.
- Deduplication: the same (runId, sha256) pair you have already seen is a redelivery — ignore it. A different sha is an updated version — take the newest and say "updated version". A notification and a poll are two views of one result: merge them, act once, and do not trigger a downstream action twice.
- The failure list never travels inside a notice. Read the index, or page through the reducer result with `subagent_status` offsets.

### Reporting honestly

- partial must be reported as partial. Name the failed paths, give the counts as they are, and hand over the paths and the index. A run that did not settle is never dressed up as completed: a false whole is the red line.
- Whether a partial counts as passing is decided by two things only: the script (its verification, convergence, and retry logic, written at authoring time) and the user's acceptance criteria. Not by the module, and not by you softening a count.
- The module never reruns, never degrades, never compensates on its own. The default action is to deliver with the warning attached. The only degradation is the user editing the script.
- Catch-up is a decision, not a mechanism: start a new run whose script focuses on the failed subset, or use an in-script retry. A resumed run with the same runId is the other option, and it serves the finished calls from cache.
- Issue-class products (reviews, audits, verifications) have no pass line — only per-item adjudication. Adjudicate every finding as 修 (fix it), 补 (add the missing piece), or 记账 [未确认] (book it as unconfirmed). Never leave an unadjudicated finding in a report.
