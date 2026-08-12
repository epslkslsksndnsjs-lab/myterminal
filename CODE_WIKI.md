# MyTerminal Code Wiki

> 版本：v0.1.2 · 协议：MIT · 运行时：Bun ≥ 1.3
> 本文档由源码静态分析生成，覆盖项目整体架构、模块职责、关键类与函数、依赖关系与运行方式。

---

## 目录

1. [项目概述](#1-项目概述)
2. [项目整体架构](#2-项目整体架构)
3. [技术栈与依赖](#3-技术栈与依赖)
4. [目录结构](#4-目录结构)
5. [核心模块职责详解](#5-核心模块职责详解)
6. [关键类与函数说明](#6-关键类与函数说明)
7. [核心数据流](#7-核心数据流)
8. [依赖关系](#8-依赖关系)
9. [项目运行方式](#9-项目运行方式)
10. [关键不变量与工程约束](#10-关键不变量与工程约束)

---

## 1. 项目概述

MyTerminal 是连接 **ChatGPT 聊天模式与本地开发环境**的终端桥梁。它让普通的 ChatGPT 对话能够以受控、可审计的方式操作本地授权工作区：检视与编辑文件、执行有界命令、协调多个工作会话、并通过本地全窗口 TUI 让用户始终保持控制权。MyTerminal 本身不是聊天客户端，而是 ChatGPT 与本地计算机之间的桥梁。

### 核心能力

- **双通道接入**：GPT Actions（OpenAPI facade）与 ChatGPT Apps（MCP connector）。
- **可审计的工作会话层**：root/delegate 会话层级、可继承、可转交、不可变终态、永久 JSONL 历史。
- **多会话协作**：root 可委派多个直属子会话，子会话不可再委派；通过持久化消息交付可纳入的成果。
- **声明式扩展**：用户可注册 builtin/command 两类自定义扩展。
- **Skill 系统**：用户编写的 `SKILL.md`，支持 inline（直接执行）与 fork（隔离 subagent 异步执行）两种路由模式。
- **Subagent 系统**：隔离的智能体循环，独立的 8 工具集、上下文窗口、成本追踪器，支持 5 个 LLM provider，git worktree 文件隔离。
- **全窗口双语 TUI**：基于 OpenTUI + React 的九页签界面（中/英双语、暖色双主题）。
- **集群与共享端口**：多进程共享同一 `host:port`，自动选主，leader 故障自动接管。
- **安全与隐私**：本地优先、无项目遥测、凭据脱敏单源、会话 token 仅存哈希、工作区即读写安全边界。

---

## 2. 项目整体架构

### 2.1 系统拓扑

```text
ChatGPT Apps / Actions
        |
        | direct low-risk MCP tools or authenticated Actions facade
        v
+----------------------------- shared public host:port -----------------------------+
| Cluster gateway (one elected leader process)                                      |
|  - validates connector / Actions credentials                                      |
|  - routes by workspace identity or authenticated session ownership                |
+--------------------------------------+---------------------------------------------+
                                       |
                  +--------------------+--------------------+
                  |                                         |
                  v                                         v
       Workspace runtime A                       Workspace runtime B
       internal loopback server                  internal loopback server
       ExtensionService                          ExtensionService
       MyTerminalStore                           MyTerminalStore
       workspace-scoped state                    workspace-scoped state

TUI
  App (rendering/composition)
    -> TuiController (use-case orchestration)
    -> workspace-selector / renderer-profile / runtime-settings / credential-visibility
```

### 2.2 分层架构

| 层 | 主要模块 | 职责 |
|---|---|---|
| 入口/配置 | `cli.ts`, `config.ts`, `migration.ts` | 启动、设置、兼容迁移 |
| 运行时/进程 | `server.ts`, `cluster.ts`, `cluster-router.ts`, `control-channel.ts`, `runtime-lifecycle.ts`, `instances.ts` | HTTP/控制生命周期、进程拓扑、路由、租约 |
| 域/状态 | `store.ts`, `types.ts`, `tui-model.ts`, `context-projector.ts` | 会话、消息、事件、journal/snapshot 持久化、审计历史 |
| 扩展门面 | `extensions.ts`, `core-tools.ts`, `mcp.ts`, `openapi.ts`, `tool-schemas.ts` | 鉴权工具发现、注册与调用 |
| Skill 系统 | `skills.ts` | SKILL.md 扫描、frontmatter 解析、inline/fork 路由 |
| Subagent 系统 | `subagent/*.ts` | 隔离 agent loop、8 工具集、多 provider LLM 适配、成本追踪、权限、worktree 隔离 |
| 资源适配 | `session-resources.ts`, `diff.ts`, `security.ts`, `update.ts`, `update-transaction.ts` | OS helper、Git 采样、路径/凭据安全、事务化更新 |
| TUI 契约/展示 | `tui/contracts.ts`, `tui/state.ts`, `tui/controller-logic.ts`, `tui/*` | 视图模型、终端配置、交互契约、渲染 |

### 2.3 所有权模型

- **工作区运行时**：一个 `MyTerminalRuntime` 拥有一个工作区本地服务器、store、扩展服务、MCP 传输、定时器与工作区运行时租约。
- **共享端口集群**：`PortClusterRegistry` 持有一个 `host:port` 的成员与选主；恰好一个成员接受公网流量，follower 仅暴露 loopback RPC。
- **工作区目录与租约**：`workspaces.json` 是持久目录；`lastPid/lastHost/lastPort` 是瞬态租约。
- **被动锁 helper**：安装级全局资源，仅当最后一个活跃 MyTerminal 进程退出时才停止。
- **会话资源**：一次性 helper 按工作区+会话隔离；会话结束/取消/运行时关闭只清理 PID 与可执行身份匹配的 helper。

---

## 3. 技术栈与依赖

### 3.1 运行时与构建

- **Bun ≥ 1.3**（`packageManager: bun@1.3.14`）：运行时、测试运行器、打包器。
- **TypeScript 5.9.3**，`strict: true`，target `ES2022`，module `NodeNext`，JSX `react-jsx`（`@opentui/react`）。
- 打包：`bun build --compile --minify` 生成单文件可执行。

### 3.2 运行时依赖（package.json）

| 依赖 | 版本 | 用途 |
|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.29.0 | MCP 协议（Apps connector） |
| `@opentui/core` / `@opentui/keymap` / `@opentui/react` | 0.4.5 | 终端 UI 渲染、键位路由 |
| `express` | ^5.2.1 | HTTP 服务器（Actions/OpenAPI/MCP） |
| `react` | 19.2.7 | TUI 组件树 |
| `zod` | ^4.4.3 | 运行期 schema 校验（MCP 工具入参派生） |

### 3.3 devDependencies

`@types/express`、`@types/node`、`@types/react`、`typescript`。

### 3.4 overrides

`fast-uri@3.1.4`、`@hono/node-server@2.0.11`（锁版本避免回归）。

---

## 4. 目录结构

```text
myterminal/
├── src/                       # 源码
│   ├── cli.ts                 # 进程入口
│   ├── server.ts              # MyTerminalRuntime 组合根
│   ├── config.ts              # 设置解析与组装
│   ├── store.ts               # 域状态持久化 (MyTerminalStore)
│   ├── types.ts               # 全部核心类型
│   ├── extensions.ts          # ExtensionService 门面
│   ├── core-tools.ts          # 内置工具注册
│   ├── openapi.ts             # Actions OpenAPI 3.1 文档
│   ├── mcp.ts / mcp-schema.ts # MCP/Apps 传输与 schema→zod
│   ├── skills.ts              # Skill 系统
│   ├── continuation.ts        # 续执行合约
│   ├── cluster.ts / cluster-router.ts / control-channel.ts
│   ├── instances.ts           # 工作区注册表与端口探测
│   ├── runtime-lifecycle.ts / session-resource-manager.ts / session-resources.ts
│   ├── audit-log.ts / redact.ts / security.ts / lock-thresholds.ts
│   ├── update.ts / update-transaction.ts / version.ts
│   ├── diff.ts / context-projector.ts / tui-model.ts
│   ├── tool-schemas.ts / runtime-settings.ts
│   ├── models/registry.ts     # LLM 模型价格与上下文窗口单源
│   ├── subagent/              # 子智能体系统 (17 文件)
│   ├── tui/                   # 终端 UI (38 文件)
│   └── utils/fs.ts
├── test/                      # 测试套件 (*.test.mjs)
├── scripts/                   # 安装脚本、探针、性能回归
├── skills/                    # 内建 onboarding skill
├── docs/                      # 文档与资产
├── .github/workflows/         # CI (ci.yaml, release.yaml)
└── package.json / tsconfig.json
```

---

## 5. 核心模块职责详解

### 5.1 入口与配置层

#### [src/cli.ts](./src/cli.ts)
进程入口。解析 CLI 参数（`--version`/`--help`/`--headless`/`--verify-installation`/`--list-adoptable`/`--adopt`），执行首启设置、工作区选择、运行时启动；非 TTY 自动进入 headless；注册 `unhandledRejection`/`uncaughtException` 安全关闭。

- `main()`：主流程；`ensureSettings()` 触发首启 TUI；`chooseWorkspace()` 选择工作区；`startRuntime()` 处理 `EADDRINUSE`（kill/next/cancel）。
- `effectiveEnvironment(headless)`：非 headless 删除 `MYTERMINAL_*` 环境覆盖，避免误覆盖 TUI 设置。
- `safeFatalShutdown()`：致命错误后 `runtime.close()` 并置退出码。

#### [src/config.ts](./src/config.ts)
设置文件解析、环境变量覆盖、可行性校验、AGENT.md/skills 目录草拟。

- `loadMyTerminalConfig(env)`：组装 `MyTerminalConfig`（含 AGENT.md、skills 目录草拟、迁移、工作区注册）。
- `readMyTerminalSettings`/`saveMyTerminalSettings`/`createDefaultSettings`/`maskCredential`/`settingsPath`。
- `assessRuntimeEnvironment`：valid/workspace_missing/volume_unmounted/permission_denied/state_dir_unavailable。
- `validateSettings`/`validateSettingsFeasibility`：字段校验 + 端口占用探测。

#### [src/migration.ts](./src/migration.ts)
跨目录 `state.json` 与 `history/*.jsonl` 的合并迁移，幂等且按稳定 ID 去重保留。`migrateWorkspaceState`。

### 5.2 运行时与集群层

#### [src/server.ts](./src/server.ts) — 组合根
`class MyTerminalRuntime` 持有工作区本地服务器、store、扩展服务、MCP 传输、集群参与权与生命周期。

- **拥有资源**：`store`、`extensions`、`app`(Express)、`internalServer`(127.0.0.1:0)、可选 `publicServer`、`mcp`/`clusterMcp`/`clusterRouter`、`cluster?`、`workspaceCatalog`、`controlChannel?`、三个定时器（heartbeat 1500ms / election 1800ms / resume 2000ms）、内存日志（500 条 + 落盘 runtime.jsonl）。
- **生命周期**：`start()` → `tryBecomeLeader()` → `revalidateAfterResume()` → `close()`→`closeOnce()`。
- **路由**（`configureRoutes`）：`/health`、`/openapi.json`、`/openapi-3.1.json`、`/mcp/:connectorKey`、`/actions/extensions/{discover,register,call}`（Bearer）、`/cluster/owns`、`/cluster/rpc/:method`（cluster-secret）。
- **集群网关**（`createClusterGateway`）：leader 额外暴露公网入口，经 `clusterRouter` 转发到归属成员 internalPort。

#### [src/cluster.ts](./src/cluster.ts)
`class PortClusterRegistry`：文件锁原子注册表。`register`/`heartbeat`/`setLeader`/`unregister`/`ensureRegistered`/`prune`。校验同 workspaceId 冲突、protocolVersion 兼容、connectorKey/actionsTokenHash 一致；锁所有权 token + compare-before-unlink（ADR-0018）。

#### [src/cluster-router.ts](./src/cluster-router.ts)
`class ClusterExtensionRouter implements ExtensionFacade`：`discover`/`register`/`call`/`mcpSessionClosed`。按 `identity.sessionId` 经 `routeBySession` 遍历成员 RPC；无 identity 时按 `boundMember`/`workspaceId`/兜底路由；成员间 RPC 走 `/cluster/rpc/{method}` + `x-myterminal-cluster-secret`。

#### [src/control-channel.ts](./src/control-channel.ts)
`class ControlChannelMonitor`：周期探活 `publicBaseUrl`，恢复后触发 `revalidateAfterResume`；指数退避重连；`classifyControlChannelFailure` 分类失败。

#### [src/instances.ts](./src/instances.ts)
全局工作区目录注册表与端口占用探测：`workspaceId`、`readWorkspaceRegistry`、`upsertWorkspaceRecord`、`releaseWorkspaceRecord`、`portOwner`(lsof)、`findAvailablePort`、`terminatePortOwner`、`appendWorkspaceLog` + `rotateRuntimeLog`（5MB/3 份）。

#### [src/runtime-lifecycle.ts](./src/runtime-lifecycle.ts)
原子写入 `runtime-state.json`：starting/active/revalidating/degraded/shutting_down/stopped。

#### [src/session-resource-manager.ts](./src/session-resource-manager.ts)
`SessionResourceManager` 单例：agent/session/global 三级资源清理单点注册与统一收口。`disposeAgent(agentId)`/`disposeSession(sessionId)`。

#### [src/session-resources.ts](./src/session-resources.ts)
macOS 被动锁 helper 的编译/启停；per-session awake-lock 的 arm/disarm/reap。`verifyRuntimeResources()`。

### 5.3 域状态层

#### [src/store.ts](./src/store.ts) — `MyTerminalStore`
会话/消息/事件/扩展持久化与业务规则。核心方法（节选）：

- 会话：`registerRoot`/`registerDelegate`/`inherit`/`release`/`checkpoint`/`unregister`/`tag`/`subscribe`/`eventsAck`。
- 消息：`sendMessage`/`messageInbox`/`messageList`/`messageConversation`。
- 上下文：`context(sessionId)` → 经 `context-projector` 投影；`history(sessionId)` 分页读 JSONL。
- 事件：`pendingEvents`/`emitEvent`/`subscriptions`。
- 扩展：`upsertExtension`/`removeExtension`/`listExtensions`。
- 续执行：`expectedContinuationCall`/`completeContinuationCall`/`activateHarnessContract`。
- 绑定：`bindApp`/`bindMcp`/`unbindMcp`（MCP 仅内存，ADR-0029 防僵尸）。
- `revision` 自增驱动 TUI `renderRevision()` 比对。

#### [src/types.ts](./src/types.ts)
全部核心类型定义（详见 [§6 关键类型](#61-域模型-types)）。

#### [src/context-projector.ts](./src/context-projector.ts)
纯函数上下文投影 `projectContext`：组装 session/objective/finalSummary/parentContext/recentToolCalls(10)/recentMessages(20)/inherited*，`CONTEXT_PROJECTION_LIMIT = 16_000`，O(n) 预算裁剪，trim 顺序固定。

#### [src/tui-model.ts](./src/tui-model.ts)
TUI 纯模型：`logicalSessionGroups`（按 continuesSessionId 链归并到 origin root）、`conversationGroups`、`selectedViewport`。

### 5.4 扩展门面层

#### [src/extensions.ts](./src/extensions.ts) — `ExtensionService`
鉴权、审计、续执行装饰、后台任务、续执行断言的门面核心。

- `discover`：无 identity 返回 bootstrap 指令 + skills + bootstrapTools（不写审计）；已认证经 `withAudit` 返回 tools catalog + instructions + harness 合约 + registrationSchema + 最多 5 条未确认事件。
- `register`：`action` ∈ remove/validate/upsert；`validateSpec` 校验后 `store.upsertExtension`。
- `call`：解析 tool 与 `callArguments`（三源合并）；bootstrap 豁免（`session_register` 非 delegate、`session_inherit`）；`assertContinuation` 校验队列顺序；非阻塞调度（200ms fast-return → BackgroundTask + `task_poll`）；同步路径 `invokeTool` → `decorateContinuation` → `attachEvents` → `finishAudit`。
- `callSubagent`：trimmed 版，供 subagent child 通知父 session。
- `withAudit`：ADR-0032 统一的 try/beginAudit/finishAudit/catch 脚手架。

#### [src/core-tools.ts](./src/core-tools.ts)
`createBuiltinTools`：注册约 35 个内置工具，返回 `Map<string, ToolDefinition>`。分组：
- 文件：`list_dir`/`find_files`/`search_text`/`read_file`/`read_file_range`/`write_file`/`apply_patch`
- blob：`blob_create`/`blob_read`/`blob_write_file`
- 命令/Git：`execute_cli`/`git_*`/`run_checks`
- 会话：`session_register`/`inherit`/`list`/`checkpoint`/`context`/`history`/`release`/`unregister`/`tag`/`subscribe`/`events_ack`
- 消息：`message_send`/`inbox`/`list`/`conversation`
- skill、subagent：`subagent_start`/`status`/`abort`
- `runCommand`/`runShellCommand`：spawn 执行器（POSIX 进程组信号、Windows taskkill 树终止、timeout+cancel、boundedOutput）；`decodeBlob`（utf-8/base64）。

#### [src/openapi.ts](./src/openapi.ts)
`buildOpenApi`：生成 Actions 三操作（discover/register/call）的 OpenAPI 3.1 文档与 schema 组件。操作 ID 用 camelCase（`extensionDiscover`/`extensionCall`/`extensionRegister`）。

#### [src/mcp.ts](./src/mcp.ts) — `MyTerminalMcpTransport`
per-session `McpServer` + `StreamableHTTPServerTransport`，`sessionIdGenerator: randomUUID`；`onsessionclosed` 解绑。`createMcpServer` 注册 3 个 facade 工具 + 约 30 个 direct tool。`extensionToolInput`：facade 协议层 zod（44 字段 + catchall unknown）。`registerDirect`：从 `BUILTIN_INPUT_SCHEMAS` 派生 zod，统一注入 `identity`/`workspaceId`。

#### [src/mcp-schema.ts](./src/mcp-schema.ts)
`jsonSchemaToZod(schema, path)`：派生器，支持 14 个关键字，`UnsupportedSchemaError` 强制失败而非静默回退。`additionalProperties:false`→strip z.object；`true`+无 properties→z.record。

#### [src/tool-schemas.ts](./src/tool-schemas.ts)
`BUILTIN_INPUT_SCHEMAS`：所有内置工具形状单源（core-tools 运行期校验 + mcp 派生 + discover 目录三处共用）；`TASK_POLL_TOOL`。

### 5.5 Skill 系统

#### [src/skills.ts](./src/skills.ts)
- **布局**：目录式 `<skillsDir>/<name>/SKILL.md` 与平铺式 `<name>.md`；全局 `<configDir>/skills/` 覆盖项目级，用户文件覆盖内建。
- `parseFrontmatter`：手写零依赖 YAML 子集解析（支持一层嵌套 `forkOptions`）。
- `validateSkillManifest`：`name` 正则 `^[a-z][a-z0-9-]{2,63}$`、description 10-800 字符、mode ∈ {inline,fork}（缺省 inline）、forkOptions 子字段校验。文件 100KB 上限。
- 内建 `adaptive-guard`（inline，恢复决策树）。
- inline：返回 `{name, description, mode:'inline', content}`，不需 identity。
- fork：要求 identity；`transport==='subagent'` 抛 `FORBIDDEN`（递归防护）；调 `getSubagentRunner().start(...)`，origin=`{type:'skill', skillName}`；返回 `{mode:'fork', taskId, sessionId, status:'running'}`。

### 5.6 Subagent 系统

详见 [§6.5 Subagent 关键模块](#65-subagent-系统-srcsubagent)。该系统由 17 个文件构成，分层如下：

| 层 | 文件 | 职责 |
|---|---|---|
| 接入层 | `runner.ts` | start/status/abort 控制面，编排 delegate session + worktree + 通知链 |
| 执行核心 | `executor.ts` | agent loop 主循环（compact 三层 + LLM + 工具 + 退出策略） |
| 工具层 | `tools.ts` / `tool-executor.ts` | 8 工具定义 + 并行/串行执行器 |
| LLM 适配 | `llm-adapter.ts` / `resilience-policy.ts` / `token-counter.ts` / `cost-tracker.ts` | 5 provider + 弹性 + 估算 + 计费 |
| 隔离层 | `worktree.ts` / `permissions.ts` | git worktree 文件隔离 + 命令安全 |
| 状态层 | `store.ts` / `file-state.ts` / `shell-tracker.ts` / `result-budget.ts` | 记录 + 读后写 + 进程追踪 + 结果预算 |
| 辅助 | `grep-utils.ts` / `tui-bridge.ts` | grep 引擎 + AG-UI 事件总线 |
| 地基 | `context.ts` | 可注入上下文（收敛模块级全局单例） |

### 5.7 资源适配层

#### [src/diff.ts](./src/diff.ts)
`WorkspaceDiffTracker`：有界 Git diff/status 采集，untracked 文件采样，TUI 周期刷新。Git 可选能力，探测一次后非 Git 目录安全降级；每个子进程有 deadline 与有界输出。

#### [src/security.ts](./src/security.ts)
- `safeEqual`：sha256 + timingSafeEqual 常量时间比较（token/key/cluster-secret）。
- `validateSafeRegex`：嵌套量词 ReDoS 启发式检测。
- `resolveWorkspacePath`：realpath 防越界 + stateDir 保护 + symlink 逃逸检测。
- `validateJsonSchema`：手写 JSON Schema 校验器（与 mcp-schema 派生语义对齐）。
- `renderTemplate`：`{{input.field}}` 模板替换。

#### [src/audit-log.ts](./src/audit-log.ts)
`class AuditLog`：`event`(写)、`facts`/`recentFactsPage`/`factsPage`(读)、`pruneDeleted`。`AuditFact` 含 sessionId/sessionName/at/tool/ok/errorCode。`AuditLogIo` 注入使其无文件系统可测。状态映射 started→running、succeeded→completed，保留 policy_rejected。

#### [src/redact.ts](./src/redact.ts) — 脱敏单源（ADR-0026）
`redact<T>(value)`：双形式（对象/字符串）。三层处理：敏感键→`[REDACTED]`；body 键→`[REDACTED <n> chars]`；自由字符串→正则扫除 Bearer/key=value/query + 字面量 secret 全量替换。所有出口（HTTP 响应/日志/审计/错误）必经此函数。

#### [src/update.ts](./src/update.ts) / [src/update-transaction.ts](./src/update-transaction.ts)
- `checkForUpdate`：GitHub releases/latest 探测；`installUpdate`：锁→事务→快照→install→migrate→restart→recovery→prune。
- `executeUpdateTransaction`：阶段审计 emit（start/snapshot/install/migration/restart/recovery/complete），失败自动 rollback。
- `snapshotUpdateData`/`restoreUpdateData`：配置目录全量备份与按 revision/size 智能恢复，`credentialsPreserved` 校验。

#### [src/continuation.ts](./src/continuation.ts)
`continuationPolicy(mode)`：返回 `{enabled, minCalls, maxCalls, exactCalls}`；`harnessRequirement`/`harnessContract` 合约文案；`HARNESS_CONTRACT_REVISION = 'actions-long-task-harness-v2'`。

### 5.8 TUI 层

基于 `@opentui/react` + `@opentui/keymap` 的 React 组件树 + 控制器（`TuiController`）+ 纯函数模型层。遵循 ADR-0004 九大决策（双速 tick、五层键盘路由、暖色双主题、吉祥物情绪、纯函数模型等）。详见 [§6.6 TUI 关键模块](#66-tui-系统-srctui)。

---

## 6. 关键类与函数说明

### 6.1 域模型（types.ts）

```typescript
type SessionPhase = 'pending'|'working'|'waiting'|'blocked'|'completed'|'cancelled';
type SessionPresence = 'unclaimed'|'claimed'|'stale';
type ActionsContinuationMode = 'off'|'adaptive'|'next-call'|'lookahead-3';
type SessionIdentity = { sessionId: string; sessionToken: string };

interface MyTerminalSession {
  id, name, role, phase, presence,
  parentSessionId?, continuesSessionId?, predecessorDeleted?,
  task?: TaskPackage,
  controller?: SessionController,        // {id, tokenHash, claimedAt, lastActivityAt}
  claimCodeHash?, claimCodeIssuedAt?,
  checkpointStartedAt?, checkpointReminderEmittedAt?,
  latestCheckpoint?: SessionCheckpoint,
  continuationPlan?: ContinuationPlan,
  finalSummary?, tags: string[], createdAt, updatedAt
}

interface SessionCheckpoint {
  at, phase, summary,
  nextSteps?, blockers?, artifacts?, milestone?, tags?,
  nextCalls?: PlannedToolCall[],   // {tool, input, purpose?}
  replanReason?
}

interface MyTerminalMessage { id, from, to, source?: 'session'|'user', body, createdAt, readAt? }
interface SessionEvent { id, recipientSessionId, sourceSessionId, kind: SessionEventKind, payload, createdAt, acknowledgedAt? }
interface StoredState { schemaVersion:2, revision, sessions, messages, events, subscriptions, appBindings, extensions, harnessContract? }
interface MyTerminalSettings { workspaceDir, host, port, connectorKey, actionsToken, publicBaseUrl, maxOutputChars, commandTimeoutSec, uiLanguage, uiTheme, passiveLockEnabled, actionsContinuationMode, nonBlockingTasksEnabled, subagent? }
interface SubagentSettings { enabled, provider, model, maxTurns, timeoutSec, maxParallel, fallbackModel? }
const SUBAGENT_PROVIDERS = ['openai','anthropic','deepseek','glm','qwen'] as const;
interface ToolDefinition { name, title, description, inputSchema, annotations, aliases?, invoke(input, context) }
```

### 6.2 运行时核心类

#### `MyTerminalRuntime`（[server.ts](./src/server.ts)）
组合根。构造时初始化 store/extensions/mcp/subagent runner。关键方法：`start()`、`tryBecomeLeader()`、`revalidateAfterResume(reason)`、`close()`→`closeOnce()`、`configureRoutes()`、`createClusterGateway()`、`log()`/`logAuditEvent()`、`passiveLockStatus()`、`appsUrl`/`openApiUrl`/`port`。

#### `ExtensionService`（[extensions.ts](./src/extensions.ts)）
门面核心。方法：`discover`/`register`/`call`/`callSubagent`/`registerFromTui`/`mcpSessionClosed`/`shutdown`。内部：`authenticate`、`withAudit`、`decorateContinuation`、`assertContinuation`、`invokeTool`、`pollBackgroundTask`、`trimBackgroundTasks`。

#### `MyTerminalStore`（[store.ts](./src/store.ts)）
域状态持久化。方法：`registerRoot`/`registerDelegate`/`inherit`/`release`/`checkpoint`/`unregister`/`tag`/`subscribe`/`eventsAck`、`sendMessage`/`messageInbox`/`messageList`/`messageConversation`、`context`/`history`、`pendingEvents`/`emitEvent`、`upsertExtension`/`removeExtension`/`listExtensions`、`expectedContinuationCall`/`completeContinuationCall`/`activateHarnessContract`、`bindApp`/`bindMcp`/`unbindMcp`、`revision`。

#### `PortClusterRegistry`（[cluster.ts](./src/cluster.ts)）
`register`/`heartbeat`/`setLeader`/`unregister`/`ensureRegistered`/`prune`。`ClusterMember`：id/pid/appVersion/protocolVersion/workspaceId/internalPort/connectorKey/actionsTokenHash/secret/heartbeatAt。

#### `ClusterExtensionRouter`（[cluster-router.ts](./src/cluster-router.ts)）
`implements ExtensionFacade`。`discover`/`register`/`call`/`mcpSessionClosed`、`routeBySession`、`boundMember`。

### 6.3 内置工具集（core-tools.ts）

| 分组 | 工具 |
|---|---|
| 工作区文件 | `list_dir` `find_files` `search_text` `read_file` `read_file_range` `write_file` `apply_patch` |
| Blob | `blob_create`（sha256 内容寻址，`flag:'wx'` 幂等，1MB 上限）`blob_read` `blob_write_file`（`flag:'wx'` 不覆盖，同 sha256 幂等成功，不同拒绝） |
| 命令/Git | `execute_cli` `git_status` `git_diff` `git_log` `run_checks` |
| 会话 | `session_register` `session_inherit` `session_list` `session_checkpoint` `session_context` `session_history` `session_release` `session_unregister` `session_tag` `session_subscribe` `session_events_ack` |
| 消息 | `message_send` `message_inbox` `message_list` `message_conversation` |
| Skill | `skill` |
| Subagent | `subagent_start` `subagent_status` `subagent_abort` |
| 后台 | `task_poll` |

### 6.4 Skill 系统（skills.ts）

```typescript
type SkillMode = 'inline' | 'fork';
interface SkillManifest { name, description, when_to_use, mode, forkOptions? }
interface SkillForkOptions { provider?, model?, maxTurns?, timeoutSec?, readOnly? }
// listSkills() / loadSkill(name) / parseFrontmatter / validateSkillManifest
```

- 无参 `skill()`：返回 manifest 列表（不含 content），不需 identity。
- inline：`{name, description, mode:'inline', content}`，不需 identity。
- fork：需 identity；递归防护；`getSubagentRunner().start(parentSessionId, {objective, background, ...forkOptions}, {type:'skill', skillName})`；返回 `{mode:'fork', taskId, sessionId, status:'running'}`。

### 6.5 Subagent 系统（src/subagent）

#### 接入层 — [runner.ts](./src/subagent/runner.ts)
`createSubagentRunner(deps)` 返回 `{start, status, abort, listSubagents}`。

- **start**：并发检查 → `assembleTask`/`toTaskPackage` → `registerAndClaimChild` → `createSubagent` → IIFE 后台执行（`cleanupStaleWorktrees` → `createAgentWorktree` → `runSubagentImpl`）→ 立即返回 `{sessionId, taskId, status:'running'}` → `finalize`（checkpoint + notify + store 更新 + `reclaimWorktree`）。
- **status**：`getSubagent` → 读 manifest 回填隔离语义字段（`hasChanges`/`changesIsolated`/`reviewPending`，仅 completed 回填，running 态 undefined）→ 幂等返回。
- **abort**：已终态幂等返回；否则 `abortController.abort()` → `{status:'aborting'}`。

#### 执行核心 — [executor.ts](./src/subagent/executor.ts)
`runSubagent(options): Promise<SubagentRunResult>` 主循环。

- 三层 compact：`microCompact`（零成本，保留最近 5 个 tool_result，更早的替换为占位）→ `autoCompact`（调 LLM 摘要，`MAX_COMPACT_FAILURES=3` 熔断）→ `normalizeMessages`。
- `AbortSignal.any([abortController.signal, timeoutSignal])`；`collectStream`（含 Circuit Breaker）→ 决策 24 content 退出检测 → `executeToolCalls` → 追加 tool_result。
- `finally`：`sessionResourceManager.disposeAgent(agentId)`。三态完成函数 `finishCompleted`/`finishFailed`/`finishAborted`。
- `getSubagentSystemPrompt`：硬编码 system prompt，隔离模式追加 auto-remapped 文案。

#### 工具层 — [tools.ts](./src/subagent/tools.ts) / [tool-executor.ts](./src/subagent/tool-executor.ts)

8 工具集：

| 工具 | isReadOnly | isConcurrencySafe | 用途 |
|---|---|---|---|
| `execute_cli` | false | 函数化 | spawn shell，detached 进程组 |
| `read_file` | true | true | 带行号读，offset/limit，二进制拒绝 |
| `write_file` | false | false | 创建/覆盖，自动建父目录 |
| `edit_file` | false | false | 先 `validateEdit` 后 `applyEdit`，支持 `replace_all` |
| `glob` | true | true | `walkFiles`+globToRegex，MAX_GLOB_RESULTS=200 |
| `grep` | true | true | `createGrep`，MAX_GREP_MATCHES=200 |
| `task_create` | true | true | 进度跟踪任务 |
| `task_update` | true | true | 状态机更新（pending→in_progress→completed） |

- `buildTool(config)` 工厂；`toolRegistry: Map`；`getTool`/`getAllToolSchemas`/`getToolNames({readOnly})`。
- `resolvePath`：cwd 限制 + ADR-0015 realpath 防 symlink 逃逸 + 隔离 ctx 下主仓→worktree 同构路径重映射。
- `tool-executor.ts`：`validateSchema`（4 类校验）、`partitionToolCalls`（按并发安全分批，MAX_PARALLEL=5）、`executeSingleTool`（未知工具→readOnly 门禁→schema→validateInput→checkPermissions→hooks→执行→审计）、`executeToolCalls`（并行批次 sibling abort，串行批次写失败链中断）。

#### LLM 适配 — [llm-adapter.ts](./src/subagent/llm-adapter.ts)
- `interface LlmAdapter { provider; stream(params, signal); create(params, signal) }`。
- 5 适配器：`OpenAIAdapter`（SSE + stream_options.include_usage）、`AnthropicAdapter`（content_block 事件路由 + cache_read_input_tokens）、`DeepSeekAdapter`/`GlmAdapter`（继承 OpenAI 改 baseUrl）、`QwenAdapter`（baseUrl 构造注入）。
- `createAdapter(settings, env)` 工厂（按 provider，缺 key 抛错附 export 指引）。
- `normalizeMessages`（合并同 role + 孤儿 tool_use 补 interrupted tool_result）、`assembleMessage`（组装单源 #66）、`collectStream`（流式累积 + 中途失败回退非流式防双重执行）。
- `ReliabilityAdapter` 装饰器（watchdog 空闲 60s/总超时）+ `withReliability` 工厂；`LlmError`（kind: rate_limit/server_overload/auth/prompt_too_long/connection/system）。
- `resilience-policy.ts`：`CircuitBreaker`（closed/open/half-open，5 次失败熔断 30s）+ `ResiliencePolicy.decideOnFailure`（rate_limit 指数退避、server_overload 3 次降级 fallbackModel、prompt_too_long 触发 compact）。

#### 隔离 — worktree.ts
- `createAgentWorktree`：D1 降级链（非 git/skip/空仓库→null）→ `git worktree add -b worktree-<slug> <wtPath> HEAD` → manifest → `injectDependencies`（`git check-ignore` 判定，降级 `cp -Rc`→`--reflink=auto`→`cp -a`）。
- `hasWorktreeChanges`：`git status --porcelain` ∪ `git log baseCommit..HEAD`（根因 #1 修复）。
- `adoptWorktree`：两阶段 `git apply --3way --check` → `--3way` → `--diff-filter=U` 取冲突 → 三联动收尾。
- `listReviewPending`：实时派生（根因 #2 修复，不信任 manifest 死布尔）。
- `cleanupStaleWorktrees`：prune + 清失联 + 清孤儿分支，N2 保护 review-pending。

#### 权限 — [permissions.ts](./src/subagent/permissions.ts)
`checkCommandSafety(command, readOnly)`：解释器壳递归 → 完整 DANGEROUS → 子命令逐段 → 命令替换检测 → 全 SAFE 快道 → readOnly 决策。`splitCommands`（状态机拆分）、`hasCommandSubstitution`、`isCommandConcurrencySafe`、`interpretExitCode`（grep/rg/find/test 语义）。

#### 状态/辅助
- [store.ts](./src/subagent/store.ts)：内存 Map，`createSubagent`/`updateSubagentStatus`（1h 清理定时器）/`addAuditLog`（截断+保留 50）/`countRunning`/`listAllSubagents`。
- [file-state.ts](./src/subagent/file-state.ts)：`recordFileRead`/`validateEdit`（0 匹配附预览，>1 非 replaceAll 报错）/`applyEdit`。
- [shell-tracker.ts](./src/subagent/shell-tracker.ts)：`trackShellTask`/`cleanupAgentShellTasks`（杀进程组，2s SIGKILL 兜底）。
- [result-budget.ts](./src/subagent/result-budget.ts)：`truncateResult`（MAX 50K）/`enforceMessageBudget`（200K 预算，超限按长度降序压成预览并冻结）/`ensureNonEmpty`。
- [token-counter.ts](./src/subagent/token-counter.ts)：`estimateTokens`/`estimateMessageTokens`/`getModelContextWindow`/`getAutoCompactThreshold`。
- [cost-tracker.ts](./src/subagent/cost-tracker.ts)：`CostTracker`（setModel 结算旧定价），`resolvePricing`（精确→前缀→provider 估算→默认 gpt-4o）。
- [grep-utils.ts](./src/subagent/grep-utils.ts)：`includePatternToRegex`/`matchInFiles`（IO 解耦）/`createGrep`。
- [tui-bridge.ts](./src/subagent/tui-bridge.ts)：`subagentEvents` EventEmitter + 14 种 AG-UI 事件 + `emitAgUi`。
- [context.ts](./src/subagent/context.ts)：`SubagentContext`（收敛 6 项）+ `createSubagentContext`/`defaultContext`。

### 6.6 TUI 系统（src/tui）

#### 整体架构
- [index.tsx](./src/tui/index.tsx)：渲染入口。`runSetupTui`/`runWorkspaceChooserTui`/`runChoiceTui`/`class MyTerminalTui`（`run()` 创建 controller + 挂载 `<App>`）；`createRenderer`/`renderWithKeymap`。
- [App.tsx](./src/tui/App.tsx)：核心组件。双速 tick（150ms 比对 `renderRevision()` 触发 refresh，1s `tickReminders`）；Ask 表单机制；`handleInputSubmit`→`routeCommand`；五层键盘路由；子代理审查队列 2s 轮询。
- [state.ts](./src/tui/state.ts)：`TABS`（9 页签）、`class TuiController`（`snapshot`/`renderRevision`/`refreshDiff`/`createSession`/`sessionAction`/`sendMessage`/`editSettings`/`rotateCredentials`/`shutdown` 等）、`phaseColor`/`presenceColor`/`hiddenAppsUrl`。
- [contracts.ts](./src/tui/contracts.ts)：`Detail`/`FormQuestion`/`Ask`/`RuntimeReconfigure` 类型。
- [controller-logic.ts](./src/tui/controller-logic.ts)：纯函数层。`parseSelectedFields`/`buildSettingsQuestions`/`resolveSettingsAnswers`/`buildChildTaskPackage`/`sessionActionOptions`，`SETTINGS_FIELDS` 11 字段注册表。

#### 九页签屏幕（screens/）
| 页签 | 文件 | 职责 |
|---|---|---|
| Overview | `Home.tsx` | 吉祥物问候 + 会话分组 top3 + 最近 7 条活动 |
| Sessions | `Sessions.tsx` | 卡片树列表 + `SessionDetail`（含永久结构化历史） |
| Messages | `Messages.tsx` | 对话卡片列表 + `ConversationDetail`（气泡流） |
| Timeline | `Timeline.tsx` | 全量时间线，PAGE_SIZE=100，priority 250 键位 |
| Diff | `Diff.tsx` | `groupDiffLines` 按文件分组，状态色映射 |
| Extensions | `Extensions.tsx` | 扩展卡片列表 |
| Settings | `Settings.tsx` | 运行设置 + macOS 被动锁 + 凭据/更新 |
| Logs | `Logs.tsx` | runtime 日志 + 跨工作区日志 + 审计事实，PAGE_SIZE=100 |
| Subagents | `Subagents.tsx`/`Subagent.tsx` | 审查队列 + subagent 列表 + 详情（AG-UI 16ms 批量 flush） |

`shared.tsx`：`Heading`/`Line`/`SessionStatus`。

#### 组件（components/）
`InputBar`（Normal/Editing 双模式，priority 350）、`MessageBubble`、`ToolCallRow`（Claude Code 风，惰性 stringify）、`FormDialog`（声明式多步表单引擎，priority 400）、`Modal`、`HelpOverlay`（priority 300）、`Mascot`（9 字符宽 ASCII，5 种 mood，独立眨眼定时器）、`BlinkingDot`；`chrome/`：`TopBar`（`processTopology`）、`BottomNav`（9 pill）、`StatusLine`（`hints`）。

#### 模型层（model/）
全部纯函数：`command-router.ts`（`routeCommand`/`commandCompletions`/`COMMANDS`）、`diff-groups.ts`（`groupDiffLines`）、`history-entry.ts`（`viewForHistoryEntry` 11 种类型）、`mascot-mood.ts`（`mascotMoodFor`）、`relative-time.ts`（`relativeTime`）、`timeline-merge.ts`（`mergeActivity`/`memoizedMergeActivity` 单槽 memoize）。

#### Hooks（hooks/）
`useInputHistory`（push/prev/next，会话内不落盘）、`useMascotMood`（从 snapshot 推导）、`useTimelineModel`（`memoizedMergeActivity`，audits 作 thunk 延迟取数）。

#### i18n（copy/）
`i18n.ts`（`i18nFor` 记忆化冻结实例，`I18n`/`Translate`）、`context.tsx`（`I18nProvider`/`useI18n`，缺 Provider 抛 `DevInvariantError`）、`types.ts`（`Copy`/`EmptyStateKey`）、`en.ts`/`zh-CN.ts`（双语字典）、`index.ts`（`copyFor`/`greetingFor`/`verbFor`/`verbLabel`）。三处语言入口收敛到 `i18nFor`。

#### 主题（theme/）
`types.ts`（`Theme` 16 角色：基础 12 + user/agent/tool/system）、`palette.ts`（`WARM_DARK`/`WARM_LIGHT`，`paletteFor`）、`index.ts`（`themeFor`）。对比度目标正文 ≥7:1，muted ≥4.5:1。

#### 其他根文件
`host-io.ts`（`copyToHostClipboard`/`playAttentionSound`/`notifySystem` 跨平台 spawn）、`keymap.ts`（`useAppKeymap` 三层优先级 300/200/100 + `buildNumberTabBindings`）、`renderer-profile.ts`（`rendererProfile`，win32 20fps main-screen 兼容）、`status-color.ts`（`statusToVisual` 单源，`StatusTone`）、`credential-visibility.ts`（`nextCredentialVisibility` 处理 key-up 不可靠）、`form-model.ts`（`initialQuestionState`/`toggleSelectedOption`/`optionAnswer`/`nextTextValue`/`workspaceChoiceQuestion`）、`workspace-selector.ts`（`buildWorkspaceSelectorModel`）。

---

## 7. 核心数据流

### 7.1 Actions/Apps 调用流

```text
ChatGPT ── HTTP ──> server.ts 路由
   Actions: /actions/extensions/{discover,register,call}  (Bearer actionsToken)
   Apps:    /mcp/:connectorKey                            (McpServer + direct tools)
                │
                ▼
   ExtensionService.discover/register/call
        ├─ authenticate(identity?)   // actionsToken / connectorKey + session binding
        ├─ withAudit                  // beginAudit(running) → finishAudit(终态)
        ├─ assertContinuation         // 续执行队列顺序校验
        ├─ invokeTool                 // builtin / custom builtin / custom command
        │     └─ core-tools ToolDefinition.invoke(input, InvocationContext)
        ├─ decorateContinuation       // 附加 continuation{mustContinue,nextCall}
        └─ attachEvents               // 最多 5 条未确认事件
                │
                ▼
   MyTerminalStore  ──> state.json + history/<sessionId>.jsonl
```

### 7.2 会话生命周期

```text
session_register(root)  ──> store.registerRoot ──> session + sessionToken
session_register(delegate, task) ──> store.registerDelegate ──> child + 一次性 claimCode + handoffPrompt
session_inherit(claimCode|sessionToken) ──> store.inherit ──> 消耗 claimCode / 换发 token
session_release ──> store.release ──> 新 claimCode
session_checkpoint(phase) ──> store.checkpoint
   - working(增强 harness): 校验 nextCalls 数量
   - completed/cancelled: sessionResourceManager.disposeSession
   - root 完成但子未 terminal: CHILD_REVIEW_REQUIRED → 自动 working + 返回子状态
```

### 7.3 Subagent 执行流

```text
subagent_start ──> runner.start
   1. countRunning >= maxParallel? → FORBIDDEN
   2. registerAndClaimChild(parentSessionId, task)
   3. createSubagent + IIFE 后台执行
   4. cleanupStaleWorktrees → createAgentWorktree (D1 降级链)
   5. runSubagent(主循环):
        microCompact → (超阈值? autoCompact) → normalizeMessages
        → collectStream (Circuit Breaker + watchdog)
        → 决策24 content 退出? → executeToolCalls (分批并行/串行)
        → 追加 tool_result → 下一轮
   6. finalize: checkpoint + message_send(通知父) + store 更新 + reclaimWorktree
subagent_status ──> 幂等读 + 隔离语义字段回填
subagent_abort  ──> abortController.abort() → finishAborted
```

### 7.4 TUI 渲染流

```text
150ms fast tick ──> controller.renderRevision() 比对
   (store.revision + runtimeLog.revision + diff.revision + update + health phase)
   变化? ──> refresh() ──> controller.snapshot() ──> App 重渲染
1s slow tick ──> controller.tickReminders()
键盘 ──> 五层优先级: form(400) > input-editing(350) > detail-esc(300) > page(200) > global(100)
```

### 7.5 集群路由流

```text
公网请求 ──> leader 进程 createClusterGateway
   ──> ClusterExtensionRouter.call
        ├─ 有 identity: routeBySession(sessionId) 遍历成员 /cluster/rpc/call
        └─ 无 identity: boundMember(clientSessionKey) / workspaceId / 兜底
   ──> 归属成员 internalPort ──> 本地 ExtensionService.call
```

---

## 8. 依赖关系

### 8.1 模块依赖图（核心层）

```text
cli.ts
  └─ server.ts (MyTerminalRuntime)
       ├─ config.ts (loadMyTerminalConfig)
       ├─ store.ts (MyTerminalStore)
       │    ├─ types.ts
       │    ├─ redact.ts (脱敏)
       │    ├─ context-projector.ts
       │    └─ lock-thresholds.ts
       ├─ extensions.ts (ExtensionService)
       │    ├─ core-tools.ts (createBuiltinTools)
       │    │    ├─ tool-schemas.ts (BUILTIN_INPUT_SCHEMAS)
       │    │    ├─ security.ts (resolveWorkspacePath/runCommand)
       │    │    ├─ skills.ts
       │    │    └─ subagent/runner.ts (getSubagentRunner)
       │    ├─ audit-log.ts (AuditLog)
       │    ├─ continuation.ts
       │    └─ redact.ts
       ├─ mcp.ts (MyTerminalMcpTransport)
       │    ├─ mcp-schema.ts (jsonSchemaToZod)
       │    └─ tool-schemas.ts
       ├─ openapi.ts (buildOpenApi)
       ├─ cluster.ts / cluster-router.ts / control-channel.ts
       ├─ instances.ts / workspace-catalog.ts
       ├─ runtime-lifecycle.ts / session-resource-manager.ts / session-resources.ts
       ├─ diff.ts / update.ts / update-transaction.ts
       └─ tui/* (MyTerminalTui)
            ├─ tui/state.ts (TuiController)
            ├─ tui/App.tsx
            └─ tui/{screens,components,model,hooks,copy,theme}/
```

### 8.2 Subagent 内部依赖

```text
runner.ts (接入层)
  ├─ store.ts, context.ts, executor.ts(runSubagentImpl 类型), worktree.ts(注入), tools.ts
  └─ ../store.ts, ../types.ts
executor.ts (执行核心)
  ├─ llm-adapter.ts, resilience-policy.ts, token-counter.ts, cost-tracker.ts
  ├─ store.ts, file-state.ts, tool-executor.ts, tools.ts, tui-bridge.ts
  └─ ../session-resource-manager.ts
tool-executor.ts ── tools.ts, store.ts, result-budget.ts
tools.ts ── file-state.ts, shell-tracker.ts, permissions.ts, result-budget.ts, store.ts, grep-utils.ts, ../utils/fs.ts, ../redact.ts
llm-adapter.ts ── token-counter.ts, ../types.ts
cost-tracker.ts / token-counter.ts ── ../models/registry.ts (MODELS)
worktree.ts ── ../lock-thresholds.ts
context.ts ── store.ts, runner.ts (类型)
```

### 8.3 外部依赖

```text
@modelcontextprotocol/sdk ── mcp.ts (McpServer + StreamableHTTPServerTransport)
@opentui/{core,keymap,react} ── tui/* (渲染 + 键位)
express ── server.ts (HTTP)
react ── tui/* (组件树)
zod ── mcp.ts, mcp-schema.ts (运行期校验)
```

### 8.4 单源纪律（禁止他处手抄）

- `tool-schemas.ts`：工具输入形状（core-tools + mcp + discover 三处共用）
- `types.ts:SUBAGENT_PROVIDERS`：provider 列表
- `redact.ts`：脱敏
- `lock-thresholds.ts`：锁阈值 `LOCK_STALE_THRESHOLD_MS = 30_000`
- `models/registry.ts`：模型价格 + 上下文窗口
- `mcp-schema.ts`：JSON Schema→zod 派生
- `status-color.ts`：TUI 状态→颜色
- `llm-adapter.ts:assembleMessage`：消息组装

---

## 9. 项目运行方式

### 9.1 环境要求

- **Bun ≥ 1.3**（CI 固定 `1.3.14`）
- 支持 macOS / Linux / Windows（Windows TUI 默认键盘兼容模式，鼠标捕获默认关闭）

### 9.2 从源码开发

```bash
git clone https://github.com/epslkslsksndnsjs-lab/myterminal.git
cd myterminal
bun install --frozen-lockfile
bun run dev          # 启动 TUI（含首启设置）
```

### 9.3 npm scripts（package.json）

| 脚本 | 命令 | 用途 |
|---|---|---|
| `build` | `bunx tsc -p tsconfig.json` | 类型检查 + 输出 dist |
| `build:binary` | `bun build --compile --minify src/cli.ts --outfile release/myterminal` | 单文件可执行 |
| `dev` | `bun run src/cli.ts` | 开发模式启动 TUI |
| `start` | `bun run dist/cli.js` | 启动构建产物 |
| `test` | `bun run build && bun test --timeout 120000 test/*.test.mjs` | 构建后跑全部测试 |
| `perf:regression` | `bun run build && bun scripts/performance-regression.mjs` | 性能回归 |
| `typecheck` | `bunx tsc --noEmit -p tsconfig.json` | 仅类型检查 |

### 9.4 CLI 参数（cli.ts）

```text
myterminal                  # 启动 TUI
myterminal --headless       # headless 模式（需先完成 TUI 设置）
myterminal --version / -v
myterminal --help / -h
myterminal --verify-installation          # 校验运行时资源
myterminal --list-adoptable               # 列出可采纳的 subagent worktree
myterminal --adopt <taskId>               # 采纳 subagent worktree 变更
```

### 9.5 环境变量覆盖（仅自动化/headless）

`MYTERMINAL_WORKSPACE_DIR`、`MYTERMINAL_HOST`、`MYTERMINAL_PORT`、`MYTERMINAL_PUBLIC_BASE_URL`、`MYTERMINAL_ACTIONS_TOKEN`、`MYTERMINAL_CONNECTOR_KEY`、`MYTERMINAL_MAX_OUTPUT_CHARS`、`MYTERMINAL_COMMAND_TIMEOUT_SEC`。非 headless 模式这些变量会被删除，避免误覆盖 TUI 设置。

### 9.6 连接端点

| 连接 | 用途 | 端点 |
|---|---|---|
| GPT Actions | 自定义 GPT + OpenAPI Action | `https://YOUR-HOST/openapi.json` |
| ChatGPT Apps | MCP connector | `https://YOUR-HOST/mcp/<hidden-connector-key>` |

Actions facade 三操作：`extension_discover`/`extension_call`/`extension_register`（camelCase: `extensionDiscover`/`extensionCall`/`extensionRegister`）。Apps 同时暴露 facade + 约 30 个 direct tool + blob 暂存。

### 9.7 测试

```bash
bun run test                # 构建后跑 test/*.test.mjs（超时 120s）
```

测试覆盖：OpenAPI 3.1、Actions/Apps identity、controller 接管、checkpoint 时机、parent/child 完成、事件 ACK、订阅、持久历史、脱敏、迁移、删除、续执行、OpenTUI 滚动与拖选、subagent M1-M8、worktree 隔离/采纳、skill v1/v2、redaction、错误码、安全边角等。

### 9.8 CI（.github/workflows/ci.yaml）

矩阵 `macos-latest / windows-latest / ubuntu-latest`，`fail-fast: false`，30 分钟超时。步骤：
1. `bun install --frozen-lockfile`
2. `bun run typecheck` → `bun run build` → `bun test --timeout 300000 test/*.test.mjs`
3. Skill provider 同步校验 + self-test
4. `bun audit`
5. Unix/Windows installer 构建与演练（含 incomplete 目录恢复测试）

### 9.9 安装脚本

- `scripts/install-macos.sh` / `scripts/install-linux.sh` / `scripts/install-windows.ps1`：下载平台预编译二进制、校验 SHA-256、注册全局 `myterminal` 命令、启动 TUI。
- `scripts/mac-one-shot-awake-lock.swift` / `mac-arm-one-shot-lock.ts`：macOS 被动锁 helper。

### 9.10 更新

TUI 启动时检查 GitHub release；Settings 页按 `U` 安装。更新器下载预编译可执行 + SHA-256，装入新版本目录，原子切换 `current` 指针，旧版本保留回滚。`update-transaction.ts` 提供事务化 snapshot→install→migrate→restart→recovery，失败自动 rollback。Git 源码检出绝不被一键更新覆盖。

---

## 10. 关键不变量与工程约束

### 10.1 架构不变量（docs/architecture.md）

1. 一个活跃进程租约同一时刻只属于一个工作区。
2. 公网网关在成员注册移除后绝不继续服务。
3. 只有最后一个活跃 MyTerminal 进程可停止全局被动锁 helper。
4. 凭据在有限 repeat 截止后 fail-closed，且在上下文切换时立即隐藏。
5. 任何 Diff 操作不读无界文件、不产生无界输出。
6. Setup/启动选择/Settings 消费同一完整工作区选择模型。
7. 工作区本地状态绝不逃逸到另一工作区，内部状态排除出工具与 Diff。
8. TUI 中的进程/集群状态来自运行时拓扑，非静态标签。
9. Actions 续执行队列仅在确切计划调用成功后才前进。
10. 标记非破坏的 Apps 窄工具不覆盖已有文件；通用 facade 保留显式覆盖与任意命令能力。
11. Subagent 隔离上下文与工具集；不能启动其他 subagent（递归防护）；与 fork skill 共享全局 maxParallel。
12. Skill frontmatter 是路由（inline vs fork）唯一真相源；skill 工具绝不静默把 fork 降级为 inline。

### 10.2 安全约束（DEV_CONSTRAINTS.md）

- 所有工具操作限制在用户选定工作区内（读写安全边界）。
- 连接凭据存于 OS 用户配置目录。
- 仅持久化 session-token 哈希。
- 敏感字段从持久化审计日志脱敏。
- 生产环境 bind 地址保持 `127.0.0.1`。

### 10.3 会话模型约束

- root 创建工作上下文，可委派直属子会话。
- 子会话不可创建孙会话。
- 已完成会话不可变；续作经 `session_register(continuesSessionId)`，非 `session_inherit`。

### 10.4 工程约定（来自项目记忆）

- Subagent 文件隔离需工作区为 Git 仓库；否则变更直接写主工作区。
- Subagent 超时不自动重试，需人工干预。
- `readOnly:true` 的 subagent 缺少 `write_file`/`execute_cli` 等写工具。
- `retryable:false` 错误（DUPLICATE_SESSION/SESSION_ALREADY_CLAIMED/INVALID_INPUT）不自动重试。
- 限流（429）重试：30s→60s→blocked+通知；网络错误：5s→10s→20s→blocked+通知。
- Subagent 在非 TTY 环境执行交互式 CLI 会超时；用非交互校验。
- LLM 处理超长 `execute_cli`/`grep` 输出（>3000 字符）易卡顿；成功任务通常输出 <2000 字符或低 maxTurns。

### 10.5 变更指导

新行为必须放在控制其生命周期的所有权层。UI 组件应渲染视图模型而非重建域状态。全局资源需全局所有权检查；工作区资源需工作区身份；会话资源需会话身份。每个新进程、定时器、文件锁、凭据显露路径都需要显式的创建、超时与清理规则。

---

## 附：关键文档索引

| 文档 | 路径 |
|---|---|
| 架构与所有权 | [docs/architecture.md](./docs/architecture.md) |
| Actions 配置 | docs/ACTIONS_SETUP.md（中文 .zh-CN.md） |
| GPT 预置指令 | docs/GPT_INSTRUCTIONS.md |
| 场景 prompt | docs/PROMPT_PLAYBOOK.md |
| 隐私与部署 | docs/PRIVACY.md |
| 手动/离线安装 | docs/MANUAL_INSTALL.md |
| Subagent provider 配置 | docs/SUBAGENT_SETUP.md |
| AI 编码规则 | [AI_RULES.md](./AI_RULES.md) |
| 开发约束 | [DEV_CONSTRAINTS.md](./DEV_CONSTRAINTS.md) |
| 贡献指南 | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| 安全披露 | [SECURITY.md](./SECURITY.md) |
