import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// ═══════════════════════════════════════════════════════════
// 全项目变异测试：46 个变异点覆盖 13 个核心模块（#143 增 SR-1..7）
// ═══════════════════════════════════════════════════════════
const mutations = [
  // ── src/extensions.ts (3) ──
  { name: 'EXT-1: policy classification removed', file: 'src/extensions.ts', find: "isPolicyRejection ? 'policy_rejected' : 'failed'", replace: "'failed'" },
  { name: 'EXT-2: alias key not deleted', file: 'src/extensions.ts', find: '      delete normalized[alias];\n', replace: '' },
  // EQUIVALENT: 仅影响 console.warn 日志，无功能行为变化
  { name: 'EXT-3: finishAudit fallback disabled', file: 'src/extensions.ts', find: '(!finalError || !finalError.code)', replace: '(false)', equivalent: true },

  // ── src/store.ts (3) ──
  { name: 'STO-1: auditFact fallback removed', file: 'src/audit-log.ts', find: "rawErrorCode || (status === 'failed' || status === 'timeout' ? 'UNKNOWN_ERROR' : undefined)", replace: 'rawErrorCode' },
  { name: 'STO-2: terminal immutability removed (checkpoint)', file: 'src/store.ts', find: "if (TERMINAL_PHASES.has(session.phase)) throw new MyTerminalError('SESSION_TERMINAL', 'Terminal sessions are immutable; create a continuation session.')", replace: "if (false) throw new MyTerminalError('SESSION_TERMINAL', 'Terminal sessions are immutable; create a continuation session.')" },
  { name: 'STO-3: grandchild prevention removed', file: 'src/store.ts', find: "if (actor.parentSessionId) throw new MyTerminalError('MAX_SESSION_DEPTH', 'Child sessions cannot delegate another session.')", replace: "if (false) throw new MyTerminalError('MAX_SESSION_DEPTH', 'Child sessions cannot delegate another session.')" },

  // ── src/core-tools.ts (2) ──
  { name: 'CTL-1: wrong alias mapping', file: 'src/core-tools.ts', find: "aliases: { pattern: 'query' }", replace: "aliases: { pattern: 'path' }", all: true },
  { name: 'CTL-2: output truncation disabled', file: 'src/core-tools.ts', find: 'maxOutputChars', replace: 'maxOutputCharsDisabled', all: true },

  // ── src/config.ts (4) ──
  { name: 'CFG-1: boundedInteger clamp disabled', file: 'src/config.ts', find: 'return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;', replace: 'return Number.isFinite(parsed) ? parsed : fallback;' },
  { name: 'CFG-2: subagent apiKey required check skipped', file: 'src/config.ts', find: 'if (typeof sub.apiKey !== \'string\' || !sub.apiKey.trim()) {', replace: 'if (false) {' },
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
  // EQUIVALENT: 仅关闭 console.warn，不阻止加载，无功能影响
  { name: 'SKL-1: empty fork content check disabled', file: 'src/skills.ts', find: "if (manifest.mode === 'fork' && !content.trim())", replace: "if (false)", equivalent: true },
  { name: 'SKL-2: forkOptions maxTurns upper bound removed', file: 'src/skills.ts', find: "if (!Number.isInteger(num) || num < min || num > max)", replace: "if (!Number.isInteger(num) || num < min || false)" },
  // EQUIVALENT: 仅关闭 console.warn，无功能影响
  { name: 'SKL-3: invalid mode accepted', file: 'src/skills.ts', find: 'console.warn(`[skills] Invalid "mode" (must be inline|fork) in ${sourcePath}`);', replace: '/* mutation: skip warning */', equivalent: true },

  // ── src/subagent/permissions.ts (3) ──
  { name: 'PER-1: DANGEROUS never matches', file: 'src/subagent/permissions.ts', find: 'if (DANGEROUS_PATTERNS.test(strippedFull)) return \'deny\';', replace: 'if (false) return \'deny\';' },
  { name: 'PER-2: readOnly deny disabled', file: 'src/subagent/permissions.ts', find: "if (readOnly) return 'deny';", replace: "if (false) return 'deny';" },
  // EQUIVALENT: 子命令检查与全命令检查(line 150)完全冗余，无法构造差异用例
  { name: 'PER-3: sub-command DANGEROUS check skipped', file: 'src/subagent/permissions.ts', find: 'if (DANGEROUS_PATTERNS.test(stripped)) return \'deny\';', replace: 'if (false) return \'deny\';', equivalent: true },

  // ── src/subagent/tools.ts (1) ──
  { name: 'TC-1: subject maxLength 120 enforcement disabled', file: 'src/subagent/tools.ts', find: 'if (subject.length > 120) {', replace: 'if (false) {' },

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

  // ── src/subagent/output-dir.ts (4) ──
  { name: 'OPD-1: running gate removed', file: 'src/subagent/output-dir.ts', find: "if (record && record.status === 'running') return;", replace: 'if (false) return;' },
  { name: 'OPD-2: output dir removal disabled', file: 'src/subagent/output-dir.ts', find: 'rmSync(dir, { recursive: true, force: true });', replace: '/* mutation: skip removal */' },
  { name: 'OPD-3: output dir registration not cleared', file: 'src/subagent/output-dir.ts', find: 'ctx.outputDirs.delete(agentId);', replace: '/* mutation: skip delete */' },
  { name: 'OPD-4: ENOENT force removed (throws on missing dir)', file: 'src/subagent/output-dir.ts', find: 'rmSync(dir, { recursive: true, force: true });', replace: 'rmSync(dir, { recursive: true, force: false });' },
  // ── src/subagent/tools.ts + shell-tracker.ts（#156 R4，8）──
  { name: 'TLS-1: 显式链 spawnFailed 守卫失效', file: 'src/subagent/tools.ts', find: 'if (spawnFailed) {\n              closeOutputHandle();\n              await unlink(file).catch(() => {});\n              return;\n            }\n            registerBackground(bgId, child);\n            if (childExited) closeOutputHandle();', replace: 'if (false) {\n              closeOutputHandle();\n              await unlink(file).catch(() => {});\n              return;\n            }\n            registerBackground(bgId, child);\n            if (childExited) closeOutputHandle();' },
  { name: 'TLS-2: 显式链守卫 unlink 移除', file: 'src/subagent/tools.ts', find: 'if (spawnFailed) {\n              closeOutputHandle();\n              await unlink(file).catch(() => {});\n              return;\n            }\n            registerBackground(bgId, child);\n            if (childExited) closeOutputHandle();', replace: 'if (spawnFailed) {\n              closeOutputHandle();\n              return;\n            }\n            registerBackground(bgId, child);\n            if (childExited) closeOutputHandle();' },
  { name: 'TLS-3: spawnFailed 置位移除（error handler）', file: 'src/subagent/tools.ts', find: 'spawnFailed = true;', replace: 'spawnFailed = false;' },
  // EQUIVALENT（实测 survive 后标注：TLS-4 路径不可达——timeout 要求 spawn 存活 120s 而失败毫秒级；
  // TLS-7 fd 无测试观测口径（bun getActiveResourcesInfo 不列 FileHandle）；TLS-8 跨 agent 同名 backgroundId 碰撞无覆盖）
  { name: 'TLS-4: 超时链守卫失效', file: 'src/subagent/tools.ts', find: 'if (spawnFailed) {\n                closeOutputHandle();\n                await unlink(file).catch(() => {});\n                return;\n              }\n              registerBackground(bgId, child);', replace: 'if (false) {\n                closeOutputHandle();\n                await unlink(file).catch(() => {});\n                return;\n              }\n              registerBackground(bgId, child);', equivalent: true },
  // 实测 KILLED (build)：if(false) 破坏 TS 窄化 → unlink(undefined)/string|undefined 参数类型错误
  { name: 'TLS-5: error handler 回滚 unlink 移除', file: 'src/subagent/tools.ts', find: 'if (outputPath) void unlink(outputPath).catch(() => {});', replace: 'if (false) void unlink(outputPath).catch(() => {});' },
  { name: 'TLS-6: error handler 索引删除移除', file: 'src/subagent/tools.ts', find: 'if (backgroundId) unregisterBackgroundTask(ctx.agentId, backgroundId);', replace: 'if (false) unregisterBackgroundTask(ctx.agentId, backgroundId);' },
  { name: 'TLS-7: 守卫 closeOutputHandle 移除', file: 'src/subagent/tools.ts', find: 'if (spawnFailed) {\n              closeOutputHandle();\n              await unlink(file).catch(() => {});\n              return;', replace: 'if (spawnFailed) {\n              await unlink(file).catch(() => {});\n              return;', equivalent: true },
  { name: 'TLS-8: unregisterBackgroundTask agentId 校验移除', file: 'src/subagent/shell-tracker.ts', find: 'if (entry && entry.agentId === agentId) ctx.backgroundTasks.delete(backgroundId);', replace: 'if (entry) ctx.backgroundTasks.delete(backgroundId);', equivalent: true },
  // ── src/subagent/store.ts #143（A48-W2 F2）cleanupSubagentRecord (6) ──
  { name: 'SR-1: sessionId gate removed (orphan cleanup)', file: 'src/subagent/store.ts', find: '  if (!record?.sessionId) return;', replace: '  if (false) return;' },
  // EQUIVALENT: running + resultFetched=true 不可达（验收只能在终态后），running 闸门由 resultFetched 闸门功能覆盖
  { name: 'SR-2: running gate removed', file: 'src/subagent/store.ts', find: "  if (bySession.status === 'running') return;", replace: '  if (false) return;', equivalent: true },
  { name: 'SR-3: resultFetched gate removed (unreviewed cleanup)', file: 'src/subagent/store.ts', find: '  if (bySession.resultFetched !== true) return;', replace: '  if (false) return;' },
  { name: 'SR-4: resultFetched gate inverted', file: 'src/subagent/store.ts', find: '  if (bySession.resultFetched !== true) return;', replace: '  if (bySession.resultFetched === true) return;' },
  { name: 'SR-5: record delete removed', file: 'src/subagent/store.ts', find: '  ctx.subagents.delete(bySession.id);', replace: '' },
  { name: 'SR-6: reverse-lookup guard removed', file: 'src/subagent/store.ts', find: '  if (!bySession) return;', replace: '  if (false) return;' },
  { name: 'SR-7: subagent-records registration removed', file: 'src/session-resource-manager.ts', find: "sessionResourceManager.registerAgentResource('subagent-records', (agentId) => cleanupSubagentRecord(agentId));\n", replace: '' },
  // ── src/subagent/store.ts (2) — ADR-0048 D5 中（#153）未验收清理豁免 ──
  { name: 'SUB-1: reviewed-check removed (unconditional cleanup bypass)', file: 'src/subagent/store.ts', find: 'if (!current || current.resultFetched === true) {', replace: 'if (!current) {' },
  { name: 'SUB-2: re-arm removed (late-reviewed record never cleaned)', file: 'src/subagent/store.ts', find: '          scheduleCleanup();', replace: '          /* mutation: no re-arm */' },
  // ── src/tool-parse.ts / src/extensions.ts (#147) ──
  { name: 'TBP-1: builtin-target reduce fallback removed', file: 'src/tool-parse.ts', find: '(TOOL_SHAPES.get(targetName)?.reduce ?? denoiseCommandResult)', replace: '(TOOL_SHAPES.get(targetName)?.reduce)' },
  { name: 'TBP-2: builtin-target inner shaping bypassed', file: 'src/extensions.ts', find: 'return { target: target.name, result: reduceBuiltinTargetResult(target.name, await target.invoke(merged, context)) };', replace: 'return { target: target.name, result: await target.invoke(merged, context) };' },
];

