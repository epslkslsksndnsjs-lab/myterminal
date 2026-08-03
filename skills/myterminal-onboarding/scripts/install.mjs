#!/usr/bin/env node
// install.mjs — one-command TUI installer for the myterminal-onboarding skill.
// Zero dependencies (pure Node). Default: auto-detect installed agents, press
// Enter to install to ALL of them. No arrow keys, no selection — just Enter.
// Flags for power users: --yes (no prompt) | --target <name> | --skills-dir <path> | --help.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SKILL_NAME = 'myterminal-onboarding';
const skillRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// Where each supported agent keeps its user-level skills dir.
const AGENTS = [
  { id: 'workbuddy', name: 'WorkBuddy',   dir: path.join(os.homedir(), '.workbuddy', 'skills') },
  { id: 'claude',    name: 'Claude Code', dir: path.join(os.homedir(), '.claude', 'skills') },
  { id: 'cursor',    name: 'Cursor',      dir: path.join(os.homedir(), '.cursor', 'skills') },
];

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', gray: '\x1b[90m',
};
const out = (s) => process.stdout.write(s + '\n');

function parseArgs() {
  const a = process.argv.slice(2);
  const r = { yes: false, help: false, targets: [], skillsDir: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--yes' || a[i] === '-y') r.yes = true;
    else if (a[i] === '--help' || a[i] === '-h') r.help = true;
    else if (a[i] === '--target') r.targets.push(a[++i]);
    else if (a[i] === '--skills-dir') r.skillsDir = a[++i];
    else if (a[i].startsWith('--target=')) r.targets.push(a[i].slice(9));
  }
  return r;
}

function resolveTargets(args) {
  if (args.skillsDir) return [{ id: 'custom', name: '自定义目录', dir: path.resolve(args.skillsDir) }];
  if (args.targets.length) {
    return args.targets.map((t) => {
      const m = AGENTS.find((x) => x.id === t);
      if (m) return m;
      out(`${c.red}未知 target: ${t}${c.reset}（支持: ${AGENTS.map((x) => x.id).join(', ')}）`);
      process.exit(1);
    });
  }
  const detected = AGENTS.filter((x) => fs.existsSync(x.dir));
  return detected.length ? detected : [AGENTS[0]];
}

function listFiles(src) {
  const acc = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) acc.push(p);
    }
  })(src);
  return acc;
}

function copyWithProgress(src, dest) {
  const files = listFiles(src);
  const total = files.length;
  fs.mkdirSync(dest, { recursive: true });
  let done = 0;
  for (const f of files) {
    const rel = path.relative(src, f);
    const o = path.join(dest, rel);
    fs.mkdirSync(path.dirname(o), { recursive: true });
    fs.copyFileSync(f, o);
    done++;
    const pct = total ? Math.round((done / total) * 100) : 100;
    const w = 20;
    const fill = Math.round((w * pct) / 100);
    const bar = '█'.repeat(fill) + '░'.repeat(w - fill);
    process.stdout.write(`\r  ${c.cyan}[${bar}]${c.reset} ${pct}%  ${path.basename(f)}`);
  }
  process.stdout.write('\n');
}

function selfTest(dest) {
  try {
    execFileSync(process.execPath, [path.join(dest, 'scripts', 'onboard.mjs'), '--self-test'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function waitEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    out('');
    out(`  ${c.dim}按 Enter 开始安装（Ctrl+C 取消）${c.reset}`);
    rl.once('line', () => { rl.close(); resolve(); });
    rl.once('SIGINT', () => process.exit(130));
  });
}

function showHelp() {
  out(`install.mjs — 安装 ${SKILL_NAME} 技能（一条命令 + 回车）`);
  out('');
  out('用法:');
  out('  node install.mjs                   # 检测 Agent，回车安装全部');
  out('  node install.mjs --yes             # 同上，无交互直接装');
  out('  node install.mjs --target claude   # 只装到指定 Agent');
  out('  node install.mjs --skills-dir <路径>');
  out('');
  out(`支持的 Agent: ${AGENTS.map((x) => x.id).join(', ')}`);
}

async function main() {
  const args = parseArgs();
  if (args.help) { showHelp(); return; }

  if (path.basename(skillRoot) !== SKILL_NAME || !fs.existsSync(path.join(skillRoot, 'SKILL.md'))) {
    out(`${c.red}install: 未在技能目录内运行（期望 ${SKILL_NAME} 且含 SKILL.md）${c.reset}`);
    process.exit(1);
  }

  const targets = resolveTargets(args);

  out('');
  out(`${c.bold}  MyTerminal 上手向导 · 安装 ${SKILL_NAME}${c.reset}`);
  out('  ' + '─'.repeat(40));
  out('');
  out('  将安装到以下 Agent：');
  for (const t of targets) out(`    ${c.green}•${c.reset} ${t.name}  ${c.gray}${t.dir}${c.reset}`);
  out('');

  const interactive = Boolean(process.stdin.isTTY) && !args.yes;
  if (interactive) await waitEnter();

  for (const t of targets) {
    const dest = path.join(t.dir, SKILL_NAME);
    out(`  ${c.bold}▸ ${t.name}${c.reset}`);
    copyWithProgress(skillRoot, dest);
    const ok = selfTest(dest);
    out(ok
      ? `  ${c.green}✓ 已安装 → ${dest}${c.reset}`
      : `  ${c.yellow}⚠ 已复制，但自检未通过，请检查后重试${c.reset}`);
    out('');
  }

  out(`${c.green}✅ 安装完成！${c.reset} 在 Agent 中输入指令即可开始配置：`);
  out(`   ${c.cyan}/myterminal-onboarding${c.reset}`);
  out('');
}

main().catch((err) => { out(`${c.red}install: ${err?.message ?? err}${c.reset}`); process.exit(1); });
