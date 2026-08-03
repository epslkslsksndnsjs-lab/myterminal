#!/usr/bin/env node
// install.mjs — install the myterminal-onboarding skill into the user's skills dir.
//
// This is the local equivalent of `npx skills add <repo>` for a skill that is NOT
// published to a skills registry. The reference skill (mattpocock/skills) is copied
// into the agent's skills directory by skills.sh; we do the same copy ourselves,
// self-locating from this file so it works no matter where it is run from.
//
// Idempotent: re-running just overwrites with the current copy (no duplicates, no
// stale leftovers). Safe to run after every update to the skill.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SKILL_NAME = 'myterminal-onboarding';
const skillRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const targetDir = path.join(os.homedir(), '.workbuddy', 'skills', SKILL_NAME);

function info(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`install: ${msg}\n`);
  process.exit(1);
}

// 1. Sanity: this file must live inside the skill it installs.
if (path.basename(skillRoot) !== SKILL_NAME) {
  fail(`expected to live in a "${SKILL_NAME}" directory, but found "${skillRoot}".`);
}
if (!fs.existsSync(path.join(skillRoot, 'SKILL.md'))) {
  fail(`SKILL.md not found in ${skillRoot} — wrong source directory.`);
}

// 2. Copy the whole skill folder into the user's skills dir, overwriting.
try {
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(skillRoot, targetDir, { recursive: true, force: true });
} catch (err) {
  fail(`failed to copy into ${targetDir}: ${err instanceof Error ? err.message : String(err)}`);
}

info(`✓ Installed ${SKILL_NAME} -> ${targetDir}`);

// 3. Verify the deployed copy is not stale (review-gap #4 self-check).
try {
  execFileSync(process.execPath, [path.join(targetDir, 'scripts', 'onboard.mjs'), '--self-test'], {
    stdio: 'inherit',
  });
} catch {
  info('⚠ self-test reported a problem. Re-run after fixing, or remove the copy and try again.');
  process.exit(1);
}

info('');
info('Next: launch your agent, then invoke the skill by name:');
info('  /myterminal-onboarding');
info('');
info('Or run it directly to see the available commands:');
info(`  node ${path.join(targetDir, 'scripts', 'onboard.mjs')} --help`);
