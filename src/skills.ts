import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SKILL_FILE = 'SKILL.md';
const MAX_SKILL_BYTES = 100_000; // 100KB
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{2,63}$/;
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 800;
const WHEN_TO_USE_MAX = 2000;

const SKILL_MODES = ['inline', 'fork'] as const;
const MAX_TURNS_MIN = 1;
const MAX_TURNS_MAX = 200;
const TIMEOUT_SEC_MIN = 30;
const TIMEOUT_SEC_MAX = 3600;

export type SkillMode = (typeof SKILL_MODES)[number];

/** ADR-0010 决策 6：fork 时可覆盖 subagent 默认配置，优先级 forkOptions > settings.json */
export type SkillForkOptions = {
  deliverables?: string[];
  acceptanceCriteria?: string[];
  constraints?: string[];
  maxTurns?: number;
  timeoutSec?: number;
  readOnly?: boolean;
};

export type SkillManifest = {
  name: string;
  description: string;
  when_to_use: string;
  mode: SkillMode;
  forkOptions?: SkillForkOptions;
};

export type SkillRecord = SkillManifest & {
  content: string;
};

type ParsedMarkdown = {
  frontmatter: Record<string, unknown>;
  content: string;
};

function projectSkillsDir(workspaceDir: string): string {
  return path.join(workspaceDir, '.myterminal', 'skills');
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : content + '\n';
}

// --- Frontmatter parser (hand-rolled, zero runtime deps) ---

/** 解析单个值：去引号、数组 [a, b]。嵌套字段复用同一逻辑。 */
function parseValue(value: string): unknown {
  // Remove surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  // Handle arrays: [item1, item2]
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => {
      const t = item.trim();
      if ((t.startsWith('"') && t.endsWith('"')) ||
          (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1);
      }
      return t;
    });
  }

  return value;
}

function parseFrontmatter(markdown: string): ParsedMarkdown {
  const match = markdown.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, content: markdown };

  const raw = match[1];
  const content = markdown.slice(match[0].length);
  const frontmatter: Record<string, unknown> = {};

  // Parse line-by-line: key: value  |  key: [item, ...]  |  key:\n  nested: value（仅支持一层嵌套）
  const lines = raw.split('\n');
  let nestedKey: string | null = null;
  let nested: Record<string, unknown> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    const isIndented = /^\s+\S/.test(line);

    if (isIndented && nestedKey !== null && nested !== null) {
      // 嵌套字段（forkOptions 下的 maxTurns/timeoutSec/...）
      nested[key] = parseValue(value);
      continue;
    }

    // 顶层字段
    if (!value) {
      // 值为空——可能是一层嵌套对象的开始（如 "forkOptions:"）
      nestedKey = key;
      nested = {};
      frontmatter[key] = nested;
      continue;
    }

    nestedKey = null;
    nested = null;
    frontmatter[key] = parseValue(value);
  }

  return { frontmatter, content };
}

// --- Validation ---

