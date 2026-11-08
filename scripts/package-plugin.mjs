#!/usr/bin/env node
// Builds and validates the ChatGPT plugin directory package (the third channel).
// Pure addition: the Actions (openapi.json) and Apps/MCP (/mcp/:key) channels are untouched.
//
// Usage: bun scripts/package-plugin.mjs
// Validates packaging/plugin/ against the OpenAI Agent Plugins field reference,
// then zips it into packaging/myterminal-plugin.zip ready for upload.
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgDir = join(repoRoot, 'packaging', 'plugin');
const outZip = join(repoRoot, 'packaging', 'myterminal-plugin.zip');

const errors = [];
const warnings = [];

function fail(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

function readJson(rel) {
  const p = join(pkgDir, rel);
  if (!existsSync(p)) { fail(`missing file: ${rel}`); return null; }
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { fail(`${rel}: invalid JSON (${e.message})`); return null; }
}

function checkStr(value, { field, max, pattern, patternHint, url, httpsOnly = true }) {
  if (typeof value !== 'string' || value.length === 0) { fail(`${field}: must be a non-empty string`); return; }
  if (max && value.length > max) fail(`${field}: ${value.length} chars exceeds limit ${max}`);
  if (pattern && !pattern.test(value)) fail(`${field}: ${patternHint || 'invalid format'} (got "${value}")`);
  if (url) {
    let u;
    try { u = new URL(value); } catch { fail(`${field}: not a valid URL (got "${value}")`); return; }
    if (httpsOnly && u.protocol !== 'https:') fail(`${field}: must be https (got "${value}")`);
  }
}

function containsPlaceholder(value) {
  return typeof value === 'string' && value.includes('REPLACE-WITH');
}

// ---------- plugin.json ----------
const plugin = readJson('plugin.json');
if (plugin) {
  if (plugin.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') {
    fail('plugin.json: $schema must be https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  }
  checkStr(plugin.name, { field: 'name', max: 64, pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/, patternHint: 'lowercase letters, digits, single hyphens' });
  checkStr(plugin.version, { field: 'version', max: 32 });
  checkStr(plugin.description, { field: 'description', max: 4000 });

  const author = plugin.author ?? {};
  checkStr(author.name, { field: 'author.name', max: 120 });
  if (author.url !== undefined) checkStr(author.url, { field: 'author.url', max: 2048, url: true });
  if (plugin.homepage !== undefined) checkStr(plugin.homepage, { field: 'homepage', max: 2048, url: true });
  if (plugin.repository !== undefined) checkStr(plugin.repository, { field: 'repository', max: 2048, url: true });

  const openai = plugin.extensions?.['com.openai'];
  if (!openai) { fail('plugin.json: extensions.com.openai is required'); }
  else {
    const ui = openai.interface ?? {};
    checkStr(ui.displayName, { field: 'interface.displayName', max: 30 });
    checkStr(ui.shortDescription, { field: 'interface.shortDescription', max: 30 });
    checkStr(ui.longDescription, { field: 'interface.longDescription', max: 4000 });
    checkStr(ui.developerName, { field: 'interface.developerName', max: 80 });
    checkStr(ui.category, { field: 'interface.category', max: 64 });
    if (!Array.isArray(ui.capabilities)) fail('interface.capabilities: must be an array');
    else {
      if (ui.capabilities.length > 20) fail(`interface.capabilities: ${ui.capabilities.length} items exceeds limit 20`);
      for (const [i, c] of ui.capabilities.entries()) checkStr(c, { field: `interface.capabilities[${i}]`, max: 120 });
    }
    for (const key of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
      checkStr(ui[key], { field: `interface.${key}`, max: 1024, url: true });
    }
    if (ui.defaultPrompt !== undefined) {
      if (!Array.isArray(ui.defaultPrompt)) fail('interface.defaultPrompt: must be an array');
      else {
        if (ui.defaultPrompt.length > 3) fail(`interface.defaultPrompt: ${ui.defaultPrompt.length} prompts exceeds limit 3`);
        const seen = new Set();
        for (const [i, p] of ui.defaultPrompt.entries()) {
          checkStr(p, { field: `interface.defaultPrompt[${i}]`, max: 128 });
          if (seen.has(p)) fail(`interface.defaultPrompt[${i}]: duplicates an earlier prompt`);
          seen.add(p);
        }
      }
    }
    for (const key of ['brandColor', 'brandColorDark']) {
      if (ui[key] !== undefined) checkStr(ui[key], { field: `interface.${key}`, pattern: /^#[0-9A-Fa-f]{6}$/, patternHint: 'must be #RRGGBB' });
    }
    for (const key of ['composerIcon', 'composerIconDark', 'logo', 'logoDark']) {
      if (ui[key] === undefined) continue;
      checkStr(ui[key], { field: `interface.${key}`, max: 256 });
      if (typeof ui[key] === 'string' && ui[key].startsWith('./')) {
        if (!existsSync(join(pkgDir, ui[key]))) fail(`interface.${key}: file not found (${ui[key]})`);
      }
    }

    // Onboarding skill
    if (openai.onboardingSkill !== undefined) {
      checkStr(openai.onboardingSkill, { field: 'onboardingSkill', max: 256 });
      if (typeof openai.onboardingSkill === 'string' && openai.onboardingSkill.startsWith('./')) {
        if (!existsSync(join(pkgDir, openai.onboardingSkill))) fail(`onboardingSkill: file not found (${openai.onboardingSkill})`);
      }
    }

    // Review
    const review = openai.review ?? {};
    const positive = review.test_cases?.positive ?? [];
    const negative = review.test_cases?.negative ?? [];
    if (positive.length < 5) fail(`review.test_cases.positive: ${positive.length} cases, initial MCP review needs 5`);
    if (negative.length < 3) fail(`review.test_cases.negative: ${negative.length} cases, initial MCP review needs 3`);
    for (const [i, c] of positive.entries()) {
      const where = `review.test_cases.positive[${i}]`;
      checkStr(c.description, { field: `${where}.description`, max: 4000 });
      checkStr(c.prompt, { field: `${where}.prompt`, max: 4000 });
      checkStr(c.tools_triggered, { field: `${where}.tools_triggered`, max: 512 });
      checkStr(c.expected_behavior, { field: `${where}.expected_behavior`, max: 4000 });
    }
    for (const [i, c] of negative.entries()) {
      const where = `review.test_cases.negative[${i}]`;
      checkStr(c.description, { field: `${where}.description`, max: 4000 });
      checkStr(c.prompt, { field: `${where}.prompt`, max: 4000 });
    }
    if (review.demo_recording_url !== undefined) {
      checkStr(review.demo_recording_url, { field: 'review.demo_recording_url', max: 1024, url: true });
      if (containsPlaceholder(review.demo_recording_url)) warn('review.demo_recording_url: still a REPLACE-WITH placeholder');
    }
    if (typeof review.commerce !== 'boolean') fail('review.commerce: must be a boolean');

    // Publication
    const pub = openai.publication ?? {};
    if (pub.countries !== undefined) {
      if (!Array.isArray(pub.countries)) fail('publication.countries: must be an array');
      else for (const [i, c] of pub.countries.entries()) checkStr(c, { field: `publication.countries[${i}]`, pattern: /^[A-Z]{2}$/, patternHint: 'uppercase 2-letter country code' });
    }
    if (pub.release_notes !== undefined) checkStr(pub.release_notes, { field: 'publication.release_notes', max: 4000 });
    if (pub.translations !== undefined && pub.translations !== null) {
      for (const [locale, t] of Object.entries(pub.translations)) {
        if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) fail(`publication.translations.${locale}: invalid locale key`);
        if (t.subtitle !== undefined && t.subtitle !== null) checkStr(t.subtitle, { field: `publication.translations.${locale}.subtitle`, max: 30 });
        if (t.description !== undefined && t.description !== null) checkStr(t.description, { field: `publication.translations.${locale}.description`, max: 4000 });
      }
    }
  }
}

// ---------- mcp.json ----------
const mcp = readJson('mcp.json');
if (mcp) {
  if (mcp.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json') {
    fail('mcp.json: $schema must be https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  }
  const servers = mcp.mcpServers ?? {};
  const names = Object.keys(servers);
  if (names.length !== 1) fail(`mcp.json: exactly one MCP server must be declared (found ${names.length})`);
  for (const [name, s] of Object.entries(servers)) {
    const where = `mcp.json.mcpServers.${name}`;
    if (s.type !== 'streamable-http') fail(`${where}.type: must be "streamable-http"`);
    checkStr(s.url, { field: `${where}.url`, max: 2048, url: true });
    if (containsPlaceholder(s.url)) warn(`${where}.url: still a REPLACE-WITH placeholder`);
    if (s.headers && Object.keys(s.headers).length > 0) fail(`${where}.headers: must be empty for public submissions`);
    if (s.clientSecret) fail(`${where}.clientSecret: must never be present in the package`);
    if (s.authentication && typeof s.authentication === 'object') {
      if (s.authentication.clientSecret) fail(`${where}.authentication.clientSecret: must never be present in the package`);
    }
  }
}

// ---------- placeholder sweep across the whole package ----------
function sweepPlaceholders(dir) {
  for (const entry of readdirSyncSafe(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { sweepPlaceholders(full); continue; }
    if (!entry.name.endsWith('.json')) continue;
    const text = readFileSync(full, 'utf8');
    const hits = text.match(/REPLACE-WITH[^\s"']*/g);
    if (hits) warn(`${entry.name}: placeholder(s) ${[...new Set(hits)].join(', ')}`);
  }
}
function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch { return []; }
}
sweepPlaceholders(pkgDir);

// ---------- build zip ----------
if (errors.length === 0) {
  if (existsSync(outZip)) rmSync(outZip);
  try {
    execFileSync('zip', ['-r', '-X', outZip, '.'], { cwd: pkgDir, stdio: 'pipe' });
    const listing = execFileSync('unzip', ['-l', outZip], { encoding: 'utf8' });
    for (const required of ['plugin.json', 'mcp.json', 'skills/get-started/SKILL.md', 'assets/icon.svg']) {
      if (!listing.includes(required)) fail(`zip is missing ${required}`);
    }
  } catch (e) {
    fail(`zip build failed: ${e.message}`);
  }
}

// ---------- report ----------
console.log('MyTerminal plugin package check');
console.log('================================');
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
if (errors.length === 0) {
  console.log(`\nOK    package valid -> ${outZip}`);
  console.log('Next: fill every placeholder, re-run this script, then follow packaging/plugin/SUBMISSION.md');
} else {
  console.log(`\nFAILED ${errors.length} error(s)`);
}
process.exit(errors.length === 0 ? 0 : 1);
