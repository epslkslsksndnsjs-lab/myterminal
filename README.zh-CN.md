# MyTerminal

[English](README.md) · [Actions 教程](docs/ACTIONS_SETUP.zh-CN.md) · [GPT 预设指令](docs/GPT_INSTRUCTIONS.zh-CN.md) · [短提示词手册](docs/PROMPT_PLAYBOOK.zh-CN.md) · [隐私说明](docs/PRIVACY.zh-CN.md)

MyTerminal 的核心目的，是让 **ChatGPT 的普通 Chat 对话模式也能以可控方式在本地电脑上工作**。通过为自定义 GPT 配置 Action，或接入 ChatGPT App，普通 ChatGPT 对话就可以查看和编辑获准的本地项目、运行受约束的工具、协调多个工作 session 并汇报进展；用户始终通过本地 TUI 保留控制权。MyTerminal 是 ChatGPT Chat 与本地电脑之间的桥梁，不是另一个聊天客户端。

MyTerminal 0.1.0 通过可审计、可继承的工作 session 层提供这座桥梁。它同时支持 ChatGPT **Actions** 和 **Apps（MCP）**，并提供多 session 协作、永久消息、声明式扩展、Git 风格实时 diff，以及覆盖整个终端窗口的中英双语 OpenTUI 界面。

![MyTerminal session 层级](docs/assets/tui/sessions-zh-CN.svg)

## 安装与启动

### 第一次安装

无需提前安装 Git、Node.js、Bun 或其他编程环境。安装脚本会下载与当前平台和 CPU 架构匹配的 `v0.1.0` 独立可执行文件，校验 SHA-256，把 `myterminal` 注册成当前用户的全局命令，然后启动 TUI。发行安装不再下载臃肿的源码包或安装运行时依赖。

#### macOS

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.0/scripts/install-macos.sh)"
```

#### Linux

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.0/scripts/install-linux.sh)"
```

#### Windows PowerShell

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.0/scripts/install-windows.ps1 | iex"
```

> [!IMPORTANT]
> **Windows 已知限制：** PowerShell 下正式支持的是纯键盘兼容模式。鼠标捕获默认关闭，因为它在 Windows PowerShell 和 PowerShell 7 中可能无响应或导致界面卡死。所有页面和精确 session 选择都可用方向键、`PgUp/PgDn`、`Home/End`、`Enter` 与页面快捷键完成。`$env:MYTERMINAL_WINDOWS_TUI_MODE='mouse'` 仅供实验，不建议用于关键任务；删除该环境变量即可恢复稳定的 20 FPS 主屏模式。

直接运行远端脚本很方便，但也需要谨慎。执行前可以先检查 [macOS 安装脚本](scripts/install-macos.sh)、[Linux 安装脚本](scripts/install-linux.sh)或 [Windows 安装脚本](scripts/install-windows.ps1)。

如需安装本地候选包、使用离线资产或逐步核对校验值，请阅读双语[手动安装说明](docs/MANUAL_INSTALL.md)。

首次启动的 TUI 会完成全部配置：语言、主题、授权工作区、监听地址、公网 URL、限制、Apps connector key 和 Actions token。不需要 `.env`，也不需要手动修改配置文件。

### 第二次及以后快速启动

重新打开一个终端、PowerShell 或命令提示符窗口，直接输入安装器为当前用户注册的全局命令。启动器通过版本化 `releases/<版本>` 目录和原子的 `current` 指针定位当前二进制。已经安装 GitHub `v1.0.1`、开发过程中的中间源码版本或旧二进制版本的用户，直接再次运行上面的 `v0.1.0` 命令即可无损迁移；用户配置、凭据、workspace、session、消息和历史不会被删除。

```text
myterminal
```

MyTerminal 会继续使用此前通过 TUI 保存的配置。如果 ChatGPT 通过临时 Quick Tunnel 接入，还需要单独重新启动隧道；它的随机公网 URL 可能发生变化。

### 从源码安装

如果已经安装 Bun 1.3 或以上版本：

```bash
git clone https://github.com/epslkslsksndnsjs-lab/myterminal.git
cd myterminal
bun install --frozen-lockfile
bun run dev
```

## 选择连接方式

| 连接 | 适用场景 | MyTerminal 显示的 endpoint |
| --- | --- | --- |
| GPT Actions | 为自定义 GPT 配置 OpenAPI Action。 | `https://你的域名/openapi.json` |
| ChatGPT Apps | 符合条件的工作区支持自定义 MCP app/connector。 | `https://你的域名/mcp/<隐藏的-connector-key>` |