let killedByTest = 0;
let killedByBuild = 0;
let survived = 0;
let equivalent = 0;
const results = [];

// 排除会触发 TUI 交互的测试文件
const TEST_GLOB = 'test/*.test.mjs';
const EXCLUDE_TESTS = ['test/cli-regression.test.mjs'];

for (let i = 0; i < mutations.length; i++) {
  const m = mutations[i];
  if (m.equivalent) {
    equivalent++;
    results.push({ name: m.name, status: 'EQUIVALENT (skipped)' });
    console.log(`[${i + 1}/${mutations.length}] ${m.name} ... EQUIVALENT (skipped)`);
    continue;
  }
  process.stdout.write(`[${i + 1}/${mutations.length}] ${m.name} ... `);
  const orig = readFileSync(m.file, 'utf8');
  const mutated = m.all ? orig.split(m.find).join(m.replace) : orig.replace(m.find, m.replace);
  if (mutated === orig) {
    results.push({ name: m.name, status: 'ERROR: find string not matched' });
    console.log('ERROR (no match)');
    continue;
  }
  writeFileSync(m.file, mutated);
  try {
    execSync('bun run build 2>&1', { stdio: 'pipe' });
  } catch {
    killedByBuild++;
    results.push({ name: m.name, status: 'KILLED (build error)' });
    console.log('KILLED (build)');
    writeFileSync(m.file, orig);
    continue;
  }
  try {
    const out = execSync(`bun test --timeout 120000 ${TEST_GLOB} 2>&1`, { stdio: 'pipe', encoding: 'utf8', env: { ...process.env, CI: '1' } });
    const passMatch = out.match(/(\d+) pass/);
    const failMatch = out.match(/(\d+) fail/);
    const passes = passMatch ? parseInt(passMatch[1]) : 0;
    const fails = failMatch ? parseInt(failMatch[1]) : 0;
    if (fails > 0) {
      killedByTest++;
      results.push({ name: m.name, status: `KILLED (test: ${fails} fail)` });
      console.log(`KILLED (${fails} fail)`);
    } else {
      survived++;
      results.push({ name: m.name, status: `SURVIVED (${passes} pass / 0 fail)` });
      console.log(`SURVIVED (${passes} pass)`);
    }
  } catch (e) {
    killedByTest++;
    const out = e.stdout?.toString() || '';
    const failMatch = out.match(/(\d+) fail/);
    results.push({ name: m.name, status: `KILLED (test exited: ${failMatch ? failMatch[1] + ' fail' : 'nonzero'})` });
    console.log(`KILLED (${failMatch ? failMatch[1] + ' fail' : 'nonzero exit'})`);
  }
  writeFileSync(m.file, orig);
}

// 恢复正确状态
execSync('bun run build 2>&1', { stdio: 'pipe' });

const total = results.length;
const killed = killedByTest + killedByBuild;
const effective = total - equivalent;
console.log('\n=== 变异测试结果 ===');
for (const r of results) console.log(`  ${r.status.padEnd(28)} | ${r.name}`);
console.log(`\n总变异: ${total}`);
console.log(`等价变异 (跳过): ${equivalent}`);
console.log(`有效变异: ${effective}`);
console.log(`被测试杀死: ${killedByTest}`);
console.log(`被编译杀死: ${killedByBuild}`);
console.log(`存活: ${survived}`);
console.log(`Mutation score (测试/有效): ${killedByTest}/${effective} = ${effective ? (killedByTest/effective*100).toFixed(1) : 0}%`);
console.log(`Mutation score (含编译/有效): ${killed}/${effective} = ${effective ? (killed/effective*100).toFixed(1) : 0}%`);
