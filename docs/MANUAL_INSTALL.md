# Manual installation and release-candidate verification

[中文说明](#中文说明)

Use this guide when you want to inspect every step, install from a locally supplied release candidate, or verify an asset before a public release. These commands do not create a Git tag, publish a GitHub Release, or upload an asset.

## Supported assets

| System | Asset |
| --- | --- |
| macOS Apple Silicon | `myterminal-darwin-arm64.tar.gz` |
| macOS Intel | `myterminal-darwin-x64.tar.gz` |
| Linux ARM64 | `myterminal-linux-arm64.tar.gz` |
| Linux x64 | `myterminal-linux-x64.tar.gz` |
| Windows x64 | `myterminal-windows-x64.zip` |

Every asset must have an adjacent `<asset>.sha256` file. The archive contains the compiled program; macOS archives also contain `mac-one-shot-awake-lock.swift`.
The x64 assets are compiled with Bun's baseline runtime so they do not require AVX-capable CPUs.

## Install a local candidate on macOS or Linux

1. Put the archive and checksum in one directory.
2. Inspect the matching installer in `scripts/`.
3. Run the installer with explicit local file URLs:

```bash
asset="/absolute/path/to/myterminal-linux-arm64.tar.gz"
installer="scripts/install-linux.sh"

# macOS example:
# asset="/absolute/path/to/myterminal-darwin-arm64.tar.gz"
# installer="scripts/install-macos.sh"

MYTERMINAL_ASSET_URL="file://${asset}" \
MYTERMINAL_CHECKSUM_URL="file://${asset}.sha256" \
MYTERMINAL_INSTALL_ONLY=1 \
bash "$installer"

myterminal --verify-installation
myterminal --version
myterminal
```

Use an absolute path without `..`. The installer verifies SHA-256, writes `~/MyTerminal/releases/v0.1.2`, atomically updates `~/MyTerminal/current`, and registers the launcher in the current user's PATH. Set `MYTERMINAL_HOME` or `MYTERMINAL_BIN_DIR` before running the command if you need different locations.

## Install a local candidate on Windows

Open PowerShell in the repository and run:

```powershell
$Asset = Resolve-Path "C:\absolute\path\myterminal-windows-x64.zip"
$Checksum = Resolve-Path ($Asset.Path + ".sha256")
$env:MYTERMINAL_ASSET_URL = ([Uri]$Asset.Path).AbsoluteUri
$env:MYTERMINAL_CHECKSUM_URL = ([Uri]$Checksum.Path).AbsoluteUri
$env:MYTERMINAL_INSTALL_ONLY = "1"

& .\scripts\install-windows.ps1

myterminal --verify-installation
myterminal --version
myterminal
```

The installer verifies SHA-256, writes `%USERPROFILE%\MyTerminal\releases\v0.1.2`, atomically updates `current`, and adds its command-launcher directory to the user PATH. Open a new terminal if the current PowerShell process does not yet see `myterminal`.

## Verify without installing

On macOS or Linux:

```bash
shasum -a 256 -c myterminal-PLATFORM.tar.gz.sha256
tar -tzf myterminal-PLATFORM.tar.gz
mkdir -p /tmp/myterminal-candidate
tar -xzf myterminal-PLATFORM.tar.gz -C /tmp/myterminal-candidate
/tmp/myterminal-candidate/myterminal --verify-installation
```

On Linux, `sha256sum -c` may be used instead of `shasum -a 256 -c`.

On Windows:

```powershell
$Asset = Resolve-Path ".\myterminal-windows-x64.zip"
$Expected = ((Get-Content -Raw ($Asset.Path + ".sha256")).Trim() -split '\s+')[0].ToLowerInvariant()
$Actual = (Get-FileHash -Algorithm SHA256 $Asset).Hash.ToLowerInvariant()
if ($Expected -ne $Actual) { throw "SHA-256 verification failed" }
Expand-Archive $Asset -DestinationPath .\candidate -Force
& .\candidate\myterminal.exe --verify-installation
```

## Recovery

- Re-running the same installer repairs an incomplete versioned layout.
- The active release and one previous release are retained.
- Settings, credentials, workspace state, sessions, messages, history, and logs live outside the program directory.
- A Git source checkout is never overwritten by the binary installer.

# 中文说明

当你希望逐步检查安装过程、安装本地提供的候选包，或在公开发布前验证资产时，请使用本页。下面的命令不会创建 Git tag、不会创建 GitHub Release，也不会上传文件。

## 支持的候选包

| 系统 | 资产文件 |
| --- | --- |
| macOS Apple Silicon | `myterminal-darwin-arm64.tar.gz` |
| macOS Intel | `myterminal-darwin-x64.tar.gz` |
| Linux ARM64 | `myterminal-linux-arm64.tar.gz` |
| Linux x64 | `myterminal-linux-x64.tar.gz` |
| Windows x64 | `myterminal-windows-x64.zip` |

每个资产旁边必须有 `<资产名>.sha256`。压缩包内包含编译后的程序；macOS 包还包含 `mac-one-shot-awake-lock.swift`。
三个 x64 资产使用 Bun baseline 运行时编译，不要求 CPU 支持 AVX。

## 在 macOS 或 Linux 安装本地候选包

把资产和校验文件放在同一目录，检查 `scripts/` 中对应的安装器，然后执行：

```bash
asset="/绝对路径/myterminal-linux-arm64.tar.gz"
installer="scripts/install-linux.sh"

# macOS 示例：
# asset="/绝对路径/myterminal-darwin-arm64.tar.gz"
# installer="scripts/install-macos.sh"

MYTERMINAL_ASSET_URL="file://${asset}" \
MYTERMINAL_CHECKSUM_URL="file://${asset}.sha256" \
MYTERMINAL_INSTALL_ONLY=1 \
bash "$installer"

myterminal --verify-installation
myterminal --version
myterminal
```

请使用不含 `..` 的绝对路径。安装器会校验 SHA-256，把程序写入 `~/MyTerminal/releases/v0.1.2`，原子更新 `~/MyTerminal/current`，并注册当前用户的命令启动器。如需改变目录，请在运行前设置 `MYTERMINAL_HOME` 或 `MYTERMINAL_BIN_DIR`。

## 在 Windows 安装本地候选包

在仓库目录打开 PowerShell：

```powershell
$Asset = Resolve-Path "C:\绝对路径\myterminal-windows-x64.zip"
$Checksum = Resolve-Path ($Asset.Path + ".sha256")
$env:MYTERMINAL_ASSET_URL = ([Uri]$Asset.Path).AbsoluteUri
$env:MYTERMINAL_CHECKSUM_URL = ([Uri]$Checksum.Path).AbsoluteUri
$env:MYTERMINAL_INSTALL_ONLY = "1"

& .\scripts\install-windows.ps1

myterminal --verify-installation
myterminal --version
myterminal
```

安装器会校验 SHA-256，把程序写入 `%USERPROFILE%\MyTerminal\releases\v0.1.2`，原子更新 `current`，并把命令启动器目录加入用户 PATH。如果当前 PowerShell 尚未识别新命令，请重新打开终端。

## 恢复说明

- 再次运行同一安装器可以修复不完整的版本化安装目录。
- 安装器保留当前版本和一个旧版本用于回退。
- 设置、凭据、工作区状态、session、消息、历史和日志位于程序目录之外。
- 二进制安装器不会覆盖 Git 源码工作区。
