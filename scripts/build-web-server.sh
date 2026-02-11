#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
SERVER_DIR="$ROOT_DIR/server"

echo "[1/2] Building web + server in parallel"

(
  echo "Starting build into $WEB_DIR/out"
  cd "$WEB_DIR"
  npm run build
) 2>&1 | sed 's/^/[web] /' &
web_pid=$!

(
  echo "Starting build into $SERVER_DIR/dist"
  cd "$SERVER_DIR"
  npm run build
) 2>&1 | sed 's/^/[server] /' &
server_pid=$!

set +e
wait "$web_pid"
web_status=$?
wait "$server_pid"
server_status=$?
set -e

if [[ $web_status -ne 0 || $server_status -ne 0 ]]; then
  echo "error: build failed (web=$web_status, server=$server_status)"
  exit 1
fi

echo "[2/2] Verifying build outputs"

if [[ ! -f "$WEB_DIR/out/index.html" ]]; then
  echo "error: expected static web output at $WEB_DIR/out/index.html"
  exit 1
fi

if [[ ! -f "$SERVER_DIR/dist/index.js" ]]; then
  echo "error: expected server output at $SERVER_DIR/dist/index.js"
  exit 1
fi

cat <<EOF

Build completed:
- $WEB_DIR/out
- $SERVER_DIR/dist
EOF
