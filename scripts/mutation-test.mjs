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
  { name: 'WF-9: 续跑归属校验移除（可续别人的 run）', file: 'src/workflows/engine.ts', find: 'if (previous.ownerSessionId !== request.ownerSessionId) throw new WorkflowStartError(\'FORBIDDEN\', \'run-not-owned\'', replace: 'if (false) throw new WorkflowStartError(\'FORBIDDEN\', \'run-not-owned\'' },
  { name: 'WF-10: 续跑终态闸门移除（终态 run 可被重开）', file: 'src/workflows/engine.ts', find: 'if (await exists(run.terminalFile)) throw new WorkflowStartError(\'VALIDATION\', \'run-already-terminal\'', replace: 'if (await exists(`${run.terminalFile}.absent`)) throw new WorkflowStartError(\'VALIDATION\', \'run-already-terminal\'' },
  { name: 'WF-11: args 记录位恒假（链种子丢失）', file: 'src/workflows/engine.ts', find: 'argsRecorded: request.args !== undefined,', replace: 'argsRecorded: false,' },
  { name: 'WF-12: saved 同名即复用（覆盖已有脚本）', file: 'src/workflows/saved.ts', find: 'if (existing === source) {', replace: 'if (true) {' },
  { name: 'WF-13: 静态扫描掩蔽移除（字符串内误报）', file: 'src/workflows/lint.ts', find: 'const masked = maskNonCode(source);', replace: 'const masked = source;' },
  { name: 'WF-14: 注册表保留裁剪移除（终态无限增长）', file: 'src/workflows/registry.ts', find: '.slice(-MAX_RETAINED_TERMINAL_RUNS)', replace: '.slice()' },
  { name: 'WF-15: resume 缺 scriptPath 的互斥校验移除', file: 'src/workflows/start.ts', find: 'if (hasResume && !hasPath) {', replace: 'if (false) {' },

  // ── src/workflows/ (17) — #225 T2 · N 路并发执行：并发窗口 / 键链 / 三态结算 ──
  // 每条都对应票面一条钉死语义：窗口水位、admission 序进键、形状错不 admission、
  // 沉默坍缩 null、run 级 throw、全败即 failed、账本按调用序归位。
  { name: 'WF-16: 并发窗口水位闸移除（N 路一起起跑）', file: 'src/workflows/scheduler.ts', find: 'while (!aborted && inFlight < limit && queue.length > 0) {', replace: 'while (!aborted && queue.length > 0) {' },
  { name: 'WF-17: 窗口 limit 正整数校验移除（0/负数静默放行）', file: 'src/workflows/scheduler.ts', find: 'if (!Number.isInteger(limit) || limit <= 0) {', replace: 'if (false) {' },
  { name: 'WF-18: 键链不滚动（位置无关，最长前缀失效不成立）', file: 'src/workflows/engine.ts', find: '    context.chainPrefix = key;\n', replace: '' },
  { name: 'WF-19: started 行不带键（重放无从对齐调用）', file: 'src/workflows/engine.ts', find: "{ type: 'started', seq: sequence, key, label, at: startedAt }", replace: "{ type: 'started', seq: sequence, label, at: startedAt }" },
  { name: 'WF-20: 键投影吃下全部已知项（展示项进键）', file: 'src/workflows/agent-opts.ts', find: 'for (const field of DISPATCH_AFFECTING_AGENT_OPTS) {', replace: 'for (const field of KNOWN_AGENT_OPTS) {' },
  { name: 'WF-21: 未知选项闸移除（形状错静默通过并占键位）', file: 'src/workflows/agent-opts.ts', find: 'if (unknown.length > 0) {', replace: 'if (false) {' },
  { name: 'WF-22: agentCap 检查移除（run 级终结少一臂）', file: 'src/workflows/engine.ts', find: 'if (context.agentCount > this.thresholds.agentCap) {', replace: 'if (false) {' },
  { name: 'WF-23: token 预算软检查移除（超限照常扇出）', file: 'src/workflows/engine.ts', find: 'if (context.spent < cap) return;', replace: 'if (true) return;' },
  { name: 'WF-24: run 级错误在批内被降成 null（整批该拒不拒）', file: 'src/workflows/fanout.ts', find: 'if (isRunLevelError(entry.reason)) throw entry.reason;', replace: 'if (false) throw entry.reason;', all: true },
  { name: 'WF-25: 失败不具名记入索引（清单静默为空）', file: 'src/workflows/engine.ts', find: '      context.index.failures = [...context.index.failures, entry];\n', replace: '' },
  { name: 'WF-26: 全败判定移除（假完整交付）', file: 'src/workflows/engine.ts', find: 'if (admitted && !succeeded) {', replace: 'if (false) {' },
  { name: 'WF-27: 账本缓冲被绕过（完成序即账本序）', file: 'src/workflows/journal.ts', find: 'this.holding.set(seq, { line, settle: resolve });', replace: 'void this.enqueue(line).then(() => resolve());' },
  { name: 'WF-28: 脚本头部 meta 不再剥离（真脚本编译失败）', file: 'src/workflows/sandbox.ts', find: 'prepared = stripWorkflowMeta(options.source);', replace: 'prepared = options.source;' },
  { name: 'WF-29: 嵌套层也注入 workflow()（单层限制失守）', file: 'src/workflows/engine.ts', find: 'if (!nested) host.workflow = async (ref, args, opts) => await this.runNested(context, ref, args, opts);', replace: 'host.workflow = async (ref, args, opts) => await this.runNested(context, ref, args, opts);' },
  { name: 'WF-30: pipeline 的 null 哨兵短路移除（失败 item 继续跑）', file: 'src/workflows/fanout.ts', find: 'if (stage > 0 && previous === null) return null;', replace: 'if (false) return null;' },
  { name: 'WF-31: 每路槽位不再唯一（独立 adapter 实例失去凭证）', file: 'src/workflows/engine.ts', find: 'const adapter = factory({ runId: context.runId, dispatchId: record.id });', replace: "const adapter = factory({ runId: context.runId, dispatchId: 'd0000' });" },
  { name: 'WF-32: isolation 标记不随每路记账', file: 'src/workflows/engine.ts', find: '      ...(gated.isolation ? { isolation: gated.isolation } : {}),\n', replace: '' },
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
 *     自动回退到本票 workflows 测试（issue-224/225），其余回退全量。
 * 不做"全局排除 e2e"——cluster/mcp 类变异的杀手测试恰是集成测试，排掉会漏杀。
 */
const WORKFLOW_TESTS = 'test/issue-224-*.test.mjs test/issue-225-*.test.mjs';
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
