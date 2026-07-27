$ErrorActionPreference = "Stop"

$Version = if ($env:MYTERMINAL_VERSION) { $env:MYTERMINAL_VERSION } else { "v0.1.2" }
$Repository = "epslkslsksndnsjs-lab/myterminal"
$InstallDir = if ($env:MYTERMINAL_HOME) { $env:MYTERMINAL_HOME } else { Join-Path $HOME "MyTerminal" }
$LauncherDir = if ($env:MYTERMINAL_BIN_DIR) { $env:MYTERMINAL_BIN_DIR } else { Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "MyTerminal\bin" }
$Asset = "myterminal-windows-x64.zip"
$AssetUrl = if ($env:MYTERMINAL_ASSET_URL) { $env:MYTERMINAL_ASSET_URL } else { "https://github.com/$Repository/releases/download/$Version/$Asset" }
$ChecksumUrl = if ($env:MYTERMINAL_CHECKSUM_URL) { $env:MYTERMINAL_CHECKSUM_URL } else { "$AssetUrl.sha256" }
$TemporaryDir = Join-Path ([System.IO.Path]::GetTempPath()) ("myterminal-" + [System.Guid]::NewGuid().ToString("N"))
$DownloadDir = if ($env:MYTERMINAL_DOWNLOAD_DIR) { $env:MYTERMINAL_DOWNLOAD_DIR } else { Join-Path ([System.IO.Path]::GetTempPath()) "myterminal-downloads" }
$Archive = Join-Path $DownloadDir "$Asset.part"
$ChecksumFile = Join-Path $DownloadDir "$Asset.sha256.part"
$ConfigDir = if ($env:MYTERMINAL_CONFIG_DIR) { $env:MYTERMINAL_CONFIG_DIR } else { Join-Path $HOME ".config\myterminal" }
$LegacyBackupRoot = Join-Path $ConfigDir "install-backups"
$BackupDir = $null
$MigratingLegacy = $false
$Committed = $false

