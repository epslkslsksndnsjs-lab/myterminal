# MyTerminal 工具系统审查报告：GPT/Claude 网页端匹配度 & 错误率评估

**日期**：2026-07-25
**工作流**：工作流 1（全面代码审查）+ 工作流 5（技术债评估）混合
**参与成员**：Cody（代码审查师）/ Archi（架构师）/ Tessa（测试专家）
**审查对象**：main 分支（commit ea5407f）工具系统——extensions.ts / mcp.ts / core-tools.ts / cluster-router.ts / server.ts / security.ts / types.ts / store.ts / test/

---

## 📌 TL;DR（执行摘要）

- **整体结论**：工具系统在 **GPT 通道（Actions API）** 上架构完整、质量良好；但 **MCP 通道（Claude）** 存在致命缺陷——26 个直接工具中 24 个无法传递 `identity`，导致 Claude 调用时必然返回 `IDENTITY_REQUIRED`，**MCP 通道工具调用错误率 ≈ 92%**，远超 10% 目标。
- **严重度分布**：🔴严重 2 项 / 🟠高 6 项 / 🟡中 8 项 / 🟢低 8 项；另含测试缺口 P0×4 / P1×4 / P2×3
- **阻塞 / 非阻塞**：2 项 🔴严重为阻塞项——修复后 MCP 通道错误率可从 ~92% 降至 <5%，Actions 通道错误率指标可消除系统性污染
- **"<10% 错误率"目标**：Actions 通道预计可达标（<5%）；MCP 通道当前 ≈92%，修复 identity 缺陷后预计可达标（<5%）；但当前**无法持续验证**——缺少错误率度量计算层和 /health 暴露

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| 整体评级 | 🟡 有条件通过 |
| 阻塞项数量 | 2 |
| 关键行动项 | 6 条 |
| 建议下一步 | 基于 main 新建干净分支修复 MCP identity 缺陷（⚠️ **不可合并 `fix/mcp-session-state`——该分支为测试分支，含不稳定工具**）；修复 `failure()` 错误码启发式猜测；补建错误率度量层使 <10% 目标可验证 |

### 对核心问题的直接回答

| 问题 | 结论 |
|------|------|
| 工具系统是否匹配"连接 GPT/Claude 网页端"定位？ | **🟡 部分匹配**——GPT 通道完整匹配，MCP 通道（Claude）因 identity 缺陷实际不可用 |
| 工具调用错误率能否做到 <10%？ | **修复前：否**（MCP 通道 ≈92%）；**修复后：是**（预计 <5%）；但当前**无法持续验证**（缺度量层） |

---

## 🔍 审查发现（按严重度排序，已去重合并三方产出）

### 🔴 严重（2 项——阻塞）

| # | 类别 | 文件:行 | 问题描述 | 建议修复 | 来源 |
|---|------|---------|---------|---------|------|
| 1 | ⚡架构+正确性 | mcp.ts:165-169, extensions.ts:425-430 | **MCP 直连工具无法传递 identity**：`registerDirect()` 将 MCP 工具调用包装为 `{tool, input}`，不包含 `identity` 字段。直接工具的 zod schema 也不含 `identity`。当 Claude 不发送 `openai/session` meta 时，`authenticate()` 无法获取身份 → 24/26 直接工具必然返回 `IDENTITY_REQUIRED`。**MCP 通道错误率 ≈ 92%（24/26）**。 | 方案A（最小改动）：`registerDirect` schema 统一添加 `identity: optionalIdentitySchema`，包装时携带。方案B（架构正确）：引入 `'mcp'` transport 类型，在 MCP transport 层缓存 `mcp-session-id → MyTerminal session` 映射，`contextFromCall` 从映射恢复 identity。⚠️ **注意：`fix/mcp-session-state` 分支虽涉及此修复但为测试分支（含不稳定工具），不可直接合并，需基于 main 新建干净分支实施。** | Archi + Cody |
| 2 | ⚡错误处理 | extensions.ts:78-83 | **错误码启发式猜测导致系统性误分类**：`failure()` 对非 MyTerminalError 的 plain Error 使用消息文本匹配猜测错误码——`includes('not found')→NOT_FOUND`、`includes('required')‖includes('must')→INVALID_INPUT`、否则→EXTENSION_ERROR。导致：`apply_patch` 抛 "oldText was not found" → 误归类 NOT_FOUND；`resolveWorkspacePath` 抛 "Path escapes workspace" → 误归类 EXTENSION_ERROR（应为 SECURITY_VIOLATION）。core-tools.ts 中 14+ 处 `throw new Error()` 均走此路径，**错误率指标被系统性污染**。 | 让工具内部错误抛 `MyTerminalError`（含 code 字段）而非 plain Error；或为 `failure()` 增加基于 `error.code`/`error.constructor.name` 的映射表，而非消息文本匹配。 | Cody |

