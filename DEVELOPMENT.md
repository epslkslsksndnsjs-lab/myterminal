# MyTerminal 开发与管理手册

> 本仓库**唯一**允许存在的内部协作文档。
> 用户向文档一律放 `docs/`（ACTIONS_SETUP / GPT_INSTRUCTIONS / MANUAL_INSTALL / PRIVACY / PROMPT_PLAYBOOK / SUBAGENT_SETUP / architecture 等）。
> 其余一切内部内容——管理规则、AI 编码规则、开发约束、领域术语、代码架构——**只能存在于本文件**，禁止另立内部文档。
> 维护身份：`epslkslsksndnsjs-lab <epslkslsksndnsjs-lab@users.noreply.github.com>`

---

## 0. 污染红线与历史教训（先读这里）

本仓库前身（已归档为私有仓库 `myterminal-legacy`，历史保留未删）因下列污染被放弃重建。以下台账是"绝不再犯"清单，每条对应一条红线规则。**任何提交/文件不得让此类污染在本仓库再现。**

### 0.1 旧仓库污染台账（逐条修复/规避到本仓库）

| # | 旧仓库问题 | 本仓库对策 |
|---|---|---|
| 1 | 提交元数据被机器身份污染：共 70 条 `.local` 邮箱身份（3 条近期本机名@主机名.local + 67 条早期 Admin@主机名.local），非 GitHub noreply 身份 | 仓库 git 身份固定为 `epslkslsksndnsjs-lab <epslkslsksndnsjs-lab@users.noreply.github.com>`；本地 clone 一律用该身份，禁止任何 `.local` 身份提交 |
| 2 | 协作文档写入本机家目录绝对路径（macOS `Users/<用户名>/…`、Windows `Users\<用户名>\…` 形态） | 文档与提交不得出现本机路径；CI 路径守卫 `scripts/check-no-absolute-paths.mjs` 强制拦截，必须保持启用 |
| 3 | 内部流程产物入库：overview、issue 证据、batch agent brief、review-gate、重构计划板、IMPLEMENTATION_PREVIEW、execution queue 等 | 此类产物只存在于本地临时目录，永不入库；内部内容一律并入本文件，禁止另立文件 |
| 4 | 文档引用已删除的 ADR 造成死链（docs/SUBAGENT_SETUP\*.md:168） | 文档只链接现存文件；ADR 目录已被 `.gitignore` 忽略，引用一律用文字描述（ADR-00NN），不写文件路径 |
| 5 | 历史身份重写后被本地旧 clone 直接 push 覆盖（本地未 hard-reset），重写失效，机器身份被推回 | 本地 clone 改动前先 `git fetch origin && git reset --hard origin/main`；push 前核对本地历史与 origin 同源 |
| 6 | 内部/临时内容未过身份与路径双重检查即公开化 | 转公开前必须过 §1.5 检查清单并经仓库所有者确认 |

### 0.2 红线规则（违反即不得合入）

1. 任何提交/文件不得包含本机路径、本机 git 身份或 `.local` 邮箱。
2. 内部内容只允许存在于本文件；新增内部约束/术语/架构记录时编辑本文件，不得新建内部文档。
3. `docs/` 只放用户向文档；禁止 ADR、证据、review-gate、队列、摘要等流程产物入库。
4. 内部引用一律文字描述（ADR-00NN），不写文件路径；不链接已被忽略/删除的文档。
5. CI 路径守卫与全部测试（含本文档断言）必须全绿才可合并。
6. 本仓库保持 private，直至仓库所有者明确确认转公开。

---

## 1. 管理规则

### 1.1 仓库身份

- 作者/提交者固定为 `epslkslsksndnsjs-lab <epslkslsksndnsjs-lab@users.noreply.github.com>`。
- 本地 clone 的 `git config` 必须使用上述身份；禁止本机名 / `.local` 邮箱身份。
- 提交信息不得包含本机路径、机器身份或内部流程引用。

### 1.2 文档纪律（唯一内部文档制度）

- 仓库文档分两类：**用户向**（`docs/` + README）与**内部**（仅本文件）。
- 一切内部约束、领域术语、架构知识、工程约定，只写在本文件并按章节归类。
- 新增内部主题 → 在本文件找归属章节或新增小节；**绝不新建内部 .md**。

### 1.3 提交纪律

- subject 一行、≤72 字符；body 说明动机；涉及行为变更须指出所有权层。
- 保持历史可溯源：push 前 `git fetch origin && git reset --hard origin/main`，禁止旧历史/旧身份混入。

### 1.4 分支与发布

- `main` 受 CI 保护：三平台 typecheck / build / test + 路径守卫 + skill provider 同步校验。
- 转公开：`gh repo edit myterminal --visibility public`，但执行前必须先过 §1.5 检查清单并由所有者确认。

### 1.5 转公开检查清单

- [ ] CI 全绿（含路径守卫与本文档断言）
- [ ] 全仓库无 `.local` 邮箱、无本机路径（守卫扫描 + 人工抽查）
- [ ] `docs/` 仅用户向文档，无 ADR / 内部产物
- [ ] 本文件 §0 台账无具体机器身份 / 本机路径明文
- [ ] 所有者复查后执行 `gh repo edit` 转公开

---

## 2. AI 编码规则（原 AI_RULES.md）

Rules for AI coding assistants working on this project.

### 2.1 User-facing copy

- Internal implementation constraints, audit guarantees, and instructions written to satisfy development requirements must not be shown as user-facing UI copy. UI text must serve an actual user task, decision, status, or recovery action.

---

## 3. 开发约束（原 DEV_CONSTRAINTS.md）

### 3.1 Workspace boundary

All tool operations are restricted to the user-selected workspace. The workspace is a real read/write security boundary.

### 3.2 Security

- Connection credentials live in the operating-system user configuration directory
- Only session-token hashes are persisted
- Sensitive fields are redacted from persisted audit logs
- Bind address should remain on `127.0.0.1` in production use

### 3.3 Session model

- A root session creates work contexts; it may delegate to direct child sessions
- Children cannot create grandchildren
- Completed sessions are immutable
- Continuation is done through `session_register(continuesSessionId)`, not `session_inherit`

---

## 4. 领域术语表（原 CONTEXT.md）

> 无实现细节。仅含经拷问确认的领域概念定义。

### 4.1 Skill

#### 存储

两个位置，首次启动自动创建目录（和 draftAgentMd 机制一致，全局 skills/ 始终建好，项目级按需建）：

- **全局**：`~/.config/myterminal/skills/<name>/SKILL.md`（跨 workspace 共用，与 AGENT.md 同级）
- **项目级**：`<workspace>/.myterminal/skills/<name>/SKILL.md`（项目专属）

discover/加载时两个目录都扫描，同名 skill 全局优先（全局覆盖项目级）。

#### 内建 Skill

系统硬编码 `BUILTIN_SKILLS` Map（skills.ts），当前含 `adaptive-guard`（7 类错误恢复操作手册）。优先级：

```
全局用户文件 > 项目用户文件 > 内建 hardcode
```

用户同名文件始终覆盖内建。内建 skill 在新用户没有任何文件时作为兜底，确保首次连接即有错误恢复策略可用。

- 不是可执行的 tool（那是 extension 的角色）。
- AI 读取 skill 内容后，按指引调用其他 tool（execute_cli、write_file 等）完成工作流。
- 例：git-commit skill 告诉 AI "当用户要提交时，先 git diff → 生成规范 message → execute_cli 执行"。
- 与 AGENT.md 区别：AGENT.md 是全局宪法（始终注入），skill 是专业知识包（按需加载）。

### 4.2 Skill 发现

Skill 元数据通过两个管道暴露给 AI，均带 mode 字段（ADR-0010 决策 5）：

- **Actions 通道**（GPT）：`extension_discover` 响应加 `skills: [{name, description, when_to_use, mode}]` JSON 数组。无大小限制。
- **MCP 通道**（Claude）：指令只放一句提示 `"Use skill() to list available skills, skill(name) to run one."`——不塞列表（2048 字符截断限制）。AI 按需调 skill() 发现。

### 4.3 skill tool

builtin tool（ADR-0010）。无参/有参区分两种行为：

- `skill()` → 返回 `{skills: [{name, description, when_to_use, mode}]}`（名单，带 mode）
- `skill(name="xxx")` → 读 frontmatter 的 mode，自动路由：
  - `mode: inline`（缺省）→ 返回 `{name, description, mode, content}`（SKILL.md 正文，云端 AI 照着做）
  - `mode: fork` → 启动 subagent 执行，返回 `{name, description, mode, taskId, sessionId, status:'running'}`

annotations 非 readOnly（fork 有副作用）。list/inline 不要求 identity；fork 要求 identity（调 actor 拿 parentSessionId）。

_Avoid_: skill_list, skill_load（已被 skill 合并取代，ADR-0010 决策 3/7）

### 4.4 mode

SKILL.md frontmatter 的可选字段（ADR-0010 决策 2），决定 skill 的执行方式。缺省 `inline`。

- `inline`：读 SKILL.md → 内容作为 tool_result 返回 → 云端 AI 自己照着做。适合简单、几步搞定的 skill。
- `fork`：读 SKILL.md → 内容作为 task 启动 subagent 执行 → 异步返回 taskId → 主 agent 用 subagent_status 查结果。适合复杂、多步骤、需隔离上下文的 skill。

AI 不传 mode 参数——mode 由 skill 作者在 frontmatter 声明，工具自动路由。

### 4.5 fork

skill 的执行模式之一（ADR-0010 决策 1）。skill 内容不进主上下文，而是作为 task 注入 subagent 的隔离上下文。subagent 用 3 层 compact（executor.ts 决策 20）管理上下文，结束后整个上下文丢弃。主上下文只有 subagent 的 result。

fork 复用 SubagentRunner.start()（ADR-0009），和 subagent_start 共享 maxParallel 配额、递归防护、通知机制。fork 的 subagent 工具集是封闭的 8 个（不含 skill，ADR-0007 决策 4 保持）。

fork 用本地 API key（付费），不是"免费借云端 AI"。

### 4.6 forkOptions

SKILL.md frontmatter 的可选字段（ADR-0010 决策 6），仅 `mode: fork` 时生效。覆盖 subagent 默认配置，优先级：`forkOptions > config.json subagent 段`。

支持字段：deliverables / acceptanceCriteria / constraints（任务包）+ maxTurns / timeoutSec / readOnly（运行时配置）。安全网上限：maxTurns 200，timeoutSec 3600。

---
## 5. 代码架构百科（原 CODE_WIKI.md，源码静态分析生成）

