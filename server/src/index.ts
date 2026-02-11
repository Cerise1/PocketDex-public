import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { getAppServerBridge } from "./appServerBridge.js";
import { normalizeDesktopResyncStrategy, resyncCodexDesktop } from "./codexDesktopResync.js";
import { createDesktopLiveSync } from "./desktopLiveSync.js";
import { getExternalRunState, type ExternalRunState } from "./externalRunState.js";
import { getThreadExtras, initFileChangeStore, recordFileChange, recordTurnDiff } from "./fileChangeStore.js";
import { getUiState, hasPersistedUiState, initUiStateStore, updateUiState } from "./uiStateStore.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(MODULE_DIR, "..");
const WORKSPACE_DIR = path.resolve(SERVER_DIR, "..");

function readCliOption(name: string): string | null {
  const args = process.argv.slice(2);
  const flag = `--${name}`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === flag) {
      const next = args[index + 1];
      return typeof next === "string" && next.trim() ? next.trim() : null;
    }
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1).trim();
      return value || null;
    }
  }
  return null;
}

function resolvePort(): number {
  const cliPort = readCliOption("port");
  const envPort = process.env.PORT?.trim() || null;
  const candidate = cliPort ?? envPort;
  const parsed = candidate ? Number.parseInt(candidate, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 8787;
}

function sanitizeDeviceName(rawName: string | null | undefined): string {
  if (!rawName) return "";
  let cleaned = rawName.trim();
  if (cleaned.toLowerCase().endsWith(".local")) {
    cleaned = cleaned.slice(0, -6);
  }
  return cleaned.trim();
}

function resolveDeviceName(): string {
  const configured = sanitizeDeviceName(process.env.POCKETDEX_DEVICE_NAME);
  if (configured) return configured;
  const hostName = sanitizeDeviceName(os.hostname());
  return hostName || "Unknown device";
}

function resolveExpectedParentPid(): number | null {
  const raw = process.env.POCKETDEX_PARENT_PID?.trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 1 || parsed === process.pid) return null;
  return parsed;
}

function startParentWatchdog(expectedParentPid: number): void {
  const watchdog = setInterval(() => {
    if (process.ppid === expectedParentPid) return;
    console.warn(
      `[PocketDex] Parent process ${expectedParentPid} is gone (current ppid=${process.ppid}). Exiting.`
    );
    clearInterval(watchdog);
    process.exit(0);
  }, 350);

  // Do not keep Node alive just for this timer.
  watchdog.unref();
}

const expectedParentPid = resolveExpectedParentPid();
if (expectedParentPid !== null) {
  startParentWatchdog(expectedParentPid);
}

const app = express();
const port = resolvePort();
const host = readCliOption("hostname") ?? process.env.HOST?.trim() ?? undefined;
const bridge = getAppServerBridge();
const desktopLiveSync = createDesktopLiveSync(bridge);
void initFileChangeStore();
void initUiStateStore();

const TITLE_CACHE_TTL_MS = 2000;
let titleCache: { timestamp: number; titles: Map<string, string> } | null = null;
const WORKSPACE_CACHE_TTL_MS = 2000;
let workspaceCache: { timestamp: number; roots: string[] } | null = null;
const THREAD_EVENT_HISTORY_LIMIT = 600;
const THREAD_EVENT_HISTORY_TTL_MS = 20 * 60_000;
const EXTERNAL_RUN_CACHE_TTL_MS = 2_000;
const LOCAL_RUN_INTENT_TTL_MS = 30_000;
const LOCAL_RUN_STATE_IDLE_TTL_MS = 20 * 60_000;
const LOCAL_RUN_SNAPSHOT_RECONCILE_GRACE_MS = 8_000;
const PENDING_INTERRUPT_TTL_MS = 30_000;
const PENDING_INTERRUPT_RETRY_INTERVAL_MS = 450;
const PENDING_INTERRUPT_MIN_RETRY_GAP_MS = 250;
const PENDING_INTERRUPT_IN_FLIGHT_STALE_MS = 12_000;
const PENDING_INTERRUPT_DEDUPED_FORCE_AFTER_MS = 1500;
const PENDING_INTERRUPT_DEDUPED_LEGACY_RETRY_MS = 700;
const PENDING_INTERRUPT_DEDUPED_LEGACY_TIMEOUT_MS = 5000;
const PENDING_INTERRUPT_DEDUPED_LEGACY_IN_FLIGHT_STALE_MS = PENDING_INTERRUPT_DEDUPED_LEGACY_TIMEOUT_MS + 1500;
const INTERRUPT_ALIAS_ATTEMPT_TIMEOUT_MS = 10_000;
const INTERRUPT_LEGACY_FALLBACK_TIMEOUT_MS = 10_000;
const INTERRUPT_DEBUG_ENABLED = process.env.POCKETDEX_INTERRUPT_DEBUG === "1";
const INTERRUPT_DEBUG_COALESCE_ENABLED =
  INTERRUPT_DEBUG_ENABLED && process.env.POCKETDEX_INTERRUPT_DEBUG_COALESCE !== "0";
const INTERRUPT_DEBUG_COALESCE_WINDOW_MS = 900;
const INTERRUPT_DEBUG_COALESCE_MAX_KEYS = 2500;
const INTERRUPT_DEBUG_HISTORY_LIMIT = 2000;
const DEFAULT_DEBUG_LOG_DIR = path.join(WORKSPACE_DIR, ".tmp", "logs");
const INTERRUPT_DEBUG_LOG_PATH =
  process.env.POCKETDEX_INTERRUPT_DEBUG_LOG?.trim() || path.join(DEFAULT_DEBUG_LOG_DIR, "pocketdex-interrupt-debug.jsonl");
const STOP_FLOW_DEBUG_ENABLED = process.env.POCKETDEX_STOP_FLOW_DEBUG === "1";
const STOP_FLOW_DEBUG_HISTORY_LIMIT = 2000;
const STOP_FLOW_DEBUG_LOG_PATH =
  process.env.POCKETDEX_STOP_FLOW_DEBUG_LOG?.trim() || path.join(DEFAULT_DEBUG_LOG_DIR, "pocketdex-stop-flow-debug.jsonl");
const TITLE_DEBUG_ENABLED = process.env.POCKETDEX_TITLE_DEBUG !== "0";
const TITLE_DEBUG_HISTORY_LIMIT = 3000;
const TITLE_DEBUG_LOG_PATH =
  process.env.POCKETDEX_TITLE_DEBUG_LOG?.trim() || path.join(DEFAULT_DEBUG_LOG_DIR, "pocketdex-title-debug.jsonl");
const TITLE_OVERLAY_PERSIST_DELAY_MS = 250;
const TITLE_OVERLAY_FILE_PATH =
  process.env.POCKETDEX_TITLE_OVERLAY_PATH?.trim() ||
  path.join(resolveCodexHome(), "pocketdex", "thread-title-overrides.json");

type IncomingAttachment = {
  name: string;
  mimeType: string;
  kind: "image" | "file";
  dataBase64: string;
};

type TurnInputAttachment =
  | { type: "localImage"; path: string }
  | { type: "mention"; name: string; path: string };

type IncomingPreparedAttachment =
  | { type: "localImage"; path: string }
  | { type: "mention"; name: string; path: string };

const LEGACY_TMP_ATTACHMENT_ROOT = path.join(os.tmpdir(), "pocketdex-attachments");
const HIDDEN_PROJECTS_ROOT = path.join(".pocketdex", "projects");
const LEGACY_VISIBLE_PROJECTS_ROOT_NAME = "PocketDexProjects";

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
};

function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function resolvePocketDexAttachmentRoot(): string {
  return path.join(resolveCodexHome(), "pocketdex", "attachments");
}

function resolvePocketDexProjectsRoot(): string {
  const configured = process.env.POCKETDEX_PROJECTS_ROOT?.trim();
  const candidate = configured && configured.length ? configured : path.join(os.homedir(), HIDDEN_PROJECTS_ROOT);
  return path.resolve(candidate);
}

function resolveLegacyVisibleProjectsRoot(): string {
  return path.resolve(path.join(os.homedir(), LEGACY_VISIBLE_PROJECTS_ROOT_NAME));
}

function normalizeProjectName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 120) return null;
  if (trimmed === "." || trimmed === "..") return null;
  if (/[\/\\]/.test(trimmed)) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function sanitizePathSegment(value: string): string {
  const cleaned = value.trim().replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "default";
}

function resolveWebStaticDir(): string | null {
  const rawOverride = process.env.POCKETDEX_WEB_DIR?.trim();
  const candidates = [
    rawOverride || null,
    path.join(SERVER_DIR, "web"),
    path.join(WORKSPACE_DIR, "web", "out"),
    path.join(WORKSPACE_DIR, "artifacts", "web"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const indexPath = path.join(resolved, "index.html");
    if (fsSync.existsSync(indexPath)) return resolved;
  }
  return null;
}

const webStaticDir = resolveWebStaticDir();
const desktopResyncEnabled = process.env.POCKETDEX_ENABLE_DESKTOP_RESYNC === "1";

async function loadThreadTitles(options?: {
  bypassCache?: boolean;
  reason?: string;
  threadId?: string | null;
}): Promise<Map<string, string>> {
  const now = Date.now();
  const bypassCache = options?.bypassCache === true;
  const reason = typeof options?.reason === "string" && options.reason.trim() ? options.reason.trim() : "unspecified";
  const debugThreadId = normalizeThreadId(options?.threadId ?? null);
  if (!bypassCache && titleCache && now - titleCache.timestamp < TITLE_CACHE_TTL_MS) {
    recordTitleDebug("server", "title_store_cache_hit", {
      threadId: debugThreadId,
      detail: {
        reason,
        cacheAgeMs: now - titleCache.timestamp,
        titleCount: titleCache.titles.size,
      },
    });
    return titleCache.titles;
  }
  const map = new Map<string, string>();
  const dbPath = await resolveStateDbPath();
  const dbTitles = loadThreadTitlesFromDb(dbPath);
  let dbCount = 0;
  let dbSeededKnown = 0;
  for (const [id, title] of dbTitles) {
    map.set(id, title);
    dbCount += 1;
    if (!knownThreadTitleById.has(id)) {
      knownThreadTitleById.set(id, title);
      desktopLiveSync.registerKnownTitle(id, title);
      dbSeededKnown += 1;
    } else if (knownThreadTitleById.get(id) !== title) {
      // DB thread titles are authoritative and should repair stale in-memory fallbacks.
      knownThreadTitleById.set(id, title);
      desktopLiveSync.registerKnownTitle(id, title);
    }
  }
  const filePath = path.join(resolveCodexHome(), ".codex-global-state.json");
  let fileCount = 0;
  let fileOverrides = 0;
  let fileSeededKnown = 0;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as any;
    const titles = parsed?.["thread-titles"]?.titles;
    if (titles && typeof titles === "object") {
      for (const [id, title] of Object.entries(titles)) {
        if (typeof title === "string" && title.trim()) {
          const normalized = title.trim();
          const previous = map.get(id);
          if (previous && previous !== normalized) {
            fileOverrides += 1;
          }
          map.set(id, normalized);
          fileCount += 1;
          if (!knownThreadTitleById.has(id)) {
            knownThreadTitleById.set(id, normalized);
            desktopLiveSync.registerKnownTitle(id, normalized);
            fileSeededKnown += 1;
          } else if (knownThreadTitleById.get(id) !== normalized) {
            // Global-state thread titles should win over stale runtime fallbacks.
            knownThreadTitleById.set(id, normalized);
            desktopLiveSync.registerKnownTitle(id, normalized);
          }
        }
      }
    }
  } catch {
    // ignore
  }
  const overlayTitles = await loadThreadTitlesFromOverlayFile();
  let overlayCount = 0;
  let overlayOverrides = 0;
  let overlaySeededKnown = 0;
  for (const [id, title] of overlayTitles) {
    const previous = map.get(id);
    if (previous && previous !== title) overlayOverrides += 1;
    if (!previous) {
      // Overlay titles are best-effort recovery only, never authoritative overrides.
      map.set(id, title);
    }
    overlayCount += 1;
    if (!knownThreadTitleById.has(id)) {
      knownThreadTitleById.set(id, title);
      desktopLiveSync.registerKnownTitle(id, title);
      overlaySeededKnown += 1;
    }
  }
  const seededKnownCount = dbSeededKnown + fileSeededKnown + overlaySeededKnown;
  if (seededKnownCount > 0) {
    scheduleTitleOverlayPersist("title_store_seed");
  }
  if (seededKnownCount > 0) {
    recordTitleDebug("server", "title_store_seeded_known_titles", {
      threadId: debugThreadId,
      detail: {
        reason,
        dbSeededKnown,
        fileSeededKnown,
        overlaySeededKnown,
        seededKnownCount,
      },
    });
  }
  let inMemoryCount = 0;
  let inMemoryOverrides = 0;
  for (const [id, title] of knownThreadTitleById) {
    const previous = map.get(id);
    if (previous && previous !== title) {
      inMemoryOverrides += 1;
      continue;
    }
    if (!previous) {
      map.set(id, title);
      inMemoryCount += 1;
    }
  }
  titleCache = { timestamp: now, titles: map };
  recordTitleDebug("server", "title_store_loaded", {
    threadId: debugThreadId,
    detail: {
      reason,
      bypassCache,
      dbPath,
      dbCount,
      dbSeededKnown,
      fileCount,
      fileOverrides,
      fileSeededKnown,
      overlayPath: TITLE_OVERLAY_FILE_PATH,
      overlayCount,
      overlayOverrides,
      overlaySeededKnown,
      inMemoryCount,
      inMemoryOverrides,
      mergedCount: map.size,
    },
  });
  return map;
}

async function resolveStateDbPath(): Promise<string | null> {
  const codexHome = resolveCodexHome();
  const roots = [codexHome, path.join(codexHome, "sqlite")];
  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isFile() && entry.name.startsWith("state_") && entry.name.endsWith(".sqlite"))
        .map((entry) => entry.name);

      if (candidates.length === 0) {
        const legacy = path.join(root, "state.sqlite");
        try {
          await fs.stat(legacy);
          return legacy;
        } catch {
          // continue
        }
      } else {
        const sorted = candidates
          .map((name) => ({
            name,
            version: parseInt(name.replace("state_", "").replace(".sqlite", ""), 10),
          }))
          .filter((entry) => Number.isFinite(entry.version))
          .sort((a, b) => b.version - a.version);

        const latest = sorted[0]?.name ?? candidates[0];
        if (latest) return path.join(root, latest);
      }
    } catch {
      // continue
    }
  }
  return null;
}

function loadThreadTitlesFromDb(dbPath: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!dbPath) return map;
  let db: any = null;
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT id, title FROM threads").all() as Array<{ id: string; title: string }>;
    for (const row of rows) {
      if (row.title && row.title.trim()) {
        map.set(row.id, row.title.trim());
      }
    }
  } catch {
    // ignore
  } finally {
    if (db) db.close();
  }
  return map;
}

async function loadWorkspaceRoots(): Promise<string[]> {
  const now = Date.now();
  if (workspaceCache && now - workspaceCache.timestamp < WORKSPACE_CACHE_TTL_MS) {
    return workspaceCache.roots;
  }
  const roots: string[] = [];
  const filePath = path.join(resolveCodexHome(), ".codex-global-state.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as any;
    const active = Array.isArray(parsed?.["active-workspace-roots"])
      ? parsed["active-workspace-roots"]
      : [];
    const saved = Array.isArray(parsed?.["electron-saved-workspace-roots"])
      ? parsed["electron-saved-workspace-roots"]
      : [];
    for (const root of [...active, ...saved]) {
      if (typeof root !== "string") continue;
      const trimmed = root.trim();
      if (!trimmed) continue;
      roots.push(path.resolve(trimmed));
    }
  } catch {
    // ignore
  }
  const managedProjects = await listManagedProjectRoots();
  for (const projectRoot of managedProjects) {
    roots.push(projectRoot);
  }
  const unique = Array.from(new Set(roots)).sort((left, right) => left.localeCompare(right));
  workspaceCache = { timestamp: now, roots: unique };
  return unique;
}

async function listManagedProjectRoots(): Promise<string[]> {
  const primaryRoot = resolvePocketDexProjectsRoot();
  const rootsToScan = new Set<string>([primaryRoot]);
  const configured = process.env.POCKETDEX_PROJECTS_ROOT?.trim();
  if (!configured) {
    const legacyRoot = resolveLegacyVisibleProjectsRoot();
    if (legacyRoot !== primaryRoot && fsSync.existsSync(legacyRoot)) {
      rootsToScan.add(legacyRoot);
    }
  }
  const projects = new Set<string>();
  for (const root of rootsToScan) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        projects.add(path.resolve(path.join(root, entry.name)));
      }
    } catch {
      // ignore missing roots
    }
  }
  return Array.from(projects).sort((left, right) => left.localeCompare(right));
}

