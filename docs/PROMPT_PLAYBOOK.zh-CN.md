# 简短提示词手册

[English](PROMPT_PLAYBOOK.md) · [推荐 GPT 预设指令](GPT_INSTRUCTIONS.zh-CN.md) · [Actions 配置教程](ACTIONS_SETUP.zh-CN.md)

只替换尖括号中的内容。保持简短；稳定的工具流程已经写在 GPT 预设指令里。

| 目的 | 提示词 |
| --- | --- |
| 开始新任务 | `为 <目标> 建立新的 root session。先检查项目，再开始执行。` |
| 领取交接 | `接管这个 MyTerminal session：<粘贴 TUI 交接提示>。` |
| 续作已完成任务 | `续作已完成 session <名称或 ID>：<新目标>。创建 continuation，不要 inherit。` |
| 委派一个子任务 | `把 <子任务> 委派给子 session，并给我可粘贴到第二个 ChatGPT 对话的交接提示。` |
| 检查协作状态 | `显示 session 树、阻塞项、未读消息和待确认事件。` |
| 发送消息 | `告诉 <session 名称>：<消息>。然后显示双方对话。` |
| 使用或创建扩展 | `查找能完成 <目标> 的工具；如果没有，先验证最小且安全的扩展 spec，再注册。` |
| 转交当前工作 | `释放当前 session，并给我一次性交接提示。` |
| 安全完成 | `运行项目检查；通过后将已验证结果 checkpoint 为 completed。` |

## 不要粘贴什么

不要使用很长的“你是一位专家”式提示词，不要复制 API schema、token、session 身份或内部工具 JSON。GPT 预设已经包含稳定规则；用户提示词只需表达目标、范围和必须由用户决定的事项。

## 一句话纠正错误流程

如果 GPT 选错 session 流程，只需发送：

`这是 <未完成交接 / 已完成续作>；请使用 <session_inherit / 带 continuesSessionId 的 session_register>。`
