# Security policy / 安全策略

## Supported version

Security fixes are applied to the latest stable release. Upgrade before reporting a behavior that may already be fixed.

安全修复只应用于最新稳定版本。报告前请先升级，确认问题没有在新版本中修复。

## Report a vulnerability

Use GitHub's private vulnerability-reporting or security-advisory flow for this repository. Do not open a public issue containing an Actions token, Apps connector key, session token, claim code, private source, or a working public tunnel URL.

请使用本仓库的 GitHub 私密漏洞报告或 Security Advisory。不要在公开 Issue 中提交 Actions token、Apps connector key、session token、claim code、私有源码或仍可访问的公网隧道 URL。

Include the affected version, operating system, minimal reproduction, expected impact, and whether a credential or workspace file was exposed. Replace all live values with clearly marked placeholders.

请说明受影响版本、操作系统、最小复现、预期影响，以及是否暴露过凭据或工作区文件。所有有效值必须替换成明确的占位符。

## Operational boundary

MyTerminal intentionally grants tool access to one user-selected workspace. Keep the bind address on `127.0.0.1`, use Bearer authentication for Actions, stop tunnels when unused, review Diff and Logs, and rotate credentials after suspected exposure.

MyTerminal 会有意授予工具对用户所选工作区的访问权。监听地址应保持 `127.0.0.1`，Actions 必须使用 Bearer 认证，不使用隧道时应停止它，并通过 Diff/Logs 审计；怀疑泄露后应立即轮换凭据。
