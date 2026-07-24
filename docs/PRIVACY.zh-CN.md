# 隐私说明与部署模板

[English](PRIVACY.md) · [README](../README.zh-CN.md)

最后更新：2026 年 7 月 18 日

## 适用范围

MyTerminal 是在用户电脑上运行的开源软件。项目维护者不运营托管的 MyTerminal 服务。仅仅安装本软件，不会把工作区文件、提示词、消息、session 历史、凭据或遥测数据发送给项目维护者。

## 本地处理的数据

根据用户调用的工具，MyTerminal 可能处理：

- TUI 中选定工作区内的文件和 Git 元数据；
- 结构化 MyTerminal session、任务包、checkpoint、协作消息、事件和脱敏工具审计；
- 运行配置与连接凭据；
- 在选定工作区内执行命令产生的输出。

配置保存在操作系统的用户配置目录。Session 状态和追加式历史保存在选定工作区的 `.myterminal` 下。MyTerminal 不会有意向项目维护者发送遥测数据。

## 发送给第三方的数据

用户通过 Actions 或 Apps 连接 ChatGPT 后，请求的工具输入和输出会在用户的 MyTerminal 实例与 OpenAI 之间传输。用户使用隧道或反向代理公开 MyTerminal 时，流量也会经过该服务商。这些服务有各自的条款和隐私政策。

MyTerminal 默认隐藏 TUI 中的连接凭据，只保存 session token 的哈希，并从持久化的调用参数与返回结果中清除 identity、authorization、claim code、credential、secret、password、API key、消息正文、content 和 URL 中的敏感查询参数。除此之外，Logs 页面会保留脱敏后的完整输入与输出供本机审查。这些措施可以降低暴露风险，但不能替代谨慎选择工作区和人工审查。

## 保留与删除

MyTerminal 会在本地保留结构化 session 历史，直到用户在 TUI 中删除或移除工作区数据。只有 TUI 所有者能够永久删除 MyTerminal session。源文件和 Git 历史仍由用户自己的项目流程管理。

## 公开 GPT 部署

本文描述的是上游、未托管的软件。如果你发布连接到自己 MyTerminal endpoint 的 GPT，你有责任提供准确的隐私政策，说明运营者身份、GPT 处理的数据、涉及的隧道或托管服务商、保留期限、删除请求方式和联系方式。除非内容与你的部署完全一致，否则不要把上游说明当作托管服务的隐私政策。

OpenAI 当前要求带 Actions 的公开 GPT 提供有效的隐私政策 URL，参见 [GPT Actions 配置说明](https://help.openai.com/en/articles/9442513)。

## 安全与问题反馈

请选择专用工作区，妥善保护 Actions token，不使用远程访问时停止公网隧道，并检查 MyTerminal 的 Diff 和 Logs 页面。项目问题可以提交到 [MyTerminal Issues](https://github.com/epslkslsksndnsjs-lab/myterminal/issues)。Issue 中不要包含凭据、私有源码或 session token。
