#!/usr/bin/env bash
set -euo pipefail

version="${MYTERMINAL_VERSION:-v0.1.0}"
repository="epslkslsksndnsjs-lab/myterminal"
install_dir="${MYTERMINAL_HOME:-$HOME/MyTerminal}"
launcher_dir="${MYTERMINAL_BIN_DIR:-$HOME/.local/bin}"

[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([._-][A-Za-z0-9.-]+)?$ ]] || { echo "Invalid MyTerminal version: $version" >&2; exit 1; }
[[ -n "$install_dir" && "$install_dir" != "/" ]] || { echo "Refusing unsafe installation root: $install_dir" >&2; exit 1; }

case "$(uname -m)" in
  arm64|aarch64) platform="darwin-arm64" ;;
  x86_64|amd64) platform="darwin-x64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="myterminal-${platform}.tar.gz"
asset_url="${MYTERMINAL_ASSET_URL:-https://github.com/${repository}/releases/download/${version}/${asset}}"
checksum_url="${MYTERMINAL_CHECKSUM_URL:-${asset_url}.sha256}"
temporary_dir="$(mktemp -d)"
download_dir="${MYTERMINAL_DOWNLOAD_DIR:-${TMPDIR:-/tmp}/myterminal-downloads}"
backup_dir=""
config_dir="${MYTERMINAL_CONFIG_DIR:-$HOME/.config/myterminal}"
legacy_backup_root="$config_dir/install-backups"
migrating_legacy=0
committed=0

