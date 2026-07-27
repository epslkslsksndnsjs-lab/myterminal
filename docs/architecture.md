# MyTerminal Architecture

## System topology

```text
ChatGPT Apps / Actions
        |
        | direct low-risk MCP tools or authenticated Actions facade
        v
+----------------------------- shared public host:port -----------------------------+
| Cluster gateway (one elected leader process)                                      |
|  - validates connector / Actions credentials                                      |
|  - routes by workspace identity or authenticated session ownership                |
+--------------------------------------+---------------------------------------------+
                                       |
                  +--------------------+--------------------+
                  |                                         |
                  v                                         v
       Workspace runtime A                       Workspace runtime B
       internal loopback server                  internal loopback server
       ExtensionService                          ExtensionService
       MyTerminalStore                                 MyTerminalStore
       workspace-scoped state                    workspace-scoped state

Global installation state
  config.json
  workspaces.json             durable workspace catalog + transient process lease
  clusters/*.json             shared-port membership and leader election
  passive-lock/*              one global macOS helper, owned by all live runtimes

TUI
  App (rendering/composition)
    -> TuiController (use-case orchestration)
    -> workspace-selector (single workspace selector presenter)
    -> renderer-profile (platform-specific terminal compatibility policy)
    -> runtime-settings (effective runtime settings snapshot)
    -> credential-visibility (fail-closed key lifecycle)
```

## Ownership rules

### Workspace runtime

A `MyTerminalRuntime` owns one workspace-local server, store, extension service, MCP transport, timers, and workspace runtime lease. Closing it must release only resources owned by that runtime.

### Shared-port cluster

`PortClusterRegistry` owns membership and leader election for one configured host and port. Exactly one member accepts public traffic. Followers expose only loopback RPC servers. Public traffic must stop before a leader unregisters.

### Workspace catalog and runtime lease

`workspaces.json` is the durable workspace catalog. `lastPid`, `lastHost`, and `lastPort` form a transient runtime lease. A runtime publishes the lease only after binding its actual port and releases it during shutdown or reconfiguration. Registry updates are cross-process locked and atomically replaced.

### Passive-lock helper

The passive-lock service is installation-global. It is not owned by one workspace or one TUI. A runtime may start or command it, but may stop it only after releasing its own lease and confirming no other live MyTerminal runtime remains.

### Session resources

One-shot helpers are workspace- and session-scoped. Terminal session completion, cancellation, controller cleanup, or runtime shutdown may terminate only helpers whose PID files and executable identity match that session.

### Continuation and background tasks

Actions continuation plans are optional durable session state. `off` preserves the core harness, `adaptive` stores 1-3 calls, `next-call` stores one, and `lookahead-3` stores three. Only a confirmed successful call advances a queue. Contract revisions are persisted; a mode/revision change emits `requirements_changed`, which discovery acknowledges after returning the new contract. Non-blocking scheduling is a separate default-off setting. When enabled, `ExtensionService` releases an operation after a 200ms response budget with a task ID, retains the live audit record, and completes or fails that same record when the operation settles. Completed responses expire after 30 minutes and are evicted oldest-first when either 100 retained tasks or 24 MiB of serialized responses is reached; a maintenance timer also enforces expiry while idle. Runtime shutdown stops accepting calls, aborts owned command trees, waits a bounded grace period, and closes remaining audits before releasing the workspace lease.

History JSONL files use a sparse, stat-validated line index and bounded range reads. The TUI renders only the newest history window and directs users to paginated `session_history` for the complete record. Inbox reads default to a bounded page, preventing message observation from monopolizing the event loop.

The renderer profile is capability-conservative on Windows: it does not infer safety from `WT_SESSION`, keeps main-screen rendering on the Bun thread at a bounded frame rate, disables Kitty keyboard negotiation, and defaults to keyboard-only input. `MYTERMINAL_WINDOWS_TUI_MODE=mouse` changes only mouse capture for isolated compatibility testing. Page lists support arrows, `j/k`, paging, boundary jumps, and Enter, so mouse availability is never required for session operations.

### Apps MCP surface and blobs

