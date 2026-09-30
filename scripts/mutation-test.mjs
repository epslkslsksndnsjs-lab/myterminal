import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// ═══════════════════════════════════════════════════════════
// 全项目变异测试：变异点覆盖 13 个核心模块（计数见下方条目实测）
// ═══════════════════════════════════════════════════════════
const mutations = [
  // ── src/openapi.ts (3) ──
  { name: 'OPEN-1: pool aggregation skips subagent_start', file: 'src/openapi.ts', find: 'for (const schema of Object.values(BUILTIN_INPUT_SCHEMAS)) {', replace: 'for (const schema of Object.values(BUILTIN_INPUT_SCHEMAS)) { if ((schema as { properties?: Record<string, unknown> }).properties?.objective) continue;' },
  { name: 'OPEN-2: union drops maxLength merge', file: 'src/openapi.ts', find: "minKeyword('minLength'); maxKeyword('maxLength');", replace: "minKeyword('minLength');" },
  { name: 'OPEN-3: TaskPackage not derived', file: 'src/openapi.ts', find: 'const taskPackage = objectSchema(taskSource.properties, taskSource.required ?? [], taskSource.additionalProperties);', replace: 'const taskPackage = objectSchema({});' },

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
  { name: 'OPD-3: output dir registration not cleared', file: 'src/subagent/output-dir.ts', find: 'ctx.outputDirs.delete(agentId);', replace: '/* mutation: skip delete */', all: true },
  { name: 'OPD-4: ENOENT force removed (throws on missing dir)', file: 'src/subagent/output-dir.ts', find: 'rmSync(dir, { recursive: true, force: true });', replace: 'rmSync(dir, { recursive: true, force: false });', all: true },
  // ── src/subagent/tools.ts + shell-tracker.ts（#156 R4，8）──
  { name: 'TLS-1: backgroundize 守卫失效', file: 'src/subagent/tools.ts', find: 'if (spawnFailed || child.killed) {\n              closeOutputHandle();\n              await unlink(file).catch(() => {});\n              return;\n            }\n            registerBackground(bgId, child);\n            if (childExited) closeOutputHandle();', replace: 'if (false) {\n              closeOutputHandle();\n              await unlink(file).catch(() => {});\n              return;\n            }\n            registerBackground(bgId, child);\n            if (childExited) closeOutputHandle();' },
  { name: 'TLS-2: backgroundize 守卫 unlink 移除', file: 'src/subagent/tools.ts', find: 'if (spawnFailed || child.killed) {\n              closeOutputHandle();\n              await unlink(file).catch(() => {});\n              return;\n            }\n            registerBackground(bgId, child);\n            if (childExited) closeOutputHandle();', replace: 'if (spawnFailed || child.killed) {\n              closeOutputHandle();\n              return;\n            }\n            registerBackground(bgId, child);\n            if (childExited) closeOutputHandle();' },
  { name: 'TLS-3: spawnFailed 置位移除（error handler）', file: 'src/subagent/tools.ts', find: 'spawnFailed = true;', replace: 'spawnFailed = false;' },
  { name: 'TLS-9: pid 闸门移除（post-spawn abort 误回滚，#160）', file: 'src/subagent/tools.ts', find: 'if (child.pid === undefined) {', replace: 'if (true) {' },
  // 实测 KILLED (build)：if(false) 破坏 TS 窄化 → unlink(undefined)/string|undefined 参数类型错误
  { name: 'TLS-5: error handler 回滚 unlink 移除', file: 'src/subagent/tools.ts', find: 'if (outputPath) void unlink(outputPath).catch(() => {});', replace: 'if (false) void unlink(outputPath).catch(() => {});' },
  { name: 'TLS-6: error handler 索引删除移除', file: 'src/subagent/tools.ts', find: 'if (backgroundId) unregisterBackgroundTask(ctx.agentId, backgroundId);', replace: 'if (false) unregisterBackgroundTask(ctx.agentId, backgroundId);' },
  // EQUIVALENT（实测 survive 后标注：TLS-7 fd 无测试观测口径（bun getActiveResourcesInfo 不列
  // FileHandle）；TLS-8 跨 agent 同名 backgroundId 碰撞无覆盖；TLS-10 建文件窗口内 abort 时序不可测）
  { name: 'TLS-7: 守卫 closeOutputHandle 移除', file: 'src/subagent/tools.ts', find: 'if (spawnFailed || child.killed) {\n              closeOutputHandle();\n              await unlink(file).catch(() => {});\n              return;', replace: 'if (spawnFailed || child.killed) {\n              await unlink(file).catch(() => {});\n              return;', equivalent: true },
  { name: 'TLS-8: unregisterBackgroundTask agentId 校验移除', file: 'src/subagent/shell-tracker.ts', find: 'if (entry && entry.agentId === agentId) ctx.backgroundTasks.delete(backgroundId);', replace: 'if (entry) ctx.backgroundTasks.delete(backgroundId);', equivalent: true },
  { name: 'TLS-10: 守卫 child.killed 项移除', file: 'src/subagent/tools.ts', find: 'if (spawnFailed || child.killed) {', replace: 'if (spawnFailed) {', equivalent: true },
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
  { name: 'SUB-1: reviewed-check removed (unconditional cleanup bypass)', file: 'src/subagent/store.ts', find: 'if (!current || current.resultFetched === true || ++rearms > 24) {', replace: 'if (!current || ++rearms > 24) {' },
  { name: 'SUB-2: re-arm removed (late-reviewed record never cleaned)', file: 'src/subagent/store.ts', find: '          scheduleCleanup();', replace: '          /* mutation: no re-arm */' },
  // ── src/tool-parse.ts / src/extensions.ts (#147) ──
  { name: 'TBP-1: builtin-target reduce fallback removed', file: 'src/tool-parse.ts', find: '(TOOL_SHAPES.get(targetName)?.reduce ?? denoiseCommandResult)', replace: '(TOOL_SHAPES.get(targetName)?.reduce)' },
  { name: 'TBP-2: builtin-target inner shaping bypassed', file: 'src/extensions.ts', find: 'return { target: target.name, result: reduceBuiltinTargetResult(target.name, await target.invoke(merged, context)) };', replace: 'return { target: target.name, result: await target.invoke(merged, context) };' },

  // ── src/workflows/ (15) — Workflows 核心（ADR-0052 #224：新模块变异点 100% 被杀）──
  // 形态闸替换成恒假条件会让 TS 判 unreachable / 窄化失效而只被编译杀（杀得没意义）；
  // 直接让返回值不再过闸，由行为测试来杀——变异点的价值在于证明有测试盯着这条纪律。
  { name: 'WF-1: runId 形态闸移除（路径穿越口）', file: 'src/workflows/ids.ts', find: "if (!isRunId(value)) throw new Error(`runId must match ${RUN_ID_PATTERN.source}; received: ${String(value)}`);\n  return value;", replace: 'return String(value);' },
  { name: 'WF-2: 确定性扫描移除（非确定性脚本放行）', file: 'src/workflows/engine.ts', find: 'if (violations.length > 0) {', replace: 'if (false) {' },
  { name: 'WF-3: scriptPath 白名单失效（越界可读）', file: 'src/workflows/paths.ts', find: 'return resolved === root || resolved.startsWith(root + path.sep);', replace: 'return true;' },
  { name: 'WF-4: 终态标记改为覆盖式发布（失去独占）', file: 'src/workflows/atomic.ts', find: '      await link(temp, file);', replace: '      await rename(temp, file);' },
  { name: 'WF-5: 快照终态校验移除（活跃期可写快照）', file: 'src/workflows/snapshot.ts', find: 'if (!isTerminal(index.status)) throw new Error(`Cannot snapshot a run that is not terminal (status: ${index.status}).`);', replace: 'if (false) throw new Error(`Cannot snapshot a run that is not terminal (status: ${index.status}).`);' },
  { name: 'WF-6: 版本超前拒读移除（半读半猜）', file: 'src/workflows/schema.ts', find: 'if (found > current) throw new VersionMismatchError(label, found, current);', replace: 'if (false) throw new VersionMismatchError(label, found, current);' },
  { name: 'WF-7: journal 丢弃段不记账（静默丢）', file: 'src/workflows/journal.ts', find: 'const dropped = lines.length - kept.length;', replace: 'const dropped = 0;' },
  { name: 'WF-8: token 记账移除（每路用量不累加）', file: 'src/workflows/engine.ts', find: '      context.spent += result.outputTokens;', replace: '      void result.outputTokens;' },
  { name: 'WF-9: 续跑归属校验移除（可续别人的 run）', file: 'src/workflows/engine.ts', find: 'if (!this.ownsRun(previous.ownerSessionId, ownerCandidates)) throw new WorkflowStartError(\'FORBIDDEN\', \'run-not-owned\'', replace: 'if (this.ownsRun(previous.ownerSessionId, ownerCandidates) && false) throw new WorkflowStartError(\'FORBIDDEN\', \'run-not-owned\'' },
  { name: 'WF-10: 续跑终态闸门移除（终态 run 可被重开）', file: 'src/workflows/engine.ts', find: 'if (await exists(run.terminalFile)) throw new WorkflowStartError(\'VALIDATION\', \'run-already-terminal\'', replace: 'if (await exists(`${run.terminalFile}.absent`)) throw new WorkflowStartError(\'VALIDATION\', \'run-already-terminal\'' },
  { name: 'WF-11: args 记录位恒假（链种子丢失）', file: 'src/workflows/engine.ts', find: 'argsRecorded: request.args !== undefined,', replace: 'argsRecorded: false,' },
  { name: 'WF-12: saved 同名即复用（覆盖已有脚本）', file: 'src/workflows/saved.ts', find: 'if (existing === source) {', replace: 'if (true) {' },
  { name: 'WF-13: 静态扫描掩蔽移除（字符串内误报）', file: 'src/workflows/lint.ts', find: 'const masked = maskNonCode(source);', replace: 'const masked = source;' },
  { name: 'WF-14: 注册表保留裁剪移除（终态无限增长）', file: 'src/workflows/registry.ts', find: '.slice(-MAX_RETAINED_TERMINAL_RUNS)', replace: '.slice()' },
  { name: 'WF-15: resume 缺 scriptPath 的互斥校验移除', file: 'src/workflows/start.ts', find: 'if (hasResume && !hasPath) {', replace: 'if (false) {' },

  // ── src/workflows/ (21) — #225 T2 · N 路并发执行：并发窗口 / 键链 / 三态结算 ──
  // 每条都对应票面一条钉死语义：窗口水位、admission 序进键、形状错不 admission、
  // 沉默坍缩 null、run 级 throw、全败即 failed、账本按调用序归位。
  { name: 'WF-16: 并发窗口水位闸移除（N 路一起起跑）', file: 'src/workflows/scheduler.ts', find: 'while (!aborted && inFlight < limit && queue.length > 0) {', replace: 'while (!aborted && queue.length > 0) {' },
  { name: 'WF-17: 窗口 limit 正整数校验移除（0/负数静默放行）', file: 'src/workflows/scheduler.ts', find: 'if (!Number.isInteger(limit) || limit <= 0) {', replace: 'if (false) {' },
  { name: 'WF-18: 键链不滚动（位置无关，最长前缀失效不成立）', file: 'src/workflows/engine.ts', find: '    context.chainPrefix = key;\n', replace: '' },
  { name: 'WF-19: started 行不带键（重放无从对齐调用）', file: 'src/workflows/engine.ts', find: "{ type: 'started', seq: sequence, key, label, at: startedAt }", replace: "{ type: 'started', seq: sequence, label, at: startedAt }" },
  { name: 'WF-20: 键投影吃下全部已知项（展示项进键）', file: 'src/workflows/agent-opts.ts', find: 'for (const field of DISPATCH_AFFECTING_AGENT_OPTS) {', replace: 'for (const field of KNOWN_AGENT_OPTS) {' },
  { name: 'WF-21: 未知选项闸移除（形状错静默通过并占键位）', file: 'src/workflows/agent-opts.ts', find: 'if (unknown.length > 0) {', replace: 'if (false) {' },
  { name: 'WF-22: agentCap 检查移除（run 级终结少一臂）', file: 'src/workflows/engine.ts', find: 'if (context.agentCount > this.gates.agentCap) {', replace: 'if (false) {' },
  { name: 'WF-23: 入口级预算门移除（越限那一笔照样记账）', file: 'src/workflows/engine.ts', find: 'this.assertBudget(context);\n    context.agentCount += 1;', replace: 'context.agentCount += 1;' },
  // 恒假条件会让 TS 丢掉 allSettled 的判别收窄（.reason 直接编译不过）——只被编译器杀没意义；
  // 换成"认错态：把 run 级当形状错"，编译过、行为错，由测试杀。
  { name: 'WF-24: run 级错误在批内被降成 null（整批该拒不拒）', file: 'src/workflows/fanout.ts', find: 'if (isRunLevelError(entry.reason)) throw entry.reason;', replace: 'if (entry.reason instanceof AgentCallShapeError) throw entry.reason;' },
  { name: 'WF-25: 失败不具名记入索引（清单静默为空）', file: 'src/workflows/engine.ts', find: '      context.index.failures = [...context.index.failures, entry];\n', replace: '' },
  { name: 'WF-26: 全败判定移除（假完整交付）', file: 'src/workflows/engine.ts', find: 'if (admitted && !succeeded) {', replace: 'if (false) {' },
  { name: 'WF-27: 账本缓冲被绕过（完成序即账本序）', file: 'src/workflows/journal.ts', find: 'this.holding.set(seq, { line, settle: resolve });', replace: 'void this.enqueue(line).then(() => resolve());' },
  { name: 'WF-28: 脚本头部 meta 不再剥离（真脚本编译失败）', file: 'src/workflows/sandbox.ts', find: 'prepared = stripWorkflowMeta(options.source);', replace: 'prepared = options.source;' },
  { name: 'WF-29: 嵌套层也注入 workflow()（单层限制失守）', file: 'src/workflows/engine.ts', find: 'host.workflow = nested ? () => this.nestingRefused(context) : async (ref, args, opts) => await this.runNested(context, ref, args, opts);', replace: 'host.workflow = async (ref, args, opts) => await this.runNested(context, ref, args, opts);' },
  { name: 'WF-30: pipeline 的 null 哨兵短路移除（失败 item 继续跑）', file: 'src/workflows/fanout.ts', find: 'if (stage > 0 && previous === null) return null;', replace: 'if (false) return null;' },
  { name: 'WF-31: 每路槽位不再唯一（独立 adapter 实例失去凭证）', file: 'src/workflows/engine.ts', find: 'const adapter = factory({ runId: context.runId, dispatchId: record.id, clock: this.clock });', replace: "const adapter = factory({ runId: context.runId, dispatchId: 'd0000', clock: this.clock });" },
  { name: 'WF-32: isolation 标记不随每路记账', file: 'src/workflows/engine.ts', find: '      ...(gated.isolation ? { isolation: gated.isolation } : {}),\n', replace: '' },
  // ── 评审补钉（#225）：接链 / 封口 / 链级拒 / 硬顶 —— 每条都由测试杀 ──
  { name: 'WF-33: pipeline 段内 run 级错误被吞成该 item null', file: 'src/workflows/fanout.ts', find: '        if (isRunLevelError(error)) throw error;', replace: '        if (false) throw error;' },
  { name: 'WF-34: 续跑用错链种子（与首跑不一致，缓存全落空、重放失效）', file: 'src/workflows/engine.ts', tests: 'test/issue-230-*.test.mjs', find: 'chainPrefix: replayChainSeed(index.args),', replace: 'chainPrefix: replayChainSeed(request.resumeFromRunId ? { __wf_bust_replay__: true } : index.args),' },
  { name: 'WF-35: 终态封口移除（迟归的一路改写终态机器件）', file: 'src/workflows/engine.ts', find: 'if (context.settled || !context.open) return null;', replace: 'if (false) return null;' },
  // #226 之后硬顶挪到闸门归一化那一步（构造期仍成立，口径没变，只是位置收敛）。
  { name: 'WF-36: 并发窗口硬顶移除（越 64 直接生效）', file: 'src/workflows/engine.ts', find: 'concurrencyWindow: Math.min(HARD_CONCURRENCY_CEILING, Math.max(1, Math.floor(window))),', replace: 'concurrencyWindow: Math.max(1, Math.floor(window)),' },

  // ── src/workflows/ (14) — #224 补口 · 结算故障注入点 + 重命名双写窗口 + 审计证据保真 ──
  { name: 'WF-37: 通知前那一帧不触发（三点矩阵缺一帧）', file: 'src/workflows/engine.ts', find: "this.crash('before-notice');\n", replace: '' },
  { name: 'WF-38: env 命中判据反向（命中的不动、其余的全动）', file: 'src/workflows/crash.ts', find: 'if (point !== target) return;', replace: 'if (point === target) return;' },
  { name: 'WF-39: env 值不 trim（带空格的合法帧名认不出来）', file: 'src/workflows/crash.ts', find: 'const normalized = raw.trim();', replace: 'const normalized = raw;' },
  { name: 'WF-40: 双写不判缺位（造出 undefined 假字段）', file: 'src/workflows/schema.ts', find: 'if (!(field in out) || out[field] === undefined) continue;', replace: 'if (false) continue;' },
  { name: 'WF-41: 读出优先旧字段（新值被旧值盖掉）', file: 'src/workflows/schema.ts', find: 'if (!hasNew && hasOld) {', replace: 'if (hasOld) {' },
  { name: 'WF-42: 新旧键冲突静默吞掉（§20 不许静默挑一个）', file: 'src/workflows/schema.ts', find: 'conflicts.push(field);\n', replace: '' },
  { name: 'WF-43: 抬升后仍留双份（上层读到两份真值）', file: 'src/workflows/schema.ts', find: 'if (hasOld) delete value[previous];', replace: '' },
  { name: 'WF-44: 空窗口表被硬编码成有表（今天形状多出旧键）', file: 'src/workflows/run-index.ts', find: 'renames: readonly FieldRename[] = RENAMED_FIELDS.index): Promise<void> {', replace: "renames: readonly FieldRename[] = [{ field: 'status', previous: 'state' }]): Promise<void> {" },
  { name: 'WF-45: 后台终止记错审计动作（结算失败被当启动）', file: 'src/workflows/engine.ts', find: "this.deps.audit?.({ runId, action: 'workflow_settle', actor: request.ownerSessionId, status: 'failed', reason: 'settle-failed',", replace: "this.deps.audit?.({ runId, action: 'workflow_start', actor: request.ownerSessionId, status: 'failed', reason: 'settle-failed'," },
  { name: 'WF-46: 终态宣告后又被改判第二次', file: 'src/workflows/engine.ts', find: 'if (context.settled) throw error;', replace: 'if (false) throw error;' },
  { name: 'WF-47: 审计幂等键不带因由（settle-failed 把终态证据整条盖掉）', file: 'src/workflows/start.ts', find: '`workflow-${entry.runId}-${entry.action}-${entry.reason}`', replace: '`workflow-${entry.runId}-${entry.action}`' },
  { name: 'WF-48: 审计 status 退回一律 completed（失败结算看不出来）', file: 'src/workflows/start.ts', find: "status: AUDIT_STATUS[entry.status] ?? 'failed',", replace: "status: entry.action === 'workflow_settle' ? 'completed' : 'running',", all: true },
  { name: 'WF-49: detail 不落进审计链（死在哪一步出不了函数）', file: 'src/workflows/start.ts', find: "...(entry.detail ? { detail: entry.detail } : {}),\n", replace: '' },
  { name: 'WF-50: 快照不走改名窗口（旧读者读不到旧键）', file: 'src/workflows/snapshot.ts', find: 'await writeJsonAtomic(file, withDualWrite(snapshot, renames));', replace: 'await writeJsonAtomic(file, snapshot);' },

  // ── src/workflows/ + 设置面 (18) — #226 T3 · 自限闸门与设置节：默认即上限 / 硬顶 / 两级软门 / 嵌套校验 ──
  // 每条都对应票面一条钉死语义：越顶压回、下限守住、env 只认合法帧、"不限制"只解 token 闸、
  // 嵌套余量有效、设置节不含端点字段、未知键不静默。取槽级软门与构造期硬顶由行为测试杀。
  // 恒假条件会让 TS 判 unreachable / 变量未读而只被编译杀（杀得没意义）；
  // 一律换成"照值放行但仍留告警"的行为错，由测试杀。
  { name: 'WF-51: 硬顶 clamp 失守（留了告警却放行越顶值）', file: 'src/workflows/gates.ts', find: 'return { value: key.ceiling, notice:', replace: 'return { value, notice:' },
  { name: 'WF-52: 下限 clamp 移除（并发窗口被调成 1 = 静默串行化）', file: 'src/workflows/gates.ts', find: 'if (value < key.floor) {', replace: 'if (false) {' },
  { name: 'WF-53: env 的 0 被当合法值（关掉闸门用错写法就生效）', file: 'src/workflows/gates.ts', find: 'return Number.isSafeInteger(value) && value > 0 ? value : undefined;', replace: 'return Number.isSafeInteger(value) ? value : undefined;' },
  { name: 'WF-54: "不限制"开关失效（开了仍有顶）', file: 'src/workflows/gates.ts', find: 'tokenCap: unlimited ? null : numbers.tokenCap', replace: 'tokenCap: numbers.tokenCap', all: true },
  { name: 'WF-55: 嵌套校验只看账面（reduceSlack 余量被吃掉）', file: 'src/workflows/gates.ts', find: 'const maxAllowedMs = outerMs - slackMs;', replace: 'const maxAllowedMs = outerMs;' },
  { name: 'WF-56: 违例只报第一条（其余击穿静默通过）', file: 'src/workflows/gates.ts', find: 'return violations.length === 0 ? { ok: true } : { ok: false, violations };', replace: 'return violations.length === 0 ? { ok: true } : { ok: false, violations: violations.slice(0, 1) };' },
  { name: 'WF-57: 端点字段探针失效（baseUrl 混进 workflows 节没人管）', file: 'src/workflows/gates.ts', find: 'return ENDPOINT_FIELD_NAMES.filter((field) => Object.hasOwn(section, field));', replace: 'return [];' },
  { name: 'WF-58: 默认并发窗口不看核数（公式失守，一律取下限）', file: 'src/workflows/gates.ts', find: "return key.default === 'auto' ? defaultConcurrencyWindow(availableParallelism) : key.default;", replace: "return key.default === 'auto' ? MIN_CONCURRENCY : key.default;" },
  { name: 'WF-59: 未知键静默通过（typo 让用户以为调了）', file: 'src/workflows/gates.ts', find: "if (!byName.has(name) && !ENDPOINT_FIELD_NAMES.includes(name as (typeof ENDPOINT_FIELD_NAMES)[number])) {", replace: 'if (false) {' },
  // 硬编码成"永远放行"会让 TS 丢掉判别收窄而只被编译杀；换成"永远拒"——编译过、
  // 行为错（连合法闸门集都起不来），由既有全部 run 用例杀。恒过那一臂由 WF-66 补。
  { name: 'WF-60: 启动校验结果被硬编码（引擎不再真问嵌套）', file: 'src/workflows/engine.ts', find: 'const nesting = validateClockNesting(this.gates);', replace: 'const nesting = { ok: false, violations: [] } as const;' },
  { name: 'WF-67: 运行时快照不带 workflows 段（TUI 一保存就抹掉用户调好的闸）', file: 'src/runtime-settings.ts', tests: 'test/issue-226-*.test.mjs', find: '...(persisted?.workflows ? { workflows: persisted.workflows } : {}),\n', replace: '' },
  { name: 'WF-68: 运行时快照不带 subagent 段（改端口顺手删掉端点三元组）', file: 'src/runtime-settings.ts', tests: 'test/issue-226-*.test.mjs', find: '...(persisted?.subagent ? { subagent: persisted.subagent } : {}),\n', replace: '' },
  { name: 'WF-66: 嵌套校验恒过（击穿嵌套的闸门集照样放行）', file: 'src/workflows/gates.ts', find: 'return violations.length === 0 ? { ok: true } : { ok: false, violations };', replace: 'return { ok: true };' },
  { name: 'WF-61: 取槽级软门移除（第二级检查失守）', file: 'src/workflows/engine.ts', find: '      this.assertOpen(context);\n      this.assertBudget(context);\n', replace: '      this.assertOpen(context);\n' },
  { name: 'WF-62: agentCap 构造期硬顶移除（注入越顶值直接生效）', file: 'src/workflows/engine.ts', find: 'agentCap: Math.min(HARD_AGENT_CAP_CEILING, Math.max(1, Math.floor(requested.agentCap))),', replace: 'agentCap: Math.max(1, Math.floor(requested.agentCap)),' },
  { name: 'WF-63: 不限制时预算读数不再报无顶（脚本读到 0 自己收手）', file: 'src/workflows/engine.ts', find: 'remaining: () => (this.gates.tokenCap === null ? Number.POSITIVE_INFINITY : Math.max(0, this.gates.tokenCap - context.spent)),', replace: 'remaining: () => Math.max(0, (this.gates.tokenCap ?? 0) - context.spent),' },
  // 整段 if 改恒假会让 normalized 未读 / 分支不可达而只被编译杀；
  // 换成"校验做了、错误不上报"——编译过、行为错，由 AC3 的端点与 typo 断言杀。
  { name: 'WF-64: 设置节校验错误不上报（端点与 typo 静默放行）', file: 'src/config.ts', tests: 'test/issue-226-*.test.mjs', find: 'if (normalized.errors.length) {', replace: 'if (false) {' },
  { name: 'WF-65: TUI 字段清单与登记表断链（新键在设置屏查无此文）', file: 'src/tui/controller-logic.ts', tests: 'test/issue-226-*.test.mjs', find: 'export const WORKFLOW_SETTING_FIELDS: string[] = WORKFLOW_SETTING_KEYS.map((key) => key.field);', replace: "export const WORKFLOW_SETTING_FIELDS: string[] = ['wf-token-cap'];" },

  // ── src/workflows/ (7) — #227 T4 · stall 看门狗与两层重试：无进展重试 / 取消优先 / backoff 上界 / 非 stall 不重试 ──
  // 每条对应票面一条钉死语义（§18），由本票的 stall/llm-retry 单元或引擎测试逐条杀。
  { name: 'WF-69: stall 耗尽前从不重试（180s 无进展应换控制器重试）', file: 'src/workflows/stall.ts', tests: 'test/issue-227-stall-retry-units.test.mjs', find: 'if (attempt < MAX_STALL_ATTEMPTS) continue;', replace: '' },
  { name: 'WF-70: 取消被当普通错重试（父信号须先判、永不重试）', file: 'src/workflows/stall.ts', tests: 'test/issue-227-stall-retry-units.test.mjs', find: 'if (deps.parentSignal.aborted) {', replace: 'if (disposed) {' },
  { name: 'WF-73: dispatch 窗口到期被当无进展（应判 timeout 不重试）', file: 'src/workflows/stall.ts', tests: 'test/issue-227-stall-retry-units.test.mjs', find: "() => fire('timeout'), deps.dispatchWindowMs", replace: "() => fire('stalled'), deps.dispatchWindowMs" },
  { name: 'WF-74: 轮数预算检查移除（越 dispatchTurns 应判 max_turns）', file: 'src/workflows/stall.ts', tests: 'test/issue-227-stall-retry-units.test.mjs', find: 'if (rounds > deps.dispatchTurns) {', replace: 'if (false) {' },
  { name: 'WF-71: 瞬态 backoff 上界越过 stall 窗（会被看门狗误判无进展）', file: 'src/workflows/llm-retry.ts', tests: 'test/issue-227-stall-retry-units.test.mjs', find: '[2_000, 5_000, 10_000, 20_000, 30_000]', replace: '[2_000, 5_000, 10_000, 20_000, 30_000, 400_000]' },
  { name: 'WF-72: 鉴权错误被当瞬态重试（auth 不是可恢复的瞬时错）', file: 'src/workflows/llm-retry.ts', tests: 'test/issue-227-stall-retry-units.test.mjs', find: "['rate_limit', 'server_overload', 'connection']", replace: "['rate_limit', 'server_overload', 'connection', 'auth']" },
  { name: 'WF-77: 重试次数不进该路终态记账（审计看不到试了几次）', file: 'src/workflows/engine.ts', tests: 'test/issue-227-stall-retry.test.mjs', find: 'const reportAttempt = (n: number): void => { record.attempts = n; };', replace: 'const reportAttempt = (n: number): void => { void n; };' },

  // ── src/workflows/ + server 接线 (22) — #228 T5 · 并行子 agent 工具集（只读面）：路径双检 / 命令闸 / 有界返回 / 工具 floor / 每路提示词 / 进程组收 ──
  // 每条对应票面一条钉死语义（§11），由本票的零件单元或引擎行为测试逐条杀（不做只被编译杀的形态）。
  { name: "WF-78: 边界归一改用宿主进程目录（这一跑的 cwd 不再生效）", file: "src/workflows/tool-boundary.ts", tests: 'test/issue-228-*.test.mjs', find: "  const resolved = path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd, value));", replace: "  const resolved = path.normalize(path.resolve(value));" },
  { name: "WF-79: realpath 段拿词法路径自比（symlink 逃逸看不见）", file: "src/workflows/tool-boundary.ts", tests: 'test/issue-228-*.test.mjs', find: "    realTarget = realpathSync(resolved);", replace: "    realTarget = resolved;" },
  { name: "WF-80: 单引号内容也参与危险判定（数据被当命令，白名单里的 grep 全被判危险）", file: "src/workflows/tool-command.ts", tests: 'test/issue-228-*.test.mjs', find: "  return value.replace(SINGLE_QUOTED, \"''\");", replace: "  return value;" },
  { name: "WF-81: 危险表先于替换面判（拒因错位，审计说不出为什么挡）", file: "src/workflows/tool-command.ts", tests: 'test/issue-228-*.test.mjs', find: "  if (hasCommandSubstitution(command)) return { allowed: false, reason: 'command-substitution' };\n  const scannable = stripSingleQuoted(command);\n  if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(scannable))) return { allowed: false, reason: 'dangerous-command' };", replace: "  const scannable = stripSingleQuoted(command);\n  if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(scannable))) return { allowed: false, reason: 'dangerous-command' };\n  if (hasCommandSubstitution(command)) return { allowed: false, reason: 'command-substitution' };" },
  { name: "WF-82: 只读白名单反成写模式专属（默认面什么命令都放）", file: "src/workflows/tool-command.ts", tests: 'test/issue-228-*.test.mjs', find: "    if (mode === 'read-only') {", replace: "    if (mode !== 'read-only') {" },
  { name: "WF-83: 结果帽抬到事实无界（一条工具结果灌满上下文）", file: "src/workflows/tool-output.ts", tests: 'test/issue-228-*.test.mjs', find: "export const MAX_TOOL_RESULT_CHARS = 50_000;", replace: "export const MAX_TOOL_RESULT_CHARS = 50_000_000;" },
  { name: "WF-84: 截断落在代理对中间也照切（递给模型半个码元）", file: "src/workflows/tool-output.ts", tests: 'test/issue-228-*.test.mjs', find: "  const last = value.charCodeAt(limit - 1);", replace: "  const last = 0;" },
  { name: "WF-85: tools 白名单可以扩面（只减不增被反过来）", file: "src/workflows/tool-face.ts", tests: 'test/issue-228-*.test.mjs', find: "    names = names.filter((name) => requested.includes(name));", replace: "    names = [...new Set([...names, ...requested.filter((name) => name !== STRUCTURED_OUTPUT_TOOL)])];" },
  { name: "WF-86: agentType 被忽略（形态上界不成立，reader 也能执行命令）", file: "src/workflows/tool-face.ts", tests: 'test/issue-228-*.test.mjs', find: "  const agentType = options.agentType ?? DEFAULT_AGENT_TYPE;", replace: "  const agentType = DEFAULT_AGENT_TYPE;" },
  { name: "WF-87: 第四次不合格提交才判败（三次上限不成立，且多烧一轮）", file: "src/workflows/agent-loop.ts", tests: 'test/issue-228-*.test.mjs', find: "        if (failedSubmissions >= MAX_FAILED_STRUCTURED_SUBMISSIONS) {", replace: "        if (failedSubmissions > MAX_FAILED_STRUCTURED_SUBMISSIONS) {" },
  { name: "WF-88: 工具在飞不再挂起无进展计时（慢工具被当 stall 重跑）", file: "src/workflows/agent-loop.ts", tests: 'test/issue-228-*.test.mjs', find: "      options.progress?.toolStart();", replace: "      options.progress?.activity();" },
  { name: "WF-89: floor 禁令退化成\"面外工具\"（模型看不出这是禁令不是笔误）", file: "src/workflows/tool-invoke.ts", tests: 'test/issue-228-*.test.mjs', find: "    const hint = FLOOR_HINT[call.name];", replace: "    const hint: string | undefined = undefined;" },
  { name: "WF-90: 工具面不再递给端点（有面也用不上）", file: "src/workflows/adapter.ts", tests: 'test/issue-228-*.test.mjs', find: "            tools: request.tools ?? [],", replace: "            tools: []," },
  { name: "WF-91: 模式判定丢失（隔离面按只读跑，写模式的回报义务消失）", file: "src/workflows/engine.ts", tests: 'test/issue-228-*.test.mjs', find: "    const mode: ToolMode = gated.isolation === 'worktree' ? 'worktree' : 'read-only';", replace: "    const mode: ToolMode = 'read-only';" },
  { name: "WF-92: 该路收尾不随路收命令树（后台进程活过这一路）", file: "src/workflows/engine.ts", tests: 'test/issue-228-*.test.mjs', find: "              await collectOwnerCommands({ runId: context.runId, dispatchId: record.id });", replace: "              void 0;" },
  { name: "WF-93: 按 pid 单杀而非按进程组杀（孙进程留在世上继续写盘）", file: "src/workflows/command-tree.ts", tests: 'test/issue-228-*.test.mjs', find: "    process.kill(-pid, signal);", replace: "    process.kill(pid, signal);" },
  { name: "WF-94: 关机第一步不停接单（收完在飞还在接新命令，燃烧打不住）", file: "src/workflows/command-tree.ts", tests: 'test/issue-228-*.test.mjs', find: "  stopAcceptingCommands();\n  const graceMs = options.graceMs ?? DEFAULT_COMMAND_GRACE_MS;", replace: "  const graceMs = options.graceMs ?? DEFAULT_COMMAND_GRACE_MS;" },
  { name: "WF-95: 子 schema 不再下钻（items / additionalProperties 里的越界关键词漏报）", file: "src/workflows/json-gate.ts", tests: 'test/issue-228-*.test.mjs', find: "      walkChildren(key, value);", replace: "      if (key === 'properties') walkChildren(key, value);" },
  { name: "WF-96: 声明 isolation 即放开命令闸（写必隔离要等边界交付，不是等一句声明）", file: "src/workflows/engine.ts", tests: 'test/issue-228-*.test.mjs', find: "    const gatedMode: ToolMode = 'read-only';", replace: "    const gatedMode: ToolMode = gated.isolation === 'worktree' ? 'worktree' : 'read-only';" },
  { name: "WF-97: 过期后台记录只销账不删输出文件（run 目录堆成永久垃圾）", file: "src/workflows/command-tree.ts", tests: 'test/issue-228-*.test.mjs', find: "        unlinkSync(command.outputPath);", replace: "        void command.outputPath;" },
  { name: "WF-98: 关机不再收 Workflows 的在飞命令树（close 漏掉本模块）", file: "src/server.ts", tests: 'test/issue-228-*.test.mjs', find: "    await shutdownCommandTrees();", replace: "    void 0;" },
  { name: "WF-99: 声明隔离的那一路不再拿到回报义务（产物找不到归属）", file: "src/workflows/engine.ts", tests: 'test/issue-228-*.test.mjs', find: "        isolated: gated.isolation === 'worktree',", replace: "        isolated: false," },

  // ── src/workflows/ + subagent 面 + 接线 (44) — #229 T6 · 汇总体回传管线：终态消息 ≤200 / durable outbox / 等待位与配额 / 预算推导 / wait_for_path 三态 / 禁止 completed 掩盖 ──
  { name: 'WF-100: 首行 KV 分隔符被改（去重键不再是钉死形态）', file: 'src/workflows/notice.ts', tests: 'test/issue-229-*.test.mjs', find: "  return `${KV_TAG} kind=${input.kind} runId=${input.runId} sha256=${input.sha256}`;", replace: "  return `${KV_TAG} kind:${input.kind} runId:${input.runId} sha256:${input.sha256}`;" },
  { name: 'WF-101: 通知体码元帽抬高（≤200 形同虚设）', file: 'src/workflows/notice.ts', tests: 'test/issue-229-*.test.mjs', find: 'export const MAX_NOTICE_CODE_UNITS = 200;', replace: 'export const MAX_NOTICE_CODE_UNITS = 20_000;' },
  { name: 'WF-102: 压缩阶梯丢掉绝对路径档（短路径也被压成尾段）', file: 'src/workflows/notice.ts', tests: 'test/issue-229-*.test.mjs', find: "  const ladder = [\n    `${draft.status} ${counts} index=${draft.indexPath}`,\n", replace: "  const ladder = [\n" },
  { name: 'WF-103: 降档次序颠倒（先扔读数再扔路径，能带读数时反而不带）', file: 'src/workflows/notice.ts', tests: 'test/issue-229-*.test.mjs', find: "    `${draft.status} ${counts} index=${tail}`,\n    `${draft.status} index=${tail}`,", replace: "    `${draft.status} index=${tail}`,\n    `${draft.status} ${counts} index=${tail}`," },
  { name: 'WF-104: KV 首行装不下也照发（半截身份发出去）', file: 'src/workflows/notice.ts', tests: 'test/issue-229-*.test.mjs', find: '  if (room < 1) {', replace: '  if (false) {' },
  { name: 'WF-105: 摘要缺件以外的 IO 故障也被当成"没有摘要"', file: 'src/workflows/notice.ts', tests: 'test/issue-229-*.test.mjs', find: "    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;\n    throw error;", replace: '    return undefined;' },
  { name: 'WF-106: outbox 改覆盖式写（失去写-if-absent，已投递位被抹回）', file: 'src/workflows/notice.ts', tests: 'test/issue-229-*.test.mjs', find: '  const created = await createExclusive(file, `${JSON.stringify(item, null, 2)}\\n`);', replace: '  const created = await writeJsonAtomic(file, item).then(() => true);' },
  { name: 'WF-107: 投递成功不标 delivered（排空趟反复重投）', file: 'src/workflows/notice.ts', tests: 'test/issue-229-*.test.mjs', find: '  const next: OutboxItem = { ...item, delivered: true, deliveredAt: at, attempts: item.attempts + 1 };', replace: '  const next: OutboxItem = { ...item, attempts: item.attempts + 1 };' },
  { name: 'WF-108: outbox 目录缺失当故障抛（排空趟在没投过件的 run 上炸）', file: 'src/workflows/notice.ts', tests: 'test/issue-229-*.test.mjs', find: "  } catch (error) {\n    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];\n    throw error;\n  }", replace: '  } catch (error) {\n    throw error;\n  }' },
  { name: 'WF-109: 等待位非独占（同一 run 起两个等待中的汇总体）', file: 'src/workflows/reducer.ts', tests: 'test/issue-229-*.test.mjs', find: '  if (created) return { ok: true, waiter };', replace: '  return { ok: true, waiter };' },
  { name: 'WF-110: 释放不校验 agentId（后来者能放掉在位者的登记）', file: 'src/workflows/reducer.ts', tests: 'test/issue-229-*.test.mjs', find: "  if (!holder || holder.agentId !== input.agentId) return { released: false };", replace: '  if (!holder) return { released: false };' },
  { name: 'WF-111: 等待位计数按可解析性（坏登记不占位，配额被击穿）', file: 'src/workflows/reducer.ts', tests: 'test/issue-229-*.test.mjs', find: "    if (await exists(path.join(paths.runsRoot, name, 'reducer-waiter.json'))) count += 1;", replace: '    if (await readWaiter(paths, name)) count += 1;' },
  { name: 'WF-112: 配额判定放宽（超一槽仍放行）', file: 'src/workflows/reducer.ts', tests: 'test/issue-229-*.test.mjs', find: '  if (waiting >= input.gates.reducerQuota) {', replace: '  if (waiting > input.gates.reducerQuota) {' },
  { name: 'WF-113: 配额满不再降级（把 notice-only 说成别的）', file: 'src/workflows/reducer.ts', tests: 'test/issue-229-*.test.mjs', find: "      noticeOnly: true,\n      runBlocked: false,\n      indexPath,\n      message: `Reducer quota is full", replace: "      noticeOnly: false,\n      runBlocked: false,\n      indexPath,\n      message: `Reducer quota is full" },
  { name: 'WF-114: 末回合不吃 waitChunk 封顶（余额多时单次阻塞无限长）', file: 'src/workflows/reducer.ts', tests: 'test/issue-229-*.test.mjs', find: '      return Math.max(0, Math.floor(Math.min(gates.waitChunkMs, budgetEndsAt - planned) / 1000));', replace: '      return Math.max(0, Math.floor((budgetEndsAt - planned) / 1000));' },
  { name: 'WF-115: 整除时白送一个空回合（等待回合数虚高）', file: 'src/workflows/reducer.ts', tests: 'test/issue-229-*.test.mjs', find: '  const finalRound: 0 | 1 = gates.reducerBudgetMs - fullRounds * gates.waitChunkMs > 0 ? 1 : 0;', replace: '  const finalRound: 0 | 1 = 1;' },
  { name: 'WF-116: timeoutSec 推导错位（硬兜底等于预算本身，余量消失）', file: 'src/workflows/reducer.ts', tests: 'test/issue-229-*.test.mjs', find: '    timeoutSec: Math.round(gates.reducerTimeoutMs / 1000),', replace: '    timeoutSec: Math.round(gates.reducerBudgetMs / 1000),' },
  { name: 'WF-117: 收场不查终态标记（认模型自述，假完整放行）', file: 'src/workflows/reducer.ts', tests: 'test/issue-229-*.test.mjs', find: "  if (!settled) {\n    return {\n      status: 'failed',\n      reason: 'wait-timeout',", replace: "  if (!settled && false) {\n    return {\n      status: 'failed',\n      reason: 'wait-timeout'," },
  { name: 'WF-118: 摘要缺件也被当成已交付（缺件兜成假 sha）', file: 'src/workflows/reducer.ts', tests: 'test/issue-229-*.test.mjs', find: '  const digestSha = await sha256FileIfPresent(input.digestPath);', replace: "  const digestSha = (await sha256FileIfPresent(input.digestPath)) ?? 'missing';" },
  { name: 'WF-119: 收场不释放等待位（同 runId 再也补不起来）', file: 'src/workflows/reducer.ts', tests: 'test/issue-229-*.test.mjs', find: '  const released = (await releaseReducerWaiter(paths, { runId: input.runId, agentId: input.agentId })).released;', replace: '  const released = true;' },
  { name: 'WF-120: 摘要首行的 sha 不取自摘要内容（内容键失效）', file: 'src/workflows/reducer.ts', tests: 'test/issue-229-*.test.mjs', find: "    firstLine: buildKvFirstLine({ kind: 'digest', runId: input.runId, sha256: digestSha }),", replace: "    firstLine: buildKvFirstLine({ kind: 'digest', runId: input.runId, sha256: input.digestPath })," },
  { name: 'WF-121: 模板里的正文预算写死（发布件与投递管线脱钩）', file: 'src/workflows/reducer.ts', tests: 'test/issue-229-*.test.mjs', find: '  const summaryBudget = reducerSummaryBudget(input.runId);', replace: '  const summaryBudget = 200;' },
  { name: 'WF-122: 轮询间隔不再钉 2 秒', file: 'src/subagent/tools.ts', tests: 'test/issue-229-*.test.mjs', find: 'export const WAIT_FOR_PATH_POLL_MS = 2_000;', replace: 'export const WAIT_FOR_PATH_POLL_MS = 20_000;' },
  { name: 'WF-123: 非普通文件不拒（FIFO / socket / 目录都能把等待体挂住）', file: 'src/subagent/tools.ts', tests: 'test/issue-229-*.test.mjs', find: '        if (stats.isSymbolicLink() || !stats.isFile()) {', replace: '        if (false) {' },
  { name: 'WF-124: IO 故障被当成"未出现"吞掉（ENOTDIR 也当缺席）', file: 'src/subagent/tools.ts', tests: 'test/issue-229-*.test.mjs', find: "        if (code !== 'ENOENT' && code !== 'ENOTDIR') {", replace: "        if (code !== 'ENOENT') {" },
  { name: 'WF-125: 末步不睡余数（等待越过预算末端）', file: 'src/subagent/tools.ts', tests: 'test/issue-229-*.test.mjs', find: "      if (await sleepOrAbort(Math.min(waitTiming.pollIntervalMs, capMs - waitedMs), ctx.signal) === 'aborted') {", replace: "      if (await sleepOrAbort(waitTiming.pollIntervalMs, ctx.signal) === 'aborted') {" },
  { name: 'WF-126: 暂停期不再冻结（暂停 20 分钟就误报 wait-timeout）', file: 'src/subagent/tools.ts', tests: 'test/issue-229-*.test.mjs', find: '      if (paused) frozenMs += delta;\n      else waitedMs += delta;', replace: '      waitedMs += delta;' },
  { name: 'WF-127: pausing 也被当成暂停（与 run 墙钟两套规则）', file: 'src/subagent/tools.ts', tests: 'test/issue-229-*.test.mjs', find: "    return parsed.status === 'paused' ? 'paused' : 'running';", replace: "    return parsed.status === 'paused' || parsed.status === 'pausing' ? 'paused' : 'running';" },
  { name: 'WF-128: 等待体不响应中止（死掉的汇总体把 promise 挂到预算尽头）', file: 'src/subagent/tools.ts', tests: 'test/issue-229-*.test.mjs', find: "    new Promise<'aborted'>((wakeup) => { signal.addEventListener('abort', () => wakeup('aborted'), { once: true }); }),", replace: "    new Promise<'aborted'>(() => { /* mutation: 永不被中止唤醒 */ })," },
  { name: 'WF-129: 越界路径不拒（cwd 外的路径也去等）', file: 'src/subagent/tools.ts', tests: 'test/issue-229-*.test.mjs', find: "      return waitFailure('outside-cwd', `wait_for_path: \"${rawPath}\" is outside the working directory (lexical escape or symlink redirect).`);", replace: '      target = rawPath;' },
  { name: 'WF-130: 坏索引不再留名（读不动与未暂停混为一谈）', file: 'src/subagent/tools.ts', tests: 'test/issue-229-*.test.mjs', find: "  } catch {\n    return 'unreadable';\n  }\n}\n\nfunction waitFailure", replace: "  } catch {\n    return 'running';\n  }\n}\n\nfunction waitFailure" },
  { name: 'WF-131: 汇总体超时不推导（拿 subagent 默认超时顶替）', file: 'src/subagent/runner.ts', tests: 'test/issue-229-*.test.mjs', find: '        timeoutSec: waiting ? waiting.timeoutSec : (input.timeoutSec ?? settings.timeoutSec),', replace: '        timeoutSec: input.timeoutSec ?? settings.timeoutSec,' },
  { name: 'WF-132: 摘要消息不前置 KV 首行（去重键丢在交付路上）', file: 'src/subagent/runner.ts', tests: 'test/issue-229-*.test.mjs', find: '      const text = settlement?.status === \'completed\' ? `${settlement.firstLine}\\n${result.result}` : result.result;', replace: '      const text = result.result;' },
  { name: 'WF-133: 收场判败不改判（completed 掩盖未结算）', file: 'src/subagent/runner.ts', tests: 'test/issue-229-*.test.mjs', find: "    const failed = result.status !== 'completed' || settlement?.status === 'failed';", replace: "    const failed = result.status !== 'completed';" },
  { name: 'WF-134: 记录期不打 reduce 标记（归属与摘要路径全丢）', file: 'src/subagent/runner.ts', tests: 'test/issue-229-*.test.mjs', find: '        ...(input.reduce ? { reduce: { runId: input.reduce.runId, digestPath: input.reduce.digestPath } } : {}),', replace: '        ...(input.reduce ? {} : {}),' },
  { name: 'WF-135: notice-only 降级谎报 running（父以为起了个汇总体）', file: 'src/subagent/runner.ts', tests: 'test/issue-229-*.test.mjs', find: "            status: 'notice-only',", replace: "            status: 'running'," },
  { name: 'WF-136: reduce 里不存在的旋钮不再拒（模型面多出可传键）', file: 'src/workflows/start.ts', tests: 'test/issue-229-*.test.mjs', find: "  const knobs = Object.keys(record).filter((key) => key !== 'runId');", replace: '  const knobs: string[] = [];' },
  { name: 'WF-137: reduce 与 timeoutSec 并存不再拒（覆盖推导值）', file: 'src/workflows/start.ts', tests: 'test/issue-229-*.test.mjs', find: '  if (input.timeoutSec !== undefined) {', replace: '  if (false) {' },
  { name: 'WF-138: reduce 归属不校验（谁都能汇别人的 run）', file: 'src/workflows/start.ts', tests: 'test/issue-229-*.test.mjs', find: '  if (!ownerCandidates.includes(run.ownerSessionId)) {', replace: '  if (false) {' },
  { name: 'WF-139: runId 形状闸变宽（非 wf_ 形态也放行）', file: 'src/workflows/start.ts', tests: 'test/issue-229-*.test.mjs', find: '  if (!isRunId(record.runId)) {', replace: "  if (typeof record.runId !== 'string') {" },
  { name: 'WF-140: 延续链断在第一跳（接任会话认不出名下 run）', file: 'src/core-tools.ts', tests: 'test/issue-229-*.test.mjs', find: '            current = store.session(current).continuesSessionId ?? undefined;', replace: '            current = undefined;' },
  { name: 'WF-141: 投递成功不标 delivered（模块侧再次漏标）', file: 'src/workflows/engine.ts', tests: 'test/issue-229-*.test.mjs', find: '    if (sent) await markNoticeDelivered(context.run, item, this.clock.iso()).catch(() => undefined);', replace: '    if (sent) { /* mutation: 不标投递位 */ }' },
  { name: 'WF-142: 崩溃帧移除（先落盘再投递的判据演不出来）', file: 'src/workflows/engine.ts', tests: 'test/issue-229-*.test.mjs', find: "    this.crash('before-notice');", replace: '    void 0;' },
  { name: 'WF-143: 汇总体槽位上限回退到 4（池上限扩到 10 白扩）', file: 'src/config.ts', tests: 'test/issue-229-*.test.mjs', find: '    maxParallel: boundedInteger(sub.maxParallel != null ? String(sub.maxParallel) : undefined, 2, 1, 10),', replace: '    maxParallel: boundedInteger(sub.maxParallel != null ? String(sub.maxParallel) : undefined, 2, 1, 4),' },

  // ── src/workflows/ (T7 #230) — 控制与续跑：cancel / pause / resume / 缓存重放 / 排他锁 ──
  // 每条对应票面一条钉死语义，全部由 test/issue-230-*.test.mjs 行为杀（非仅编译杀）。
  { name: 'WF-200: 续跑不查缓存（命中前缀照样全 live，重放形同虚设）', file: 'src/workflows/engine.ts', tests: 'test/issue-230-*.test.mjs', find: 'if (context.replay && !context.replayBarrierBroken && context.replay.has(key)) {', replace: 'if (context.replay && context.replayBarrierBroken && context.replay.has(key)) {' },
  { name: 'WF-201: 缓存命中不把已完成记录接回账本（每路 usage 丢、X/Y 算虚）', file: 'src/workflows/engine.ts', tests: 'test/issue-230-*.test.mjs', find: 'context.index = { ...context.index, dispatches: [...context.index.dispatches, reused] };', replace: 'context.index = { ...context.index, dispatches: [...context.index.dispatches] };' },
  { name: 'WF-202: run 级终结一律坍缩成 failed（取消不再是 cancelled 三态之一）', file: 'src/workflows/engine.ts', tests: 'test/issue-230-*.test.mjs', find: "return reason === 'cancelled' ? 'cancelled' : 'failed';", replace: "return 'failed';" },
  { name: 'WF-203: 存活进程反被当失效锁（他人续跑被放行，双写目录）', file: 'src/workflows/lock.ts', tests: 'test/issue-230-*.test.mjs', find: 'if (!isAlive(holder.pid)) return true;', replace: 'if (isAlive(holder.pid)) return true;' },
  { name: 'WF-204: pid 复用窗口的 epoch 兜底移除（复用 pid 打不死接管）', file: 'src/workflows/lock.ts', tests: 'test/issue-230-*.test.mjs', find: 'if (holder.pid === self.pid && holder.epoch < self.epoch) return true;', replace: 'if (holder.pid === self.pid && holder.epoch < self.epoch) return false;' },
  { name: 'WF-205: pause 不把 paused 落 index.status（T6 读侧冻结等待预算失去依据）', file: 'src/workflows/engine.ts', tests: 'test/issue-230-*.test.mjs', find: "context.index = { ...context.index, status: 'paused' };", replace: "context.index = { ...context.index, status: 'running' };" },
  { name: 'WF-206: cancel 不以 cancelled 终结（在飞按墙钟归因，取消语义失真）', file: 'src/workflows/engine.ts', tests: 'test/issue-230-*.test.mjs', find: "this.terminate(context, 'cancelled', 'Workflow run cancelled by its owner.');", replace: "this.terminate(context, 'run-gate', 'x');" },
  { name: 'WF-207: 汇总体用量第三档不累加（reducer 账永远为 0）', file: 'src/workflows/reducer.ts', tests: 'test/issue-230-*.test.mjs', find: 'reducerTokens: { spent: (index.reducerTokens?.spent ?? 0) + Math.floor(outputTokens) }', replace: 'reducerTokens: { spent: (index.reducerTokens?.spent ?? 0) + 0 }' },

  // ── src/workflows/ + tui 面板 (T8 #231, 32) — 写必隔离：工具面随边界变 / 闸门在任何资源副作用之前 / 竞态纪律 / 四层配额 / 保留与处置 ──
  // 每条对应票面一条钉死语义，全部由 test/issue-231-*.test.mjs 行为杀（非仅编译杀、非等价豁免）。
  { name: "WF-300: 未标隔离的写请求不再被拦（直接烧 token）", file: "src/workflows/engine.ts", tests: 'test/issue-231-*.test.mjs', find: "const unisolatedWrite = boundary === undefined && requestedWriteToolNames(gated.tools).length > 0;", replace: "const unisolatedWrite = false;" },
  { name: "WF-301: 工具面不跟边界走（写工具在只读面也可见）", file: "src/workflows/engine.ts", tests: 'test/issue-231-*.test.mjs', find: "const gatedMode: ToolMode = boundary ? 'worktree' : 'read-only';", replace: "const gatedMode: ToolMode = 'read-only';" },
  { name: "WF-302: 写工具自身的模式硬闸反了（只读面反而放行写）", file: "src/workflows/tool-write.ts", tests: 'test/issue-231-*.test.mjs', find: "  if (context.mode === 'worktree') return undefined;", replace: "  if (context.mode !== 'worktree') return undefined;" },
  { name: "WF-303: apply_patch 多处命中不再拒（改错地方还自称成功）", file: "src/workflows/tool-write.ts", tests: 'test/issue-231-*.test.mjs', find: "    if (matches > 1) {", replace: "    if (false) {" },
  { name: "WF-304: realpath 段只查目标本身（界内 symlink 目录下的新文件成逃逸口）", file: "src/workflows/tool-boundary.ts", tests: 'test/issue-231-*.test.mjs', find: "  const deepest = deepestExisting(resolved);", replace: "  const deepest: string | undefined = realpathSync(resolved);" },
  { name: "WF-305: 脏树闸门移除（在有人未提交的工作上 branching）", file: "src/workflows/worktree-service.ts", tests: 'test/issue-231-*.test.mjs', find: "    if (await hasUncommittedChanges(this.git, repoRoot)) {", replace: "    if (false) {" },
  { name: "WF-306: worktree 套 worktree 闸门移除", file: "src/workflows/worktree-service.ts", tests: 'test/issue-231-*.test.mjs', find: "    if (isWithinBoundary(repoRoot, this.worktreesRoot)) {", replace: "    if (false) {" },
  { name: "WF-307: 硬上限判据放宽一格（第 51 件仍照建）", file: "src/workflows/worktree-quota.ts", tests: 'test/issue-231-*.test.mjs', find: "  if (input.preservedCount >= input.gates.keepQuotaCount) blocked.push('keep-quota-count');", replace: "  if (input.preservedCount > input.gates.keepQuotaCount) blocked.push('keep-quota-count');" },
  { name: "WF-308: 磁盘可用下界归零（只剩 0 字节也敢建）", file: "src/workflows/worktree-quota.ts", tests: 'test/issue-231-*.test.mjs', find: "export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;", replace: "export const MIN_FREE_BYTES = 0;" },
  { name: "WF-309: 软阈值比例抬高（配额告警永远不响）", file: "src/workflows/worktree-quota.ts", tests: 'test/issue-231-*.test.mjs', find: "export const QUOTA_SOFT_THRESHOLD_RATIO = 0.8;", replace: "export const QUOTA_SOFT_THRESHOLD_RATIO = 1.6;" },
  { name: "WF-310: 计数口径把在建的也算进去（自己把自己拒掉）", file: "src/workflows/worktree-quota.ts", tests: 'test/issue-231-*.test.mjs', find: "  const kept = entries.filter((entry) => entry.state === 'preserved');", replace: "  const kept = entries.filter((entry) => entry.state !== 'removed');" },
  { name: "WF-311: 删除不走 fence（clean 检查与删除之间留窗口）", file: "src/workflows/worktree-service.ts", tests: 'test/issue-231-*.test.mjs', find: "      fs.renameSync(worktreePath, path.join(trash, id));", replace: "      fs.rmSync(worktreePath, { recursive: true, force: true });" },
  { name: "WF-312: 未合并提交判不准时按「没有」处理（丢工作）", file: "src/workflows/worktree-git.ts", tests: 'test/issue-231-*.test.mjs', find: "  if (!Number.isFinite(count)) return true;", replace: "  if (!Number.isFinite(count)) return false;" },
  { name: "WF-313: 销毁谓词不再把 stderr 当成有活", file: "src/workflows/worktree-git.ts", tests: 'test/issue-231-*.test.mjs', find: "  if (result.code !== null && result.code !== 0) return true;\n  if (result.stderr.trim() !== '') return true;", replace: "  if (result.code !== null && result.code !== 0) return true;" },
  { name: "WF-314: 公共前缀丢掉 gc.auto=0（并发 gc 互踩对象库）", file: "src/workflows/worktree-git.ts", tests: 'test/issue-231-*.test.mjs', find: "export const GIT_NO_GC_ARGS: readonly string[] = ['-c', 'gc.auto=0', '--no-optional-locks'];", replace: "export const GIT_NO_GC_ARGS: readonly string[] = [];" },
  { name: "WF-315: 重试不再共享同一件（active 那件被当成已收场）", file: "src/workflows/worktree-service.ts", tests: 'test/issue-231-*.test.mjs', find: "      if (existing && (existing.state === 'starting' || existing.state === 'active')) {", replace: "      if (existing && existing.state === 'starting') {" },
  { name: "WF-316: 同 id 重复登记静默覆盖（两件活记成一件）", file: "src/workflows/worktree-registry.ts", tests: 'test/issue-231-*.test.mjs', find: "    if (this.items.has(input.id)) throw new Error(", replace: "    if (false) throw new Error(" },
  { name: "WF-317: 登记簿未 load 就给空账（配额与面板看到零保留）", file: "src/workflows/worktree-registry.ts", tests: 'test/issue-231-*.test.mjs', find: "    if (!this.loaded) throw new Error(", replace: "    if (false) throw new Error(" },
  { name: "WF-318: 隔离路的 cwd 不挪到那块件（写回共享工作区）", file: "src/workflows/engine.ts", tests: 'test/issue-231-*.test.mjs', find: "        outcome = await this.attemptPath(context, record, adapter, prompt, gated, toolNames, mode, opened.cwd);", replace: "        outcome = await this.attemptPath(context, record, adapter, prompt, gated, toolNames, mode, this.deps.workspaceDir);" },
  { name: "WF-319: 配额硬上限那道闸失效应照建（fail-open）", file: "src/workflows/worktree-service.ts", tests: 'test/issue-231-*.test.mjs', find: "    if (quota.level === 'blocked') {", replace: "    if (quota.level === 'blocked' && false) {" },
  { name: "WF-320: 结算前不收场（worktree 永不删也永不定性保留）", file: "src/workflows/engine.ts", tests: 'test/issue-231-*.test.mjs', find: "        if (opened.managedId) kept = await this.worktrees().release(opened.managedId).catch(() => undefined);", replace: "        void opened.managedId;" },
  { name: "WF-321: 有改动的件被记成已删除（preserved 失真）", file: "src/workflows/engine.ts", tests: 'test/issue-231-*.test.mjs', find: "    record.worktree = { path: kept.path, branch: kept.branch, preserved: kept.kept,", replace: "    record.worktree = { path: kept.path, branch: kept.branch, preserved: false," },
  { name: "WF-322: 归档不看超期（未到期的保留项也被打成 bundle）", file: "src/workflows/worktree-service.ts", tests: 'test/issue-231-*.test.mjs', find: "        if (Date.parse(entry.at) > cutoff) continue;", replace: "        if (false) continue;" },
  { name: "WF-323: 自动归档不再默认关", file: "src/workflows/worktree-service.ts", tests: 'test/issue-231-*.test.mjs', find: "    if (!options.autoArchive) return [];", replace: "    if (false) return [];" },
  { name: "WF-324: pin 不查 git 注册表（目录存在就当 worktree）", file: "src/workflows/worktree-service.ts", tests: 'test/issue-231-*.test.mjs', find: "      if (!(await isRegisteredLinkedWorktree(this.git, repoRoot, pinned))) {", replace: "      if (false) {" },
  { name: "WF-325: 配额拒建的审计不落账", file: "src/workflows/worktree-service.ts", tests: 'test/issue-231-*.test.mjs', find: "      this.recordQuota('worktree-quota-blocked', runId, 'blocked', quota);", replace: "      void quota;" },
  { name: "WF-326: 审计 actor 不再换成 run 归属（谁起的查不出来）", file: "src/workflows/engine.ts", tests: 'test/issue-231-*.test.mjs', find: "      actor: this.runs.get(event.runId)?.index.ownerSessionId ?? event.actor,", replace: "      actor: event.actor," },
  { name: "WF-327: 人工丢弃的审计把结果写错（留痕说不出干了什么）", file: "src/workflows/worktree-service.ts", tests: 'test/issue-231-*.test.mjs', find: "        result: 'discarded',", replace: "        result: 'not-found'," },
  { name: "WF-328: 面板字节口径不做单位换算（1536 显示成 1536 B）", file: "src/tui/controller-logic.ts", tests: 'test/issue-231-*.test.mjs', find: "  while (scaled >= 1024 && index < SIZE_UNITS.length - 1) {", replace: "  while (false && scaled >= 1024 && index < SIZE_UNITS.length - 1) {" },
  { name: "WF-329: 软阈值告警在 TUI 侧不可见（只留审计一条腿）", file: "src/tui/controller-logic.ts", tests: 'test/issue-231-*.test.mjs', find: "  return level === 'warn' || level === 'blocked';", replace: "  return false;" },
  { name: "WF-330: 结算后的自动归档接线移除（开了设置也不归档）", file: "src/workflows/engine.ts", tests: 'test/issue-231-*.test.mjs', find: "    if (this.gates.autoArchive) void this.archiveWorktreesDue().catch(() => undefined);", replace: "    void this.gates.autoArchive;" },
  { name: "WF-331: 保留尾巴不拼进该路文本（人看得见账、看不见话）", file: "src/workflows/engine.ts", tests: 'test/issue-231-*.test.mjs', find: "    return { ...outcome, value: `${outcome.value}\\n[worktree preserved: ${kept.path} (branch ${kept.branch})]` };", replace: "    return outcome;" },
];

