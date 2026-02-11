# Codex Desktop Live Sync (PocketDex)

Date: 2026-02-07

## Goal

Mirror PocketDex runs in Codex Desktop in real time, including:

- thread reorder in sidebar
- streaming spinner visibility
- unread blue dot at completion
- automatic return to normal editable mode (no persistent follower lock)

## Implemented Flow

Source file:

- `/Users/valence/PocketDex/server/src/desktopLiveSync.ts`

Integration point:

- `/Users/valence/PocketDex/server/src/index.ts`

### 1) Outgoing user message registration

Before `turn/start`, PocketDex stores a short user text fallback per thread.  
This is used only if a synthetic in-progress turn is temporarily needed.

### 2) In-progress live snapshots

On app-server notifications:

- `turn/started`: immediate snapshot with in-progress state
- `item/*`: throttled in-progress snapshots (to keep spinner alive without flooding)

IPC broadcast:

- method: `thread-stream-state-changed`
- version: `4`

### 3) Completion snapshot + unread

On `turn/completed`:

- snapshot with completed state
- `hasUnreadTurn=true`
- nudge for list refresh

On `turn/aborted` or `error`:

- snapshot with completed/stopped state
- `hasUnreadTurn=false`

### 4) Auto-unlock follower mode

After completion/stopped (delayed):

1. `thread-archived` (version `1`)
2. short delay
3. `thread-unarchived` (version `0`)

This clears the follower role in desktop cache and restores composer editing without restarting Codex Desktop.

## Why this works

- `thread-stream-state-changed` gives immediate live visual sync.
- The archive/unarchive pair clears follower-lock side effects introduced by stream snapshots.
- Using real `thread/read` data for turns preserves user messages in UI.

## Environment Variables

- `POCKETDEX_ENABLE_DESKTOP_LIVE_SYNC`
  - default: enabled (`1`)
  - set `0` to disable this subsystem
- `POCKETDEX_DESKTOP_LIVE_PROGRESS_THROTTLE_MS`
  - default: `220`
- `POCKETDEX_DESKTOP_LIVE_UNLOCK_DELAY_MS`
  - default: `1200`
- `POCKETDEX_DESKTOP_LIVE_ARCHIVE_GAP_MS`
  - default: `260`

## Operational Notes

- IPC socket expected: `/tmp/codex-ipc/ipc-<uid>.sock`
- If socket is missing, subsystem stays idle and logs one warning.
- Broadcast ordering is serialized through an internal queue to avoid race conditions.
- The feature is desktop-macOS oriented (named pipe path on Windows is stubbed but untested).

## Quick Validation Checklist

1. Send a message from PocketDex on an existing thread.
2. In Codex Desktop, verify:
   - spinner appears during generation
   - thread moves up in sidebar
   - blue unread dot appears at end
   - composer is editable again after completion
3. Repeat on a newly created thread.