function isPathWithin(root: string, candidate: string): boolean {
  if (!root || !candidate) return false;
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedRoot === resolvedCandidate) return true;
  return resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

function extractThreadIdFromParams(params: any): string | null {
  if (!params || typeof params !== "object") return null;
  const direct = params.threadId ?? params.thread_id;
  if (typeof direct === "string" && direct.trim()) return direct;
  const conversationId = params.conversationId ?? params.conversation_id;
  if (typeof conversationId === "string" && conversationId.trim()) return conversationId;
  const msgThreadId = params.msg?.thread_id ?? params.msg?.threadId;
  if (typeof msgThreadId === "string" && msgThreadId.trim()) return msgThreadId;
  const fromItem = params.item?.threadId ?? params.item?.thread_id;
  if (typeof fromItem === "string" && fromItem.trim()) return fromItem;
  const fromTurn = params.turn?.threadId ?? params.turn?.thread_id;
  if (typeof fromTurn === "string" && fromTurn.trim()) return fromTurn;
  const nested = params.thread?.id;
  if (typeof nested === "string" && nested.trim()) return nested;
  return null;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return toEpochMs(numeric);
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value > 1_000_000_000_000) return value;
  if (value > 1_000_000_000) return value * 1000;
  return null;
}

type CachedExternalRunState = {
  state: ExternalRunState;
  checkedAtMs: number;
};

type ExternalRunOwner = "local" | "external" | "none";

type EffectiveExternalRunState = ExternalRunState & {
  owner: ExternalRunOwner;
  turnId: string | null;
};

type LocalRunControlState = {
  activeTurnIds: Set<string>;
  pendingIntentUntilMs: number;
  lastTurnId: string | null;
  lastActivityAtMs: number;
};

type PendingInterruptState = {
  requestedAtMs: number;
  reason: "unknown_turn" | "pre_start" | "direct";
  turnId: string | null;
  lastAttemptAtMs: number;
  clientActionId: string | null;
};

type InterruptDebugRecord = {
  at: string;
  source: string;
  event: string;
  threadId: string | null;
  turnId: string | null;
  detail: Record<string, unknown>;
};

type TitleDebugRecord = {
  at: string;
  source: string;
  event: string;
  threadId: string | null;
  title: string | null;
  detail: Record<string, unknown>;
};

type InterruptDebugCoalesceState = {
  lastEmittedAtMs: number;
  suppressed: number;
  lastSuppressedAt: string;
};

const externalRunCacheByThreadId = new Map<string, CachedExternalRunState>();
const localRunControlByThreadId = new Map<string, LocalRunControlState>();
const pendingInterruptByThreadId = new Map<string, PendingInterruptState>();
const pendingInterruptRetryTimerByThreadId = new Map<string, NodeJS.Timeout>();
const pendingInterruptInFlightByThreadId = new Set<string>();
const pendingInterruptInFlightSinceByThreadId = new Map<string, number>();
const pendingInterruptDedupedFallbackAtByThreadId = new Map<string, number>();
const pendingInterruptDedupedLegacyInFlightByThreadId = new Set<string>();
const pendingInterruptDedupedLegacyInFlightSinceByThreadId = new Map<string, number>();
const interruptDebugHistory: InterruptDebugRecord[] = [];
const interruptDebugCoalesceByKey = new Map<string, InterruptDebugCoalesceState>();
const stopFlowDebugHistory: InterruptDebugRecord[] = [];
const titleDebugHistory: TitleDebugRecord[] = [];
const knownThreadTitleById = new Map<string, string>();
let titleOverlayPersistTimer: NodeJS.Timeout | null = null;
let titleOverlayWriteQueue: Promise<void> = Promise.resolve();

function sanitizeInterruptDebugDetail(value: unknown): Record<string, unknown> {
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

function appendInterruptDebugHistory(record: InterruptDebugRecord): void {
  interruptDebugHistory.push(record);
  const overflow = interruptDebugHistory.length - INTERRUPT_DEBUG_HISTORY_LIMIT;
  if (overflow > 0) {
    interruptDebugHistory.splice(0, overflow);
  }
}

function appendStopFlowDebugHistory(record: InterruptDebugRecord): void {
  stopFlowDebugHistory.push(record);
  const overflow = stopFlowDebugHistory.length - STOP_FLOW_DEBUG_HISTORY_LIMIT;
  if (overflow > 0) {
    stopFlowDebugHistory.splice(0, overflow);
  }
}

function appendTitleDebugHistory(record: TitleDebugRecord): void {
  titleDebugHistory.push(record);
  const overflow = titleDebugHistory.length - TITLE_DEBUG_HISTORY_LIMIT;
  if (overflow > 0) {
    titleDebugHistory.splice(0, overflow);
  }
}

function normalizeThreadTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > 400 ? trimmed.slice(0, 400) : trimmed;
}

function createThreadTitleMapFromRecord(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw || typeof raw !== "object") return map;
  for (const [id, title] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedId = normalizeThreadId(id);
    const normalizedTitle = normalizeThreadTitle(title);
    if (!normalizedId || !normalizedTitle) continue;
    map.set(normalizedId, normalizedTitle);
  }
  return map;
}

async function loadThreadTitlesFromOverlayFile(): Promise<Map<string, string>> {
  try {
    const raw = await fs.readFile(TITLE_OVERLAY_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as any;
    const titlesRecord = parsed?.titles ?? parsed;
    return createThreadTitleMapFromRecord(titlesRecord);
  } catch {
    return new Map<string, string>();
  }
}

function scheduleTitleOverlayPersist(reason: string): void {
  if (titleOverlayPersistTimer) return;
  titleOverlayPersistTimer = setTimeout(() => {
    titleOverlayPersistTimer = null;
    const snapshot = Object.fromEntries(
      Array.from(knownThreadTitleById.entries()).sort((left, right) => left[0].localeCompare(right[0]))
    );
    const payload = {
      updatedAt: new Date().toISOString(),
      titles: snapshot,
    };
    titleOverlayWriteQueue = titleOverlayWriteQueue
      .catch(() => {
        // continue queue after prior failures
      })
      .then(async () => {
        await fs.mkdir(path.dirname(TITLE_OVERLAY_FILE_PATH), { recursive: true });
        await fs.writeFile(TITLE_OVERLAY_FILE_PATH, `${JSON.stringify(payload)}\n`, "utf8");
        recordTitleDebug("server", "title_overlay_persisted", {
          detail: {
            reason,
            count: Object.keys(snapshot).length,
            path: TITLE_OVERLAY_FILE_PATH,
          },
        });
      })
      .catch((error) => {
        recordTitleDebug("server", "title_overlay_persist_failed", {
          detail: {
            reason,
            error: error instanceof Error ? error.message : "unknown",
            path: TITLE_OVERLAY_FILE_PATH,
          },
        });
      });
  }, TITLE_OVERLAY_PERSIST_DELAY_MS);
  titleOverlayPersistTimer.unref();
}

function buildTitleDebugSnapshot(threadId: string | null): Record<string, unknown> {
  if (!threadId) {
    return {
      cacheSize: titleCache?.titles.size ?? 0,
      knownSize: knownThreadTitleById.size,
    };
  }
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) return {};
  const cacheTitle = titleCache?.titles.get(normalizedThreadId) ?? null;
  const knownTitle = knownThreadTitleById.get(normalizedThreadId) ?? null;
  const preservedTitle = desktopLiveSync.getKnownTitle(normalizedThreadId);
  const cacheAgeMs = titleCache ? Math.max(0, Date.now() - titleCache.timestamp) : null;
  return {
    knownTitle,
    cacheTitle,
    preservedTitle,
    cacheAgeMs,
  };
}

function recordTitleDebug(
  source: string,
  event: string,
  options?: { threadId?: string | null; title?: string | null; detail?: Record<string, unknown> }
): void {
  if (!TITLE_DEBUG_ENABLED) return;
  const threadId = normalizeThreadId(options?.threadId ?? null);
  const title = normalizeThreadTitle(options?.title ?? null);
  const detail = sanitizeInterruptDebugDetail(options?.detail ?? {});
  const record: TitleDebugRecord = {
    at: new Date().toISOString(),
    source,
    event,
    threadId,
    title,
    detail: {
      ...detail,
      titleState: buildTitleDebugSnapshot(threadId),
    },
  };
  appendTitleDebugHistory(record);
  const serialized = JSON.stringify(record);
  console.log(`[title-debug] ${serialized}`);
  void fs
    .mkdir(path.dirname(TITLE_DEBUG_LOG_PATH), { recursive: true })
    .then(() => fs.appendFile(TITLE_DEBUG_LOG_PATH, `${serialized}\n`))
    .catch(() => {
      // Ignore debug log write failures.
    });
}

function buildStopFlowServerStateSnapshot(threadId: string | null): Record<string, unknown> {
  if (!threadId) return {};
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) return {};

  const localSnapshot = getLocalRunControlSnapshot(normalizedThreadId);
  const localState = getLocalRunControl(normalizedThreadId);
  const pending = getPendingInterrupt(normalizedThreadId);
  const externalRunCached = externalRunCacheByThreadId.get(normalizedThreadId);

  return {
    localRun: {
      active: localSnapshot.active,
      turnId: localSnapshot.turnId,
      activeTurnIds: localState ? Array.from(localState.activeTurnIds).slice(0, 8) : [],
      pendingIntentUntilMs: localState?.pendingIntentUntilMs ?? 0,
      lastActivityAtMs: localSnapshot.lastActivityAtMs,
    },
    pendingInterrupt: pending
      ? {
          reason: pending.reason,
          turnId: pending.turnId,
          requestedAtMs: pending.requestedAtMs,
          lastAttemptAtMs: pending.lastAttemptAtMs,
          clientActionId: pending.clientActionId,
        }
      : null,
    interruptInFlight: pendingInterruptInFlightByThreadId.has(normalizedThreadId),
    interruptInFlightAgeMs: getPendingInterruptInFlightAgeMs(normalizedThreadId),
    externalRunCache: externalRunCached
      ? {
          active: externalRunCached.state.active,
          source: externalRunCached.state.source,
          lastEventAt: externalRunCached.state.lastEventAt,
          checkedAtMs: externalRunCached.checkedAtMs,
        }
      : null,
  };
}

function recordStopFlowDebug(
  source: string,
  event: string,
  options?: { threadId?: string | null; turnId?: string | null; detail?: Record<string, unknown> }
): void {
  if (!STOP_FLOW_DEBUG_ENABLED) return;
  const threadId = normalizeThreadId(options?.threadId ?? null);
  const turnId = normalizeTurnId(options?.turnId ?? null);
  const detail = sanitizeInterruptDebugDetail(options?.detail ?? {});
  const record: InterruptDebugRecord = {
    at: new Date().toISOString(),
    source,
    event,
    threadId,
    turnId,
    detail: {
      ...detail,
      serverState: buildStopFlowServerStateSnapshot(threadId),
    },
  };
  appendStopFlowDebugHistory(record);
  const serialized = JSON.stringify(record);
  console.log(`[stop-flow-debug] ${serialized}`);
  void fs
    .mkdir(path.dirname(STOP_FLOW_DEBUG_LOG_PATH), { recursive: true })
    .then(() => fs.appendFile(STOP_FLOW_DEBUG_LOG_PATH, `${serialized}\n`))
    .catch(() => {
      // Ignore debug log write failures.
    });
}

function shouldMirrorInterruptDebugToStopFlow(record: InterruptDebugRecord): boolean {
  if (record.source !== "server") return false;
  if (
    record.event.startsWith("interrupt_route") ||
    record.event.startsWith("pending_interrupt") ||
    record.event.startsWith("resolve_interrupt_turn") ||
    record.event.startsWith("interrupt_alias") ||
    record.event.startsWith("interrupt_legacy_fallback") ||
    record.event.startsWith("local_turn_")
  ) {
    return true;
  }
  if (record.event !== "app_server_notification") return false;
  const method = typeof record.detail.method === "string" ? record.detail.method : "";
  return method === "turn/started" || method === "turn/completed" || method === "turn/aborted" || method === "error";
}

function maybeMirrorInterruptDebugToStopFlow(record: InterruptDebugRecord): void {
  if (!shouldMirrorInterruptDebugToStopFlow(record)) return;
  recordStopFlowDebug(record.source, `interrupt_${record.event}`, {
    threadId: record.threadId,
    turnId: record.turnId,
    detail: record.detail,
  });
}

function recordInterruptDebug(
  source: string,
  event: string,
  options?: { threadId?: string | null; turnId?: string | null; detail?: Record<string, unknown> }
): void {
  if (!INTERRUPT_DEBUG_ENABLED) return;
  const threadId = normalizeThreadId(options?.threadId ?? null);
  const turnId = normalizeTurnId(options?.turnId ?? null);
  let detail = sanitizeInterruptDebugDetail(options?.detail ?? {});
  if (INTERRUPT_DEBUG_COALESCE_ENABLED) {
    const coalesceKey = buildInterruptDebugCoalesceKey(source, event, threadId, turnId, detail);
    if (coalesceKey) {
      const nowMs = Date.now();
      const existing = interruptDebugCoalesceByKey.get(coalesceKey);
      if (existing && nowMs - existing.lastEmittedAtMs <= INTERRUPT_DEBUG_COALESCE_WINDOW_MS) {
        existing.suppressed += 1;
        existing.lastSuppressedAt = new Date(nowMs).toISOString();
        interruptDebugCoalesceByKey.set(coalesceKey, existing);
        return;
      }
      if (existing?.suppressed) {
        detail = {
          ...detail,
          coalescedSuppressed: existing.suppressed,
          coalescedLastAt: existing.lastSuppressedAt,
          coalescedWindowMs: INTERRUPT_DEBUG_COALESCE_WINDOW_MS,
        };
      }
      interruptDebugCoalesceByKey.set(coalesceKey, {
        lastEmittedAtMs: nowMs,
        suppressed: 0,
        lastSuppressedAt: new Date(nowMs).toISOString(),
      });
      if (interruptDebugCoalesceByKey.size > INTERRUPT_DEBUG_COALESCE_MAX_KEYS) {
        const overflow = interruptDebugCoalesceByKey.size - INTERRUPT_DEBUG_COALESCE_MAX_KEYS;
        let removed = 0;
        for (const key of interruptDebugCoalesceByKey.keys()) {
          interruptDebugCoalesceByKey.delete(key);
          removed += 1;
          if (removed >= overflow) break;
        }
      }
    }
  }
  const record: InterruptDebugRecord = {
    at: new Date().toISOString(),
    source,
    event,
    threadId,
    turnId,
    detail,
  };
  appendInterruptDebugHistory(record);
  maybeMirrorInterruptDebugToStopFlow(record);
  const serialized = JSON.stringify(record);
  console.log(`[interrupt-debug] ${serialized}`);
  void fs
    .mkdir(path.dirname(INTERRUPT_DEBUG_LOG_PATH), { recursive: true })
    .then(() => fs.appendFile(INTERRUPT_DEBUG_LOG_PATH, `${serialized}\n`))
    .catch(() => {
      // Ignore debug log write failures.
    });
}

function buildInactiveExternalRunState(): ExternalRunState {
  return { active: false, source: "none", lastEventAt: null };
}

function normalizeThreadId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

type TurnStartApprovalPolicy = "never" | "on-request";
type TurnStartSandbox = "danger-full-access" | "workspace-write" | "read-only";

function normalizeTurnStartApprovalPolicy(value: unknown): TurnStartApprovalPolicy | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "never") return "never";
  if (normalized === "on-request") return "on-request";
  return null;
}

function normalizeTurnStartSandbox(value: unknown): TurnStartSandbox | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "danger-full-access") return "danger-full-access";
  if (normalized === "workspace-write") return "workspace-write";
  if (normalized === "read-only") return "read-only";
  return null;
}

function resolveEffectiveThreadTitle(
  threadId: unknown,
  options?: { titles?: Map<string, string> | null; fallbackTitle?: unknown }
): string | null {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) return null;
  const titleFromKnown = knownThreadTitleById.get(normalizedThreadId) ?? null;
  const titleFromProvidedMap = options?.titles?.get(normalizedThreadId) ?? null;
  const titleFromCache = titleCache?.titles.get(normalizedThreadId) ?? null;
  const titleFromLiveSync = desktopLiveSync.getKnownTitle(normalizedThreadId);
  const fallbackTitle = normalizeThreadTitle(options?.fallbackTitle ?? null);
  return (
    normalizeThreadTitle(titleFromKnown) ??
    normalizeThreadTitle(titleFromProvidedMap) ??
    normalizeThreadTitle(titleFromCache) ??
    normalizeThreadTitle(titleFromLiveSync) ??
    fallbackTitle ??
    null
  );
}