### 🟠 高（6 项）

| # | 类别 | 文件:行 | 问题描述 | 建议修复 | 来源 |
|---|------|---------|---------|---------|------|
| 3 | ⚡错误处理 | extensions.ts:425-430 | **policy_rejected 覆盖不全**：issue #4 仅将 `NEXT_CALL_REQUIRED` 和 `CONTINUATION_PLAN_REQUIRED` 归类为 `policy_rejected`，但 `CHECKPOINT_REQUIRED`（store.ts:302）和 `CHILD_REVIEW_REQUIRED`（store.ts:375）同样是策略拦截，却被映射到 `failed`，**将策略拦截计入失败率，使错误率指标失真**。 | 将 `CHECKPOINT_REQUIRED` 和 `CHILD_REVIEW_REQUIRED` 加入 `isPolicyRejection` 判断。 | Cody |
| 4 | ⚡正确性 | extensions.ts:88-97, 401-405 | **NON_ZERO_EXIT 错误归类**：`resultProblem()` 将所有 `exitCode !== 0` 的命令结果归类为失败（`ok: false`，error code `NON_ZERO_EXIT`）。`grep` 返回 1（无匹配）、`test` 返回 1（条件为假）等**合法非零退出被计为工具调用错误**，直接抬高错误率。 | 为 `execute_cli` 增加 `expectedExitCodes` 参数；或审计中将 NON_ZERO_EXIT 单列为非 failed 状态。 | Cody |
| 5 | ⚡可观测性 | extensions.ts:357-434 | **bootstrap 工具失败审计缺失**：`session_register`/`session_inherit` 的 `beginAudit` 仅在工具成功后才调用。如果工具抛异常，`sessionId` 为 undefined，`auditStarted` 为 false，**失败审计永远不会被记录**，bootstrap 失败在错误率指标中完全不可见。 | 在 `invokeTool` 返回 identity 后立即 `beginAudit`，或增加预审计机制。 | Cody |
| 6 | 安全 | core-tools.ts:238-239 | **search_text ReDoS 风险**：`new RegExp(query, 'i')` 直接编译用户输入，无 ReDoS 防护。灾难性正则（如 `/(a+)+$/`）在 1MB 文件上可阻塞事件循环。LLM 可能生成此类正则。 | 增加 regex 超时检测（vm 沙箱）或限制 regex 复杂度，或回退纯文本匹配。 | Cody |
| 7 | ⚡架构 | types.ts, mcp.ts:111-117 | **缺少 'mcp' transport 类型**：`InvocationContext.transport` 类型为 `'apps'|'actions'|'tui'|'test'`，无 `'mcp'`。`contextFromCall()` 硬编码 `transport: 'apps'`，MCP 调用被伪装为 Apps，代码路径语义不明确，Apps binding 回退逻辑被错误触发。 | 扩展 transport 类型加 `'mcp'`，`contextFromCall` 返回 `transport: 'mcp'`。 | Archi |
| 8 | ⚡架构 | mcp.ts, extensions.ts | **MCP transport 层不缓存 session 身份**：`MyTerminalMcpTransport` 管理 MCP session 但不关联 MyTerminal session；`contextFromCall` 不使用 `mcp-session-id`。Claude 无法获得"一次注册、持续可用"的体验。 | 在 `LiveSession` 中增加 `myTerminalSessionId?` 字段，`session_register`/`session_inherit` 成功后自动绑定；`contextFromCall` 从 `LiveSession` 恢复 identity。 | Archi |

