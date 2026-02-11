import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

type PendingRequest = {
  method: string;
  startedAtMs: number;
  timeoutMs: number;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type ServerNotification = {
  method: string;
  params: any;
};

type ServerRequest = {
  id: number;
  method: string;
  params: any;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const METHOD_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  "turn/start": 180000,
  "turn/interrupt": 8000,
  "thread/read": 45000,
};
const ORIGINATOR_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const ORIGINATOR_NAME = "pocketdex_server";
const DESKTOP_CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const BRIDGE_DEBUG_METHODS = new Set([
  "turn/interrupt",
  "interruptConversation",
  "turn/start",
  "thread/read",
  "thread/resume",
]);
const BRIDGE_DEBUG_ENABLED = process.env.POCKETDEX_BRIDGE_DEBUG === "1";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = path.resolve(MODULE_DIR, "..", "..");
const BRIDGE_DEBUG_LOG_PATH =
  process.env.POCKETDEX_BRIDGE_DEBUG_LOG?.trim() ||
  path.join(WORKSPACE_DIR, ".tmp", "logs", "pocketdex-bridge-interrupt-debug.jsonl");

type BridgeDebugRecord = {
  at: string;
  event: string;
  detail: Record<string, unknown>;
};

function shouldBridgeDebugMethod(method: string): boolean {
  return BRIDGE_DEBUG_METHODS.has(method);
}

function recordBridgeDebug(event: string, detail: Record<string, unknown>): void {
  if (!BRIDGE_DEBUG_ENABLED) return;
  const record: BridgeDebugRecord = { at: new Date().toISOString(), event, detail };
  const serialized = JSON.stringify(record);
  console.log(`[bridge-debug] ${serialized}`);
  void fs
    .mkdir(path.dirname(BRIDGE_DEBUG_LOG_PATH), { recursive: true })
    .then(() => fs.appendFile(BRIDGE_DEBUG_LOG_PATH, `${serialized}\n`))
    .catch(() => {
      // Ignore debug log write failures.
    });
}

export class AppServerBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private readyPromise: Promise<void> | null = null;
  private initialized = false;

  private startProcess(): void {
    if (this.child) return;
    const codexBin = resolveCodexBin();
    const env = { ...process.env } as Record<string, string>;
    if (!env[ORIGINATOR_ENV]) env[ORIGINATOR_ENV] = ORIGINATOR_NAME;

    console.info(`[AppServerBridge] starting codex app-server with binary: ${codexBin}`);
    if (BRIDGE_DEBUG_ENABLED) {
      console.info(`[bridge-debug] log path: ${BRIDGE_DEBUG_LOG_PATH}`);
    }
    this.child = spawn(codexBin, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.on("error", (err) => {
      console.error("codex app-server failed to start:", err);
      this.reset();
    });
    this.child.on("exit", (code) => {
      console.error(`codex app-server exited with code ${code}`);
      this.reset();
    });

    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.handleLine(line));

    if (this.child.stderr) {
      this.child.stderr.on("data", (chunk) => {
        const raw = chunk.toString();
        const lines = raw.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean);
        for (const line of lines) {
          if (isNoisyAppServerLog(line)) continue;
          console.error("codex app-server stderr:", line);
        }
      });
    }
  }

  private handleLine(line: string): void {
    let parsed: any = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;

    if (typeof parsed.id !== "undefined") {
      if (parsed.method) {
        const request: ServerRequest = {
          id: Number(parsed.id),
          method: String(parsed.method),
          params: parsed.params ?? null,
        };
        this.emit("request", request);
        return;
      }
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(parsed.id);
      if (shouldBridgeDebugMethod(pending.method)) {
        recordBridgeDebug(parsed.error ? "request_error" : "request_result", {
          id: parsed.id,
          method: pending.method,
          timeoutMs: pending.timeoutMs,
          elapsedMs: Date.now() - pending.startedAtMs,
          pendingCount: this.pending.size,
          error: parsed.error?.message ?? null,
        });
      }
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message || "App-server error"));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    if (parsed.method) {
      const notification: ServerNotification = {
        method: String(parsed.method),
        params: parsed.params ?? null,
      };
      this.emit("notification", notification);
    }
  }

  private reset(): void {
    this.initialized = false;
    this.readyPromise = null;
    this.child?.removeAllListeners();
    this.rl?.removeAllListeners();
    this.child = null;
    this.rl = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("App-server disconnected"));
    }
    this.pending.clear();
  }

  private send(payload: object): void {
    if (!this.child || !this.child.stdin) {
      throw new Error("App-server not running");
    }
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
  }

  private requestRaw(method: string, params?: Record<string, unknown>, timeoutMsOverride?: number): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const startedAtMs = Date.now();
      const timeoutMs =
        typeof timeoutMsOverride === "number" && Number.isFinite(timeoutMsOverride) && timeoutMsOverride > 0
          ? Math.trunc(timeoutMsOverride)
          : METHOD_TIMEOUT_OVERRIDES_MS[method] ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        if (shouldBridgeDebugMethod(method)) {
          recordBridgeDebug("request_timeout", {
            id,
            method,
            timeoutMs,
            elapsedMs: Date.now() - startedAtMs,
            pendingCount: this.pending.size,
          });
        }
        reject(new Error(`App-server timeout for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, startedAtMs, timeoutMs, resolve, reject, timeout });
      if (shouldBridgeDebugMethod(method)) {
        recordBridgeDebug("request_sent", {
          id,
          method,
          timeoutMs,
          pendingCount: this.pending.size,
          hasParams: Boolean(params && Object.keys(params).length > 0),
        });
      }
      try {
        this.send({ id, method, params });
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        if (shouldBridgeDebugMethod(method)) {
          recordBridgeDebug("request_send_error", {
            id,
            method,
            timeoutMs,
            elapsedMs: Date.now() - startedAtMs,
            pendingCount: this.pending.size,
            error: err instanceof Error ? err.message : "unknown",
          });
        }
        reject(err instanceof Error ? err : new Error("Failed to send app-server request"));
      }
    });
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.startProcess();
    const clientInfo = {
      name: "pocketdex",
      title: "PocketDex Companion",
      version: "0.1.0",
    };
    await this.requestRaw("initialize", { clientInfo, capabilities: null });
    this.send({ method: "initialized" });
    this.initialized = true;
  }

  private async ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.initialize().catch((err) => {
      this.readyPromise = null;
      throw err;
    });
    return this.readyPromise;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<any> {
    await this.ensureReady();
    return this.requestRaw(method, params);
  }

  async requestWithTimeout(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<any> {
    await this.ensureReady();
    return this.requestRaw(method, params, timeoutMs);
  }

  respond(id: number, result: any): void {
    this.send({ id, result });
  }

  respondError(id: number, message: string, code = -32000): void {
    this.send({ id, error: { code, message } });
  }
}

let singleton: AppServerBridge | null = null;

export function getAppServerBridge(): AppServerBridge {
  if (!singleton) singleton = new AppServerBridge();
  return singleton;
}

function isNoisyAppServerLog(line: string): boolean {
  // Some app-server logs include ANSI escapes and slightly different wording.
  const sanitized = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim().toLowerCase();

  if (sanitized.includes("falling back on rollout system")) return true;
  if (sanitized.includes("state db unavailable; falling back on rollout system")) return true;
  if (sanitized.includes("state db missing rollout path for thread")) return true;
  return false;
}

function resolveCodexBin(): string {
  const explicit = process.env.CODEX_BIN?.trim();
  if (explicit) return explicit;
  if (existsSync(DESKTOP_CODEX_BIN)) return DESKTOP_CODEX_BIN;
  return "codex";
}
