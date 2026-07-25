# Skill 系统研究报告 — 上下文注入 / 安装 / 调用机制

**分支**：`feat/skills`（基于 `main` @ `53b07ac`）
**日期**：2026-07-26
**状态**：研究阶段，未开始实施

---

## 1. 目标

为 MyTerminal 增加 **Skill 系统**：可复用、可分发、按需加载的"专业知识/工作流"包，介于现有的 `AGENT.md`（全局宪法）与 `extension`（动态 tool）之间。

本报告先剖析现有架构，再研究 skill 系统必须解决的三个机制：
1. **上下文注入机制** — skill 内容如何到达 agent
2. **skill 安装机制** — skill 文件如何被安装/管理
3. **skill 被调用机制** — skill 何时被触发、内容如何被消费

---

## 2. 现有架构剖析

### 2.1 装配链（`server.ts:64-66`）

```text
createBuiltinTools(config, store)            // core-tools.ts → Map<name, ToolDefinition>
        │
        ▼
new ExtensionService(config, store, builtins, onAudit)   // extensions.ts
        │
        ▼
new MyTerminalMcpTransport(extensions)       // mcp.ts → MCP 通道
```

- `ExtensionService` 是统一门面：`discover()` / `register()` / `call()`
- `builtins` 是硬编码 tool map（29 个：文件/shell/git/CI/session/message/blob）
- MCP 通道在 `createMcpServer()` 里把 facade + ~25 个 direct tool 注册到 McpServer

### 2.2 现有上下文注入机制（skill 注入的参照）

| 注入点 | 位置 | 内容 | 范围 |
|---|---|---|---|
| `agentMd` 字段 | `extensions.ts:226`（未认证 discover）、`:258`（已认证 discover） | `~/.config/myterminal/AGENT.md` 全文 | 全局、单文件、始终注入 |
| MCP `instructions` | `mcp.ts:121-134` | 12 条硬编码英文，`join('\n')` 传给 `McpServer` 构造函数 | 每个 MCP server 实例一份，静态 |
| `instructions` 对象 | `extensions.ts:228-236`、`:260-271` | root/inherit/continue/call/... 等 key 的行为指令 | 已认证 discover 响应里 |
| `harness` / `registrationSchema` | `extensions.ts:272-278` | continuation 合约 + extension 注册 schema | 已认证 discover 响应里 |

**关键函数**：`loadAgentMd(settingsPath)` (`extensions.ts:19-26`)
```ts
function loadAgentMd(settingsPath: string): string | undefined {
  const file = path.join(path.dirname(settingsPath), 'AGENT.md');
  if (!existsSync(file)) return undefined;
  const content = readFileSync(file, 'utf8').trim();
  return content || undefined;
}
```

**关键观察**：
- agentMd 是"全局单文件、始终注入"——适合宪法，不适合可复用技能包
- MCP instructions 是硬编码——skill 内容要进 MCP 必须改 `createMcpServer()`
- discover 响应是天然的 skill 元数据广播点（agent 每次都会调）

### 2.3 现有 extension 注册/调用机制（skill 安装的参照）

**注册**（`extensions.ts:295-329`）：`extension_register(action=validate|upsert|remove, spec|specJson)`
- `validateSpec()` (`:60-76`) 校验：name 正则 `[a-z][a-z0-9_]{2,63}`、title 1-100、description 10-800、inputSchema、annotations、handler
- handler 两种：`builtin`（指向已有 builtin tool + defaults）或 `command`（执行外部命令）
- 持久化：`store.upsertExtension(spec)` / `store.removeExtension(name)` (`store.ts:770-779`)，存于 `StoredState.extensions: CustomExtensionSpec[]`

**调用**（`extensions.ts:347-435`）：`extension_call(tool, input, identity)`
- `invokeTool()` (`:567-584`)：
  - builtin → 从 `this.builtins` map 查 → schema 校验 → `invoke(normalized, context)`
  - custom → 从 `store.listExtensions()` 查 → schema 校验 → builtin handler 合并 defaults 调 target，command handler 渲染模板后 `runCommand`
- 鉴权：`authenticate()` (`:540-553`)，identity 在请求顶层
- continuation / background task 机制在 `call()` 里统一处理

**关键观察**：extension 是"动态 tool"——有 inputSchema、有 handler、被 `extension_call` 调用。skill 不应该是 tool（skill 是知识/指令，不是可执行能力），但安装机制可借鉴 `validate|upsert|remove` 模式。

### 2.4 目录结构（skill 文件该放哪）

