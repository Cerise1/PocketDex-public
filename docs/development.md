# Development

## Prerequisites

- macOS
- Xcode
- Node.js + npm
- Codex CLI installed and logged in

## Local Run

Server:

```bash
cd server
npm install
npm run dev
```

Web:

```bash
cd web
npm install
npm run dev
```

By default, the web app targets `http://localhost:8787`.
Override with `NEXT_PUBLIC_API_BASE_URL` if needed.

## Build

Build web and server outputs:

```bash
./scripts/build-web-server.sh
```

Build production-style artifacts:

```bash
./scripts/build-macos-artifacts.sh
```

## Useful Environment Variables

Server:

- `CODEX_HOME` (default `~/.codex`)
- `CODEX_BIN` (default auto-detected)
- `PORT` (default `8787`)
- `POCKETDEX_DEVICE_NAME` (used for "Connected to …" labels; if unset, server uses host name)
- `POCKETDEX_WEB_DIR` (optional static web directory override)
- `POCKETDEX_PROJECTS_ROOT` (default `~/.pocketdex/projects`)
- `POCKETDEX_ENABLE_DESKTOP_LIVE_SYNC` (`1` by default, set `0` to disable)

Web:

- `NEXT_PUBLIC_API_BASE_URL`