一个 GPT 不能同时使用 Apps 和 Actions。Actions 用户请阅读隐私安全的[中文完整教程](docs/ACTIONS_SETUP.zh-CN.md)或[英文教程](docs/ACTIONS_SETUP.md)，其中包括 HTTPS 隧道、schema 导入、Bearer 认证、GPT 配置、预览测试和常见报错。

## 按连接方式区分的工具接口

GPT Actions 始终只看到三个稳定 facade 操作：

- `extension_discover`：了解身份、具体工具、schema 和扩展注册方式；
- `extension_call`：调用工作区、Git、session、消息或自定义具体工具；
- `extension_register`：验证、upsert 或移除声明式扩展。

稳定的 Actions 小接口避免导入的 OpenAPI 配置随工具增加而膨胀，具体能力仍可按需发现。operation ID 使用 camelCase（`extensionDiscover`、`extensionCall`、`extensionRegister`），语义相同。

ChatGPT Apps 同时暴露通用 `extension_call` / `extension_register` 能力和窄接口 MCP 工具。通用 facade 将任意命令、覆盖写入、patch 和自定义扩展保留为产品基础能力；直接工具为常用 session、读取、Git、消息、轮询与 Blob 操作提供更小的 schema，但不取代通用入口。Apps 可用 `blob_create` 暂存 UTF-8 或 base64 内容；`blob_write_file` 会创建缺失文件、把内容相同的已有文件视为幂等成功，并拒绝覆盖内容不同的已有文件。需要覆盖时仍可使用 `extension_call` → `write_file` 或 `apply_patch`。

```text
ChatGPT
  └─ extensionCall
       ├─ tool: session_register
       ├─ input: { mode: "root", name: "main" }
       └─ identity: { sessionId, sessionToken }  # bootstrap 后
```

使用项目提供的 [GPT 预设指令](docs/GPT_INSTRUCTIONS.zh-CN.md)避免 API 分层错误；向普通用户提供[短提示词手册](docs/PROMPT_PLAYBOOK.zh-CN.md)，不需要长篇提示词。

## 可审计协作

MyTerminal session 是工作上下文，不是 ChatGPT 对话 ID。

- 新任务通过 `session_register(mode=root)` 创建并领取 root。
- Root 可以用结构化任务包创建多个直接子 session；子 session 不得创建孙 session。任务应按领域、专家能力和可并行工作量拆分，不能把一个大型目标整体交给单个子 session。
- 协作是主动的：在范围内且不会产生冲突时，session 可以直接帮助其他 session 完成部分工作，并通过永久消息交接可纳入成果。
- `session_inherit` 使用一次性 claim code 领取 handoff/released/revoked 的未完成工作；同一 ChatGPT 对话因中断变 stale 时，可用之前的 sessionToken 重新领取原 session。
- Completed 工作不可变。续作必须创建同级 `session_register(...continuesSessionId)`，不能调用 `session_inherit`。
- session 状态更新优先级最高。可选的 Actions 长任务增强 Harness **默认关闭**，因此不会改变核心 session harness。设置页提供日常测试建议使用的 `adaptive`（1–3 条调用），以及本次 A/B 使用的诊断模式 `next-call` 和 `lookahead-3`。增强模式会拒绝顺序不符的调用，并在每次确认完成后返回下一条；切换模式后，活动 session 会收到 `requirements_changed` 事件，要求模型重新 discover 工具约束。
- 可选的**非阻塞任务**也默认关闭，并且与 Actions Harness 相互独立。开启后，普通调用超过 200ms 会脱离当前请求、在本机继续运行并返回 `taskId`，`task_poll` 可读取进度；完成结果保存在有数量、字节与时限上界的缓存中。关闭时，调用会一直连接到完成或超时。
- Root 只有在所有直属子 session 终态、且所有子消息和事件都已审阅后才能完成。被阻止的完成请求会返回子 session 时间戳、最后活动、最近操作、消息时序和 `mustContinue` 指引。
- 消息永久保存。AI 消息保留当前认证 session 身份；TUI 用户手动发送的消息明确标记为 `user`。读取消息时会返回发送/观察时间、消息年龄、发送后的审计操作和延迟/滞后提示。
- 追加式 JSONL 历史记录任务包、checkpoint、消息、状态事件和脱敏工具审计。

