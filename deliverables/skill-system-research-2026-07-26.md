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

---

## 8. Claw (Claude Code) Skill 系统对照 — 设计拷问

> 来源：`claw v2.1.88-source.0`（`/Desktop/claude-code-source-jr/`），共 29 文件/6103 行。从 init commit `55eeb5c` 起就内置 skill 系统，非事后增补。
>
> **Claw 的"源优先（source-first）"哲学**：内置 skill 内容是硬编码在 `.ts` 文件里的，不是 SKILL.md。SKILL.md 只用于用户自定义 skill。MyTerminal 同理——首期不做内置 skill，所有 skill 都是用户安装的 SKILL.md 文件。

### 8.1 Claw 核心设计要点

| 维度 | Claw 实现 |
|------|----------|
| **Skill 本质** | Prompt Command — 带 frontmatter 的可触发提示模板 |
| **执行模式** | inline（展开内容到当前对话）/ fork（隔离子 agent）/ remote（远程） |
| **Tool 定义** | `Skill` tool，输入 `{skill: string, args?: string}`，Zod v4 schema |
| **文件格式** | `skill-name/SKILL.md`（frontmatter YAML + Markdown），仅目录格式 |
| **YAML 解析** | `Bun.YAML` 内置 + `yaml` npm 降级；两层 try/catch + `quoteProblematicValues()` 自动修复 YAML 特殊字符 |
| **存储来源** | managed > `~/.claw/skills/` > 各 `.claw/skills/` (嵌套遍历) > add-dir > 遗留 `/commands/` |
| **内置 skill** | 17 个，通过 `registerBundledSkill()` → `bundledSkills[]` 数组；在 `initBundledSkills()` 里初始化 |
| **上下文注入** | 系统提示（`formatCommandsWithinBudget`）+ 系统提醒消息（`systemInit`）；预算 = context window × 1% ≈ 8000 字符；bundled source 始终完整不截断 |
| **条件 skill** | `paths` frontmatter（如 `"src/core/**"`），文件被操作后下个 turn 才可见；用 `ignore` 库进行 gitignore 风格匹配 |
| **变更监听** | chokidar 文件监视 + 300ms 防抖重载；Bun 下用 polling 避免 FSWatcher bug |
| **使用追踪** | 记录频率 + 最近使用时间 → 影响 skill 列表排序 |

### 8.2 十大拷问

#### Q1：Skill 是 Tool 还是 Metadata？

- Claw：Skill 是 tool，叫 `Skill`。模型看到 skill 列表在 prompt 中 → 调 `Skill({ skill: "commit" })` → 内容展开注入。
- MyTerminal：discover 返回 `skills` 元数据数组 → 模型用 `skill_load({ name })` 获取内容。
- ✅ **本质相同**——列表→决策→获取。`skill_load` 语义更显式（加载=取内容），不与 Claw 的 `Skill` tool 名冲突。

#### Q2：Skill 调用后如何执行？

- Claw：inline 用 `processPromptSlashCommand` 展开 `!command`/`$ARGUMENTS` → 返回 `ContentBlockParam[]` 注入对话。fork 启隔离 agent。
- MyTerminal：`skill_load` 返回 `{ content, name, ... }`，agent 自己读 + 执行。
- ✅ MyTerminal 不需要 fork（没有 agent SDK），inline = 返回内容。更简单可控。

#### Q3：Frontmatter 字段名要对齐 Claw 吗？

- Claw 字段：`name`, `description`, `when_to_use`, `user-invocable`, `disable-model-invocation`, `allowed-tools`, `model`, `context`, `agent`, `effort`, `paths`, `hooks`, `shell`, `version`, `argument-hint`, `arguments` — 16 个。
- MyTerminal 原方案：`name`, `title`, `description`, `trigger`, `keywords`, `version` — 6 个。
- ⚠️ **建议对齐**。用 `when_to_use` 替代 `title`+`trigger`（更语义化——告诉 AI 何时激活）。加 `user-invocable`（默认 true）和 `disable-model-invocation`（默认 false）。去掉 `keywords`。

#### Q4：需要 args 参数化吗？

- Claw：`Skill` tool 支持 `args`（如 `/commit -m "fix"`），frontmatter 声明 `arguments`/`argument-hint`。
- MyTerminal：skill 是"知识包"而非"命令"。
- ✅ 首期不加 args。frontmatter 预留 `argument-hint` 字段。

#### Q5：Frontmatter 解析 — 手写 vs 引依赖？

