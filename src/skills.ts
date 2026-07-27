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
const FORK_PROVIDERS = ['openai', 'anthropic', 'deepseek', 'glm'] as const;
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
  provider?: 'openai' | 'anthropic' | 'deepseek' | 'glm';
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

// --- Public API ---

/** List installed skills (metadata only, no content). Global overrides project-level. */
export function listSkills(configDir: string, workspaceDir: string): SkillManifest[] {
  const project = scanDir(projectSkillsDir(workspaceDir));
  const global = scanDir(path.join(configDir, 'skills'));

  // Global overrides project level for same-name skills
  for (const [name, skill] of global) {
    project.set(name, skill);
  }

  return [...project.values()].map(({ manifest }) => manifest);
}

/** Load a skill's full content by name. Returns null if not found. */
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

  return null;
}
