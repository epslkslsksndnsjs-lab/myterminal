# install-skill.ps1 — one-line installer for the myterminal-onboarding skill
# (Windows PowerShell). Downloads the skill folder from the repository and
# installs it into every detected agent (Claude Code / WorkBuddy / Cursor) via
# the skill's own install.mjs, then runs the skill's built-in self-test.
#
# Env knobs:
#   MYTERMINAL_SKILL_REF          branch or vX.Y.Z tag (default: main)
#   MYTERMINAL_REPOSITORY         owner/repo (default: epslkslsksndnsjs-lab/myterminal)
#   MYTERMINAL_SKILL_TARBALL_URL  full download-URL override (for offline/testing)
#
# Extra arguments pass through to install.mjs, e.g. `--target claude`.

$ErrorActionPreference = "Stop"

$Ref = if ($env:MYTERMINAL_SKILL_REF) { $env:MYTERMINAL_SKILL_REF } else { "main" }
$Repository = if ($env:MYTERMINAL_REPOSITORY) { $env:MYTERMINAL_REPOSITORY } else { "epslkslsksndnsjs-lab/myterminal" }

if ($Ref -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Invalid skill ref: $Ref" }
if ($Repository -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$') { throw "Invalid repository: $Repository" }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 18+ is required (your agent - Claude Code / WorkBuddy / Cursor - already requires it). Install Node.js first: https://nodejs.org/"
}

$GitRef = if ($Ref.StartsWith("v")) { "refs/tags/$Ref" } else { "refs/heads/$Ref" }
# GitHub archive top-level dir: <repo>-<ref> with a leading 'v' stripped.
$RepoName = ($Repository -split "/")[-1]
$TopDir = $RepoName + "-" + ($Ref -replace "^v", "")

$TemporaryDir = Join-Path ([System.IO.Path]::GetTempPath()) ("myterminal-skill-" + [System.Guid]::NewGuid().ToString("N"))
$Archive = Join-Path $TemporaryDir "skill.tar.gz"

try {
  New-Item -ItemType Directory -Path $TemporaryDir | Out-Null

  $TarballUrl = if ($env:MYTERMINAL_SKILL_TARBALL_URL) { $env:MYTERMINAL_SKILL_TARBALL_URL } else { "https://codeload.github.com/$Repository/tar.gz/$GitRef" }
  Invoke-WebRequest -Uri $TarballUrl -OutFile $Archive

  & tar -xzf $Archive -C $TemporaryDir --strip-components=2 "$TopDir/skills/myterminal-onboarding"
  if ($LASTEXITCODE -ne 0) { throw "tar extraction failed" }

  $SkillDir = Join-Path $TemporaryDir "myterminal-onboarding"
  if (-not ((Test-Path (Join-Path $SkillDir "SKILL.md")) -and (Test-Path (Join-Path $SkillDir "scripts\install.mjs")))) {
    throw "Downloaded archive does not contain the myterminal-onboarding skill (expected $TopDir/skills/myterminal-onboarding)"
  }

  # Default to --yes (non-interactive); extra arguments pass through, e.g. `--target claude`.
  $InstallArgs = @((Join-Path $SkillDir "scripts\install.mjs"), "--yes")
  $InstallArgs += $args
  & node @InstallArgs
  if ($LASTEXITCODE -ne 0) { throw "install.mjs failed (exit $LASTEXITCODE)" }

  Write-Host "Done. Open your agent and type: /myterminal-onboarding"
}
finally {
  Remove-Item -Recurse -Force $TemporaryDir -ErrorAction SilentlyContinue
}