```text
~/.config/myterminal/                # configDir = path.dirname(settingsPath)
├── config.json                       # MyTerminalSettings
├── AGENT.md                          # 全局 agent 指令（draftAgentMd 创建模板）
├── state/<workspaceHash>/            # stateDir — store.jsonl 等
└── install-backups/                  # 旧 state 归档
```

- `settingsPath()` (`config.ts:24-30`)：`$MYTERMINAL_CONFIG_DIR` 或 `~/.config/myterminal/config.json`
- `draftAgentMd(configDir)` (`config.ts:239-260`)：首次启动创建 AGENT.md 模板
- skill 文件自然位置：`configDir/skills/<name>/SKILL.md`（目录式，支持附带资源文件）

---

## 3. 三个机制研究

### 3.1 上下文注入机制

**核心问题**：skill 内容如何到达 agent 的 context window？

**现状**：只有 agentMd 一条管道（AGENT.md 全文 → discover 响应）。skill 若都塞进 AGENT.md 会污染用户手写的宪法，且无法按需加载。

**三种注入策略**（可组合）：

| 策略 | 注入点 | 内容 | 优点 | 缺点 |
|---|---|---|---|---|
| **A. always 注入** | 拼到 agentMd 末尾，或 MCP instructions 末尾 | always 类 skill 全文 | agent 必定看到 | context 膨胀；skill 多了不可行 |
| **B. 元数据广播** ⭐ | discover 响应新增 `skills: [{name,title,description,trigger}]` | 仅元数据列表 | 轻量；agent 自主决定加载 | 依赖 agent 主动调 skill_load |
| **C. trigger 自动注入** | transport 层 hook，匹配关键词后注入 | 命中 skill 的全文 | 体验好，agent 无需感知 | 需要 hook 机制，复杂 |

**推荐**：**B + A（仅 always 类）组合**
- discover 响应新增 `skills` 字段（元数据列表，所有 skill）
- always 类 skill 的简要提示追加到 MCP instructions 末尾（mcp.ts:121）
- agent 通过新增的 `skill_load(name)` tool 主动获取完整内容
- C（trigger 自动注入）作为后续增强，不在首期

**注入点改动清单**：
- `extensions.ts` `discover()` (`:216-293`)：响应 data 里加 `skills: listSkills()`
- `extensions.ts`：新增 `loadSkillManifest(configDir)` helper（扫描 skills 目录 + 解析 frontmatter）
- `mcp.ts:121` `instructions`：末尾追加 always 类 skill 提示（动态拼接，需把 configDir 传进 `createMcpServer`）

### 3.2 skill 安装机制

**核心问题**：skill 文件如何被安装、校验、列出、删除？

**存储设计**：
```text
~/.config/myterminal/skills/
├── <skill-name>/
│   ├── SKILL.md          # frontmatter + Markdown 内容
│   └── files/            # 可选附带资源（脚本、模板等）
└── <another-skill>/
    └── SKILL.md
```

**Skill 文件格式**（frontmatter + Markdown，借鉴 WorkBuddy SKILL.md）：
```markdown
---
name: git-commit-helper
title: Git Commit Helper
description: When the user asks to commit changes, use this skill
trigger: manual                    # manual | always | keyword
keywords: [commit, 提交]           # trigger=keyword 时生效
version: 1.0.0
---

# Git Commit Helper

## When to use
...

## Workflow
...
```

**注册方式**（两选一）：

| 方式 | 实现 | 优点 | 缺点 |
|---|---|---|---|
| **文件系统扫描** ⭐ | 启动时 + discover 时扫描 `skills/` 目录，从 frontmatter 解析元数据 | 无需改持久化格式；用户可直接编辑文件；与 AGENT.md 一致 | 元数据不进 store.state，需每次扫描 |
| 复用 extension_register | `skill_register(action=upsert, spec)` 写入 store.state.skills | 与 extension 一致 | 改持久化格式（StoredState 加字段）；与文件系统双源易不一致 |

**推荐**：**文件系统扫描**——不碰 store.ts / types.ts 持久化格式，与 AGENT.md 同构（都是 configDir 下的 Markdown），用户可直接用编辑器管理。

**安装 tool 设计**（新增 builtin tool）：
- `skill_install({name, content, files?})` — 从 content 写入 SKILL.md（content 可来自 blob_create 暂存）
- `skill_list()` — 扫描目录返回元数据列表
- `skill_load({name})` — 读 SKILL.md 全文返回
- `skill_remove({name})` — 删除 skill 目录