function registerKnownLiveSyncTitle(
  threadId: unknown,
  title: unknown,
  options?: { source?: string; preferExisting?: boolean }
): void {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId || typeof title !== "string") return;
  const normalizedTitle = title.trim();
  if (!normalizedTitle) return;
  const source = typeof options?.source === "string" && options.source.trim() ? options.source.trim() : "unknown";
  const hadKnownInMemory = knownThreadTitleById.has(normalizedThreadId);
  const previousKnownTitle = knownThreadTitleById.get(normalizedThreadId) ?? titleCache?.titles.get(normalizedThreadId) ?? null;
  if (options?.preferExisting === true && previousKnownTitle && previousKnownTitle !== normalizedTitle) {
    recordTitleDebug("server", "known_title_conflict_ignored", {
      threadId: normalizedThreadId,
      title: previousKnownTitle,
      detail: {
        source,
        previousKnownTitle,
        incomingTitle: normalizedTitle,
      },
    });
    return;
  }
  knownThreadTitleById.set(normalizedThreadId, normalizedTitle);
  desktopLiveSync.registerKnownTitle(normalizedThreadId, normalizedTitle);
  if (titleCache) {
    const nextTitles = new Map(titleCache.titles);
    nextTitles.set(normalizedThreadId, normalizedTitle);
    titleCache = { timestamp: Date.now(), titles: nextTitles };
  }
  if (!hadKnownInMemory || previousKnownTitle !== normalizedTitle) {
    scheduleTitleOverlayPersist(source);
  }
  recordTitleDebug(
    "server",
    previousKnownTitle
      ? previousKnownTitle === normalizedTitle
        ? "known_title_refreshed"
        : "known_title_updated"
      : "known_title_registered",
    {
      threadId: normalizedThreadId,
      title: normalizedTitle,
      detail: {
        source,
        previousKnownTitle,
      },
    }
  );
}

function normalizeTurnId(value: unknown): string | null {
  const normalized = normalizeThreadId(value);
  if (!normalized) return null;
  // App Server may transiently report turn id 0 before a real turn id exists.
  if (normalized === "0") return null;
  return normalized;
}

function normalizeClientActionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 160) return trimmed.slice(0, 160);
  return trimmed;
}

function buildInterruptDebugCoalesceKey(
  source: string,
  event: string,
  threadId: string | null,
  turnId: string | null,
  detail: Record<string, unknown>
): string | null {
  if (!INTERRUPT_DEBUG_COALESCE_ENABLED) return null;

  const method = typeof detail.method === "string" ? detail.method : "";
  const eventType = typeof detail.eventType === "string" ? detail.eventType : "";
  const interruptedTurnId = typeof detail.interruptedTurnId === "string" ? detail.interruptedTurnId : "";
  const reason = typeof detail.reason === "string" ? detail.reason : "";

  switch (event) {
    case "app_server_notification": {
      if (method !== "item/started" && method !== "item/completed") return null;
      const pendingReason = typeof detail.pendingReason === "string" ? detail.pendingReason : "none";
      return `${source}:${event}:${threadId ?? "-"}:${turnId ?? "-"}:${method}:${pendingReason}`;
    }
    case "pending_interrupt_in_flight": {
      return `${source}:${event}:${threadId ?? "-"}:${turnId ?? "-"}:${reason}`;
    }
    case "local_turn_started": {
      return `${source}:${event}:${threadId ?? "-"}:${turnId ?? "-"}`;
    }
    case "ws_codex_event_suppressed":
    case "ws_item_started_suppressed":
    case "ws_item_completed_suppressed":
    case "ws_turn_started_suppressed":
    case "ws_external_run_suppressed":
    case "ws_event_retry_interrupt":
    case "ws_codex_event_retry_interrupt": {
      return `${source}:${event}:${threadId ?? "-"}:${turnId ?? "-"}:${method}:${eventType}:${interruptedTurnId}`;
    }
    default:
      return null;
  }
}

function normalizeNumericTurnIdentity(value: string): string {
  const trimmed = value.replace(/^0+(?=\d)/, "");
  return trimmed || "0";
}

function normalizeComparableTurnId(value: unknown): string | null {
  const normalized = normalizeTurnId(value);
  if (!normalized) return null;
  if (normalized === "external-run") return normalized;
  if (/^\d+$/.test(normalized)) {
    return normalizeNumericTurnIdentity(normalized);
  }
  const prefixedNumeric = normalized.match(/^turn[-_:]?(\d+)$/i);
  if (prefixedNumeric?.[1]) {
    return normalizeNumericTurnIdentity(prefixedNumeric[1]);
  }
  return normalized;
}

function turnIdsReferToSameTurn(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeTurnId(left);
  const normalizedRight = normalizeTurnId(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  const comparableLeft = normalizeComparableTurnId(normalizedLeft);
  const comparableRight = normalizeComparableTurnId(normalizedRight);
  return Boolean(comparableLeft && comparableRight && comparableLeft === comparableRight);
}

function buildTurnIdAliasCandidates(turnId: string): string[] {
  const normalized = normalizeTurnId(turnId);
  if (!normalized || normalized === "external-run") return [];
  const candidates: string[] = [];
  const push = (value: string | null) => {
    const normalizedValue = normalizeTurnId(value);
    if (!normalizedValue || normalizedValue === "external-run") return;
    if (candidates.some((existing) => turnIdsReferToSameTurn(existing, normalizedValue) && existing === normalizedValue)) {
      return;
    }
    candidates.push(normalizedValue);
  };

  const prefixedNumeric = normalized.match(/^turn[-_:]?(\d+)$/i);
  if (prefixedNumeric?.[1]) {
    // Prefer live event id shape ("1") before legacy/prefixed variants ("turn-1").
    // Some app-server builds can hang when interrupt is attempted with the stale prefixed shape first.
    push(normalizeNumericTurnIdentity(prefixedNumeric[1]));
    push(normalized);
    return candidates;
  }
  push(normalized);
  if (/^\d+$/.test(normalized)) {
    push(`turn-${normalizeNumericTurnIdentity(normalized)}`);
  }
  return candidates;
}

async function requestTurnInterruptWithAliases(
  threadId: string,
  requestedTurnId: string,
  source: "direct" | "pending"
): Promise<{ usedTurnId: string }> {
  const candidates = buildTurnIdAliasCandidates(requestedTurnId);
  if (!candidates.length) {
    throw new Error("Missing turn id for interrupt.");
  }

  const normalizeError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(typeof error === "string" && error.trim() ? error : "unknown");

  const attemptAlias = async (candidateTurnId: string, index: number): Promise<{ usedTurnId: string }> => {
    try {
      await bridge.requestWithTimeout(
        "turn/interrupt",
        { threadId, turnId: candidateTurnId },
        INTERRUPT_ALIAS_ATTEMPT_TIMEOUT_MS
      );
      if (!turnIdsReferToSameTurn(candidateTurnId, requestedTurnId) || candidateTurnId !== requestedTurnId) {
        recordInterruptDebug("server", "interrupt_alias_succeeded", {
          threadId,
          turnId: candidateTurnId,
          detail: { source, requestedTurnId, aliasIndex: index, aliasCount: candidates.length },
        });
      }
      return { usedTurnId: candidateTurnId };
    } catch (error) {
      const normalizedError = normalizeError(error);
      recordInterruptDebug("server", "interrupt_alias_failed", {
        threadId,
        turnId: candidateTurnId,
        detail: {
          source,
          requestedTurnId,
          aliasIndex: index,
          aliasCount: candidates.length,
          error: normalizedError.message,
        },
      });
      throw normalizedError;
    }
  };

  const attemptLegacyFallback = async (): Promise<{ usedTurnId: string }> => {
    try {
      await bridge.requestWithTimeout(
        "interruptConversation",
        { conversationId: threadId },
        INTERRUPT_LEGACY_FALLBACK_TIMEOUT_MS
      );
      recordInterruptDebug("server", "interrupt_legacy_fallback_succeeded", {
        threadId,
        turnId: requestedTurnId,
        detail: {
          source,
          timeoutMs: INTERRUPT_LEGACY_FALLBACK_TIMEOUT_MS,
          aliasCount: candidates.length,
        },
      });
      return { usedTurnId: requestedTurnId };
    } catch (error) {
      const normalizedError = normalizeError(error);
      recordInterruptDebug("server", "interrupt_legacy_fallback_failed", {
        threadId,
        turnId: requestedTurnId,
        detail: {
          source,
          timeoutMs: INTERRUPT_LEGACY_FALLBACK_TIMEOUT_MS,
          error: normalizedError.message,
        },
      });
      throw normalizedError;
    }
  };

  let lastError: Error | null = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidateTurnId = candidates[index];
    try {
      return await attemptAlias(candidateTurnId, index);
    } catch (error) {
      const normalizedError = normalizeError(error);
      lastError = normalizedError;
      const timeoutLike = isLikelyInterruptTimeoutError(normalizedError.message);
      const unknownTurnLike = isLikelyUnknownTurnError(normalizedError.message);
      if (!timeoutLike && !unknownTurnLike) {
        throw normalizedError;
      }
    }
  }

  const lastMessage = lastError instanceof Error ? lastError.message : "";
  if (isLikelyInterruptTimeoutError(lastMessage) || (source === "direct" && isLikelyUnknownTurnError(lastMessage))) {
    try {
      return await attemptLegacyFallback();
    } catch (fallbackError) {
      if (source === "direct") {
        throw normalizeError(fallbackError);
      }
      // For pending retries, ignore fallback errors and keep retry loop alive.
    }
  }

  throw lastError ?? new Error("Failed to interrupt turn.");
}

function localSetHasTurnId(target: ReadonlySet<string>, turnId: string): boolean {
  for (const existingTurnId of target) {
    if (turnIdsReferToSameTurn(existingTurnId, turnId)) return true;
  }
  return false;
}

function localDeleteTurnId(target: Set<string>, turnId: string): boolean {
  let deleted = false;
  for (const existingTurnId of Array.from(target)) {
    if (!turnIdsReferToSameTurn(existingTurnId, turnId)) continue;
    target.delete(existingTurnId);
    deleted = true;
  }
  return deleted;
}

function touchTrackedThread(threadId: string): void {
  // External-run reconciliation is now on-demand from client reads.
  // Keep this helper to preserve call-sites without background watcher state.
  void normalizeThreadId(threadId);
}

function getOrCreateLocalRunControl(threadId: string): LocalRunControlState {
  const existing = localRunControlByThreadId.get(threadId);
  if (existing) return existing;
  const created: LocalRunControlState = {
    activeTurnIds: new Set<string>(),
    pendingIntentUntilMs: 0,
    lastTurnId: null,
    lastActivityAtMs: Date.now(),
  };
  localRunControlByThreadId.set(threadId, created);
  return created;
}

function clearExpiredLocalRunIntent(state: LocalRunControlState, nowMs: number): void {
  if (state.pendingIntentUntilMs > 0 && state.pendingIntentUntilMs <= nowMs) {
    state.pendingIntentUntilMs = 0;
  }
}

function maybePruneLocalRunControl(threadId: string, state: LocalRunControlState, nowMs: number): void {
  if (state.activeTurnIds.size > 0) return;
  if (state.pendingIntentUntilMs > nowMs) return;
  if (nowMs - state.lastActivityAtMs < LOCAL_RUN_STATE_IDLE_TTL_MS) return;
  localRunControlByThreadId.delete(threadId);
}

function getLocalRunControl(threadId: string): LocalRunControlState | null {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return null;
  const state = localRunControlByThreadId.get(normalized);
  if (!state) return null;
  const nowMs = Date.now();
  clearExpiredLocalRunIntent(state, nowMs);
  maybePruneLocalRunControl(normalized, state, nowMs);
  return localRunControlByThreadId.get(normalized) ?? null;
}

function getLocalRunControlSnapshot(threadId: string): {
  active: boolean;
  turnId: string | null;
  lastActivityAtMs: number;
} {
  const state = getLocalRunControl(threadId);
  if (!state) {
    return {
      active: false,
      turnId: null,
      lastActivityAtMs: 0,
    };
  }

  let turnId = state.lastTurnId && state.activeTurnIds.has(state.lastTurnId) ? state.lastTurnId : null;
  if (!turnId) {
    const next = state.activeTurnIds.values().next().value;
    turnId = typeof next === "string" && next.trim() ? next.trim() : null;
    state.lastTurnId = turnId;
  }

  return {
    active: state.activeTurnIds.size > 0 || state.pendingIntentUntilMs > Date.now(),
    turnId,
    lastActivityAtMs: state.lastActivityAtMs,
  };
}

function hasUnexpiredLocalIntent(state: LocalRunControlState, nowMs = Date.now()): boolean {
  return state.pendingIntentUntilMs > nowMs;
}

function shouldTrackLocalRunForEvent(threadId: string, turnId?: string | null): boolean {
  const state = getLocalRunControl(threadId);
  if (!state) return false;
  const nowMs = Date.now();
  if (hasUnexpiredLocalIntent(state, nowMs)) return true;
  const normalizedTurnId = normalizeTurnId(turnId ?? null);
  if (normalizedTurnId && localSetHasTurnId(state.activeTurnIds, normalizedTurnId)) return true;
  return state.activeTurnIds.size > 0;
}

function markLocalRunIntent(threadId: string): void {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return;
  const state = getOrCreateLocalRunControl(normalized);
  const nowMs = Date.now();
  state.pendingIntentUntilMs = Math.max(state.pendingIntentUntilMs, nowMs + LOCAL_RUN_INTENT_TTL_MS);
  state.lastActivityAtMs = nowMs;
}

function clearLocalRunIntent(threadId: string): void {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return;
  const state = localRunControlByThreadId.get(normalized);
  if (!state) return;
  state.pendingIntentUntilMs = 0;
  state.lastActivityAtMs = Date.now();
  maybePruneLocalRunControl(normalized, state, Date.now());
}

function markPendingInterruptInFlight(threadId: string): void {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return;
  pendingInterruptInFlightByThreadId.add(normalized);
  pendingInterruptInFlightSinceByThreadId.set(normalized, Date.now());
}

function markPendingInterruptDedupedLegacyInFlight(threadId: string): void {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return;
  pendingInterruptDedupedLegacyInFlightByThreadId.add(normalized);
  pendingInterruptDedupedLegacyInFlightSinceByThreadId.set(normalized, Date.now());
}

function clearPendingInterruptDedupedLegacyInFlight(threadId: string): void {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return;
  pendingInterruptDedupedLegacyInFlightByThreadId.delete(normalized);
  pendingInterruptDedupedLegacyInFlightSinceByThreadId.delete(normalized);
}

function clearPendingInterruptInFlight(threadId: string): void {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return;
  pendingInterruptInFlightByThreadId.delete(normalized);
  pendingInterruptInFlightSinceByThreadId.delete(normalized);
  pendingInterruptDedupedFallbackAtByThreadId.delete(normalized);
  clearPendingInterruptDedupedLegacyInFlight(normalized);
}

function getPendingInterruptInFlightAgeMs(threadId: string, nowMs = Date.now()): number | null {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return null;
  if (!pendingInterruptInFlightByThreadId.has(normalized)) return null;
  const sinceMs = pendingInterruptInFlightSinceByThreadId.get(normalized) ?? nowMs;
  return Math.max(0, nowMs - sinceMs);
}

function hasFreshPendingInterruptInFlight(threadId: string, nowMs = Date.now()): boolean {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return false;
  if (!pendingInterruptInFlightByThreadId.has(normalized)) return false;
  const ageMs = getPendingInterruptInFlightAgeMs(normalized, nowMs) ?? 0;
  if (ageMs <= PENDING_INTERRUPT_IN_FLIGHT_STALE_MS) return true;
  clearPendingInterruptInFlight(normalized);
  recordInterruptDebug("server", "pending_interrupt_in_flight_stale_cleared", {
    threadId: normalized,
    detail: { ageMs, staleAfterMs: PENDING_INTERRUPT_IN_FLIGHT_STALE_MS },
  });
  return false;
}

function hasFreshPendingInterruptDedupedLegacyInFlight(threadId: string, nowMs = Date.now()): boolean {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return false;
  if (!pendingInterruptDedupedLegacyInFlightByThreadId.has(normalized)) return false;
  const sinceMs = pendingInterruptDedupedLegacyInFlightSinceByThreadId.get(normalized) ?? nowMs;
  const ageMs = Math.max(0, nowMs - sinceMs);
  if (ageMs <= PENDING_INTERRUPT_DEDUPED_LEGACY_IN_FLIGHT_STALE_MS) return true;
  clearPendingInterruptDedupedLegacyInFlight(normalized);
  recordInterruptDebug("server", "pending_interrupt_deduped_legacy_in_flight_stale_cleared", {
    threadId: normalized,
    detail: { ageMs, staleAfterMs: PENDING_INTERRUPT_DEDUPED_LEGACY_IN_FLIGHT_STALE_MS },
  });
  return false;
}

function clearPendingInterrupt(threadId: string): void {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return;
  const timer = pendingInterruptRetryTimerByThreadId.get(normalized);
  if (timer) {
    clearTimeout(timer);
    pendingInterruptRetryTimerByThreadId.delete(normalized);
  }
  pendingInterruptByThreadId.delete(normalized);
  clearPendingInterruptInFlight(normalized);
}