> 版本：v0.1.2 · 协议：MIT · 运行时：Bun ≥ 1.3
> 本文档由源码静态分析生成，覆盖项目整体架构、模块职责、关键类与函数、依赖关系与运行方式。

---

### 目录

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

### 1. 项目概述

MyTerminal 是连接 **ChatGPT 聊天模式与本地开发环境**的终端桥梁。它让普通的 ChatGPT 对话能够以受控、可审计的方式操作本地授权工作区：检视与编辑文件、执行有界命令、协调多个工作会话、并通过本地全窗口 TUI 让用户始终保持控制权。MyTerminal 本身不是聊天客户端，而是 ChatGPT 与本地计算机之间的桥梁。

#### 核心能力

- **双通道接入**：GPT Actions（OpenAPI facade）与 ChatGPT Apps（MCP connector）。
- **可审计的工作会话层**：root/delegate 会话层级、可继承、可转交、不可变终态、永久 JSONL 历史。
- **多会话协作**：root 可委派多个直属子会话，子会话不可再委派；通过持久化消息交付可纳入的成果。
- **声明式扩展**：用户可注册 builtin/command 两类自定义扩展。
- **Skill 系统**：用户编写的 `SKILL.md`，支持 inline（直接执行）与 fork（隔离 subagent 异步执行）两种路由模式。
- **Subagent 系统**：隔离的智能体循环，独立的 8 工具集、上下文窗口、token 追踪器，Anthropic 兼容协议 LLM 适配（`baseUrl` 可配），上下文级单例隔离。
- **全窗口双语 TUI**：基于 OpenTUI + React 的九页签界面（中/英双语、暖色双主题）。
- **集群与共享端口**：多进程共享同一 `host:port`，自动选主，leader 故障自动接管。
- **安全与隐私**：本地优先、无项目遥测、凭据脱敏单源、会话 token 仅存哈希、工作区即读写安全边界。

---

### 2. 项目整体架构

#### 2.1 系统拓扑

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

#### 2.2 分层架构

| 层 | 主要模块 | 职责 |
|---|---|---|
| 入口/配置 | `cli.ts`, `config.ts`, `migration.ts` | 启动、设置、兼容迁移 |
| 运行时/进程 | `server.ts`, `cluster.ts`, `cluster-router.ts`, `control-channel.ts`, `runtime-lifecycle.ts`, `instances.ts` | HTTP/控制生命周期、进程拓扑、路由、租约 |
| 域/状态 | `store.ts`, `types.ts`, `tui-model.ts`, `context-projector.ts` | 会话、消息、事件、journal/snapshot 持久化、审计历史 |
| 扩展门面 | `extensions.ts`, `core-tools.ts`, `mcp.ts`, `openapi.ts`, `tool-schemas.ts` | 鉴权工具发现、注册与调用 |
| Skill 系统 | `skills.ts` | SKILL.md 扫描、frontmatter 解析、inline/fork 路由 |
| Subagent 系统 | `subagent/*.ts` | 隔离 agent loop、8 工具集、Anthropic 协议 LLM 适配、token 追踪、权限、上下文隔离 |
| 工具结果整形 | `tool-parse.ts` / `l3/*.ts` | TOOL_SHAPES 中心注册表、L1/L2/L3 分层路由、D12 失败双帽、D13 递归、D7 双版本审计、预算门 |
| 资源适配 | `session-resources.ts`, `diff.ts`, `security.ts`, `update.ts`, `update-transaction.ts` | OS helper、Git 采样、路径/凭据安全、事务化更新 |
| TUI 契约/展示 | `tui/contracts.ts`, `tui/state.ts`, `tui/controller-logic.ts`, `tui/*` | 视图模型、终端配置、交互契约、渲染 |

#### 2.3 所有权模型

- **工作区运行时**：一个 `MyTerminalRuntime` 拥有一个工作区本地服务器、store、扩展服务、MCP 传输、定时器与工作区运行时租约。
- **共享端口集群**：`PortClusterRegistry` 持有一个 `host:port` 的成员与选主；恰好一个成员接受公网流量，follower 仅暴露 loopback RPC。
- **工作区目录与租约**：`workspaces.json` 是持久目录；`lastPid/lastHost/lastPort` 是瞬态租约。
- **被动锁 helper**：安装级全局资源，仅当最后一个活跃 MyTerminal 进程退出时才停止。
- **会话资源**：一次性 helper 按工作区+会话隔离；会话结束/取消/运行时关闭只清理 PID 与可执行身份匹配的 helper。

---

### 3. 技术栈与依赖

#### 3.1 运行时与构建

- **Bun ≥ 1.3**（`packageManager: bun@1.3.14`）：运行时、测试运行器、打包器。
- **TypeScript 5.9.3**，`strict: true`，target `ES2022`，module `NodeNext`，JSX `react-jsx`（`@opentui/react`）。
- 打包：`bun build --compile --minify` 生成单文件可执行。

#### 3.2 运行时依赖（package.json）

| 依赖 | 版本 | 用途 |
|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.30.0 | MCP 协议（Apps connector） |
| `@opentui/core` / `@opentui/keymap` / `@opentui/react` | 0.4.5 | 终端 UI 渲染、键位路由 |
| `express` | ^5.2.1 | HTTP 服务器（Actions/OpenAPI/MCP） |
| `react` | 19.2.7 | TUI 组件树 |
| `zod` | ^4.4.3 | 运行期 schema 校验（MCP 工具入参派生） |
| `node-llama-cpp` | ^3.20.0 | L3 本地模型推理引擎（Qwen GGUF，trustedDependencies） |

#### 3.3 devDependencies

`@types/express`、`@types/node`、`@types/react`、`typescript`。

#### 3.4 overrides

`fast-uri@^3.1.5`、`hono@^4.12.34`、`ip-address@^10.3.1`、`@hono/node-server@2.0.11`（锁版本避免回归）。

---

### 4. 目录结构

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
│   ├── tool-parse.ts          # 工具结果整形中心（TOOL_SHAPES 路由）
│   ├── l3/                    # L3 本地模型层 (7 文件)
│   ├── subagent/              # 子智能体系统 (16 文件)
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

### 5. 核心模块职责详解

#### 5.1 入口与配置层

##### [src/cli.ts](./src/cli.ts)
进程入口。解析 CLI 参数（`--version`/`--help`/`--headless`/`--verify-installation`）与 `l3-model fetch` 子命令（sha256 钉死下载 L3 模型，stateless、先于 settings/runtime），执行首启设置、工作区选择、运行时启动；非 TTY 自动进入 headless；注册 `unhandledRejection`/`uncaughtException` 安全关闭。

- `main()`：主流程；`ensureSettings()` 触发首启 TUI；`chooseWorkspace()` 选择工作区；`startRuntime()` 处理 `EADDRINUSE`（kill/next/cancel）。
- `effectiveEnvironment(headless)`：非 headless 删除 `MYTERMINAL_*` 环境覆盖，避免误覆盖 TUI 设置。
- `safeFatalShutdown()`：致命错误后 `runtime.close()` 并置退出码。

##### [src/config.ts](./src/config.ts)
设置文件解析、环境变量覆盖、可行性校验、AGENT.md/skills 目录草拟。

- `loadMyTerminalConfig(env)`：组装 `MyTerminalConfig`（含 AGENT.md、skills 目录草拟、迁移、工作区注册）。
- `readMyTerminalSettings`/`saveMyTerminalSettings`/`createDefaultSettings`/`maskCredential`/`settingsPath`。
- `assessRuntimeEnvironment`：valid/workspace_missing/volume_unmounted/permission_denied/state_dir_unavailable。
- `validateSettings`/`validateSettingsFeasibility`：字段校验 + 端口占用探测。

##### [src/migration.ts](./src/migration.ts)
跨目录 `state.json` 与 `history/*.jsonl` 的合并迁移，幂等且按稳定 ID 去重保留。`migrateWorkspaceState`。

#### 5.2 运行时与集群层

##### [src/server.ts](./src/server.ts) — 组合根
`class MyTerminalRuntime` 持有工作区本地服务器、store、扩展服务、MCP 传输、集群参与权与生命周期。

- **拥有资源**：`store`、`extensions`、`app`(Express)、`internalServer`(127.0.0.1:0)、可选 `publicServer`、`mcp`/`clusterMcp`/`clusterRouter`、`cluster?`、`workspaceCatalog`、`controlChannel?`、三个定时器（heartbeat 1500ms / election 1800ms / resume 2000ms）、内存日志（500 条 + 落盘 runtime.jsonl）。
- **L3 预热**（`start()` 触发，`l3Enabled()` 门控）：异步预热 + smoke probe，最多 `WARMUP_MAX_RETRIES`+1 次尝试、退避 500/1000/2000ms，全失败仅记日志不阻断；`MYTERMINAL_L3_WARMUP=false` 可关。就绪状态三通道可见：`/health` 的 `l3` 字段（D-8 通道2）、TUI Settings 页 L3 卡片、运行时日志。启用策略（D18.2）：standalone 默认开、cluster 参与者默认关（防 N×1.1GB 模型乘散），`MYTERMINAL_L3_ENABLED` env 优先覆盖。
- **生命周期**：`start()` → `tryBecomeLeader()` → `revalidateAfterResume()` → `close()`→`closeOnce()`。
- **路由**（`configureRoutes`）：`/health`、`/openapi.json`、`/openapi-3.1.json`、`/mcp/:connectorKey`、`/actions/extensions/{discover,register,call}`（Bearer）、`/cluster/owns`、`/cluster/rpc/:method`（cluster-secret）。
- **集群网关**（`createClusterGateway`）：leader 额外暴露公网入口，经 `clusterRouter` 转发到归属成员 internalPort。

##### [src/cluster.ts](./src/cluster.ts)
`class PortClusterRegistry`：文件锁原子注册表。`register`/`heartbeat`/`setLeader`/`unregister`/`ensureRegistered`/`prune`。校验同 workspaceId 冲突、protocolVersion 兼容、connectorKey/actionsTokenHash 一致；锁所有权 token + compare-before-unlink（ADR-0018）。

##### [src/cluster-router.ts](./src/cluster-router.ts)
`class ClusterExtensionRouter implements ExtensionFacade`：`discover`/`register`/`call`/`mcpSessionClosed`。按 `identity.sessionId` 经 `routeBySession` 遍历成员 RPC；无 identity 时按 `boundMember`/`workspaceId`/兜底路由；成员间 RPC 走 `/cluster/rpc/{method}` + `x-myterminal-cluster-secret`。

