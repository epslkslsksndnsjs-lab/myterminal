#!/usr/bin/env bash
#
# Installer for the myterminal-onboarding skill.
#
# Copies this skill folder into an agent's skills directory and puts a
# `myterminal-onboard` command on your PATH, so the trigger is identical no
# matter which agent you use (Claude Code, WorkBuddy, Cursor, Codex, ...).
#
# See docs/adr/0043-myterminal-onboarding-skill.md (decisions D1, D3, D5).

set -euo pipefail

SKILL_NAME="myterminal-onboarding"
COMMAND_NAME="myterminal-onboard"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"

TARGETS=()
LINK_COMMAND=1
DRY_RUN=0

usage() {
  cat <<EOF
Install the ${SKILL_NAME} skill.

USAGE
  ./install.sh [--target <name|path>]... [options]

TARGETS
  workbuddy   ~/.workbuddy/skills          (default)
  claude      ~/.claude/skills
  cursor      ./.cursor/skills             (current project)
  codex       ~/.codex/skills
  <path>      any directory you name

  --target may be repeated. With --all, every agent directory that already
  exists on this machine is used.

OPTIONS
  --all          Install into every detected agent skills directory.
  --no-command   Skip creating the ${COMMAND_NAME} command in ${BIN_DIR}.
  --dry-run      Print what would happen; change nothing.
  -h, --help     This text.

AFTER INSTALLING
  Run: ${COMMAND_NAME}
  It detects your environment and writes nothing until you ask it to.
EOF
}

resolve_target() {
  case "$1" in
    workbuddy) printf '%s\n' "${HOME}/.workbuddy/skills" ;;
    claude)    printf '%s\n' "${HOME}/.claude/skills" ;;
    cursor)    printf '%s\n' "${PWD}/.cursor/skills" ;;
    codex)     printf '%s\n' "${HOME}/.codex/skills" ;;
    *)         printf '%s\n' "$1" ;;
  esac
}

detect_all_targets() {
  local found=()
  for name in workbuddy claude codex; do
    local dir
    dir="$(resolve_target "$name")"
    [[ -d "$(dirname "${dir}")" ]] && found+=("${dir}")
  done
  [[ -d "${PWD}/.cursor" ]] && found+=("${PWD}/.cursor/skills")
  printf '%s\n' "${found[@]:-}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)     TARGETS+=("$(resolve_target "$2")"); shift 2 ;;
    --all)        while IFS= read -r line; do [[ -n "${line}" ]] && TARGETS+=("${line}"); done < <(detect_all_targets); shift ;;
    --no-command) LINK_COMMAND=0; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=("$(resolve_target workbuddy)")
fi

if [[ ! -f "${SOURCE_DIR}/SKILL.md" || ! -f "${SOURCE_DIR}/scripts/onboard.mjs" ]]; then
  printf 'Error: %s does not look like the skill folder (SKILL.md / scripts/onboard.mjs missing).\n' "${SOURCE_DIR}" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'Error: node is required to run %s but was not found on PATH.\n' "${COMMAND_NAME}" >&2
  exit 1
fi

run() {
  if [[ ${DRY_RUN} -eq 1 ]]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

primary_install=""

for skills_dir in "${TARGETS[@]}"; do
  dest="${skills_dir}/${SKILL_NAME}"
  printf 'Installing -> %s\n' "${dest}"
  run mkdir -p "${skills_dir}"
  run rm -rf "${dest}"
  run mkdir -p "${dest}"
  # Copy contents, not the folder itself, so the destination name is ours.
  run cp -R "${SOURCE_DIR}/SKILL.md" "${SOURCE_DIR}/README.md" "${SOURCE_DIR}/scripts" "${SOURCE_DIR}/templates" "${dest}/"
  run chmod +x "${dest}/scripts/onboard.mjs"
  [[ -z "${primary_install}" ]] && primary_install="${dest}"
done

if [[ ${LINK_COMMAND} -eq 1 ]]; then
  target_script="${primary_install}/scripts/onboard.mjs"
  link_path="${BIN_DIR}/${COMMAND_NAME}"
  printf 'Linking   -> %s\n' "${link_path}"
  run mkdir -p "${BIN_DIR}"
  run ln -sf "${target_script}" "${link_path}"

  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *)
      printf '\nNote: %s is not on your PATH. Add this to your shell profile:\n' "${BIN_DIR}"
      printf '  export PATH="%s:$PATH"\n' "${BIN_DIR}"
      ;;
  esac
fi

printf '\nDone.\n'
printf 'Run: %s\n' "${COMMAND_NAME}"
printf '(It only reports on your environment. Nothing is written until you pass a write flag.)\n'
