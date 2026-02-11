import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ExternalRunState = {
  active: boolean;
  source: "rollout" | "none";
  lastEventAt: string | null;
};

type ThreadRolloutState = {
  filePath: string;
  offset: number;
  remainder: string;
  pendingCallIds: Set<string>;
  lastRunStartedAtMs: number;
  lastRunActivityAtMs: number;
  lastAssistantMessageAtMs: number;
  lastTerminalAtMs: number;
  lastEventAtMs: number;
};

const ROLLOUT_INDEX_REFRESH_MS = 12_000;
const ROLLOUT_BOOTSTRAP_BYTES = 1_048_576;
const ROLLOUT_FILE_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const RUN_IDLE_TIMEOUT_MS = 15 * 60_000;
const STALE_PENDING_CALL_TIMEOUT_MS = 10 * 60_000;

const rolloutPathByThreadId = new Map<string, string>();
const stateByThreadId = new Map<string, ThreadRolloutState>();
let lastIndexRefreshAtMs = 0;
let indexRefreshPromise: Promise<void> | null = null;

function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function resolveSessionsRoot(): string {
  return path.join(resolveCodexHome(), "sessions");
}

function parseThreadIdFromFilename(name: string): string | null {
  const match = name.match(ROLLOUT_FILE_RE);
  if (!match?.[1]) return null;
  return match[1];
}

