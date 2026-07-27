import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// ═══════════════════════════════════════════════════════════
// 全项目变异测试：36 个变异点覆盖 12 个核心模块
// ═══════════════════════════════════════════════════════════
const mutations = [
  // ── src/extensions.ts (3) ──
  { name: 'EXT-1: policy classification removed', file: 'src/extensions.ts', find: "isPolicyRejection ? 'policy_rejected' : 'failed'", replace: "'failed'" },
  { name: 'EXT-2: alias key not deleted', file: 'src/extensions.ts', find: '      delete normalized[alias];\n', replace: '' },
  { name: 'EXT-3: finishAudit fallback disabled', file: 'src/extensions.ts', find: '(!finalError || !finalError.code)', replace: '(false)' },

  // ── src/store.ts (3) ──
  { name: 'STO-1: auditFact fallback removed', file: 'src/store.ts', find: "rawErrorCode || (status === 'failed' || status === 'timeout' ? 'UNKNOWN_ERROR' : undefined)", replace: 'rawErrorCode' },
  { name: 'STO-2: terminal immutability removed (checkpoint)', file: 'src/store.ts', find: "if (TERMINAL_PHASES.has(session.phase)) throw new MyTerminalError('SESSION_TERMINAL', 'Terminal sessions are immutable; create a continuation session.')", replace: "if (false) throw new MyTerminalError('SESSION_TERMINAL', 'Terminal sessions are immutable; create a continuation session.')" },
  { name: 'STO-3: grandchild prevention removed', file: 'src/store.ts', find: "if (actor.parentSessionId) throw new MyTerminalError('MAX_SESSION_DEPTH', 'Child sessions cannot delegate another session.')", replace: "if (false) throw new MyTerminalError('MAX_SESSION_DEPTH', 'Child sessions cannot delegate another session.')" },

  // ── src/core-tools.ts (2) ──
  { name: 'CTL-1: wrong alias mapping', file: 'src/core-tools.ts', find: "aliases: { pattern: 'query' }", replace: "aliases: { pattern: 'path' }", all: true },
  { name: 'CTL-2: output truncation disabled', file: 'src/core-tools.ts', find: 'maxOutputChars', replace: 'maxOutputCharsDisabled', all: true },

  // ── src/config.ts (4) ──
  { name: 'CFG-1: boundedInteger clamp disabled', file: 'src/config.ts', find: 'return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;', replace: 'return Number.isFinite(parsed) ? parsed : fallback;' },
  { name: 'CFG-2: provider validation skipped', file: 'src/config.ts', find: "!VALID_PROVIDERS.includes(sub.provider)", replace: "false" },
  { name: 'CFG-3: credential length check removed', file: 'src/config.ts', find: 'settings.connectorKey.length < 24 || settings.actionsToken.length < 24', replace: 'false' },
  { name: 'CFG-4: port feasibility always skipped', file: 'src/config.ts', find: 'settings.port === 0', replace: 'true' },

  // ── src/cluster.ts (3) ──
  { name: 'CLU-1: protocol version check removed', file: 'src/cluster.ts', find: 'item.protocolVersion !== record.protocolVersion', replace: 'false' },
  { name: 'CLU-2: heartbeat timestamp frozen', file: 'src/cluster.ts', find: 'const refreshed = { ...this.localMember, heartbeatAt: new Date().toISOString() };', replace: 'const refreshed = { ...this.localMember };' },
  { name: 'CLU-3: prune never removes stale members', file: 'src/cluster.ts', find: 'if (Date.parse(member.heartbeatAt) < cutoff) return false;', replace: 'if (false) return false;' },

  // ── src/security.ts (3) ──
  { name: 'SEC-1: safeEqual always true', file: 'src/security.ts', find: 'return timingSafeEqual(leftHash, rightHash);', replace: 'return true;' },
  { name: 'SEC-2: path traversal check disabled', file: 'src/security.ts', find: "if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path escapes workspace: ${input}`);", replace: "if (false) throw new Error(`Path escapes workspace: ${input}`);" },
  { name: 'SEC-3: schema required check skipped', file: 'src/security.ts', find: 'for (const required of schema.required ?? []) if (!(required in object)) errors.push(`${label}.${required} is required`);', replace: 'for (const required of schema.required ?? []) if (false) errors.push(`${label}.${required} is required`);' },

  // ── src/skills.ts (3) ──
  { name: 'SKL-1: empty fork content check disabled', file: 'src/skills.ts', find: "if (manifest.mode === 'fork' && !content.trim())", replace: "if (false)" },
  { name: 'SKL-2: forkOptions maxTurns upper bound removed', file: 'src/skills.ts', find: "if (!Number.isInteger(num) || num < min || num > max)", replace: "if (!Number.isInteger(num) || num < min || false)" },
  { name: 'SKL-3: invalid mode accepted', file: 'src/skills.ts', find: 'console.warn(`[skills] Invalid "mode" (must be inline|fork) in ${sourcePath}`);', replace: '/* mutation: skip warning */' },

  // ── src/subagent/permissions.ts (3) ──
  { name: 'PER-1: DANGEROUS never matches', file: 'src/subagent/permissions.ts', find: 'if (DANGEROUS_PATTERNS.test(strippedFull)) return \'deny\';', replace: 'if (false) return \'deny\';' },
  { name: 'PER-2: readOnly deny disabled', file: 'src/subagent/permissions.ts', find: "if (readOnly) return 'deny';", replace: "if (false) return 'deny';" },
  { name: 'PER-3: sub-command DANGEROUS check skipped', file: 'src/subagent/permissions.ts', find: 'if (DANGEROUS_PATTERNS.test(stripped)) return \'deny\';', replace: 'if (false) return \'deny\';' },

  // ── src/subagent/tool-executor.ts (3) ──
  { name: 'TEX-1: MAX_PARALLEL unlimited', file: 'src/subagent/tool-executor.ts', find: 'const MAX_PARALLEL = 5;', replace: 'const MAX_PARALLEL = 9999;' },
  { name: 'TEX-2: schema validation always passes', file: 'src/subagent/tool-executor.ts', find: 'const schemaResult = validateSchema(call.input, tool.inputSchema);', replace: 'const schemaResult = { ok: true, errors: [] };' },
  { name: 'TEX-3: partition merge disabled (always new batch)', file: 'src/subagent/tool-executor.ts', find: 'if (lastBatch?.isConcurrencySafe && lastBatch.calls.length < MAX_PARALLEL)', replace: 'if (false)' },

  // ── src/subagent/executor.ts (3) ──
  { name: 'EXE-1: maxTurns check disabled (infinite loop)', file: 'src/subagent/executor.ts', find: 'while (turns < settings.maxTurns)', replace: 'while (turns < 999999)' },
  { name: 'EXE-2: abort signal ignored', file: 'src/subagent/executor.ts', find: 'if (signal.aborted) return finishAborted();', replace: 'if (false) return finishAborted();' },
  { name: 'EXE-3: timeout signal never fires', file: 'src/subagent/executor.ts', find: 'const timeoutSignal = AbortSignal.timeout(settings.timeoutSec * 1000);', replace: 'const timeoutSignal = AbortSignal.timeout(999999999);' },

  // ── src/subagent/llm-adapter.ts (3) ──
  { name: 'LLM-1: 429 classified as system (not rate_limit)', file: 'src/subagent/llm-adapter.ts', find: "return new LlmError('rate_limit', 'Rate limit exceeded. Please wait before retrying.', status, retryAfterMs);", replace: "return new LlmError('system', 'Rate limit exceeded. Please wait before retrying.', status, retryAfterMs);" },
  { name: 'LLM-2: auth errors classified as rate_limit (would retry)', file: 'src/subagent/llm-adapter.ts', find: "return new LlmError('auth', 'API key is invalid or expired. Please check your environment variable.', status);", replace: "return new LlmError('rate_limit', 'API key is invalid or expired. Please check your environment variable.', status);" },
  { name: 'LLM-3: 529 not classified as server_overload', file: 'src/subagent/llm-adapter.ts', find: "return new LlmError('server_overload', 'Server is overloaded. Consider switching to a fallback model.', status);", replace: "return new LlmError('system', 'Server is overloaded. Consider switching to a fallback model.', status);" },
];

