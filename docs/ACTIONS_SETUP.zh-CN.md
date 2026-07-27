# 将 MyTerminal 配置为 GPT Action

[English](ACTIONS_SETUP.md) · [推荐 GPT 预设指令](GPT_INSTRUCTIONS.zh-CN.md) · [短提示词手册](PROMPT_PLAYBOOK.zh-CN.md) · [隐私说明](PRIVACY.zh-CN.md)

本教程从一台没有开发环境的新电脑开始，直到完成一个可测试的私有 GPT。教程基于 MyTerminal 0.1.2 和 ChatGPT 网页编辑器。OpenAI 当前向付费用户提供 GPT 创建功能，具体还受工作区角色、策略和 Actions 域名限制。一个 GPT 只能选择 **Apps 或 Actions，不能同时使用两者**。使用 ChatGPT 的 Pro mode 时不能使用 Actions，因此 Actions GPT 的编辑器会提供兼容的非 Pro 模型。参见 OpenAI 的 [GPT 创建说明](https://help.openai.com/en/articles/8554397-creating-a-gpt)和 [Actions 配置说明](https://help.openai.com/en/articles/9442513)。

> ChatGPT 截图来自本地 HTML 存档的隐私安全裁剪，只保留通用配置界面；不含聊天正文、账户身份、真实地址或真实凭据。ChatGPT 的具体标签以后可能调整。

## 完整路径

```mermaid
flowchart LR
  A["本机启动 MyTerminal"] --> B["建立 HTTPS 隧道"]
  B --> C["在 TUI 设置公网 URL"]
  C --> D["创建 GPT"]
  D --> E["导入 /openapi.json"]
  E --> F["设置 Bearer 身份验证"]
  F --> G["粘贴 GPT 预设指令"]
  G --> H["测试身份与 checkpoint"]
```

## 1. 安装并启动 MyTerminal

无需提前安装 Git、Node.js 或 Bun。

### macOS

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.2/scripts/install-macos.sh)"
```

### Linux

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.2/scripts/install-linux.sh)"
```

### Windows PowerShell

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.2/scripts/install-windows.ps1 | iex"
```

安装脚本会下载与当前平台匹配的独立可执行文件和 SHA-256 文件，完成校验后写入版本化 release 目录，把 `myterminal` 注册到当前用户的 PATH，然后打开 TUI。它不会安装 Git、Node.js、Bun 或包依赖。如果组织不允许直接运行远端脚本，请先打开仓库中的脚本检查内容。第二次及以后只需重新打开终端并输入：

```text
myterminal
```

首次启动时在 TUI 中完成以下配置：

1. 选择 `zh-CN` 或 `en`，并选择主题；
2. 选择允许 ChatGPT 操作的项目目录；
3. 除非端口冲突，否则保持监听地址 `127.0.0.1`、端口 `3210`；
4. 公网 URL 暂时保持 local；
5. 接受或调整输出与命令限制；
6. 保留自动生成的 Apps connector key 和 Actions token。

以后所有配置都在 **6 设置** 页面按 `c` 修改，不要手动编辑配置文件。

![MyTerminal 概览](assets/tui/overview-zh-CN.svg)

视觉检查：顶部应显示“运行中”；概览页面只显示三个 facade 工具，并隐藏连接凭据。

![MyTerminal 设置](assets/tui/settings-zh-CN.svg)

设置页面是工作区、监听地址、公网 URL、限制、隐藏凭据、可选**长任务 Harness**与可选**非阻塞任务**的唯一配置入口。两项功能默认都关闭且互相独立；`adaptive` 使用灵活的 1–3 条计划，`next-call` / `lookahead-3` 用于严格 A/B 诊断。切换任一设置都会重启 MyTerminal 并生成匹配的 OpenAPI schema；Harness 变化还会向活动 session 发出 `requirements_changed`。模型应重新 discover，并在 GPT 编辑器中重新导入 `/openapi.json`。

## 2. 为 Actions 提供 HTTPS 地址

ChatGPT 无法访问 `127.0.0.1`。私有测试时，可以在第二个终端运行 Cloudflare Quick Tunnel。Cloudflare 明确说明 Quick Tunnel 只适合开发和测试；长期使用请改用 named tunnel 和固定域名。

### macOS 无 Homebrew 安装 cloudflared

```bash
case "$(uname -m)" in
  arm64) CF_ARCH=arm64 ;;
  x86_64) CF_ARCH=amd64 ;;
  *) echo "Unsupported macOS architecture"; exit 1 ;;