**校验**（借鉴 `validateSpec()` extensions.ts:60）：
- name 正则 `[a-z][a-z0-9-]{2,63}`
- title 1-100 字符
- description 10-800 字符
- trigger ∈ `manual|always|keyword`
- content 非空、≤ 100KB

### 3.3 skill 被调用机制

**核心问题**：skill 何时被触发、内容如何被消费？

**三种调用模式**（对应三种 trigger 类型）：

| 模式 | 触发 | 流程 | 首期实现 |
|---|---|---|---|
| **manual** ⭐ | agent 看到 discover 的 skills 列表，自主决定调用 `skill_load(name)` | discover → agent 判断 → skill_load → 消费内容 | ✅ 首期 |
| **always** | discover 时元数据 + MCP instructions 提示都包含；agent 可直接 skill_load 或按提示执行 | discover → (instructions 含提示) → skill_load | ✅ 首期 |
| **keyword** | 用户消息匹配 keywords → 自动注入 skill 内容 | transport hook → 匹配 → 注入 | ❌ 后续（需 hook） |

**消费路径**：
- `skill_load(name)` 返回 `{name, title, description, content, version}` 
- agent 把 content 当作指令阅读执行（与 agentMd 同质，但按需加载）
- skill 内容里可以指导 agent 调用其它 builtin/custom tool（如 execute_cli、write_file）来完成工作流

**与 extension 的区别**（关键）：
- extension = 可执行能力（有 inputSchema、handler、返回 result）
- skill = 知识/指令（有 content、被 agent 阅读后指导行为，不直接"执行"）
- skill 不进 `extension_call` 调用链，它是"给 agent 看的说明书"，不是"被调用的函数"

---

## 4. Skill 系统设计提案

### 4.1 设计目标

1. **最小侵入**：不改 store.ts / types.ts 持久化格式；core-tools.ts / extensions.ts / mcp.ts 改动最小
2. **与 AGENT.md 同构**：skill 是 configDir 下的 Markdown 文件，用户可直接编辑
3. **按需加载**：always 类少而精，manual 类为主体，避免 context 膨胀
4. **可分发**：skill 是目录（SKILL.md + 可选 files/），可打包分享
5. **双通道覆盖**：Actions 通道（discover 响应）和 MCP 通道（instructions）都能感知 skill

### 4.2 Skill 文件格式（最终）

```markdown
---
name: lower-kebab-case-3-63
title: 1-100 chars
description: 10-800 chars (when to use this skill)
trigger: manual | always | keyword
keywords: [可选, trigger=keyword 时生效]
version: semver string
---

# Skill 正文（Markdown）

任何 Markdown 内容。agent 读取后作为指令执行。
可引用其它 builtin tool（execute_cli, write_file, ...）。
```

### 4.3 新增模块：`src/skills.ts`

职责：skill 文件系统扫描、frontmatter 解析、CRUD、校验。

```ts
// 伪代码
export type SkillManifest = {
  name: string; title: string; description: string;
  trigger: 'manual' | 'always' | 'keyword';
  keywords?: string[]; version: string;
};

export type SkillRecord = SkillManifest & { content: string; installedAt: string };

export function skillsDir(configDir: string): string;            // <configDir>/skills
export function listSkills(configDir: string): SkillManifest[];  // 扫描目录
export function loadSkill(configDir: string, name: string): SkillRecord;  // 读全文
export function installSkill(configDir: string, name: string, content: string): void;  // 写 SKILL.md
export function removeSkill(configDir: string, name: string): void;
export function validateSkillManifest(raw: unknown): SkillManifest;  // 校验 frontmatter
```