function parseTimestampMs(value: unknown): number {
  if (typeof value !== "string" || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAtMs(value: unknown): number {
  const parsed = parseTimestampMs(value);
  return parsed > 0 ? parsed : 0;
}

function markEvent(state: ThreadRolloutState, atMs: number): number {
  const effectiveAtMs = atMs > 0 ? atMs : state.lastEventAtMs;
  if (effectiveAtMs > state.lastEventAtMs) state.lastEventAtMs = effectiveAtMs;
  return effectiveAtMs;
}

function startRun(state: ThreadRolloutState, atMs: number): void {
  const effectiveAtMs = markEvent(state, atMs);
  state.pendingCallIds.clear();
  state.lastRunStartedAtMs = effectiveAtMs;
  state.lastRunActivityAtMs = effectiveAtMs;
  state.lastAssistantMessageAtMs = 0;
  state.lastTerminalAtMs = 0;
}

function markActivity(state: ThreadRolloutState, atMs: number): void {
  const effectiveAtMs = markEvent(state, atMs);
  if (!state.lastRunStartedAtMs) {
    state.lastRunStartedAtMs = effectiveAtMs;
    state.lastTerminalAtMs = 0;
  }
  if (effectiveAtMs > state.lastRunActivityAtMs) state.lastRunActivityAtMs = effectiveAtMs;
}

function markAssistantMessage(state: ThreadRolloutState, atMs: number): void {
  markActivity(state, atMs);
  if (atMs > state.lastAssistantMessageAtMs) state.lastAssistantMessageAtMs = atMs;
}

function markTerminal(state: ThreadRolloutState, atMs: number): void {
  const effectiveAtMs = markEvent(state, atMs);
  if (!state.lastRunStartedAtMs) state.lastRunStartedAtMs = effectiveAtMs;
  if (effectiveAtMs > state.lastTerminalAtMs) state.lastTerminalAtMs = effectiveAtMs;
  if (effectiveAtMs > state.lastRunActivityAtMs) state.lastRunActivityAtMs = effectiveAtMs;
  state.pendingCallIds.clear();
}

function resetState(state: ThreadRolloutState): void {
  state.offset = 0;
  state.remainder = "";
  state.pendingCallIds.clear();
  state.lastRunStartedAtMs = 0;
  state.lastRunActivityAtMs = 0;
  state.lastAssistantMessageAtMs = 0;
  state.lastTerminalAtMs = 0;
  state.lastEventAtMs = 0;
}

function isStateActive(state: ThreadRolloutState): boolean {
  if (state.lastRunStartedAtMs <= 0) return false;

  const nowMs = Date.now();
  const lastActivityAtMs = Math.max(state.lastRunActivityAtMs, state.lastRunStartedAtMs);

  // Explicit terminal marker always wins unless later activity happened.
  if (
    state.lastTerminalAtMs > 0 &&
    state.lastTerminalAtMs >= lastActivityAtMs &&
    state.pendingCallIds.size === 0
  ) {
    return false;
  }

  if (state.pendingCallIds.size > 0) {
    const pendingIdleMs = nowMs - lastActivityAtMs;
    return pendingIdleMs <= STALE_PENDING_CALL_TIMEOUT_MS;
  }

  const idleMs = nowMs - lastActivityAtMs;
  if (idleMs > RUN_IDLE_TIMEOUT_MS) return false;

  return true;
}

function extractCallId(payload: Record<string, unknown>): string {
  const callId = payload.call_id;
  return typeof callId === "string" && callId.trim() ? callId : "";
}

function trackCallStarted(state: ThreadRolloutState, payload: Record<string, unknown>, atMs: number): void {
  const callId = extractCallId(payload);
  if (callId) state.pendingCallIds.add(callId);
  markActivity(state, atMs);
}

function trackCallCompleted(state: ThreadRolloutState, payload: Record<string, unknown>, atMs: number): void {
  const callId = extractCallId(payload);
  if (callId) state.pendingCallIds.delete(callId);
  markActivity(state, atMs);
}

function applyRolloutLine(state: ThreadRolloutState, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let entry: any = null;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (!entry || typeof entry !== "object") return;
  const atMs = normalizeAtMs(entry.timestamp);
  markEvent(state, atMs);

  const entryType = typeof entry.type === "string" ? entry.type : "";
  const payload = entry.payload && typeof entry.payload === "object" ? entry.payload : {};

  if (entryType === "session_meta") {
    return;
  }
  if (entryType === "thread.started" || entryType === "thread_started") {
    // Thread creation does not imply an active run.
    markEvent(state, atMs);
    return;
  }
  if (entryType === "turn.started" || entryType === "turn_started") {
    startRun(state, atMs);
    return;
  }
  if (
    entryType === "turn.completed" ||
    entryType === "turn_completed" ||
    entryType === "turn.aborted" ||
    entryType === "turn_aborted"
  ) {
    markTerminal(state, atMs);
    return;
  }
  if (entryType === "item.started" || entryType === "item_started") {
    markActivity(state, atMs);
    return;
  }
  if (entryType === "item.completed" || entryType === "item_completed") {
    markActivity(state, atMs);
    return;
  }

  if (entryType === "event_msg") {
    const msgType = typeof payload.type === "string" ? payload.type : "";
    if (msgType === "user_message" || msgType === "task_started" || msgType === "turn_started") {
      startRun(state, atMs);
      return;
    }
    if (msgType === "agent_message") {
      markAssistantMessage(state, atMs);
      // Some short runs omit explicit task/turn completion events in rollout.
      // When no tool call is pending, treat a full assistant message as terminal.
      if (state.pendingCallIds.size === 0) {
        markTerminal(state, atMs);
      }
      return;
    }
    if (
      msgType === "agent_reasoning" ||
      msgType === "agent_message_delta" ||
      msgType === "agent_reasoning_delta" ||
      msgType === "agent_reasoning_raw_content" ||
      msgType === "agent_reasoning_raw_content_delta" ||
      msgType === "agent_message_content_delta" ||
      msgType === "reasoning_content_delta" ||
      msgType === "reasoning_raw_content_delta" ||
      msgType === "plan_delta" ||
      msgType === "plan_update" ||
      msgType === "item_started" ||
      msgType === "item_completed"
    ) {
      markActivity(state, atMs);
      return;
    }
    if (
      msgType === "task_complete" ||
      msgType === "turn_complete" ||
      msgType === "turn_aborted" ||
      msgType === "stream_error" ||
      msgType === "shutdown_complete"
    ) {
      markTerminal(state, atMs);
    }
    return;
  }

  if (entryType === "turn_context") {
    // Turn context snapshots are frequent and not a reliable start signal.
    if (state.lastRunStartedAtMs > 0 && isStateActive(state)) {
      markActivity(state, atMs);
    }
    return;
  }

  if (entryType !== "response_item") return;

  const payloadType = typeof payload.type === "string" ? payload.type : "";
  if (
    payloadType === "function_call" ||
    payloadType === "custom_tool_call" ||
    payloadType === "local_shell_call"
  ) {
    trackCallStarted(state, payload, atMs);
    return;
  }
  if (
    payloadType === "function_call_output" ||
    payloadType === "custom_tool_call_output" ||
    payloadType === "local_shell_call_output"
  ) {
    trackCallCompleted(state, payload, atMs);
    return;
  }
  if (payloadType === "web_search_call" || payloadType === "tool_call") {
    markActivity(state, atMs);
    return;
  }
  if (payloadType === "message") {
    const role = typeof payload.role === "string" ? payload.role : "";
    const phase = typeof payload.phase === "string" ? payload.phase : "";
    if (role === "user") {
      startRun(state, atMs);
      return;
    }
    if (role === "assistant") {
      markAssistantMessage(state, atMs);
      if (phase === "final_answer" || (!phase && state.pendingCallIds.size === 0)) {
        markTerminal(state, atMs);
      }
      return;
    }
    if (phase === "final_answer") {
      markTerminal(state, atMs);
      return;
    }
    markActivity(state, atMs);
    return;
  }
  if (
    payloadType === "reasoning" ||
    payloadType === "web_search_call_output" ||
    payloadType === "compaction" ||
    payloadType === "ghost_snapshot"
  ) {
    markActivity(state, atMs);
  }
}

async function walkRolloutDirectory(dirPath: string, target: Map<string, string>): Promise<void> {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkRolloutDirectory(fullPath, target);
      continue;
    }
    if (!entry.isFile()) continue;

    const threadId = parseThreadIdFromFilename(entry.name);
    if (!threadId) continue;
    const existingPath = target.get(threadId);
    if (!existingPath || path.basename(fullPath) > path.basename(existingPath)) {
      target.set(threadId, fullPath);
    }
  }
}