esac
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${CF_ARCH}.tgz" -o /tmp/cloudflared.tgz
tar -xzf /tmp/cloudflared.tgz -C /tmp
sudo install /tmp/cloudflared /usr/local/bin/cloudflared
cloudflared --version
```

如果已经安装 Homebrew，官方的简短命令是 `brew install cloudflared`。

### Windows PowerShell 安装 cloudflared

```powershell
$CloudflaredDir = Join-Path $env:LOCALAPPDATA "cloudflared"
New-Item -ItemType Directory -Force -Path $CloudflaredDir | Out-Null
Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile (Join-Path $CloudflaredDir "cloudflared.exe")
& (Join-Path $CloudflaredDir "cloudflared.exe") --version
```

启动隧道；只有 TUI 显示了其他端口时才替换 `3210`：

```bash
cloudflared tunnel --url http://127.0.0.1:3210
```

Windows 如果 executable 不在 `PATH`：

```powershell
& "$env:LOCALAPPDATA\cloudflared\cloudflared.exe" tunnel --url http://127.0.0.1:3210
```

复制输出的 `https://...trycloudflare.com` 地址。在 MyTerminal 中进入 **6 设置**，按 `c`，把 **公网 HTTPS URL** 设置为该地址并完成表单。MyTerminal 会安全重启并使用新的 base URL。Cloudflare [Quick Tunnel 官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)介绍了随机域名和测试限制。

> MyTerminal 和 `cloudflared` 必须同时保持运行。Quick Tunnel 重启后 URL 会变化；变化后需要更新 TUI 公网 URL，并重新导入 Action schema。

## 3. 创建并描述 GPT