## TUI 用户控制面板

七个全屏页面分别是：概览、会话、消息、差异、扩展、设置和日志。

![MyTerminal 概览](docs/assets/tui/overview-zh-CN.svg)

- macOS/Linux 的鼠标滚轮和所有平台的键盘滚动由 OpenTUI ScrollBox viewport 处理；Windows 默认兼容模式不捕获鼠标。
- 拖动框选由 renderer 管理，通过 OSC 52 和系统剪贴板复制。
- Continuation 保留在一个逻辑 session 卡片内；委派子项像目录一样缩进，并保留 phase/presence 颜色。
- Enter 可打开完整 session 历史或双向消息对话。
- Diff 展示 staged、unstaged 和 untracked 工作区变化。
- Logs 使用统一生命周期展示 Apps 与 Actions 调用。调用发起后立即显示来源、工具名、脱敏后的完整参数、开始时间和 `running`；返回后在同一条逻辑记录中补充脱敏后的完整结果、耗时以及 `completed`、`failed` 或 `timeout`。
- 所有设置和凭据轮换都在 TUI 内完成。有限选项使用键盘/鼠标选择器；自由文本在首次输入时替换预填值，并支持 `Ctrl+U` 一键清空。按住 `V` 显示凭证；停止按键重复后会在 450ms 的 fail-closed 截止时间内隐藏，切换页面或打开表单会立即隐藏。

输入优先级固定为：模态框 → 当前表单控件 → 当前页面 → 全局快捷键。OpenTUI 负责屏幕生命周期、可用时的鼠标解析、布局、换行、增量绘制和终端恢复；Windows 默认使用主屏兼容配置。

## 安全与隐私

MyTerminal 以本地运行为主，没有项目遥测。所选工作区是真实的读写安全边界：请使用专用项目，检查 Diff 和 Logs，保持凭据隐藏，并在不需要公网访问时停止隧道。

- 连接凭据保存在操作系统用户配置目录；
- 只持久化 session token 的哈希；
- 持久化的调用参数与返回结果会清除 identity、authorization、claim code、credential、secret、password、API key、消息正文、content 和 URL 中的敏感查询参数；
- 只有 TUI 用户能够永久删除 session 与历史。

请阅读[隐私说明与部署模板](docs/PRIVACY.zh-CN.md)。发布带 Actions 的公开 GPT 时，隐私政策必须准确覆盖发布者自己的 endpoint 和数据流。

漏洞请按照 [SECURITY.md](SECURITY.md) 的私密流程报告，不要在包含凭据或私有源码的公开 Issue 中提交。

## 文档地图