function schedulePendingInterruptRetry(threadId: string): void {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return;
  if (pendingInterruptRetryTimerByThreadId.has(normalized)) return;
  const timer = setTimeout(() => {
    pendingInterruptRetryTimerByThreadId.delete(normalized);
    void attemptPendingInterrupt(normalized).finally(() => {
      if (getPendingInterrupt(normalized)) {
        schedulePendingInterruptRetry(normalized);
      }
    });
  }, PENDING_INTERRUPT_RETRY_INTERVAL_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  pendingInterruptRetryTimerByThreadId.set(normalized, timer);
}

function setPendingInterrupt(
  threadId: string,
  reason: PendingInterruptState["reason"],
  turnId?: string | null,
  clientActionId?: string | null,
): void {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return;
  const existing = pendingInterruptByThreadId.get(normalized);
  const nextTurnId = normalizeTurnId(turnId ?? existing?.turnId ?? null);
  const nextClientActionId = normalizeClientActionId(clientActionId ?? existing?.clientActionId ?? null);
  pendingInterruptByThreadId.set(normalized, {
    requestedAtMs: Date.now(),
    reason,
    turnId: nextTurnId,
    lastAttemptAtMs: existing?.lastAttemptAtMs ?? 0,
    clientActionId: nextClientActionId,
  });
  recordInterruptDebug("server", "pending_interrupt_set", {
    threadId: normalized,
    turnId: nextTurnId,
    detail: {
      reason,
      replacedTurnId: existing?.turnId ?? null,
      lastAttemptAtMs: existing?.lastAttemptAtMs ?? 0,
      replacedClientActionId: existing?.clientActionId ?? null,
      clientActionId: nextClientActionId,
    },
  });
  schedulePendingInterruptRetry(normalized);
}

function getPendingInterrupt(threadId: string): PendingInterruptState | null {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return null;
  const entry = pendingInterruptByThreadId.get(normalized);
  if (!entry) return null;
  if (Date.now() - entry.requestedAtMs > PENDING_INTERRUPT_TTL_MS) {
    const timer = pendingInterruptRetryTimerByThreadId.get(normalized);
    if (timer) {
      clearTimeout(timer);
      pendingInterruptRetryTimerByThreadId.delete(normalized);
    }
    pendingInterruptByThreadId.delete(normalized);
    return null;
  }
  return entry;
}

async function attemptPendingInterrupt(threadId: string, turnIdHint?: string | null): Promise<boolean> {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) return false;
  const entry = getPendingInterrupt(normalizedThreadId);
  if (!entry) {
    recordInterruptDebug("server", "pending_interrupt_missing", { threadId: normalizedThreadId });
    return false;
  }

  const hintedTurnId = normalizeTurnId(turnIdHint ?? null);
  if (hintedTurnId) {
    if (entry.turnId && !turnIdsReferToSameTurn(entry.turnId, hintedTurnId) && entry.reason !== "pre_start") {
      recordInterruptDebug("server", "pending_interrupt_hint_rejected", {
        threadId: normalizedThreadId,
        turnId: entry.turnId,
        detail: { hintedTurnId, reason: entry.reason },
      });
      return false;
    }
    entry.turnId = hintedTurnId;
  }

  const targetTurnId = normalizeTurnId(entry.turnId);
  if (!targetTurnId) {
    recordInterruptDebug("server", "pending_interrupt_missing_turn_id", {
      threadId: normalizedThreadId,
      detail: { reason: entry.reason, hintedTurnId: hintedTurnId ?? null },
    });
    return false;
  }

  if (hasFreshPendingInterruptInFlight(normalizedThreadId)) {
    recordInterruptDebug("server", "pending_interrupt_in_flight", {
      threadId: normalizedThreadId,
      turnId: targetTurnId,
      detail: {
        reason: entry.reason,
        ageMs: getPendingInterruptInFlightAgeMs(normalizedThreadId) ?? 0,
        clientActionId: entry.clientActionId,
      },
    });
    return false;
  }

  const nowMs = Date.now();
  if (nowMs - entry.lastAttemptAtMs < PENDING_INTERRUPT_MIN_RETRY_GAP_MS) {
    recordInterruptDebug("server", "pending_interrupt_backoff", {
      threadId: normalizedThreadId,
      turnId: targetTurnId,
      detail: { nowMs, lastAttemptAtMs: entry.lastAttemptAtMs, minGapMs: PENDING_INTERRUPT_MIN_RETRY_GAP_MS },
    });
    return false;
  }
  entry.lastAttemptAtMs = nowMs;
  recordInterruptDebug("server", "pending_interrupt_attempt", {
    threadId: normalizedThreadId,
    turnId: targetTurnId,
    detail: { reason: entry.reason, clientActionId: entry.clientActionId },
  });
  markPendingInterruptInFlight(normalizedThreadId);

  try {
    const interruptResult = await requestTurnInterruptWithAliases(normalizedThreadId, targetTurnId, "pending");
    const completedTurnId = normalizeTurnId(interruptResult.usedTurnId) ?? targetTurnId;
    entry.turnId = completedTurnId;
    recordInterruptDebug("server", "pending_interrupt_success", {
      threadId: normalizedThreadId,
      turnId: completedTurnId,
      detail: { reason: entry.reason, requestedTurnId: targetTurnId, clientActionId: entry.clientActionId },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (isLikelyUnknownTurnError(message)) {
      entry.turnId = null;
    }
    if (isLikelyInterruptTimeoutError(message)) {
      try {
        const localSnapshot = getLocalRunControlSnapshot(normalizedThreadId);
        if (!localSnapshot.active) {
          const externalRun = await readEffectiveExternalRunState(normalizedThreadId, {
            allowStaleMs: 0,
            forceRefresh: true,
          });
          const shouldClearPending = !externalRun.active || externalRun.owner !== "local";
          if (shouldClearPending) {
            clearPendingInterrupt(normalizedThreadId);
            recordInterruptDebug("server", "pending_interrupt_timeout_cleared_inactive", {
              threadId: normalizedThreadId,
              turnId: targetTurnId,
              detail: {
                reason: entry.reason,
                owner: externalRun.owner,
                source: externalRun.source,
                externalActive: externalRun.active,
                clientActionId: entry.clientActionId,
              },
            });
          }
        }
      } catch (readError) {
        recordInterruptDebug("server", "pending_interrupt_timeout_state_check_failed", {
          threadId: normalizedThreadId,
          turnId: targetTurnId,
          detail: { error: readError instanceof Error ? readError.message : "unknown" },
        });
      }
    }
    recordInterruptDebug("server", "pending_interrupt_failed", {
      threadId: normalizedThreadId,
      turnId: targetTurnId,
      detail: {
        reason: entry.reason,
        error: message || "unknown",
        unknownTurn: isLikelyUnknownTurnError(message),
        clientActionId: entry.clientActionId,
      },
    });
    return false;
  } finally {
    clearPendingInterruptInFlight(normalizedThreadId);
  }
}

function markLocalTurnStarted(threadId: string, turnId: string): void {
  const normalizedThreadId = normalizeThreadId(threadId);
  const normalizedTurnId = normalizeTurnId(turnId);
  if (!normalizedThreadId || !normalizedTurnId) return;
  const state = getOrCreateLocalRunControl(normalizedThreadId);
  localDeleteTurnId(state.activeTurnIds, normalizedTurnId);
  state.activeTurnIds.add(normalizedTurnId);
  state.lastTurnId = normalizedTurnId;
  state.pendingIntentUntilMs = 0;
  state.lastActivityAtMs = Date.now();
  recordInterruptDebug("server", "local_turn_started", {
    threadId: normalizedThreadId,
    turnId: normalizedTurnId,
    detail: { activeTurnIds: Array.from(state.activeTurnIds) },
  });
}

function markLocalTurnCompleted(threadId: string, turnId?: string | null): void {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) return;
  const state = localRunControlByThreadId.get(normalizedThreadId);
  if (!state) return;

  const normalizedTurnId = normalizeTurnId(turnId ?? null);
  if (normalizedTurnId) {
    localDeleteTurnId(state.activeTurnIds, normalizedTurnId);
  } else {
    state.activeTurnIds.clear();
  }
  state.pendingIntentUntilMs = 0;
  state.lastActivityAtMs = Date.now();

  if (state.lastTurnId && !state.activeTurnIds.has(state.lastTurnId)) {
    const next = state.activeTurnIds.values().next().value;
    state.lastTurnId = typeof next === "string" && next.trim() ? next.trim() : null;
  }

  recordInterruptDebug("server", "local_turn_completed", {
    threadId: normalizedThreadId,
    turnId: normalizedTurnId,
    detail: {
      activeTurnIds: Array.from(state.activeTurnIds),
      lastTurnId: state.lastTurnId ?? null,
    },
  });

  maybePruneLocalRunControl(normalizedThreadId, state, Date.now());
}

function mergeEffectiveExternalRunState(threadId: string, rolloutState: ExternalRunState): EffectiveExternalRunState {
  const localState = getLocalRunControlSnapshot(threadId);
  if (localState.active) {
    return {
      ...rolloutState,
      active: true,
      owner: "local",
      turnId: localState.turnId,
      lastEventAt:
        rolloutState.lastEventAt ??
        (localState.lastActivityAtMs > 0 ? new Date(localState.lastActivityAtMs).toISOString() : null),
    };
  }

  if (rolloutState.active) {
    return {
      ...rolloutState,
      owner: "external",
      turnId: null,
    };
  }

  return {
    ...rolloutState,
    owner: "none",
    turnId: null,
  };
}

function getCachedExternalRunState(threadId: string, allowStaleMs = EXTERNAL_RUN_CACHE_TTL_MS): ExternalRunState | null {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return null;
  const cached = externalRunCacheByThreadId.get(normalized);
  if (!cached) return null;
  if (Date.now() - cached.checkedAtMs > Math.max(0, allowStaleMs)) return null;
  return cached.state;
}

async function readExternalRunState(
  threadId: string,
  options?: { allowStaleMs?: number; forceRefresh?: boolean }
): Promise<ExternalRunState> {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return buildInactiveExternalRunState();
  const allowStaleMs = Math.max(0, options?.allowStaleMs ?? EXTERNAL_RUN_CACHE_TTL_MS);
  const cached = externalRunCacheByThreadId.get(normalized);
  const isCachedFresh = cached ? Date.now() - cached.checkedAtMs <= allowStaleMs : false;
  if (!options?.forceRefresh && cached && isCachedFresh) {
    return cached.state;
  }

  try {
    const state = await getExternalRunState(normalized);
    externalRunCacheByThreadId.set(normalized, { state, checkedAtMs: Date.now() });
    return state;
  } catch {
    if (cached) {
      return cached.state;
    }
    return buildInactiveExternalRunState();
  }
}

async function readEffectiveExternalRunState(
  threadId: string,
  options?: { allowStaleMs?: number; forceRefresh?: boolean }
): Promise<EffectiveExternalRunState> {
  const rolloutState = await readExternalRunState(threadId, options);
  return mergeEffectiveExternalRunState(threadId, rolloutState);
}

function normalizeTurnStatus(status: unknown): string {
  return String(status ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]/g, "");
}

function isTurnRunningStatus(status: unknown): boolean {
  const value = normalizeTurnStatus(status);
  return ["inprogress", "running", "started", "pending", "active", "executing"].includes(value);
}

function isTurnTerminalStatus(status: unknown): boolean {
  const value = normalizeTurnStatus(status);
  return ["completed", "interrupted", "failed", "aborted", "cancelled", "canceled", "stopped"].includes(value);
}

function isTurnStillActive(turn: any): boolean {
  if (!turn || typeof turn !== "object") return false;
  const normalized = normalizeTurnStatus(turn.status);
  if (!normalized) return false;
  if (isTurnRunningStatus(normalized)) return true;
  if (isTurnTerminalStatus(normalized)) return false;
  return false;
}

function resolveTurnRecencyMs(turn: any, fallbackMs: number): number {
  if (!turn || typeof turn !== "object") return fallbackMs;
  const values = [
    toEpochMs(turn.updatedAt),
    toEpochMs(turn.completedAt),
    toEpochMs(turn.completed_at),
    toEpochMs(turn.startedAt),
    toEpochMs(turn.started_at),
    toEpochMs(turn.createdAt),
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return fallbackMs;
  return Math.max(...values);
}

function resolveTurnIdAliasFromTurns(turns: any[], candidateTurnId: unknown): string | null {
  if (!Array.isArray(turns) || turns.length === 0) return null;
  const normalizedCandidate = normalizeTurnId(candidateTurnId);
  if (!normalizedCandidate || normalizedCandidate === "external-run") return null;

  const exactMatch = turns.find((turn: any) => normalizeTurnId(turn?.id) === normalizedCandidate);
  const exactTurnId = normalizeTurnId(exactMatch?.id);
  if (exactTurnId) return exactTurnId;

  const comparableCandidate = normalizeComparableTurnId(normalizedCandidate);
  if (!comparableCandidate) return null;

  const candidates = turns
    .filter((turn: any) => {
      const turnId = normalizeTurnId(turn?.id);
      if (!turnId) return false;
      return turnIdsReferToSameTurn(turnId, comparableCandidate);
    })
    .sort((left: any, right: any) => {
      const leftActive = isTurnStillActive(left) ? 1 : 0;
      const rightActive = isTurnStillActive(right) ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;
      return resolveTurnRecencyMs(right, 0) - resolveTurnRecencyMs(left, 0);
    });
  return normalizeTurnId(candidates[0]?.id);
}

function resolveBestKnownTurnId(turns: any[]): string | null {
  if (!Array.isArray(turns) || turns.length === 0) return null;
  const candidates = turns
    .filter((turn: any) => normalizeTurnId(turn?.id))
    .sort((left: any, right: any) => {
      const leftActive = isTurnStillActive(left) ? 1 : 0;
      const rightActive = isTurnStillActive(right) ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;
      return resolveTurnRecencyMs(right, 0) - resolveTurnRecencyMs(left, 0);
    });
  return normalizeTurnId(candidates[0]?.id);
}

function withMappedExternalRunTurnId(
  externalRun: EffectiveExternalRunState,
  turns: any[]
): EffectiveExternalRunState {
  if (!externalRun.turnId) return externalRun;
  const mappedTurnId = resolveTurnIdAliasFromTurns(turns, externalRun.turnId);
  if (!mappedTurnId || mappedTurnId === externalRun.turnId) return externalRun;
  return { ...externalRun, turnId: mappedTurnId };
}

function hasTurnCompletionTimestamp(turn: any): boolean {
  if (!turn || typeof turn !== "object") return false;
  return Boolean(toEpochMs(turn.completedAt) ?? toEpochMs(turn.completed_at));
}

function reconcileLocalRunFromThreadSnapshot(
  threadId: string,
  turns: any[],
  rolloutState: ExternalRunState
): boolean {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) return false;
  if (!Array.isArray(turns) || turns.length === 0) return false;

  const localSnapshot = getLocalRunControlSnapshot(normalizedThreadId);
  if (!localSnapshot.active) return false;
  if (turns.some((turn) => isTurnStillActive(turn))) return false;

  const latestTurn = turns[turns.length - 1];
  const latestTurnTerminalByStatus = latestTurn ? isTurnTerminalStatus(latestTurn.status) : false;
  const latestTurnHasCompletedAt = hasTurnCompletionTimestamp(latestTurn);
  const localIdleMs =
    localSnapshot.lastActivityAtMs > 0
      ? Math.max(0, Date.now() - localSnapshot.lastActivityAtMs)
      : Number.MAX_SAFE_INTEGER;
  const shouldReconcileFromRollout =
    !rolloutState.active && localIdleMs >= LOCAL_RUN_SNAPSHOT_RECONCILE_GRACE_MS;

  if (!latestTurnTerminalByStatus && !latestTurnHasCompletedAt && !shouldReconcileFromRollout) {
    return false;
  }

  markLocalTurnCompleted(normalizedThreadId, localSnapshot.turnId);
  recordInterruptDebug("server", "local_turn_reconciled_from_snapshot", {
    threadId: normalizedThreadId,
    turnId: localSnapshot.turnId ?? null,
    detail: {
      latestTurnTerminalByStatus,
      latestTurnHasCompletedAt,
      rolloutActive: rolloutState.active,
      localIdleMs,
      turnCount: turns.length,
    },
  });
  return true;
}

async function resolveExternalRunForThreadSnapshot(
  threadId: string,
  turns: any[]
): Promise<EffectiveExternalRunState> {
  const rolloutState = await readExternalRunState(threadId, { allowStaleMs: EXTERNAL_RUN_CACHE_TTL_MS });
  const reconciled = reconcileLocalRunFromThreadSnapshot(threadId, turns, rolloutState);
  if (reconciled) {
    const refreshedRolloutState = await readExternalRunState(threadId, {
      allowStaleMs: 0,
      forceRefresh: true,
    });
    return withMappedExternalRunTurnId(mergeEffectiveExternalRunState(threadId, refreshedRolloutState), turns);
  }
  return withMappedExternalRunTurnId(mergeEffectiveExternalRunState(threadId, rolloutState), turns);
}

