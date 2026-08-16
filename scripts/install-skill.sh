#!/usr/bin/env bash
# install-skill.sh — one-line installer for the myterminal-onboarding skill
# (macOS / Linux). Downloads the skill folder from the repository and installs
# it into every detected agent (Claude Code / WorkBuddy / Cursor) via the
# skill's own install.mjs, then runs the skill's built-in self-test.
#
# Env knobs:
#   MYTERMINAL_SKILL_REF          branch or vX.Y.Z tag (default: main)
#   MYTERMINAL_REPOSITORY         owner/repo (default: epslkslsksndnsjs-lab/myterminal)
#   MYTERMINAL_SKILL_TARBALL_URL  full download-URL override (for offline/testing)
#
# Extra arguments pass through to install.mjs, e.g. `--target claude`.

set -euo pipefail

ref="${MYTERMINAL_SKILL_REF:-main}"
repository="${MYTERMINAL_REPOSITORY:-epslkslsksndnsjs-lab/myterminal}"

[[ "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "Invalid skill ref: $ref" >&2; exit 1; }
[[ "$repository" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo "Invalid repository: $repository" >&2; exit 1; }

command -v node >/dev/null 2>&1 || {
  echo "Node.js 18+ is required (your agent — Claude Code / WorkBuddy / Cursor — already requires it)." >&2
  echo "Install Node.js first: https://nodejs.org/" >&2
  exit 1
}

if [[ "$ref" == v* ]]; then
  git_ref="refs/tags/$ref"
else
  git_ref="refs/heads/$ref"
fi
# GitHub archive top-level dir: <repo>-<ref> with a leading 'v' stripped.
topdir="${repository##*/}-${ref#v}"

temporary_dir="$(mktemp -d)"
cleanup() { rm -rf "$temporary_dir"; }
trap cleanup EXIT

tarball_url="${MYTERMINAL_SKILL_TARBALL_URL:-https://codeload.github.com/${repository}/tar.gz/${git_ref}}"
archive="$temporary_dir/skill.tar.gz"

curl_retry_all=()
curl --help all 2>/dev/null | grep -q -- '--retry-all-errors' && curl_retry_all=(--retry-all-errors)
curl -fL --connect-timeout 15 --max-time 600 --retry 5 "${curl_retry_all[@]}" --retry-delay 1 "$tarball_url" -o "$archive"

tar -xzf "$archive" -C "$temporary_dir" --strip-components=2 "$topdir/skills/myterminal-onboarding"
skill_dir="$temporary_dir/myterminal-onboarding"
[[ -f "$skill_dir/SKILL.md" && -f "$skill_dir/scripts/install.mjs" ]] || {
  echo "Downloaded archive does not contain the myterminal-onboarding skill" >&2
  echo "(expected $topdir/skills/myterminal-onboarding)" >&2
  exit 1
}

# Default to --yes (non-interactive); extra arguments pass through, e.g. `--target claude`.
node "$skill_dir/scripts/install.mjs" --yes "$@"

echo "Done. Open your agent and type: /myterminal-onboarding"
