import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { SUBAGENT_PROVIDERS } from './types.js';
import type { SubagentProvider } from './types.js';

const SKILL_FILE = 'SKILL.md';
const MAX_SKILL_BYTES = 100_000; // 100KB
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{2,63}$/;
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 800;
const WHEN_TO_USE_MAX = 2000;

const SKILL_MODES = ['inline', 'fork'] as const;
// ADR-0031（#61）：派生自 types.ts 单源 SUBAGENT_PROVIDERS，禁止在此手抄 provider 列表
const FORK_PROVIDERS = SUBAGENT_PROVIDERS;
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
  provider?: SubagentProvider;
  model?: string;
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

function projectSkillPath(workspaceDir: string, name: string): string {
  return path.join(projectSkillsDir(workspaceDir), name, SKILL_FILE);
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
      // 嵌套字段（forkOptions 下的 provider/maxTurns/...）
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

    if (raw.provider !== undefined) {
      if (typeof raw.provider !== 'string' || !(FORK_PROVIDERS as readonly string[]).includes(raw.provider)) {
        console.warn(`[skills] "forkOptions.provider" must be one of ${FORK_PROVIDERS.join('/')} in ${sourcePath}`);
        return null;
      }
      parsed.provider = raw.provider as SkillForkOptions['provider'];
    }

    if (raw.model !== undefined) {
      if (typeof raw.model !== 'string' || !raw.model.trim()) {
        console.warn(`[skills] "forkOptions.model" must be a non-empty string in ${sourcePath}`);
        return null;
      }
      parsed.model = raw.model;
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
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return result;
  }

  for (const name of names) {
    const filePath = path.join(dir, name, SKILL_FILE);
    if (!existsSync(filePath)) continue;

    const parsed = readSkillFile(filePath);
    if (parsed) result.set(parsed.manifest.name, parsed);
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
- Step 2: Use subagent_start for each sub-objective with a focused objective and acceptanceCriteria.
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

const BUILTIN_SKILLS: Map<string, SkillRecord> = new Map([
  ['adaptive-guard', {
    name: 'adaptive-guard',
    description: 'Recovery strategies when encountering server limits, timeouts, turn interruptions, context overflow, or tool failures. Load this when any MyTerminal call returns an error or when work feels stuck.',
    when_to_use: 'Load immediately when receiving any error response (429, TIMEOUT, INVALID_IDENTITY, WORKSPACE_UNAVAILABLE, NEXT_CALL_REQUIRED, etc.), when OpenAI ends a turn prematurely, or when a task seems too large for the current context window.',
    mode: 'inline',
    content: BUILTIN_ADAPTIVE_GUARD_CONTENT,
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

/** Load a skill's full content by name. Falls back to built-in skills if no user file is found. */
export function loadSkill(configDir: string, workspaceDir: string, name: string): SkillRecord | null {
  // Global first (global takes priority)
  const globalPath = path.join(configDir, 'skills', name, SKILL_FILE);
  if (existsSync(globalPath)) {
    const parsed = readSkillFile(globalPath);
    if (parsed) return { ...parsed.manifest, content: parsed.content };
  }

  // Fallback to project-level
  const projectPath = projectSkillPath(workspaceDir, name);
  if (existsSync(projectPath)) {
    const parsed = readSkillFile(projectPath);
    if (parsed) return { ...parsed.manifest, content: parsed.content };
  }

  // Fallback to built-in skills
  const builtin = BUILTIN_SKILLS.get(name);
  if (builtin) return builtin;

  return null;
}