type InterruptTurnResolution =
  | { type: "resolved"; turnId: string }
  | { type: "external_surface_run" }
  | { type: "missing_turn_id" };

type SendTurnResolution = { type: "ok" } | { type: "external_surface_run" };

async function resolveInterruptTurn(threadId: string, requestedTurnId: string): Promise<InterruptTurnResolution> {
  const trimmedTurnId = normalizeTurnId(requestedTurnId) ?? "";
  recordInterruptDebug("server", "resolve_interrupt_turn_begin", {
    threadId,
    turnId: trimmedTurnId || null,
    detail: { requestedTurnId: requestedTurnId || null },
  });
  let knownTurns: any[] = [];
  let turnsLoaded = false;

  try {
    const readResult = await bridge.request("thread/read", { threadId, includeTurns: true });
    knownTurns = Array.isArray(readResult?.thread?.turns) ? readResult.thread.turns : [];
    turnsLoaded = true;

    if (trimmedTurnId && trimmedTurnId !== "external-run") {
      const mappedRequestedTurnId = resolveTurnIdAliasFromTurns(knownTurns, trimmedTurnId);
      const mappedRequestedTurn =
        mappedRequestedTurnId
          ? knownTurns.find((turn: any) => turnIdsReferToSameTurn(turn?.id, mappedRequestedTurnId))
          : null;
      const mappedRequestedTurnActive = isTurnStillActive(mappedRequestedTurn);
      recordInterruptDebug("server", "resolve_interrupt_turn_requested", {
        threadId,
        turnId: trimmedTurnId,
        detail: {
          turnsLoaded: true,
          knownTurns: knownTurns.length,
          mappedRequestedTurnId: mappedRequestedTurnId ?? null,
          mappedRequestedTurnActive,
        },
      });
      if (mappedRequestedTurnId && mappedRequestedTurnActive) {
        return { type: "resolved", turnId: mappedRequestedTurnId };
      }

      const activeTurns = knownTurns
        .filter((turn: any) => normalizeTurnId(turn?.id) && isTurnStillActive(turn))
        .sort((a: any, b: any) => resolveTurnRecencyMs(b, 0) - resolveTurnRecencyMs(a, 0));
      const activeFallbackTurnId = normalizeTurnId(activeTurns[0]?.id);
      if (activeFallbackTurnId) {
        recordInterruptDebug("server", "resolve_interrupt_turn_requested_active_fallback", {
          threadId,
          turnId: activeFallbackTurnId,
          detail: { requestedTurnId: trimmedTurnId, mappedRequestedTurnId: mappedRequestedTurnId ?? null },
        });
        return { type: "resolved", turnId: activeFallbackTurnId };
      }

      if (mappedRequestedTurnId) {
        // If thread/read says requested turn is inactive, prefer the local active turn from
        // live websocket notifications before falling back to the requested id shape.
        const localControl = getLocalRunControlSnapshot(threadId);
        if (localControl.active && localControl.turnId) {
          recordInterruptDebug("server", "resolve_interrupt_turn_requested_local_active_fallback", {
            threadId,
            turnId: localControl.turnId,
            detail: {
              requestedTurnId: trimmedTurnId,
              mappedRequestedTurnId,
              mappedRequestedTurnActive,
            },
          });
          return { type: "resolved", turnId: localControl.turnId };
        }
        // Preserve caller-provided id shape when no better local active hint exists.
        return { type: "resolved", turnId: trimmedTurnId };
      }
    }

    const activeTurns = knownTurns
      .filter((turn: any) => normalizeTurnId(turn?.id) && isTurnStillActive(turn))
      .sort((a: any, b: any) => resolveTurnRecencyMs(b, 0) - resolveTurnRecencyMs(a, 0));
    const best = activeTurns[0];
    const bestTurnId = normalizeTurnId(best?.id);
    if (bestTurnId) {
      recordInterruptDebug("server", "resolve_interrupt_turn_active", {
        threadId,
        turnId: bestTurnId,
        detail: { activeTurns: activeTurns.length, knownTurns: knownTurns.length },
      });
      return { type: "resolved", turnId: bestTurnId };
    }
  } catch (error) {
    recordInterruptDebug("server", "resolve_interrupt_turn_read_failed", {
      threadId,
      detail: { error: error instanceof Error ? error.message : "unknown" },
    });
    // Fall through to external run check below.
  }

  if (trimmedTurnId && trimmedTurnId !== "external-run") {
    const localControl = getLocalRunControlSnapshot(threadId);
    if (localControl.active && localControl.turnId) {
      recordInterruptDebug("server", "resolve_interrupt_turn_requested_local_fallback", {
        threadId,
        turnId: localControl.turnId,
        detail: {
          requestedTurnId: trimmedTurnId,
          turnsLoaded,
        },
      });
      return { type: "resolved", turnId: localControl.turnId };
    }
    recordInterruptDebug("server", "resolve_interrupt_turn_requested_fallback", {
      threadId,
      turnId: trimmedTurnId,
      detail: { turnsLoaded },
    });
    return { type: "resolved", turnId: trimmedTurnId };
  }

  const localControl = getLocalRunControlSnapshot(threadId);
  if (turnsLoaded && localControl.active) {
    const fallbackTurnId = resolveBestKnownTurnId(knownTurns);
    if (fallbackTurnId) {
      recordInterruptDebug("server", "resolve_interrupt_turn_local_active_fallback", {
        threadId,
        turnId: fallbackTurnId,
        detail: {
          knownTurns: knownTurns.length,
          localActive: localControl.active,
          localTurnId: localControl.turnId ?? null,
        },
      });
      return { type: "resolved", turnId: fallbackTurnId };
    }
  }
  if (localControl.turnId) {
    if (turnsLoaded) {
      const mappedLocalTurnId = resolveTurnIdAliasFromTurns(knownTurns, localControl.turnId);
      if (mappedLocalTurnId) {
        recordInterruptDebug("server", "resolve_interrupt_turn_local_mapped", {
          threadId,
          turnId: mappedLocalTurnId,
          detail: { localTurnId: localControl.turnId, knownTurns: knownTurns.length },
        });
        return { type: "resolved", turnId: mappedLocalTurnId };
      }
    }
    recordInterruptDebug("server", "resolve_interrupt_turn_local", {
      threadId,
      turnId: localControl.turnId,
      detail: { turnsLoaded, knownTurns: knownTurns.length },
    });
    return { type: "resolved", turnId: localControl.turnId };
  }

  try {
    const externalRun = await readEffectiveExternalRunState(threadId, { allowStaleMs: EXTERNAL_RUN_CACHE_TTL_MS });
    if (externalRun.turnId) {
      if (turnsLoaded) {
        const mappedExternalTurnId = resolveTurnIdAliasFromTurns(knownTurns, externalRun.turnId);
        if (mappedExternalTurnId) {
          recordInterruptDebug("server", "resolve_interrupt_turn_external_mapped", {
            threadId,
            turnId: mappedExternalTurnId,
            detail: { externalTurnId: externalRun.turnId, owner: externalRun.owner },
          });
          return { type: "resolved", turnId: mappedExternalTurnId };
        }
      }
      recordInterruptDebug("server", "resolve_interrupt_turn_external", {
        threadId,
        turnId: externalRun.turnId,
        detail: { owner: externalRun.owner, source: externalRun.source },
      });
      return { type: "resolved", turnId: externalRun.turnId };
    }
    if (externalRun.active && externalRun.owner === "external") {
      recordInterruptDebug("server", "resolve_interrupt_turn_external_surface", {
        threadId,
        detail: { owner: externalRun.owner, source: externalRun.source },
      });
      return { type: "external_surface_run" };
    }
  } catch (error) {
    recordInterruptDebug("server", "resolve_interrupt_turn_external_read_failed", {
      threadId,
      detail: { error: error instanceof Error ? error.message : "unknown" },
    });
    // ignore
  }

  recordInterruptDebug("server", "resolve_interrupt_turn_missing", {
    threadId,
    detail: { turnsLoaded, knownTurns: knownTurns.length },
  });
  return { type: "missing_turn_id" };
}

async function resolveSendTurn(threadId: string): Promise<SendTurnResolution> {
  const localControl = getLocalRunControlSnapshot(threadId);
  if (localControl.active) {
    return { type: "ok" };
  }

  let hasKnownTurns = false;
  try {
    const readResult = await bridge.request("thread/read", { threadId, includeTurns: true });
    const turns = Array.isArray(readResult?.thread?.turns) ? readResult.thread.turns : [];
    hasKnownTurns = turns.length > 0;
    const hasLocalActiveTurn = turns.some((turn: any) => normalizeTurnId(turn?.id) && isTurnStillActive(turn));
    if (hasLocalActiveTurn) return { type: "ok" };
  } catch {
    // Fall through to external run check below.
  }

  if (!hasKnownTurns) {
    return { type: "ok" };
  }

  try {
    const externalRun = await readEffectiveExternalRunState(threadId, { allowStaleMs: EXTERNAL_RUN_CACHE_TTL_MS });
    if (externalRun.active && externalRun.owner === "external") return { type: "external_surface_run" };
  } catch {
    // ignore
  }

  return { type: "ok" };
}

function isLikelyUnknownTurnError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("turn") &&
    (normalized.includes("not found") ||
      normalized.includes("unknown") ||
      normalized.includes("invalid") ||
      normalized.includes("missing"))
  );
}

function isLikelyInterruptTimeoutError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("deadline exceeded")
  );
}

function isLikelyThreadNotFoundError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("thread") && normalized.includes("not found");
}

async function ensureThreadLoadedForWake(threadId: string): Promise<void> {
  try {
    await bridge.request("thread/read", { threadId, includeTurns: false });
    recordStopFlowDebug("server", "ws_subscribe_wake_thread_already_loaded", { threadId });
    return;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "thread/read failed";
    if (!isLikelyThreadNotFoundError(errorMessage)) {
      recordStopFlowDebug("server", "ws_subscribe_wake_thread_check_failed", {
        threadId,
        detail: { error: errorMessage },
      });
      throw error instanceof Error ? error : new Error(errorMessage);
    }
    recordStopFlowDebug("server", "ws_subscribe_wake_thread_resume", {
      threadId,
      detail: { reason: "thread_not_found", error: errorMessage },
    });
    await bridge.request("thread/resume", { threadId });
    recordStopFlowDebug("server", "ws_subscribe_wake_thread_resume_ok", { threadId });
  }
}

function sanitizeAttachmentName(value: string): string {
  const fileName = path.basename(value || "");
  const cleaned = fileName.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim();
  return cleaned || "attachment";
}

function imageMimeTypeFromPath(filePath: string): string | null {
  const extension = path.extname(filePath || "").toLowerCase();
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}

function isImageAttachment(attachment: IncomingAttachment): boolean {
  if (attachment.kind === "image") return true;
  if (attachment.mimeType.toLowerCase().startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|tif|tiff|heic|heif)$/i.test(attachment.name);
}

function isAllowedAttachmentPath(candidatePath: string): boolean {
  const allowedRoots = [resolvePocketDexAttachmentRoot(), LEGACY_TMP_ATTACHMENT_ROOT];
  return allowedRoots.some((root) => isPathWithin(root, candidatePath));
}

function parseIncomingAttachments(value: unknown): IncomingAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: IncomingAttachment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const dataBase64 = typeof source.dataBase64 === "string" ? source.dataBase64.trim() : "";
    if (!dataBase64) continue;
    const kind: "image" | "file" = source.kind === "image" ? "image" : "file";
    const mimeType =
      typeof source.mimeType === "string" && source.mimeType.trim()
        ? source.mimeType.trim()
        : "application/octet-stream";
    const rawName = typeof source.name === "string" && source.name.trim() ? source.name.trim() : "";
    const fallbackName = kind === "image" ? "image.png" : "attachment.bin";
    attachments.push({
      name: sanitizeAttachmentName(rawName || fallbackName),
      mimeType,
      kind,
      dataBase64,
    });
  }
  return attachments;
}

function parsePreparedAttachments(value: unknown): IncomingPreparedAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: IncomingPreparedAttachment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const type =
      source.type === "localImage" ? "localImage" : source.type === "mention" ? "mention" : null;
    if (!type) continue;
    const rawPath = typeof source.path === "string" ? source.path.trim() : "";
    if (!rawPath) continue;
    const resolvedPath = path.resolve(rawPath);
    if (!isAllowedAttachmentPath(resolvedPath)) continue;
    if (type === "localImage") {
      attachments.push({ type: "localImage", path: resolvedPath });
    } else {
      const rawName =
        typeof source.name === "string" && source.name.trim()
          ? source.name.trim()
          : path.basename(resolvedPath);
      attachments.push({ type: "mention", name: sanitizeAttachmentName(rawName), path: resolvedPath });
    }
  }
  return attachments;
}

async function persistAttachmentPayload(
  threadId: string,
  attachmentName: string,
  payload: Buffer,
): Promise<string> {
  const uploadRoot = path.join(resolvePocketDexAttachmentRoot(), sanitizePathSegment(threadId));
  await fs.mkdir(uploadRoot, { recursive: true });
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const filePath = path.join(uploadRoot, `${unique}-${attachmentName}`);
  await fs.writeFile(filePath, payload);
  return filePath;
}

async function materializeAttachments(
  threadId: string,
  attachments: IncomingAttachment[],
): Promise<TurnInputAttachment[]> {
  if (!attachments.length) return [];
  const output: TurnInputAttachment[] = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const payload = Buffer.from(attachment.dataBase64, "base64");
    if (!payload.length) continue;
    const filePath = await persistAttachmentPayload(
      threadId,
      `${index + 1}-${sanitizeAttachmentName(attachment.name)}`,
      payload,
    );
    if (isImageAttachment(attachment)) {
      output.push({ type: "localImage", path: filePath });
    } else {
      output.push({ type: "mention", name: attachment.name, path: filePath });
    }
  }
  return output;
}

app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.post(
  "/api/attachments/upload",
  express.raw({ type: () => true, limit: "50mb" }),
  async (req, res) => {
    const threadId =
      typeof req.query.threadId === "string" && req.query.threadId.trim()
        ? req.query.threadId.trim()
        : "";
    if (!threadId) {
      res.status(400).json({ error: "threadId query param is required" });
      return;
    }

    const rawName =
      typeof req.query.name === "string" && req.query.name.trim()
        ? req.query.name.trim()
        : "attachment.bin";
    const name = sanitizeAttachmentName(rawName);
    const kind: "image" | "file" = req.query.kind === "image" ? "image" : "file";
    const mimeType =
      typeof req.headers["content-type"] === "string" && req.headers["content-type"].trim()
        ? req.headers["content-type"].trim()
        : "application/octet-stream";
    const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!payload.length) {
      res.status(400).json({ error: "Attachment body is empty" });
      return;
    }

    try {
      const filePath = await persistAttachmentPayload(threadId, name, payload);
      const isImage =
        kind === "image" ||
        mimeType.toLowerCase().startsWith("image/") ||
        /\.(png|jpe?g|gif|webp|bmp|svg|tif|tiff|heic|heif|avif)$/i.test(name);
      const attachment: TurnInputAttachment = isImage
        ? { type: "localImage", path: filePath }
        : { type: "mention", name, path: filePath };
      res.status(201).json({ ok: true, attachment });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to upload attachment",
      });
    }
  },
);

app.get("/api/local-images", async (req, res) => {
  const requestedPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
  if (!requestedPath) {
    res.status(400).json({ error: "path query param is required" });
    return;
  }

  const resolvedPath = path.resolve(requestedPath);
  const allowedRoots = [resolvePocketDexAttachmentRoot(), LEGACY_TMP_ATTACHMENT_ROOT];
  if (!allowedRoots.some((root) => isPathWithin(root, resolvedPath))) {
    res.status(403).json({ error: "Path is outside allowed attachment directories" });
    return;
  }

  const mimeType = imageMimeTypeFromPath(resolvedPath);
  if (!mimeType) {
    res.status(415).json({ error: "Unsupported image type" });
    return;
  }

  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      res.status(404).json({ error: "Image not found" });
      return;
    }
  } catch {
    res.status(404).json({ error: "Image not found" });
    return;
  }

  res.setHeader("Cache-Control", "private, max-age=604800, immutable");
  res.setHeader("Content-Type", mimeType);
  res.sendFile(resolvedPath);
});

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    deviceName: resolveDeviceName(),
  });
});

