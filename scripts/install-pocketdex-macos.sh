#!/usr/bin/env bash

set -euo pipefail

REPO="${POCKETDEX_REPO:-Cerise1/PocketDex}"
APP_NAME="${POCKETDEX_APP_NAME:-PocketDexApp.app}"
INSTALL_DIR="${POCKETDEX_INSTALL_DIR:-/Applications}"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
}

require_cmd curl
require_cmd ditto
require_cmd mktemp

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pocketdex-install.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

latest_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")"
tag="${latest_url##*/}"

if [[ -z "$tag" || "$tag" == "latest" || "$tag" == "releases" ]]; then
  echo "Unable to resolve latest release tag for ${REPO}"
  exit 1
fi

archive_name="PocketDex-macOS-${tag}.zip"
archive_url="https://github.com/${REPO}/releases/download/${tag}/${archive_name}"
archive_path="$tmp_dir/$archive_name"
extract_dir="$tmp_dir/extracted"
app_source="$extract_dir/$APP_NAME"
app_dest="$INSTALL_DIR/$APP_NAME"

echo "Downloading ${archive_name}..."
curl -fL "$archive_url" -o "$archive_path"

mkdir -p "$extract_dir"
ditto -x -k "$archive_path" "$extract_dir"

if [[ ! -d "$app_source" ]]; then
  echo "Archive did not contain expected app bundle: $APP_NAME"
  exit 1
fi

echo "Installing to ${app_dest}..."
if rm -rf "$app_dest" 2>/dev/null && cp -R "$app_source" "$app_dest" 2>/dev/null; then
  :
else
  echo "Administrative privileges may be required for ${INSTALL_DIR}."
  sudo rm -rf "$app_dest"
  sudo cp -R "$app_source" "$app_dest"
fi

xattr -dr com.apple.quarantine "$app_dest" >/dev/null 2>&1 || true

echo
echo "PocketDex installed: $app_dest"
echo "Launch with:"
echo "  open -a \"$APP_NAME\""
