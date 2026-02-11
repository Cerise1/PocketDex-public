import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AppServerBridge } from "./appServerBridge.js";

type AppServerNotification = {
  method: string;
  params: any;
};

type DesktopLiveSyncOptions = {
  enabled: boolean;
  progressThrottleMs: number;
  unlockDelayMs: number;
  archiveUnarchiveGapMs: number;
  defaultCwd: string;
};

type DesktopBroadcastMethod = "thread-stream-state-changed" | "thread-archived" | "thread-unarchived";

type DesktopBroadcast = {
  method: DesktopBroadcastMethod;
  params: Record<string, unknown>;
  version: number;
};

type ThreadSyncSession = {
  runSequence: number;
  streaming: boolean;
  progressTimer: NodeJS.Timeout | null;
  unlockTimer: NodeJS.Timeout | null;
  unlockTargetRunSequence: number | null;
};

type ThreadReadResult = {
  thread?: {
    id?: string;
    preview?: string;
    title?: string;
    source?: string;
    path?: string;
    rolloutPath?: string;
    cwd?: string;
    createdAt?: number | string;
    updatedAt?: number | string;
    latestModel?: string;
    latestReasoningEffort?: string | null;
    latestCollaborationMode?: unknown;
    latestTokenUsageInfo?: unknown;
    resumeState?: string;
    requests?: unknown[];
    gitInfo?: unknown;
    turns?: Array<{
      id?: string;
      status?: unknown;
      error?: unknown;
      items?: unknown[];
    }>;
  };
};

type SnapshotApprovalPolicy = "never" | "on-request";
type SnapshotSandboxType = "danger-full-access" | "workspace-write" | "read-only";
type DesktopSandboxType = "dangerFullAccess" | "workspaceWrite" | "readOnly";

type SnapshotTurnSecurity = {
  approvalPolicy?: SnapshotApprovalPolicy;
  sandboxPolicy?: {
    type: SnapshotSandboxType;
    writableRoots?: string[];
    networkAccess?: boolean;
  };
};

const METHOD_VERSION: Record<DesktopBroadcastMethod, number> = {
  "thread-stream-state-changed": 4,
  "thread-archived": 1,
  "thread-unarchived": 0,
};

const DEFAULT_PROGRESS_THROTTLE_MS = 220;
const DEFAULT_UNLOCK_DELAY_MS = 1200;
const DEFAULT_ARCHIVE_UNARCHIVE_GAP_MS = 260;
const SNAPSHOT_SECURITY_TAIL_BYTES = 262_144;
const IPC_TIMEOUT_MS = 2500;
const IPC_WRITE_FLUSH_MS = 70;
const TITLE_DEBUG_ENABLED = process.env.POCKETDEX_TITLE_DEBUG !== "0";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(MODULE_DIR, "..");
const WORKSPACE_DIR = path.resolve(SERVER_DIR, "..");
const DEFAULT_DEBUG_LOG_DIR = path.join(WORKSPACE_DIR, ".tmp", "logs");
const TITLE_DEBUG_LOG_PATH =
  process.env.POCKETDEX_TITLE_DEBUG_LOG?.trim() || path.join(DEFAULT_DEBUG_LOG_DIR, "pocketdex-title-debug.jsonl");

const snapshotSecurityCacheByRolloutPath = new Map<
  string,
  { size: number; mtimeMs: number; security: SnapshotTurnSecurity | null }
>();

type TitleDebugRecord = {
  at: string;
  source: string;
  event: string;
  threadId: string | null;
  detail: Record<string, unknown>;
};

export class DesktopLiveSync {
  private readonly bridge: AppServerBridge;
  private readonly options: DesktopLiveSyncOptions;
  private readonly sessions = new Map<string, ThreadSyncSession>();
  private readonly pendingUserTextByThreadId = new Map<string, string>();
  private readonly preservedTitleByThreadId = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private warnedIpcMissing = false;

