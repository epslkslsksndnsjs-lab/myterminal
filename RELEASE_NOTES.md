# MyTerminal v0.1.0

MyTerminal v0.1.0 focuses on long-task continuity, optional non-blocking execution, bounded history performance, Apps capability completeness, and Windows process reliability. Existing settings, credentials, workspaces, sessions, messages, extensions, and history are preserved.

> [!IMPORTANT]
> **Known Windows limitation:** the supported PowerShell TUI path is keyboard-only compatibility mode. Mouse capture is disabled by default because it can become unresponsive or freeze under Windows PowerShell and PowerShell 7. All pages, forms, and exact session selectors remain keyboard-operable with arrows, `PgUp/PgDn`, `Home/End`, `Enter`, and page shortcuts. `MYTERMINAL_WINDOWS_TUI_MODE=mouse` is experimental and is not recommended for critical work.

## Highlights

- The optional Actions long-task harness is **off by default**. `adaptive` enforces 1–3 exact next calls, while `next-call` and `lookahead-3` provide deterministic diagnostic modes. Mode changes emit `requirements_changed`; discovery returns the current contract.
- Optional non-blocking tasks are independent and **off by default**. When enabled, calls exceeding the 200ms response budget continue locally and return a `taskId`; `task_poll` follows them to a terminal result.
- Background results are bounded by a 30-minute lifetime, 100 retained tasks, and 24 MiB of serialized responses. Runtime shutdown cancels owned command trees and closes their audit records.
- ChatGPT Apps keeps the complete generic `extension_call` and `extension_register` facade, including arbitrary commands, overwrite-capable writes, patches, and custom extensions. Narrow direct MCP tools and content-addressed Blob staging remain available alongside it.
- Bootstrap Actions calls now accept an explicit `identity:null` as absent while continuing to reject malformed authenticated identities such as `identity:{}`.
- History uses sparse, stat-validated indexes and bounded range reads. Inbox, TUI message snapshots, session detail, and logs return bounded windows instead of repeatedly materializing all persisted data.
- Tool audits retain one logical record from `running` to `completed`, `failed`, or `timeout`. Background execution updates that same record rather than creating duplicates.
- Windows shell commands use private one-shot batch entrypoints so nested quotes retain their meaning. Each command runs in an independent process group; timeout and shutdown wait for tree termination without killing the MyTerminal runtime.
- Windows TUI compatibility no longer depends on `WT_SESSION`. It uses main-screen rendering at 20 FPS, disables the native output thread and Kitty keyboard negotiation, and provides complete keyboard navigation.
- Obsolete review reports, resolved issue notes, and dated acceptance documents were removed. README, Actions setup, GPT Instructions/Introduction, architecture, privacy, and manual installation documents now describe the shipping behavior.

## Performance verification

The release regression workload on the release-development host produced:

- 100,000 history entries: sparse index plus newest 200 entries in about 59.6ms, approximately 5.2 MiB RSS growth;
- 5,000 inbox messages: newest 50 messages and observations in about 82.6ms;
- 5,000 source messages: bounded 500-message TUI snapshot in about 0.65ms.

Exact timings vary by host. The release gates enforce bounded returned collections and guard against sustained memory growth.

## Windows verification

Windows 11 ARM64 under Parallels, running the x64 baseline binary through the compatibility layer, passed separate automated acceptance runs from:

- Windows PowerShell 5.1.26100.7920;
- PowerShell 7.6.3.

Both runs covered executable verification, headless health, Actions session registration, quoted commands, forced PowerShell child-tree timeout, timeout response semantics, and a post-timeout runtime health check. The TUI is usable in the supported keyboard compatibility mode; the mouse limitation above remains intentional and documented.

## Binary release assets

The release workflow builds, tests, packages, installs, and verifies:

- macOS Apple Silicon (`darwin-arm64`)
- macOS Intel (`darwin-x64`)
- Linux ARM64 (`linux-arm64`)
- Linux x64 (`linux-x64`)
- Windows x64 (`windows-x64`)

Each archive has a matching SHA-256 file. The x64 assets use Bun baseline targets for older CPU compatibility.

## One-command update

### macOS

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com//myterminal/v0.1.0/scripts/install-macos.sh)"
```

### Linux

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com//myterminal/v0.1.0/scripts/install-linux.sh)"
```

### Windows PowerShell

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com//myterminal/v0.1.0/scripts/install-windows.ps1 | iex"
```

The installers preserve configuration and workspace state, install into a versioned release directory, verify the downloaded asset and installed executable, and atomically update the `current` pointer. Running processes continue using their loaded version until restarted; in a shared-port group, restart members one at a time and the current leader last.

## Verification

The release candidate passed TypeScript checking, 88 automated tests, documentation/link checks, the bounded performance regression, standalone macOS and Windows x64 builds, and the PowerShell 5.1/7.6.3 VM checks above. The tag-triggered GitHub workflow repeats the full test and packaged-installer suite on all five platform runners before publishing assets.

## 中文说明

MyTerminal v0.1.0 重点完善长任务持续执行、可选非阻塞任务、有界历史性能、Apps 完整能力以及 Windows 进程可靠性。升级会保留已有配置、凭据、工作区、session、消息、扩展和历史。

> [!IMPORTANT]
> **Windows 已知限制：** PowerShell TUI 正式支持的是纯键盘兼容模式。鼠标捕获默认关闭，因为它在 Windows PowerShell 与 PowerShell 7 中可能无响应或导致界面卡死。所有页面、表单和精确 session 选择都可使用方向键、`PgUp/PgDn`、`Home/End`、`Enter` 与页面快捷键完成。`MYTERMINAL_WINDOWS_TUI_MODE=mouse` 仅供实验，不建议用于关键任务。

本版本主要变化：

- Actions 长任务增强 Harness 默认关闭。`adaptive` 强制 1–3 个准确后续调用，`next-call` 与 `lookahead-3` 用于确定性诊断；切换模式后会发送 `requirements_changed`，模型应重新 discovery 当前合约。
- 非阻塞任务是独立开关且默认关闭。开启后，超过 200ms 的调用会在本机继续并返回 `taskId`，由 `task_poll` 轮询到终态；结果缓存具有 30 分钟、100 项和 24 MiB 三重上限。
- Apps 保留完整通用 facade，包括任意命令、覆盖写入、patch 和自定义扩展，同时继续提供窄接口工具与内容寻址 Blob。
- Actions bootstrap 兼容显式 `identity:null`，但认证调用仍会拒绝 `identity:{}` 等无效身份。
- 历史、inbox、TUI 消息快照、session 详情和日志都改为有界读取，避免数据增长后反复加载全部状态。
- Windows 命令通过私有的一次性批处理入口保留嵌套引号，并在独立进程组中运行；超时和关闭会等待命令树终止，不再误伤 Runtime。
- Windows TUI 不再根据 `WT_SESSION` 自动切换高风险路径。默认使用主屏、20 FPS、关闭原生输出线程和 Kitty 协议，并补齐纯键盘导航。
- 已清理旧审查报告、已解决 issue 记录与过期验收文档；README、Actions 教程、GPT Instructions/Introduction、架构、隐私和手动安装说明均与当前行为一致。

发布候选已通过 88 项自动测试、文档链接检查、10 万历史/5000 消息性能回归、macOS 与 Windows x64 独立二进制构建，以及 Parallels Windows 11 中 Windows PowerShell 5.1 和 PowerShell 7.6.3 的独立自动验收。GitHub tag 工作流会再次在五个平台 runner 上运行完整测试、安装器演练并生成带 SHA-256 的发布资产。