### 4.4 接入点清单（文件改动）

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/skills.ts` | **新建** | skill 文件系统操作 + frontmatter 解析 |
| `src/core-tools.ts` | +4 个 builtin tool | `skill_install` / `skill_list` / `skill_load` / `skill_remove` |
| `src/extensions.ts` | discover() 响应 +skills 字段 | `:226`、`:258` 两处注入点加 `skills: listSkills(configDir)`；新增 `loadSkillManifest()` helper（类似 `loadAgentMd`） |
| `src/mcp.ts` | instructions 末尾追加 always 类提示 | `:121-134` 改为动态拼接；需把 configDir 传入 `createMcpServer(service, configDir)` |
| `src/server.ts` | 传 configDir 给 createMcpServer | `:66` `new MyTerminalMcpTransport(this.extensions)` → 需让 transport 持有 configDir |
| `src/types.ts` | （可选）加 SkillManifest 类型 | 若不想改 types.ts，类型放 skills.ts |
| `src/config.ts` | （可选）draftSkillsDir() | 首次启动创建 skills/ 目录（类比 draftAgentMd） |

**不改**：`store.ts`（skill 走文件系统）、`StoredState`（持久化格式不变）、TUI（首期不做 skill 管理 UI）。

### 4.5 MCP 通道的 configDir 传递

当前 `MyTerminalMcpTransport` 只持有 `ExtensionFacade`。要让它知道 configDir 有两条路：

| 方案 | 实现 | 侵入度 |
|---|---|---|
| **A. ExtensionFacade 扩展** | `ExtensionFacade` 加 `listSkills()` 方法，MCP 从 service 取 | 改 extensions.ts 接口 |
| **B. Transport 持有 configDir** ⭐ | `new MyTerminalMcpTransport(service, configDir)` | 改 mcp.ts 构造 + server.ts 装配 |

推荐 **B**——configDir 是配置，本就该在 transport 层可用；且 `ExtensionFacade = Pick<ExtensionService, ...>` 保持纯净。

---

## 5. 实施路线图

### Phase 1 — 地基（`src/skills.ts` + 类型）
- 新建 `src/skills.ts`：实现 `listSkills` / `loadSkill` / `installSkill` / `removeSkill` / `validateSkillManifest`
- frontmatter 解析（轻量 YAML subset，或引入 `gray-matter`——但项目零运行时依赖，建议手写最小解析器）
- 单元测试：校验、扫描、CRUD

### Phase 2 — builtin tool（`core-tools.ts`）
- 新增 4 个 tool：`skill_install` / `skill_list` / `skill_load` / `skill_remove`
- `skill_install` / `skill_remove` 标 `mutating` annotation，需 authenticatedSession
- `skill_list` / `skill_load` 标 `readOnly`

### Phase 3 — 上下文注入（`extensions.ts` + `mcp.ts`）
- `extensions.ts` discover() 两处响应加 `skills` 字段
- `mcp.ts` instructions 末尾动态追加 always 类 skill 提示
- `server.ts` 装配链传 configDir

### Phase 4 — 测试与文档
- 测试：安装/列出/加载/删除/注入到 discover/注入到 MCP instructions
- 文档：docs/skills.md（中英）、README 加 skill 章节
- 示例 skill：`skills/example-git-commit/SKILL.md`

### Phase 5（后续）— 增强
- keyword trigger 自动注入（需 transport hook）
- TUI skill 管理页（Extensions 页扩展或新建 Skills 页）
- skill 打包/分发（zip 一个 skill 目录）

---

## 6. 风险与待决策

| 项 | 风险 | 建议 |
|---|---|---|
| frontmatter 解析 | 引入 YAML 解析依赖 vs 手写 | 手写最小解析器（key: value + list），保持零运行时依赖 |
| MCP instructions 膨胀 | always 类 skill 多了 instructions 会很长 | 限制 always 类只放"提示一句话"，全文仍走 skill_load |
| configDir 传递链 | 改 mcp.ts 构造签名 | 影响面小，server.ts 装配点只有 2 处（`:66`、`:342`） |
| skill 安全 | skill 内容可能含恶意指令 | skill 是用户自己安装的（与 AGENT.md 同信任级），不额外加沙箱；但 skill_install 要校验 name 防 path traversal |
| 与 AGENT.md 关系 | 重复？冲突？ | AGENT.md = 宪法（始终全量）；skill = 专业知识（按需）。文档明确区分 |

**待用户决策**：
1. frontmatter 解析：手写 vs 引入依赖？
2. 首期是否实现 keyword trigger 自动注入？（建议否，先 manual+always）
3. 是否首期就做 TUI skill 管理 UI？（建议否，先 tool + 文件系统管理）

---

## 7. 结论

MyTerminal 现有架构对 skill 系统友好：
- **上下文注入**有现成管道（agentMd / MCP instructions），扩展即可
- **安装机制**借鉴 extension_register 的 validate/upsert/remove 模式，但走文件系统（不碰持久化格式）
- **调用机制**用"manual 为主 + always 辅助"的按需加载模型，避免 context 膨胀

最小侵入方案：新建 1 个文件（`src/skills.ts`），改 4 个文件（core-tools / extensions / mcp / server），不改 store / types 持久化格式。首期 4 个 builtin tool + discover 注入 + MCP instructions 提示，可在一个分支内完成。
