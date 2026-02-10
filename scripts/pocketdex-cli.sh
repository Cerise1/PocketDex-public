#!/usr/bin/env bash

set -euo pipefail

DEFAULT_INSTALL_DIR="$HOME/.local/share/pocketdex"
DEFAULT_STATE_DIR="$HOME/.local/state/pocketdex"
DEFAULT_CONFIG_FILE="$HOME/.config/pocketdex/env"

INSTALL_DIR="${POCKETDEX_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
STATE_DIR="${POCKETDEX_STATE_DIR:-$DEFAULT_STATE_DIR}"
CONFIG_FILE="${POCKETDEX_CONFIG_FILE:-$DEFAULT_CONFIG_FILE}"

if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

INSTALL_DIR="${POCKETDEX_INSTALL_DIR:-$INSTALL_DIR}"
STATE_DIR="${POCKETDEX_STATE_DIR:-$STATE_DIR}"
REQUESTED_CMD="${1:-}"

resolve_writable_state_dir() {
  local target="$1"
  local fallback="${TMPDIR:-/tmp}/pocketdex-${USER:-user}"

  case "$REQUESTED_CMD" in
    ""|help|-h|--help)
      printf "%s" "$target"
      return
      ;;
  esac

  if mkdir -p "$target" >/dev/null 2>&1; then
    printf "%s" "$target"
    return
  fi

  mkdir -p "$fallback"
  case "$REQUESTED_CMD" in
    start|restart)
      echo "Warning: state directory is not writable ($target). Using $fallback" >&2
      ;;
  esac
  printf "%s" "$fallback"
}

STATE_DIR="$(resolve_writable_state_dir "$STATE_DIR")"

PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
CODEX_BIN="${CODEX_BIN:-codex}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
PROJECTS_ROOT="${POCKETDEX_PROJECTS_ROOT:-$HOME/.pocketdex/projects}"
POCKETDEX_DEVICE_NAME="${POCKETDEX_DEVICE_NAME:-MacBook-Pro-de-Cerise}"
NODE_BIN="${POCKETDEX_NODE_BIN:-node}"
WEB_DIR="${POCKETDEX_WEB_DIR:-$INSTALL_DIR/web}"
SERVER_ENTRY="${POCKETDEX_SERVER_ENTRY:-$INSTALL_DIR/server/dist/index.js}"
PID_FILE="${POCKETDEX_PID_FILE:-$STATE_DIR/pocketdex.pid}"
LOG_FILE="${POCKETDEX_LOG_FILE:-$STATE_DIR/pocketdex.log}"

usage() {
  cat <<EOF
PocketDex process manager

Usage:
  pocketdex start
  pocketdex stop
  pocketdex restart
  pocketdex status
  pocketdex logs [--follow] [--lines N]

Config file:
  $CONFIG_FILE
EOF
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    tr -d '[:space:]' <"$PID_FILE"
  fi
}

is_running() {
  local pid
  pid="$(read_pid)"
  if [[ -z "${pid:-}" ]]; then
    return 1
  fi
  kill -0 "$pid" >/dev/null 2>&1
}

validate_runtime() {
  if [[ ! -f "$SERVER_ENTRY" ]]; then
    echo "PocketDex server not found at: $SERVER_ENTRY"
    echo "Run the installer again."
    exit 1
  fi
  if [[ ! -f "$WEB_DIR/index.html" ]]; then
    echo "PocketDex web build not found at: $WEB_DIR"
    echo "Run the installer again."
    exit 1
  fi
  if [[ "$CODEX_BIN" == */* ]]; then
    if [[ ! -x "$CODEX_BIN" ]]; then
      echo "CODEX_BIN is not executable: $CODEX_BIN"
      exit 1
    fi
  else
    if ! command_exists "$CODEX_BIN"; then
      echo "Codex CLI not found in PATH (expected command: $CODEX_BIN)."
      exit 1
    fi
  fi
  if ! command_exists "$NODE_BIN"; then
    echo "Node.js not found (expected command: $NODE_BIN)."
    exit 1
  fi
}

wait_until_stopped() {
  local pid="$1"
  local attempt
  for attempt in $(seq 1 30); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

cmd_start() {
  if is_running; then
    echo "PocketDex already running (pid $(read_pid))."
    return
  fi

  validate_runtime

  : >"$LOG_FILE"
  nohup env \
    CODEX_BIN="$CODEX_BIN" \
    CODEX_HOME="$CODEX_HOME" \
    POCKETDEX_DEVICE_NAME="$POCKETDEX_DEVICE_NAME" \
    POCKETDEX_PROJECTS_ROOT="$PROJECTS_ROOT" \
    POCKETDEX_WEB_DIR="$WEB_DIR" \
    "$NODE_BIN" "$SERVER_ENTRY" --hostname "$HOST" --port "$PORT" >>"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"
  sleep 0.4

  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "PocketDex started (pid $pid)."
    echo "URL: http://$HOST:$PORT"
    return
  fi

  if grep -q "EADDRINUSE" "$LOG_FILE" 2>/dev/null; then
    echo "Port $PORT is already in use. Change PORT in $CONFIG_FILE, then retry."
  fi
  echo "PocketDex failed to start. Recent logs:"
  tail -n 40 "$LOG_FILE" || true
  rm -f "$PID_FILE"
  exit 1
}

cmd_stop() {
  if ! is_running; then
    rm -f "$PID_FILE"
    echo "PocketDex is not running."
    return
  fi

  local pid
  pid="$(read_pid)"
  kill "$pid" >/dev/null 2>&1 || true
  if wait_until_stopped "$pid"; then
    rm -f "$PID_FILE"
    echo "PocketDex stopped."
    return
  fi

  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$PID_FILE"
  echo "PocketDex force-stopped."
}

cmd_status() {
  if is_running; then
    echo "PocketDex is running."
    echo "PID: $(read_pid)"
    echo "URL: http://$HOST:$PORT"
    echo "Log: $LOG_FILE"
  else
    echo "PocketDex is stopped."
    echo "Expected server entry: $SERVER_ENTRY"
  fi
}

cmd_logs() {
  local follow=0
  local lines=80
  shift || true

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --follow|-f)
        follow=1
        ;;
      --lines|-n)
        if [[ $# -lt 2 ]]; then
          echo "--lines requires a numeric value"
          exit 1
        fi
        lines="$2"
        shift
        ;;
      *)
        echo "Unknown logs option: $1"
        exit 1
        ;;
    esac
    shift
  done

  if [[ ! -f "$LOG_FILE" ]]; then
    echo "No log file yet at: $LOG_FILE"
    return
  fi

  if [[ "$follow" -eq 1 ]]; then
    tail -n "$lines" -f "$LOG_FILE"
  else
    tail -n "$lines" "$LOG_FILE"
  fi
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    start)
      cmd_start
      ;;
    stop)
      cmd_stop
      ;;
    restart)
      cmd_stop
      cmd_start
      ;;
    status)
      cmd_status
      ;;
    logs)
      cmd_logs "$@"
      ;;
    help|-h|--help|"")
      usage
      ;;
    *)
      echo "Unknown command: $cmd"
      echo
      usage
      exit 1
      ;;
  esac
}

main "$@"