let killedByTest = 0;
let killedByBuild = 0;
let survived = 0;
let equivalent = 0;
const results = [];

// 全量套件（改后全量 / PR 门禁走它）
const TEST_GLOB = 'test/*.test.mjs';
/**
 * 变异内环提速（不改变"是否有测试变红"的判定语义）：
 *  1) --bail：首个失败即停——检测只需知道红没红，无需跑完 1464 例。
 *     ⚠ 前提：基线必须绿（见下方 preflight），否则 --bail 会在既有红上误判 KILLED。
 *  2) 逐点窄口：变异点可带 `tests` 字段显式指定覆盖测试；src/workflows/ 下的点
 *     自动回退到 workflows 测试（issue-224..228），其余回退全量。
 * 不做"全局排除 e2e"——cluster/mcp 类变异的杀手测试恰是集成测试，排掉会漏杀。
 */
const WORKFLOW_TESTS = 'test/issue-224-*.test.mjs test/issue-225-*.test.mjs test/issue-226-*.test.mjs test/issue-227-*.test.mjs test/issue-228-*.test.mjs test/issue-229-*.test.mjs test/issue-230-*.test.mjs test/issue-231-*.test.mjs';
const TEST_FILES = process.env.ONLY_TESTS || TEST_GLOB;

// 中断恢复（#145 REJECT 修正点②）：跟踪当前已写入的突变体，收到 SIGINT/SIGTERM 先还原再退出，
// 防止突变体残留污染工作树（事故：套件被误杀致 STO-1 残留在 audit-log.ts，污染后续测量数字）。
let activeMutation = null; // { file, orig }
function restoreActiveMutation() {
  if (activeMutation) {
    try {
      writeFileSync(activeMutation.file, activeMutation.orig);
      console.log(`\n[interrupt] restored ${activeMutation.file}`);
    } catch { /* 还原尽力而为，绝不掩盖退出信号 */ }
    activeMutation = null;
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restoreActiveMutation();
    process.exit(128 + (sig === 'SIGINT' ? 2 : 15));
  });
}

