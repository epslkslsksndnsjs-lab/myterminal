# MyTerminal v0.1.3

MyTerminal v0.1.3 catches the public release up to the current `main` branch — **290 commits ahead of v0.1.2**. This release folds in the open-source wrap-up, the security rework, and the CI stabilization work that landed after v0.1.2, and re-points the installers to the latest tagged build.

## What changed since v0.1.2

- **Release discipline fix:** the one-line installers (`install-macos.sh`, `install-linux.sh`, `install-windows.ps1`) now default to `v0.1.3`, so a fresh install pulls the current snapshot instead of the early v0.1.2 build.
- **Open-source wrap-up:** internal dev docs removed ahead of public release, bilingual documentation and agent-skill install paths finalized.
- **Security rework:** hardened installer verification, credential handling, and update rollback paths.
- **CI stabilization:** the release pipeline builds and smoke-tests every platform asset and the packaged installer before publishing.

## Install

macOS / Linux:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.3/scripts/install-macos.sh)"
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.3/scripts/install-linux.sh)"
```

Windows (PowerShell):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/epslkslsksndnsjs-lab/myterminal/v0.1.3/scripts/install-windows.ps1 | iex"
```

Existing installations migrate losslessly — re-run the matching command above. User settings, credentials, workspaces, sessions, messages, and history are preserved.

## Assets

Precompiled, SHA-256-verified standalone binaries for each platform:

- `myterminal-darwin-arm64.tar.gz`
- `myterminal-darwin-x64.tar.gz`
- `myterminal-linux-arm64.tar.gz`
- `myterminal-linux-x64.tar.gz`
- `myterminal-windows-x64.zip`

Each asset ships with a matching `.sha256` checksum file.
