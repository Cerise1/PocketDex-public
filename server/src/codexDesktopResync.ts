import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { getExternalRunState } from "./externalRunState.js";

const DESKTOP_APP_SERVER_CMD = "/Applications/Codex.app/Contents/Resources/codex app-server";
const DESKTOP_APP_CMD = "/Applications/Codex.app/Contents/MacOS/Codex";
const DESKTOP_APP_NAME = "Codex";
const ROLLOUT_FILE_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const ENABLE_DESKTOP_APP_SERVER_RESTART = process.env.POCKETDEX_ENABLE_DESKTOP_RESTART === "1";

export type DesktopResyncStrategy = "nudge" | "restart_app_server" | "all";

export type DesktopResyncOptions = {
  strategy?: DesktopResyncStrategy;
  allowDuringActiveRuns?: boolean;
  rolloutTouchLimit?: number;
  relaunchApp?: boolean;
  forceQuitApp?: boolean;
};

export type DesktopResyncResult = {
  ok: boolean;
  strategy: DesktopResyncStrategy;
  codexDesktopAppServerPids: number[];
  activeRunDetected: boolean;
  restartedPids: number[];
  touchedFiles: string[];
  skippedRestartReason: string | null;
  appRelaunchTriggered: boolean;
  appForceQuitUsed: boolean;
  warnings: string[];
};

function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function strategyNeedsNudge(strategy: DesktopResyncStrategy): boolean {
  return strategy === "nudge" || strategy === "all";
}

function strategyNeedsRestart(strategy: DesktopResyncStrategy): boolean {
  return strategy === "restart_app_server" || strategy === "all";
}

function isValidStrategy(value: unknown): value is DesktopResyncStrategy {
  return value === "nudge" || value === "restart_app_server" || value === "all";
}

async function execPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-axo", "pid=,command="], { timeout: 4000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function openCodexApp(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("open", ["-a", DESKTOP_APP_NAME], { timeout: 6000 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function quitCodexApp(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", `tell application "${DESKTOP_APP_NAME}" to quit`], { timeout: 6000 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function normalizeDesktopResyncStrategy(value: unknown): DesktopResyncStrategy {
  if (isValidStrategy(value)) return value;
  return "nudge";
}

async function listDesktopAppServerPids(): Promise<number[]> {
  const stdout = await execPs();
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const command = match[2] ?? "";
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!command.includes(DESKTOP_APP_SERVER_CMD)) continue;
    pids.push(pid);
  }
  return pids;
}

async function listDesktopAppPids(): Promise<number[]> {
  const stdout = await execPs();
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const command = match[2] ?? "";
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!command.includes(DESKTOP_APP_CMD)) continue;
    pids.push(pid);
  }
  return pids;
}

async function listRolloutsForDay(dayRoot: string): Promise<Array<{ filePath: string; mtimeMs: number }>> {
  const result: Array<{ filePath: string; mtimeMs: number }> = [];
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(dayRoot, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const threadId = parseThreadIdFromRolloutName(entry.name);
    if (!threadId) continue;
    const fullPath = path.join(dayRoot, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      result.push({ filePath: fullPath, mtimeMs: Number(stat.mtimeMs) });
    } catch {
      // ignore
    }
  }
  return result;
}

function buildCandidateDayPaths(sessionsRoot: string): string[] {
  const days = [0, 1, 2, 3];
  const dayPaths: string[] = [];
  for (const dayOffset of days) {
    const date = new Date();
    date.setDate(date.getDate() - dayOffset);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    dayPaths.push(path.join(sessionsRoot, year, month, day));
  }
  return dayPaths;
}

function parseThreadIdFromRolloutName(fileName: string): string | null {
  const match = fileName.match(ROLLOUT_FILE_RE);
  if (!match?.[1]) return null;
  return match[1];
}

async function findRecentRolloutFiles(codexHome: string, limit: number): Promise<string[]> {
  const sessionsRoot = path.join(codexHome, "sessions");
  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const dayPath of buildCandidateDayPaths(sessionsRoot)) {
    const files = await listRolloutsForDay(dayPath);
    candidates.push(...files);
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, Math.max(1, limit)).map((entry) => entry.filePath);
}

async function touchFiles(filePaths: string[]): Promise<string[]> {
  const touched: string[] = [];
  const now = new Date();
  for (const filePath of filePaths) {
    try {
      await fs.utimes(filePath, now, now);
      touched.push(filePath);
    } catch {
      // ignore
    }
  }
  return touched;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return !isPidAlive(pid);
}

async function waitForPidsExit(pids: number[], timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pids.every((pid) => !isPidAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 140));
  }
  return pids.every((pid) => !isPidAlive(pid));
}