app.post("/api/debug/interrupt", async (req, res) => {
  const event = typeof req.body?.event === "string" && req.body.event.trim() ? req.body.event.trim() : "client_event";
  const source = typeof req.body?.source === "string" && req.body.source.trim() ? req.body.source.trim() : "web";
  const threadId = normalizeThreadId(req.body?.threadId ?? null);
  const turnId = normalizeTurnId(req.body?.turnId ?? null);
  const detail = req.body?.detail && typeof req.body.detail === "object" ? req.body.detail : {};
  recordInterruptDebug(source, event, { threadId, turnId, detail: detail as Record<string, unknown> });
  res.status(202).json({ ok: true });
});

app.get("/api/debug/interrupt", async (req, res) => {
  const threadId = normalizeThreadId(typeof req.query.threadId === "string" ? req.query.threadId : null);
  const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : Number.NaN;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200;
  const filtered = threadId ? interruptDebugHistory.filter((entry) => entry.threadId === threadId) : interruptDebugHistory;
  const data = filtered.slice(-limit);
  res.json({
    ok: true,
    enabled: INTERRUPT_DEBUG_ENABLED,
    logPath: INTERRUPT_DEBUG_LOG_PATH,
    stopFlowEnabled: STOP_FLOW_DEBUG_ENABLED,
    stopFlowLogPath: STOP_FLOW_DEBUG_LOG_PATH,
    total: filtered.length,
    data,
  });
});

app.post("/api/debug/stop-flow", async (req, res) => {
  const event = typeof req.body?.event === "string" && req.body.event.trim() ? req.body.event.trim() : "client_event";
  const source = typeof req.body?.source === "string" && req.body.source.trim() ? req.body.source.trim() : "mobile";
  const threadId = normalizeThreadId(req.body?.threadId ?? null);
  const turnId = normalizeTurnId(req.body?.turnId ?? null);
  const detail = req.body?.detail && typeof req.body.detail === "object" ? req.body.detail : {};
  recordStopFlowDebug(source, event, { threadId, turnId, detail: detail as Record<string, unknown> });
  res.status(202).json({ ok: true });
});

app.get("/api/debug/stop-flow", async (req, res) => {
  const threadId = normalizeThreadId(typeof req.query.threadId === "string" ? req.query.threadId : null);
  const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : Number.NaN;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 300;
  const filtered = threadId ? stopFlowDebugHistory.filter((entry) => entry.threadId === threadId) : stopFlowDebugHistory;
  const data = filtered.slice(-limit);
  res.json({
    ok: true,
    enabled: STOP_FLOW_DEBUG_ENABLED,
    logPath: STOP_FLOW_DEBUG_LOG_PATH,
    total: filtered.length,
    data,
  });
});

app.post("/api/debug/title", async (req, res) => {
  const event = typeof req.body?.event === "string" && req.body.event.trim() ? req.body.event.trim() : "client_event";
  const source = typeof req.body?.source === "string" && req.body.source.trim() ? req.body.source.trim() : "web";
  const threadId = normalizeThreadId(req.body?.threadId ?? null);
  const title = normalizeThreadTitle(req.body?.title ?? null);
  const detail = req.body?.detail && typeof req.body.detail === "object" ? req.body.detail : {};
  recordTitleDebug(source, event, { threadId, title, detail: detail as Record<string, unknown> });
  res.status(202).json({ ok: true });
});

app.get("/api/debug/title", async (req, res) => {
  const threadId = normalizeThreadId(typeof req.query.threadId === "string" ? req.query.threadId : null);
  const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : Number.NaN;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 300;
  const filtered = threadId ? titleDebugHistory.filter((entry) => entry.threadId === threadId) : titleDebugHistory;
  const data = filtered.slice(-limit);
  res.json({
    ok: true,
    enabled: TITLE_DEBUG_ENABLED,
    logPath: TITLE_DEBUG_LOG_PATH,
    overlayPath: TITLE_OVERLAY_FILE_PATH,
    total: filtered.length,
    data,
  });
});

