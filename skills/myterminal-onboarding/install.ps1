# Installer for the myterminal-onboarding skill (Windows / PowerShell).
#
# Windows symlinks need elevation, so this creates a small .cmd shim instead of a
# symlink. The command name is the same as on posix: myterminal-onboard.
#
# Note: MyTerminal's build chain targets posix. On native Windows this skill can
# install itself and detect your environment, but the onboarding flow will hand you
# manual `setx` steps for the API key. WSL is the smoother path.
#
# See docs/adr/0043-myterminal-onboarding-skill.md (decisions D5, D6).

[CmdletBinding()]
param(
    [string[]]$Target,
    [switch]$All,
    [switch]$NoCommand,
    [switch]$DryRun,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

$SkillName   = 'myterminal-onboarding'
$CommandName = 'myterminal-onboard'
$SourceDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinDir      = Join-Path $env:USERPROFILE '.local\bin'

function Show-Usage {
    @"
Install the $SkillName skill.

USAGE
  .\install.ps1 [-Target <name|path>] [-All] [-NoCommand] [-DryRun]

TARGETS
  workbuddy   %USERPROFILE%\.workbuddy\skills   (default)
  claude      %USERPROFILE%\.claude\skills
  cursor      .\.cursor\skills                  (current project)
  codex       %USERPROFILE%\.codex\skills
  <path>      any directory you name

AFTER INSTALLING
  Run: $CommandName
  It detects your environment and writes nothing until you ask it to.
"@ | Write-Host
}

function Resolve-Target([string]$Name) {
    switch ($Name) {
        'workbuddy' { Join-Path $env:USERPROFILE '.workbuddy\skills' }
        'claude'    { Join-Path $env:USERPROFILE '.claude\skills' }
        'cursor'    { Join-Path (Get-Location) '.cursor\skills' }
        'codex'     { Join-Path $env:USERPROFILE '.codex\skills' }
        default     { $Name }
    }
}

function Invoke-Step([string]$Description, [scriptblock]$Action) {
    if ($DryRun) { Write-Host "[dry-run] $Description" } else { & $Action }
}

if ($Help) { Show-Usage; exit 0 }

$targets = @()
if ($Target) { $targets += $Target | ForEach-Object { Resolve-Target $_ } }
if ($All) {
    foreach ($name in @('workbuddy', 'claude', 'codex')) {
        $dir = Resolve-Target $name
        if (Test-Path (Split-Path -Parent $dir)) { $targets += $dir }
    }
    if (Test-Path (Join-Path (Get-Location) '.cursor')) { $targets += Resolve-Target 'cursor' }
}
if ($targets.Count -eq 0) { $targets = @(Resolve-Target 'workbuddy') }

if (-not (Test-Path (Join-Path $SourceDir 'SKILL.md')) -or
    -not (Test-Path (Join-Path $SourceDir 'scripts\onboard.mjs'))) {
    Write-Error "$SourceDir does not look like the skill folder (SKILL.md / scripts\onboard.mjs missing)."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node is required to run $CommandName but was not found on PATH."
}

$primaryInstall = $null

foreach ($skillsDir in $targets) {
    $dest = Join-Path $skillsDir $SkillName
    Write-Host "Installing -> $dest"
    Invoke-Step "mkdir $skillsDir" { New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null }
    Invoke-Step "remove $dest"     { if (Test-Path $dest) { Remove-Item -Recurse -Force $dest } }
    Invoke-Step "mkdir $dest"      { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
    Invoke-Step "copy skill files" {
        Copy-Item (Join-Path $SourceDir 'SKILL.md')   $dest
        Copy-Item (Join-Path $SourceDir 'README.md')  $dest
        Copy-Item (Join-Path $SourceDir 'scripts')    $dest -Recurse
        Copy-Item (Join-Path $SourceDir 'templates')  $dest -Recurse
    }
    if (-not $primaryInstall) { $primaryInstall = $dest }
}

if (-not $NoCommand) {
    $targetScript = Join-Path $primaryInstall 'scripts\onboard.mjs'
    $shimPath     = Join-Path $BinDir "$CommandName.cmd"
    Write-Host "Shim       -> $shimPath"
    Invoke-Step "mkdir $BinDir" { New-Item -ItemType Directory -Force -Path $BinDir | Out-Null }
    Invoke-Step "write $shimPath" {
        "@echo off`r`nnode `"$targetScript`" %*`r`n" | Set-Content -Path $shimPath -Encoding ASCII
    }

    if ($env:PATH -notlike "*$BinDir*") {
        Write-Host ''
        Write-Host "Note: $BinDir is not on your PATH. Add it, then reopen the terminal:"
        Write-Host "  setx PATH `"$BinDir;%PATH%`""
    }
}

Write-Host ''
Write-Host 'Done.'
Write-Host "Run: $CommandName"
Write-Host '(It only reports on your environment. Nothing is written until you pass a write flag.)'