### 🟡 中（8 项）

| # | 类别 | 文件:行 | 问题描述 | 建议修复 | 来源 |
|---|------|---------|---------|---------|------|
| 9 | ⚡错误处理 | server.ts:567-570 | **HTTP 状态码映射不精确**：`EXTENSION_ERROR`（内部错误）→400（应为 500）；`NON_ZERO_EXIT`/`ACTION_TIMEOUT`→400；`NEXT_CALL_REQUIRED`/`CONTINUATION_PLAN_REQUIRED`→400（应为 409）。 | 增加细粒度 HTTP 状态映射：500 for EXTENSION_ERROR，409 for policy rejections，422 for INVALID_INPUT。 | Cody |
| 10 | 性能 | store.ts:859,1016,1026 | **appendFileSync 同步阻塞**：`appendHistory` 和 `save()` 在热路径中同步阻塞事件循环。每次工具调用至少触发一次 appendHistory。 | 改用 `fs.promises.appendFile` 或写入队列批处理。 | Cody |
| 11 | 正确性 | core-tools.ts:225-255 | **文件工具不检查 abort signal**：`search_text`/`find_files` 的 `walkFiles()` 及文件读取循环不检查 `context.signal`，运行时关闭时不会被中断。`execute_cli`/`git_*` 已正确处理。 | 在 `walkFiles` 和 `search_text` 循环中检查 `context.signal?.aborted`。 | Cody |
| 12 | 安全 | store.ts:944-970 | **sanitize 不含 command 字段**：`execute_cli` 的 command 参数可能含密钥（如 `curl -H "X-API-Key: secret"`），但 `command` 不在敏感 key 检测模式中。 | 将 `command` 加入敏感 key 检测，或做更通用的密钥模式扫描。 | Cody |
| 13 | 正确性 | extensions.ts:53-58 | **callArguments 无冲突检测**：`arguments`、`inputJson`、`input` 三个来源用 spread 合并，无冲突检测，可能静默混入键。 | 文档明确优先级语义，或仅取最高优先级来源。 | Cody |
| 14 | 正确性 | security.ts:55-63 | **validateJsonSchema 不完整**：仅处理 `additionalProperties === false`，不处理 `additionalProperties` 为 schema 对象的情况。 | 补充 schema 对象时的校验逻辑。 | Cody |
| 15 | ⚡可观测性 | extensions.ts, server.ts | **错误率度量层完全缺失**：无错误率计算方法、无时间窗口查询、/health 端点不含错误率、无告警机制、无指标导出。原始审计数据完整但无法自动化计算。"<10% 错误率"目标理论可验证，实践无法持续监控。 | 三阶段补建：①度量计算方法 + /health 暴露 ②定时检查 + /metrics 端点 ③TUI 告警 + 趋势追踪。 | Tessa |
| 16 | 架构 | extensions.ts | **TUI register 绕过 audit**：`registerFromTui()` 直接操作 store，不经过 `call()` 的 authenticate/audit/continuation 路径，审计日志缺失 TUI 注册操作。 | TUI 注册改为调用 `call()`，或至少补充审计日志。 | Archi |

### 🟢 低（8 项）