function validateSkillManifest(frontmatter: Record<string, unknown>, sourcePath: string): SkillManifest | null {
  const name = typeof frontmatter.name === 'string' ? frontmatter.name : '';
  if (!SKILL_NAME_RE.test(name)) {
    console.warn(`[skills] Invalid or missing "name" in ${sourcePath}`);
    return null;
  }

  const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
  if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    console.warn(`[skills] Invalid "description" (${DESCRIPTION_MIN}-${DESCRIPTION_MAX} chars) in ${sourcePath}`);
    return null;
  }

  const when_to_use = typeof frontmatter.when_to_use === 'string' ? frontmatter.when_to_use : '';
  if (when_to_use.length > WHEN_TO_USE_MAX) {
    console.warn(`[skills] "when_to_use" exceeds ${WHEN_TO_USE_MAX} chars in ${sourcePath}`);
    return null;
  }

  // ADR-0010 决策 2/11：mode 校验，缺省 inline
  let mode: SkillMode = 'inline';
  if (frontmatter.mode !== undefined) {
    if (typeof frontmatter.mode === 'string' && (SKILL_MODES as readonly string[]).includes(frontmatter.mode)) {
      mode = frontmatter.mode as SkillMode;
    } else {
      console.warn(`[skills] Invalid "mode" (must be inline|fork) in ${sourcePath}`);
      return null;
    }
  }

  // ADR-0010 决策 6/11：forkOptions 校验（解析器产出字符串/数组，此处 coerce 为语义类型）
  let forkOptions: SkillForkOptions | undefined;
  if (frontmatter.forkOptions !== undefined) {
    if (typeof frontmatter.forkOptions !== 'object' || frontmatter.forkOptions === null || Array.isArray(frontmatter.forkOptions)) {
      console.warn(`[skills] "forkOptions" must be a nested object in ${sourcePath}`);
      return null;
    }
    const raw = frontmatter.forkOptions as Record<string, unknown>;
    const parsed: SkillForkOptions = {};

    for (const key of ['deliverables', 'acceptanceCriteria', 'constraints'] as const) {
      if (raw[key] !== undefined) {
        if (!Array.isArray(raw[key]) || !(raw[key] as unknown[]).every((item) => typeof item === 'string')) {
          console.warn(`[skills] "forkOptions.${key}" must be a string array in ${sourcePath}`);
          return null;
        }
        parsed[key] = raw[key] as string[];
      }
    }

    for (const key of ['maxTurns', 'timeoutSec'] as const) {
      if (raw[key] !== undefined) {
        const num = typeof raw[key] === 'number' ? (raw[key] as number) : Number(raw[key]);
        const [min, max] = key === 'maxTurns' ? [MAX_TURNS_MIN, MAX_TURNS_MAX] : [TIMEOUT_SEC_MIN, TIMEOUT_SEC_MAX];
        if (!Number.isInteger(num) || num < min || num > max) {
          console.warn(`[skills] "forkOptions.${key}" must be an integer ${min}-${max} in ${sourcePath}`);
          return null;
        }
        parsed[key] = num;
      }
    }

    if (raw.readOnly !== undefined) {
      if (raw.readOnly === 'true' || raw.readOnly === true) parsed.readOnly = true;
      else if (raw.readOnly === 'false' || raw.readOnly === false) parsed.readOnly = false;
      else {
        console.warn(`[skills] "forkOptions.readOnly" must be true/false in ${sourcePath}`);
        return null;
      }
    }

    forkOptions = parsed;
  }

  return { name, description, when_to_use, mode, ...(forkOptions ? { forkOptions } : {}) };
}

// --- Directory scanning ---

function readSkillFile(filePath: string): { manifest: SkillManifest; content: string } | null {
  let raw: string;
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_SKILL_BYTES) {
      console.warn(`[skills] ${filePath} exceeds ${MAX_SKILL_BYTES} bytes, skipping`);
      return null;
    }
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null; // ENOENT or permission error — skip
  }

  const { frontmatter, content } = parseFrontmatter(raw);
  const manifest = validateSkillManifest(frontmatter, filePath);
  if (!manifest) return null;

  // ADR-0010 决策 11：fork 但 content 为空 → 警告（不阻止）
  if (manifest.mode === 'fork' && !content.trim()) {
    console.warn(`[skills] ${filePath}: mode is "fork" but content is empty`);
  }

  return { manifest, content: ensureTrailingNewline(content) };
}

function scanDir(dir: string): Map<string, { manifest: SkillManifest; content: string }> {
  const result = new Map<string, { manifest: SkillManifest; content: string }>();
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // 目录式布局：<name>/SKILL.md
      const filePath = path.join(dir, entry.name, SKILL_FILE);
      if (!existsSync(filePath)) {
        console.warn(`[skills] Skill directory ${path.join(dir, entry.name)} has no ${SKILL_FILE}, skipping`);
        continue;
      }
      const parsed = readSkillFile(filePath);
      if (parsed) result.set(parsed.manifest.name, parsed);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // 平铺布局：<name>.md —— ADR-0031 #16：此前被 isDirectory() 过滤静默丢弃
      const filePath = path.join(dir, entry.name);
      const parsed = readSkillFile(filePath);
      if (parsed) result.set(parsed.manifest.name, parsed);
      else console.warn(`[skills] Skill file ${filePath} is invalid or missing frontmatter, skipping`);
    }
  }
  return result;
}