  constructor(bridge: AppServerBridge, options?: Partial<DesktopLiveSyncOptions>) {
    this.bridge = bridge;
    this.options = {
      enabled: options?.enabled ?? true,
      progressThrottleMs: Math.max(80, options?.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS),
      unlockDelayMs: Math.max(200, options?.unlockDelayMs ?? DEFAULT_UNLOCK_DELAY_MS),
      archiveUnarchiveGapMs: Math.max(80, options?.archiveUnarchiveGapMs ?? DEFAULT_ARCHIVE_UNARCHIVE_GAP_MS),
      defaultCwd: options?.defaultCwd ?? process.cwd(),
    };

    if (this.options.enabled) {
      console.info(
        `[DesktopLiveSync] enabled (progressThrottleMs=${this.options.progressThrottleMs}, unlockDelayMs=${this.options.unlockDelayMs})`
      );
      recordTitleDebug("desktop_live_sync_enabled", {
        detail: {
          progressThrottleMs: this.options.progressThrottleMs,
          unlockDelayMs: this.options.unlockDelayMs,
          archiveUnarchiveGapMs: this.options.archiveUnarchiveGapMs,
        },
      });
    } else {
      console.info("[DesktopLiveSync] disabled");
    }
  }

  registerOutgoingUserText(threadId: string, text: string): void {
    if (!this.options.enabled) return;
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) return;
    const normalizedText = String(text || "").trim();
    if (!normalizedText) return;
    this.pendingUserTextByThreadId.set(normalizedThreadId, normalizedText);
  }

  registerKnownTitle(threadId: string, title: string): void {
    if (!this.options.enabled) return;
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) return;
    const normalizedTitle = normalizeNonEmptyString(title);
    if (!normalizedTitle) return;
    const previousTitle = this.preservedTitleByThreadId.get(normalizedThreadId) ?? null;
    this.preservedTitleByThreadId.set(normalizedThreadId, normalizedTitle);
    recordTitleDebug("desktop_register_known_title", {
      threadId: normalizedThreadId,
      detail: {
        previousTitle,
        incomingTitle: normalizedTitle,
        changed: previousTitle !== normalizedTitle,
      },
    });
  }

  getKnownTitle(threadId: string): string | null {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) return null;
    return this.preservedTitleByThreadId.get(normalizedThreadId) ?? null;
  }

  handleNotification(note: AppServerNotification): void {
    if (!this.options.enabled) return;
    const threadId = extractThreadId(note.params);
    if (!threadId) return;

    if (
      note.method === "turn/started" ||
      note.method === "turn/completed" ||
      note.method === "turn/aborted" ||
      note.method === "error" ||
      note.method === "thread/started" ||
      note.method === "thread/name/updated"
    ) {
      recordTitleDebug("desktop_notification_received", {
        threadId,
        detail: {
          method: note.method,
          eventTitle: normalizeNonEmptyString(note.params?.threadName ?? note.params?.thread_name) ?? null,
        },
      });
    }

    if (note.method === "turn/started") {
      this.handleTurnStarted(threadId);
      return;
    }

    if (note.method === "turn/completed") {
      this.handleTurnCompleted(threadId);
      return;
    }

    if (note.method === "turn/aborted" || note.method === "error") {
      this.handleTurnStopped(threadId);
      return;
    }

    if (note.method === "thread/started") {
      // Ensure brand new threads show up in Desktop list immediately.
      this.enqueue(async () => {
        await this.sendUnarchiveNudge(threadId);
      });
      return;
    }

    if (note.method.startsWith("item/")) {
      this.scheduleProgressSnapshot(threadId);
    }
  }

  private getOrCreateSession(threadId: string): ThreadSyncSession {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;
    const session: ThreadSyncSession = {
      runSequence: 0,
      streaming: false,
      progressTimer: null,
      unlockTimer: null,
      unlockTargetRunSequence: null,
    };
    this.sessions.set(threadId, session);
    return session;
  }

  private handleTurnStarted(threadId: string): void {
    const session = this.getOrCreateSession(threadId);
    session.runSequence += 1;
    session.streaming = true;
    if (session.unlockTimer) {
      recordTitleDebug("desktop_unlock_timer_cleared_on_turn_started", {
        threadId,
        detail: {
          previousTargetRunSequence: session.unlockTargetRunSequence,
          nextRunSequence: session.runSequence,
        },
      });
      clearTimeout(session.unlockTimer);
      session.unlockTimer = null;
      session.unlockTargetRunSequence = null;
    }
    this.enqueue(async () => {
      await this.sendSnapshot(threadId, { forceInProgress: true, hasUnreadTurn: false, nudgeThreadList: true });
    });
    recordTitleDebug("desktop_turn_started", {
      threadId,
      detail: { runSequence: session.runSequence },
    });
  }

  private handleTurnCompleted(threadId: string): void {
    const session = this.getOrCreateSession(threadId);
    session.streaming = false;
    if (session.progressTimer) {
      clearTimeout(session.progressTimer);
      session.progressTimer = null;
    }
    const sequenceAtCompletion = session.runSequence;
    this.enqueue(async () => {
      await this.sendSnapshot(threadId, { forceInProgress: false, hasUnreadTurn: true, nudgeThreadList: true });
      this.scheduleUnlock(threadId, sequenceAtCompletion);
    });
    this.pendingUserTextByThreadId.delete(threadId);
    recordTitleDebug("desktop_turn_completed", {
      threadId,
      detail: { runSequence: sequenceAtCompletion },
    });
  }

  private handleTurnStopped(threadId: string): void {
    const session = this.getOrCreateSession(threadId);
    session.streaming = false;
    if (session.progressTimer) {
      clearTimeout(session.progressTimer);
      session.progressTimer = null;
    }
    const sequenceAtStop = session.runSequence;
    this.enqueue(async () => {
      await this.sendSnapshot(threadId, { forceInProgress: false, hasUnreadTurn: false, nudgeThreadList: true });
      this.scheduleUnlock(threadId, sequenceAtStop);
    });
    this.pendingUserTextByThreadId.delete(threadId);
    recordTitleDebug("desktop_turn_stopped", {
      threadId,
      detail: { runSequence: sequenceAtStop },
    });
  }

  private scheduleProgressSnapshot(threadId: string): void {
    const session = this.getOrCreateSession(threadId);
    if (!session.streaming) return;
    if (session.progressTimer) return;
    session.progressTimer = setTimeout(() => {
      session.progressTimer = null;
      this.enqueue(async () => {
        await this.sendSnapshot(threadId, { forceInProgress: true, hasUnreadTurn: false, nudgeThreadList: false });
      });
    }, this.options.progressThrottleMs);
    session.progressTimer.unref();
  }

  private scheduleUnlock(threadId: string, targetRunSequence: number): void {
    const session = this.getOrCreateSession(threadId);
    if (session.unlockTimer) {
      recordTitleDebug("desktop_unlock_timer_replaced", {
        threadId,
        detail: {
          previousTargetRunSequence: session.unlockTargetRunSequence,
          nextTargetRunSequence: targetRunSequence,
        },
      });
      clearTimeout(session.unlockTimer);
      session.unlockTimer = null;
    }
    session.unlockTargetRunSequence = targetRunSequence;
    recordTitleDebug("desktop_unlock_scheduled", {
      threadId,
      detail: {
        targetRunSequence,
        unlockDelayMs: this.options.unlockDelayMs,
      },
    });
    session.unlockTimer = setTimeout(() => {
      session.unlockTimer = null;
      recordTitleDebug("desktop_unlock_timer_fired", {
        threadId,
        detail: {
          targetRunSequence,
        },
      });
      this.enqueue(async () => {
        const latest = this.sessions.get(threadId);
        if (!latest) {
          recordTitleDebug("desktop_unlock_skipped_no_session", {
            threadId,
            detail: { targetRunSequence },
          });
          return;
        }
        if (latest.streaming) {
          recordTitleDebug("desktop_unlock_skipped_streaming", {
            threadId,
            detail: {
              targetRunSequence,
              currentRunSequence: latest.runSequence,
            },
          });
          return;
        }
        if (latest.runSequence !== targetRunSequence) {
          recordTitleDebug("desktop_unlock_skipped_sequence_mismatch", {
            threadId,
            detail: {
              targetRunSequence,
              currentRunSequence: latest.runSequence,
            },
          });
          return;
        }
        recordTitleDebug("desktop_unlock_execute", {
          threadId,
          detail: { targetRunSequence },
        });
        await this.unlockFollowerMode(threadId);
      });
    }, this.options.unlockDelayMs);
    session.unlockTimer.unref();
  }

  private async sendSnapshot(
    threadId: string,
    options: { forceInProgress: boolean; hasUnreadTurn: boolean; nudgeThreadList: boolean }
  ): Promise<void> {
    const thread = await this.readThread(threadId);
    if (!thread) return;
    const snapshotSecurity = await this.resolveSnapshotTurnSecurity(thread);
    const previousPreservedTitle = this.preservedTitleByThreadId.get(threadId) ?? null;
    const liveTitle = normalizeNonEmptyString(thread.title);
    if (liveTitle) {
      this.preservedTitleByThreadId.set(threadId, liveTitle);
    }
    const preservedTitle = liveTitle ?? previousPreservedTitle ?? null;
    recordTitleDebug("desktop_snapshot_title_resolution", {
      threadId,
      detail: {
        liveTitle,
        previousPreservedTitle,
        resolvedTitle: preservedTitle,
        forceInProgress: options.forceInProgress,
        hasUnreadTurn: options.hasUnreadTurn,
        nudgeThreadList: options.nudgeThreadList,
        snapshotSecurity: snapshotSecurity ?? null,
      },
    });

    const conversationState = buildConversationState({
      thread,
      forceInProgress: options.forceInProgress,
      hasUnreadTurn: options.hasUnreadTurn,
      pendingUserText: this.pendingUserTextByThreadId.get(threadId) ?? null,
      preservedTitle,
      defaultCwd: this.options.defaultCwd,
      turnSecurity: snapshotSecurity,
    });

    const broadcasts: DesktopBroadcast[] = [];
    if (options.nudgeThreadList) {
      broadcasts.push({
        method: "thread-unarchived",
        version: METHOD_VERSION["thread-unarchived"],
        params: { conversationId: threadId },
      });
    }
    broadcasts.push({
      method: "thread-stream-state-changed",
      version: METHOD_VERSION["thread-stream-state-changed"],
      params: {
        conversationId: threadId,
        change: {
          type: "snapshot",
          conversationState,
        },
      },
    });

    recordTitleDebug("desktop_snapshot_broadcast", {
      threadId,
      detail: {
        methods: broadcasts.map((entry) => entry.method),
        resolvedTitle: preservedTitle,
      },
    });
    await this.sendDesktopBroadcasts(broadcasts);
  }

  private async resolveSnapshotTurnSecurity(
    thread: NonNullable<ThreadReadResult["thread"]>
  ): Promise<SnapshotTurnSecurity | null> {
    const rolloutPath = normalizeNonEmptyString(thread.rolloutPath) ?? normalizeNonEmptyString(thread.path);
    if (!rolloutPath) return null;
    return readLatestSnapshotSecurityFromRolloutPath(rolloutPath);
  }

  private async sendUnarchiveNudge(threadId: string): Promise<void> {
    recordTitleDebug("desktop_send_unarchive_nudge", { threadId });
    await this.sendDesktopBroadcasts([
      {
        method: "thread-unarchived",
        version: METHOD_VERSION["thread-unarchived"],
        params: { conversationId: threadId },
      },
    ]);
  }

  private async unlockFollowerMode(threadId: string): Promise<void> {
    const thread = await this.readThread(threadId);
    const cwd = normalizeNonEmptyString(thread?.cwd) ?? this.options.defaultCwd;
    recordTitleDebug("desktop_unlock_follower_mode_archive", {
      threadId,
      detail: { cwd },
    });
    await this.sendDesktopBroadcasts([
      {
        method: "thread-archived",
        version: METHOD_VERSION["thread-archived"],
        params: { conversationId: threadId, cwd },
      },
    ]);
    await sleep(this.options.archiveUnarchiveGapMs);
    recordTitleDebug("desktop_unlock_follower_mode_unarchive", {
      threadId,
      detail: { gapMs: this.options.archiveUnarchiveGapMs },
    });
    await this.sendDesktopBroadcasts([
      {
        method: "thread-unarchived",
        version: METHOD_VERSION["thread-unarchived"],
        params: { conversationId: threadId },
      },
    ]);
  }

  private async readThread(threadId: string): Promise<ThreadReadResult["thread"] | null> {
    try {
      const result = (await this.bridge.request("thread/read", {
        threadId,
        includeTurns: true,
      })) as ThreadReadResult;
      if (!result?.thread || typeof result.thread !== "object") return null;
      recordTitleDebug("desktop_thread_read", {
        threadId,
        detail: {
          title: normalizeNonEmptyString(result.thread.title) ?? null,
          turnCount: Array.isArray(result.thread.turns) ? result.thread.turns.length : 0,
          resumeState: normalizeNonEmptyString(result.thread.resumeState) ?? null,
        },
      });
      return result.thread;
    } catch (error) {
      console.warn(`[DesktopLiveSync] failed to read thread ${threadId}: ${error instanceof Error ? error.message : "unknown"}`);
      recordTitleDebug("desktop_thread_read_failed", {
        threadId,
        detail: { error: error instanceof Error ? error.message : "unknown" },
      });
      return null;
    }
  }

  private async sendDesktopBroadcasts(broadcasts: DesktopBroadcast[]): Promise<void> {
    if (broadcasts.length === 0) return;
    recordTitleDebug("desktop_broadcast_batch", {
      detail: {
        count: broadcasts.length,
        methods: broadcasts.map((entry) => entry.method),
      },
    });
    const socketPath = resolveCodexIpcSocketPath();
    if (!socketPath) return;

    if (process.platform !== "win32" && !existsSync(socketPath)) {
      if (!this.warnedIpcMissing) {
        this.warnedIpcMissing = true;
        console.warn(`[DesktopLiveSync] Codex IPC socket not found at ${socketPath}; desktop live sync is idle`);
      }
      return;
    }
    this.warnedIpcMissing = false;

    try {
      await sendBroadcastBatch(socketPath, broadcasts);
    } catch (error) {
      console.warn(
        `[DesktopLiveSync] failed to send desktop broadcasts: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .then(task)
      .catch((error) => {
        console.warn(
          `[DesktopLiveSync] queued task failed: ${error instanceof Error ? error.message : "unknown error"}`
        );
      });
  }
}

export function createDesktopLiveSync(bridge: AppServerBridge): DesktopLiveSync {
  const enabled = process.env.POCKETDEX_ENABLE_DESKTOP_LIVE_SYNC !== "0";
  const progressThrottleMs = parsePositiveInt(process.env.POCKETDEX_DESKTOP_LIVE_PROGRESS_THROTTLE_MS, DEFAULT_PROGRESS_THROTTLE_MS);
  const unlockDelayMs = parsePositiveInt(process.env.POCKETDEX_DESKTOP_LIVE_UNLOCK_DELAY_MS, DEFAULT_UNLOCK_DELAY_MS);
  const archiveUnarchiveGapMs = parsePositiveInt(
    process.env.POCKETDEX_DESKTOP_LIVE_ARCHIVE_GAP_MS,
    DEFAULT_ARCHIVE_UNARCHIVE_GAP_MS
  );
  return new DesktopLiveSync(bridge, {
    enabled,
    progressThrottleMs,
    unlockDelayMs,
    archiveUnarchiveGapMs,
    defaultCwd: process.cwd(),
  });
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function extractThreadId(params: any): string | null {
  if (!params || typeof params !== "object") return null;
  const direct = params.threadId ?? params.thread_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const conversationId = params.conversationId ?? params.conversation_id;
  if (typeof conversationId === "string" && conversationId.trim()) return conversationId.trim();
  const fromItem = params.item?.threadId ?? params.item?.thread_id;
  if (typeof fromItem === "string" && fromItem.trim()) return fromItem.trim();
  const fromTurn = params.turn?.threadId ?? params.turn?.thread_id;
  if (typeof fromTurn === "string" && fromTurn.trim()) return fromTurn.trim();
  const nested = params.thread?.id;
  if (typeof nested === "string" && nested.trim()) return nested.trim();
  return null;
}

function resolveCodexIpcSocketPath(): string | null {
  if (process.platform === "win32") return "\\\\.\\pipe\\codex-ipc";
  const root = path.join(os.tmpdir(), "codex-ipc");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const name = uid ? `ipc-${uid}.sock` : "ipc.sock";
  return path.join(root, name);
}

async function sendBroadcastBatch(socketPath: string, broadcasts: DesktopBroadcast[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const initRequestId = randomUUID();
    let clientId = "initializing-client";
    let settled = false;
    let initSent = false;
    let expectedLength: number | null = null;
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      finish(new Error("ipc-timeout"));
    }, IPC_TIMEOUT_MS);
    timeout.unref();

    const socket = net.createConnection(socketPath, () => {
      initSent = true;
      writeFrame(socket, {
        type: "request",
        requestId: initRequestId,
        sourceClientId: "initializing-client",
        method: "initialize",
        params: { clientType: "pocketdex_server_live_sync" },
      });
    });

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.end();
      } catch {
        // ignore
      }
      if (error) reject(error);
      else resolve();
    }

    socket.on("error", (error) => {
      finish(error instanceof Error ? error : new Error("ipc-socket-error"));
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (expectedLength === null) {
          if (buffer.length < 4) return;
          expectedLength = buffer.readUInt32LE(0);
          buffer = buffer.subarray(4);
        }
        if (buffer.length < expectedLength) return;
        const frame = buffer.subarray(0, expectedLength);
        buffer = buffer.subarray(expectedLength);
        expectedLength = null;

        let parsed: any = null;
        try {
          parsed = JSON.parse(frame.toString("utf8"));
        } catch {
          continue;
        }

        if (parsed?.type === "client-discovery-request" && typeof parsed.requestId === "string") {
          writeFrame(socket, {
            type: "client-discovery-response",
            requestId: parsed.requestId,
            response: { canHandle: false },
          });
          continue;
        }

        if (
          parsed?.type === "response" &&
          parsed?.requestId === initRequestId &&
          parsed?.resultType === "success" &&
          parsed?.method === "initialize"
        ) {
          const nextClientId = normalizeNonEmptyString(parsed?.result?.clientId);
          if (nextClientId) clientId = nextClientId;
          for (const broadcast of broadcasts) {
            writeFrame(socket, {
              type: "broadcast",
              method: broadcast.method,
              sourceClientId: clientId,
              version: broadcast.version,
              params: broadcast.params,
            });
          }
          setTimeout(() => finish(), IPC_WRITE_FLUSH_MS).unref();
        }
      }
    });

    socket.on("close", () => {
      if (!settled && initSent) {
        finish(new Error("ipc-closed-before-complete"));
      } else if (!settled) {
        finish(new Error("ipc-closed"));
      }
    });
  });
}

function writeFrame(socket: net.Socket, payload: object): void {
  if (socket.destroyed || socket.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  socket.write(Buffer.concat([header, body]));
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toEpochMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return value;
    if (value > 1_000_000_000) return value * 1000;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return toEpochMs(numeric);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isTurnInProgress(status: unknown): boolean {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]/g, "");
  return ["inprogress", "running", "started", "pending", "active", "executing"].includes(normalized);
}

function normalizeSnapshotApprovalPolicy(value: unknown): SnapshotApprovalPolicy | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "never") return "never";
  if (normalized === "on-request") return "on-request";
  return null;
}

function normalizeSnapshotSandboxType(value: unknown): SnapshotSandboxType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "danger-full-access") return "danger-full-access";
  if (normalized === "workspace-write") return "workspace-write";
  if (normalized === "read-only") return "read-only";
  return null;
}

function toDesktopSandboxType(type: SnapshotSandboxType): DesktopSandboxType {
  if (type === "danger-full-access") return "dangerFullAccess";
  if (type === "read-only") return "readOnly";
  return "workspaceWrite";
}

function normalizeWritableRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const roots: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    roots.push(trimmed);
  }
  return roots;
}

function buildConversationSecurityParams(turnSecurity: SnapshotTurnSecurity | null, cwd: string): Record<string, unknown> {
  if (!turnSecurity) return {};
  const params: Record<string, unknown> = {};

  if (turnSecurity.approvalPolicy) {
    params.approvalPolicy = turnSecurity.approvalPolicy;
  }

  const sandboxType = turnSecurity.sandboxPolicy?.type;
  if (sandboxType) {
    const sandboxPolicy: Record<string, unknown> = { type: toDesktopSandboxType(sandboxType) };
    if (sandboxType === "workspace-write") {
      const configuredRoots = normalizeWritableRoots(turnSecurity.sandboxPolicy?.writableRoots ?? []);
      sandboxPolicy.writableRoots = configuredRoots.length > 0 ? configuredRoots : [cwd];
    }
    if (typeof turnSecurity.sandboxPolicy?.networkAccess === "boolean") {
      sandboxPolicy.networkAccess = turnSecurity.sandboxPolicy.networkAccess;
    }
    params.sandboxPolicy = sandboxPolicy;
  }

  return params;
}

async function readLatestSnapshotSecurityFromRolloutPath(rolloutPath: string): Promise<SnapshotTurnSecurity | null> {
  let stat: { size: number; mtimeMs: number } | null = null;
  try {
    const nextStat = await fs.stat(rolloutPath);
    stat = {
      size: Number(nextStat.size),
      mtimeMs: Number(nextStat.mtimeMs),
    };
  } catch {
    return null;
  }

  const cached = snapshotSecurityCacheByRolloutPath.get(rolloutPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.security;
  }

  let security: SnapshotTurnSecurity | null = null;
  let handle: fs.FileHandle | null = null;
  try {
    const totalSize = Math.max(0, stat.size);
    if (totalSize > 0) {
      const readSize = Math.min(totalSize, SNAPSHOT_SECURITY_TAIL_BYTES);
      const start = totalSize - readSize;
      handle = await fs.open(rolloutPath, "r");
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, start);
      const lines = buffer.toString("utf8").split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const rawLine = lines[index]?.trim();
        if (!rawLine) continue;
        let parsed: any = null;
        try {
          parsed = JSON.parse(rawLine);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object" || parsed.type !== "turn_context") continue;
        const payload = parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {};
        const approvalPolicy = normalizeSnapshotApprovalPolicy(payload.approval_policy);
        const sandboxType = normalizeSnapshotSandboxType(payload.sandbox_policy?.type);
        if (!approvalPolicy && !sandboxType) continue;
        const writableRoots = normalizeWritableRoots(payload.sandbox_policy?.writable_roots);
        const networkAccess =
          typeof payload.sandbox_policy?.network_access === "boolean" ? payload.sandbox_policy.network_access : undefined;

        security = {};
        if (approvalPolicy) security.approvalPolicy = approvalPolicy;
        if (sandboxType) {
          security.sandboxPolicy = {
            type: sandboxType,
            ...(writableRoots.length > 0 ? { writableRoots } : {}),
            ...(typeof networkAccess === "boolean" ? { networkAccess } : {}),
          };
        }
        break;
      }
    }
  } catch {
    security = null;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
  }

  snapshotSecurityCacheByRolloutPath.set(rolloutPath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    security,
  });
  if (snapshotSecurityCacheByRolloutPath.size > 1200) {
    const staleKey = snapshotSecurityCacheByRolloutPath.keys().next().value as string | undefined;
    if (staleKey) snapshotSecurityCacheByRolloutPath.delete(staleKey);
  }
  return security;
}

function buildConversationState(args: {
  thread: NonNullable<ThreadReadResult["thread"]>;
  forceInProgress: boolean;
  hasUnreadTurn: boolean;
  pendingUserText: string | null;
  preservedTitle: string | null;
  defaultCwd: string;
  turnSecurity: SnapshotTurnSecurity | null;
}): Record<string, unknown> {
  const { thread, forceInProgress, hasUnreadTurn, pendingUserText, preservedTitle, defaultCwd, turnSecurity } = args;
  const now = Date.now();
  const createdAt = toEpochMs(thread.createdAt) || now;
  const updatedAt = Math.max(toEpochMs(thread.updatedAt) || now, now);
  const cwd = normalizeNonEmptyString(thread.cwd) ?? defaultCwd;
  const conversationSecurityParams = buildConversationSecurityParams(turnSecurity, cwd);
  const model = normalizeNonEmptyString(thread.latestModel) ?? "gpt-5.3-codex";
  const effort = normalizeNonEmptyString(thread.latestReasoningEffort ?? null) ?? "xhigh";
  const turnsRaw = Array.isArray(thread.turns) ? thread.turns : [];
  const turns = turnsRaw.map((turn, index) => {
    const items = Array.isArray(turn.items) ? turn.items : [];
    const userMessages = items.filter((item: any) => item?.type === "userMessage");
    const input = userMessages
      .flatMap((item: any) => (Array.isArray(item?.content) ? item.content : []))
      .filter((entry: any) => entry && typeof entry === "object")
      .map((entry: any) => {
        if (entry.type === "text" && typeof entry.text === "string") {
          return { type: "text", text: entry.text, text_elements: [] };
        }
        return null;
      })
      .filter((entry: any) => entry !== null);

    return {
      id: normalizeNonEmptyString(turn.id) ?? `turn-${index + 1}`,
      params: {
        threadId: thread.id ?? "",
        input,
        ...conversationSecurityParams,
        model,
        cwd,
        effort,
        summary: "auto",
        personality: null,
        outputSchema: null,
        collaborationMode: null,
      },
      turnId: normalizeNonEmptyString(turn.id) ?? `turn-${index + 1}`,
      turnStartedAtMs: null,
      finalAssistantStartedAtMs: null,
      status: normalizeNonEmptyString(turn.status) ?? "completed",
      error: turn.error ?? null,
      diff: null,
      items,
    };
  });

  if (forceInProgress) {
    const inProgressIndex = turns.findIndex((turn: any) => isTurnInProgress(turn.status));
    if (inProgressIndex >= 0) {
      turns[inProgressIndex] = { ...turns[inProgressIndex], status: "inProgress" };
    } else if (turns.length > 0) {
      const last = turns[turns.length - 1];
      turns[turns.length - 1] = { ...last, status: "inProgress" };
    } else {
      const fallbackText = pendingUserText || normalizeNonEmptyString(thread.preview) || "Streaming update";
      const syntheticTurnId = `turn-live-${randomUUID()}`;
      turns.push({
        id: syntheticTurnId,
        params: {
          threadId: thread.id ?? "",
          input: [{ type: "text", text: fallbackText, text_elements: [] }],
          ...conversationSecurityParams,
          model,
          cwd,
          effort,
          summary: "auto",
          personality: null,
          outputSchema: null,
          collaborationMode: null,
        },
        turnId: syntheticTurnId,
        turnStartedAtMs: null,
        finalAssistantStartedAtMs: null,
        status: "inProgress",
        error: null,
        diff: null,
        items: [
          {
            type: "userMessage",
            id: `item-live-user-${randomUUID()}`,
            content: [{ type: "text", text: fallbackText, text_elements: [] }],
          },
        ],
      });
    }
  }

  return {
    id: normalizeNonEmptyString(thread.id) ?? "",
    turns,
    requests: Array.isArray(thread.requests) ? thread.requests : [],
    createdAt,
    updatedAt,
    ...(preservedTitle ? { title: preservedTitle } : {}),
    source: normalizeNonEmptyString(thread.source) ?? "local",
    latestModel: model,
    latestReasoningEffort: effort,
    latestCollaborationMode:
      thread.latestCollaborationMode ?? {
        mode: "default",
        settings: {
          model,
          reasoning_effort: effort,
          developer_instructions: null,
        },
      },
    hasUnreadTurn,
    rolloutPath: normalizeNonEmptyString(thread.rolloutPath) ?? normalizeNonEmptyString(thread.path) ?? "",
    cwd,
    gitInfo: thread.gitInfo ?? null,
    resumeState: normalizeNonEmptyString(thread.resumeState) ?? "resumed",
    latestTokenUsageInfo: thread.latestTokenUsageInfo ?? null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeTitleDebugDetail(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw instanceof Error) {
      output[key] = raw.message;
      continue;
    }
    if (
      raw === null ||
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean" ||
      Array.isArray(raw)
    ) {
      output[key] = raw;
      continue;
    }
    if (typeof raw === "object") {
      try {
        output[key] = JSON.parse(JSON.stringify(raw));
      } catch {
        output[key] = "[unserializable]";
      }
      continue;
    }
    output[key] = String(raw);
  }
  return output;
}

function normalizeThreadIdForDebug(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function recordTitleDebug(
  event: string,
  options?: { threadId?: string | null; detail?: Record<string, unknown> }
): void {
  if (!TITLE_DEBUG_ENABLED) return;
  const threadId = normalizeThreadIdForDebug(options?.threadId ?? null);
  const detail = sanitizeTitleDebugDetail(options?.detail ?? {});
  const record: TitleDebugRecord = {
    at: new Date().toISOString(),
    source: "desktopLiveSync",
    event,
    threadId,
    detail,
  };
  const serialized = JSON.stringify(record);
  console.log(`[title-debug] ${serialized}`);
  void fs
    .mkdir(path.dirname(TITLE_DEBUG_LOG_PATH), { recursive: true })
    .then(() => fs.appendFile(TITLE_DEBUG_LOG_PATH, `${serialized}\n`))
    .catch(() => {
      // Ignore debug log write failures.
    });
}