在桌面浏览器打开 [chatgpt.com/gpts/editor](https://chatgpt.com/gpts/editor)，进入配置视图，填写清楚的名称和描述。

![GPT 配置字段](assets/actions/gpt-config-zh-CN.jpg)

1. **名称：** `MyTerminal Developer`
2. **描述：** `通过可审计 MyTerminal session、协作消息、checkpoint 和扩展处理一个本地项目。`
3. **指令：** 粘贴[推荐 GPT 预设指令](GPT_INSTRUCTIONS.zh-CN.md)中的完整代码块。
4. **对话开场白：** 从[短提示词手册](PROMPT_PLAYBOOK.zh-CN.md)选择两到三条。

## 4. 创建 Action

滚动到 **操作（Actions）**，选择 **创建新操作**。

![创建新的 GPT Action](assets/actions/add-action-zh-CN.jpg)

Actions 界面有意只暴露三个操作：

| Action 操作 | 语义 |
| --- | --- |
| `extensionDiscover` | 建立身份前返回引导；认证后发现具体工具目录。 |
| `extensionCall` | 调用 `session_register`、`read_file`、`message_send` 等具体工具。 |
| `extensionRegister` | 验证/upsert/remove 声明式扩展；绝不用于创建 session。 |

## 5. 导入 OpenAPI schema

选择 **从 URL 导入**，输入：

```text
https://你的公网域名/openapi.json
```

Quick Tunnel 示例：

```text
https://random-words.trycloudflare.com/openapi.json
```

![导入 OpenAPI schema](assets/actions/import-schema-zh-CN.jpg)

当前文档是 OpenAPI `3.1.0`，`components.schemas` 是 JSON 对象。编辑器应显示上面的三个 operation ID。不要在这里填写 Apps MCP URL，也不要附加隐藏的 Apps connector key。

## 6. 配置 Bearer 身份验证

在 Action 编辑器中打开 **身份验证**：

1. 选择 **API 密钥**；
2. 粘贴 MyTerminal 设置页显示的 **Actions token**；
3. 选择 **Bearer**；
4. 保存。

![配置 Actions Bearer token](assets/actions/authentication-zh-CN.jpg)

只有确实要查看凭据时才在 MyTerminal 设置页按 `v`。截图使用 `[HIDDEN]`；绝不要提交真实 token。

三个值有完全不同的用途：

| 值 | 放置位置 | 用途 |
| --- | --- | --- |
| Actions token | GPT 编辑器 → 身份验证 → API 密钥/Bearer | 对三个 facade HTTP 端点进行传输层认证。 |
| `sessionId + sessionToken` | 认证 Action 调用顶层的 `identity` | 标识当前可审计 MyTerminal 工作 session。 |
| `claimCode` | 一次 `session_inherit` 调用的 `input` | 一次性领取/交接；不是可重复使用的 token。 |

不要把 session token 或 claim code 填入 GPT 编辑器的身份验证字段。

## 7. 在预览中测试

测试阶段保持 GPT 私有。发送：

```text
为检查这个项目建立新的 root session。报告工作区概况，然后 checkpoint 为 waiting。
```

预期顺序：

1. 完全省略 `identity` 键的 `extensionDiscover` 只返回 bootstrap 引导；
2. `extensionCall` 用 `input.mode="root"` 调用 `session_register`，同样不包含 `identity` 键；
3. GPT 在内部保存返回的 `sessionId + sessionToken`；
4. 认证后的 discover 暴露具体工具目录；
5. `workspace_info` 通过带顶层 `identity` 的 `extensionCall` 执行；
6. 回复结束前，`session_checkpoint` 写入 summary 和 `waiting` phase。

MyTerminal 日志页会把每次调用显示为一条持续更新的记录：来源（`ACTIONS`）、工具名、脱敏后的完整参数、`running` 状态和开始时间；返回后在同一记录中显示脱敏后的完整结果、耗时以及 `completed`、`failed` 或 `timeout` 状态。

然后在设置页的三种增强模式下分别测试未完成任务续执行：

```text
检查项目三个不同部分。第一次观察后记录 working checkpoint，然后不要向我发送中间回复，继续工作。
```

`adaptive` 的 working checkpoint 可包含 1–3 项 `nextCalls`：步骤可预测时优先给 3 项，测试结果或后台任务可能迫使重排时只给 1 项。`next-call` 必须恰好 1 项，`lookahead-3` 必须恰好 3 项。增强模式都会返回 `continuation.mustContinue=true` 和准确 `nextCall`，GPT 必须立即调用；顺序不符会返回 `NEXT_CALL_REQUIRED`。另行开启**非阻塞任务**后，工具超过 200ms 才会返回 `status=running` 与 `taskId` 并释放 HTTP 请求；关闭时会正常等待。最后把两项都切回关闭，确认核心行为不受影响。

继续测试协作：

```text
委派一个只读的项目结构检查，并给我可粘贴到第二个 ChatGPT 对话的交接提示。
```

把交接提示粘贴到另一个 GPT 对话。子项开始工作前必须调用 `session_inherit`。MyTerminal Sessions 页面应把 continuation 放在同一逻辑卡片内，并像目录一样缩进显示子 session。

![可审计 session 层级](assets/tui/sessions-zh-CN.svg)

## 8. 谨慎保存和分享

首次保存请选择 **仅自己**。OpenAI 可能会在 Action 执行前要求用户确认。如果以后通过链接分享或发布到 GPT Store，OpenAI 要求带 Actions 的 GPT 提供有效的隐私政策 URL。请根据你的实际运营方式修改[隐私模板](PRIVACY.zh-CN.md)，并放到稳定的公开 URL；仓库中的政策描述的是未托管的 MyTerminal 软件，不能自动覆盖每一个第三方部署。

## 故障排查

| 现象 | 处理方法 |
| --- | --- |
| `Input should be '3.1.1' or '3.1.0'` | 更新 MyTerminal，导入准确的 `/openapi.json` URL，并删除旧的手工 schema。 |
| `components.schemas ... is not an object` | 使用了旧版或被修改的 schema。MyTerminal 0.1.2 返回具体对象；从运行中的服务重新导入。 |
| `ApiTypeError: Expected identity to be a dict` | 重新导入 `/openapi.json` 并粘贴当前 GPT 指令。bootstrap 调用应省略 `identity` 键，不能发送 `identity:null` 或 `identity:{}`；更新到包含本兼容修复的构建后，显式 null 也会被视为未提供 bootstrap identity。 |
| `spec must be an object` | `extensionRegister` 需要顶层 `spec:{...}`。创建 session 应使用 `extensionCall` + `tool:"session_register"`。 |
| `input.name is required`、`input.to is required` 或 `input.body is required` | 把参数放入 `extensionCall.input`，例如 `{tool:"message_send", input:{to:"reviewer", body:"Ready"}, identity:{...}}`。 |
| `IDENTITY_REQUIRED` | 创建 root 或领取交接 session，然后在每个认证调用中携带返回的 identity。 |
| `INVALID_IDENTITY` | 若同一 ChatGPT 对话因中断变 stale，使用旧 sessionToken 调用 session_inherit 恢复原 session；若是 release/revoke/handoff，则从 TUI 获取新 claimCode。不要为同一未完成任务新建 root。 |
| `CHECKPOINT_REQUIRED` | 立即调用 `session_checkpoint`。`off` 模式可省略 nextCalls 并按普通流程继续；增强模式按 discovery 声明提供准确数量，并立即执行返回的 nextCall。 |
| `CONTINUATION_PLAN_REQUIRED` | 查看设置页的长任务 Harness：`adaptive` 接受 1–3 项，`next-call` 需要 1 项，`lookahead-3` 需要 3 项；切换后重新 discovery 即可，静态 OpenAPI schema 不需要重新导入。 |
| `NEXT_CALL_REQUIRED` | 执行返回的准确 nextCall；只有计划确实失效时，才能用 replanReason 和完整替代计划重新 checkpoint。 |
| 工具返回 `status=running` | 操作仍在本机继续。使用 taskId 调用 `task_poll`，直到 completed、failed 或 timeout；不能把快速返回当成任务完成。 |
| `CHILD_REVIEW_REQUIRED` | 检查返回的子项总结、消息和事件；完成或取消全部子项。 |
| Schema URL 无法访问 | 确认 MyTerminal 和隧道都在运行，然后在浏览器打开 `https://你的域名/health` 和 `/openapi.json`。 |
| HTTP 401 | 重新把 MyTerminal **Actions token** 填为 API Key → Bearer；不要使用 Apps connector key。 |

## 安全边界

GPT 可以通过 facade 写入所选工作区。请使用专用项目目录，通过 Diff 和 Logs 页面审计变更，保持凭据隐藏，并在不需要远程访问时停止隧道。Quick Tunnel 会把本机 HTTP 服务放到公开的随机域名，因此 Actions Bearer token 必不可少。
