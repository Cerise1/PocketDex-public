import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ModelSelection = {
  model: string | null;
  effort: string | null;
};

export type CodexAccessMode = "full-access" | "workspace-write";

export type CodexPreferences = {
  accessMode: CodexAccessMode;
  internetAccess: boolean;
};

export type UiState = {
  collapsedProjects: Record<string, boolean>;
  expandedProjects: Record<string, boolean>;
  pinnedThreadIds: string[];
  projectOrder: string[];
  modelSelection: ModelSelection | null;
  verboseMode: boolean;
  codexPreferences: CodexPreferences;
};

const STORE_FILENAME = "pocketdex-ui-state.json";

const DEFAULT_UI_STATE: UiState = {
  collapsedProjects: {},
  expandedProjects: {},
  pinnedThreadIds: [],
  projectOrder: [],
  modelSelection: null,
  verboseMode: false,
  codexPreferences: {
    accessMode: "full-access",
    internetAccess: true,
  },
};

function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function resolveStorePath(): string {
  return path.join(resolveCodexHome(), STORE_FILENAME);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (typeof key !== "string" || !key.trim()) continue;
    if (typeof entry !== "boolean") continue;
    result[key] = entry;
  }
  return result;
}

function normalizePinnedThreadIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const threadId = normalizeText(entry);
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    result.push(threadId);
  }
  return result;
}

function normalizeProjectOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const projectId = normalizeText(entry);
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    result.push(projectId);
  }
  return result;
}

function normalizeModelSelection(value: unknown): ModelSelection | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const model = normalizeText(source.model);
  if (!model) return null;
  const effort = normalizeText(source.effort);
  return { model, effort };
}

function normalizeVerboseMode(value: unknown): boolean {
  return value === true;
}

function normalizeAccessMode(value: unknown): CodexAccessMode {
  if (typeof value !== "string") return "full-access";
  const trimmed = value.trim();
  if (trimmed === "workspace-write") return "workspace-write";
  if (trimmed === "full-access") return "full-access";
  return "full-access";
}

function normalizeCodexPreferences(value: unknown): CodexPreferences {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_UI_STATE.codexPreferences };
  }
  const source = value as Record<string, unknown>;
  return {
    accessMode: normalizeAccessMode(source.accessMode),
    internetAccess: source.internetAccess !== false,
  };
}

function cloneUiState(input: UiState): UiState {
  return {
    collapsedProjects: { ...input.collapsedProjects },
    expandedProjects: { ...input.expandedProjects },
    pinnedThreadIds: [...input.pinnedThreadIds],
    projectOrder: [...input.projectOrder],
    modelSelection: input.modelSelection ? { ...input.modelSelection } : null,
    verboseMode: input.verboseMode === true,
    codexPreferences: { ...input.codexPreferences },
  };
}

function normalizeUiState(value: unknown): UiState {
  if (!value || typeof value !== "object") return cloneUiState(DEFAULT_UI_STATE);
  const source = value as Record<string, unknown>;
  return {
    collapsedProjects: normalizeBooleanRecord(source.collapsedProjects),
    expandedProjects: normalizeBooleanRecord(source.expandedProjects),
    pinnedThreadIds: normalizePinnedThreadIds(source.pinnedThreadIds),
    projectOrder: normalizeProjectOrder(source.projectOrder),
    modelSelection: normalizeModelSelection(source.modelSelection),
    verboseMode: normalizeVerboseMode(source.verboseMode),
    codexPreferences: normalizeCodexPreferences(source.codexPreferences),
  };
}

let store: UiState = cloneUiState(DEFAULT_UI_STATE);
let persistedStoreFound = false;
let initPromise: Promise<void> | null = null;

async function loadStore(): Promise<void> {
  try {
    const raw = await fs.readFile(resolveStorePath(), "utf8");
    store = normalizeUiState(JSON.parse(raw));
    persistedStoreFound = true;
  } catch {
    store = cloneUiState(DEFAULT_UI_STATE);
    persistedStoreFound = false;
  }
}

async function saveStore(): Promise<void> {
  try {
    await fs.mkdir(resolveCodexHome(), { recursive: true });
    await fs.writeFile(resolveStorePath(), JSON.stringify(store));
    persistedStoreFound = true;
  } catch {
    // ignore
  }
}

export async function initUiStateStore(): Promise<void> {
  if (!initPromise) {
    initPromise = loadStore();
  }
  await initPromise;
}

export function hasPersistedUiState(): boolean {
  return persistedStoreFound;
}

export function getUiState(): UiState {
  return cloneUiState(store);
}

export function updateUiState(patch: unknown): UiState {
  if (!patch || typeof patch !== "object") return getUiState();
  const source = patch as Record<string, unknown>;
  let didUpdate = false;

  if (Object.prototype.hasOwnProperty.call(source, "collapsedProjects")) {
    store.collapsedProjects = normalizeBooleanRecord(source.collapsedProjects);
    didUpdate = true;
  }

  if (Object.prototype.hasOwnProperty.call(source, "expandedProjects")) {
    store.expandedProjects = normalizeBooleanRecord(source.expandedProjects);
    didUpdate = true;
  }

  if (Object.prototype.hasOwnProperty.call(source, "pinnedThreadIds")) {
    store.pinnedThreadIds = normalizePinnedThreadIds(source.pinnedThreadIds);
    didUpdate = true;
  }

  if (Object.prototype.hasOwnProperty.call(source, "projectOrder")) {
    store.projectOrder = normalizeProjectOrder(source.projectOrder);
    didUpdate = true;
  }

  if (Object.prototype.hasOwnProperty.call(source, "modelSelection")) {
    store.modelSelection = normalizeModelSelection(source.modelSelection);
    didUpdate = true;
  }

  if (Object.prototype.hasOwnProperty.call(source, "verboseMode")) {
    store.verboseMode = normalizeVerboseMode(source.verboseMode);
    didUpdate = true;
  }

  if (Object.prototype.hasOwnProperty.call(source, "codexPreferences")) {
    store.codexPreferences = normalizeCodexPreferences(source.codexPreferences);
    didUpdate = true;
  }

  if (didUpdate) {
    persistedStoreFound = true;
    void saveStore();
  }
  return getUiState();
}
