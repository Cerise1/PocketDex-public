#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FALLBACK_BASE_DIR="$HOME/.pocketdex"
INSTALL_DIR_RAW="${POCKETDEX_INSTALL_DIR:-$HOME/.local/share/pocketdex}"
BIN_DIR_RAW="${POCKETDEX_BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR_RAW="${POCKETDEX_CONFIG_DIR:-$HOME/.config/pocketdex}"
STATE_DIR_RAW="${POCKETDEX_STATE_DIR:-$HOME/.local/state/pocketdex}"

CLI_SOURCE="$ROOT_DIR/scripts/pocketdex-cli.sh"
BUILD_SCRIPT="$ROOT_DIR/scripts/build-macos-artifacts.sh"

pick_writable_dir() {
  local primary="$1"
  local fallback="$2"

  if mkdir -p "$primary" >/dev/null 2>&1; then
    printf "%s" "$primary"
    return
  fi

  mkdir -p "$fallback"
  echo "Warning: '$primary' is not writable. Using '$fallback' instead." >&2
  printf "%s" "$fallback"
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
}

ensure_executable() {
  local target="$1"
  if [[ ! -x "$target" ]]; then
    chmod +x "$target"
  fi
}

write_default_config() {
  local config_file="$1"

  if [[ -f "$config_file" ]]; then
    if grep -q "Warning: '" "$config_file"; then
      echo "Detected invalid config format. Rewriting: $config_file"
    else
      echo "Keeping existing config at: $config_file"
      return
    fi
  fi

  cat >"$config_file" <<EOF
# PocketDex CLI runtime config
POCKETDEX_INSTALL_DIR="$INSTALL_DIR"
POCKETDEX_STATE_DIR="$STATE_DIR"

# API bind address used by: pocketdex start
HOST=0.0.0.0
PORT=8787

# Codex runtime
CODEX_BIN=codex
CODEX_HOME="$HOME/.codex"

# Default location for projects created from PocketDex
POCKETDEX_PROJECTS_ROOT="$HOME/.pocketdex/projects"
EOF
  echo "Created config: $config_file"
}

print_path_hint() {
  case ":$PATH:" in
    *":$BIN_DIR:"*)
      ;;
    *)
      echo
      echo "Add this to your shell profile to use 'pocketdex' directly:"
      echo "  export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
}

main() {
  INSTALL_DIR="$(pick_writable_dir "$INSTALL_DIR_RAW" "$FALLBACK_BASE_DIR/runtime")"
  BIN_DIR="$(pick_writable_dir "$BIN_DIR_RAW" "$FALLBACK_BASE_DIR/bin")"
  CONFIG_DIR="$(pick_writable_dir "$CONFIG_DIR_RAW" "$FALLBACK_BASE_DIR/config")"
  STATE_DIR="$(pick_writable_dir "$STATE_DIR_RAW" "$FALLBACK_BASE_DIR/state")"
  CONFIG_FILE="$CONFIG_DIR/env"
  CLI_TARGET="$BIN_DIR/pocketdex"

  require_command node
  require_command npm

  if [[ ! -f "$BUILD_SCRIPT" ]]; then
    echo "Build script not found: $BUILD_SCRIPT"
    exit 1
  fi
  if [[ ! -f "$CLI_SOURCE" ]]; then
    echo "CLI source not found: $CLI_SOURCE"
    exit 1
  fi

  ensure_executable "$BUILD_SCRIPT"
  ensure_executable "$CLI_SOURCE"

  echo "[1/4] Building PocketDex artifacts"
  "$BUILD_SCRIPT"

  echo "[2/4] Installing runtime files to $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  cp -R "$ROOT_DIR/artifacts/web" "$INSTALL_DIR/web"
  cp -R "$ROOT_DIR/artifacts/server" "$INSTALL_DIR/server"

  echo "[3/4] Installing CLI command to $CLI_TARGET"
  mkdir -p "$BIN_DIR"
  cp "$CLI_SOURCE" "$CLI_TARGET"
  chmod +x "$CLI_TARGET"

  echo "[4/4] Writing runtime config"
  mkdir -p "$CONFIG_DIR" "$STATE_DIR"
  write_default_config "$CONFIG_FILE"

  echo
  echo "PocketDex installed."
  echo "Try:"
  echo "  pocketdex start"
  echo "  pocketdex status"
  echo "  pocketdex stop"
  print_path_hint

  if ! command -v codex >/dev/null 2>&1; then
    echo
    echo "Warning: codex CLI is not in PATH yet."
    echo "Install/login Codex CLI before running 'pocketdex start'."
  fi
}

main "$@"