| # | 类别 | 文件:行 | 问题描述 | 建议修复 | 来源 |
|---|------|---------|---------|---------|------|
| 17 | 架构 | server.ts:515 | `toolsExposed` 硬编码为 3，实际暴露 29 个工具，误导监控。 | 改为 `this.builtins.size + 1`。 | Archi |
| 18 | 架构 | core-tools.ts | 缺少文件删除/移动/重命名/目录创建直接工具，必须通过 `execute_cli`。 | 新增 `delete_file`/`move_file`/`create_dir` 工具。 | Archi |
| 19 | 可维护性 | extensions.ts(41KB), store.ts(65KB) | 两个文件混合 5/7 个职责，超出单文件合理规模。 | 拆分为独立模块。 | Cody |
| 20 | 正确性 | mcp.ts:106 | `toToolResult()` 中 error 为 undefined 时文本为 `undefined: undefined`。 | 增加 fallback `response.error?.code ?? 'UNKNOWN_ERROR'`。 | Cody |
| 21 | 性能 | cluster-router.ts:71-93 | `routeBySession()`/`boundMember()` 顺序遍历，N 个成员最坏 N×6.5s。 | 增加 session→member 映射缓存。 | Cody |
| 22 | 安全 | core-tools.ts:389 | `git_show` revision 正则允许裸选项（如 `--grep`）。 | revision 前加 `--` 分隔符。 | Cody |
| 23 | 正确性 | core-tools.ts:283-313 | `write_file`/`apply_patch` 不检查 `context.signal`，与 `execute_cli`/`git_*` 不一致。 | 写入前检查 `context.signal?.aborted`。 | Cody |
| 24 | 可维护性 | extensions.ts:213 | `closedActionIds.delete(...)` 使用非空断言，虽有守卫但不防御。 | 改为安全取值。 | Cody |

---

## 🏗️ 架构影响评估

### 匹配度评级：🟡 部分匹配

| 通道 | 匹配度 | 说明 |
|------|--------|------|
| GPT（Actions API） | 🟢 完全匹配 | continuation harness（4 模式）、identity 注入、non-blocking tasks、policy_rejected 分类、安全边界全部到位 |
| Claude（MCP） | 🔴 不匹配 | transport 类型缺失、session 身份不缓存、直接工具不支持 identity 传递——24/26 工具必然失败 |
| TUI | 🟡 可接受 | 有意分叉（信任边界不同），但审计缺失 |

### 多通道汇聚设计

`ExtensionService.call()` → `invokeTool()` 是 Actions/MCP 的统一入口，设计基本成立。但存在 3 个分叉点：
1. **Transport 类型缺失**：MCP 硬编码为 `'apps'`，非显式 `'mcp'`
2. **TUI 绕过 call()**：`registerFromTui()` 直接操作 store
3. **Cluster 路由**：通过 HTTP RPC 转发，设计合理不改变工具语义

### 架构债清单（Priority = (Impact + Risk) × (6 - Effort)）

| 债 | 影响面 | 风险 | 修复投入(1-5) | Priority | 来源 |
|----|--------|------|-------------|----------|------|
| MCP 直接工具 identity 缺失 | MCP 通道 92% 错误率 | 5 | 2 | (5+5)×(6-2)=40 | Archi+Cody |
| 缺少 mcp transport 类型 | 代码路径语义不明 | 4 | 1 | (4+4)×(6-1)=40 | Archi |
| MCP session 身份不缓存 | Claude 无法持续可用 | 4 | 2 | (4+4)×(6-2)=32 | Archi |
| TUI register 绕过 audit | 审计盲区 | 3 | 2 | (3+3)×(6-2)=24 | Archi |
| toolsExposed 硬编码 | 监控误判 | 2 | 1 | (2+2)×(6-1)=20 | Archi |
| 缺少文件管理工具 | 体验不佳 | 2 | 3 | (2+2)×(6-3)=12 | Archi |

### 架构亮点（值得肯定的设计）