Apps registers both the full execution/registration facade and direct tools for local session control, workspace/Git reads, messaging, polling, and content-addressed Blob staging. `extension_call` is the capability-complete path for arbitrary commands, overwriting writes, patches, and custom extensions; direct tools are schema-focused convenience paths and never replace it. Blob bytes live under the workspace runtime's private state directory and are addressed and verified by SHA-256. `blob_write_file` succeeds idempotently when an existing target has the same digest and rejects only content collisions; overwriting remains available through the generic facade.

### Diff subsystem

Git is an optional workspace capability. The Diff tracker probes once and degrades safely for non-Git directories or missing Git. Every subprocess has a deadline and bounded output. Untracked files are sampled through bounded reads; binaries and oversized files are never loaded wholly into memory.

### Credential visibility

Credentials are hidden by default and may be visible only while eligible `v` press/repeat events keep extending a 450ms deadline. Some terminal protocols emit unnamed release packets between repeats, so release packets do not directly toggle visibility. When repeats stop, the deadline hides credentials; navigation, modal transition, or loss of eligible context hides them immediately.

## Module boundaries

| Layer | Primary modules | Responsibility |
|---|---|---|
| Entry/configuration | `cli.ts`, `config.ts`, `migration.ts` | startup, settings, compatibility |
| Runtime/process | `server.ts`, `cluster.ts`, `cluster-router.ts`, `control-channel.ts`, `runtime-lifecycle.ts`, `instances.ts` | HTTP/control lifecycle, process topology, routing, leases |
| Domain/state | `store.ts`, `types.ts`, `tui-model.ts` | sessions, messages, events, journal/snapshot persistence, audit history |
| Extension facade | `extensions.ts`, `core-tools.ts`, `mcp.ts`, `openapi.ts` | authenticated tool discovery, registration and calls |
| Skill system | `skills.ts` | SKILL.md scanning, frontmatter parsing, manifest loading, fork/inline routing, built-in skill fallback (adaptive-guard) |
| Subagent system | `subagent/*.ts` | isolated agent loop, 8-tool set, multi-provider LLM adapter, cost tracking, permissions, file/shell state, result budget, TUI bridge |
| Resource adapters | `session-resources.ts`, `diff.ts`, `security.ts`, `update.ts`, `update-transaction.ts` | OS helpers, Git sampling, path/credential safety, transactional updates |
| TUI contracts/presentation | `tui/contracts.ts`, `tui/workspace-selector.ts`, `tui/renderer-profile.ts`, `runtime-settings.ts`, `tui/credential-visibility.ts` | shared view models, terminal profiles, and interaction contracts |
| TUI orchestration/rendering | `tui/state.ts`, `tui/App.tsx`, screens/components | use cases and rendering |

## Required invariants

1. A live process lease belongs to exactly one workspace at a time.
2. A public gateway never serves after its member registration is removed.
3. Only the last live MyTerminal process may stop the global passive-lock helper.
4. Credentials fail closed after the bounded repeat deadline and immediately on context transitions.
5. No Diff operation reads an unbounded file or produces unbounded output.
6. Setup, startup selection, and Settings consume the same complete workspace selector model.
7. Workspace-local state never escapes into another workspace and internal state is excluded from tools and Diff.
8. Process and cluster status shown in the TUI comes from runtime topology, not static labels.
9. An Actions continuation queue advances only after the exact planned call completes successfully.
10. Narrow Apps tools marked non-destructive do not overwrite existing workspace files; the separately exposed generic facade retains explicit overwrite and arbitrary-command capabilities.
11. Subagents have an isolated context window and tool set; they cannot start other subagents (recursion guard) and share a global maxParallel limit with fork skills.
12. Skill frontmatter is the single source of truth for routing (inline vs fork); the skill tool never silently downgrades a fork to inline.

## Change guidance

New behavior must be placed at the ownership level that controls its lifecycle. UI components should render a view model rather than reconstruct domain state. Global resources require global ownership checks; workspace resources require workspace identity; session resources require session identity. Every new process, timer, file lock, and credential-reveal path needs an explicit creation, timeout, and cleanup rule.
