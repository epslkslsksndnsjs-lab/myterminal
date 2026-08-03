#!/usr/bin/env node
/**
 * check-provider-sync.mjs — CI guardrail (review-gap #4, plan B).
 *
 * The skill's SUPPORTED_PROVIDERS must stay in lockstep with the providers that
 * createAdapter actually supports in the main repo. If someone adds a 6th provider
 * to src/subagent/llm-adapter.ts but forgets to update the skill, this script fails
 * CI instead of letting a stale skill copy silently reject the new provider at runtime.
 *
 * Source of truth: the SUBAGENT_PROVIDERS const in src/types.ts:185 — the closed
 * provider list (the runtime adapter in llm-adapter.ts echoes it). Skill copy: the
 * `provider: '...'` entries in SUPPORTED_PROVIDERS.
 *
 * Usage (from repo root):  node skills/myterminal-onboarding/scripts/check-provider-sync.mjs
 * Exits 0 if the two sets match, 1 otherwise. Fails safe: if the repo source isn't
 * found (e.g. run from an installed copy with no repo), it exits 1, never a false pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// skills/<name>/scripts -> repo root is three levels up.
const repoRoot = path.resolve(here, '..', '..', '..');

const typesPath = path.join(repoRoot, 'src', 'types.ts');
const skillPath = path.join(here, 'onboard.mjs');

function fail(msg) {
  process.stderr.write(`check-provider-sync: ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(typesPath)) {
  fail(`cannot find ${typesPath} — run this from the MyTerminal repo root (not an installed copy).`);
}
if (!fs.existsSync(skillPath)) fail(`cannot find ${skillPath}`);

const typesSrc = fs.readFileSync(typesPath, 'utf8');
const skillSrc = fs.readFileSync(skillPath, 'utf8');

// Repo: parse the SUBAGENT_PROVIDERS const in src/types.ts:185 — the closed list.
const listMatch = typesSrc.match(/SUBAGENT_PROVIDERS\s*=\s*\[([^\]]+)\]/);
if (!listMatch) fail('could not find SUBAGENT_PROVIDERS in src/types.ts');
const repoProviders = [...listMatch[1].matchAll(/'([^']+)'/g)]
  .map((m) => m[1])
  .sort();

// Skill: parse `provider: 'x'` entries inside SUPPORTED_PROVIDERS.
const skillProviders = [...skillSrc.matchAll(/provider:\s*'([^']+)'/g)]
  .map((m) => m[1])
  .sort();

const repoSet = new Set(repoProviders);
const skillSet = new Set(skillProviders);
const missing = repoProviders.filter((p) => !skillSet.has(p));
const extra = skillProviders.filter((p) => !repoSet.has(p));

if (missing.length || extra.length) {
  process.stderr.write(
    `Provider lists diverged.\n` +
      `  repo  (types.ts): ${repoProviders.join(', ') || '(none)'}\n` +
      `  skill (onboard.mjs)   : ${skillProviders.join(', ') || '(none)'}\n` +
      (missing.length ? `  missing in skill  : ${missing.join(', ')}\n` : '') +
      (extra.length ? `  extra in skill    : ${extra.join(', ')}\n` : ''),
  );
  fail('update SUPPORTED_PROVIDERS in onboard.mjs to match the repo, then re-run.');
}

process.stdout.write(
  `check-provider-sync: OK — ${repoProviders.length} providers in sync (${repoProviders.join(', ')})\n`,
);
process.exit(0);