// --- Built-in skills (hardcoded fallback, user files take priority) ---

const BUILTIN_ADAPTIVE_GUARD_CONTENT = `# Adaptive Guard — Recovery Playbook

Load this skill when any MyTerminal call returns an error, when OpenAI ends a turn prematurely, or when a task seems too large for the current context window.

## Diagnostic Flow

1. Read the \`error.code\` from the response (or identify the symptom).
2. Match it to one of the categories below.
3. Execute the recovery steps in order.
4. After recovery, checkpoint(working) with the next planned action and continue.

## Recovery Decision Tree

### Category 1: Rate Limit (429 / RateLimitReached)

- Step 1: checkpoint(working, summary:"rate limited, backing off 30s").
- Step 2: Wait ~30 seconds, then retry the original call.
- Step 3: Still 429 → wait 60 seconds, retry.
- Step 4: Still 429 → checkpoint(blocked, blockers:["OpenAI rate limit persists after 3 attempts"]). Inform the user.

### Category 2: Turn Ended Prematurely (summary-like result, mustContinue not set)

- Step 1: Do NOT send a completion summary to the user.
- Step 2: Immediately checkpoint(phase:"working", summary:"turn interrupted, continuing work") with nextCalls containing the exact next tool and input.
- Step 3: Execute the returned nextCall in the same assistant turn.
- Step 4: If the harness mode is \`off\`, continue working normally without waiting for nextCall enforcement.

### Category 3: Tool Timeout (ACTION_TIMEOUT)

- Step 1: Reduce input size — use read_file_range instead of read_file, narrow search_text query, or reduce execute_cli command scope.
- Step 2: Retry with a larger timeoutSec if applicable.
- Step 3: Still timing out → delegate to subagent_start({objective, timeoutSec:600}) for async execution. Poll subagent_status until terminal.

### Category 4: Identity Stale (INVALID_IDENTITY / STALE_IDENTITY)

- Step 1: Use the previous sessionToken with session_inherit({sessionId, sessionToken:<previous>}) to reclaim the session.
- Step 2: If that fails, call extensionDiscover without identity, then session_register a new root.
- Step 3: NEVER create a new root for the same unfinished task just because identity became stale.

### Category 5: Network / Connection Error (WORKSPACE_UNAVAILABLE / RUNTIME_SHUTTING_DOWN)

- Step 1: Wait 5 seconds, retry.
- Step 2: Wait 10 seconds, retry.
- Step 3: Wait 20 seconds, retry.
- Step 4: Still failing → checkpoint(blocked, blockers:["workspace unreachable after 3 retries"]). Inform the user.

### Category 6: Context Overflow / Task Too Large

- Symptom: conversation exceeds ~15 turns, or tool results are too large to process.
- Step 1: Break the remaining work into 2-3 independent sub-objectives.
- Step 2: Use subagent_start for each sub-objective with a focused, complete objective.
- Step 3: Poll subagent_status(taskId) until each subagent completes.
- Step 4: Aggregate results and continue.

### Category 7: Response Data Too Large

- Step 1: Replace read_file with read_file_range — read 500 lines at a time.
- Step 2: Add maxBytes parameter to read_file (e.g., 50000).
- Step 3: Narrow search_text queries to reduce match count.
- Step 4: For execute_cli, pipe output through head/tail to limit size.

## General Principles

- Always checkpoint BEFORE attempting recovery, so progress is not lost.
- After successful recovery, checkpoint(working) with the next planned action.
- If 3 recovery attempts fail for the same category, escalate to blocked with clear blockers.
- Never invent fake results or claim success when a tool returned an error.
`;