- Claw：Bun.YAML + `yaml` npm 双后端 + 自动引号修复。说明 YAML frontmatter 容错是刚需。
- MyTerminal：手写最小解析器（key: value 逐行）。
- ✅ 手写足够。MyTerminal 字段少（~6 个），手写覆盖 key:value + 数组。加 try/catch 跳过失败 skill。

#### Q6：预算制是否必需？

- Claw：1% context window ≈ 8000 字符。因为可能有几十个 skill 要列出。
- MyTerminal：预计 < 20 个 skill，每个元数据 ~100 字符 → ≤ 2000 字符。
- ✅ 首期不做，预留 `priority` 标记。

#### Q7：项目级 skill？全局 skill？

- Claw：四层来源——managed > user > project 嵌套 > add-dir。
- MyTerminal：只有全局（`~/.config/myterminal/skills/`）。
- ✅ 首期只做全局。项目级（workspace `.myterminal/skills/`）留 Phase 5。

#### Q8：条件 Skill（paths/keyword）首期做吗？

- Claw：`paths` frontmatter 匹配后下 turn 激活。用 `ignore` 库。
- MyTerminal 原方案：`trigger: keyword|manual|always`。
- ✅ 首期不做。所有 skill 都是 manual/always。条件触发留 Phase 5。

#### Q9：需要文件变更监听吗？

- Claw：chokidar + 300ms 防抖 + 自动重载。因为 Claw 是长期运行的 REPL。
- MyTerminal：discover 每次请求时扫描。因为 discover 本身高频。
- ✅ 不需要，不引入 chokidar 依赖。

#### Q10：使用追踪与排序？

- Claw：记录频率 + 最近使用时间，影响排序。
- MyTerminal：首期按文件系统顺序（alphabetical）。
- ✅ 不需要。使用追踪需持久化 → 改 store → 违背铁律。

### 8.3 拷问结果：MyTerminal 方案的调整清单

| # | 调整项 | 原方案 | 调整后 |
|---|--------|--------|--------|
| 1 | frontmatter 字段 | name, title, description, trigger, keywords, version | name, description, when_to_use, version, user-invocable, disable-model-invocation, argument-hint |
| 2 | call tool 名 | skill_load | skill_load（保持） |
| 3 | 手写解析器 | 待决策 | ✅ 确认，+ try/catch 跳过失败 |
| 4 | 预算制 | 未提及 | ❌ 不做，预留 priority 标记 |
| 5 | 条件 trigger | keyword auto-inject | ❌ 不做，首期只有 manual+always |
| 6 | 项目级 skill | 未提及 | ❌ 不做，留 Phase 5 |
| 7 | 文件监听 | 未提及 | ❌ 不做，discover 时扫描 |

---

## 9. 最终方案（拷问后，90%+ 信心）

### 9.1 SKILL.md 格式（最终）

```yaml
---
name: git-commit-helper                    # 必须 — [a-z][a-z0-9-]{2,63}
description: Short description (10-800)    # 必须
when_to_use: When to use this skill       # 可选 — 告诉 AI 何时激活
version: 1.0.0                             # 可选
user-invocable: true                       # 可选 — 默认 true。false = 仅模型调用（不在用户 /skills 列表显示）
disable-model-invocation: false            # 可选 — 默认 false。true = 仅用户触发，模型不可主动调用
argument-hint: "<args>"                    # 可选 — 预留，后续条件 skill 用
---

# Skill 正文（Markdown）

任何 Markdown 内容。agent 读取后作为指令执行。
可以引用其它 builtin tool（如 execute_cli、write_file）。
```

### 9.2 确认决策

| 决策项 | 结论 |
|---|---|
| frontmatter 解析 | ✅ 手写最小解析器（key: value + array），保持零运行时依赖 |
| keyword auto-inject | ❌ 首期不做 |
| TUI 管理 UI | ❌ 首期不做 |
| 预算制 | ❌ 首期不做（skill 数量 < 20，无需） |
| 项目级 skill | ❌ 留 Phase 5 |
| 文件监听 | ❌ 不引入 chokidar，discover 时扫描 |

### 9.3 信心评估

- ✅ 三机制理解：100%（已剖析 Claw 29 文件/6103 行 + MyTerminal 装配链）
- ✅ 设计合理性：95%（对齐 Claw 的 frontmatter 格式，简化掉不需要的部分）
- ✅ 可实现性：95%（接入点明确，改动量小，有 Claw 参照）
- ⚠️ 剩余不确定性：5%（实践中 frontmatter 手写解析器的边界 case；GPT/Claude 对 skill 元数据格式的理解效果需实测）

**总体信心：90%+。可以开始实施 Phase 1 —— `src/skills.ts` 地基。**