1. **Cluster 路由**：session 亲和性 + App binding 亲和性，多 workspace 共享端口
2. **安全边界**：`resolveWorkspacePath` 防 path traversal（含 symlink）、`safeEqual` timing-safe 比较、`runCommand` 使用 `shell: false`
3. **Continuation harness**：四模式精确控制 GPT 长任务行为
4. **Non-blocking tasks**：200ms fast-return + task_poll + retention/maxBytes/trim 三重限制
5. **Control channel monitor**：指数退避重连 + 故障分类 + resume 恢复
6. **原子状态持久化**：temp+rename 原子写入 + journal 机制，崩溃恢复可靠

---

## 🧪 测试覆盖评估

### 测试套件概览

| 测试文件 | 测试数 | 聚焦领域 |
|---|---|---|
| myterminal.test.mjs | ~67 | 全功能集成测试 |
| stability-regression.test.mjs | 10 | 稳定性回归 |
| cli-regression.test.mjs | 1 | CLI 鲁棒性 |
| docs.test.mjs | 6 | 文档链接/版本一致性 |
| **合计** | **~84** | |

### 测试覆盖矩阵（工具类别 × 路径）

| 工具类别 | 正常 | 参数错误 | Policy 拦截 | 执行异常 | 超时 |
|---|---|---|---|---|---|
| Facade (3) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Session (12) | ✅ | ✅ | ✅ | ✅ | ✅ |
| File (7) | ✅ | 🟡 | N/A | 🟡 | N/A |
| Code Mod (1) | 🔴 | 🔴 | N/A | 🔴 | N/A |
| Shell (1) | ✅ | 🔴 | N/A | ✅ | ✅ |
| Blob (3) | ✅ | 🔴 | N/A | ✅ | N/A |
| Git (4) | ✅ | 🔴 | N/A | 🔴 | 🔴 |
| CI (1) | 🔴 | 🔴 | N/A | 🔴 | 🔴 |
| Message (4) | ✅ | 🔴 | N/A | 🔴 | N/A |

### Issue #4 功能测试：🟢 充分

- `policy_rejected` 分类：2 个专门测试（NEXT_CALL_REQUIRED + CONTINUATION_PLAN_REQUIRED）
- 参数别名（pattern→query）：1 个测试验证 Claude Code 兼容性
- 错误码 fallback（UNKNOWN_ERROR）：1 个测试验证审计完整性

### 错误率可观测性评级：🟡 部分可验证

| 能力 | 状态 |
|------|------|
| 工具调用审计事件 | ✅ 每次调用记录 running→terminal 事件 |
| 审计状态分类（5种） | ✅ running/completed/failed/timeout/policy_rejected |
| 错误码记录 + UNKNOWN_ERROR fallback | ✅ |
| 审计持久化 + 查询（最多 5000 条） | ✅ |
| 敏感值脱敏 | ✅ |
| **错误率计算方法** | 🔴 不存在 |
| **时间窗口查询** | 🔴 不存在 |
| **按工具/错误码分组** | 🔴 不存在 |
| **/health 暴露错误率** | 🔴 不存在 |
| **错误率告警** | 🔴 不存在 |
| **指标导出（Prometheus等）** | 🔴 不存在 |

**结论**：原始审计数据完整，理论上可手动计算错误率，但实践中无法持续监控。"<10% 错误率"目标当前**无法持续验证**。

### 缺失测试清单

**P0（高风险）**：
1. `apply_patch` 工具完全未测试（核心功能零覆盖）
2. `run_checks` 工具未直接测试
3. MCP 通道错误路径未测试（仅覆盖 happy path）
4. 自定义扩展命令执行失败路径未测试

**P1（中风险）**：
5. Git 工具错误路径未测试
6. Blob read 未直接测试
7. 并发工具调用竞争条件未测试
8. Schema 验证错误未系统测试

**P2（低风险）**：
9. session_unregister / session_tag 未直接测试
10. 错误率度量功能测试（待功能实现后）
11. write_file SHA 乐观锁未测试

---