async function restartDesktopAppServers(pids: number[]): Promise<{ restarted: number[]; warnings: string[] }> {
  const restarted: number[] = [];
  const warnings: string[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      const exited = await waitForPidExit(pid, 2500);
      if (!exited) {
        warnings.push(`Timed out waiting for PID ${pid} to exit`);
      } else {
        restarted.push(pid);
      }
    } catch (error) {
      warnings.push(`Failed to restart PID ${pid}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  return { restarted, warnings };
}

async function relaunchDesktopApp(forceQuitApp: boolean): Promise<{ triggered: boolean; forcedQuit: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  let forcedQuit = false;
  let appPids: number[] = [];
  try {
    appPids = await listDesktopAppPids();
  } catch (error) {
    warnings.push(`Failed to list Codex Desktop app process: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  if (forceQuitApp) {
    if (appPids.length > 0) {
      forcedQuit = true;
      for (const pid of appPids) {
        try {
          // Hard stop first to avoid in-app quit confirmation dialogs.
          process.kill(pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      const sigkillExited = await waitForPidsExit(appPids, 900);
      if (!sigkillExited) {
        warnings.push("Failed to fully stop Codex app before relaunch");
      }
    }
  } else {
    try {
      await quitCodexApp();
    } catch (error) {
      warnings.push(`Failed to quit Codex app gracefully: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    if (appPids.length > 0) {
      const exited = await waitForPidsExit(appPids, 8000);
      if (!exited) {
        warnings.push("Timed out waiting for Codex app to close before relaunch");
      }
    }
  }

  try {
    await openCodexApp();
    return { triggered: true, forcedQuit, warnings };
  } catch (error) {
    warnings.push(`Failed to reopen Codex app: ${error instanceof Error ? error.message : "unknown error"}`);
    return { triggered: false, forcedQuit, warnings };
  }
}

async function detectActiveRun(rolloutPaths: string[]): Promise<boolean> {
  for (const rolloutPath of rolloutPaths) {
    const threadId = parseThreadIdFromRolloutName(path.basename(rolloutPath));
    if (!threadId) continue;
    try {
      const runState = await getExternalRunState(threadId);
      if (runState.active) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

export async function resyncCodexDesktop(options: DesktopResyncOptions = {}): Promise<DesktopResyncResult> {
  const strategy = options.strategy ?? "nudge";
  const allowDuringActiveRuns = options.allowDuringActiveRuns === true;
  const relaunchApp = options.relaunchApp === true;
  const forceQuitApp = options.forceQuitApp === true;
  const rolloutTouchLimit = Number.isFinite(options.rolloutTouchLimit)
    ? Math.max(1, Math.min(40, Number(options.rolloutTouchLimit)))
    : 8;

  const codexHome = resolveCodexHome();
  const warnings: string[] = [];
  const touchedFiles: string[] = [];
  let pids: number[] = [];
  try {
    pids = await listDesktopAppServerPids();
  } catch (error) {
    warnings.push(`Failed to list Codex Desktop app-server processes: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  let rolloutFiles: string[] = [];
  try {
    rolloutFiles = await findRecentRolloutFiles(codexHome, rolloutTouchLimit);
  } catch (error) {
    warnings.push(`Failed to list recent rollout files: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  const globalStatePath = path.join(codexHome, ".codex-global-state.json");
  const nudgeTargets = [globalStatePath, ...rolloutFiles];

  if (strategyNeedsNudge(strategy)) {
    const touched = await touchFiles(nudgeTargets);
    touchedFiles.push(...touched);
    if (touched.length === 0) {
      warnings.push("No nudge target could be touched");
    }
  }

  const activeRunDetected = await detectActiveRun(rolloutFiles);
  let restartedPids: number[] = [];
  let skippedRestartReason: string | null = null;
  let appRelaunchTriggered = false;
  let appForceQuitUsed = false;

  if (strategyNeedsRestart(strategy)) {
    if (!ENABLE_DESKTOP_APP_SERVER_RESTART) {
      skippedRestartReason = "restart_disabled_by_policy";
    } else if (activeRunDetected && !allowDuringActiveRuns) {
      skippedRestartReason = "active_run_detected";
    } else if (pids.length === 0) {
      skippedRestartReason = "codex_desktop_app_server_not_found";
    } else {
      const restartResult = await restartDesktopAppServers(pids);
      restartedPids = restartResult.restarted;
      warnings.push(...restartResult.warnings);
    }
  }

  if (relaunchApp) {
    const relaunch = await relaunchDesktopApp(forceQuitApp);
    appRelaunchTriggered = relaunch.triggered;
    appForceQuitUsed = relaunch.forcedQuit;
    warnings.push(...relaunch.warnings);
  }

  return {
    ok: true,
    strategy,
    codexDesktopAppServerPids: pids,
    activeRunDetected,
    restartedPids,
    touchedFiles,
    skippedRestartReason,
    appRelaunchTriggered,
    appForceQuitUsed,
    warnings,
  };
}