let killedByTest = 0;
let killedByBuild = 0;
let survived = 0;
const results = [];

for (const m of mutations) {
  const orig = readFileSync(m.file, 'utf8');
  const mutated = m.all ? orig.split(m.find).join(m.replace) : orig.replace(m.find, m.replace);
  if (mutated === orig) {
    results.push({ name: m.name, status: 'ERROR: find string not matched' });
    continue;
  }
  writeFileSync(m.file, mutated);
  try {
    execSync('bun run build 2>&1', { stdio: 'pipe' });
  } catch {
    killedByBuild++;
    results.push({ name: m.name, status: 'KILLED (build error)' });
    writeFileSync(m.file, orig);
    continue;
  }
  try {
    const out = execSync('bun test --timeout 120000 test/*.test.mjs 2>&1', { stdio: 'pipe', encoding: 'utf8' });
    const passMatch = out.match(/(\d+) pass/);
    const failMatch = out.match(/(\d+) fail/);
    const passes = passMatch ? parseInt(passMatch[1]) : 0;
    const fails = failMatch ? parseInt(failMatch[1]) : 0;
    if (fails > 0) {
      killedByTest++;
      results.push({ name: m.name, status: `KILLED (test: ${fails} fail)` });
    } else {
      survived++;
      results.push({ name: m.name, status: `SURVIVED (${passes} pass / 0 fail)` });
    }
  } catch (e) {
    killedByTest++;
    const out = e.stdout?.toString() || '';
    const failMatch = out.match(/(\d+) fail/);
    results.push({ name: m.name, status: `KILLED (test exited: ${failMatch ? failMatch[1] + ' fail' : 'nonzero'})` });
  }
  writeFileSync(m.file, orig);
}

// 恢复正确状态
execSync('bun run build 2>&1', { stdio: 'pipe' });

const total = results.length;
const killed = killedByTest + killedByBuild;
console.log('\n=== 变异测试结果 ===');
for (const r of results) console.log(`  ${r.status.padEnd(28)} | ${r.name}`);
console.log(`\n总变异: ${total}`);
console.log(`被测试杀死: ${killedByTest}`);
console.log(`被编译杀死: ${killedByBuild}`);
console.log(`存活: ${survived}`);
console.log(`Mutation score (测试捕获): ${killedByTest}/${total} = ${total ? (killedByTest/total*100).toFixed(1) : 0}%`);
console.log(`Mutation score (含编译): ${killed}/${total} = ${total ? (killed/total*100).toFixed(1) : 0}%`);
