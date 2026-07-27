# MyTerminal 领域术语表

> 无实现细节。仅含经拷问确认的领域概念定义。

## Skill

### 存储

两个位置，首次启动自动创建目录（和 draftAgentMd 机制一致，全局 skills/ 始终建好，项目级按需建）：

- **全局**：`~/.config/myterminal/skills/<name>/SKILL.md`（跨 workspace 共用，与 AGENT.md 同级）
- **项目级**：`<workspace>/.myterminal/skills/<name>/SKILL.md`（项目专属）

discover/加载时两个目录都扫描，同名 skill 全局优先（全局覆盖项目级）。

- 不是可执行的 tool（那是 extension 的角色）。
- AI 读取 skill 内容后，按指引调用其他 tool（execute_cli、write_file 等）完成工作流。
- 例：git-commit skill 告诉 AI "当用户要提交时，先 git diff → 生成规范 message → execute_cli 执行"。
- 与 AGENT.md 区别：AGENT.md 是全局宪法（始终注入），skill 是专业知识包（按需加载）。

## Skill 发现

Skill 元数据通过两个管道暴露给 AI，均带 mode 字段（ADR-0010 决策 5）：

- **Actions 通道**（GPT）：`extension_discover` 响应加 `skills: [{name, description, when_to_use, mode}]` JSON 数组。无大小限制。
- **MCP 通道**（Claude）：指令只放一句提示 `"Use skill() to list available skills, skill(name) to run one."`——不塞列表（2048 字符截断限制）。AI 按需调 skill() 发现。

## skill tool

builtin tool（ADR-0010）。无参/有参区分两种行为：

- `skill()` → 返回 `{skills: [{name, description, when_to_use, mode}]}`（名单，带 mode）
- `skill(name="xxx")` → 读 frontmatter 的 mode，自动路由：
  - `mode: inline`（缺省）→ 返回 `{name, description, mode, content}`（SKILL.md 正文，云端 AI 照着做）
  - `mode: fork` → 启动 subagent 执行，返回 `{name, description, mode, taskId, sessionId, status:'running'}`

annotations 非 readOnly（fork 有副作用）。list/inline 不要求 identity；fork 要求 identity（调 actor 拿 parentSessionId）。

_Avoid_: skill_list, skill_load（已被 skill 合并取代，ADR-0010 决策 3/7）

## mode

SKILL.md frontmatter 的可选字段（ADR-0010 决策 2），决定 skill 的执行方式。缺省 `inline`。

- `inline`：读 SKILL.md → 内容作为 tool_result 返回 → 云端 AI 自己照着做。适合简单、几步搞定的 skill。
- `fork`：读 SKILL.md → 内容作为 task 启动 subagent 执行 → 异步返回 taskId → 主 agent 用 subagent_status 查结果。适合复杂、多步骤、需隔离上下文的 skill。

AI 不传 mode 参数——mode 由 skill 作者在 frontmatter 声明，工具自动路由。

## fork

skill 的执行模式之一（ADR-0010 决策 1）。skill 内容不进主上下文，而是作为 task 注入 subagent 的隔离上下文。subagent 用 3 层 compact（executor.ts 决策 20）管理上下文，结束后整个上下文丢弃。主上下文只有 subagent 的 result。

fork 复用 SubagentRunner.start()（ADR-0009），和 subagent_start 共享 maxParallel 配额、递归防护、通知机制。fork 的 subagent 工具集是封闭的 8 个（不含 skill，ADR-0007 决策 4 保持）。

fork 用本地 API key（付费），不是"免费借云端 AI"。

## forkOptions

SKILL.md frontmatter 的可选字段（ADR-0010 决策 6），仅 `mode: fork` 时生效。覆盖 subagent 默认配置，优先级：`forkOptions > settings.json`。

支持字段：deliverables / acceptanceCriteria / constraints（任务包）+ provider / model / maxTurns / timeoutSec / readOnly（运行时配置）。安全网上限：maxTurns 200，timeoutSec 3600。
