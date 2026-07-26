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

Skill 元数据通过两个管道暴露给 AI：

- **Actions 通道**（GPT）：`extension_discover` 响应加 `skills: [{name, description, when_to_use}]` JSON 数组。无大小限制。
- **MCP 通道**（Claude）：指令只放一句提示 `"Use skill_list to see available skills, then skill_load(name) for instructions."`——不塞列表（2048 字符截断限制）。AI 按需调 skill_list 发现。

## skill_list tool

只读 builtin tool，返回已安装 skill 的元数据数组 `{skills: [{name, description, when_to_use, version}]}`。不返回正文内容（省 token）。

## skill_load tool

只读 builtin tool。输入 `{name}`，返回 `{content}`（SKILL.md 正文）。和 read_file 类似——读文件内容，AI 按指引执行。不照搬 Claw 的 {data, newMessages, contextModifier}（需要 agent loop，MyTerminal 做不到）。