##### [src/control-channel.ts](./src/control-channel.ts)
`class ControlChannelMonitor`：周期探活 `publicBaseUrl`，恢复后触发 `revalidateAfterResume`；指数退避重连；`classifyControlChannelFailure` 分类失败。

##### [src/instances.ts](./src/instances.ts)
全局工作区目录注册表与端口占用探测：`workspaceId`、`readWorkspaceRegistry`、`upsertWorkspaceRecord`、`releaseWorkspaceRecord`、`portOwner`(lsof)、`findAvailablePort`、`terminatePortOwner`、`appendWorkspaceLog` + `rotateRuntimeLog`（5MB/3 份）。

##### [src/runtime-lifecycle.ts](./src/runtime-lifecycle.ts)
原子写入 `runtime-state.json`：starting/active/revalidating/degraded/shutting_down/stopped。

##### [src/session-resource-manager.ts](./src/session-resource-manager.ts)
`SessionResourceManager` 单例：agent/session/global 三级资源清理单点注册与统一收口。`disposeAgent(agentId)`/`disposeSession(sessionId)`。

##### [src/session-resources.ts](./src/session-resources.ts)
macOS 被动锁 helper 的编译/启停；per-session awake-lock 的 arm/disarm/reap。`verifyRuntimeResources()`。

#### 5.3 域状态层

##### [src/store.ts](./src/store.ts) — `MyTerminalStore`
会话/消息/事件/扩展持久化与业务规则。核心方法（节选）：

- 会话：`registerRoot`/`registerDelegate`/`inherit`/`release`/`checkpoint`/`unregister`/`tag`/`subscribe`/`eventsAck`。
- 消息：`sendMessage`/`messageInbox`/`messageList`/`messageConversation`。
- 上下文：`context(sessionId)` → 经 `context-projector` 投影；`history(sessionId)` 分页读 JSONL。
- 事件：`pendingEvents`/`emitEvent`/`subscriptions`。
- 扩展：`upsertExtension`/`removeExtension`/`listExtensions`。
- 续执行：`expectedContinuationCall`/`completeContinuationCall`/`activateHarnessContract`。
- 绑定：`bindApp`/`bindMcp`/`unbindMcp`（MCP 仅内存，ADR-0029 防僵尸）。
- `revision` 自增驱动 TUI `renderRevision()` 比对。