const WORKFLOW_AUTHORING_CONTENT = `## 触发与使用 / Trigger and use

- **Named.** The user names workflows — load this skill, then write the script and start the run in the same conversation.
- **Name only, no task.** The user says "workflows" and nothing else: ask what to run first. Do not start a run on a guess about what they meant.
- **Task attached.** The request needs real breadth that one conversation cannot hold (research, audits, sweeps): scout first, then write the script and start.
- **Opt-in is absolute.** Never start a run on your own initiative. This skill teaches how a run is written; it does not itself authorize running one — only the user's request does. There is no approval prompt and no confirmation gate locally: the gate is you, and it is the user's ask.
- **No command entry point.** There is no slash command and no CLI launcher for workflows. A run starts only through \`workflow_start\` called in conversation.
- **Scripts are saved.** An inline script is persisted and \`workflow_start\` answers with its \`scriptPath\`, so "the one from last time" works: find saved scripts under \`<workspace>/.myterminal/workflows/saved/\` with \`list_dir\` / \`find_files\`, or read the path back out of the conversation. Reusing a saved script is \`scriptPath\`; a resume is \`scriptPath\` + \`resumeFromRunId\` — the only legal combination.
- **Two calls, one turn.** Reconnoiter the target before you write anything, then in the same turn start the run and its reducer: \`workflow_start({script|scriptPath, args?})\` and \`subagent_start({objective: the reducer template below, reduce:{runId}})\`. Only the root session that owns the run can start its reducer.
- **Limits are local settings, never arguments.** Nothing on the model-facing surface raises a gate; the defaults are the ceiling. Concurrency window \`max(2, min(16, cores-2))\` (hard ceiling 64); 1000 agents per run (hard ceiling 10,000); 30-minute wall clock; 8,000,000 output tokens per run; stall window 180 seconds with at most 3 attempts including the first; per-path dispatch 10 minutes / 50 turns. Widen anything only when the user explicitly asks, and widen it in the settings surface (\`workflows\` config section or \`MYTERMINAL_WORKFLOW_*\` env), not in the call.
- **Scale guidance 5/15/50.** A handful of paths for a focused job, 15 as a default shape, 50 when the breadth is the point. This is advice, not a limit.

## 作者参考 / Authoring reference

The script contract lives here and nowhere else; the tool description deliberately does not repeat it, so the numbers cannot drift between two faces.

### Shape of a script

- Plain JavaScript. The source is wrapped in an async function body, so top-level \`await\` and \`return\` are legal — but the last expression is **not** the result: return explicitly on the success path. No \`import\`.
- A leading \`export const meta = { name, description, phases }\` block is allowed and is located and blanked before execution, with line and column numbers preserved; an unbalanced block rejects the script. Its \`name\` becomes the saved script's filename when it matches \`^[a-z][a-z0-9-]{0,40}$\`; otherwise the file is named after the runId. Nothing else about it is interpreted.
- **Determinism is a launch gate.** \`Math.random()\` and every \`Date\` accessor (\`Date()\`, \`Date.now()\`, \`Date.parse()\`, \`Date.UTC()\`, \`new Date()\`) are rejected before a single token is spent, and the sandbox makes them throw as well. Resume replay depends on deterministic scripts, so a non-deterministic script can never be continued honestly.
- The sandbox has no fs, shell, network, or environment. Every byte of I/O goes through \`agent()\`. Values crossing back out are revived per slot, so one path returning something unserializable loses only that slot, and the loss is logged.
- Globals: \`agent()\`, \`parallel()\`, \`pipeline()\`, \`workflow()\`, \`args\`, \`budget\`, \`log()\`, \`phase()\`. \`console.log/warn/error\` route into the run log.
- The script's return value is the run result; per-path results are on disk regardless, and the index is the machine-readable account.

### agent(prompt, opts)

Option keys are exactly these twelve; an unknown option (including a typo) is rejected at the call rather than silently ignored:
\`stepId\`, \`label\`, \`phase\`, \`schema\`, \`model\`, \`effort\`, \`agentType\`, \`isolation\`, \`workingDir\`, \`stallMs\`, \`disallowedTools\`, \`tools\`.

- Behaviour-affecting — each one changes this call's cache key: \`schema\`, \`model\`, \`effort\`, \`isolation\`, \`agentType\`, \`workingDir\`, \`disallowedTools\`, \`tools\`.
- Presentation and timing only — they never change the key: \`label\`, \`phase\`, \`stepId\`, \`stallMs\`.
- \`effort\` tiers: \`low\` | \`medium\` | \`high\` | \`xhigh\` | \`max\` (aliases \`med\`, \`mid\`, \`x-high\`). Changing tier changes the key.
- \`stepId\` is capped at 128 characters and is deliberately not part of the key.
- \`tools\` / \`disallowedTools\` only ever narrow the tool face; they cannot add a tool the face does not offer, \`tools\` may not be an empty array, and wildcards are refused.
- \`schema\` mode: that path must finish through \`structured_output\`. A submission that does not fit the schema is refused with the reason, and the third failed submission ends the path with no result.
- \`workingDir\` pins an existing worktree and is mutually exclusive with \`isolation\`.
- \`agentType\` selects one of the module's own profiles — \`workflow-agent\` by default, \`reader\` for a face with no write tool at all. A profile is an upper bound: it can only narrow what the mode already allows, so a \`reader\` path gets no write tool even when it asks for isolation.
- A path can never fan out another path, message a human, or touch its own run: the fan-out, message, and control surfaces are absent from its tool face. \`workflow()\` nests at most one level.

### Three outcomes

- \`null\` — that path failed and it is accounted: turn cap, time cap, model or launch error, missing structured output, stall retries exhausted, or death before the first response. Each failure is recorded in the index with its label, kind, and reason. Check for \`null\` everywhere, including on a bare \`await agent()\`.
- reject — the call itself was written wrong (unknown option, \`parallel()\` given a non-array or an already-started promise instead of a thunk, a stage that is not a function). Shape errors are not path failures and do not consume a cache key.
- throw — run-level end: token gate, agent cap, cancel. The whole batch refuses and the run terminates.
- \`parallel(thunks)\` starts the whole batch and bars at the end of the batch. \`pipeline(items, ...stages)\` flows each item through the stages independently with no bar between stages, and short-circuits an item when a stage returns \`null\` (\`0\`, \`''\`, and \`false\` are legitimate values to pass along). Prefer \`pipeline\`. Paths never talk to each other: data moves only through script variables, and a barrier between groups exists only when the script itself writes one.

### 写必隔离 / Write requires isolation

- read-only by default: an ordinary path gets \`read_file\`, \`read_file_range\`, \`list_dir\`, \`find_files\`, \`search_text\`, and \`execute_cli\` limited to safe read commands.
- \`write_file\` and \`apply_patch\` appear only on a path marked \`isolation: 'worktree'\`. Asking for a write tool without that mark fails the dispatch before any token is spent, and the write tools refuse again on their own if the mode is wrong.
- The worktree is the boundary: its own cwd, path checks done lexically and with realpath, symlinks and escapes refused. The main checkout and the main \`.git\` are outside the boundary and unreachable; worktrees cannot see each other.
- A clean worktree is deleted. Anything uncommitted is kept and reported as path + branch — losing work is not an option. The same worktree is shared by all retries of one dispatch.
- Disk is bounded by refusing new worktrees, never by deleting old ones: kept worktrees are capped at 50 and 5 GB; at 80% the TUI warns, at the cap (or below 2 GB free) creation is refused and the offending path fails with reason \`worktree-quota\`. Only a human subtracts, in the TUI Worktrees panel.

### Budget, cache, resume

- \`budget.total\`, \`budget.spent()\`, \`budget.remaining()\`. Check \`budget.total\` before looping: with no target, \`remaining()\` is \`Infinity\` and a loop runs to the agent cap. Exceeding the cap ends the run; the gate is checked on admission and again when a slot is acquired.
- A new run always runs everything live; there is no cross-run memory.
- Resume replays one run's journal: \`workflow_start({scriptPath, resumeFromRunId})\` with the script's original reference and, ideally, its original \`args\`. Keys roll forward in call order from the args, so the first changed or missing call and everything after it runs live while the unchanged prefix is served from cache without spending any tokens. Changing \`args\` changes the seed and the whole run re-runs; changing a comment, whitespace, or trailing post-processing keeps the whole prefix.
- A journal row torn by a crash is repaired by truncating to the longest well-formed prefix, and what was dropped is reported — never silently.
- A second resume of the same run is refused by an exclusive lock, from this session or any other.
- \`workflow_cancel({runId})\` stops the whole run; finished work is still delivered, and a reducer reports it as partial.

## 汇总体模板与轮询规则 / Reducer template and polling rules

### Reducer objective — publish verbatim, line by line

Substitute the real values for the angle-bracket placeholders and pass the result as \`subagent_start\`'s \`objective\`, with \`reduce:{runId}\`. The waiting budget is internal: there is no knob for it on the model-facing surface, and the reducer's own timeout is derived from it.

\`\`\`text
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
\`\`\`

### Digest shape — a document template, not a machine contract

The three sections above are the shape, declared here so a reducer and a reader agree on it:

\`\`\`json
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
\`\`\`

- This shape is a template, not a machine contract. Anything that needs to parse it programmatically must go back to the index (\`index.json\`), which is the versioned machine artifact.
- An old run's digest is a historical document: never rewritten, and never promised to a machine reader.

### Terminal message — the template is locked here

Delivery is at most 200 code units, and the first line is identity, not formatting:

\`\`\`text
[workflow] kind=settled-notice runId=<runId> sha256=<hex>
[workflow] kind=digest runId=<runId> sha256=<hex>
\`\`\`

- \`settled-notice\` comes from the module when the run settles; \`digest\` comes from the reducer's delivery. They are not duplicates of each other: \`kind\` says which.
- The second line of a settled-notice carries \`status X/Y index=<absolute path>\`. When an absolute path will not fit, the ladder drops detail in this order: the canonical tail form \`…/workflows/runs/<runId>/index.json\`, then the \`X/Y\` reading, then a hard cut by code unit. The first line is never compressed — if identity does not fit, the notice is not sent, because the disk and the index are still the truth.
- \`sha256\` is the byte hash of the file (the snapshot for a settled-notice, the digest for a digest message), and \`(runId, sha256)\` is the deduplication key.

### Polling rules

- Poll the reducer with \`subagent_status\` until terminal. Keep at most 10 minutes of continuous polling inside one turn.
- For a run of more than 20 paths, do not poll at all: start it, confirm once that it is running, and let go.
- When your polling budget is up, keep the runId and end the turn, with the query wording the user can repeat. Nobody is obliged to wait for a run to bottom out; the run does not depend on this conversation staying open.
- Polling is activity: it keeps refreshing \`lastActivityAt\`, so a session that polls does not go stale. The stale window itself is 15 minutes and is not changed for workflows.
- Closing discipline: when the reducer reads \`NOT_FOUND\` or has failed, read the settled-notice in the inbox — the record lives an hour and the notice is permanent. If the run settled but no digest exists, start another reducer with the same runId; the marker is already on disk, so it wakes immediately.
- Deduplication: the same (runId, sha256) pair you have already seen is a redelivery — ignore it. A different sha is an updated version — take the newest and say "updated version". A notification and a poll are two views of one result: merge them, act once, and do not trigger a downstream action twice.
- The failure list never travels inside a notice. Read the index, or page through the reducer result with \`subagent_status\` offsets.

### Reporting honestly

- partial must be reported as partial. Name the failed paths, give the counts as they are, and hand over the paths and the index. A run that did not settle is never dressed up as completed: a false whole is the red line.
- Whether a partial counts as passing is decided by two things only: the script (its verification, convergence, and retry logic, written at authoring time) and the user's acceptance criteria. Not by the module, and not by you softening a count.
- The module never reruns, never degrades, never compensates on its own. The default action is to deliver with the warning attached. The only degradation is the user editing the script.
- Catch-up is a decision, not a mechanism: start a new run whose script focuses on the failed subset, or use an in-script retry. A resumed run with the same runId is the other option, and it serves the finished calls from cache.
- Issue-class products (reviews, audits, verifications) have no pass line — only per-item adjudication. Adjudicate every finding as 修 (fix it), 补 (add the missing piece), or 记账 [未确认] (book it as unconfirmed). Never leave an unadjudicated finding in a report.
`;