## ✅ 行动清单（按优先级排序）

| # | 行动 | 负责角色 | 紧急度 | 预期完成 |
|---|------|---------|--------|---------|
| 1 | 基于 main 新建干净分支修复 MCP 直连工具 identity 传递（阻塞项 #1），使 MCP 通道从 92% 错误率降至可用。⚠️ **不可合并 `fix/mcp-session-state`（测试分支，含不稳定工具），需从 main 新建分支只提取 MCP identity 修复逻辑** | 后端工程 | P0 | 立即 |
| 2 | 修复 `failure()` 错误码启发式猜测——让 core-tools.ts 中 14+ 处 `throw new Error()` 改为 `throw new MyTerminalError(code, msg)`（阻塞项 #2） | 后端工程 | P0 | 本周 |
| 3 | 补全 `policy_rejected` 分类——将 `CHECKPOINT_REQUIRED` 和 `CHILD_REVIEW_REQUIRED` 加入 `isPolicyRejection`（#3） | 后端工程 | P0 | 本周 |
| 4 | 实现错误率度量层——添加 `errorRate(windowMs)` 方法 + /health 暴露错误率，使"<10%"目标可验证（#15） | 后端工程 | P1 | 2 周内 |
| 5 | 修复 `execute_cli` NON_ZERO_EXIT 错误归类——增加 `expectedExitCodes` 参数或审计分离（#4） | 后端工程 | P1 | 2 周内 |
| 6 | 补 `apply_patch` 和 `run_checks` 测试——核心功能零覆盖（P0 测试缺口） | QA | P1 | 2 周内 |
| 7 | 修复 `search_text` ReDoS 风险——增加 regex 超时或复杂度限制（#6） | 后端工程 | P1 | 2 周内 |
| 8 | 修复 bootstrap 工具失败审计缺失——使 session_register/inherit 失败可被错误率统计捕获（#5） | 后端工程 | P2 | 下个迭代 |
| 9 | 引入 `'mcp'` transport 类型 + MCP session 身份缓存——架构层面彻底修复（#7+#8） | 架构师 | P2 | 下个迭代 |
| 10 | 补 MCP 通道错误路径测试 + Git 工具错误路径测试 | QA | P2 | 下个迭代 |

---

## ⚠️ 待完善 / 已知局限

- 本报告基于 main 分支（commit ea5407f）静态代码审查，未包含运行时错误率实测数据（因当前缺少度量层无法采集）
- `fix/mcp-session-state` 分支虽涉及 MCP identity 修复，但**该分支为测试分支（含不稳定工具），绝对不可合并**——修复需基于 main 新建干净分支实施
- 错误率估算（MCP ≈92%、Actions 预计 <5%）基于代码路径分析，非实测数据
- 集群模式（ClusterExtensionRouter）的审查基于代码阅读，未做多 workspace 实际部署验证
- `store.ts`（65KB）因文件过大仅审查了工具调用/identity/审计相关路径，其他路径（如 migration、update）未深入

---

## 📚 数据来源 & 成员产出索引

- **Archi（架构师）原始产出**：架构影响评估报告——匹配度评级 🟡部分匹配、6 项架构债（CRITICAL×1/HIGH×2/MEDIUM×2/LOW×1）、通道适配分析、架构亮点 6 项
- **Cody（代码审查师）原始产出**：代码审查报告——18 项发现（🔴严重×1/🟠高×5/🟡中×6/🟢低×6）、错误率关键路径标注 ⚡、做得好的地方 7 项
- **Tessa（测试专家）原始产出**：测试评估报告——~84 项测试概览、覆盖矩阵（9 工具类别×5 路径）、Issue #4 功能测试 🟢充分、错误率可观测性 🟡部分可验证、缺失测试 P0×4/P1×4/P2×3、可观测性改进三阶段路线图

---

> 本报告由工程保障团队 AI 协作生成，关键决策请由人类工程负责人复核。