// #177：单点重跑过滤（ONLY=SUB-1,OPD-3,OPD-4）——按点名前缀子串匹配
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);

// ═══════════════════════════════════════════════════════════
// 变异安全带（#145 事故教训：残留变异体污染后续测量）
//
// 逐点备份/还原 + 信号处理器已经覆盖了 SIGINT/SIGTERM；剩下唯一的口子是
// SIGKILL / 断电 —— 那种情形下 git 是最后一层兜底：
//   · 跑前：工作树必须干净，不干净拒跑（否则"还原"无法用 git diff 验证）；
//   · 跑后：`git diff --exit-code` 自检，非空即报警并还原。
// 开发期每轮变异前先提交到集成分支，即可满足"跑前干净"。
// ═══════════════════════════════════════════════════════════
function gitPorcelain() {
  return execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

if (!process.env.SKIP_GIT_SAFETY) {
  const dirty = gitPorcelain();
  if (dirty) {
    console.error('[safety] 拒绝运行：git 工作树不干净（残留变异体会污染测量）。先提交或清理：\n' + dirty);
    process.exit(1);
  }
} else {
  console.log('[safety] SKIP_GIT_SAFETY=1：跳过跑前干净检查（仅限无 git 的环境）');
}

// ── preflight：基线必须绿，否则 --bail 会在既有红上误杀、变异分数无效（T1 红线）──
if (!process.env.SKIP_PREFLIGHT) {
  process.stdout.write('[preflight] 基线全绿校验（--bail，最多 240s）… ');
  try {
    execSync(`bun test --bail --timeout 120000 ${TEST_FILES} 2>&1`, { stdio: 'pipe', encoding: 'utf8', env: { ...process.env, CI: '1' }, timeout: 240_000 });
    console.log('绿 → 开始变异。');
  } catch (e) {
    const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
    const fails = (out.match(/(\d+) fail/) || [])[1] || '?';
    const bad = out.split('\n').filter((l) => /^\(fail\)|^\(error\)/.test(l)).slice(0, 30).join('\n');
    console.log(`红（${fails} fail）→ 变异门禁中止。`);
    console.log('[preflight] 基线非绿时跑变异无意义。先修以下红，或确认无碍后 SKIP_PREFLIGHT=1 强跑：\n' + bad);
    process.exit(1);
  }
}

for (let i = 0; i < mutations.length; i++) {
  const m = mutations[i];
  if (ONLY.length && !ONLY.some((p) => m.name.includes(p))) continue;
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
  activeMutation = { file: m.file, orig };
  try {
    // 每点超时加固（#171 会话教训：无 timeout 的 execSync 遇挂起测试会永久阻塞——2026-08-16
    // 首跑在 SKL 点挂死 77 分钟）：build 120s、全量测试 480s，超时即 KILLED（挂起=可观测行为破坏）。
    execSync('bun run build 2>&1', { stdio: 'pipe', timeout: 120_000 });
  } catch (e) {
    killedByBuild++;
    results.push({ name: m.name, status: e.killed ? 'KILLED (build timeout)' : 'KILLED (build error)' });
    console.log(e.killed ? 'KILLED (build timeout)' : 'KILLED (build)');
    writeFileSync(m.file, orig);
    activeMutation = null;
    continue;
  }
  try {
    const files = m.tests || (m.file.startsWith('src/workflows/') ? WORKFLOW_TESTS : TEST_FILES);
    const out = execSync(`bun test --bail --timeout 120000 ${files} 2>&1`, { stdio: 'pipe', encoding: 'utf8', env: { ...process.env, CI: '1' }, timeout: 480_000 });
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
    if (e.killed) {
      results.push({ name: m.name, status: 'KILLED (test timeout 480s)' });
      console.log('KILLED (test timeout)');
    } else {
      const out = e.stdout?.toString() || '';
      const failMatch = out.match(/(\d+) fail/);
      results.push({ name: m.name, status: `KILLED (test exited: ${failMatch ? failMatch[1] + ' fail' : 'nonzero'})` });
      console.log(`KILLED (${failMatch ? failMatch[1] + ' fail' : 'nonzero exit'})`);
    }
  }
  writeFileSync(m.file, orig);
  activeMutation = null;
}

// 恢复正确状态
execSync('bun run build 2>&1', { stdio: 'pipe' });

// 安全带自检：跑完必须与开跑前逐字节一致（残余变异体 = 报警 + 还原）
if (!process.env.SKIP_GIT_SAFETY) {
  const after = gitPorcelain();
  if (after) {
    console.error('\n[safety] 报警：跑后工作树仍有差异，判定为残留变异体，正在用 git 还原：\n' + after);
    try {
      execSync('git checkout -- .', { stdio: 'pipe' });
      execSync('bun run build 2>&1', { stdio: 'pipe' });
      console.error('[safety] 已还原并重建。');
    } catch { /* 还原尽力而为，报警信息已经打出 */ }
    process.exitCode = 1;
  } else {
    console.log('[safety] 跑后自检通过：工作树与开跑前一致。');
  }
}

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