async function refreshRolloutIndex(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastIndexRefreshAtMs < ROLLOUT_INDEX_REFRESH_MS) return;
  if (indexRefreshPromise) return indexRefreshPromise;

  indexRefreshPromise = (async () => {
    const nextByThreadId = new Map<string, string>();
    await walkRolloutDirectory(resolveSessionsRoot(), nextByThreadId);

    rolloutPathByThreadId.clear();
    for (const [threadId, filePath] of nextByThreadId.entries()) {
      rolloutPathByThreadId.set(threadId, filePath);
    }

    for (const [threadId, state] of stateByThreadId.entries()) {
      const nextPath = rolloutPathByThreadId.get(threadId);
      if (!nextPath || nextPath !== state.filePath) {
        stateByThreadId.delete(threadId);
      }
    }

    lastIndexRefreshAtMs = Date.now();
  })().finally(() => {
    indexRefreshPromise = null;
  });

  return indexRefreshPromise;
}

async function syncThreadState(state: ThreadRolloutState): Promise<void> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(state.filePath, "r");
    const stat = await handle.stat();
    const size = Number(stat.size);
    if (!Number.isFinite(size) || size <= 0) {
      resetState(state);
      return;
    }

    let startOffset = state.offset;
    let dropLeadingPartialLine = false;

    if (startOffset === 0 && size > ROLLOUT_BOOTSTRAP_BYTES) {
      startOffset = size - ROLLOUT_BOOTSTRAP_BYTES;
      state.offset = startOffset;
      state.remainder = "";
      dropLeadingPartialLine = true;
    }

    if (startOffset > size) {
      resetState(state);
      startOffset = 0;
    }

    if (startOffset === size) return;

    const readLength = size - startOffset;
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, startOffset);
    if (bytesRead <= 0) return;

    state.offset = startOffset + bytesRead;
    let chunk = buffer.toString("utf8", 0, bytesRead);
    if (!dropLeadingPartialLine && state.remainder) {
      chunk = state.remainder + chunk;
    }

    const lines = chunk.split("\n");
    if (dropLeadingPartialLine && lines.length > 0) {
      lines.shift();
    }
    state.remainder = lines.pop() ?? "";

    for (const line of lines) {
      applyRolloutLine(state, line);
    }
  } catch {
    // ignore transient file IO errors
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

export async function getExternalRunState(threadId: string): Promise<ExternalRunState> {
  if (!threadId) return { active: false, source: "none", lastEventAt: null };

  await refreshRolloutIndex();

  const filePath = rolloutPathByThreadId.get(threadId);
  if (!filePath) return { active: false, source: "none", lastEventAt: null };

  let state = stateByThreadId.get(threadId);
  if (!state || state.filePath !== filePath) {
    state = {
      filePath,
      offset: 0,
      remainder: "",
      pendingCallIds: new Set<string>(),
      lastRunStartedAtMs: 0,
      lastRunActivityAtMs: 0,
      lastAssistantMessageAtMs: 0,
      lastTerminalAtMs: 0,
      lastEventAtMs: 0,
    };
    stateByThreadId.set(threadId, state);
  }

  await syncThreadState(state);
  return {
    active: isStateActive(state),
    source: "rollout",
    lastEventAt: state.lastEventAtMs ? new Date(state.lastEventAtMs).toISOString() : null,
  };
}
