import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SKILL_FILE = 'SKILL.md';
const MAX_SKILL_BYTES = 100_000; // 100KB
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{2,63}$/;
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 800;
const WHEN_TO_USE_MAX = 2000;

export type SkillManifest = {
  name: string;
  description: string;
  when_to_use: string;
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

function parseFrontmatter(markdown: string): ParsedMarkdown {
  const match = markdown.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, content: markdown };

  const raw = match[1];
  const content = markdown.slice(match[0].length);
  const frontmatter: Record<string, unknown> = {};

  // Parse line-by-line: key: value  or  key: [item, ...]
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();

    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Handle arrays: [item1, item2]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      if (!inner) {
        frontmatter[key] = [];
      } else {
        frontmatter[key] = inner.split(',').map((item) => {
          const t = item.trim();
          if ((t.startsWith('"') && t.endsWith('"')) ||
              (t.startsWith("'") && t.endsWith("'"))) {
            return t.slice(1, -1);
          }
          return t;
        });
      }
      continue;
    }

    frontmatter[key] = value;
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

  return { name, description, when_to_use };
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
