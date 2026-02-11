import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

type FileChangeItem = {
  type: "fileChange";
  id: string;
  status: string;
  changes: Array<{ path: string; kind: string; diff: string }>;
};

type TurnDiffItem = {
  type: "turnDiff";
  id: string;
  turnId: string;
  diff: string;
};

type StoredTurn = {
  fileChanges: Record<string, FileChangeItem>;
  turnDiff?: TurnDiffItem;
};

type StoreData = {
  threads: Record<string, Record<string, StoredTurn>>;
};

const STORE_FILENAME = "pocketdex-filechanges.json";

function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function resolveStorePath(): string {
  return path.join(resolveCodexHome(), STORE_FILENAME);
}

let store: StoreData = { threads: {} };
let saveTimer: NodeJS.Timeout | null = null;

async function loadStore(): Promise<void> {
  try {
    const raw = await fs.readFile(resolveStorePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.threads) {
      store = parsed as StoreData;
    }
  } catch {
    // ignore
  }
}

async function saveStore(): Promise<void> {
  try {
    await fs.mkdir(resolveCodexHome(), { recursive: true });
    await fs.writeFile(resolveStorePath(), JSON.stringify(store));
  } catch {
    // ignore
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveStore();
  }, 750);
}

function ensureTurn(threadId: string, turnId: string): StoredTurn {
  if (!store.threads[threadId]) store.threads[threadId] = {};
  if (!store.threads[threadId][turnId]) {
    store.threads[threadId][turnId] = { fileChanges: {} };
  }
  return store.threads[threadId][turnId];
}

export async function initFileChangeStore(): Promise<void> {
  await loadStore();
}

export function recordFileChange(threadId: string, turnId: string, item: FileChangeItem): void {
  if (!threadId || !turnId || !item?.id) return;
  const turn = ensureTurn(threadId, turnId);
  turn.fileChanges[item.id] = item;
  scheduleSave();
}

export function recordTurnDiff(threadId: string, turnId: string, diff: string): void {
  if (!threadId || !turnId || !diff) return;
  const turn = ensureTurn(threadId, turnId);
  turn.turnDiff = { type: "turnDiff", id: `turn-diff-${turnId}`, turnId, diff };
  scheduleSave();
}

export function getThreadExtras(threadId: string): Record<string, StoredTurn> {
  return store.threads[threadId] ?? {};
}