cleanup() {
  local code=$?
  if [[ "$code" != "0" && "$committed" != "1" && "$migrating_legacy" == "1" ]]; then
    rm -rf "$install_dir"
    [[ -n "$backup_dir" && -d "$backup_dir" ]] && mv "$backup_dir" "$install_dir" || true
  fi
  : # successful legacy backups remain under the config directory for recovery
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

is_binary_layout() {
  [[ -d "$install_dir/releases" && -f "$install_dir/current" ]]
}

is_legacy_layout() {
  [[ -f "$install_dir/package.json" && -f "$install_dir/src/cli.ts" ]] \
    && grep -Eq '"name"[[:space:]]*:[[:space:]]*"myterminal"' "$install_dir/package.json"
}

if [[ -e "$install_dir" ]]; then
  if [[ -d "$install_dir/.git" && "${MYTERMINAL_ALLOW_SOURCE_UPDATE:-0}" != "1" ]]; then
    echo "Refusing to overwrite a Git source checkout: $install_dir" >&2
    echo "Use git pull for source checkouts, or set MYTERMINAL_HOME to a release installation directory." >&2
    exit 1
  fi
  if ! is_binary_layout && ! is_legacy_layout && [[ ! -d "$install_dir/releases" ]]; then
    echo "The target exists but is not a recognized MyTerminal installation: $install_dir" >&2
    exit 1
  fi
  if is_legacy_layout; then
    migrating_legacy=1
    mkdir -p "$legacy_backup_root"
    backup_dir="$legacy_backup_root/legacy-$(date +%s)"
    mv "$install_dir" "$backup_dir"
  fi
fi

mkdir -p "$temporary_dir" "$download_dir" "$launcher_dir"
asset_part="$download_dir/$asset.part"
checksum_part="$download_dir/$asset.sha256.part"
curl_retry_all=()
curl --help all 2>/dev/null | grep -q -- '--retry-all-errors' && curl_retry_all=(--retry-all-errors)
curl -fL --connect-timeout 15 --max-time 1800 --retry 5 "${curl_retry_all[@]}" --retry-delay 1 -C - "$asset_url" -o "$asset_part"
curl -fL --connect-timeout 15 --max-time 300 --retry 5 "${curl_retry_all[@]}" --retry-delay 1 "$checksum_url" -o "$checksum_part"
cp "$asset_part" "$temporary_dir/$asset"
cp "$checksum_part" "$temporary_dir/$asset.sha256"

expected="$(awk '{print $1}' "$temporary_dir/$asset.sha256" | tr -d '\r\n')"
actual="$(shasum -a 256 "$temporary_dir/$asset" | awk '{print $1}')"
[[ -n "$expected" && "$expected" == "$actual" ]] || {
  rm -f "$asset_part" "$checksum_part"
  echo "SHA-256 verification failed for $asset" >&2
  exit 1
}

tar -xzf "$temporary_dir/$asset" -C "$temporary_dir"
binary="$temporary_dir/myterminal"
[[ -f "$binary" ]] || { echo "Release asset does not contain myterminal" >&2; exit 1; }
chmod 755 "$binary"
xattr -d com.apple.quarantine "$binary" 2>/dev/null || true
"$binary" --verify-installation >/dev/null
actual_version="$("$binary" --version | tr -d '\r\n')"
[[ "$actual_version" == "${version#v}" ]] || { echo "Release version mismatch: expected ${version#v}, found $actual_version" >&2; exit 1; }

release_dir="$install_dir/releases/$version"
release_staging="$install_dir/releases/.${version}.staging.$$"
rm -rf "$release_staging"
mkdir -p "$release_staging"
cp "$binary" "$release_staging/myterminal"
helper_source="$temporary_dir/mac-one-shot-awake-lock.swift"
[[ -f "$helper_source" ]] || { echo "Release asset does not contain mac-one-shot-awake-lock.swift" >&2; exit 1; }
cp "$helper_source" "$release_staging/mac-one-shot-awake-lock.swift"
chmod 600 "$release_staging/mac-one-shot-awake-lock.swift"
chmod 755 "$release_staging/myterminal"
rm -rf "$release_dir"
mv "$release_staging" "$release_dir"
printf '%s\n' "$version" > "$install_dir/current.tmp"
mv "$install_dir/current.tmp" "$install_dir/current"

launcher_path="$launcher_dir/myterminal"
cat > "$launcher_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
root=$(printf '%q' "$install_dir")
version=\$(tr -d '\\r\\n' < "\$root/current")
exec "\$root/releases/\$version/myterminal" "\$@"
EOF
chmod 755 "$launcher_path"

add_launcher_to_path() {
  local profile_file="$1" escaped_dir path_line
  printf -v escaped_dir '%q' "$launcher_dir"
  path_line="export PATH=${escaped_dir}:\$PATH"
  [[ -f "$profile_file" ]] && grep -Fqx "$path_line" "$profile_file" && return
  printf '\n# MyTerminal command\n%s\n' "$path_line" >> "$profile_file"
}
case "$(basename "${SHELL:-sh}")" in
  zsh) add_launcher_to_path "$HOME/.zprofile"; add_launcher_to_path "$HOME/.zshrc" ;;
  bash) add_launcher_to_path "$HOME/.bash_profile"; add_launcher_to_path "$HOME/.bashrc" ;;
  *) add_launcher_to_path "$HOME/.profile" ;;
esac

# Keep the active version and one rollback version.
find "$install_dir/releases" -mindepth 1 -maxdepth 1 -type d -name 'v*' -print0 \
  | xargs -0 ls -1dt 2>/dev/null | tail -n +3 | while IFS= read -r old; do rm -rf "$old"; done || true

rm -f "$asset_part" "$checksum_part"
find "$legacy_backup_root" -mindepth 1 -maxdepth 1 -type d -name 'legacy-*' -print0 2>/dev/null   | xargs -0 ls -1dt 2>/dev/null | tail -n +4 | while IFS= read -r old; do rm -rf "$old"; done || true
committed=1
export PATH="$launcher_dir:$PATH"
echo "Installed MyTerminal ${version}: $install_dir"
echo "User settings and workspace state were preserved."
echo "Start it with: myterminal"
[[ "${MYTERMINAL_INSTALL_ONLY:-0}" == "1" ]] && exit 0
exec "$launcher_path"