##### [src/types.ts](./src/types.ts)
全部核心类型定义（详见 [§6 关键类型](#61-域模型-types)）。

##### [src/context-projector.ts](./src/context-projector.ts)
纯函数上下文投影 `projectContext`：组装 session/objective/finalSummary/parentContext/recentToolCalls(10)/recentMessages(20)/inherited*，`CONTEXT_PROJECTION_LIMIT = 16_000`，O(n) 预算裁剪，trim 顺序固定。

##### [src/tui-model.ts](./src/tui-model.ts)
TUI 纯模型：`logicalSessionGroups`（按 continuesSessionId 链归并到 origin root）、`conversationGroups`、`selectedViewport`。

#### 5.4 扩展门面层

##### [src/extensions.ts](./src/extensions.ts) — `ExtensionService`
鉴权、审计、续执行装饰、后台任务、续执行断言的门面核心。

- `discover`：无 identity 返回 bootstrap 指令 + skills + bootstrapTools（不写审计）；已认证经 `withAudit` 返回 tools catalog + instructions + harness 合约 + registrationSchema + 最多 5 条未确认事件。
- `register`：`action` ∈ remove/validate/upsert；`validateSpec` 校验后 `store.upsertExtension`。
- `call`：解析 tool 与 `callArguments`（三源合并）；bootstrap 豁免（`session_register` 非 delegate、`session_inherit`）；`assertContinuation` 校验队列顺序；非阻塞调度（200ms fast-return → BackgroundTask + `task_poll`）；同步路径 `invokeTool` → `applyShape`（工具结果整形统一出口：L1/L2/L3 路由，subagent 通道 D2 豁免）→ `decorateContinuation` → `attachEvents` → `finishAudit`。
- `callSubagent`：trimmed 版，供 subagent child 通知父 session。
- `withAudit`：ADR-0032 统一的 try/beginAudit/finishAudit/catch 脚手架。

##### [src/core-tools.ts](./src/core-tools.ts)
`createBuiltinTools`：注册 36 个内置工具（34 处 add，其中 git 循环展开 git_status/git_diff/git_log 3 个），返回 `Map<string, ToolDefinition>`。分组：
- 文件：`list_dir`/`find_files`/`search_text`/`read_file`/`read_file_range`/`write_file`/`apply_patch`
- blob：`blob_create`/`blob_read`/`blob_write_file`
- 命令/Git：`execute_cli`/`git_*`/`run_checks`
- 会话：`session_register`/`inherit`/`list`/`checkpoint`/`context`/`history`/`release`/`unregister`/`tag`/`subscribe`/`events_ack`
- 消息：`message_send`/`inbox`/`list`/`conversation`
- skill、subagent：`subagent_start`/`status`/`abort`
- `runCommand`/`runShellCommand`：spawn 执行器（POSIX 进程组信号、Windows taskkill 树终止、timeout+cancel、boundedOutput）；`decodeBlob`（utf-8/base64）。
- 工具结果经 `TOOL_SHAPES` 中心表整形路由（§5.9）：git_* 四工具 L3 豁免（增补-04 #103）仅走 L1 去噪；`find_files` handler 上报 `totalMatches`（D16.2 totalCount 唯一合法来源，W1-01 #74）。

##### [src/openapi.ts](./src/openapi.ts)
`buildOpenApi`：生成 Actions 三操作（discover/register/call）的 OpenAPI 3.1 文档与 schema 组件。操作 ID 用 camelCase（`extensionDiscover`/`extensionCall`/`extensionRegister`）。

##### [src/mcp.ts](./src/mcp.ts) — `MyTerminalMcpTransport`
per-session `McpServer` + `StreamableHTTPServerTransport`，`sessionIdGenerator: randomUUID`；`onsessionclosed` 解绑。`createMcpServer` 注册 3 个 facade 工具 + 约 30 个 direct tool。`extensionToolInput`：facade 协议层 zod（44 字段 + catchall unknown）。`registerDirect`：从 `BUILTIN_INPUT_SCHEMAS` 派生 zod，统一注入 `identity`/`workspaceId`。MCP 出口（facade + direct）与 Actions 共用同一 `applyShape` 整形链（T13）。

##### [src/mcp-schema.ts](./src/mcp-schema.ts)
`jsonSchemaToZod(schema, path)`：派生器，支持 14 个关键字，`UnsupportedSchemaError` 强制失败而非静默回退。`additionalProperties:false`→strip z.object；`true`+无 properties→z.record。

##### [src/tool-schemas.ts](./src/tool-schemas.ts)
`BUILTIN_INPUT_SCHEMAS`：所有内置工具形状单源（core-tools 运行期校验 + mcp 派生 + discover 目录三处共用）；`TASK_POLL_TOOL`。

#### 5.5 Skill 系统

##### [src/skills.ts](./src/skills.ts)
- **布局**：目录式 `<skillsDir>/<name>/SKILL.md` 与平铺式 `<name>.md`；全局 `<configDir>/skills/` 覆盖项目级，用户文件覆盖内建。
- `parseFrontmatter`：手写零依赖 YAML 子集解析（支持一层嵌套 `forkOptions`）。
- `validateSkillManifest`：`name` 正则 `^[a-z][a-z0-9-]{2,63}$`、description 10-800 字符、mode ∈ {inline,fork}（缺省 inline）、forkOptions 子字段校验。文件 100KB 上限。
- 内建 `adaptive-guard`（inline，恢复决策树）。
- inline：返回 `{name, description, mode:'inline', content}`，不需 identity。
- fork：要求 identity；`transport==='subagent'` 抛 `FORBIDDEN`（递归防护）；调 `getSubagentRunner().start(...)`，origin=`{type:'skill', skillName}`；返回 `{mode:'fork', taskId, sessionId, status:'running'}`。

#### 5.6 Subagent 系统

详见 [§6.5 Subagent 关键模块](#65-subagent-系统-srcsubagent)。该系统由 16 个文件构成，分层如下：

| 层 | 文件 | 职责 |
|---|---|---|
| 接入层 | `runner.ts` | start/status/abort 控制面，编排 delegate session + 通知链 |
| 执行核心 | `executor.ts` | agent loop 主循环（compact 三层 + LLM + 工具 + 退出策略） |
| 工具层 | `tools.ts` / `tool-executor.ts` | 8 工具定义 + 并行/串行执行器 |
| LLM 适配 | `llm-adapter.ts` / `resilience-policy.ts` / `token-counter.ts` / `cost-tracker.ts` | Anthropic 协议适配 + 弹性 + 估算 + token 累计 |
| 隔离层 | `permissions.ts` | 命令安全（readOnly 决策） |
| 状态层 | `store.ts` / `file-state.ts` / `shell-tracker.ts` / `result-budget.ts` | 记录 + 读后写 + 进程追踪 + 结果预算 |
| 辅助 | `grep-utils.ts` / `tui-bridge.ts` | grep 引擎 + AG-UI 事件总线 |
| 地基 | `context.ts` | 可注入上下文（`SubagentContext` 收敛 6 项模块级全局单例，见 §6.5 隔离说明） |

#### 5.7 资源适配层

##### [src/diff.ts](./src/diff.ts)
`WorkspaceDiffTracker`：有界 Git diff/status 采集，untracked 文件采样，TUI 周期刷新。Git 可选能力，探测一次后非 Git 目录安全降级；每个子进程有 deadline 与有界输出。

##### [src/security.ts](./src/security.ts)
- `safeEqual`：sha256 + timingSafeEqual 常量时间比较（token/key/cluster-secret）。
- `validateSafeRegex`：嵌套量词 ReDoS 启发式检测。
- `resolveWorkspacePath`：realpath 防越界 + stateDir 保护 + symlink 逃逸检测。
- `validateJsonSchema`：手写 JSON Schema 校验器（与 mcp-schema 派生语义对齐）。
- `renderTemplate`：`{{input.field}}` 模板替换。

##### [src/audit-log.ts](./src/audit-log.ts)
`class AuditLog`：`event`(写)、`facts`/`recentFactsPage`/`factsPage`(读)、`pruneDeleted`。`AuditFact` 含 sessionId/sessionName/at/tool/ok/errorCode。`AuditLogIo` 注入使其无文件系统可测。状态映射 started→running、succeeded→completed，保留 policy_rejected。

##### [src/redact.ts](./src/redact.ts) — 脱敏单源（ADR-0026）
`redact<T>(value)`：双形式（对象/字符串）。三层处理：敏感键→`[REDACTED]`；body 键→`[REDACTED <n> chars]`；自由字符串→转义合并的**单条 alternation 单遍 replace**（#102，O(串数+secrets) 替代 split/join 乘数）扫除 Bearer/key=value/query + 字面量 secret 全量替换。所有出口（HTTP 响应/日志/审计/错误）必经此函数；store 侧历史 tail 增量缓存（`historyTailCache` 按 (session,size,mtime) 失效，`HISTORY_TAIL_LIMIT=5000`）避免重复红化整段历史。

##### [src/update.ts](./src/update.ts) / [src/update-transaction.ts](./src/update-transaction.ts)
- `checkForUpdate`：GitHub releases/latest 探测；`installUpdate`：锁→事务→快照→install→migrate→restart→recovery→prune。
- `executeUpdateTransaction`：阶段审计 emit（start/snapshot/install/migration/restart/recovery/complete），失败自动 rollback。
- `snapshotUpdateData`/`restoreUpdateData`：配置目录全量备份与按 revision/size 智能恢复，`credentialsPreserved` 校验。

##### [src/continuation.ts](./src/continuation.ts)
`continuationPolicy(mode)`：返回 `{enabled, minCalls, maxCalls, exactCalls}`；`harnessRequirement`/`harnessContract` 合约文案；`HARNESS_CONTRACT_REVISION = 'actions-long-task-harness-v2'`。

#### 5.8 TUI 层

基于 `@opentui/react` + `@opentui/keymap` 的 React 组件树 + 控制器（`TuiController`）+ 纯函数模型层。遵循 ADR-0004 九大决策（双速 tick、五层键盘路由、暖色双主题、吉祥物情绪、纯函数模型等）。详见 [§6.6 TUI 关键模块](#66-tui-系统-srctui)。

#### 5.9 工具结果整形系统（tool-parse.ts + l3/，ADR-0047）

##### [src/tool-parse.ts](./src/tool-parse.ts) — 整形中心
`TOOL_SHAPES` 中心注册表（16 条）把每个工具的结果路由为三类（各工具入口见 §5.4/§6.3）：

- **L1 reduce**：被动去噪（剥 `command`/`cwd`/`signal`/`timedOut`/`cancelled`）+ 主动精简（会话/消息列表摘要替换 + count/分页）+ 聚合字段（D16 `count`/`totalCount`；D16.3 按工具 opt-in：search_text `fileCount`/`uniqueFiles`、git_log `commitCount`，派生字段一律代码后置补、不进 L3 schema）。
- **L2 路由**（D-4）：schema 优先、reduce 兜底——有 schema 且结果走 L3；L3 失败/超预算回落 L1 reduce。
- **L3 schema 入口（3 个）**：`execute_cli`（dual + `admitL3` stdout≤8K）、`run_checks`（dual）、`subagent_status.result` L3-if-small 例外（仅 completed + 自由文本 + ≤24K，D-13 旁挂，`result` 字段原文不动）。git_status/git_diff/git_log/git_show 增补-04 豁免：无 schema → L3 永不进入，仅 L1 去噪。

失败语义（D11/D17）：reducer/cap 失败 → 原样 passthrough（reason 记审计 `reducer-threw`/`cap-threw`）；整形审计（raw+shaped+reason）只进审计链、绝不进模型上下文；成功结果无任何层标记。错误双帽（D12）：`error.message`≤2000、`error.details`≤6000（env 旋钮 `MYTERMINAL_ERROR_MESSAGE_MAX_CHARS`/`MYTERMINAL_ERROR_DETAILS_MAX_CHARS` 优先，默认 2000/6000；'0' 合法 → 帽为 0 信息全清）；`continuation` 子键原样保全。task_poll 递归（D13）：`operation.data.result` 递归整形 + `operation.error` 双帽，保全 `operation.ok`/`data.tool`；Q7 嵌套预算门、Q6 整层回退、Q8 按 (taskId + operation 内容哈希) 缓存（`clearOperationCache(taskId?)`）——预填（#106 `seedOperationCache`）哈希 shaped 内容、D13 递归哈希 poll 侧 raw operation，两者同公式保证命中。预算门（D6）：`estimateTokens`（中文×1.5/英文÷4）+ `RAW_BUDGET_TOKENS=24000`，门槛 = min(24000, L3 ctx − 2048)；L3 每会话配额 50（`l3MaxPerSession`）；超限 fail-open 回 L1。

##### [src/l3/](./src/l3/) — L3 本地模型层（7 文件）
`adapter.ts`（L3 适配接口）/ `engine.ts`（字段白名单 + 值存在性 `applyQ5`，失败矩阵 q5-rejected/l3-parse-error 零重试）/ `llama-adapter.ts`（真模型：Qwen3.5-2B GGUF，non-thinking/GBNF）/ `registry.ts`（`getL3Adapter`/`resetL3Adapter` 单例懒加载 + ctx 回标；`l3Enabled()`：`MYTERMINAL_L3_ENABLED` env 优先，未设置 → standalone 开 / cluster 参与者关）/ `warmup.ts`（`startL3Warmup` 异步预热 + smoke probe，`MYTERMINAL_L3_WARMUP=false` 关闭）/ `prompt.ts`（L3 系统提示词）/ `model-fetch.ts`（`l3-model fetch` sha256 钉死；`MYTERMINAL_L3_MODEL_PATH` 覆盖路径，未设置 → 安装根 models 目录 > 裸文件名）。

---

### 6. 关键类与函数说明

#### 6.1 域模型（types.ts）

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
interface SubagentSettings { enabled, model, baseUrl, apiKey, maxTurns, timeoutSec, maxParallel, contextWindow, maxOutput, compactThreshold, fallbackModel? }
interface ToolDefinition { name, title, description, inputSchema, annotations, aliases?, invoke(input, context) }
```

#### 6.2 运行时核心类

##### `MyTerminalRuntime`（[server.ts](./src/server.ts)）
组合根。构造时初始化 store/extensions/mcp/subagent runner。关键方法：`start()`、`tryBecomeLeader()`、`revalidateAfterResume(reason)`、`close()`→`closeOnce()`、`configureRoutes()`、`createClusterGateway()`、`log()`/`logAuditEvent()`、`passiveLockStatus()`、`appsUrl`/`openApiUrl`/`port`。

##### `ExtensionService`（[extensions.ts](./src/extensions.ts)）
门面核心。方法：`discover`/`register`/`call`/`callSubagent`/`registerFromTui`/`mcpSessionClosed`/`shutdown`。内部：`authenticate`、`withAudit`、`decorateContinuation`、`assertContinuation`、`invokeTool`、`pollBackgroundTask`、`trimBackgroundTasks`。

##### `MyTerminalStore`（[store.ts](./src/store.ts)）
域状态持久化。方法：`registerRoot`/`registerDelegate`/`inherit`/`release`/`checkpoint`/`unregister`/`tag`/`subscribe`/`eventsAck`、`sendMessage`/`messageInbox`/`messageList`/`messageConversation`、`context`/`history`、`pendingEvents`/`emitEvent`、`upsertExtension`/`removeExtension`/`listExtensions`、`expectedContinuationCall`/`completeContinuationCall`/`activateHarnessContract`、`bindApp`/`bindMcp`/`unbindMcp`、`revision`。

##### `PortClusterRegistry`（[cluster.ts](./src/cluster.ts)）
`register`/`heartbeat`/`setLeader`/`unregister`/`ensureRegistered`/`prune`。`ClusterMember`：id/pid/appVersion/protocolVersion/workspaceId/internalPort/connectorKey/actionsTokenHash/secret/heartbeatAt。

##### `ClusterExtensionRouter`（[cluster-router.ts](./src/cluster-router.ts)）
`implements ExtensionFacade`。`discover`/`register`/`call`/`mcpSessionClosed`、`routeBySession`、`boundMember`。

#### 6.3 内置工具集（core-tools.ts）

| 分组 | 工具 |
|---|---|
| 工作区文件 | `workspace_info` `list_dir` `find_files` `search_text` `read_file` `read_file_range` `write_file` `apply_patch` |
| Blob | `blob_create`（sha256 内容寻址，`flag:'wx'` 幂等，1MB 上限）`blob_read` `blob_write_file`（`flag:'wx'` 不覆盖，同 sha256 幂等成功，不同拒绝） |
| 命令/Git | `execute_cli` `git_status` `git_diff` `git_log` `git_show` `run_checks` |
| 会话 | `session_register` `session_inherit` `session_list` `session_checkpoint` `session_context` `session_history` `session_release` `session_unregister` `session_tag` `session_subscribe` `session_events_ack` |
| 消息 | `message_send` `message_inbox` `message_list` `message_conversation` |
| Skill | `skill` |
| Subagent | `subagent_start` `subagent_status` `subagent_abort` |
| 后台 | `task_poll` |

36 个内置工具（34 处 add，其中 git 循环展开 `git_status`/`git_diff`/`git_log` 3 个）。工具结果统一经 `applyShape` 整形出口（§5.9）：`execute_cli`/`run_checks` 走 L3 schema（stdout≤8K 才 admit）；git_* 四工具增补-04 豁免仅 L1 去噪；其余走 L1 reduce。

#### 6.4 Skill 系统（skills.ts）

```typescript
type SkillMode = 'inline' | 'fork';
interface SkillManifest { name, description, when_to_use, mode, forkOptions? }
interface SkillForkOptions { maxTurns?, timeoutSec?, readOnly? }
// listSkills() / loadSkill(name) / parseFrontmatter / validateSkillManifest
```

- 无参 `skill()`：返回 manifest 列表（不含 content），不需 identity。
- inline：`{name, description, mode:'inline', content}`，不需 identity。
- fork：需 identity；递归防护；`getSubagentRunner().start(parentSessionId, {objective, background, ...forkOptions}, {type:'skill', skillName})`；返回 `{mode:'fork', taskId, sessionId, status:'running'}`。

#### 6.5 Subagent 系统（src/subagent）

##### 接入层 — [runner.ts](./src/subagent/runner.ts)
`createSubagentRunner(deps)` 返回 `{start, status, abort, listSubagents}`。

- **start**：并发检查 → `assembleTask`/`toTaskPackage` → `registerAndClaimChild` → `createSubagent` → IIFE 后台执行 `runSubagentImpl` → 立即返回 `{sessionId, taskId, status:'running'}` → `finalize`（checkpoint + notify + store 更新）。
- **status**：`getSubagent` → 幂等返回 `{status, sessionId, tasks, usage, error, result?（仅 completed 回填）, origin}`（ADR-0048 D11：auditLogs 已从 status 返回体移除，流水账走 store 层直查）。
- **abort**：已终态幂等返回；否则 `abortController.abort()` → `{status:'aborting'}`。

##### 执行核心 — [executor.ts](./src/subagent/executor.ts)
`runSubagent(options): Promise<SubagentRunResult>` 主循环。

- 三层 compact：`microCompact`（零成本，保留最近 5 个 tool_result，更早的替换为占位）→ `autoCompact`（调 LLM 摘要，`MAX_COMPACT_FAILURES=3` 熔断）→ `normalizeMessages`。
- `AbortSignal.any([abortController.signal, timeoutSignal])`；`collectStream`（含 Circuit Breaker）→ 决策 24 content 退出检测 → `executeToolCalls` → 追加 tool_result。
- `finally`：`sessionResourceManager.disposeAgent(agentId)`。三态完成函数 `finishCompleted`/`finishFailed`/`finishAborted`。
- `getSubagentSystemPrompt`：硬编码 system prompt（8 工具集 + 会话/交付物/退出语义 + D12 fail-fast 纪律：干不了立即置 blocked + 最终报告 ≤2000 tokens 报告帽 + 三处零成本加固）。

##### 工具层 — [tools.ts](./src/subagent/tools.ts) / [tool-executor.ts](./src/subagent/tool-executor.ts)

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
| `task_update` | true | true | 状态机更新（pending/in_progress→blocked 允许、blocked→completed 允许、blocked→in_progress 禁止；blocked 必填 blockedReason≤1000） |

- `buildTool(config)` 工厂；`toolRegistry: Map`；`getTool`/`getAllToolSchemas`/`getToolNames({readOnly})`。
- `resolvePath`：cwd 限制 + ADR-0015 realpath 防 symlink 逃逸。
- `tool-executor.ts`：`validateSchema`（4 类校验）、`partitionToolCalls`（按并发安全分批，MAX_PARALLEL=5）、`executeSingleTool`（未知工具→readOnly 门禁→schema→validateInput→checkPermissions→hooks→执行→审计）、`executeToolCalls`（并行批次 sibling abort，串行批次写失败链中断）。

##### LLM 适配 — [llm-adapter.ts](./src/subagent/llm-adapter.ts)
- `interface LlmAdapter { provider; stream(params, signal); create(params, signal) }`。
- 单协议适配：`AnthropicAdapter`（content_block 事件路由 + cache_read_input_tokens），`baseUrl` 可配，指向任意 Anthropic Messages 兼容端点。
- `createAdapter(settings)` 工厂（单一 Anthropic 协议；apiKey/baseUrl/model 三必填缺失抛错：`Subagent apiKey, baseUrl and model are required. Provide them in the MyTerminal config file (subagent.apiKey / subagent.baseUrl / subagent.model).`；遗留 provider 字段静默忽略）。
- `normalizeMessages`（合并同 role + 孤儿 tool_use 补 interrupted tool_result）、`assembleMessage`（组装单源 #66）、`collectStream`（流式累积 + 中途失败回退非流式防双重执行）。
- `ReliabilityAdapter` 装饰器（watchdog 空闲 60s/总超时）+ `withReliability` 工厂；`LlmError`（kind: rate_limit/server_overload/auth/prompt_too_long/connection/system）。
- `resilience-policy.ts`：`CircuitBreaker`（closed/open/half-open，5 次失败熔断 30s）+ `ResiliencePolicy.decideOnFailure`（rate_limit 指数退避、server_overload 3 次降级 fallbackModel、prompt_too_long 触发 compact）。

##### 隔离 — [context.ts](./src/subagent/context.ts)
`SubagentContext` 收敛 6 项模块级全局单例：`subagents`（记录表）/`readFileStates`（读后写）/`agentShellTasks`（shell 子进程）/`replacementDecisions`（结果预算替换决策）/`events`（AG-UI 事件总线）/`runner`（装配实例）。每个 subagent 通过可注入 ctx 获得与主会话隔离的状态；生产用 `defaultContext`，单测用 `createSubagentContext()` 创建隔离实例。

##### 权限 — [permissions.ts](./src/subagent/permissions.ts)
`checkCommandSafety(command, readOnly)`：解释器壳递归 → 完整 DANGEROUS → 子命令逐段 → 命令替换检测 → 全 SAFE 快道 → readOnly 决策。`splitCommands`（状态机拆分）、`hasCommandSubstitution`、`isCommandConcurrencySafe`、`interpretExitCode`（grep/rg/find/test 语义）。

##### 状态/辅助
- [store.ts](./src/subagent/store.ts)：内存 Map，`createSubagent`/`updateSubagentStatus`（1h 清理定时器）/`addAuditLog`（截断+保留 50）/`countRunning`/`listAllSubagents`。
- [file-state.ts](./src/subagent/file-state.ts)：`recordFileRead`/`validateEdit`（0 匹配附预览，>1 非 replaceAll 报错）/`applyEdit`。
- [shell-tracker.ts](./src/subagent/shell-tracker.ts)：`trackShellTask`/`cleanupAgentShellTasks`（杀进程组，2s SIGKILL 兜底）。
- [result-budget.ts](./src/subagent/result-budget.ts)：`truncateResult`（MAX 50K）/`enforceMessageBudget`（200K 预算，超限按长度降序压成预览并冻结）/`ensureNonEmpty`。
- [token-counter.ts](./src/subagent/token-counter.ts)：`estimateTokens`/`estimateMessageTokens`。
- [cost-tracker.ts](./src/subagent/cost-tracker.ts)：`CostTracker` 纯 token 累加器（`addUsage`/`getUsage`；input/output/cacheRead tokens，无任何定价/USD——ADR-0046 D1 已移除成本概念）。
- [grep-utils.ts](./src/subagent/grep-utils.ts)：`includePatternToRegex`/`matchInFiles`（IO 解耦）/`createGrep`。
- [tui-bridge.ts](./src/subagent/tui-bridge.ts)：`subagentEvents` EventEmitter + 14 种 AG-UI 事件 + `emitAgUi`。
- [context.ts](./src/subagent/context.ts)：`SubagentContext`（收敛 6 项）+ `createSubagentContext`/`defaultContext`。

#### 6.6 TUI 系统（src/tui）

##### 整体架构
- [index.tsx](./src/tui/index.tsx)：渲染入口。`runSetupTui`/`runWorkspaceChooserTui`/`runChoiceTui`/`class MyTerminalTui`（`run()` 创建 controller + 挂载 `<App>`）；`createRenderer`/`renderWithKeymap`。
- [App.tsx](./src/tui/App.tsx)：核心组件。双速 tick（150ms 比对 `renderRevision()` 触发 refresh，1s `tickReminders`）；Ask 表单机制；`handleInputSubmit`→`routeCommand`；五层键盘路由；子代理审查队列 2s 轮询。
- [state.ts](./src/tui/state.ts)：`TABS`（9 页签）、`class TuiController`（`snapshot`/`renderRevision`/`refreshDiff`/`createSession`/`sessionAction`/`sendMessage`/`editSettings`/`rotateCredentials`/`shutdown` 等）、`phaseColor`/`presenceColor`/`hiddenAppsUrl`。
- [contracts.ts](./src/tui/contracts.ts)：`Detail`/`FormQuestion`/`Ask`/`RuntimeReconfigure` 类型。
- [controller-logic.ts](./src/tui/controller-logic.ts)：纯函数层。`parseSelectedFields`/`buildSettingsQuestions`/`resolveSettingsAnswers`/`buildChildTaskPackage`/`sessionActionOptions`，`SETTINGS_FIELDS` 11 字段注册表。

##### 九页签屏幕（screens/）
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

##### 组件（components/）
`InputBar`（Normal/Editing 双模式，priority 350）、`MessageBubble`、`ToolCallRow`（惰性 stringify）、`FormDialog`（声明式多步表单引擎，priority 400）、`Modal`、`HelpOverlay`（priority 300）、`Mascot`（9 字符宽 ASCII，5 种 mood，独立眨眼定时器）、`BlinkingDot`；`chrome/`：`TopBar`（`processTopology`）、`BottomNav`（9 pill）、`StatusLine`（`hints`）。

##### 模型层（model/）
全部纯函数：`command-router.ts`（`routeCommand`/`commandCompletions`/`COMMANDS`）、`diff-groups.ts`（`groupDiffLines`）、`history-entry.ts`（`viewForHistoryEntry` 11 种类型）、`mascot-mood.ts`（`mascotMoodFor`）、`relative-time.ts`（`relativeTime`）、`timeline-merge.ts`（`mergeActivity`/`memoizedMergeActivity` 单槽 memoize）。

##### Hooks（hooks/）
`useInputHistory`（push/prev/next，会话内不落盘）、`useMascotMood`（从 snapshot 推导）、`useTimelineModel`（`memoizedMergeActivity`，audits 作 thunk 延迟取数）。

##### i18n（copy/）
`i18n.ts`（`i18nFor` 记忆化冻结实例，`I18n`/`Translate`）、`context.tsx`（`I18nProvider`/`useI18n`，缺 Provider 抛 `DevInvariantError`）、`types.ts`（`Copy`/`EmptyStateKey`）、`en.ts`/`zh-CN.ts`（双语字典）、`index.ts`（`copyFor`/`greetingFor`/`verbFor`/`verbLabel`）。三处语言入口收敛到 `i18nFor`。

##### 主题（theme/）
`types.ts`（`Theme` 16 角色：基础 12 + user/agent/tool/system）、`palette.ts`（`WARM_DARK`/`WARM_LIGHT`，`paletteFor`）、`index.ts`（`themeFor`）。对比度目标正文 ≥7:1，muted ≥4.5:1。

##### 其他根文件
`host-io.ts`（`copyToHostClipboard`/`playAttentionSound`/`notifySystem` 跨平台 spawn）、`keymap.ts`（`useAppKeymap` 三层优先级 300/200/100 + `buildNumberTabBindings`）、`renderer-profile.ts`（`rendererProfile`，win32 20fps main-screen 兼容）、`status-color.ts`（`statusToVisual` 单源，`StatusTone`）、`credential-visibility.ts`（`nextCredentialVisibility` 处理 key-up 不可靠）、`form-model.ts`（`initialQuestionState`/`toggleSelectedOption`/`optionAnswer`/`nextTextValue`/`workspaceChoiceQuestion`）、`workspace-selector.ts`（`buildWorkspaceSelectorModel`）。

---

### 7. 核心数据流

#### 7.1 Actions/Apps 调用流

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
        ├─ applyShape                 // 工具结果整形统一出口（§5.9：L1/L2/L3 路由，subagent 通道 D2 豁免）
        ├─ decorateContinuation       // 附加 continuation{mustContinue,nextCall}
        └─ attachEvents               // 最多 5 条未确认事件
                │
                ▼
   MyTerminalStore  ──> state.json + history/<sessionId>.jsonl
```

#### 7.2 会话生命周期

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

#### 7.3 Subagent 执行流

```text
subagent_start ──> runner.start
   1. countRunning >= maxParallel? → FORBIDDEN
   2. registerAndClaimChild(parentSessionId, task)
   3. createSubagent + IIFE 后台执行
   4. runSubagent(主循环):
        microCompact → (超阈值? autoCompact) → normalizeMessages
        → collectStream (Circuit Breaker + watchdog)
        → 决策24 content 退出? → executeToolCalls (分批并行/串行)
        → 追加 tool_result → 下一轮
   5. finalize: checkpoint + message_send(通知父) + store 更新
subagent_status ──> 幂等读 + 终态 result 回填
subagent_abort  ──> abortController.abort() → finishAborted
```

#### 7.4 TUI 渲染流

```text
150ms fast tick ──> controller.renderRevision() 比对
   (store.revision + runtimeLog.revision + diff.revision + update + health phase)
   变化? ──> refresh() ──> controller.snapshot() ──> App 重渲染
1s slow tick ──> controller.tickReminders()
键盘 ──> 五层优先级: form(400) > input-editing(350) > detail-esc(300) > page(200) > global(100)
```

#### 7.5 集群路由流

```text
公网请求 ──> leader 进程 createClusterGateway
   ──> ClusterExtensionRouter.call
        ├─ 有 identity: routeBySession(sessionId) 遍历成员 /cluster/rpc/call
        └─ 无 identity: boundMember(clientSessionKey) / workspaceId / 兜底
   ──> 归属成员 internalPort ──> 本地 ExtensionService.call
```

---

### 8. 依赖关系

#### 8.1 模块依赖图（核心层）

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

#### 8.2 Subagent 内部依赖

```text
runner.ts (接入层)
  ├─ store.ts, context.ts, executor.ts(runSubagentImpl 类型), tools.ts
  └─ ../store.ts, ../types.ts
executor.ts (执行核心)
  ├─ llm-adapter.ts, resilience-policy.ts, token-counter.ts, cost-tracker.ts
  ├─ store.ts, file-state.ts, tool-executor.ts, tools.ts, tui-bridge.ts
  └─ ../session-resource-manager.ts
tool-executor.ts ── tools.ts, store.ts, result-budget.ts
tools.ts ── file-state.ts, shell-tracker.ts, permissions.ts, result-budget.ts, store.ts, grep-utils.ts, ../utils/fs.ts, ../redact.ts
llm-adapter.ts ── token-counter.ts, ../types.ts
cost-tracker.ts / token-counter.ts ── ../types.ts
context.ts ── store.ts, runner.ts (类型)
```

#### 8.3 外部依赖

```text
@modelcontextprotocol/sdk ── mcp.ts (McpServer + StreamableHTTPServerTransport)
@opentui/{core,keymap,react} ── tui/* (渲染 + 键位)
express ── server.ts (HTTP)
react ── tui/* (组件树)
zod ── mcp.ts, mcp-schema.ts (运行期校验)
```

#### 8.4 单源纪律（禁止他处手抄）

- `tool-schemas.ts`：工具输入形状（core-tools + mcp + discover 三处共用）
- `types.ts:SubagentSettings`：subagent 配置字段（单一 Anthropic 入口，无 provider 枚举）
- `redact.ts`：脱敏
- `lock-thresholds.ts`：锁阈值 `LOCK_STALE_THRESHOLD_MS = 30_000`
- `l3/registry.ts`：L3 适配器单例（`getL3Adapter`/`resetL3Adapter`）
- `mcp-schema.ts`：JSON Schema→zod 派生
- `status-color.ts`：TUI 状态→颜色
- `llm-adapter.ts:assembleMessage`：消息组装

---

### 9. 项目运行方式

#### 9.1 环境要求

- **Bun ≥ 1.3**（CI 固定 `1.3.14`）
- 支持 macOS / Linux / Windows（Windows TUI 默认键盘兼容模式，鼠标捕获默认关闭）

#### 9.2 从源码开发

```bash
git clone https://github.com/epslkslsksndnsjs-lab/myterminal.git
cd myterminal
bun install --frozen-lockfile
bun run dev          # 启动 TUI（含首启设置）
```

#### 9.3 npm scripts（package.json）

| 脚本 | 命令 | 用途 |
|---|---|---|
| `build` | `bunx tsc -p tsconfig.json` | 类型检查 + 输出 dist |
| `build:binary` | `bun build --compile --minify src/cli.ts --outfile release/myterminal` | 单文件可执行 |
| `dev` | `bun run src/cli.ts` | 开发模式启动 TUI |
| `start` | `bun run dist/cli.js` | 启动构建产物 |
| `test` | `bun run build && bun test --timeout 120000 test/*.test.mjs` | 构建后跑全部测试 |
| `perf:regression` | `bun run build && bun scripts/performance-regression.mjs` | 性能回归 |
| `typecheck` | `bunx tsc --noEmit -p tsconfig.json` | 仅类型检查 |

#### 9.4 CLI 参数（cli.ts）

```text
myterminal                  # 启动 TUI
myterminal --headless       # headless 模式（需先完成 TUI 设置）
myterminal --version / -v
myterminal --help / -h
myterminal --verify-installation          # 校验运行时资源
myterminal l3-model fetch                 # 下载 L3 本地模型（sha256 钉死，幂等；stateless，先于 settings/runtime）
```

#### 9.5 环境变量覆盖（仅自动化/headless）

`MYTERMINAL_WORKSPACE_DIR`、`MYTERMINAL_HOST`、`MYTERMINAL_PORT`、`MYTERMINAL_PUBLIC_BASE_URL`、`MYTERMINAL_ACTIONS_TOKEN`、`MYTERMINAL_CONNECTOR_KEY`、`MYTERMINAL_MAX_OUTPUT_CHARS`、`MYTERMINAL_COMMAND_TIMEOUT_SEC`。非 headless 模式这些变量会被删除，避免误覆盖 TUI 设置。

L3 与错误帽开关不受上述删除影响（非 headless 下保留）：`MYTERMINAL_L3_ENABLED`（未设置 → standalone 开 / cluster 参与者关）、`MYTERMINAL_L3_MODEL_PATH`（覆盖 L3 模型路径）、`MYTERMINAL_L3_WARMUP`（默认开，`false` 关闭预热；测试进程默认 `false`，见 §9.7 测试全局 L3 隔离）、`MYTERMINAL_ERROR_MESSAGE_MAX_CHARS` / `MYTERMINAL_ERROR_DETAILS_MAX_CHARS`（错误双帽，默认 2000/6000）。

#### 9.6 连接端点

| 连接 | 用途 | 端点 |
|---|---|---|
| GPT Actions | 自定义 GPT + OpenAPI Action | `https://YOUR-HOST/openapi.json` |
| ChatGPT Apps | MCP connector | `https://YOUR-HOST/mcp/<hidden-connector-key>` |

Actions facade 三操作：`extension_discover`/`extension_call`/`extension_register`（camelCase: `extensionDiscover`/`extensionCall`/`extensionRegister`）。Apps 同时暴露 facade + 约 30 个 direct tool + blob 暂存。

#### 9.7 测试

```bash
bun run test                # 构建后跑 test/*.test.mjs（超时 120s）
```

测试覆盖：OpenAPI 3.1、Actions/Apps identity、controller 接管、checkpoint 时机、parent/child 完成、事件 ACK、订阅、持久历史、脱敏、迁移、删除、续执行、OpenTUI 滚动与拖选、subagent M1-M8、tool-parse 整形（L1/L2/L3 路由、D7 双版本审计、D12 错误双帽、D13 task_poll 递归、D16.3 聚合字段）、skill v1/v2、redaction、错误码、安全边角等。

测试全局 L3 隔离（增补-13 #112）：`bunfig.toml` 的 `[test] preload` 加载 `test/setup.ts`，测试 worker 启动时注入 `MYTERMINAL_L3_WARMUP=false`（预热 smoke probe 全局默认关）与 `MYTERMINAL_L3_MODEL_PATH=<不存在路径>`（直接加载路径——runL3 只查 `l3Enabled()`、不查预热旋钮——的 `loadModel` 恒快速失败；warmup 的 modelFileMissing 早退同样拦截）。主仓库 `models/` 存在真实模型时全量测试仍零 gguf 加载（历史炸点：RSS 20GB+、卡死 23 分钟）。需要预热语义的测试（W208/W303/issue-111 等）在文件顶部显式 `delete process.env.MYTERMINAL_L3_WARMUP` 或 withEnv 覆盖该 env，恢复默认开分支，覆盖能力原样保留（共享 worker 下该 delete 会泄漏给同 worker 后续文件——无害：MODEL_PATH 钉死无人删除，预热开时仍 zero-load）。回归锁：`test/issue-112-test-warmup-isolation.test.mjs`。

#### 9.8 CI（.github/workflows/ci.yaml）

矩阵 `macos-latest / windows-latest / ubuntu-latest`，`fail-fast: false`，30 分钟超时。步骤：
1. `bun install --frozen-lockfile`
2. `bun run typecheck` → `bun run build` → `bun test --timeout 300000 test/*.test.mjs`
3. Skill provider 同步校验 + self-test
4. `bun audit`
5. Unix/Windows installer 构建与演练（含 incomplete 目录恢复测试）

#### 9.9 安装脚本

- `scripts/install-macos.sh` / `scripts/install-linux.sh` / `scripts/install-windows.ps1`：下载平台预编译二进制、校验 SHA-256、注册全局 `myterminal` 命令、启动 TUI。
- `scripts/mac-one-shot-awake-lock.swift` / `mac-arm-one-shot-lock.ts`：macOS 被动锁 helper。

#### 9.10 更新

TUI 启动时检查 GitHub release；Settings 页按 `U` 安装。更新器下载预编译可执行 + SHA-256，装入新版本目录，原子切换 `current` 指针，旧版本保留回滚。`update-transaction.ts` 提供事务化 snapshot→install→migrate→restart→recovery，失败自动 rollback。Git 源码检出绝不被一键更新覆盖。

---

### 10. 关键不变量与工程约束

#### 10.1 架构不变量（docs/architecture.md）

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
13. 工具结果整形失败 fail-open（D17/D11）：reducer/cap 失败原样 passthrough（reason 只进审计），整形审计绝不进模型上下文。
14. L3 本地模型按部署形态启用（D18.2）：standalone 默认开、cluster 参与者默认关，`MYTERMINAL_L3_ENABLED` 可显式覆盖。

#### 10.2 安全约束（见本文件 §3 开发约束）

- 所有工具操作限制在用户选定工作区内（读写安全边界）。
- 连接凭据存于 OS 用户配置目录。
- 仅持久化 session-token 哈希。
- 敏感字段从持久化审计日志脱敏。
- 生产环境 bind 地址保持 `127.0.0.1`。

#### 10.3 会话模型约束

- root 创建工作上下文，可委派直属子会话。
- 子会话不可创建孙会话。
- 已完成会话不可变；续作经 `session_register(continuesSessionId)`，非 `session_inherit`。

#### 10.4 工程约定（来自项目记忆）

- Subagent 超时不自动重试，需人工干预。
- `readOnly:true` 的 subagent 缺少 `write_file`/`execute_cli` 等写工具。
- `retryable:false` 错误（DUPLICATE_SESSION/SESSION_ALREADY_CLAIMED/INVALID_INPUT）不自动重试。
- 限流（429）重试：30s→60s→blocked+通知；网络错误：5s→10s→20s→blocked+通知。
- Subagent 在非 TTY 环境执行交互式 CLI 会超时；用非交互校验。
- LLM 处理超长 `execute_cli`/`grep` 输出（>3000 字符）易卡顿；成功任务通常输出 <2000 字符或低 maxTurns。

#### 10.5 变更指导

新行为必须放在控制其生命周期的所有权层。UI 组件应渲染视图模型而非重建域状态。全局资源需全局所有权检查；工作区资源需工作区身份；会话资源需会话身份。每个新进程、定时器、文件锁、凭据显露路径都需要显式的创建、超时与清理规则。

---

### 附：关键文档索引

| 文档 | 路径 |
|---|---|
| 架构与所有权 | [docs/architecture.md](./docs/architecture.md) |
| Actions 配置 | docs/ACTIONS_SETUP.md（中文 .zh-CN.md） |
| GPT 预置指令 | docs/GPT_INSTRUCTIONS.md |
| 场景 prompt | docs/PROMPT_PLAYBOOK.md |
| 隐私与部署 | docs/PRIVACY.md |
| 手动/离线安装 | docs/MANUAL_INSTALL.md |
| Subagent LLM 配置 | docs/SUBAGENT_SETUP.md |
| AI 编码规则 | 见本文件 §2 |
| 开发约束 | 见本文件 §3 |
| 贡献指南 | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| 安全披露 | [SECURITY.md](./SECURITY.md) |

---

## 11. ADR-0047 T16 — 回归 + 文档同步汇总报告（票 #42，2026-08-15）

- 基线：`wk-a4 @ 3105dc3`（ADR-0051 全 29 票整合 HEAD）
- 性质：全量交付基线（T01–T15 收口验证 + 文档同步 + ADR 待实施清单核对 + D1–D18 落地报告）
- 验收标准 5（用户端到端基线对比）由 #96 承接，本报告仅留链接位（见遗留项）

### 一、验证结果（验收标准 1）

| 门 | 命令 | 结果 |
|---|---|---|
| 全量测试 | `bun run build && bun test --timeout 120000 test/*.test.mjs` | **1184 pass / 0 fail**（103 文件，58.51s） |
| 性能回归门 | `PERF_GATE_BLOCK=1 bun scripts/compare-perf.mjs`（median of 5） | **全 8 指标 PASS**，无回退 |
| AC8 专项 | `bun test test/issue-102-observe-messages-perf.test.mjs` | **4 pass / 0 fail**（AC1 语义 + AC2 redact 单次 <500ms） |

性能门指标（`PERF_GATE_BLOCK=1 bun scripts/compare-perf.mjs`，median of 5 样本、机器相关，复跑 ±10% 波动；当前 vs `scripts/perf-baseline.json`）：

| 指标 | 基线 | 当前 | Δ |
|---|---|---|---|
| history.elapsedMs | 329.1 | 163.2 | **−50.4%** |
| inbox.elapsedMs | 225.7 | 132.4 | **−41.3%** |
| inbox.rssDeltaBytes（内存，informational） | 27.2 MB | 25.1 MB | −7.6% |
| tui.snapshotMs | 2.01 | 1.06 | −47.5% |
| issue63.context.firstMs | 146.6 | 17.3 | −88.2% |
| issue63.context.repeat50Ms | 32.5 | 16.9 | −47.9% |
| issue63.microCompact.elapsedMs | 1.57 | 1.15 | −26.5% |
| issue63.timeline.elapsedMs | 0.17 | 0.09 | −48.3% |

### 二、D1–D18 落地状态核对（验收标准 4；证据 = 3105dc3 实读源码）

| 决策 | 内容 | 状态 | 落地证据 |
|---|---|---|---|
| D1 | 结果脏乱嵌套度路由，L1/L2/L3 三层 | ✅ | `tool-parse.ts` `resolveShape`（内联 shapeResult → 中心表 → passthrough）+ 20 函数 |
| D2 | 主模型双通道覆盖（subagent 内部不整形） | ✅ | `extensions.ts` `applyShape` 接 actions/MCP 出口；subagent 内部上下文不整形 |
| D2.1 | `subagent_status.result` L3-if-small 例外 | ✅ | `isSubagentCompletedResult`（仅 completed + 自由文本 + ≤24K）；W2-07(#90) D-13 旁挂式升级 |
| D3 | 注册时静态声明 | ✅ | `TOOL_SHAPES` 中心表 16 条；运行时只查表（D3→D18.1 模式无关升级） |
| D4 | 网页端 L3 放行 | ✅（代码） | L3 不按通道禁用；transport 感知超时 actions≤8s；**45s 实测归 #96** |
| D5 | 中心表为主 + 可选内联 | ✅ | 16 条注册；`resolveShape` 第一级读内联 `shapeResult` |
| D6 | L3 三重护栏 | ✅ | `l3TimeoutMs`（actions 8s/其他 20s）/ `estimateTokens`+`RAW_BUDGET_TOKENS=min(24000, ctx−2048)`（P2-01 #97 运行时化）/ `l3MaxPerSession`=50（engine.ts） |
| D7 | 双版本审计 | ✅ | `ctx.audit({rawResult, shapedResult, shaping})`；`withAudit`→`finishAudit`；W1-09(#82) `stripAuditRawFields` 剥模型可见通道 |
| D8 | 本地小模型设施 | ✅ | `src/l3/adapter.ts` + `llama-adapter.ts` + `registry.ts` + node-llama-cpp 依赖 |
| D8.2 | 单例懒加载 + 上下文隔离 | ✅ | `getL3Adapter`/`resetL3Adapter` 单例（registry.ts） |
| D8.3 | 模型选型硬约束 | ✅ | T12 真模型探测：Qwen3.5-2B max ctx=256K 回标；non-thinking/GBNF 由 llama-adapter 满足 |
| D8.4 | prompt 模板 + 失败矩阵 | ✅ | `prompt.ts` `buildInstruction` + `engine.ts` `applyQ5`（字段白名单 + 值存在性） |
| D9 | 只改 `data.result` | ✅ | shaper 只动 result；events/error/ok 原样；MCP `events`（checkpoint_due/CHECKPOINT_REQUIRED）透传 |
| D10 | 中心表主注册表（非回退） | ✅ | 同 D5 |
| D11 | 失败静默 passthrough + 仅审计 | ✅ | `shaping.reason`（reducer-threw/over-budget/quota/passthrough…）只进审计；全失败矩阵 fail-open |
| D12 | 错误长度帽（message+details 双帽） | ✅ | `capError`/`capErrorResponse`（2000/6000）；P2-02(#98) env 旋钮 `MYTERMINAL_ERROR_MESSAGE_MAX_CHARS`/`MYTERMINAL_ERROR_DETAILS_MAX_CHARS`；`continuation` 子键保全（Q4 双分支） |
| D13 | task_poll 递归 + continuation 保全 | ✅ | `isNestedOperation` 递归 `operation.data.result` + `operation.error`；保全 `operation.ok`/`data.tool`；Q6 整体回退 / Q7 嵌套预算门 / Q8 身份缓存（operationCache） |
| D14 | L3 面向脏乱嵌套（≤24K） | ✅ | 预算门内小脏数据走 L3；超门 fail-open 回 L1（L2 悖论落地，D-4 兜底） |
| D15 | 主动精简 reducer | ✅ | `reduceSessionList`/`reduceSessionHistory`/`reduceMessageConversation` 等（摘要替换 + count/分页）；`read_file_range` handler 流式截断（0051 D-16 A6 豁免登记） |
| D16 | 派生字段标准化（count/totalCount） | ✅ | `applyCountRule` 强制 count/totalCount；D16.3 聚合 opt-in（P2-03 #99：search_text fileCount/uniqueFiles、git_log commitCount） |
| D17 | 跨层统一静默 | ✅ | 无 `_shapedBy` 等层标记；诚实性只经 count/totalCount/continuation 原生字段 |
| D18 | 运行时模式正交（mode-agnostic/多进程/MCP） | ✅ | 不读模式标志；cluster 参与者 L3 默认关（`setL3ClusterMode`，0051 D-6）；MCP 自有工具完整 L1/L2/L3 + `isPointerResult`（T13） |

**0051 修订决策核验**（全部 29 票整合 @3105dc3，1184/0）：

- D-4 路由裁决（schema 优先、reduce 兜底）✅ `resolveShape` 双条目实现（L3 失败回落 L1 reduce）
- D-3 L3 名单 10→7 ✅ #103 增补-04：git_status/git_log/git_show 豁免回 L1（无 schema → L3 永不进入），git_diff 先例
- D-11 schema 实际注册 3 份：`EXECUTE_CLI_SCHEMA`、`RUN_CHECKS_SCHEMA`、`SUBAGENT_STATUS_RESULT_SCHEMA`（git_* 三份随豁免不注册）
- D-12 git_show pathspec bug ✅ W2-04(#87) `core-tools.ts:472-476`：revision 移到 `--` 前，'-' 前缀例外逐字节保全
- D-13 subagent_status 旁挂式 ✅ 抽取挂 `data.result.extracted`，`result` 字段原文不动（0048 D11 铁律）
- D-7 分发 ✅ `l3ModelPath()` 链：env > 安装根 models 目录 > 裸文件名；`myterminal l3-model fetch`（sha256 钉死，幂等）
- D-8 可见性三通道 ✅ fetch 输出 + `/health` l3 字段（server.ts:131）+ 启动日志（warmup.ts:138 缺失提示指向 fetch）
- D-15 P2 三票全整合 ✅ #97（预算门运行时化）/ #98（D12 env 旋钮）/ #99（D16.3 聚合字段）

### 三、ADR-0047「待实施检查清单」逐项核对（验收标准 3）

已核对并**在 ADR 文档勾选**（docs/adr/0047，本地工作文档不入 git）：

- 开工前 7 项：**6 项 [x] + 1 项 [~]**——D4「K5 45s 实测」为唯一遗留（代码侧 transport 感知超时已兜底；45s 协同实测属用户端到端范畴 → #96）
- 补遗3 新增 4 项：**4 项全 [x]**（git_show/run_checks reducer、read_file_range 截断〔0051 D-16 A6 豁免登记〕、subagent_status L3-if-small〔D-13 旁挂式升级〕、真实键路径 reducer）

### 四、docs 一致性核对（验收标准 2）

逐段落核对 `docs/` 全部用户向文档（README[.zh-CN]、ACTIONS_SETUP[.zh-CN]、GPT_INSTRUCTIONS[.zh-CN]、MANUAL_INSTALL、PRIVACY[.zh-CN]、PROMPT_PLAYBOOK[.zh-CN]、SUBAGENT_SETUP[.zh-CN]、architecture.md）：

- **结论：无工具结果字段级形状描述**——文档描述的都是控制流（continuation/nextCall/checkpoint/task_poll `status=running`）与信封结构（subagent_status {status, tasks, usage, result} 等），整形（D9/D17）不碰控制流、信封键不变（D-13 只旁挂新增 `extracted`）→ 与整形后形状天然一致
- **修正 1（真实文档 bug）**：`docs/GPT_INSTRUCTIONS.zh-CN.md` subagent_status 信封字段 `cost` → `usage`（实现 `runner.ts:218` 为 `usage`，英文版正确）
- **修正 2（D-7/D-8 可见面同步）**：`docs/MANUAL_INSTALL.md` 补「可选：L3 本地模型」节（EN + 中文）——`myterminal l3-model fetch`（幂等/sha256 钉死）、启动日志提示、`MYTERMINAL_L3_ENABLED`/`MYTERMINAL_L3_MODEL_PATH` 旋钮语义（与 registry.ts 实现一致）
- 观察项（未改）：README/architecture 未记载 `/health` l3 字段与 L3 特性——非结果格式描述，超出本票修正范围；如需补记另行开票

### 五、遗留项（验收标准 5）

1. **用户端到端验收（基线对比）**：#96 承接（tool-returns/ 137 文件四窗对照）。对照表位置：TODO（调度窗回填 #96 对照表链接）
2. D4「K5 45s 实测」同上归 #96。

### 六、e2e 证据链接

| 票 | 测试文件（@3105dc3，整合基线） |
|---|---|
| T01 #29 | test/issue-29-shaping-skeleton.test.mjs |
| T02 #30 | test/issue-30-error-details-normalization.test.mjs |
| T03 #31 | test/issue-31-l2-engine.test.mjs |
| T04 #32 | test/issue-32-d12-error-caps.test.mjs |
| T05 #33 | test/issue-33-task-poll-recursion.test.mjs |
| T07 #35 | test/issue-35-session-list-trim.test.mjs |
| T08 #36 | test/issue-36-session-history-summary.test.mjs |
| T09 #37 | test/issue-37-l3-adapter-registry.test.mjs |
| T10 #38 | test/issue-38-l3-engine.test.mjs |
| T11 #45 | test/issue-45-subagent-status-l3.test.mjs |
| T13 #40 | test/issue-40-mcp-cluster.test.mjs |
| T14 #44 | test/issue-44-l3-prompt-failure-matrix.test.mjs |
| T12/T15 | 检查点/探测票（T12 真模型探测归 T15 检查点验收） |
| 0051 全 29 票 | 整合 HEAD `3105dc3`，全量 1184/0（逐票 hash 见 git log） |

### 七、结论

- 验收标准 1 ✅（1184/0 + 性能门 PASS + AC8 4/0）
- 验收标准 2 ✅（逐段核对：天然一致 + 2 处修正）
- 验收标准 3 ✅（ADR 清单逐项勾选，仅 D4 45s 实测遗留 → #96）
- 验收标准 4 ✅（本报告即汇总）
- 验收标准 5 ⏳（#96 承接，链接位 TODO）

## 12. ADR-0048 T5 — 完成信号两处微改造执行报告（票 #136，2026-08-16）

- 基线：`wk-136 @ 4d9ff45`（adr-0048-parent-child-handoff = main）
- 性质：D5 第四轮微改造两处 ≤10 字（红线：通信机制不改不删）——①subagent_status 文本块动态句 ②store 收工完成闸门
- 调度：调度3 派单（myterminal-34）→ 本窗（ghostty pid 35200）接单；MCP 查库结论已贴 #136 评论（5304210184）

### 一、改动文件（4 src + 1 测试）

| 文件 | 改动 |
|---|---|
| `src/mcp.ts` | registerDirect 加可选末参 `summaryFor?: (response) => string`（0044 N3 summary 函数化）；subagent_status 传 `(r) => r.data?.result?.status === 'completed' ? '子已完成，请验收' : '运行中'`；其余工具不传 → 默认 `${title} completed.` 逐字不变 |
| `src/subagent/store.ts` | SubagentRecord 补可选字段 `resultFetched?: boolean`（「已验收」标记，不破坏 #62 序列化）+ 导出 `markResultFetched(id)`（幂等置位） |
| `src/subagent/runner.ts` | `status()`：record 非 running 且未置位 → `markResultFetched`（父首次取终态结果即验收；failed/aborted 看过 error 即验收；幂等保留重复轮询） |
| `src/store.ts` | checkpoint 完成路径（`phase==='completed' && !parentSessionId`）在 CHILD_REVIEW_REQUIRED 前加新闸门：directChildren 反查 `getSubagentBySessionId`，存在终态（completed/failed/aborted）且 `!resultFetched` → 抛 `CHILD_RESULT_UNREVIEWED` + message「先查子结果再收工」+ details{taskId, childSessionId, mustContinue, userFacingFinalProhibited, currentTime}；文件级常量 `TERMINAL_SUBAGENT_STATUSES` |
| `test/issue-136-completion-signals.test.mjs` | 7 用例：s1 running→运行中 / s2 completed→子已完成，请验收（InMemoryTransport + Client.callTool 断言 content[0].text）/ s3 其余工具文本块逐字不变锚点（session_list/workspace_info/session_context/message_list）/ s4 终态取 result 置位+幂等 / s5 running 不置位、failed 置位 / s6 闸门拦+放行（AC2+AC3）/ s7 running 不触发新闸门回落旧 CHILD_REVIEW_REQUIRED |

### 二、验证结果

| 门 | 结果 |
|---|---|
| 单文件 | `bun test test/issue-136-completion-signals.test.mjs` **7 pass / 0 fail**（273ms） |
| 全量回归 | `bun test` **1230 pass / 0 fail**（108 文件，59.47s）——与基线一致零回归 |
| 变异体 | 新逻辑 8/8 全杀（M1 summaryFor 判定反转 / M2 默认分支破坏 / M3 置位无条件化 / M4 置位整行删除 / M5 闸门忽略验收标记 / M6 错误文本 / M7 错误码 / M8 details.taskId；M2/M6 脚本匹配误报经手动复验 KILLED） |

### 三、纪律记录（教训）

1. **全项目 mutation-test.mjs 在隔离检出目录上跑有污染风险**：后台运行被 timeout 挪后台后继续变异 core-tools.ts（maxOutputChars→maxOutputCharsDisabled 11 处）、config.ts 且未还原 → 手动 git checkout 还原 + kill 进程。教训：跑变异脚本须前台限时 + 事后 `git status` 核对；本票变异验证改用针对性变异（临时备份→变异→单文件测试→还原）。
2. 测试基建：`cleanTask` 五项全必填非空（background/deliverables/acceptanceCriteria/constraints 不能给空）；child checkpoint completed 会向 parent 发 event，s6 放行前须 `acknowledgeEvents`（否则落旧 CHILD_REVIEW_REQUIRED）。
3. MCP InMemoryTransport 双端 connect 须 `Promise.all`（顺序 await 会挂起超时）。

## 13. ADR-0048 #154 — backgroundize 抽取 + 反向依赖认领（2026-08-16）

- 基线：wk-154 @ 266d371（adr-0048-parent-child-handoff = main）
- 性质：低危两件——execute_cli 后台化单函数抽取（纯重构，行为零变化）+ src/store.ts 反向依赖认领记录
- 调度：调度3 派单（myterminal-34）→ 本窗（pid 87973，myterminal-7c）接单；MCP 查库结论已贴 #154 评论（5304459895）

### 一、backgroundize 单函数抽取

| 文件 | 改动 |
|---|---|
| `src/subagent/tools.ts` | execute_cli call() 内新增局部函数 `backgroundize(child)`——显式后台分支（run_in_background=true）与超时自动转后台分支的 `createOutputFile(bgId).then(...).catch(failBackground)` 链逐字相同，合并为单函数两处共用。纯抽取：settled/backgrounded/childExited/outputPath/fileHandle/out 捕获关系不变，行为零变化，全量回归与抽取前一致为硬验收 |

### 二、反向依赖认领：src/store.ts → src/subagent/store.ts

- **现状**：`src/store.ts:13-14`（核心会话存储 MyTerminalStore）反向 import 子系统运行时内存态——`SubagentStatus`（type）+ `getSubagentBySessionId`（runtime）。核心 store 内用法仅一处：checkpoint 完成闸门（D5 #136）在 directChildren 上反查 SubagentRecord 的 status/resultFetched；`getSubagentBySessionId` 对 `ctx.subagents` Map 做 O(n) 线性扫描。
- **为何可接受**：①闸门判据（终态+未验收）本质是运行时会话事实，落盘到 StoredState 会复制运行时真值并引入同步复杂度；②n = 进程内活跃 subagent 数，量级小，O(n) 扫描开销可忽略；③只读方向（store 不修改 subagent 态），无循环写依赖。
- **演进方向**：若 SubagentRecord 持久化为第一类状态（schema v3+），将闸门数据源下沉——runner finalize 时把 resultFetched/终态写进 session 状态，store 自持判据，取消反向依赖；或经注册表/事件接口倒置，核心 store 不直达子系统。
