# Architecture

PocketDex is built around a simple local stack:

1. A native macOS menu bar app (`PocketDexApp`)
2. A local Node.js server (`server`)
3. A web UI (`web`)
4. Codex runtime (`codex app-server`)

## Runtime Flow

1. `PocketDexApp` starts/stops the local Node server process.
2. The Node server launches and proxies `codex app-server`.
3. The web app talks to the Node API and stream endpoints.
4. Sparkle checks GitHub Releases for app updates.

## Component Responsibilities

- `PocketDexApp/`
  - process control (run/stop)
  - open web UI and logs
  - update checks via Sparkle
- `server/`
  - API layer
  - real-time stream bridge
  - Codex process orchestration
- `web/`
  - browser interface for interacting with running sessions
- `scripts/`
  - build artifacts
  - install helpers
  - release publishing
