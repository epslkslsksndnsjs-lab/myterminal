[CmdletBinding()]
param(
    [string]$Candidate
)

$ErrorActionPreference = 'Stop'

function Read-EnvironmentValue([string]$Name) {
    $Value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrEmpty($Value)) { return '<unset>' }
    return $Value
}

$RuntimeVersion = if (Get-Command bun.exe -ErrorAction SilentlyContinue) {
    (& bun.exe --version 2>&1 | Out-String).Trim()
} else {
    '<not on PATH>'
}

$CandidateVersion = '<not requested>'
if ($Candidate) {
    $ResolvedCandidate = (Resolve-Path -LiteralPath $Candidate).Path
    $CandidateVersion = (& $ResolvedCandidate --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Candidate --version failed: $ResolvedCandidate" }
}

$ConsoleSize = try { "$([Console]::WindowWidth)x$([Console]::WindowHeight)" } catch { '<unavailable>' }
$BufferSize = try { "$([Console]::BufferWidth)x$([Console]::BufferHeight)" } catch { '<unavailable>' }
$InputRedirected = try { [Console]::IsInputRedirected } catch { '<unavailable>' }
$OutputRedirected = try { [Console]::IsOutputRedirected } catch { '<unavailable>' }
$InputCodePage = try { [Console]::InputEncoding.CodePage } catch { '<unavailable>' }
$OutputCodePage = try { [Console]::OutputEncoding.CodePage } catch { '<unavailable>' }
$OsDescription = try { [Runtime.InteropServices.RuntimeInformation]::OSDescription } catch { [Environment]::OSVersion.VersionString }
$ProcessArchitecture = try { [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture } catch { '<unavailable>' }
$OsArchitecture = try { [Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch { '<unavailable>' }

$Report = [ordered]@{
    capturedAt = [DateTime]::UtcNow.ToString('o')
    os = $OsDescription
    osArchitecture = [string]$OsArchitecture
    processArchitecture = [string]$ProcessArchitecture
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    powershellEdition = [string]$PSVersionTable.PSEdition
    hostName = $Host.Name
    hostVersion = $Host.Version.ToString()
    consoleWindow = $ConsoleSize
    consoleBuffer = $BufferSize
    inputRedirected = $InputRedirected
    outputRedirected = $OutputRedirected
    inputCodePage = $InputCodePage
    outputCodePage = $OutputCodePage
    WT_SESSION = Read-EnvironmentValue 'WT_SESSION'
    TERM_PROGRAM = Read-EnvironmentValue 'TERM_PROGRAM'
    TERM = Read-EnvironmentValue 'TERM'
    COLORTERM = Read-EnvironmentValue 'COLORTERM'
    ConEmuANSI = Read-EnvironmentValue 'ConEmuANSI'
    windowsTuiMode = Read-EnvironmentValue 'MYTERMINAL_WINDOWS_TUI_MODE'
    bunVersion = $RuntimeVersion
    candidateVersion = $CandidateVersion
}

$Report | ConvertTo-Json -Depth 4
Write-Host ''
Write-Host 'Default acceptance profile: compatible (main screen, 20 FPS, keyboard-only).'
Write-Host "Mouse isolation test: `$env:MYTERMINAL_WINDOWS_TUI_MODE='mouse'"