| 文档 | 中文 | English |
| --- | --- | --- |
| GPT Actions 完整配置 | [打开](docs/ACTIONS_SETUP.zh-CN.md) | [Open](docs/ACTIONS_SETUP.md) |
| 推荐 GPT 预设指令 | [打开](docs/GPT_INSTRUCTIONS.zh-CN.md) | [Open](docs/GPT_INSTRUCTIONS.md) |
| 特定场景短提示词 | [打开](docs/PROMPT_PLAYBOOK.zh-CN.md) | [Open](docs/PROMPT_PLAYBOOK.md) |
| 隐私与部署模板 | [打开](docs/PRIVACY.zh-CN.md) | [Open](docs/PRIVACY.md) |
| 手动/离线安装 | [打开](docs/MANUAL_INSTALL.md#中文说明) | [Open](docs/MANUAL_INSTALL.md) |
| 架构与资源归属 | — | [Open](docs/architecture.md) |

## 开发与验证

要求 Bun 1.3 或以上版本。

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run dev
```

测试覆盖 OpenAPI 3.1、Actions/Apps 身份、控制权接管、固定 checkpoint 计时、父子完成审计、事件 ACK、订阅、永久历史、脱敏、迁移、删除、continuation、OpenTUI 滚轮和拖动框选。

首次 TUI 配置完成后，可以无界面运行：

```bash
bun run build
bun run start -- --headless
```

## 更新

MyTerminal 会在 TUI 启动时检查 GitHub 最新发行版。设置页会显示当前版本和最新版本；有新版本时按 `U` 可一键安装。更新器下载当前平台的预编译二进制与 SHA-256，安装到新的版本目录，再原子切换 `current` 指针；失败时保留原版本并自动回滚。Git 源码工作区不会被一键更新覆盖。完整迁移和后续更新说明见 [v0.1.0 发布说明](RELEASE_NOTES.md)。

工作区状态迁移采用可重复执行的增量合并：现有目标状态、旧全局状态、`state.migrated` 和工作区 `.myterminal` 会按稳定 ID 合并，session 历史文件会去重并完整保留。
## 共享端口与工作区路由

多个 MyTerminal 进程可以在 Apps connector key 和 Actions token 相同的前提下共用同一个 `host:port`。每个进程仍保留独立的 workspace、状态、session、历史和日志。端口组会选出一个公共网络 leader，其余成员仅监听本机回环端口；leader 退出后，其他成员会自动接管公共端口。

在共享端口下，`extension_discover` 会列出当前活动的 workspace ID。新建 root session 时必须在 `session_register` 的 input 中传入 `workspaceId`；后续请求按 MyTerminal session identity 路由，Apps 也可继续使用已验证的 `openai/session` 绑定。同一个 workspace 不允许被两个进程同时运行。若端口由非 MyTerminal 程序占用，仍进入 kill、换端口或取消的处理流程。不同端口形成相互独立的端口组，聚合日志也不会跨端口混合。
### macOS 被动锁屏保护

设置页提供仅限 macOS 的被动锁屏控制，支持 `arm`、`standby` 和 `off` 三种操作。选择 `arm` 后，程序会保持显示器唤醒、显示全屏保护遮罩，并在首次键盘或鼠标输入时发送系统 `Control–Command–Q` 锁屏快捷键。锁屏后 helper 不退出，而是进入 `standby`：释放防睡眠断言和输入监听，用户可以正常使用电脑；之后可再次选择 `arm`，或选择 `off` 彻底关闭 helper。只有当最后一个 MyTerminal 进程退出时才会终止全局 helper；关闭任意单个 workspace runtime 不会影响仍在运行的其他进程。

该功能目前仅支持 macOS。它需要为启动 MyTerminal 的终端或宿主进程（例如 Terminal、iTerm2）授予“无障碍”权限；部分 macOS 版本也可能显示 `MyTerminal Passive Lock`。权限窗口和设置页会明确说明所需权限及授权对象。

### 集群更新

安装更新不会终止正在运行的 TUI 进程。现有 Apps/Actions 流量会继续由内存中的旧代码处理，workspace 状态仍保存在磁盘。请逐个重启成员以切换到已安装版本，并最后重启当前网络 leader，以减少端口接管时的短暂中断。不同应用版本只有在集群协议版本相同时才允许共存；协议不兼容会在加入前被拒绝，避免混合版本破坏状态或路由。占用端口的旧版非集群 MyTerminal 会被视为普通端口冲突，不能直接加入；测试时应使用其他端口，或先把旧进程重启到支持集群的版本。