if ($Version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+([._-][A-Za-z0-9.-]+)?$') { throw "Invalid MyTerminal version: $Version" }
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
if ($InstallDir -eq [System.IO.Path]::GetPathRoot($InstallDir)) { throw "Refusing unsafe installation root: $InstallDir" }

function Test-BinaryLayout {
  return (Test-Path (Join-Path $InstallDir "releases")) -and (Test-Path (Join-Path $InstallDir "current"))
}

function Test-LegacyLayout {
  $PackagePath = Join-Path $InstallDir "package.json"
  $CliPath = Join-Path $InstallDir "src\cli.ts"
  if (-not ((Test-Path $PackagePath) -and (Test-Path $CliPath))) { return $false }
  try { return ((Get-Content -Raw $PackagePath | ConvertFrom-Json).name -eq "myterminal") }
  catch { return $false }
}

try {
  if (Test-Path $InstallDir) {
    if ((Test-Path (Join-Path $InstallDir ".git")) -and ($env:MYTERMINAL_ALLOW_SOURCE_UPDATE -ne "1")) {
      throw "Refusing to overwrite a Git source checkout: $InstallDir"
    }
    if (-not (Test-BinaryLayout) -and -not (Test-LegacyLayout) -and -not (Test-Path (Join-Path $InstallDir "releases"))) {
      throw "The target exists but is not a recognized MyTerminal installation: $InstallDir"
    }
    if (Test-LegacyLayout) {
      $MigratingLegacy = $true
      $null = New-Item -ItemType Directory -Force -Path $LegacyBackupRoot
      $BackupDir = Join-Path $LegacyBackupRoot ("legacy-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
      Move-Item -LiteralPath $InstallDir -Destination $BackupDir
    }
  }

  New-Item -ItemType Directory -Force -Path $TemporaryDir | Out-Null
  New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "releases") | Out-Null
  New-Item -ItemType Directory -Force -Path $LauncherDir | Out-Null

  & curl.exe --fail --location --connect-timeout 15 --max-time 1800 --retry 5 --retry-all-errors --continue-at - --output $Archive $AssetUrl
  if ($LASTEXITCODE -ne 0) { throw "Failed to download $Asset" }
  & curl.exe --fail --location --connect-timeout 15 --max-time 300 --retry 5 --retry-all-errors --output $ChecksumFile $ChecksumUrl
  if ($LASTEXITCODE -ne 0) { throw "Failed to download checksum for $Asset" }
  $Expected = ((Get-Content -Raw $ChecksumFile).Trim() -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
  if (-not $Expected -or $Expected -ne $Actual) { Remove-Item $Archive,$ChecksumFile -Force -ErrorAction SilentlyContinue; throw "SHA-256 verification failed for $Asset" }

  $VerifiedArchive = Join-Path $TemporaryDir $Asset
  Copy-Item -LiteralPath $Archive -Destination $VerifiedArchive
  $Expanded = Join-Path $TemporaryDir "expanded"
  Expand-Archive -Path $VerifiedArchive -DestinationPath $Expanded
  $Binary = Join-Path $Expanded "myterminal.exe"
  if (-not (Test-Path $Binary)) { throw "Release asset does not contain myterminal.exe" }
  # Windows security scanners can transiently lock or interrupt a freshly expanded
  # executable. Verify the exact candidate with bounded retries before committing it.
  $CandidateVerified = $false
  $ActualVersion = ""
  $LastVerifyOutput = ""
  for ($Attempt = 1; $Attempt -le 10; $Attempt++) {
    $LastVerifyOutput = (& $Binary --verify-installation 2>&1 | Out-String).Trim()
    $VerifyExit = $LASTEXITCODE
    if ($VerifyExit -eq 0) {
      $ActualVersion = (& $Binary --version 2>&1 | Out-String).Trim()
      $VersionExit = $LASTEXITCODE
      if ($VersionExit -eq 0 -and $ActualVersion -eq $Version.TrimStart('v')) {
        $CandidateVerified = $true
        break
      }
    }
    Start-Sleep -Milliseconds ([Math]::Min(2000, 250 * $Attempt))
  }
  if (-not $CandidateVerified) {
    throw "Release executable failed verification: expected $($Version.TrimStart('v')), found $ActualVersion. $LastVerifyOutput"
  }

  $ReleaseDir = Join-Path (Join-Path $InstallDir "releases") $Version
  $ReleaseStaging = Join-Path (Join-Path $InstallDir "releases") (".$Version.staging.$PID")
  Remove-Item -LiteralPath $ReleaseStaging -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $ReleaseStaging | Out-Null
  Copy-Item -LiteralPath $Binary -Destination (Join-Path $ReleaseStaging "myterminal.exe")
  Remove-Item -LiteralPath $ReleaseDir -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $ReleaseStaging -Destination $ReleaseDir

  # Copying the verified executable can trigger a second security scan. Do not
  # publish the current pointer until the installed copy is executable too.
  $InstalledBinary = Join-Path $ReleaseDir "myterminal.exe"
  $InstalledVerified = $false
  for ($Attempt = 1; $Attempt -le 10; $Attempt++) {
    $InstalledVersion = (& $InstalledBinary --version 2>&1 | Out-String).Trim()
    $InstalledExit = $LASTEXITCODE
    if ($InstalledExit -eq 0 -and $InstalledVersion -eq $Version.TrimStart('v')) {
      $InstalledVerified = $true
      break
    }
    Start-Sleep -Milliseconds ([Math]::Min(2000, 250 * $Attempt))
  }
  if (-not $InstalledVerified) { throw "Installed release failed verification: $InstalledVersion" }

  $CurrentTmp = Join-Path $InstallDir "current.tmp"
  $CurrentPath = Join-Path $InstallDir "current"
  Set-Content -Path $CurrentTmp -Value $Version -Encoding Ascii
  Move-Item -LiteralPath $CurrentTmp -Destination $CurrentPath -Force

  $PowerShellLauncher = Join-Path $LauncherDir "myterminal.ps1"
  Remove-Item -LiteralPath $PowerShellLauncher -Force -ErrorAction SilentlyContinue
  $CommandLauncher = Join-Path $LauncherDir "myterminal.cmd"
  $EscapedInstallDir = $InstallDir.Replace("%", "%%")
  @(
    '@echo off',
    'setlocal',
    ('set "ROOT={0}"' -f $EscapedInstallDir),
    'set /p VERSION=<"%ROOT%\current"',
    '"%ROOT%\releases\%VERSION%\myterminal.exe" %*',
    'exit /b %ERRORLEVEL%'
  ) | Set-Content -Path $CommandLauncher -Encoding Ascii

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $Entries = @($UserPath -split ';' | Where-Object { $_ })
  if (-not ($Entries | Where-Object { $_.TrimEnd('\') -ieq $LauncherDir.TrimEnd('\') })) {
    $NewUserPath = if ($UserPath) { "$LauncherDir;$UserPath" } else { $LauncherDir }
    [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
  }

  Get-ChildItem -Path (Join-Path $InstallDir "releases") -Directory -Filter "v*" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 2 |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $LegacyBackupRoot) {
    Get-ChildItem -Path $LegacyBackupRoot -Directory -Filter "legacy-*" |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip 3 |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }

  $Committed = $true
  Remove-Item $Archive,$ChecksumFile -Force -ErrorAction SilentlyContinue
  Write-Host "Installed MyTerminal ${Version}: $InstallDir"
  Write-Host "User settings and workspace state were preserved."
  Write-Host "Start it with: myterminal"
  if ($env:MYTERMINAL_INSTALL_ONLY -ne "1") { & $CommandLauncher }
} catch {
  if (-not $Committed -and $MigratingLegacy) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    if ($BackupDir -and (Test-Path $BackupDir)) { Move-Item -LiteralPath $BackupDir -Destination $InstallDir -ErrorAction SilentlyContinue }
  }
  throw
} finally {
  # Successful legacy backups remain under the config directory for recovery.
  Remove-Item -LiteralPath $TemporaryDir -Recurse -Force -ErrorAction SilentlyContinue
}