const BUILTIN_SKILLS: Map<string, SkillRecord> = new Map([
  ['adaptive-guard', {
    name: 'adaptive-guard',
    description: 'Recovery strategies when encountering server limits, timeouts, turn interruptions, context overflow, or tool failures. Load this when any MyTerminal call returns an error or when work feels stuck.',
    when_to_use: 'Load immediately when receiving any error response (429, TIMEOUT, INVALID_IDENTITY, WORKSPACE_UNAVAILABLE, NEXT_CALL_REQUIRED, etc.), when OpenAI ends a turn prematurely, or when a task seems too large for the current context window.',
    mode: 'inline',
    content: BUILTIN_ADAPTIVE_GUARD_CONTENT,
  }],
  // ADR-0052 §23③（#234）：workflow-authoring 随模块发布，零新安装面。
  // 正文与 skills/workflow-authoring/SKILL.md 逐字同文（issue-234 锁）——改任一处必须同步另一处。
  ['workflow-authoring', {
    name: 'workflow-authoring',
    description: `Load before writing or starting a workflow run — the script contract, fan-out shapes, write isolation, the reducer (汇总体) objective template and the polling rules. Reference only; reading it does not itself authorize running a workflow, which starts only when the user asks for one.`,
    when_to_use: `Load when the user asks for a workflow run — by naming workflows, or with a task that needs real breadth (wide research, a full-repo audit, a large sweep). If the user only names workflows with no task, ask what to run first instead of loading this and launching. Never load on your own initiative.`,
    mode: 'inline',
    content: WORKFLOW_AUTHORING_CONTENT,
  }],
]);