app.get("/api/models", async (_req, res) => {
  try {
    const result = await bridge.request("model/list", {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch models" });
  }
});

app.get("/api/config", async (req, res) => {
  const cwd = typeof req.query.cwd === "string" && req.query.cwd.trim() ? req.query.cwd.trim() : null;
  try {
    const result = await bridge.request("config/read", { includeLayers: false, cwd });
    res.json({ config: result?.config ?? null });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch config" });
  }
});

app.post("/api/projects", async (req, res) => {
  const name = normalizeProjectName(req.body?.name);
  if (!name) {
    res.status(400).json({ error: "Project name is required and cannot contain path separators." });
    return;
  }

  const projectsRoot = resolvePocketDexProjectsRoot();
  const projectPath = path.resolve(path.join(projectsRoot, name));
  if (!isPathWithin(projectsRoot, projectPath)) {
    res.status(400).json({ error: "Project path is outside the allowed projects root." });
    return;
  }

  try {
    await fs.mkdir(projectsRoot, { recursive: true });
    const existing = await fs.stat(projectPath).catch(() => null);
    if (existing) {
      if (existing.isDirectory()) {
        res.status(409).json({ error: `Project "${name}" already exists.` });
        return;
      }
      res.status(409).json({ error: `A file named "${name}" already exists in the projects folder.` });
      return;
    }

    await fs.mkdir(projectPath, { recursive: false });
    workspaceCache = null;
    res.status(201).json({
      ok: true,
      project: {
        name,
        path: projectPath,
        root: projectsRoot,
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      res.status(409).json({ error: `Project "${name}" already exists.` });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to create project" });
  }
});

app.get("/api/workspaces", async (_req, res) => {
  try {
    const roots = await loadWorkspaceRoots();
    res.json({ roots, projectsRoot: resolvePocketDexProjectsRoot() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load workspaces" });
  }
});

app.get("/api/ui-state", async (_req, res) => {
  try {
    await initUiStateStore();
    res.json({ data: getUiState(), persisted: hasPersistedUiState() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load ui state" });
  }
});

app.patch("/api/ui-state", async (req, res) => {
  const payload = req.body?.data ?? req.body;
  if (!payload || typeof payload !== "object") {
    res.status(400).json({ error: "Expected an object payload" });
    return;
  }
  try {
    await initUiStateStore();
    const data = updateUiState(payload);
    res.json({ data, persisted: hasPersistedUiState() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to update ui state" });
  }
});

app.get("/api/threads", async (_req, res) => {
  const cursor = typeof _req.query.cursor === "string" ? _req.query.cursor : null;
  const limit = typeof _req.query.limit === "string" ? Number(_req.query.limit) : null;
  const archived = typeof _req.query.archived === "string" ? _req.query.archived === "true" : null;
  const sortKey = typeof _req.query.sortKey === "string" ? _req.query.sortKey : "updated_at";
  try {
    const result = await bridge.request("thread/list", {
      cursor,
      limit: Number.isFinite(limit) ? limit : undefined,
      archived,
      sortKey,
    });
    const titles = await loadThreadTitles({ reason: "api_threads_list" });
    recordTitleDebug("server", "api_threads_list_titles_loaded", {
      detail: {
        cursor,
        limit: Number.isFinite(limit) ? limit : null,
        archived,
        sortKey,
        titleCount: titles.size,
      },
    });
    const roots = await loadWorkspaceRoots();
    const data = Array.isArray(result.data)
      ? result.data.map((thread: any) => {
          const title = resolveEffectiveThreadTitle(thread.id, {
            titles,
            fallbackTitle: thread?.title ?? null,
          });
          if (title) registerKnownLiveSyncTitle(thread.id, title, { source: "api_threads_list" });
          return {
            ...thread,
            title,
          };
        })
      : result.data;
    const filtered =
      Array.isArray(data) && roots.length
        ? data.filter((thread: any) => {
            const cwd = typeof thread.cwd === "string" ? thread.cwd : "";
            return roots.some((root) => isPathWithin(root, cwd));
          })
        : data;
    const enriched =
      Array.isArray(filtered)
        ? await Promise.all(
            filtered.map(async (thread: any) => {
              if (!thread?.id) return thread;
              const normalizedThreadId = normalizeThreadId(thread.id);
              if (normalizedThreadId) touchTrackedThread(normalizedThreadId);
              try {
                const externalRun = await readEffectiveExternalRunState(String(thread.id), {
                  allowStaleMs: EXTERNAL_RUN_CACHE_TTL_MS,
                });
                return { ...thread, externalRun };
              } catch {
                return thread;
              }
            })
          )
        : filtered;
    res.json({ ...result, data: enriched });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load threads" });
  }
});

app.post("/api/threads", async (req, res) => {
  const cwd = typeof req.body?.cwd === "string" ? req.body.cwd : null;
  const model = typeof req.body?.model === "string" ? req.body.model : null;
  const modelProvider = typeof req.body?.modelProvider === "string" ? req.body.modelProvider : null;
  const approvalPolicy = typeof req.body?.approvalPolicy === "string" ? req.body.approvalPolicy : null;
  const sandbox = typeof req.body?.sandbox === "string" ? req.body.sandbox : null;
  try {
    const result = await bridge.request("thread/start", {
      cwd: cwd ?? undefined,
      model: model ?? undefined,
      modelProvider: modelProvider ?? undefined,
      approvalPolicy: approvalPolicy ?? undefined,
      sandbox: sandbox ?? undefined,
    });
    const titles = await loadThreadTitles({ reason: "api_threads_start" });
    const threadId = result.thread?.id;
    const title = resolveEffectiveThreadTitle(threadId ?? null, {
      titles,
      fallbackTitle: result.thread?.title ?? null,
    });
    if (threadId && title) registerKnownLiveSyncTitle(threadId, title, { source: "api_threads_start" });
    recordTitleDebug("server", "api_threads_start_response", {
      threadId: normalizeThreadId(threadId ?? null),
      title,
      detail: {
        cwd,
        model,
      },
    });
    const thread = result.thread ? { ...result.thread, title } : result.thread;
    if (thread?.id) {
      const normalizedThreadId = normalizeThreadId(thread.id);
      if (normalizedThreadId) touchTrackedThread(normalizedThreadId);
    }
    res.json({ ...result, thread });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to start thread" });
  }
});

app.get("/api/threads/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await bridge.request("thread/read", { threadId: id, includeTurns: true });
    const normalizedThreadId = normalizeThreadId(id);
    if (normalizedThreadId) touchTrackedThread(normalizedThreadId);
    const threadTurns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
    const externalRunThreadId = normalizeThreadId(result?.thread?.id ?? id) ?? id;
    const externalRun = await resolveExternalRunForThreadSnapshot(externalRunThreadId, threadTurns);
    const titles = await loadThreadTitles({ reason: "api_thread_read", threadId: id });
    const threadId = result.thread?.id;
    const title = resolveEffectiveThreadTitle(threadId ?? id, {
      titles,
      fallbackTitle: result.thread?.title ?? null,
    });
    if (threadId && title) registerKnownLiveSyncTitle(threadId, title, { source: "api_thread_read" });
    recordTitleDebug("server", "api_thread_read_response", {
      threadId: normalizeThreadId(threadId ?? id),
      title,
      detail: {
        requestedThreadId: id,
        turnCount: threadTurns.length,
      },
    });
    let thread = result.thread
      ? { ...result.thread, title, externalRun }
      : result.thread;
    if (thread?.turns?.length) {
      const extras = getThreadExtras(thread.id);
      thread = {
        ...thread,
        turns: thread.turns.map((turn: any) => {
          const stored = extras[turn.id];
          if (!stored) return turn;
          const existingIds = new Set((turn.items ?? []).map((item: any) => item?.id).filter(Boolean));
          const extraItems = [
            ...Object.values(stored.fileChanges ?? {}),
            ...(stored.turnDiff ? [stored.turnDiff] : []),
          ].filter((item: any) => item && !existingIds.has(item.id));
          if (!extraItems.length) return turn;
          return { ...turn, items: [...(turn.items ?? []), ...extraItems] };
        }),
      };
    }
    res.json({ ...result, thread });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Thread not found" });
  }
});

app.post("/api/threads/:id/archive", async (req, res) => {
  const { id } = req.params;
  try {
    recordTitleDebug("server", "api_thread_archive_begin", {
      threadId: id,
      title: knownThreadTitleById.get(id) ?? null,
    });
    await bridge.request("thread/archive", { threadId: id });
    clearPendingInterrupt(id);
    markLocalTurnCompleted(id);
    clearLocalRunIntent(id);
    externalRunCacheByThreadId.set(id, { state: buildInactiveExternalRunState(), checkedAtMs: Date.now() });
    recordTitleDebug("server", "api_thread_archive_success", {
      threadId: id,
      title: knownThreadTitleById.get(id) ?? null,
    });
    res.json({ ok: true, threadId: id, archived: true });
  } catch (error) {
    recordTitleDebug("server", "api_thread_archive_failed", {
      threadId: id,
      title: knownThreadTitleById.get(id) ?? null,
      detail: {
        error: error instanceof Error ? error.message : "unknown",
      },
    });
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to archive thread" });
  }
});

app.post("/api/threads/:id/messages", async (req, res) => {
  const { id } = req.params;
  const normalizedThreadId = normalizeThreadId(id);
  if (normalizedThreadId) touchTrackedThread(normalizedThreadId);
  const threadId = normalizedThreadId ?? id;
  const message = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const model = req.body?.model ? String(req.body.model) : null;
  const effort = req.body?.effort ? String(req.body.effort) : null;
  const clientActionId = normalizeClientActionId(req.body?.clientActionId ?? null);
  const approvalPolicy = normalizeTurnStartApprovalPolicy(req.body?.approvalPolicy ?? null);
  const sandbox = normalizeTurnStartSandbox(req.body?.sandbox ?? null);
  const attachments = parseIncomingAttachments(req.body?.attachments);
  const preparedAttachments = parsePreparedAttachments(req.body?.preparedAttachments);
  const traceId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAtMs = Date.now();
  recordTitleDebug("server", "message_route_begin", {
    threadId,
    title: knownThreadTitleById.get(threadId) ?? null,
    detail: {
      traceId,
      clientActionId,
      textChars: message.length,
      preparedAttachmentCount: preparedAttachments.length,
      attachmentCount: attachments.length,
    },
  });
  recordStopFlowDebug("server", "message_route_begin", {
    threadId,
    detail: {
      traceId,
      clientActionId,
      textChars: message.length,
      preparedAttachmentCount: preparedAttachments.length,
      attachmentCount: attachments.length,
    },
  });
  if (!message && attachments.length === 0 && preparedAttachments.length === 0) {
    console.warn(
      `[messages:${traceId}] rejected: empty payload thread=${id} prepared=${preparedAttachments.length} attachments=${attachments.length}`
    );
    recordStopFlowDebug("server", "message_route_rejected_empty_payload", {
      threadId,
      detail: { traceId, clientActionId, preparedAttachmentCount: preparedAttachments.length, attachmentCount: attachments.length },
    });
    res.status(400).json({ error: "Message or attachment required" });
    return;
  }

  const sendResolution = await resolveSendTurn(id);
  if (sendResolution.type === "external_surface_run") {
    recordStopFlowDebug("server", "message_route_external_surface_rejected", {
      threadId,
      detail: { traceId, clientActionId },
    });
    res.status(409).json({
      ok: false,
      code: "EXTERNAL_SURFACE_RUN",
      error: "You cannot steer because the current run was started on another Codex surface.",
    });
    return;
  }

  try {
    console.log(
      `[messages:${traceId}] start thread=${id} text_chars=${message.length} prepared=${preparedAttachments.length} attachments=${attachments.length}`
    );
    const materializeStartedAtMs = Date.now();
    const encodedAttachmentInputs = await materializeAttachments(id, attachments);
    const attachmentInputs = [...preparedAttachments, ...encodedAttachmentInputs];
    console.log(
      `[messages:${traceId}] materialize_done encoded=${encodedAttachmentInputs.length} total_inputs=${attachmentInputs.length} elapsed_ms=${
        Date.now() - materializeStartedAtMs
      }`
    );
    const input: Array<Record<string, unknown>> = [];
    if (message) {
      input.push({ type: "text", text: message, text_elements: [] });
    }
    for (const attachment of attachmentInputs) {
      input.push(attachment);
    }
    if (!input.length) {
      res.status(400).json({ error: "No valid attachment payloads were provided" });
      return;
    }
    const freshTitles = await loadThreadTitles({ bypassCache: true, reason: "message_route_pre_send", threadId: id });
    const knownTitle = resolveEffectiveThreadTitle(normalizedThreadId ?? id, {
      titles: freshTitles,
    });
    recordTitleDebug("server", "message_route_title_lookup", {
      threadId,
      title: knownTitle,
      detail: {
        traceId,
        clientActionId,
        found: Boolean(knownTitle),
        titleStoreCount: freshTitles.size,
      },
    });
    if (knownTitle) {
      registerKnownLiveSyncTitle(normalizedThreadId ?? id, knownTitle, { source: "message_route_pre_send" });
    }
    const liveSyncUserText =
      message ||
      attachmentInputs
        .map((attachment) => {
          if (attachment.type === "mention") return attachment.name || "attachment";
          return path.basename(attachment.path || "image");
        })
        .join(", ");
    if (liveSyncUserText) {
      desktopLiveSync.registerOutgoingUserText(id, liveSyncUserText);
    }
    const params: Record<string, unknown> = {
      threadId: id,
      input,
    };
    if (model) params.model = model;
    if (effort) params.effort = effort;
    if (approvalPolicy) params.approvalPolicy = approvalPolicy;
    if (sandbox) params.sandbox = sandbox;
    const turnStartStartedAtMs = Date.now();
    markLocalRunIntent(id);
    const requestTurnStart = async (): Promise<any> => {
      try {
        return await bridge.request("turn/start", params);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Failed to start turn";
        if (!isLikelyThreadNotFoundError(errorMessage)) {
          throw error;
        }

        recordStopFlowDebug("server", "message_turn_start_thread_resume_retry", {
          threadId,
          detail: { traceId, clientActionId, error: errorMessage },
        });
        const resumeStartedAtMs = Date.now();
        const resumeParams: Record<string, unknown> = { threadId: id };
        if (approvalPolicy) resumeParams.approvalPolicy = approvalPolicy;
        if (sandbox) resumeParams.sandbox = sandbox;
        await bridge.request("thread/resume", resumeParams);
        console.log(
          `[messages:${traceId}] thread_resume_retry_ok elapsed_ms=${Date.now() - resumeStartedAtMs}`
        );
        return bridge.request("turn/start", params);
      }
    };

    void requestTurnStart()
      .then((result) => {
        const resolvedTurnId = normalizeTurnId(result?.turnId ?? result?.turn_id ?? result?.turn?.id ?? null);
        recordStopFlowDebug("server", "message_turn_start_ok_async", {
          threadId,
          turnId: resolvedTurnId,
          detail: { traceId, clientActionId, resolvedTurnId },
        });
        if (resolvedTurnId) {
          markLocalTurnStarted(id, resolvedTurnId);
          const pendingInterrupt = getPendingInterrupt(id);
          if (pendingInterrupt) {
            void attemptPendingInterrupt(id, resolvedTurnId).then((interrupted) => {
              if (interrupted) {
                markLocalTurnCompleted(id, resolvedTurnId);
              }
            });
          }
        }
        console.log(
          `[messages:${traceId}] turn_start_ok_async elapsed_ms=${Date.now() - turnStartStartedAtMs} total_elapsed_ms=${
            Date.now() - startedAtMs
          }`
        );
      })
      .catch((error) => {
        clearLocalRunIntent(id);
        clearPendingInterrupt(id);
        const asyncErrorMessage = error instanceof Error ? error.message : "Failed to start turn";
        recordStopFlowDebug("server", "message_turn_start_failed_async", {
          threadId,
          detail: { traceId, clientActionId, error: asyncErrorMessage },
        });
        console.error(
          `[messages:${traceId}] turn_start_failed_async thread=${id} elapsed_ms=${
            Date.now() - turnStartStartedAtMs
          }: ${asyncErrorMessage}`
        );
        broadcastNotification("pocketdex/turn-start-failed", {
          threadId: id,
          traceId,
          error: asyncErrorMessage,
        });
      });
    console.log(`[messages:${traceId}] accepted thread=${id} total_elapsed_ms=${Date.now() - startedAtMs}`);
    recordStopFlowDebug("server", "message_route_accepted", {
      threadId,
      detail: { traceId, clientActionId, elapsedMs: Date.now() - startedAtMs },
    });
    recordTitleDebug("server", "message_route_accepted", {
      threadId,
      title: knownThreadTitleById.get(threadId) ?? null,
      detail: { traceId, clientActionId, elapsedMs: Date.now() - startedAtMs },
    });
    res.status(202).json({ ok: true, accepted: true, traceId, clientActionId });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Failed to send";
    console.error(`[messages:${traceId}] failed thread=${id} elapsed_ms=${Date.now() - startedAtMs}: ${messageText}`);
    recordStopFlowDebug("server", "message_route_failed", {
      threadId,
      detail: { traceId, clientActionId, elapsedMs: Date.now() - startedAtMs, error: messageText },
    });
    recordTitleDebug("server", "message_route_failed", {
      threadId,
      title: knownThreadTitleById.get(threadId) ?? null,
      detail: {
        traceId,
        clientActionId,
        elapsedMs: Date.now() - startedAtMs,
        error: messageText,
      },
    });
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Failed to send" });
  }
});

app.post("/api/threads/:id/interrupt", async (req, res) => {
  const { id } = req.params;
  const normalizedThreadId = normalizeThreadId(id);
  const threadId = normalizedThreadId ?? id;
  touchTrackedThread(threadId);
  const requestedTurnId = normalizeTurnId(req.body?.turnId ?? "") ?? "";
  const clientActionId = normalizeClientActionId(req.body?.clientActionId ?? null);
  if (hasFreshPendingInterruptInFlight(threadId)) {
    const nowMs = Date.now();
    const inFlightAgeMs = getPendingInterruptInFlightAgeMs(threadId, nowMs) ?? 0;
    const pending = getPendingInterrupt(threadId);
    const pendingTurnId = normalizeTurnId(pending?.turnId ?? null);
    const shouldRetargetPending =
      Boolean(requestedTurnId) &&
      (!pendingTurnId || !turnIdsReferToSameTurn(requestedTurnId, pendingTurnId));
    if (shouldRetargetPending) {
      setPendingInterrupt(threadId, "direct", requestedTurnId, clientActionId);
      recordInterruptDebug("server", "interrupt_route_retargeted_in_flight", {
        threadId,
        turnId: requestedTurnId,
        detail: {
          requestedTurnId,
          pendingTurnId: pendingTurnId ?? null,
          pendingReason: pending?.reason ?? null,
          clientActionId: clientActionId ?? pending?.clientActionId ?? null,
        },
      });
    }
    let dedupedFallbackTriggered = false;
    let dedupedFallbackSuppressedInFlight = false;
    let dedupedLegacyFallbackAlreadyInFlight = false;
    if (inFlightAgeMs >= PENDING_INTERRUPT_DEDUPED_FORCE_AFTER_MS) {
      const lastFallbackAtMs = pendingInterruptDedupedFallbackAtByThreadId.get(threadId) ?? 0;
      dedupedLegacyFallbackAlreadyInFlight = hasFreshPendingInterruptDedupedLegacyInFlight(threadId, nowMs);
      if (dedupedLegacyFallbackAlreadyInFlight) {
        dedupedFallbackSuppressedInFlight = true;
      } else if (nowMs - lastFallbackAtMs >= PENDING_INTERRUPT_DEDUPED_LEGACY_RETRY_MS) {
        pendingInterruptDedupedFallbackAtByThreadId.set(threadId, nowMs);
        markPendingInterruptDedupedLegacyInFlight(threadId);
        dedupedFallbackTriggered = true;
        recordInterruptDebug("server", "interrupt_route_deduped_legacy_fallback_dispatched", {
          threadId,
          turnId: requestedTurnId || pendingTurnId || null,
          detail: {
            inFlightAgeMs,
            timeoutMs: PENDING_INTERRUPT_DEDUPED_LEGACY_TIMEOUT_MS,
            clientActionId: clientActionId ?? pending?.clientActionId ?? null,
          },
        });
        void bridge
          .requestWithTimeout(
            "interruptConversation",
            { conversationId: threadId },
            PENDING_INTERRUPT_DEDUPED_LEGACY_TIMEOUT_MS
          )
          .then(() => {
            recordInterruptDebug("server", "interrupt_route_deduped_legacy_fallback_succeeded", {
              threadId,
              turnId: requestedTurnId || pendingTurnId || null,
              detail: { inFlightAgeMs, clientActionId: clientActionId ?? pending?.clientActionId ?? null },
            });
          })
          .catch((error) => {
            recordInterruptDebug("server", "interrupt_route_deduped_legacy_fallback_failed", {
              threadId,
              turnId: requestedTurnId || pendingTurnId || null,
              detail: {
                inFlightAgeMs,
                error: error instanceof Error ? error.message : "unknown",
                clientActionId: clientActionId ?? pending?.clientActionId ?? null,
              },
            });
          })
          .finally(() => {
            clearPendingInterruptDedupedLegacyInFlight(threadId);
          });
      }
    }
    recordInterruptDebug("server", "interrupt_route_deduped_in_flight", {
      threadId,
      turnId: requestedTurnId || pendingTurnId || null,
      detail: {
        requestedTurnId: requestedTurnId || null,
        pendingTurnId: pendingTurnId ?? null,
        pendingReason: pending?.reason ?? null,
        retargeted: shouldRetargetPending,
        inFlightAgeMs,
        dedupedFallbackTriggered,
        dedupedFallbackSuppressedInFlight,
        dedupedLegacyFallbackAlreadyInFlight,
        clientActionId: clientActionId ?? pending?.clientActionId ?? null,
      },
    });
    res.status(202).json({
      ok: true,
      pending: true,
      deduped: true,
      retargeted: shouldRetargetPending,
      dedupedFallbackTriggered,
      dedupedFallbackSuppressedInFlight,
      clientActionId: clientActionId ?? pending?.clientActionId ?? null,
    });
    return;
  }

  const localSnapshotBefore = getLocalRunControlSnapshot(threadId);
  recordInterruptDebug("server", "interrupt_route_begin", {
    threadId,
    turnId: requestedTurnId || null,
    detail: {
      requestedTurnId: requestedTurnId || null,
      localActive: localSnapshotBefore.active,
      localTurnId: localSnapshotBefore.turnId ?? null,
      clientActionId,
    },
  });
  const resolved = await resolveInterruptTurn(threadId, requestedTurnId);
  recordInterruptDebug("server", "interrupt_route_resolved", {
    threadId,
    turnId: resolved.type === "resolved" ? resolved.turnId : requestedTurnId || null,
    detail: { resolvedType: resolved.type },
  });

  if (resolved.type === "external_surface_run") {
    recordInterruptDebug("server", "interrupt_route_external_surface", {
      threadId,
      detail: { requestedTurnId: requestedTurnId || null },
    });
    res.status(409).json({
      ok: false,
      code: "EXTERNAL_SURFACE_RUN",
      error: "You cannot stop the current run because it was started on another Codex surface.",
    });
    return;
  }

  if (resolved.type === "missing_turn_id") {
    const localControl = getLocalRunControlSnapshot(threadId);
    if (!localControl.active) {
      try {
        const effectiveExternalRun = await readEffectiveExternalRunState(threadId, {
          allowStaleMs: EXTERNAL_RUN_CACHE_TTL_MS,
        });
        if (effectiveExternalRun.active && effectiveExternalRun.owner === "local") {
          recordInterruptDebug("server", "interrupt_route_missing_turn_local_external_active", {
            threadId,
            detail: {
              owner: effectiveExternalRun.owner,
              source: effectiveExternalRun.source,
              externalTurnId: effectiveExternalRun.turnId ?? null,
              clientActionId,
            },
          });
          setPendingInterrupt(threadId, "unknown_turn", undefined, clientActionId);
          clearLocalRunIntent(threadId);
          const optimisticIdle: ExternalRunState = {
            active: false,
            source: "rollout",
            lastEventAt: new Date().toISOString(),
          };
          externalRunCacheByThreadId.set(threadId, { state: optimisticIdle, checkedAtMs: Date.now() });
          recordInterruptDebug("server", "interrupt_route_accepted_pending_unknown_turn", {
            threadId,
            detail: { reason: "missing_turn_local_external_active", clientActionId },
          });
          res.status(202).json({ ok: true, pending: true, clientActionId });
          return;
        }
      } catch (error) {
        recordInterruptDebug("server", "interrupt_route_missing_turn_external_read_failed", {
          threadId,
          detail: { error: error instanceof Error ? error.message : "unknown", clientActionId },
        });
        // fall through to 400 below
      }
      recordInterruptDebug("server", "interrupt_route_missing_turn_rejected", {
        threadId,
        detail: { localActive: false, clientActionId },
      });
      res.status(400).json({ ok: false, error: "No active turn found to interrupt." });
      return;
    }
    recordInterruptDebug("server", "interrupt_route_missing_turn_pre_start", {
      threadId,
      detail: { localActive: true, localTurnId: localControl.turnId ?? null, clientActionId },
    });
    setPendingInterrupt(threadId, "pre_start", undefined, clientActionId);
    clearLocalRunIntent(threadId);
    const optimisticIdle: ExternalRunState = {
      active: false,
      source: "rollout",
      lastEventAt: new Date().toISOString(),
    };
    externalRunCacheByThreadId.set(threadId, { state: optimisticIdle, checkedAtMs: Date.now() });
    recordInterruptDebug("server", "interrupt_route_accepted_pending_pre_start", {
      threadId,
      detail: { reason: "missing_turn_pre_start", clientActionId },
    });
    res.status(202).json({ ok: true, pending: true, clientActionId });
    return;
  }

  const turnId = resolved.turnId;
  recordInterruptDebug("server", "interrupt_route_direct_attempt", {
    threadId,
    turnId,
    detail: { clientActionId },
  });
  setPendingInterrupt(threadId, "direct", turnId, clientActionId);
  recordInterruptDebug("server", "interrupt_route_direct_dispatched", {
    threadId,
    turnId,
    detail: { clientActionId },
  });
  void attemptPendingInterrupt(threadId, turnId)
    .then((interrupted) => {
      if (!interrupted) return;
      const pending = getPendingInterrupt(threadId);
      const interruptedTurnId = normalizeTurnId(pending?.turnId ?? null) ?? turnId;
      markLocalTurnCompleted(threadId, interruptedTurnId);
      const optimisticIdle: ExternalRunState = {
        active: false,
        source: "rollout",
        lastEventAt: new Date().toISOString(),
      };
      externalRunCacheByThreadId.set(threadId, { state: optimisticIdle, checkedAtMs: Date.now() });
      recordInterruptDebug("server", "interrupt_route_direct_success", {
        threadId,
        turnId: interruptedTurnId,
        detail: { requestedTurnId: turnId, clientActionId },
      });
    })
    .catch((error) => {
      recordInterruptDebug("server", "interrupt_route_direct_dispatch_failed", {
        threadId,
        turnId,
        detail: {
          clientActionId,
          error: error instanceof Error ? error.message : "unknown",
        },
      });
    });
  res.status(202).json({ ok: true, pending: true, clientActionId });
});

app.post("/api/codex-desktop/resync", async (req, res) => {
  if (!desktopResyncEnabled) {
    res.status(501).json({ error: "Desktop resync is disabled in this build. Set POCKETDEX_ENABLE_DESKTOP_RESYNC=1 to enable it." });
    return;
  }
  const strategy = normalizeDesktopResyncStrategy(req.body?.strategy);
  const allowDuringActiveRuns = req.body?.allowDuringActiveRuns === true;
  const relaunchApp = req.body?.relaunchApp === true;
  const forceQuitApp = req.body?.forceQuitApp === true;
  const rolloutTouchLimitRaw = req.body?.rolloutTouchLimit;
  const rolloutTouchLimit =
    typeof rolloutTouchLimitRaw === "number" && Number.isFinite(rolloutTouchLimitRaw)
      ? rolloutTouchLimitRaw
      : undefined;
  try {
    const result = await resyncCodexDesktop({
      strategy,
      allowDuringActiveRuns,
      rolloutTouchLimit,
      relaunchApp,
      forceQuitApp,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to resync Codex Desktop" });
  }
});

if (webStaticDir) {
  app.use(
    express.static(webStaticDir, {
      index: false,
      setHeaders: (res, filePath) => {
        const name = path.basename(filePath);
        if (name === "manifest.json" || name === "sw.js" || name.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        }
      },
    }),
  );

  app.get(/^\/(?!api(?:\/|$)).*$/, async (req, res) => {
    if (path.extname(req.path)) {
      res.status(404).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(webStaticDir, "index.html"));
  });
} else {
  app.get("/", async (_req, res) => {
    res.json({
      name: "PocketDex server",
      docs: "Use /api/threads to list conversations",
      web: "Web build not found. Set POCKETDEX_WEB_DIR or build web/out.",
    });
  });
}

const onServerReady = () => {
  const printableHost = host && host !== "0.0.0.0" ? host : "localhost";
  console.log(`PocketDex server running on http://${printableHost}:${port}`);
  if (webStaticDir) {
    console.log(`Serving PocketDex web from ${webStaticDir}`);
  }
  if (INTERRUPT_DEBUG_ENABLED || STOP_FLOW_DEBUG_ENABLED || TITLE_DEBUG_ENABLED) {
    console.log(`[debug] interrupt log: ${INTERRUPT_DEBUG_LOG_PATH}`);
    console.log(`[debug] stop-flow log: ${STOP_FLOW_DEBUG_LOG_PATH}`);
    console.log(`[debug] title log: ${TITLE_DEBUG_LOG_PATH}`);
    console.log(`[debug] title overlay: ${TITLE_OVERLAY_FILE_PATH}`);
    console.log(
      `[debug] interrupt timeouts alias=${INTERRUPT_ALIAS_ATTEMPT_TIMEOUT_MS}ms legacy=${INTERRUPT_LEGACY_FALLBACK_TIMEOUT_MS}ms dedupeLegacy=${PENDING_INTERRUPT_DEDUPED_LEGACY_TIMEOUT_MS}ms`
    );
  }
  void loadThreadTitles({ bypassCache: true, reason: "server_startup_seed" }).catch((error) => {
    recordTitleDebug("server", "title_store_startup_seed_failed", {
      detail: {
        error: error instanceof Error ? error.message : "unknown",
      },
    });
  });
};

const server = host ? app.listen(port, host, onServerReady) : app.listen(port, onServerReady);

type ClientState = {
  id: string;
  socket: WebSocket;
  threads: Set<string>;
};

type ClientMessage =
  | { type: "subscribe"; threadId: string; resume?: boolean; wake?: boolean; resumeFrom?: number; lastSeq?: number }
  | { type: "unsubscribe"; threadId: string }
  | { type: "response"; id: number; result: unknown }
  | { type: "response_error"; id: number; message: string; code?: number };

type ThreadEventRecord = {
  seq: number;
  threadId: string;
  method: string;
  params: any;
  timestampMs: number;
};

type ThreadEventState = {
  nextSeq: number;
  history: ThreadEventRecord[];
  lastTouchedMs: number;
};

const clients = new Map<string, ClientState>();
const pendingRequests = new Map<number, { threadId?: string; method: string }>();
const threadEventStateById = new Map<string, ThreadEventState>();

const wss = new WebSocketServer({ server, path: "/api/stream" });

const send = (client: ClientState, payload: object) => {
  if (client.socket.readyState !== 1) return;
  client.socket.send(JSON.stringify(payload));
};

function parseResumeFrom(message: { resumeFrom?: number; lastSeq?: number }): number {
  const rawCandidate = typeof message.resumeFrom === "number" ? message.resumeFrom : message.lastSeq;
  if (typeof rawCandidate !== "number" || !Number.isFinite(rawCandidate)) return 0;
  const candidate = Math.trunc(rawCandidate);
  if (candidate <= 0) return 0;
  return candidate;
}

function getOrCreateThreadEventState(threadId: string): ThreadEventState {
  const existing = threadEventStateById.get(threadId);
  if (existing) return existing;
  const created: ThreadEventState = {
    nextSeq: 1,
    history: [],
    lastTouchedMs: Date.now(),
  };
  threadEventStateById.set(threadId, created);
  return created;
}

function pruneThreadEventHistory(threadId: string, state: ThreadEventState): void {
  const now = Date.now();
  state.lastTouchedMs = now;
  while (state.history.length > THREAD_EVENT_HISTORY_LIMIT) {
    state.history.shift();
  }
  while (state.history.length > 0 && now - state.history[0].timestampMs > THREAD_EVENT_HISTORY_TTL_MS) {
    state.history.shift();
  }
  if (state.history.length === 0) {
    state.lastTouchedMs = now;
  }
}

function appendThreadEvent(threadId: string, method: string, params: any): ThreadEventRecord {
  const state = getOrCreateThreadEventState(threadId);
  const record: ThreadEventRecord = {
    seq: state.nextSeq,
    threadId,
    method,
    params,
    timestampMs: Date.now(),
  };
  state.nextSeq += 1;
  state.history.push(record);
  pruneThreadEventHistory(threadId, state);
  return record;
}

function sendThreadEvent(client: ClientState, record: ThreadEventRecord): void {
  send(client, {
    type: "notification",
    method: record.method,
    params: record.params,
    threadId: record.threadId,
    seq: record.seq,
  });
}

function broadcastThreadEvent(record: ThreadEventRecord): void {
  for (const client of clients.values()) {
    if (!client.threads.has(record.threadId)) continue;
    sendThreadEvent(client, record);
  }
}

async function buildThreadSnapshot(threadId: string): Promise<any | null> {
  try {
    const result = await bridge.request("thread/read", { threadId, includeTurns: true });
    const sourceThread = result?.thread;
    if (!sourceThread || typeof sourceThread !== "object") return null;

    const titles = await loadThreadTitles({ reason: "build_thread_snapshot", threadId });
    const title = resolveEffectiveThreadTitle(sourceThread.id, {
      titles,
      fallbackTitle: sourceThread.title ?? null,
    });
    if (title) registerKnownLiveSyncTitle(sourceThread.id, title, { source: "build_thread_snapshot" });
    recordTitleDebug("server", "build_thread_snapshot_read", {
      threadId,
      title,
      detail: {
        sourceThreadId: normalizeThreadId(sourceThread.id ?? null),
        turnCount: Array.isArray(sourceThread.turns) ? sourceThread.turns.length : 0,
      },
    });
    const threadTurns = Array.isArray(sourceThread.turns) ? sourceThread.turns : [];
    const externalRunThreadId = normalizeThreadId(sourceThread.id ?? threadId) ?? threadId;
    const externalRun = await resolveExternalRunForThreadSnapshot(externalRunThreadId, threadTurns);
    let thread: any = {
      ...sourceThread,
      title,
      externalRun,
    };
    if (Array.isArray(thread.turns) && thread.turns.length) {
      const extras = getThreadExtras(thread.id);
      thread = {
        ...thread,
        turns: thread.turns.map((turn: any) => {
          const stored = extras[turn.id];
          if (!stored) return turn;
          const existingIds = new Set((turn.items ?? []).map((item: any) => item?.id).filter(Boolean));
          const extraItems = [
            ...Object.values(stored.fileChanges ?? {}),
            ...(stored.turnDiff ? [stored.turnDiff] : []),
          ].filter((item: any) => item && !existingIds.has(item.id));
          if (!extraItems.length) return turn;
          return { ...turn, items: [...(turn.items ?? []), ...extraItems] };
        }),
      };
    }
    return thread;
  } catch {
    return null;
  }
}

async function sendThreadSnapshot(
  client: ClientState,
  threadId: string,
  options?: { reason?: "gap" | "resume" | "fallback"; seqBase?: number }
): Promise<void> {
  const state = threadEventStateById.get(threadId);
  const defaultSeqBase = state ? Math.max(0, state.nextSeq - 1) : 0;
  const seqBaseRaw = options?.seqBase;
  const seqBase =
    typeof seqBaseRaw === "number" && Number.isFinite(seqBaseRaw)
      ? Math.max(0, Math.trunc(seqBaseRaw))
      : defaultSeqBase;
  const thread = await buildThreadSnapshot(threadId);
  recordTitleDebug("server", "send_thread_snapshot", {
    threadId,
    title: normalizeThreadTitle(thread?.title ?? null),
    detail: {
      reason: options?.reason ?? "fallback",
      seqBase,
      hasThread: Boolean(thread),
    },
  });
  send(client, {
    type: "thread_snapshot",
    threadId,
    seqBase,
    reason: options?.reason ?? "fallback",
    thread,
  });
}

async function sendThreadCatchUp(client: ClientState, threadId: string, resumeFrom: number): Promise<void> {
  const state = threadEventStateById.get(threadId);
  const safeResumeFrom = Number.isFinite(resumeFrom) ? Math.max(0, Math.trunc(resumeFrom)) : 0;
  if (safeResumeFrom === 0) {
    const latestSeq = state ? Math.max(0, state.nextSeq - 1) : 0;
    send(client, { type: "thread_sync", threadId, latestSeq });
    return;
  }
  if (!state || state.history.length === 0) {
    if (safeResumeFrom > 0) {
      await sendThreadSnapshot(client, threadId, { reason: "resume", seqBase: 0 });
    } else {
      send(client, { type: "thread_sync", threadId, latestSeq: 0 });
    }
    return;
  }

  const latestSeq = Math.max(0, state.nextSeq - 1);
  if (safeResumeFrom >= latestSeq) {
    send(client, { type: "thread_sync", threadId, latestSeq });
    return;
  }

  const earliestSeq = state.history[0]?.seq ?? latestSeq;
  if (safeResumeFrom > 0 && safeResumeFrom < earliestSeq - 1) {
    await sendThreadSnapshot(client, threadId, { reason: "gap", seqBase: latestSeq });
    return;
  }

  for (const record of state.history) {
    if (record.seq <= safeResumeFrom) continue;
    sendThreadEvent(client, record);
  }
  send(client, { type: "thread_sync", threadId, latestSeq });
}

function broadcastNotification(method: string, params: any): void {
  const rawThreadId = extractThreadIdFromParams(params);
  const threadId = normalizeThreadId(rawThreadId);
  if (!threadId) {
    for (const client of clients.values()) {
      send(client, { type: "notification", method, params });
    }
    return;
  }
  touchTrackedThread(threadId);
  const record = appendThreadEvent(threadId, method, params);
  broadcastThreadEvent(record);
}

bridge.on("notification", (note: { method: string; params: any }) => {
  desktopLiveSync.handleNotification(note);
  const rawThreadId = extractThreadIdFromParams(note.params);
  const threadId = normalizeThreadId(rawThreadId);
  const eventTitle = normalizeThreadTitle(note.params?.threadName ?? note.params?.thread_name ?? note.params?.thread?.title ?? null);
  if (
    threadId &&
    (note.method === "thread/name/updated" ||
      note.method === "turn/completed" ||
      note.method === "turn/aborted" ||
      note.method === "error" ||
      note.method === "thread/archived" ||
      note.method === "thread/unarchived")
  ) {
    recordTitleDebug("bridge", "notification_received", {
      threadId,
      title: eventTitle,
      detail: {
        method: note.method,
        eventTitle,
      },
    });
  }
  if (note.method === "thread/name/updated") {
    const threadName = note.params?.threadName ?? note.params?.thread_name;
    registerKnownLiveSyncTitle(threadId, threadName, {
      source: "notification_thread_name_updated",
    });
  }
  if (note.method === "item/started" || note.method === "item/completed") {
    const item = note.params?.item;
    if (item?.type === "fileChange") {
      const threadId = note.params?.threadId ?? note.params?.thread_id ?? item?.threadId;
      const turnId = note.params?.turnId ?? note.params?.turn_id ?? item?.turnId;
      if (threadId && turnId) recordFileChange(String(threadId), String(turnId), item);
    }
  }
  if (note.method === "turn/diff/updated") {
    const threadId = note.params?.threadId ?? note.params?.thread_id;
    const turnId = note.params?.turnId ?? note.params?.turn_id;
    const diff = typeof note.params?.diff === "string" ? note.params.diff : "";
    if (threadId && turnId && diff) recordTurnDiff(String(threadId), String(turnId), diff);
  }
  if (threadId) {
    const turnId = normalizeTurnId(
      note.params?.turnId ??
        note.params?.turn_id ??
        note.params?.turn?.id ??
        note.params?.item?.turnId ??
        note.params?.item?.turn_id ??
        note.params?.item?.turn?.id ??
        note.params?.item?.turn?.turnId ??
        note.params?.item?.turn?.turn_id ??
        null
    );
    const pendingInterrupt = getPendingInterrupt(threadId);
    if (
      note.method === "turn/started" ||
      note.method === "item/started" ||
      note.method === "item/completed" ||
      note.method === "turn/completed" ||
      note.method === "turn/aborted" ||
      note.method === "error"
    ) {
      recordInterruptDebug("server", "app_server_notification", {
        threadId,
        turnId,
        detail: {
          method: note.method,
          pendingInterrupt: Boolean(pendingInterrupt),
          pendingTurnId: pendingInterrupt?.turnId ?? null,
          pendingReason: pendingInterrupt?.reason ?? null,
          pendingClientActionId: pendingInterrupt?.clientActionId ?? null,
          paramKeys: note.params && typeof note.params === "object" ? Object.keys(note.params).slice(0, 20) : [],
          candidateTurnId: note.params?.turnId ?? null,
          candidateTurn_id: note.params?.turn_id ?? null,
          candidateTurnDotId: note.params?.turn?.id ?? null,
          candidateTurnDotStatus: note.params?.turn?.status ?? null,
          candidateTurnDotError: note.params?.turn?.error ?? null,
          candidateTurnDotTurnId: note.params?.turn?.turnId ?? note.params?.turn?.turn_id ?? null,
          candidateItemTurnId:
            note.params?.item?.turnId ?? note.params?.item?.turn_id ?? note.params?.item?.turn?.id ?? null,
        },
      });
    }

    if (note.method === "turn/started") {
      if (turnId && shouldTrackLocalRunForEvent(threadId, turnId)) {
        markLocalTurnStarted(threadId, turnId);
      } else if (!turnId && shouldTrackLocalRunForEvent(threadId, null)) {
        markLocalRunIntent(threadId);
      }
      if (pendingInterrupt && turnId) {
        void attemptPendingInterrupt(threadId, turnId).then((interrupted) => {
          if (interrupted) {
            markLocalTurnCompleted(threadId, turnId);
          }
        });
      }
    } else if (note.method === "item/started" || note.method === "item/completed") {
      if (turnId && shouldTrackLocalRunForEvent(threadId, turnId)) {
        markLocalTurnStarted(threadId, turnId);
      }
      if (pendingInterrupt && turnId) {
        void attemptPendingInterrupt(threadId, turnId).then((interrupted) => {
          if (interrupted) {
            markLocalTurnCompleted(threadId, turnId);
          }
        });
      }
    } else if (note.method === "turn/completed" || note.method === "turn/aborted") {
      clearPendingInterrupt(threadId);
      if (shouldTrackLocalRunForEvent(threadId, turnId)) {
        markLocalTurnCompleted(threadId, turnId);
      }
    } else if (note.method === "error") {
      clearPendingInterrupt(threadId);
      if (shouldTrackLocalRunForEvent(threadId, turnId)) {
        markLocalTurnCompleted(threadId, turnId);
      }
    }

    if (note.method === "turn/started" || note.method === "item/started") {
      const optimisticState: ExternalRunState = {
        active: pendingInterrupt ? false : true,
        source: "rollout",
        lastEventAt: new Date().toISOString(),
      };
      externalRunCacheByThreadId.set(threadId, { state: optimisticState, checkedAtMs: Date.now() });
    } else if (note.method === "turn/completed" || note.method === "turn/aborted" || note.method === "error") {
      const optimisticIdle: ExternalRunState = {
        active: false,
        source: "rollout",
        lastEventAt: new Date().toISOString(),
      };
      externalRunCacheByThreadId.set(threadId, { state: optimisticIdle, checkedAtMs: Date.now() });
    }
  }
  // Do not synthesize turn completion from item events: AppServer `turn/completed` is the terminal signal.
  broadcastNotification(note.method, note.params);
});

bridge.on("request", (request: { id: number; method: string; params: any }) => {
  const threadId = extractThreadIdFromParams(request.params);
  pendingRequests.set(request.id, { threadId: threadId ?? undefined, method: request.method });
  let delivered = false;
  for (const client of clients.values()) {
    if (threadId && !client.threads.has(threadId)) continue;
    send(client, { type: "request", id: request.id, method: request.method, params: request.params });
    delivered = true;
  }
  if (!delivered) {
    pendingRequests.delete(request.id);
    bridge.respondError(request.id, "No active client to handle request");
  }
});

wss.on("connection", (socket) => {
  const clientId = `client-${Math.random().toString(36).slice(2)}`;
  const state: ClientState = { id: clientId, socket, threads: new Set() };
  clients.set(clientId, state);

  socket.on("message", async (raw) => {
    let msg: ClientMessage | null = null;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "subscribe") {
      const threadId = normalizeThreadId(msg.threadId);
      if (!threadId) return;
      state.threads.add(threadId);
      touchTrackedThread(threadId);
      // Subscription resume is for stream catch-up only.
      // Waking a thread in codex app-server is explicit because it's expensive.
      if (msg.wake === true) {
        try {
          await ensureThreadLoadedForWake(threadId);
        } catch (error) {
          send(state, { type: "error", message: error instanceof Error ? error.message : "Failed to subscribe" });
        }
      }
      const resumeFrom = parseResumeFrom(msg);
      await sendThreadCatchUp(state, threadId, resumeFrom);
      return;
    }

    if (msg.type === "unsubscribe") {
      state.threads.delete(String(msg.threadId));
      return;
    }

    if (msg.type === "response") {
      const requestId = Number(msg.id);
      if (!pendingRequests.has(requestId)) return;
      pendingRequests.delete(requestId);
      bridge.respond(requestId, msg.result);
      return;
    }

    if (msg.type === "response_error") {
      const requestId = Number(msg.id);
      if (!pendingRequests.has(requestId)) return;
      pendingRequests.delete(requestId);
      bridge.respondError(requestId, msg.message || "Request rejected", msg.code ?? -32000);
    }
  });

  socket.on("close", () => {
    clients.delete(clientId);
  });
});
