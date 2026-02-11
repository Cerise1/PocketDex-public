#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
SERVER_DIR="$ROOT_DIR/server"
ARTIFACTS_DIR="$ROOT_DIR/artifacts"
WEB_ARTIFACTS_DIR="$ARTIFACTS_DIR/web"
SERVER_ARTIFACTS_DIR="$ARTIFACTS_DIR/server"

echo "[1/5] Building static web bundle"
(cd "$WEB_DIR" && npm run build)

if [[ ! -d "$WEB_DIR/out" ]]; then
  echo "error: expected web export directory at $WEB_DIR/out"
  exit 1
fi

echo "[2/5] Building server bundle"
(cd "$SERVER_DIR" && npm run build)

echo "[3/5] Preparing artifacts directories"
rm -rf "$ARTIFACTS_DIR"
mkdir -p "$WEB_ARTIFACTS_DIR" "$SERVER_ARTIFACTS_DIR"

echo "[4/5] Copying web artifacts"
cp -R "$WEB_DIR/out/." "$WEB_ARTIFACTS_DIR/"

echo "[5/5] Copying server artifacts and installing prod dependencies"
cp -R "$SERVER_DIR/dist" "$SERVER_ARTIFACTS_DIR/dist"
cp "$SERVER_DIR/package.json" "$SERVER_ARTIFACTS_DIR/package.json"
if [[ -f "$SERVER_DIR/package-lock.json" ]]; then
  cp "$SERVER_DIR/package-lock.json" "$SERVER_ARTIFACTS_DIR/package-lock.json"
fi

(cd "$SERVER_ARTIFACTS_DIR" && npm install --omit=dev --no-audit --no-fund)

cat <<EOF

Artifacts generated:
- $WEB_ARTIFACTS_DIR
- $SERVER_ARTIFACTS_DIR

Runtime hint:
- Start server with POCKETDEX_WEB_DIR="$WEB_ARTIFACTS_DIR"
EOF