// --- Public API ---

/** List installed skills (metadata only, no content). Global overrides project-level. Built-in skills appear unless overridden by user files. */
export function listSkills(configDir: string, workspaceDir: string): SkillManifest[] {
  const project = scanDir(projectSkillsDir(workspaceDir));
  const global = scanDir(path.join(configDir, 'skills'));

  // Global overrides project level for same-name skills
  for (const [name, skill] of global) {
    project.set(name, skill);
  }

  const result = [...project.values()].map(({ manifest }) => manifest);

  // Inject built-in skills that are not overridden by user files
  for (const [name, record] of BUILTIN_SKILLS) {
    if (!project.has(name)) {
      result.push({ name: record.name, description: record.description, when_to_use: record.when_to_use, mode: record.mode });
    }
  }

  return result;
}

/** ADR-0031 #16：按 name 在某一 skills 基目录下解析，同时支持目录式（<name>/SKILL.md）与平铺式（<name>.md）。 */
function readSkillFromBase(baseDir: string, name: string): { manifest: SkillManifest; content: string } | null {
  // 目录式优先
  const dirPath = path.join(baseDir, name, SKILL_FILE);
  if (existsSync(dirPath)) {
    const parsed = readSkillFile(dirPath);
    if (parsed) return parsed;
  }
  // 平铺式
  const flatPath = path.join(baseDir, `${name}.md`);
  if (existsSync(flatPath)) {
    const parsed = readSkillFile(flatPath);
    if (parsed) return parsed;
  }
  return null;
}

/** Load a skill's full content by name. Falls back to built-in skills if no user file is found. */
export function loadSkill(configDir: string, workspaceDir: string, name: string): SkillRecord | null {
  // Global first (global takes priority)
  const global = readSkillFromBase(path.join(configDir, 'skills'), name);
  if (global) return { ...global.manifest, content: global.content };

  // Fallback to project-level
  const project = readSkillFromBase(projectSkillsDir(workspaceDir), name);
  if (project) return { ...project.manifest, content: project.content };

  // Fallback to built-in skills
  const builtin = BUILTIN_SKILLS.get(name);
  if (builtin) return builtin;

  return null;
}
