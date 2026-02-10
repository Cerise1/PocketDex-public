"use client";

import { Children, isValidElement, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Archive,
  ChevronRight,
  FolderOpen,
  ListCollapse,
  Loader2,
  MoreHorizontal,
  Pin,
  Plus,
  RotateCw,
  Settings2,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { projectRunningTurnsForUi, turnIdsReferToSameTurn } from "./interruptState";

type ThreadSource = string | { subAgent: unknown };

type Thread = {
  id: string;
  title?: string | null;
  preview: string;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: ThreadSource;
  externalRun?: {
    active?: boolean;
    source?: string;
    lastEventAt?: string | null;
    owner?: "local" | "external" | "none" | string;
    turnId?: string | null;
  } | null;
  gitInfo: { sha: string | null; branch: string | null; originUrl: string | null } | null;
  turns: Turn[];
};

type Turn = {
  id: string;
  status: string;
  error: unknown | null;
  items: ThreadItem[];
  startedAt?: number | string | null;
  started_at?: number | string | null;
  completedAt?: number | string | null;
  completed_at?: number | string | null;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
};

type UserInput =
  | { type: "text"; text: string; text_elements: Array<{ start: number; end: number; kind: string }> }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

type ThreadItem =
  | { type: "userMessage"; id: string; content: UserInput[] }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | { type: "turnDiff"; id: string; turnId: string; diff: string; files: Array<{ path: string; added: number; removed: number }> }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: string;
      commandActions?: CommandAction[];
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | { type: "fileChange"; id: string; status: string; changes: Array<{ path: string; kind: string; diff: string }> }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: string;
      arguments: unknown;
      result: unknown | null;
      error: unknown | null;
      durationMs: number | null;
    }
  | {
      type: "collabAgentToolCall";
      id: string;
      tool: string;
      status: string;
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt: string | null;
      agentsStates: Record<string, unknown>;
    }
  | { type: "webSearch"; id: string; query: string }
  | { type: "imageView"; id: string; path: string }
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "contextCompaction"; id: string }
  | { type: "unknown"; id: string; raw: any };

type TimelineItem = ThreadItem & {
  _meta?: {
    status?: "started" | "completed";
    turnId?: string;
    final?: boolean;
    workedMs?: number;
  };
};

type TimelineMetaStatus = NonNullable<TimelineItem["_meta"]>["status"];

type ModelInfo = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
};

type ModelOption = {
  label: string;
  value: string;
};

type ReasoningOption = {
  label: string;
  value: string;
};

type PendingRequest = {
  id: number;
  method: string;
  params: any;
};

type OutgoingAttachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: "image" | "file";
  dataBase64?: string;
  file?: File;
};

type ComposerAttachment = OutgoingAttachment & {
  previewUrl: string | null;
};

type QueuedSend = {
  id: string;
  text: string;
  modelValue: string;
  attachments: OutgoingAttachment[];
  createdAt: number;
  threadId: string | null;
  optimisticMessageId: string | null;
};

type QueuedSendSnapshot = {
  id: string;
  preview: string;
  detail: string | null;
};

type QueuedComposerDraft = Pick<QueuedSend, "text" | "modelValue" | "attachments">;

type PendingThreadHydration = {
  thread: Thread;
  expiresAtMs: number;
};

type PersistedModelSelection = {
  model: string | null;
  effort: string | null;
};

type CodexAccessMode = "full-access" | "workspace-write";

type PersistedCodexPreferences = {
  accessMode: CodexAccessMode;
  internetAccess: boolean;
};

type PersistedUiState = {
  collapsedProjects: Record<string, boolean>;
  expandedProjects: Record<string, boolean>;
  pinnedThreadIds: string[];
  projectOrder: string[];
  modelSelection: PersistedModelSelection | null;
  verboseMode: boolean;
  codexPreferences: PersistedCodexPreferences;
};

type ProjectDropPlacement = "before" | "after";

type ProjectDropTarget = {
  id: string;
  placement: ProjectDropPlacement;
};

const apiBaseFromEnv = process.env.NEXT_PUBLIC_API_BASE_URL || "";
const SYNC_SPINNER_DURATION_SECONDS = 2.4;
const SYNC_SPINNER_STYLE: CSSProperties = {
  animationDuration: `${SYNC_SPINNER_DURATION_SECONDS}s`,
};
const DEFAULT_CODEX_PREFERENCES: PersistedCodexPreferences = {
  accessMode: "full-access",
  internetAccess: true,
};

function formatShortTimeFromSeconds(value?: number): string {
  if (!value) return "";
  const date = new Date(value * 1000);
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
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

function normalizeWorkedMs(startedAtMs: number | null, completedAtMs: number | null): number | null {
  if (!startedAtMs || !completedAtMs) return null;
  const duration = completedAtMs - startedAtMs;
  if (!Number.isFinite(duration) || duration < 1000) return null;
  if (duration > 12 * 60 * 60 * 1000) return null;
  return duration;
}

function getTurnWorkedMs(turn: Turn): number | null {
  const startedAtMs = toEpochMs(turn.startedAt ?? turn.started_at ?? turn.createdAt);
  const completedAtMs = toEpochMs(turn.completedAt ?? turn.completed_at ?? turn.updatedAt);
  return normalizeWorkedMs(startedAtMs, completedAtMs);
}

function formatWorkedDuration(workedMs?: number | null): string {
  if (!workedMs || !Number.isFinite(workedMs) || workedMs < 1000) return "";
  const totalSeconds = Math.round(workedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.replace(/\/+$/, "") || normalized;
}

function projectGroupInfo(thread: Thread): { id: string; label: string; cwd: string | null } {
  if (thread.cwd) {
    return projectGroupInfoFromCwd(thread.cwd);
  }
  if (thread.path) {
    const normalized = normalizePath(thread.path);
    return { id: normalized || "(unknown)", label: basename(normalized), cwd: null };
  }
  return { id: "(unknown)", label: "(unknown)", cwd: null };
}

function projectGroupInfoFromCwd(cwd: string): { id: string; label: string; cwd: string | null } {
  const normalized = normalizePath(cwd);
  return { id: normalized || "(unknown)", label: basename(normalized), cwd };
}

function mergeWorkspaceRoots(roots: unknown, threads: Thread[]): string[] {
  const values = new Set<string>();
  if (Array.isArray(roots)) {
    for (const root of roots) {
      if (typeof root !== "string") continue;
      const trimmed = root.trim();
      if (!trimmed) continue;
      values.add(normalizePath(trimmed));
    }
  }
  for (const thread of threads) {
    if (!thread.cwd) continue;
    const trimmed = thread.cwd.trim();
    if (!trimmed) continue;
    values.add(normalizePath(trimmed));
  }
  return Array.from(values).sort((left, right) => left.localeCompare(right));
}

function projectLabelFromThread(thread: Thread | null): string {
  if (!thread) return "Project";
  const info = projectGroupInfo(thread);
  return info.label === "(unknown)" ? "Project" : info.label;
}

function threadTitle(thread: Thread): string {
  const title = (thread.title || "").trim();
  if (title) return title;
  const fallback = buildFallbackThreadTitle(thread);
  if (fallback) return fallback;
  return "Untitled conversation";
}

function buildFallbackThreadTitle(thread: Thread): string {
  const preview = (thread.preview || "").trim();
  if (preview) return truncateTitle(preview, 80);
  if (!Array.isArray(thread.turns)) return "";
  for (const turn of thread.turns) {
    if (!Array.isArray(turn.items)) continue;
    for (const item of turn.items) {
      if (item.type !== "userMessage" || !Array.isArray(item.content)) continue;
      const text = item.content
        .map((entry) => {
          if (entry.type === "text") return entry.text;
          if (entry.type === "skill") return entry.name;
          if (entry.type === "mention") return entry.name;
          return "";
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) return truncateTitle(text, 80);
    }
  }
  return "";
}

function truncateTitle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const trimmed = value.slice(0, Math.max(0, maxLength - 3)).trimEnd();
  return `${trimmed}...`;
}

function stripShellWrapper(command: string): string {
  const trimmed = (command || "").trim();
  if (!trimmed) return "";
  const patterns = [
    /^(?:\/bin\/)?zsh\s+-lc\s+/i,
    /^(?:\/bin\/)?bash\s+-lc\s+/i,
    /^sh\s+-lc\s+/i,
    /^(?:\/usr\/bin\/)?env\s+zsh\s+-lc\s+/i,
    /^(?:\/usr\/bin\/)?env\s+bash\s+-lc\s+/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(trimmed)) {
      return trimmed.replace(pattern, "").trim();
    }
  }
  return trimmed;
}

function normalizeCommandValue(command: unknown): string {
  if (typeof command === "string") {
    const raw = command.trim();
    if (!raw) return "";
    if (raw.startsWith("[") && raw.endsWith("]")) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
          const argv = parsed as string[];
          const lcIndex = argv.findIndex((entry) => entry === "-lc" || entry === "-c");
          if (lcIndex >= 0 && lcIndex < argv.length - 1) {
            return stripShellWrapper(argv[lcIndex + 1]);
          }
          return stripShellWrapper(argv.join(" "));
        }
      } catch {
        // fall through
      }
    }
    const unwrapped = stripShellWrapper(raw);
    const unquoted =
      (unwrapped.startsWith('"') && unwrapped.endsWith('"')) ||
      (unwrapped.startsWith("'") && unwrapped.endsWith("'"))
        ? unwrapped.slice(1, -1)
        : unwrapped;
    return unquoted.trim();
  }

  if (Array.isArray(command) && command.every((entry) => typeof entry === "string")) {
    const argv = command as string[];
    const lcIndex = argv.findIndex((entry) => entry === "-lc" || entry === "-c");
    if (lcIndex >= 0 && lcIndex < argv.length - 1) {
      return stripShellWrapper(argv[lcIndex + 1]);
    }
    return stripShellWrapper(argv.join(" "));
  }

  return "";
}

function summarizeCommandTitle(command: unknown): string {
  const normalized = normalizeCommandValue(command);
  if (!normalized) return "Run command";
  const firstToken = normalized.split(/\s+/)[0] ?? "";
  const executable = firstToken.split("/").filter(Boolean).pop() ?? "";
  if (!executable || /[|;&><$`]/.test(executable)) return "Run command";
  return `Run ${executable}`;
}

type CommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path?: string | null }
  | { type: "search"; command: string; query?: string | null; path?: string | null }
  | { type: "unknown"; command: string };

function formatCommandActionSummary(actions?: CommandAction[] | null): string | null {
  if (!actions || actions.length === 0) return null;
  const action = actions[0];
  if (!action || typeof action !== "object") return null;
  let summary: string | null = null;
  if (action.type === "read") {
    summary = `Read ${shortenPath(action.path)}`;
  } else if (action.type === "listFiles") {
    summary = action.path ? `List files ${shortenPath(action.path)}` : "List files";
  } else if (action.type === "search") {
    const query = action.query ? truncateTitle(action.query, 48) : "";
    const path = action.path ? ` in ${shortenPath(action.path)}` : "";
    summary = query ? `Search “${query}”${path}` : `Search${path}`;
  } else if (action.type === "unknown") {
    summary = summarizeCommandTitle(action.command);
  }
  if (!summary) return null;
  if (actions.length > 1) {
    return `${summary} +${actions.length - 1}`;
  }
  return summary;
}

function normalizeItemStatusValue(status: unknown): string | null {
  if (typeof status !== "string") return null;
  const normalized = status.trim().toLowerCase();
  return normalized || null;
}

function isInProgressItemStatus(status: string | null): boolean {
  if (!status) return false;
  return ["started", "running", "pending", "queued", "inprogress", "in_progress"].includes(status);
}

function resolveDisplayStatus(itemStatus: unknown, metaStatus?: TimelineMetaStatus): string {
  const normalizedItem = normalizeItemStatusValue(itemStatus);
  const normalizedMeta = normalizeItemStatusValue(metaStatus ?? null);
  if (!normalizedItem) return normalizedMeta ?? "";
  if (!normalizedMeta) return normalizedItem;
  // Prefer terminal status from meta when item still reports a transient status.
  if (!isInProgressItemStatus(normalizedMeta)) {
    return isInProgressItemStatus(normalizedItem) ? normalizedMeta : normalizedItem;
  }
  return normalizedItem;
}

function shortenPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-3).join("/") || value;
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

function buildLocalImageAttachmentUrl(apiBase: string, localPath?: string): string | null {
  const pathValue = typeof localPath === "string" ? localPath.trim() : "";
  const baseValue = typeof apiBase === "string" ? apiBase.trim() : "";
  if (!pathValue || !baseValue) return null;
  return `${baseValue.replace(/\/+$/, "")}/api/local-images?path=${encodeURIComponent(pathValue)}`;
}

type ParsedFileReference = {
  path: string;
  line: number;
  column: number | null;
};

const FILE_REFERENCE_SCHEME = "pocketdex-file-ref:";
const FILE_REFERENCE_CANDIDATE_RE =
  /[A-Za-z0-9_./\\:-]+\.[A-Za-z][A-Za-z0-9]*(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)/g;
const FILE_REFERENCE_LABEL_RE = /^[^/\s]+\.[A-Za-z0-9]{1,16}\s+\(line\s+\d+(?::\d+)?\)$/i;

function isLikelyFilePath(value: string): boolean {
  const path = value.trim().replace(/[),.;]+$/, "");
  if (!path) return false;
  if (path.includes("://")) return false;
  const fileName = basename(path);
  return /\.[A-Za-z][A-Za-z0-9]{0,15}$/.test(fileName);
}

function parseFileReference(value: string): ParsedFileReference | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\n")) return null;
  if (trimmed.includes("://")) return null;

  const parseParts = (pathPart: string, linePart: string, columnPart?: string): ParsedFileReference | null => {
    const path = pathPart.trim().replace(/[),.;]+$/, "");
    const line = Number.parseInt(linePart, 10);
    const column = columnPart ? Number.parseInt(columnPart, 10) : null;
    if (!Number.isFinite(line) || line <= 0) return null;
    if (column !== null && (!Number.isFinite(column) || column <= 0)) return null;
    if (!isLikelyFilePath(path)) return null;
    return { path, line, column };
  };

  const hashMatch = trimmed.match(/^(.*)#L(\d+)(?:C(\d+))?$/i);
  if (hashMatch) {
    return parseParts(hashMatch[1] ?? "", hashMatch[2] ?? "", hashMatch[3]);
  }

  const colonMatch = trimmed.match(/^(.*):(\d+)(?::(\d+))?$/);
  if (colonMatch) {
    return parseParts(colonMatch[1] ?? "", colonMatch[2] ?? "", colonMatch[3]);
  }

  return null;
}

function formatFileReferenceLabel(reference: ParsedFileReference): string {
  if (reference.column) {
    return `${basename(reference.path)} (line ${reference.line}:${reference.column})`;
  }
  return `${basename(reference.path)} (line ${reference.line})`;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractTextContent(node: React.ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: React.ReactNode }>(child)) {
        return extractTextContent(child.props.children ?? null);
      }
      return "";
    })
    .join("");
}

function markdownUrlTransform(url: string): string {
  if (url.startsWith(FILE_REFERENCE_SCHEME)) return url;
  return defaultUrlTransform(url);
}

function linkifyBareFileReferences(text: string): string {
  if (!text) return text;
  const fencedSegments = text.split(/(```[\s\S]*?```)/g);
  return fencedSegments
    .map((segment) => {
      if (segment.startsWith("```")) return segment;
      const inlineSegments = segment.split(/(`[^`\n]+`)/g);
      return inlineSegments
        .map((part) => {
          if (part.startsWith("`") && part.endsWith("`")) return part;
          return part.replace(FILE_REFERENCE_CANDIDATE_RE, (match) => {
            const reference = parseFileReference(match);
            if (!reference) return match;
            const label = formatFileReferenceLabel(reference);
            const href = `${FILE_REFERENCE_SCHEME}${encodeURIComponent(match)}`;
            return `[${label}](${href})`;
          });
        })
        .join("");
    })
    .join("");
}

const markdownComponentsWithFileReferences = {
  code({ inline, className, children, ...props }: any) {
    const raw = String(children ?? "").replace(/\n$/, "");
    const trimmed = raw.trim();
    const reference = parseFileReference(trimmed);
    if (reference) {
      return <span className="font-medium text-sky-300">{formatFileReferenceLabel(reference)}</span>;
    }
    const hasLanguageClass = typeof className === "string" && className.includes("language-");
    const isLikelyInline = inline ?? (!hasLanguageClass && !raw.includes("\n"));
    if (isLikelyInline) {
      const normalized = raw
        .trim()
        .replace(/^`+/, "")
        .replace(/`+$/, "")
        .replace(/^'+/, "")
        .replace(/'+$/, "");
      const inlineText = normalized || raw.trim();
      return (
        <span className="inline-flex items-center rounded bg-[rgba(27,33,41,0.78)] px-1.5 py-[1px] font-mono text-[0.88em] leading-none text-white/95">
          {inlineText}
        </span>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  a({ href, children, ...props }: any) {
    if (typeof href === "string" && href.startsWith(FILE_REFERENCE_SCHEME)) {
      const rawReference = safeDecodeURIComponent(href.slice(FILE_REFERENCE_SCHEME.length));
      const reference = parseFileReference(rawReference);
      const label = reference ? formatFileReferenceLabel(reference) : String(children ?? "");
      return <span className="font-medium text-sky-300">{label}</span>;
    }
    if (typeof href === "string") {
      const hrefReference = parseFileReference(safeDecodeURIComponent(href));
      if (hrefReference) {
        return <span className="font-medium text-sky-300">{formatFileReferenceLabel(hrefReference)}</span>;
      }
    }
    const childText = extractTextContent(children).trim();
    if (FILE_REFERENCE_LABEL_RE.test(childText)) {
      return <span className="font-medium text-sky-300">{childText}</span>;
    }
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  },
};

function formatModelName(name: string): string {
  return name
    .split("-")
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "codex") return "Codex";
      if (/^[0-9.]+$/.test(part)) return part;
      if (part.length <= 3) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("-");
}

function formatReasoningLabel(effort: string): string {
  const lower = effort.toLowerCase();
  if (lower === "xhigh") return "Extra High";
  if (lower === "high") return "High";
  if (lower === "medium") return "Medium";
  if (lower === "low") return "Low";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function sanitizeReasoningHeadline(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (!firstLine) return "";
  return firstLine.replace(/^(?:reasoning|risoning)\b[:\-\s]*/i, "").trim();
}

function buildModelPickerData(models: ModelInfo[]): {
  modelOptions: ModelOption[];
  effortOptionsByModel: Record<string, ReasoningOption[]>;
  defaultEffortByModel: Record<string, string | null>;
} {
  const modelOptions: ModelOption[] = [];
  const effortOptionsByModel: Record<string, ReasoningOption[]> = {};
  const defaultEffortByModel: Record<string, string | null> = {};
  const seen = new Set<string>();

  for (const model of models) {
    if (!seen.has(model.model)) {
      modelOptions.push({ value: model.model, label: formatModelName(model.displayName || model.model) });
      seen.add(model.model);
    }

    const existing = effortOptionsByModel[model.model] ?? [];
    const effortSeen = new Set(existing.map((option) => option.value));
    for (const level of model.supportedReasoningEfforts ?? []) {
      if (effortSeen.has(level.reasoningEffort)) continue;
      existing.push({
        value: level.reasoningEffort,
        label: formatReasoningLabel(level.reasoningEffort),
      });
      effortSeen.add(level.reasoningEffort);
    }
    effortOptionsByModel[model.model] = existing;

    if (!(model.model in defaultEffortByModel)) {
      defaultEffortByModel[model.model] = model.defaultReasoningEffort || null;
    }
  }

  return { modelOptions, effortOptionsByModel, defaultEffortByModel };
}

type ThreadRowProps = {
  thread: Thread;
  selected: boolean;
  pinned: boolean;
  active: boolean;
  unreadCompleted: boolean;
  archiving: boolean;
  isMobileViewport: boolean;
  previewActive: boolean;
  onSelect: () => void;
  onTogglePin: (threadId: string) => void;
  onArchive: (thread: Thread) => void;
};

const ThreadRow = memo(function ThreadRow({
  thread,
  selected,
  pinned,
  active,
  unreadCompleted,
  archiving,
  isMobileViewport,
  previewActive,
  onSelect,
  onTogglePin,
  onArchive,
}: ThreadRowProps) {
  const timestamp = formatShortTimeFromSeconds(thread.updatedAt || thread.createdAt);
  const mobileActionsVisible = isMobileViewport && previewActive;
  return (
    <div
      className={`group flex cursor-pointer items-center gap-1.5 rounded-lg border px-1.5 py-1.5 text-[14px] leading-tight transition md:gap-1 md:px-[0.375rem] md:py-1 md:text-[15px] ${
        selected
          ? "border-sky-300/40 bg-sky-200/10"
          : mobileActionsVisible
            ? "border-white/20 bg-white/5"
            : "border-transparent md:hover:border-white/10 md:hover:bg-white/5"
      }`}
      onClick={onSelect}
    >
      <div className="-ml-1 relative flex h-4 w-4 items-center justify-center">
        {active ? (
          <>
            <span
              className={`pointer-events-none flex h-4 w-4 items-center justify-center text-white/55 transition-opacity ${
                mobileActionsVisible ? "opacity-0" : "md:group-hover:opacity-0"
              }`}
              title="In progress"
              aria-label="In progress"
            >
              <Loader2 className="h-3 w-3 animate-spin" style={SYNC_SPINNER_STYLE} strokeWidth={2.1} />
            </span>
            <button
              type="button"
              aria-label={pinned ? "Unpin thread" : "Pin thread"}
              aria-pressed={pinned}
              className={`absolute inset-0 z-10 flex h-4 w-4 items-center justify-center rounded-full transition ${
                pinned
                  ? "text-amber-200"
                  : "text-white/35"
              } ${
                mobileActionsVisible
                  ? "pointer-events-auto opacity-100"
                  : "pointer-events-none opacity-0 md:pointer-events-auto md:group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
              }`}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin(thread.id);
              }}
            >
              <Pin className="h-3 w-3" strokeWidth={1.8} />
            </button>
          </>
        ) : unreadCompleted ? (
          <>
            <span
              className={`pointer-events-none flex h-2 w-2 rounded-full bg-sky-300/90 transition-opacity ${
                mobileActionsVisible ? "opacity-0" : "md:group-hover:opacity-0"
              }`}
              title="Completed (unread)"
              aria-label="Completed (unread)"
            />
            <button
              type="button"
              aria-label={pinned ? "Unpin thread" : "Pin thread"}
              aria-pressed={pinned}
              className={`absolute inset-0 z-10 flex h-4 w-4 items-center justify-center rounded-full transition ${
                pinned
                  ? "text-amber-200"
                  : "text-white/35"
              } ${
                mobileActionsVisible
                  ? "pointer-events-auto opacity-100"
                  : "pointer-events-none opacity-0 md:pointer-events-auto md:group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
              }`}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin(thread.id);
              }}
            >
              <Pin className="h-3 w-3" strokeWidth={1.8} />
            </button>
          </>
        ) : (
          <button
            type="button"
            aria-label={pinned ? "Unpin thread" : "Pin thread"}
            aria-pressed={pinned}
            className={`flex h-4 w-4 items-center justify-center rounded-full transition ${
              pinned ? "text-amber-200" : "text-white/35"
            } ${
              mobileActionsVisible
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0 md:pointer-events-auto md:group-hover:opacity-80 focus-visible:pointer-events-auto focus-visible:opacity-80"
            }`}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin(thread.id);
            }}
          >
            <Pin className="h-3 w-3" strokeWidth={1.8} />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-1.5">
          <div className="min-w-0 truncate font-semibold text-white/90" title={threadTitle(thread)}>
            {threadTitle(thread)}
          </div>
          <div className="relative flex min-w-[34px] items-center justify-end text-[12px] tracking-wide text-white/45 md:min-w-[36px] md:text-[13px]">
            <span
              className={`tabular-nums transition-opacity ${
                archiving || mobileActionsVisible
                  ? "pointer-events-none opacity-0"
                  : "md:group-hover:pointer-events-none md:group-hover:opacity-0"
              }`}
              suppressHydrationWarning
            >
              {timestamp}
            </span>
            <button
              type="button"
              aria-label={archiving ? "Archiving thread" : "Archive thread"}
              disabled={archiving}
              className={`absolute right-0 flex h-5 w-5 items-center justify-center rounded-md text-white/65 transition ${
                archiving
                  ? "cursor-wait opacity-100"
                  : mobileActionsVisible
                    ? "pointer-events-auto opacity-100 hover:bg-white/10 hover:text-white"
                    : "pointer-events-none opacity-0 hover:bg-white/10 hover:text-white md:group-hover:pointer-events-auto md:group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
              }`}
              onClick={(event) => {
                event.stopPropagation();
                onArchive(thread);
              }}
            >
              {archiving ? (
                <Loader2 className="h-3 w-3 animate-spin" style={SYNC_SPINNER_STYLE} strokeWidth={2} />
              ) : (
                <Archive className="h-3 w-3" strokeWidth={2} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

function flattenThreadItems(thread: Thread | null): TimelineItem[] {
  if (!thread) return [];
  const items: TimelineItem[] = [];
  const turns = thread.turns ?? [];
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    const isLatestTurn = turnIndex === turns.length - 1;
    // Keep historical "Final response" markers, but avoid marking the latest turn
    // as final from snapshots because external surfaces can report stale `completed`.
    const canMarkFinal = isTurnTerminalStatus(turn) && !isLatestTurn;
    const turnItems: TimelineItem[] = [];
    let lastAgentIndex = -1;
    for (const item of turn.items ?? []) {
      const normalized = normalizeThreadItem(item);
      turnItems.push({ ...normalized, _meta: { status: "completed", turnId: turn.id } });
      if (normalized.type === "agentMessage") lastAgentIndex = turnItems.length - 1;
    }
    if (canMarkFinal && lastAgentIndex >= 0) {
      const workedMs = getTurnWorkedMs(turn);
      const current = turnItems[lastAgentIndex];
      turnItems[lastAgentIndex] = {
        ...current,
        _meta: { ...current._meta, final: true, ...(workedMs ? { workedMs } : {}) },
      };
    }
    items.push(...turnItems);
  }
  return items;
}

function buildThreadSnapshotSignature(thread: Thread | null): string {
  if (!thread || !Array.isArray(thread.turns) || thread.turns.length === 0) return "0";
  return thread.turns
    .map((turn) => {
      const status = String(turn?.status ?? "").trim().toLowerCase();
      const itemCount = Array.isArray(turn?.items) ? turn.items.length : 0;
      return `${String(turn?.id ?? "")}:${status}:${itemCount}`;
    })
    .join("|");
}

function countThreadUserMessages(thread: Thread | null): number {
  if (!thread || !Array.isArray(thread.turns) || thread.turns.length === 0) return 0;
  let count = 0;
  for (const turn of thread.turns) {
    if (!turn || !Array.isArray(turn.items)) continue;
    for (const item of turn.items) {
      if (item?.type === "userMessage") {
        count += 1;
      }
    }
  }
  return count;
}

function normalizeThreadItem(item: any): ThreadItem {
  if (!item || typeof item !== "object") {
    return { type: "unknown", id: crypto.randomUUID(), raw: item };
  }
  const type = String(item.type || "unknown");
  switch (type) {
    case "userMessage":
    case "agentMessage":
    case "plan":
      return item as ThreadItem;
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const content = Array.isArray(item.content) ? item.content : [];
      return { ...(item as any), summary, content } as ThreadItem;
    }
    case "turnDiff": {
      const diff = typeof item.diff === "string" ? item.diff : "";
      const files = Array.isArray((item as any).files)
        ? (item as any).files
        : parseUnifiedDiffFiles(diff);
      return { ...(item as any), diff, files } as ThreadItem;
    }
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "collabAgentToolCall":
    case "webSearch":
    case "imageView":
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "contextCompaction":
      return item as ThreadItem;
    default:
      return { type: "unknown", id: item.id ?? crypto.randomUUID(), raw: item };
  }
}

function isVerboseOnlyTimelineItem(item: Pick<TimelineItem, "type">): boolean {
  switch (item.type) {
    case "turnDiff":
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "collabAgentToolCall":
    case "webSearch":
    case "imageView":
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "unknown":
      return true;
    default:
      return false;
  }
}

function stripIdeContext(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const lower = normalized.toLowerCase();
  const marker = "my request for codex:";
  const header = "context from my ide setup";
  if (!lower.includes(header) && !lower.includes(marker)) return normalized;
  const index = lower.indexOf(marker);
  if (index < 0) return "";
  const after = normalized.slice(index + marker.length);
  return after.replace(/^\s+/, "");
}

function userInputToText(content: UserInput[]): {
  text: string;
  attachments: Array<{
    kind: "image" | "localImage" | "file";
    url?: string;
    label: string;
    path?: string;
  }>;
} {
  const parts: string[] = [];
  const attachments: Array<{
    kind: "image" | "localImage" | "file";
    url?: string;
    label: string;
    path?: string;
  }> = [];
  for (const item of content) {
    if (item.type === "text") {
      parts.push(item.text);
    } else if (item.type === "image") {
      attachments.push({ kind: "image", url: item.url, label: "image" });
    } else if (item.type === "localImage") {
      attachments.push({ kind: "localImage", label: item.path, path: item.path });
    } else if (item.type === "mention") {
      attachments.push({ kind: "file", label: item.name || item.path, path: item.path });
    }
  }
  const raw = parts.join("\n\n").trim();
  const cleaned = stripIdeContext(raw);
  return { text: cleaned, attachments };
}

function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (!line) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function parseUnifiedDiffFiles(diff: string): Array<{ path: string; added: number; removed: number }> {
  const entries: Array<{ path: string; added: number; removed: number }> = [];
  const lines = diff.split("\n");
  let current: { path: string; added: number; removed: number } | null = null;

  const pushCurrent = () => {
    if (!current) return;
    if (!current.path) return;
    entries.push(current);
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushCurrent();
      const match = line.match(/ b\/(.+)$/);
      const path = match?.[1] ?? line.replace(/^diff --git a\//, "").replace(/ b\/.+$/, "");
      current = { path, added: 0, removed: 0 };
      continue;
    }

    if (!current && line.startsWith("+++ b/")) {
      current = { path: line.slice(6).trim(), added: 0, removed: 0 };
      continue;
    }

    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) continue;

    if (line.startsWith("+")) {
      if (!line.startsWith("+++")) {
        if (current) current.added += 1;
      }
    } else if (line.startsWith("-")) {
      if (!line.startsWith("---")) {
        if (current) current.removed += 1;
      }
    }
  }

  pushCurrent();
  return entries;
}

function parseModelSelection(value: string): { model: string | null; effort: string | null } {
  if (!value) return { model: null, effort: null };
  const [model, effort] = value.split(":");
  return { model: model || null, effort: effort || null };
}

function parseBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!key.trim() || typeof entry !== "boolean") continue;
    result[key] = entry;
  }
  return result;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function normalizeProjectOrderForGroups(
  orderIds: string[],
  groups: Array<{ id: string }>,
): string[] {
  const visibleProjectIds = groups
    .map((group) => group.id)
    .filter((projectId) => projectId !== "(unknown)");
  const visibleIdSet = new Set(visibleProjectIds);
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const projectId of orderIds) {
    if (!visibleIdSet.has(projectId) || seen.has(projectId)) continue;
    seen.add(projectId);
    normalized.push(projectId);
  }

  for (const projectId of visibleProjectIds) {
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    normalized.push(projectId);
  }

  return normalized;
}

function applyProjectOrderToGroups<T extends { id: string }>(
  groups: T[],
  orderIds: string[],
): T[] {
  if (!groups.length) return groups;
  const reorderableGroups = groups.filter((group) => group.id !== "(unknown)");
  const unknownGroup = groups.find((group) => group.id === "(unknown)") ?? null;
  const normalizedOrder = normalizeProjectOrderForGroups(orderIds, reorderableGroups);
  const byId = new Map(reorderableGroups.map((group) => [group.id, group]));
  const ordered = normalizedOrder.map((projectId) => byId.get(projectId)).filter(Boolean) as T[];
  return unknownGroup ? [...ordered, unknownGroup] : ordered;
}

function reorderVisibleProjectIds(
  projectIds: string[],
  sourceId: string,
  targetId: string,
  placement: ProjectDropPlacement,
): string[] {
  const sourceIndex = projectIds.indexOf(sourceId);
  const targetIndex = projectIds.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) return projectIds;
  if (sourceIndex === targetIndex) return projectIds;

  const next = [...projectIds];
  const [movedId] = next.splice(sourceIndex, 1);
  if (!movedId) return projectIds;

  const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  const destinationIndex = placement === "before" ? adjustedTargetIndex : adjustedTargetIndex + 1;
  const boundedIndex = Math.max(0, Math.min(destinationIndex, next.length));
  next.splice(boundedIndex, 0, movedId);
  return next;
}

function parsePersistedModelSelection(value: unknown): PersistedModelSelection | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const model = typeof source.model === "string" ? source.model.trim() : "";
  if (!model) return null;
  const effort = typeof source.effort === "string" ? source.effort.trim() : "";
  return { model, effort: effort || null };
}

function parsePersistedCodexPreferences(value: unknown): PersistedCodexPreferences {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_CODEX_PREFERENCES };
  }
  const source = value as Record<string, unknown>;
  const rawAccessMode = typeof source.accessMode === "string" ? source.accessMode.trim() : "";
  const accessMode: CodexAccessMode = rawAccessMode === "workspace-write" ? "workspace-write" : "full-access";
  const internetAccess = source.internetAccess !== false;
  return {
    accessMode,
    internetAccess,
  };
}

function parsePersistedUiState(value: unknown): PersistedUiState {
  if (!value || typeof value !== "object") {
    return {
      collapsedProjects: {},
      expandedProjects: {},
      pinnedThreadIds: [],
      projectOrder: [],
      modelSelection: null,
      verboseMode: false,
      codexPreferences: { ...DEFAULT_CODEX_PREFERENCES },
    };
  }
  const source = value as Record<string, unknown>;
  return {
    collapsedProjects: parseBooleanRecord(source.collapsedProjects),
    expandedProjects: parseBooleanRecord(source.expandedProjects),
    pinnedThreadIds: parseStringArray(source.pinnedThreadIds),
    projectOrder: parseStringArray(source.projectOrder),
    modelSelection: parsePersistedModelSelection(source.modelSelection),
    verboseMode: source.verboseMode === true,
    codexPreferences: parsePersistedCodexPreferences(source.codexPreferences),
  };
}

function resolveThreadStartSecurityPreferences(
  preferences: PersistedCodexPreferences,
): { approvalPolicy: "never" | "on-request"; sandbox: "danger-full-access" | "workspace-write" } {
  const accessMode = preferences.accessMode;
  const internetAccess = preferences.internetAccess;
  if (accessMode === "full-access" && internetAccess) {
    return {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    };
  }
  return {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  };
}

function extractTurnId(params: any): string | null {
  if (!params || typeof params !== "object") return null;
  const direct = normalizeTurnId(params.turnId ?? params.turn_id);
  if (direct) return direct;
  const directTurn = normalizeTurnId(params.turn?.turnId ?? params.turn?.turn_id);
  if (directTurn) return directTurn;
  const itemTurnId = normalizeTurnId(
    params.item?.turnId ?? params.item?.turn_id ?? params.item?.turn?.id ?? params.item?.turn?.turnId ?? params.item?.turn?.turn_id,
  );
  if (itemTurnId) return itemTurnId;
  const msgTurnId = normalizeTurnId(params.msg?.turn_id ?? params.msg?.turnId);
  if (msgTurnId) return msgTurnId;
  const msgTurn = normalizeTurnId(params.msg?.turn?.id ?? params.msg?.turn?.turnId ?? params.msg?.turn?.turn_id);
  if (msgTurn) return msgTurn;
  const eventId = normalizeTurnId(params.id);
  if (eventId) return eventId;
  const nested = normalizeTurnId(params.turn?.id);
  if (nested) return nested;
  return null;
}

function extractThreadId(params: any): string | null {
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

function normalizeTurnStatus(status: unknown): string {
  return String(status ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]/g, "");
}

const ACTIVE_TURN_STATUSES = new Set(["inprogress", "running", "started", "pending", "active", "executing"]);
const TERMINAL_TURN_STATUSES = new Set(["completed", "interrupted", "failed", "aborted", "cancelled", "canceled", "stopped"]);

function isTurnRunningStatus(status: unknown): boolean {
  const value = normalizeTurnStatus(status);
  return ACTIVE_TURN_STATUSES.has(value);
}

function isTurnTerminalStatus(turn: Turn): boolean {
  const status = normalizeTurnStatus(turn.status);
  if (status) {
    return TERMINAL_TURN_STATUSES.has(status);
  }
  return Boolean(toEpochMs(turn.completedAt ?? turn.completed_at));
}

function isTurnStillActive(turn: Turn): boolean {
  const normalized = normalizeTurnStatus(turn.status);
  if (!normalized) return false;
  if (ACTIVE_TURN_STATUSES.has(normalized)) return true;
  if (TERMINAL_TURN_STATUSES.has(normalized)) return false;
  return false;
}

function isExternalRunActive(thread: any): boolean {
  return Boolean(thread?.externalRun?.active === true);
}

function normalizeExternalRunOwner(value: unknown): "local" | "external" | "none" {
  if (typeof value !== "string") return "none";
  const normalized = value.trim().toLowerCase();
  if (normalized === "local" || normalized === "external" || normalized === "none") {
    return normalized;
  }
  return "none";
}

function normalizeErrorToken(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isOutOfCreditErrorLike(input: { message?: unknown; code?: unknown }): boolean {
  const code = normalizeErrorToken(input.code);
  const message = normalizeErrorToken(input.message);
  if (!code && !message) return false;
  if (code.includes("insufficient_quota") || code.includes("out_of_credit")) return true;
  const haystack = `${code} ${message}`;
  return (
    haystack.includes("out of credit") ||
    haystack.includes("out-of-credit") ||
    haystack.includes("insufficient quota") ||
    haystack.includes("insufficient_quota") ||
    haystack.includes("exceeded your current quota") ||
    haystack.includes("billing hard limit") ||
    haystack.includes("quota exceeded") ||
    haystack.includes("usage limit reached")
  );
}

function formatOutOfCreditBannerMessage(rawMessage?: string | null): string {
  const fallback = "Out of Credit. Please add billing credits to continue.";
  const message = (rawMessage ?? "").trim();
  if (!message) return fallback;
  if (message.length <= 220) return message;
  return `${message.slice(0, 217).trimEnd()}...`;
}

function normalizeTurnId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "0") return null;
    return trimmed;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const normalized = String(value).trim();
    if (!normalized || normalized === "0") return null;
    return normalized;
  }
  return null;
}

function turnSetHas(target: ReadonlySet<string>, turnId: string | null): boolean {
  if (!turnId) return false;
  for (const existingTurnId of target) {
    if (turnIdsReferToSameTurn(existingTurnId, turnId)) return true;
  }
  return false;
}

function deleteTurnFromSet(target: Set<string>, turnId: string | null): boolean {
  if (!turnId) return false;
  let deleted = false;
  for (const existingTurnId of Array.from(target)) {
    if (!turnIdsReferToSameTurn(existingTurnId, turnId)) continue;
    target.delete(existingTurnId);
    deleted = true;
  }
  return deleted;
}

function addTurnToSet(target: Set<string>, turnId: string): void {
  deleteTurnFromSet(target, turnId);
  target.add(turnId);
}

function queueKeyFor(thread: Thread | null, draftCwd: string | null): string | null {
  if (thread?.id) return `thread:${thread.id}`;
  if (draftCwd) return `draft:${draftCwd}`;
  return null;
}

function describeQueuedSend(entry: QueuedSend | undefined): string | null {
  if (!entry) return null;
  const text = entry.text.replace(/\s+/g, " ").trim();
  if (text) return truncateTitle(text, 96);
  const attachmentCount = entry.attachments.length;
  if (attachmentCount <= 0) return null;
  return attachmentCount === 1 ? "1 attachment" : `${attachmentCount} attachments`;
}

function queueSnapshotFor(entry: QueuedSend): QueuedSendSnapshot {
  const stableId = typeof entry.id === "string" && entry.id.trim() ? entry.id : `queued-${entry.createdAt}`;
  const text = entry.text.replace(/\s+/g, " ").trim();
  const attachmentCount = entry.attachments.length;
  const attachmentLabel =
    attachmentCount <= 0 ? null : attachmentCount === 1 ? "1 attachment" : `${attachmentCount} attachments`;
  if (text) {
    return {
      id: stableId,
      preview: truncateTitle(text, 180),
      detail: attachmentLabel,
    };
  }
  return {
    id: stableId,
    preview: attachmentLabel ?? "Pending message",
    detail: null,
  };
}

function normalizeThreadForImmediateInsertion(thread: Thread, fallbackCwd: string | null): Thread {
  const normalizedFallbackCwd = typeof fallbackCwd === "string" ? fallbackCwd.trim() : "";
  const normalizedCwd = typeof thread.cwd === "string" ? thread.cwd.trim() : "";
  const cwd = normalizedCwd || normalizedFallbackCwd;
  const fallbackTimestamp = Math.floor(Date.now() / 1000);
  const updatedAt =
    typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt) && thread.updatedAt > 0
      ? thread.updatedAt
      : typeof thread.createdAt === "number" && Number.isFinite(thread.createdAt) && thread.createdAt > 0
        ? thread.createdAt
        : fallbackTimestamp;
  const createdAt =
    typeof thread.createdAt === "number" && Number.isFinite(thread.createdAt) && thread.createdAt > 0
      ? thread.createdAt
      : updatedAt;
  return {
    ...thread,
    cwd,
    createdAt,
    updatedAt,
    turns: Array.isArray(thread.turns) ? thread.turns : [],
  };
}

const PROJECT_THREAD_LIMIT = 8;
const EXTERNAL_WS_RECENT_MS = 2500;
const EXTERNAL_TRACKED_ACTIVE_STALE_MS = 10 * 60 * 1000;
const EXTERNAL_PROBE_MAX_PER_REFRESH = 8;
const EXTERNAL_ACTIVE_RECHECK_MS = 5000;
const EXTERNAL_ACTIVE_RECHECK_MAX = 4;
const EXTERNAL_RESUME_RETRY_MS = 1500;
const THREAD_REFRESH_INTERVAL_MS = 20000;
const PENDING_THREAD_HYDRATION_WINDOW_MS = 45_000;
const IDLE_CHECK_SOFT_TIMEOUT_MS = 1200;
const THINKING_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const THREAD_SEQ_STORAGE_KEY = "pocketdex.thread.seq.v1";
const CONNECTION_ATTEMPT_TIMEOUT_MS = 5000;
const RETRY_MIN_VISUAL_MS = 1500;
const PROJECT_DISCOVERY_MIN_VISUAL_MS = 1200;
const PROJECT_DISCOVERY_TIMEOUT_MS = 3000;
const UI_ERROR_BANNER_VISIBLE_MS = 5000;
const MOBILE_TIMELINE_BOTTOM_CLEARANCE_PX = 64;
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 8;
const COMMON_DEV_SERVER_PORTS = ["3000", "3001", "3002", "5173", "8080"] as const;
const INTERRUPT_SINGLE_SHOT_STORAGE_KEY = "pocketdex.interrupt.singleShot";
const INTERRUPT_SINGLE_SHOT_QUERY_KEY = "interruptSingleShot";

function parseOptionalBooleanFlag(value: unknown): boolean | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return null;
}

const interruptSingleShotModeFromEnv =
  parseOptionalBooleanFlag(process.env.NEXT_PUBLIC_INTERRUPT_SINGLE_SHOT ?? "") ?? true;

function resolveInterruptSingleShotMode(defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const fromQuery = parseOptionalBooleanFlag(searchParams.get(INTERRUPT_SINGLE_SHOT_QUERY_KEY));
    if (fromQuery !== null) return fromQuery;
  } catch {
    // ignore query parsing failures
  }
  try {
    const fromStorage = parseOptionalBooleanFlag(window.localStorage.getItem(INTERRUPT_SINGLE_SHOT_STORAGE_KEY));
    if (fromStorage !== null) return fromStorage;
  } catch {
    // ignore localStorage access failures
  }
  return defaultValue;
}

export default function HomePage() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    // Keep server and first client render identical to avoid hydration mismatches.
    return <div className="h-screen min-h-screen w-full bg-codex-base" suppressHydrationWarning />;
  }

  return <HomePageInner />;
}

function HomePageInner() {
  const [apiBase, setApiBase] = useState(apiBaseFromEnv);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [workspaceRoots, setWorkspaceRoots] = useState<string[]>([]);
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [draftCwd, setDraftCwd] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [outOfCreditMessage, setOutOfCreditMessage] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [threadsBootstrapping, setThreadsBootstrapping] = useState(true);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [pinnedThreadIds, setPinnedThreadIds] = useState<string[]>([]);
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const [codexPreferences, setCodexPreferences] = useState<PersistedCodexPreferences>({ ...DEFAULT_CODEX_PREFERENCES });
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<ProjectDropTarget | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [thinkingCount, setThinkingCount] = useState(0);
  const [activeThreadIds, setActiveThreadIds] = useState<Set<string>>(() => new Set());
  const [stalledRunByThreadId, setStalledRunByThreadId] = useState<Set<string>>(() => new Set());
  const [unreadCompletedThreadIds, setUnreadCompletedThreadIds] = useState<Set<string>>(() => new Set());
  const [archivingThreadIds, setArchivingThreadIds] = useState<Set<string>>(() => new Set());
  const [steerEnabled, setSteerEnabled] = useState(true);
  const [queuedCount, setQueuedCount] = useState(0);
  const [queuedPreview, setQueuedPreview] = useState<string | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<QueuedSendSnapshot[]>([]);
  const [interrupting, setInterrupting] = useState(false);
  const [interruptSingleShotMode, setInterruptSingleShotMode] = useState(interruptSingleShotModeFromEnv);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectCreationOpen, setProjectCreationOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [projectCreationPending, setProjectCreationPending] = useState(false);
  const [projectCreationError, setProjectCreationError] = useState<string | null>(null);
  const [devServerDialogOpen, setDevServerDialogOpen] = useState(false);
  const [archiveConfirmTarget, setArchiveConfirmTarget] = useState<{ threadId: string; title: string } | null>(null);
  const [codexSettingsDialogOpen, setCodexSettingsDialogOpen] = useState(false);
  const [codexSettingsDraft, setCodexSettingsDraft] = useState<PersistedCodexPreferences>({ ...DEFAULT_CODEX_PREFERENCES });
  const [devServerPort, setDevServerPort] = useState("");
  const [devServerError, setDevServerError] = useState<string | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  const [serverDeviceName, setServerDeviceName] = useState<string | null>(null);
  const [connectionCheckRunning, setConnectionCheckRunning] = useState(true);
  const [iosSimpleScrollMode, setIosSimpleScrollMode] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [mobileThreadPreviewId, setMobileThreadPreviewId] = useState<string | null>(null);
  const [composerLayout, setComposerLayout] = useState({ height: 176, overlap: 176 });
  const [uiStateReady, setUiStateReady] = useState(false);
  const [collapsedLoaded, setCollapsedLoaded] = useState(false);
  const [expandedLoaded, setExpandedLoaded] = useState(false);
  const [pinnedLoaded, setPinnedLoaded] = useState(false);
  const [projectOrderLoaded, setProjectOrderLoaded] = useState(false);
  const [codexPreferencesLoaded, setCodexPreferencesLoaded] = useState(false);
  const [projectDiscoveryMinElapsed, setProjectDiscoveryMinElapsed] = useState(false);
  const [projectDiscoverySettled, setProjectDiscoverySettled] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const wsReadyRef = useRef(false);
  const sendingRef = useRef(false);
  const interruptingRef = useRef(false);
  const thinkingCountRef = useRef(0);
  const activeThreadIdsRef = useRef<Set<string>>(new Set());
  const stalledRunByThreadRef = useRef<Set<string>>(new Set());
  const archivingThreadIdsRef = useRef<Set<string>>(new Set());
  const subscribedThreadsRef = useRef<Set<string>>(new Set());
  const pendingThreadHydrationByIdRef = useRef<Map<string, PendingThreadHydration>>(new Map());
  const resumeRequestedAtByThreadRef = useRef<Map<string, number>>(new Map());
  const threadSeqByIdRef = useRef<Map<string, number>>(new Map());
  const threadSeqPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadsBootstrappedRef = useRef(false);
  const threadUpdatedAtByIdRef = useRef<Map<string, number>>(new Map());
  const lastWsActivityByThreadRef = useRef<Map<string, number>>(new Map());
  const externalProbeInFlightRef = useRef<Set<string>>(new Set());
  const threadsRef = useRef<Thread[]>([]);
  const itemsRef = useRef<TimelineItem[]>([]);
  const itemIndexRef = useRef<Map<string, number>>(new Map());
  const lastAgentByTurnRef = useRef<Map<string, string>>(new Map());
  const turnStartedAtMsRef = useRef<Map<string, number>>(new Map());
  const activeTurnsRef = useRef<Set<string>>(new Set());
  const activeTurnsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const optimisticThinkingRef = useRef(false);
  const optimisticThinkingPendingRef = useRef(false);
  const optimisticThinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optimisticThinkingHealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transientSendErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optimisticThinkingStartedAtMsRef = useRef<number>(0);
  const optimisticUserMessageIdsByThreadRef = useRef<Map<string, string[]>>(new Map());
  const optimisticAttachmentPreviewUrlsByMessageRef = useRef<Map<string, string[]>>(new Map());
  const syncSelectedThreadInvokerRef = useRef<((threadId: string) => void) | null>(null);
  const activeTurnIdRef = useRef<string | null>(null);
  const interruptOnNextTurnRef = useRef(false);
  const interruptRequestedRef = useRef(false);
  const interruptingTurnIdRef = useRef<string | null>(null);
  const interruptingActionIdRef = useRef<string | null>(null);
  const interruptHttpInFlightByThreadRef = useRef<
    Map<string, { turnId: string | null; clientActionId: string | null; startedAtMs: number }>
  >(new Map());
  const requestInterruptInvokerRef = useRef<
    ((turnId?: string | null, options?: { retry?: boolean; skipOptimisticUi?: boolean; clientActionId?: string | null }) => Promise<boolean>) | null
  >(null);
  const interruptRetryAtByKeyRef = useRef<Map<string, number>>(new Map());
  const interruptWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendQueueRef = useRef<Map<string, QueuedSend[]>>(new Map());
  const queuePausedRef = useRef(false);
  const queueAutoFlushOnRunCompletionKeyRef = useRef<string | null>(null);
  const selectedThreadUpdatedAtRef = useRef<number | null>(null);
  const selectedThreadSnapshotSignatureRef = useRef<string>("0");
  const selectionEpochRef = useRef(0);
  const [itemsVersion, setItemsVersion] = useState(0);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const initialThreadBottomLockRef = useRef<string | null>(null);
  const selectedThreadRef = useRef<Thread | null>(null);
  const selectedThreadIdForResetRef = useRef<string | null>(null);
  const projectMenuRef = useRef<HTMLDivElement | null>(null);
  const interruptDebugSessionIdRef = useRef<string>(createClientId());
  const interruptDebugSeqRef = useRef(0);
  const interruptDebugBusySignatureRef = useRef<string>("");

  const emitInterruptDebug = useCallback(
    (event: string, detail?: Record<string, unknown>, options?: { threadId?: string | null; turnId?: string | null }) => {
      const sequence = ++interruptDebugSeqRef.current;
      const selectedThreadId = selectedThreadRef.current?.id ?? null;
      const payload = {
        source: "web",
        event,
        threadId: options?.threadId ?? selectedThreadId,
        turnId: options?.turnId ?? activeTurnIdRef.current,
        detail: {
          ...detail,
          sequence,
          sessionId: interruptDebugSessionIdRef.current,
          selectedThreadId,
          interruptSingleShotMode,
          interruptRequested: interruptRequestedRef.current,
          interruptingTurnId: interruptingTurnIdRef.current,
          interruptingActionId: interruptingActionIdRef.current,
          activeTurnId: activeTurnIdRef.current,
          activeTurns: Array.from(activeTurnsRef.current),
        },
      };
      if (typeof window !== "undefined") {
        // eslint-disable-next-line no-console
        console.debug("[interrupt-debug]", payload);
      }
      if (!apiBase) return;
      void fetch(`${apiBase}/api/debug/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {
        // Ignore debug telemetry failures.
      });
    },
    [apiBase, interruptSingleShotMode],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(min-width: 768px)").matches) {
      setSidebarOpen(true);
    }
  }, []);

  useEffect(() => {
    setInterruptSingleShotMode(resolveInterruptSingleShotMode(interruptSingleShotModeFromEnv));
  }, []);

  useEffect(() => {
    return () => {
      if (interruptWatchdogTimerRef.current) {
        clearTimeout(interruptWatchdogTimerRef.current);
        interruptWatchdogTimerRef.current = null;
      }
      interruptHttpInFlightByThreadRef.current.clear();
      requestInterruptInvokerRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const previewUrls of optimisticAttachmentPreviewUrlsByMessageRef.current.values()) {
        for (const previewUrl of previewUrls) {
          revokePreviewUrl(previewUrl);
        }
      }
      optimisticAttachmentPreviewUrlsByMessageRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const isIOS =
      /iP(ad|hone|od)/.test(window.navigator.userAgent) ||
      (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
    const isTouch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    setIosSimpleScrollMode(isIOS && isTouch);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobileViewport(mediaQuery.matches);
    update();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", update);
      return () => mediaQuery.removeEventListener("change", update);
    }
    mediaQuery.addListener(update);
    return () => mediaQuery.removeListener(update);
  }, []);

  useEffect(() => {
    if (isMobileViewport) return;
    setMobileThreadPreviewId(null);
  }, [isMobileViewport]);

  useEffect(() => {
    if (sidebarOpen) return;
    setMobileThreadPreviewId(null);
  }, [sidebarOpen]);

  useEffect(() => {
    if (!projectCreationOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (projectCreationPending) return;
      setProjectCreationOpen(false);
      setProjectCreationError(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [projectCreationOpen, projectCreationPending]);

  useEffect(() => {
    if (!devServerDialogOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDevServerDialogOpen(false);
      setDevServerError(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [devServerDialogOpen]);

  useEffect(() => {
    if (!archiveConfirmTarget) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setArchiveConfirmTarget(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [archiveConfirmTarget]);

  const items = itemsRef.current;
  const visibleItems = useMemo(
    () => items.filter((item) => !isVerboseOnlyTimelineItem(item)),
    [items, itemsVersion],
  );
  const draftThread = useMemo<Thread | null>(() => {
    if (!draftCwd) return null;
    const now = Math.floor(Date.now() / 1000);
    return {
      id: "draft",
      title: null,
      preview: "",
      modelProvider: "",
      createdAt: now,
      updatedAt: now,
      path: null,
      cwd: draftCwd,
      cliVersion: "",
      source: "local",
      gitInfo: null,
      turns: [],
    };
  }, [draftCwd]);
  const activeThread = selectedThread ?? draftThread;
  const currentQueueKey = useMemo(() => queueKeyFor(selectedThread, draftCwd), [selectedThread, draftCwd]);
  const selectedThreadHasActiveRun = useMemo(() => {
    if (!selectedThread) return false;
    if (stalledRunByThreadId.has(selectedThread.id)) return false;
    if (interrupting) return false;
    if (activeThreadIds.has(selectedThread.id)) return true;
    const turns = Array.isArray(selectedThread.turns) ? selectedThread.turns : [];
    if (turns.some((turn) => isTurnStillActive(turn))) return true;
    if (isExternalRunActive(selectedThread) && turns.length > 0) return true;
    return false;
  }, [activeThreadIds, interrupting, selectedThread, stalledRunByThreadId]);

  const selectedThreadHasExternalSurfaceRun = useMemo(() => {
    if (!selectedThread) return false;
    if (stalledRunByThreadId.has(selectedThread.id)) return false;
    if (interrupting) return false;
    const externalOwner = normalizeExternalRunOwner(selectedThread.externalRun?.owner);
    if (externalOwner === "local") return false;
    if (externalOwner === "external") {
      return isExternalRunActive(selectedThread);
    }
    const turns = Array.isArray(selectedThread.turns) ? selectedThread.turns : [];
    if (turns.length === 0) return false;
    if (!isExternalRunActive(selectedThread)) return false;
    if (turns.some((turn) => isTurnStillActive(turn))) return false;
    const trackedTurns = activeTurnsByThreadRef.current.get(selectedThread.id);
    if (trackedTurns && trackedTurns.size > 0) {
      return trackedTurns.has("external-run");
    }
    return true;
  }, [activeThreadIds, interrupting, selectedThread, stalledRunByThreadId]);

  const pinnedIdSet = useMemo(() => new Set(pinnedThreadIds), [pinnedThreadIds]);
  const pinnedThreads = useMemo(() => {
    if (!pinnedThreadIds.length) return [];
    const lookup = new Map(threads.map((thread) => [thread.id, thread]));
    return pinnedThreadIds.map((id) => lookup.get(id)).filter(Boolean) as Thread[];
  }, [threads, pinnedThreadIds]);
  const grouped = useMemo(() => {
    const groups = new Map<string, { id: string; label: string; cwd: string | null; threads: Thread[] }>();
    for (const root of workspaceRoots) {
      const info = projectGroupInfoFromCwd(root);
      if (info.id === "(unknown)") continue;
      if (!groups.has(info.id)) {
        groups.set(info.id, { ...info, threads: [] });
      }
    }
    for (const thread of threads) {
      const info = projectGroupInfo(thread);
      if (!groups.has(info.id)) {
        groups.set(info.id, { ...info, threads: [] });
      }
      const group = groups.get(info.id);
      if (!group) continue;
      if (!group.cwd && info.cwd) group.cwd = info.cwd;
      group.threads.push(thread);
    }
    const sorted = Array.from(groups.values())
      .map((group) => ({
        ...group,
        ...(() => {
          const sorted = [...group.threads].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
          const pinnedThreads = sorted.filter((thread) => pinnedIdSet.has(thread.id));
          const unpinnedThreads = sorted.filter((thread) => !pinnedIdSet.has(thread.id));
          return { totalCount: sorted.length, pinnedThreads, threads: unpinnedThreads };
        })(),
      }))
      .sort((left, right) => {
        if (left.id === "(unknown)") return 1;
        if (right.id === "(unknown)") return -1;

        const leftHasThreads = left.totalCount > 0;
        const rightHasThreads = right.totalCount > 0;
        if (leftHasThreads !== rightHasThreads) {
          return leftHasThreads ? -1 : 1;
        }

        const leftUpdatedAt =
          left.pinnedThreads[0]?.updatedAt ?? left.threads[0]?.updatedAt ?? 0;
        const rightUpdatedAt =
          right.pinnedThreads[0]?.updatedAt ?? right.threads[0]?.updatedAt ?? 0;
        if (leftUpdatedAt !== rightUpdatedAt) {
          return rightUpdatedAt - leftUpdatedAt;
        }
        return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
      });
    return applyProjectOrderToGroups(sorted, projectOrder);
  }, [projectOrder, threads, pinnedIdSet, workspaceRoots]);

  const reorderableProjectIds = useMemo(
    () => grouped.filter((group) => group.id !== "(unknown)").map((group) => group.id),
    [grouped],
  );

  useEffect(() => {
    if (!projectOrder.length) return;
    if (!grouped.length) return;
    const normalizedOrder = normalizeProjectOrderForGroups(projectOrder, grouped);
    if (areStringArraysEqual(projectOrder, normalizedOrder)) return;
    setProjectOrder(normalizedOrder);
  }, [grouped, projectOrder]);

  useEffect(() => {
    if (!draggingProjectId) return;
    if (reorderableProjectIds.includes(draggingProjectId)) return;
    setDraggingProjectId(null);
    setProjectDropTarget(null);
  }, [draggingProjectId, reorderableProjectIds]);

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      setProjectDiscoveryMinElapsed(true);
    }, PROJECT_DISCOVERY_MIN_VISUAL_MS);
    return () => window.clearTimeout(timerId);
  }, []);

  useEffect(() => {
    if (projectDiscoverySettled) return;
    const timeoutId = window.setTimeout(() => {
      setProjectDiscoverySettled(true);
    }, PROJECT_DISCOVERY_TIMEOUT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [projectDiscoverySettled]);

  useEffect(() => {
    if (projectDiscoverySettled) return;
    if (grouped.length === 0) return;
    if (!projectDiscoveryMinElapsed) return;
    setProjectDiscoverySettled(true);
  }, [grouped.length, projectDiscoveryMinElapsed, projectDiscoverySettled]);

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    if (transientSendErrorTimeoutRef.current) {
      clearTimeout(transientSendErrorTimeoutRef.current);
      transientSendErrorTimeoutRef.current = null;
    }

    const message = typeof sendError === "string" ? sendError.trim() : "";
    if (!message) return;

    transientSendErrorTimeoutRef.current = setTimeout(() => {
      setSendError((current) => {
        const currentMessage = typeof current === "string" ? current.trim() : "";
        return currentMessage === message ? null : current;
      });
      transientSendErrorTimeoutRef.current = null;
    }, UI_ERROR_BANNER_VISIBLE_MS);

    return () => {
      if (transientSendErrorTimeoutRef.current) {
        clearTimeout(transientSendErrorTimeoutRef.current);
        transientSendErrorTimeoutRef.current = null;
      }
    };
  }, [sendError]);

  useEffect(() => {
    activeThreadIdsRef.current = activeThreadIds;
  }, [activeThreadIds]);

  useEffect(() => {
    stalledRunByThreadRef.current = stalledRunByThreadId;
  }, [stalledRunByThreadId]);

  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  useEffect(() => {
    interruptingRef.current = interrupting;
  }, [interrupting]);

  useEffect(() => {
    thinkingCountRef.current = thinkingCount;
  }, [thinkingCount]);

  const { modelOptions, effortOptionsByModel, defaultEffortByModel } = useMemo(
    () => buildModelPickerData(models),
    [models],
  );
  const defaultModelValue = useMemo(() => {
    const primary = models.find((model) => model.isDefault);
    if (primary) {
      return primary.model;
    }
    return modelOptions[0]?.value ?? "";
  }, [models, modelOptions]);
  const defaultEffortValue = useMemo(() => {
    if (!defaultModelValue) return null;
    const defaultEffort = defaultEffortByModel[defaultModelValue];
    if (defaultEffort) return defaultEffort;
    return effortOptionsByModel[defaultModelValue]?.[0]?.value ?? null;
  }, [defaultEffortByModel, defaultModelValue, effortOptionsByModel]);

  const bumpItems = useCallback(() => setItemsVersion((value) => value + 1), []);

  const syncThinking = useCallback(() => {
    if (interruptRequestedRef.current) {
      const optimisticActive = optimisticThinkingRef.current || optimisticThinkingPendingRef.current;
      setThinkingCount(optimisticActive ? 1 : 0);
      return;
    }
    const selectedId = selectedThreadRef.current?.id ?? null;
    const hasSelectedActiveTurns = selectedId
      ? (activeTurnsByThreadRef.current.get(selectedId)?.size ?? 0) > 0
      : false;
    const hasSelectedActiveThread = selectedId ? activeThreadIdsRef.current.has(selectedId) : false;
    const optimisticActive = optimisticThinkingRef.current || optimisticThinkingPendingRef.current;
    const count = (hasSelectedActiveTurns || hasSelectedActiveThread ? 1 : 0) + (optimisticActive ? 1 : 0);
    setThinkingCount(count);
  }, []);

  const clearOptimisticThinkingTimer = useCallback(() => {
    if (!optimisticThinkingTimerRef.current) return;
    clearTimeout(optimisticThinkingTimerRef.current);
    optimisticThinkingTimerRef.current = null;
  }, []);

  const clearOptimisticThinkingHealTimer = useCallback(() => {
    if (!optimisticThinkingHealTimerRef.current) return;
    clearTimeout(optimisticThinkingHealTimerRef.current);
    optimisticThinkingHealTimerRef.current = null;
  }, []);

  const clearRunStallMarker = useCallback((threadId: string) => {
    if (!threadId) return;
    setStalledRunByThreadId((current) => {
      if (!current.has(threadId)) return current;
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
  }, []);

  const markRunStalled = useCallback((threadId: string) => {
    if (!threadId) return;
    setStalledRunByThreadId((current) => {
      if (current.has(threadId)) return current;
      const next = new Set(current);
      next.add(threadId);
      return next;
    });
  }, []);

  const noteThreadActivity = useCallback(
    (threadId: string | null | undefined) => {
      const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
      if (!normalizedThreadId) return;
      lastWsActivityByThreadRef.current.set(normalizedThreadId, Date.now());
      clearRunStallMarker(normalizedThreadId);
    },
    [clearRunStallMarker],
  );

  const beginOptimisticThinking = useCallback(() => {
    optimisticThinkingPendingRef.current = true;
    optimisticThinkingRef.current = false;
    optimisticThinkingStartedAtMsRef.current = Date.now();
    noteThreadActivity(selectedThreadRef.current?.id ?? null);
    clearOptimisticThinkingTimer();
    clearOptimisticThinkingHealTimer();
    syncThinking();
    optimisticThinkingHealTimerRef.current = setTimeout(() => {
      if (!optimisticThinkingPendingRef.current && !optimisticThinkingRef.current) return;
      const threadId = selectedThreadRef.current?.id;
      if (!threadId) return;
      syncSelectedThreadInvokerRef.current?.(threadId);
    }, IDLE_CHECK_SOFT_TIMEOUT_MS);
    optimisticThinkingTimerRef.current = setTimeout(() => {
      if (!optimisticThinkingPendingRef.current) return;
      if (activeTurnsRef.current.size > 0) return;
      optimisticThinkingPendingRef.current = false;
      optimisticThinkingRef.current = true;
      syncThinking();
    }, 500);
  }, [clearOptimisticThinkingHealTimer, clearOptimisticThinkingTimer, noteThreadActivity, syncThinking]);

  const settleOptimisticThinking = useCallback(() => {
    optimisticThinkingPendingRef.current = false;
    optimisticThinkingStartedAtMsRef.current = 0;
    clearOptimisticThinkingTimer();
    clearOptimisticThinkingHealTimer();
    if (optimisticThinkingRef.current) {
      optimisticThinkingRef.current = false;
    }
    syncThinking();
  }, [clearOptimisticThinkingHealTimer, clearOptimisticThinkingTimer, syncThinking]);

  const removeItemById = useCallback(
    (id: string): boolean => {
      const index = itemIndexRef.current.get(id);
      if (index === undefined) return false;
      itemsRef.current.splice(index, 1);
      const nextIndex = new Map<string, number>();
      itemsRef.current.forEach((entry, entryIndex) => {
        nextIndex.set(entry.id, entryIndex);
      });
      itemIndexRef.current = nextIndex;
      bumpItems();
      return true;
    },
    [bumpItems],
  );

  const releaseOptimisticMessageResources = useCallback((optimisticId: string) => {
    const previewUrls = optimisticAttachmentPreviewUrlsByMessageRef.current.get(optimisticId);
    if (!previewUrls || previewUrls.length === 0) return;
    for (const previewUrl of previewUrls) {
      revokePreviewUrl(previewUrl);
    }
    optimisticAttachmentPreviewUrlsByMessageRef.current.delete(optimisticId);
  }, []);

  const addOptimisticUserMessage = useCallback(
    (threadId: string, text: string, attachments: OutgoingAttachment[]) => {
      const trimmedText = text.trim();
      const fallbackText =
        attachments.length <= 0 ? "" : attachments.length === 1 ? "[1 attachment]" : `[${attachments.length} attachments]`;
      const optimisticText = trimmedText || fallbackText;
      const content: UserInput[] = [];
      if (optimisticText) {
        content.push({ type: "text", text: optimisticText, text_elements: [] });
      }
      const previewUrlsToRelease: string[] = [];
      for (const attachment of attachments) {
        if (attachment.kind === "image") {
          const mimeType = attachment.mimeType?.trim() || "image/jpeg";
          const dataBase64 = typeof attachment.dataBase64 === "string" ? attachment.dataBase64.trim() : "";
          if (dataBase64) {
            content.push({ type: "image", url: `data:${mimeType};base64,${dataBase64}` });
            continue;
          }
          if (attachment.file instanceof File) {
            const objectUrl = safeCreateObjectUrl(attachment.file);
            if (objectUrl) {
              content.push({ type: "image", url: objectUrl });
              previewUrlsToRelease.push(objectUrl);
              continue;
            }
          }
        }
        const fileName = attachment.name?.trim() || "attachment";
        content.push({ type: "mention", name: fileName, path: fileName });
      }
      if (content.length === 0) return null;
      const optimisticId = `optimistic-user-${createClientId()}`;
      const item: TimelineItem = {
        type: "userMessage",
        id: optimisticId,
        content,
        _meta: { status: "started" },
      };
      if (previewUrlsToRelease.length > 0) {
        optimisticAttachmentPreviewUrlsByMessageRef.current.set(optimisticId, previewUrlsToRelease);
      }
      const index = itemIndexRef.current.get(optimisticId);
      if (index === undefined) {
        itemIndexRef.current.set(optimisticId, itemsRef.current.length);
        itemsRef.current.push(item);
      } else {
        itemsRef.current[index] = item;
      }
      bumpItems();
      const existing = optimisticUserMessageIdsByThreadRef.current.get(threadId) ?? [];
      optimisticUserMessageIdsByThreadRef.current.set(threadId, [...existing, optimisticId]);
      return optimisticId;
    },
    [bumpItems],
  );

  const clearOptimisticUserMessages = useCallback(
    (threadId: string, consumeOnlyOne = false) => {
      const known = optimisticUserMessageIdsByThreadRef.current.get(threadId);
      if (!known || known.length === 0) return;
      const remaining = [...known];
      const targetIds = consumeOnlyOne ? [remaining.shift() ?? ""] : [...remaining];
      for (const optimisticId of targetIds) {
        if (!optimisticId) continue;
        releaseOptimisticMessageResources(optimisticId);
        removeItemById(optimisticId);
      }
      if (consumeOnlyOne && remaining.length > 0) {
        optimisticUserMessageIdsByThreadRef.current.set(threadId, remaining);
        return;
      }
      optimisticUserMessageIdsByThreadRef.current.delete(threadId);
    },
    [releaseOptimisticMessageResources, removeItemById],
  );

  const dropOptimisticUserMessage = useCallback(
    (threadId: string, optimisticId: string) => {
      if (!threadId || !optimisticId) return;
      releaseOptimisticMessageResources(optimisticId);
      removeItemById(optimisticId);
      const known = optimisticUserMessageIdsByThreadRef.current.get(threadId);
      if (!known || known.length === 0) return;
      const remaining = known.filter((entryId) => entryId !== optimisticId);
      if (remaining.length > 0) {
        optimisticUserMessageIdsByThreadRef.current.set(threadId, remaining);
      } else {
        optimisticUserMessageIdsByThreadRef.current.delete(threadId);
      }
    },
    [releaseOptimisticMessageResources, removeItemById],
  );

  const persistThreadSeqs = useCallback(() => {
    if (typeof window === "undefined") return;
    try {
      const payload = Object.fromEntries(
        Array.from(threadSeqByIdRef.current.entries()).filter(
          ([threadId, seq]) => !!threadId && Number.isFinite(seq) && seq > 0,
        ),
      );
      window.localStorage.setItem(THREAD_SEQ_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }, []);

  const schedulePersistThreadSeqs = useCallback(() => {
    if (threadSeqPersistTimerRef.current) return;
    threadSeqPersistTimerRef.current = setTimeout(() => {
      threadSeqPersistTimerRef.current = null;
      persistThreadSeqs();
    }, 450);
  }, [persistThreadSeqs]);

  const rememberThreadSeq = useCallback(
    (threadId: string, seq: number) => {
      if (!threadId || !Number.isFinite(seq)) return;
      const normalized = Math.max(0, Math.trunc(seq));
      const previous = threadSeqByIdRef.current.get(threadId) ?? 0;
      if (normalized <= previous) return;
      threadSeqByIdRef.current.set(threadId, normalized);
      schedulePersistThreadSeqs();
    },
    [schedulePersistThreadSeqs],
  );

  const hasPendingThreadHydration = useCallback((threadId: string | null | undefined): boolean => {
    if (!threadId) return false;
    const pending = pendingThreadHydrationByIdRef.current.get(threadId);
    if (!pending) return false;
    if (pending.expiresAtMs > Date.now()) return true;
    pendingThreadHydrationByIdRef.current.delete(threadId);
    return false;
  }, []);

  const rememberPendingThreadHydration = useCallback((thread: Thread) => {
    const threadId = typeof thread.id === "string" ? thread.id.trim() : "";
    if (!threadId) return;
    pendingThreadHydrationByIdRef.current.set(threadId, {
      thread,
      expiresAtMs: Date.now() + PENDING_THREAD_HYDRATION_WINDOW_MS,
    });
  }, []);

  const upsertThreadForSidebar = useCallback((thread: Thread) => {
    const threadId = typeof thread.id === "string" ? thread.id.trim() : "";
    if (!threadId) return;
    setThreads((current) => {
      const index = current.findIndex((entry) => entry.id === threadId);
      const next = [...current];
      if (index >= 0) {
        next[index] = thread;
      } else {
        next.push(thread);
      }
      next.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
      return next;
    });
  }, []);

  const mergeThreadsWithPendingHydration = useCallback((fetchedThreads: Thread[]): Thread[] => {
    const nowMs = Date.now();
    const pendingById = pendingThreadHydrationByIdRef.current;

    for (const [threadId, pending] of Array.from(pendingById.entries())) {
      if (pending.expiresAtMs <= nowMs) {
        pendingById.delete(threadId);
      }
    }

    for (const thread of fetchedThreads) {
      pendingById.delete(thread.id);
    }

    if (pendingById.size <= 0) {
      return fetchedThreads;
    }

    const knownIds = new Set(fetchedThreads.map((thread) => thread.id));
    const merged = [...fetchedThreads];
    for (const [threadId, pending] of pendingById.entries()) {
      if (knownIds.has(threadId)) continue;
      merged.push(pending.thread);
    }
    merged.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    return merged;
  }, []);

  const updateActiveThreadIds = useCallback((threadId: string, isActive: boolean) => {
    setActiveThreadIds((current) => {
      const hasThread = current.has(threadId);
      if (isActive ? hasThread : !hasThread) return current;
      const next = new Set(current);
      if (isActive) {
        next.add(threadId);
      } else {
        next.delete(threadId);
      }
      return next;
    });
  }, []);

  const patchSelectedThreadRunState = useCallback(
    (
      threadId: string,
      options: {
        turnId?: string | null;
        status?: "running" | "completed";
        externalRunActive?: boolean;
        externalRunOwner?: "local" | "external" | "none";
        externalRunTurnId?: string | null;
      }
    ) => {
      if (!threadId) return;
      setSelectedThread((current) => {
        if (!current || current.id !== threadId) return current;
        let changed = false;
        let nextThread = current;
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();

        if (options.status) {
          const turns = Array.isArray(nextThread.turns) ? nextThread.turns : [];
          if (turns.length > 0) {
            let targetIndex = -1;
            const explicitTurnId = options.turnId ? String(options.turnId).trim() : "";
            if (explicitTurnId) {
              targetIndex = turns.findIndex((turn) => turn?.id === explicitTurnId);
            }
            if (targetIndex < 0 && options.status === "completed") {
              for (let index = turns.length - 1; index >= 0; index -= 1) {
                if (isTurnStillActive(turns[index])) {
                  targetIndex = index;
                  break;
                }
              }
            }
            if (targetIndex >= 0) {
              const turn = turns[targetIndex];
              const nextStatus =
                options.status === "running"
                  ? isTurnRunningStatus(turn.status)
                    ? turn.status
                    : "running"
                  : isTurnTerminalStatus(turn)
                    ? turn.status
                    : "completed";
              const nextStartedAt =
                options.status === "running" ? turn.startedAt ?? turn.started_at ?? nowMs : turn.startedAt;
              const nextCompletedAt =
                options.status === "completed" ? turn.completedAt ?? turn.completed_at ?? nowMs : turn.completedAt;
              const shouldUpdateTurn =
                turn.status !== nextStatus ||
                turn.startedAt !== nextStartedAt ||
                turn.completedAt !== nextCompletedAt ||
                turn.updatedAt !== nowMs;
              if (shouldUpdateTurn) {
                const nextTurns = [...turns];
                nextTurns[targetIndex] = {
                  ...turn,
                  status: nextStatus,
                  startedAt: nextStartedAt,
                  completedAt: nextCompletedAt,
                  updatedAt: nowMs,
                };
                nextThread = { ...nextThread, turns: nextTurns };
                changed = true;
              }
            }
          }
        }

        if (typeof options.externalRunActive === "boolean") {
          const currentExternal = nextThread.externalRun ?? null;
          const currentActive = currentExternal?.active === true;
          const currentOwner = normalizeExternalRunOwner(currentExternal?.owner);
          const nextOwner = options.externalRunOwner ?? currentOwner;
          const currentTurnId =
            typeof currentExternal?.turnId === "string" && currentExternal.turnId.trim()
              ? currentExternal.turnId.trim()
              : null;
          const nextTurnId =
            typeof options.externalRunTurnId === "string" && options.externalRunTurnId.trim()
              ? options.externalRunTurnId.trim()
              : options.externalRunTurnId === null
                ? null
                : currentTurnId;
          const shouldPatchExternal =
            currentActive !== options.externalRunActive ||
            currentOwner !== nextOwner ||
            currentTurnId !== nextTurnId;
          if (shouldPatchExternal) {
            nextThread = {
              ...nextThread,
              externalRun: {
                ...(currentExternal ?? {}),
                active: options.externalRunActive,
                source: currentExternal?.source ?? "rollout",
                lastEventAt: nowIso,
                owner: nextOwner,
                turnId: nextTurnId,
              },
            };
            changed = true;
          }
        }

        return changed ? nextThread : current;
      });
    },
    [],
  );

  const markThreadExternallyActive = useCallback(
    (threadId: string, options?: { owner?: "local" | "external" | "none"; turnId?: string | null }) => {
      if (!threadId) return;
      clearRunStallMarker(threadId);
      updateActiveThreadIds(threadId, true);
      patchSelectedThreadRunState(threadId, {
        externalRunActive: true,
        externalRunOwner: options?.owner,
        externalRunTurnId: options?.turnId,
      });
      setUnreadCompletedThreadIds((current) => {
        if (!current.has(threadId)) return current;
        const next = new Set(current);
        next.delete(threadId);
        return next;
      });
    },
    [clearRunStallMarker, patchSelectedThreadRunState, updateActiveThreadIds],
  );

  const markThreadExternallyCompleted = useCallback(
    (threadId: string, options?: { notifyUnread?: boolean }) => {
      if (!threadId) return;
      updateActiveThreadIds(threadId, false);
      patchSelectedThreadRunState(threadId, {
        externalRunActive: false,
        externalRunOwner: "none",
        externalRunTurnId: null,
      });
      setUnreadCompletedThreadIds((current) => {
        const isSelected = selectedThreadRef.current?.id === threadId;
        if (isSelected) {
          if (!current.has(threadId)) return current;
          const next = new Set(current);
          next.delete(threadId);
          return next;
        }
        if (!options?.notifyUnread) return current;
        if (current.has(threadId)) return current;
        const next = new Set(current);
        next.add(threadId);
        return next;
      });
    },
    [patchSelectedThreadRunState, updateActiveThreadIds],
  );

  const forceStopTrackedRun = useCallback(
    (threadId: string, options?: { reason?: string; outOfCredit?: string | null }) => {
      if (!threadId) return;
      activeTurnsByThreadRef.current.delete(threadId);
      if (selectedThreadRef.current?.id === threadId) {
        activeTurnsRef.current = new Set<string>();
        activeTurnIdRef.current = null;
        interruptRequestedRef.current = false;
        interruptingTurnIdRef.current = null;
        interruptingActionIdRef.current = null;
        interruptOnNextTurnRef.current = false;
        interruptRetryAtByKeyRef.current.clear();
        if (interruptWatchdogTimerRef.current) {
          clearTimeout(interruptWatchdogTimerRef.current);
          interruptWatchdogTimerRef.current = null;
        }
        setInterrupting(false);
      }
      markThreadExternallyCompleted(threadId, { notifyUnread: false });
      settleOptimisticThinking();
      syncThinking();
      markRunStalled(threadId);

      const outOfCredit = options?.outOfCredit;
      if (typeof outOfCredit === "string" && outOfCredit.trim()) {
        setOutOfCreditMessage(formatOutOfCreditBannerMessage(outOfCredit));
      }
      if (options?.reason) {
        setSendError(options.reason);
      }
    },
    [markRunStalled, markThreadExternallyCompleted, settleOptimisticThinking, syncThinking],
  );

  const probeExternalThreadState = useCallback(
    async (threadId: string) => {
      if (!apiBase || !threadId) return;
      const inFlight = externalProbeInFlightRef.current;
      if (inFlight.has(threadId)) return;
      inFlight.add(threadId);
      try {
        const response = await fetch(`${apiBase}/api/threads/${threadId}`);
        if (!response.ok) return;
        const data = await response.json();
        const externalRunActive = isExternalRunActive(data?.thread);
        const externalRunOwner = normalizeExternalRunOwner(data?.thread?.externalRun?.owner);
        const externalRunTurnId =
          typeof data?.thread?.externalRun?.turnId === "string" && data.thread.externalRun.turnId.trim()
            ? data.thread.externalRun.turnId.trim()
            : null;
        const turns = Array.isArray(data?.thread?.turns) ? data.thread.turns : [];
        const runningTurnIds = new Set<string>();
        for (const turn of turns) {
          const normalizedTurnId = normalizeTurnId(turn?.id);
          if (normalizedTurnId && isTurnStillActive(turn)) {
            runningTurnIds.add(normalizedTurnId);
          }
        }
        if (runningTurnIds.size === 0 && externalRunActive && turns.length > 0) {
          if (externalRunOwner === "local" && externalRunTurnId) {
            runningTurnIds.add(externalRunTurnId);
          } else if (externalRunOwner !== "local") {
            runningTurnIds.add("external-run");
          }
        }
        const knownTurns = activeTurnsByThreadRef.current.get(threadId);
        const knownTrackedTurnIds = Array.from(knownTurns ?? []).filter((turnId) => Boolean(turnId));
        const hadKnownActiveTurns = (knownTurns?.size ?? 0) > 0;
        const lastWsActivityAt = lastWsActivityByThreadRef.current.get(threadId) ?? 0;
        const wsTrackedTurnsStillFresh =
          knownTrackedTurnIds.length > 0 &&
          lastWsActivityAt > 0 &&
          Date.now() - lastWsActivityAt <= EXTERNAL_TRACKED_ACTIVE_STALE_MS;
        if (runningTurnIds.size === 0 && wsTrackedTurnsStillFresh) {
          activeTurnsByThreadRef.current.set(threadId, new Set(knownTrackedTurnIds));
          markThreadExternallyActive(threadId, {
            owner: externalRunOwner === "none" ? undefined : externalRunOwner,
            turnId: externalRunTurnId,
          });
          return;
        }
        if (runningTurnIds.size > 0) {
          activeTurnsByThreadRef.current.set(threadId, runningTurnIds);
          markThreadExternallyActive(threadId, {
            owner: externalRunOwner === "none" ? undefined : externalRunOwner,
            turnId: externalRunTurnId,
          });
          return;
        }
        activeTurnsByThreadRef.current.delete(threadId);
        markThreadExternallyCompleted(threadId, { notifyUnread: hadKnownActiveTurns });
      } catch {
        // ignore
      } finally {
        inFlight.delete(threadId);
      }
    },
    [apiBase, markThreadExternallyActive, markThreadExternallyCompleted],
  );

  const noteTurnStarted = useCallback(
    (threadId: string, turnId: string) => {
      if (!threadId || !turnId) return;
      if (!turnStartedAtMsRef.current.has(turnId)) {
        turnStartedAtMsRef.current.set(turnId, Date.now());
      }
      noteThreadActivity(threadId);
      markThreadExternallyActive(threadId, { owner: "local", turnId });
      const map = activeTurnsByThreadRef.current;
      let turns = map.get(threadId);
      if (!turns) {
        turns = new Set();
        map.set(threadId, turns);
      }
      turns.delete("external-run");
      addTurnToSet(turns, turnId);
      patchSelectedThreadRunState(threadId, {
        turnId,
        status: "running",
        externalRunActive: true,
        externalRunOwner: "local",
        externalRunTurnId: turnId,
      });
    },
    [markThreadExternallyActive, noteThreadActivity, patchSelectedThreadRunState],
  );

  const noteTurnCompleted = useCallback(
    (threadId: string, turnId: string) => {
      if (!threadId || !turnId) return;
      noteThreadActivity(threadId);
      const map = activeTurnsByThreadRef.current;
      const turns = map.get(threadId);
      if (!turns) {
        markThreadExternallyCompleted(threadId, { notifyUnread: false });
        return;
      }
      deleteTurnFromSet(turns, turnId);
      if (turns.size === 0) {
        map.delete(threadId);
        markThreadExternallyCompleted(threadId, { notifyUnread: true });
      }
      patchSelectedThreadRunState(threadId, {
        turnId,
        status: "completed",
        externalRunActive: false,
        externalRunOwner: "none",
        externalRunTurnId: null,
      });
    },
    [markThreadExternallyCompleted, noteThreadActivity, patchSelectedThreadRunState],
  );

  const ensureThreadTurnActive = useCallback(
    (threadId: string | null, turnId: string | null, _source = "event") => {
      if (!threadId || !turnId) return;
      const knownTurns = activeTurnsByThreadRef.current.get(threadId);
      const alreadyKnown = Boolean(knownTurns && turnSetHas(knownTurns, turnId));
      if (!alreadyKnown) {
        noteTurnStarted(threadId, turnId);
      }
      if (selectedThreadRef.current?.id === threadId) {
        if (!turnSetHas(activeTurnsRef.current, turnId)) {
          addTurnToSet(activeTurnsRef.current, turnId);
          if (!activeTurnIdRef.current) activeTurnIdRef.current = turnId;
        }
        settleOptimisticThinking();
      }
    },
    [noteTurnStarted, settleOptimisticThinking],
  );

  const clearSelectedTurnActivity = useCallback(
    (turnId: string | null) => {
      if (!turnId) return false;
      const wasTracked = turnSetHas(activeTurnsRef.current, turnId);
      deleteTurnFromSet(activeTurnsRef.current, turnId);
      if (turnIdsReferToSameTurn(activeTurnIdRef.current, turnId)) {
        activeTurnIdRef.current = activeTurnsRef.current.values().next().value ?? null;
      }
      if (turnIdsReferToSameTurn(interruptingTurnIdRef.current, turnId)) {
        interruptRequestedRef.current = false;
        interruptingTurnIdRef.current = null;
        interruptingActionIdRef.current = null;
        interruptOnNextTurnRef.current = false;
        interruptRetryAtByKeyRef.current.clear();
        if (interruptWatchdogTimerRef.current) {
          clearTimeout(interruptWatchdogTimerRef.current);
          interruptWatchdogTimerRef.current = null;
        }
        setInterrupting(false);
      }
      if (activeTurnsRef.current.size === 0 && interruptingTurnIdRef.current) {
        interruptRequestedRef.current = false;
        interruptingTurnIdRef.current = null;
        interruptingActionIdRef.current = null;
        interruptOnNextTurnRef.current = false;
        interruptRetryAtByKeyRef.current.clear();
        if (interruptWatchdogTimerRef.current) {
          clearTimeout(interruptWatchdogTimerRef.current);
          interruptWatchdogTimerRef.current = null;
        }
        setInterrupting(false);
      }
      settleOptimisticThinking();
      return wasTracked;
    },
    [settleOptimisticThinking],
  );

  const ensureSubscribed = useCallback((threadId: string, resume = false, resumeFromOverride?: number, wake = false) => {
    if (!threadId || !wsRef.current || !wsReadyRef.current) return;
    const isSubscribed = subscribedThreadsRef.current.has(threadId);
    const currentSeq = threadSeqByIdRef.current.get(threadId) ?? 0;
    const resumeFrom =
      typeof resumeFromOverride === "number" && Number.isFinite(resumeFromOverride)
        ? Math.max(0, Math.trunc(resumeFromOverride))
        : currentSeq;
    if (!isSubscribed) {
      subscribedThreadsRef.current.add(threadId);
      if (!resume) {
        wsRef.current.send(JSON.stringify({ type: "subscribe", threadId, resume: false, resumeFrom, wake }));
        return;
      }
    } else if (!resume) {
      return;
    }
    const now = Date.now();
    const lastResumeAt = resumeRequestedAtByThreadRef.current.get(threadId) ?? 0;
    if (now - lastResumeAt < EXTERNAL_RESUME_RETRY_MS) return;
    resumeRequestedAtByThreadRef.current.set(threadId, now);
    wsRef.current.send(JSON.stringify({ type: "subscribe", threadId, resume: true, resumeFrom, wake }));
  }, []);

  const resubscribeAll = useCallback(() => {
    subscribedThreadsRef.current.clear();
    resumeRequestedAtByThreadRef.current.clear();
    if (!wsRef.current || !wsReadyRef.current) return;
    for (const thread of threadsRef.current) {
      ensureSubscribed(thread.id, true);
    }
    const selectedId = selectedThreadRef.current?.id;
    if (selectedId) {
      ensureSubscribed(selectedId, true, undefined, true);
    }
  }, [ensureSubscribed]);

  const resolveSteerEnabled = useCallback((config: any): boolean => {
    return config?.features?.steer !== false;
  }, []);

  const getQueue = useCallback((key: string) => {
    let queue = sendQueueRef.current.get(key);
    if (!queue) {
      queue = [];
      sendQueueRef.current.set(key, queue);
    }
    return queue;
  }, []);

  const updateQueueState = useCallback(
    (key?: string | null) => {
      const targetKey = key ?? currentQueueKey;
      if (!targetKey) {
        if (!currentQueueKey) {
          setQueuedCount(0);
          setQueuedPreview(null);
          setQueuedMessages([]);
        }
        return;
      }
      if (targetKey !== currentQueueKey) return;
      const queue = sendQueueRef.current.get(targetKey) ?? [];
      setQueuedCount(queue.length);
      setQueuedPreview(describeQueuedSend(queue[0]));
      setQueuedMessages(queue.map((entry) => queueSnapshotFor(entry)));
    },
    [currentQueueKey],
  );

  const enqueueSend = useCallback(
    (
      text: string,
      modelValue: string,
      attachments: OutgoingAttachment[],
      key?: string | null,
      options?: { threadId?: string | null; addOptimistic?: boolean },
    ) => {
      const targetKey = key ?? currentQueueKey;
      if (!targetKey) return;
      const queue = getQueue(targetKey);
      const threadId = options?.threadId?.trim() ? options.threadId.trim() : null;
      const optimisticMessageId =
        options?.addOptimistic === false || !threadId ? null : addOptimisticUserMessage(threadId, text, attachments);
      queue.push({
        id: createClientId(),
        text,
        modelValue,
        attachments,
        createdAt: Date.now(),
        threadId,
        optimisticMessageId,
      });
      updateQueueState(targetKey);
    },
    [addOptimisticUserMessage, currentQueueKey, getQueue, updateQueueState],
  );

  const removeQueuedSend = useCallback(
    (id: string, key?: string | null): QueuedSend | null => {
      const targetKey = key ?? currentQueueKey;
      if (!targetKey) return null;
      const queue = sendQueueRef.current.get(targetKey);
      if (!queue || queue.length === 0) return null;
      const index = queue.findIndex((entry) => {
        const stableId = typeof entry.id === "string" && entry.id.trim() ? entry.id : `queued-${entry.createdAt}`;
        return stableId === id;
      });
      if (index < 0) return null;
      const [removed] = queue.splice(index, 1);
      if (removed?.threadId && removed.optimisticMessageId) {
        dropOptimisticUserMessage(removed.threadId, removed.optimisticMessageId);
      }
      updateQueueState(targetKey);
      return removed ?? null;
    },
    [currentQueueKey, dropOptimisticUserMessage, updateQueueState],
  );

  const migrateQueue = useCallback(
    (fromKey: string | null, toKey: string | null) => {
      if (!fromKey || !toKey || fromKey === toKey) return;
      const fromQueue = sendQueueRef.current.get(fromKey);
      if (!fromQueue || fromQueue.length === 0) return;
      const toQueue = sendQueueRef.current.get(toKey) ?? [];
      sendQueueRef.current.set(toKey, [...fromQueue, ...toQueue]);
      sendQueueRef.current.delete(fromKey);
      updateQueueState();
    },
    [updateQueueState],
  );

  const resetItems = useCallback((nextItems: TimelineItem[]) => {
    itemsRef.current = nextItems;
    const map = new Map<string, number>();
    nextItems.forEach((item, index) => map.set(item.id, index));
    itemIndexRef.current = map;
    bumpItems();
  }, [bumpItems]);

  const syncSelectedThread = useCallback(
    async (threadId: string, options?: { force?: boolean }) => {
      if (!apiBase) return;
      const force = options?.force === true;
      const recentWsActivityAt = lastWsActivityByThreadRef.current.get(threadId) ?? 0;
      const hasRecentWsActivity = Date.now() - recentWsActivityAt <= EXTERNAL_WS_RECENT_MS;
      const optimisticStartedAtMs = optimisticThinkingStartedAtMsRef.current;
      const optimisticIsFresh =
        (optimisticThinkingRef.current || optimisticThinkingPendingRef.current) &&
        optimisticStartedAtMs > 0 &&
        Date.now() - optimisticStartedAtMs < IDLE_CHECK_SOFT_TIMEOUT_MS;
      if (!force && (hasRecentWsActivity || optimisticIsFresh || sendingRef.current || interruptingRef.current)) {
        return;
      }
      try {
        const response = await fetch(`${apiBase}/api/threads/${threadId}`);
        const data = await response.json();
        if (!data?.thread) return;
        if (selectedThreadRef.current?.id !== threadId) return;
        const externalRunActive = isExternalRunActive(data.thread);
        const externalRunOwner = normalizeExternalRunOwner(data.thread?.externalRun?.owner);
        const externalRunTurnId =
          typeof data.thread?.externalRun?.turnId === "string" && data.thread.externalRun.turnId.trim()
            ? data.thread.externalRun.turnId.trim()
            : null;
        const turns = Array.isArray(data.thread.turns) ? (data.thread.turns as Turn[]) : [];
        const runningTurnIds = new Set<string>();
        for (const turn of turns) {
          const normalizedTurnId = normalizeTurnId(turn?.id);
          if (normalizedTurnId && isTurnStillActive(turn)) {
            runningTurnIds.add(normalizedTurnId);
          }
        }
        if (runningTurnIds.size === 0 && externalRunActive && turns.length > 0) {
          if (externalRunOwner === "local" && externalRunTurnId) {
            runningTurnIds.add(externalRunTurnId);
          } else if (externalRunOwner !== "local") {
            runningTurnIds.add("external-run");
          }
        }
        const knownTurns = activeTurnsByThreadRef.current.get(threadId);
        const knownTrackedTurnIds = Array.from(knownTurns ?? []).filter((turnId) => Boolean(turnId));
        const hadKnownActiveTurns = (knownTurns?.size ?? 0) > 0;
        const lastWsActivityAt = lastWsActivityByThreadRef.current.get(threadId) ?? 0;
        const wsTrackedTurnsStillFresh =
          knownTrackedTurnIds.length > 0 &&
          lastWsActivityAt > 0 &&
          Date.now() - lastWsActivityAt <= EXTERNAL_TRACKED_ACTIVE_STALE_MS;
        if (runningTurnIds.size === 0 && wsTrackedTurnsStillFresh) {
          for (const turnId of knownTrackedTurnIds) {
            runningTurnIds.add(turnId);
          }
        }
        let interruptedTurnId = interruptingTurnIdRef.current;
        let interruptProjection = projectRunningTurnsForUi({
          runningTurnIds,
          interruptRequested: interruptRequestedRef.current,
          interruptedTurnId,
        });
        if (
          interruptRequestedRef.current &&
          interruptedTurnId &&
          interruptedTurnId !== "external-run" &&
          !interruptProjection.interruptedTurnStillRunning &&
          runningTurnIds.has("external-run")
        ) {
          interruptedTurnId = "external-run";
          interruptingTurnIdRef.current = "external-run";
          emitInterruptDebug(
            "sync_interrupt_retarget_external_run",
            {
              force,
              runningTurnIds: Array.from(runningTurnIds),
            },
            { threadId, turnId: "external-run" },
          );
          interruptProjection = projectRunningTurnsForUi({
            runningTurnIds,
            interruptRequested: interruptRequestedRef.current,
            interruptedTurnId,
          });
        }
        const uiRunningTurnIds = interruptProjection.uiRunningTurnIds;
        if (interruptRequestedRef.current && interruptedTurnId) {
          const interruptedTurnStillRunning = interruptProjection.interruptedTurnStillRunning;
          if (!interruptedTurnStillRunning && runningTurnIds.size === 0) {
            emitInterruptDebug(
              "sync_interrupt_settled",
              {
                force,
                runningTurnIds: Array.from(runningTurnIds),
                uiRunningTurnIds: Array.from(uiRunningTurnIds),
              },
              { threadId, turnId: interruptedTurnId },
            );
            interruptRequestedRef.current = false;
            interruptingTurnIdRef.current = null;
            interruptingActionIdRef.current = null;
            interruptOnNextTurnRef.current = false;
            interruptRetryAtByKeyRef.current.clear();
            if (interruptWatchdogTimerRef.current) {
              clearTimeout(interruptWatchdogTimerRef.current);
              interruptWatchdogTimerRef.current = null;
            }
            setInterrupting(false);
          } else if (interruptedTurnStillRunning) {
            const retryKey = `${threadId}:${interruptedTurnId}`;
            const nowMs = Date.now();
            const lastRetryAtMs = interruptRetryAtByKeyRef.current.get(retryKey) ?? 0;
            if (nowMs - lastRetryAtMs >= 450) {
              interruptRetryAtByKeyRef.current.set(retryKey, nowMs);
              const clientActionId = interruptingActionIdRef.current ?? createClientId();
              interruptingActionIdRef.current = clientActionId;
              if (interruptSingleShotMode) {
                emitInterruptDebug(
                  "sync_interrupt_retry_skipped_single_shot",
                  {
                    force,
                    retryKey,
                    clientActionId,
                    runningTurnIds: Array.from(runningTurnIds),
                    uiRunningTurnIds: Array.from(uiRunningTurnIds),
                  },
                  { threadId, turnId: interruptedTurnId },
                );
              } else {
                emitInterruptDebug(
                  "sync_interrupt_retry",
                  {
                    force,
                    retryKey,
                    clientActionId,
                    runningTurnIds: Array.from(runningTurnIds),
                    uiRunningTurnIds: Array.from(uiRunningTurnIds),
                  },
                  { threadId, turnId: interruptedTurnId },
                );
                const requestInterruptInvoker = requestInterruptInvokerRef.current;
                if (requestInterruptInvoker) {
                  void requestInterruptInvoker(interruptedTurnId, {
                    retry: true,
                    skipOptimisticUi: true,
                    clientActionId,
                  });
                } else {
                  void fetch(`${apiBase}/api/threads/${threadId}/interrupt`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ turnId: interruptedTurnId, clientActionId }),
                  }).catch(() => {
                    // ignore retry failures
                  });
                }
              }
            }
          }
        }
        if (uiRunningTurnIds.size > 0) {
          activeTurnsByThreadRef.current.set(threadId, uiRunningTurnIds);
          markThreadExternallyActive(threadId, {
            owner: externalRunOwner === "none" ? undefined : externalRunOwner,
            turnId: externalRunTurnId,
          });
        } else {
          activeTurnsByThreadRef.current.delete(threadId);
          markThreadExternallyCompleted(threadId, { notifyUnread: hadKnownActiveTurns });
        }
        activeTurnsRef.current = new Set(uiRunningTurnIds);
        activeTurnIdRef.current = activeTurnsRef.current.values().next().value ?? null;
        if (uiRunningTurnIds.size > 0) {
          settleOptimisticThinking();
        } else {
          syncThinking();
        }
        const updatedAt = typeof data.thread.updatedAt === "number" ? data.thread.updatedAt : null;
        const previousUpdatedAt = selectedThreadUpdatedAtRef.current;
        const previousUserMessageCount = countThreadUserMessages(selectedThreadRef.current);
        const snapshotUserMessageCount = countThreadUserMessages(data.thread);
        const pendingOptimisticCountBefore =
          optimisticUserMessageIdsByThreadRef.current.get(threadId)?.length ?? 0;
        if (pendingOptimisticCountBefore > 0 && snapshotUserMessageCount > previousUserMessageCount) {
          clearOptimisticUserMessages(threadId, true);
        }
        const hasPendingOptimisticAfterReconcile =
          (optimisticUserMessageIdsByThreadRef.current.get(threadId)?.length ?? 0) > 0;
        const snapshotSignature = buildThreadSnapshotSignature(data.thread);
        const previousSignature = selectedThreadSnapshotSignatureRef.current;
        const hasSnapshotAdvanced =
          typeof updatedAt === "number" &&
          Number.isFinite(updatedAt) &&
          (!previousUpdatedAt || updatedAt > previousUpdatedAt);
        const hasSnapshotChanged = snapshotSignature !== previousSignature;
        if (
          !force &&
          !hasSnapshotAdvanced &&
          !hasSnapshotChanged &&
          itemsRef.current.length > 0 &&
          hasRecentWsActivity
        ) {
          return;
        }
        selectedThreadUpdatedAtRef.current = updatedAt ?? selectedThreadUpdatedAtRef.current;
        setSelectedThread(data.thread);
        const shouldHydrateFromSnapshot =
          itemsRef.current.length === 0 ||
          ((force || !hasRecentWsActivity) && (hasSnapshotAdvanced || hasSnapshotChanged));
        const shouldHoldOptimisticProjection =
          hasPendingOptimisticAfterReconcile && snapshotUserMessageCount <= previousUserMessageCount;
        if (shouldHydrateFromSnapshot && !shouldHoldOptimisticProjection) {
          resetItems(flattenThreadItems(data.thread));
          selectedThreadSnapshotSignatureRef.current = snapshotSignature;
        }
      } catch {
        // ignore
      }
    },
    [
      apiBase,
      clearOptimisticUserMessages,
      emitInterruptDebug,
      markThreadExternallyActive,
      markThreadExternallyCompleted,
      resetItems,
      settleOptimisticThinking,
      syncThinking,
      interruptSingleShotMode,
    ],
  );

  useEffect(() => {
    syncSelectedThreadInvokerRef.current = (threadId: string) => {
      void syncSelectedThread(threadId);
    };
    return () => {
      syncSelectedThreadInvokerRef.current = null;
    };
  }, [syncSelectedThread]);

  const schedulePostSendThreadHeals = useCallback(
    (threadId: string) => {
      if (!threadId) return;
      const delays = [120, 420, 900, 1600, 2600];
      for (const delayMs of delays) {
        setTimeout(() => {
          if (selectedThreadRef.current?.id !== threadId) return;
          void syncSelectedThread(threadId, { force: true });
        }, delayMs);
      }
    },
    [syncSelectedThread],
  );

  const upsertItem = useCallback(
    (item: ThreadItem, meta?: TimelineItem["_meta"]) => {
      const normalized = normalizeThreadItem(item);
      const index = itemIndexRef.current.get(normalized.id);
      if (index === undefined) {
        const next: TimelineItem = { ...normalized, _meta: meta };
        itemIndexRef.current.set(normalized.id, itemsRef.current.length);
        itemsRef.current.push(next);
        bumpItems();
        return;
      }
      const existing = itemsRef.current[index];
      itemsRef.current[index] = { ...existing, ...normalized, _meta: { ...existing._meta, ...meta } };
      bumpItems();
    },
    [bumpItems],
  );

  const updateItem = useCallback(
    (id: string, updater: (item: TimelineItem) => TimelineItem) => {
      const index = itemIndexRef.current.get(id);
      if (index === undefined) return;
      const current = itemsRef.current[index];
      itemsRef.current[index] = updater(current);
      bumpItems();
    },
    [bumpItems],
  );

  useEffect(() => {
    if (apiBaseFromEnv) return;
    if (typeof window === "undefined") return;

    // Always target the same server origin that served this web app.
    const origin = window.location?.origin?.trim() ?? "";
    if (/^https?:\/\//i.test(origin)) {
      setApiBase(origin.replace(/\/+$/, ""));
      return;
    }

    // Fallback for unusual environments where origin may be unavailable.
    if (window.location?.hostname) {
      setApiBase(`http://${window.location.hostname}:8787`);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(THREAD_SEQ_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const next = new Map<string, number>();
      for (const [threadId, value] of Object.entries(parsed || {})) {
        if (!threadId) continue;
        const seq =
          typeof value === "number"
            ? value
            : typeof value === "string" && value.trim()
              ? Number.parseInt(value, 10)
              : Number.NaN;
        if (!Number.isFinite(seq) || seq <= 0) continue;
        next.set(threadId, Math.trunc(seq));
      }
      threadSeqByIdRef.current = next;
    } catch {
      // ignore
    }
  }, []);

  useEffect(
    () => () => {
      if (threadSeqPersistTimerRef.current) {
        clearTimeout(threadSeqPersistTimerRef.current);
        threadSeqPersistTimerRef.current = null;
      }
      clearOptimisticThinkingTimer();
      clearOptimisticThinkingHealTimer();
      persistThreadSeqs();
    },
    [clearOptimisticThinkingHealTimer, clearOptimisticThinkingTimer, persistThreadSeqs],
  );

  const refreshThreads = useCallback(async () => {
    if (!apiBase) return;
    const bootstrapping = !threadsBootstrappedRef.current;
    if (bootstrapping) setThreadsBootstrapping(true);
    try {
      const res = await fetch(`${apiBase}/api/threads?sortKey=updated_at&limit=100`);
      const data = await res.json();
      const nextThreads = Array.isArray(data?.data) ? (data.data as Thread[]) : [];
      const hydratedThreads = mergeThreadsWithPendingHydration(nextThreads);
      let workspacePayloadRoots: unknown = null;
      try {
        const workspaceResponse = await fetch(`${apiBase}/api/workspaces`);
        if (workspaceResponse.ok) {
          const workspacePayload = await workspaceResponse.json();
          workspacePayloadRoots = workspacePayload?.roots;
        }
      } catch {
        workspacePayloadRoots = null;
      }
      const nextWorkspaceRoots = mergeWorkspaceRoots(workspacePayloadRoots, hydratedThreads);
      const now = Date.now();
      const nextIds = new Set<string>();
      const highPriorityProbeTargets: string[] = [];
      const regularProbeTargets: string[] = [];
      const probeTargets = new Set<string>();

      for (const thread of nextThreads) {
        nextIds.add(thread.id);
        const threadId = thread.id;
        const nextUpdatedAt = typeof thread.updatedAt === "number" ? thread.updatedAt : 0;
        const previousUpdatedAt = threadUpdatedAtByIdRef.current.get(threadId);
        threadUpdatedAtByIdRef.current.set(threadId, nextUpdatedAt);
        const wsActivityAt = lastWsActivityByThreadRef.current.get(threadId) ?? 0;
        const hasRecentWsActivity = now - wsActivityAt <= EXTERNAL_WS_RECENT_MS;
        const hasActiveTurns = (activeTurnsByThreadRef.current.get(threadId)?.size ?? 0) > 0;
        const wasUpdatedSinceLastRefresh = previousUpdatedAt !== undefined && nextUpdatedAt > previousUpdatedAt;
        const isSelectedThread = selectedThreadRef.current?.id === threadId;
        if (isSelectedThread || hasRecentWsActivity) continue;
        if (hasActiveTurns && !probeTargets.has(threadId)) {
          probeTargets.add(threadId);
          highPriorityProbeTargets.push(threadId);
        } else if (wasUpdatedSinceLastRefresh && !probeTargets.has(threadId)) {
          probeTargets.add(threadId);
          regularProbeTargets.push(threadId);
        }
      }

      const orderedProbeTargets = [...highPriorityProbeTargets, ...regularProbeTargets].slice(
        0,
        EXTERNAL_PROBE_MAX_PER_REFRESH,
      );
      for (const threadId of orderedProbeTargets) {
        void probeExternalThreadState(threadId);
      }

      const staleThreadIds: string[] = [];
      for (const existingId of threadUpdatedAtByIdRef.current.keys()) {
        if (!nextIds.has(existingId)) staleThreadIds.push(existingId);
      }
      for (const staleId of staleThreadIds) {
        threadUpdatedAtByIdRef.current.delete(staleId);
        lastWsActivityByThreadRef.current.delete(staleId);
        externalProbeInFlightRef.current.delete(staleId);
        activeTurnsByThreadRef.current.delete(staleId);
        updateActiveThreadIds(staleId, false);
        setUnreadCompletedThreadIds((current) => {
          if (!current.has(staleId)) return current;
          const next = new Set(current);
          next.delete(staleId);
          return next;
        });
      }
      if (staleThreadIds.length > 0) {
        setStalledRunByThreadId((current) => {
          let changed = false;
          const next = new Set(current);
          for (const staleId of staleThreadIds) {
            if (!next.delete(staleId)) continue;
            changed = true;
          }
          return changed ? next : current;
        });
      }

      setThreads(hydratedThreads);
      setWorkspaceRoots(nextWorkspaceRoots);
      setThreadError(null);
    } catch {
      setThreadError("Failed to load threads. Is the PocketDex server reachable?");
    } finally {
      if (bootstrapping) {
        threadsBootstrappedRef.current = true;
        setThreadsBootstrapping(false);
      }
    }
  }, [apiBase, mergeThreadsWithPendingHydration, probeExternalThreadState, updateActiveThreadIds]);

  const checkServerConnection = useCallback(async (options?: { minVisualMs?: number }) => {
    const minVisualMs = Math.max(0, Number(options?.minVisualMs ?? 0));
    if (!apiBase) {
      setServerReachable(false);
      setServerDeviceName(null);
      setConnectionCheckRunning(false);
      return;
    }
    setConnectionCheckRunning(true);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONNECTION_ATTEMPT_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/api/health`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json().catch(() => null);
      if (payload?.ok !== true) throw new Error("Invalid health payload");
      const deviceName =
        typeof payload?.deviceName === "string" && payload.deviceName.trim()
          ? payload.deviceName.trim()
          : null;
      setServerReachable(true);
      setServerDeviceName(deviceName);
    } catch {
      setServerReachable(false);
      setServerDeviceName(null);
    } finally {
      clearTimeout(timeoutId);
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = minVisualMs - elapsedMs;
      if (remainingMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
      }
      setConnectionCheckRunning(false);
    }
  }, [apiBase]);

  const refreshModels = useCallback(async () => {
    if (!apiBase) return;
    try {
      const res = await fetch(`${apiBase}/api/models`);
      if (!res.ok) throw new Error("Failed to fetch models");
      const data = await res.json();
      if (!Array.isArray(data?.data)) throw new Error("Invalid models payload");
      setModels(data.data as ModelInfo[]);
    } catch {
      // Keep the last known models on transient errors.
    }
  }, [apiBase]);

  useEffect(() => {
    if (!apiBase) {
      setServerReachable(false);
      setServerDeviceName(null);
      setConnectionCheckRunning(false);
      return;
    }
    refreshThreads();
    void checkServerConnection();
    const interval = setInterval(refreshThreads, THREAD_REFRESH_INTERVAL_MS);
    const onFocus = () => {
      refreshThreads();
      const selectedId = selectedThreadRef.current?.id;
      if (selectedId) {
        void syncSelectedThread(selectedId, { force: true });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      refreshThreads();
      const selectedId = selectedThreadRef.current?.id;
      if (selectedId) {
        void syncSelectedThread(selectedId, { force: true });
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [apiBase, checkServerConnection, refreshThreads, syncSelectedThread]);

  useEffect(() => {
    if (!apiBase) return;
    const interval = setInterval(() => {
      const selectedId = selectedThreadRef.current?.id ?? null;
      const activeThreadIds = Array.from(activeTurnsByThreadRef.current.keys())
        .filter((threadId) => threadId && threadId !== selectedId)
        .slice(0, EXTERNAL_ACTIVE_RECHECK_MAX);
      for (const threadId of activeThreadIds) {
        void probeExternalThreadState(threadId);
      }
    }, EXTERNAL_ACTIVE_RECHECK_MS);
    return () => clearInterval(interval);
  }, [apiBase, probeExternalThreadState]);

  useEffect(() => {
    const selectedId = selectedThread?.id;
    if (!selectedId) return;
    if (threads.some((thread) => thread.id === selectedId)) return;
    if (hasPendingThreadHydration(selectedId)) return;
    selectionEpochRef.current += 1;
    selectedThreadRef.current = null;
    setSelectedThread(null);
    selectedThreadUpdatedAtRef.current = null;
    selectedThreadSnapshotSignatureRef.current = "0";
    activeTurnsRef.current = new Set<string>();
    activeTurnIdRef.current = null;
    selectedThreadIdForResetRef.current = null;
    resetItems([]);
    setLoading(false);
  }, [threads, selectedThread, hasPendingThreadHydration, resetItems]);

  useEffect(() => {
    if (selectedThread || draftCwd) return;
    const fallback = threads.find((thread) => thread.cwd)?.cwd ?? null;
    if (fallback) setDraftCwd(fallback);
  }, [threads, selectedThread, draftCwd]);

  useEffect(() => {
    if (!apiBase) return;
    refreshModels();
    const interval = setInterval(refreshModels, 60000);
    const onFocus = () => refreshModels();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshModels();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [apiBase, refreshModels]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("pocketdex.sidebar.collapsed");
      if (raw) {
        setCollapsedProjects(parseBooleanRecord(JSON.parse(raw)));
      }
    } catch {
      // ignore
    } finally {
      setCollapsedLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("pocketdex.sidebar.expanded");
      if (raw) {
        setExpandedProjects(parseBooleanRecord(JSON.parse(raw)));
      }
    } catch {
      // ignore
    } finally {
      setExpandedLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("pocketdex.sidebar.pinned");
      if (raw) {
        setPinnedThreadIds(parseStringArray(JSON.parse(raw)));
      }
    } catch {
      // ignore
    } finally {
      setPinnedLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("pocketdex.sidebar.projectOrder");
      if (raw) {
        setProjectOrder(parseStringArray(JSON.parse(raw)));
      }
    } catch {
      // ignore
    } finally {
      setProjectOrderLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("pocketdex.codex.preferences");
      if (raw) {
        setCodexPreferences(parsePersistedCodexPreferences(JSON.parse(raw)));
      }
    } catch {
      // ignore
    } finally {
      setCodexPreferencesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!collapsedLoaded) return;
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("pocketdex.sidebar.collapsed", JSON.stringify(collapsedProjects));
    } catch {
      // ignore
    }
  }, [collapsedLoaded, collapsedProjects]);

  useEffect(() => {
    if (!expandedLoaded) return;
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("pocketdex.sidebar.expanded", JSON.stringify(expandedProjects));
    } catch {
      // ignore
    }
  }, [expandedLoaded, expandedProjects]);

  useEffect(() => {
    if (!pinnedLoaded) return;
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("pocketdex.sidebar.pinned", JSON.stringify(pinnedThreadIds));
    } catch {
      // ignore
    }
  }, [pinnedLoaded, pinnedThreadIds]);

  useEffect(() => {
    if (!projectOrderLoaded) return;
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("pocketdex.sidebar.projectOrder", JSON.stringify(projectOrder));
    } catch {
      // ignore
    }
  }, [projectOrder, projectOrderLoaded]);

  useEffect(() => {
    if (!codexPreferencesLoaded) return;
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("pocketdex.codex.preferences", JSON.stringify(codexPreferences));
    } catch {
      // ignore
    }
  }, [codexPreferences, codexPreferencesLoaded]);

  useEffect(() => {
    if (!apiBase) return;
    const controller = new AbortController();
    let cancelled = false;
    const loadUiState = async () => {
      try {
        const response = await fetch(`${apiBase}/api/ui-state`, { signal: controller.signal });
        if (!response.ok) return;
        const payload = await response.json();
        const nextState = parsePersistedUiState(payload?.data);
        const persisted = payload?.persisted === true;
        if (cancelled) return;

        setCollapsedProjects((current) => {
          if (persisted) return nextState.collapsedProjects;
          if (!Object.keys(current).length && Object.keys(nextState.collapsedProjects).length) {
            return nextState.collapsedProjects;
          }
          return current;
        });

        setExpandedProjects((current) => {
          if (persisted) return nextState.expandedProjects;
          if (!Object.keys(current).length && Object.keys(nextState.expandedProjects).length) {
            return nextState.expandedProjects;
          }
          return current;
        });

        setPinnedThreadIds((current) => {
          if (persisted) return nextState.pinnedThreadIds;
          if (!current.length && nextState.pinnedThreadIds.length) {
            return nextState.pinnedThreadIds;
          }
          return current;
        });

        setProjectOrder((current) => {
          if (persisted) return nextState.projectOrder;
          if (!current.length && nextState.projectOrder.length) {
            return nextState.projectOrder;
          }
          return current;
        });

        setCodexPreferences((current) => {
          if (persisted) return nextState.codexPreferences;
          const isDefault =
            current.accessMode === DEFAULT_CODEX_PREFERENCES.accessMode &&
            current.internetAccess === DEFAULT_CODEX_PREFERENCES.internetAccess;
          if (isDefault) {
            return nextState.codexPreferences;
          }
          return current;
        });

      } catch {
        // ignore
      } finally {
        if (!cancelled) setUiStateReady(true);
      }
    };

    void loadUiState();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiBase]);

  useEffect(() => {
    if (!apiBase || !uiStateReady) return;
    if (!collapsedLoaded || !expandedLoaded || !pinnedLoaded || !projectOrderLoaded || !codexPreferencesLoaded) return;
    const timer = setTimeout(() => {
      const payload = {
        collapsedProjects,
        expandedProjects,
        pinnedThreadIds,
        projectOrder,
        codexPreferences,
      };
      void fetch(`${apiBase}/api/ui-state`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: payload }),
      }).catch(() => {
        // ignore
      });
    }, 220);
    return () => clearTimeout(timer);
  }, [
    apiBase,
    collapsedLoaded,
    collapsedProjects,
    expandedLoaded,
    expandedProjects,
    codexPreferences,
    codexPreferencesLoaded,
    projectOrder,
    projectOrderLoaded,
    pinnedLoaded,
    pinnedThreadIds,
    uiStateReady,
  ]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (projectMenuRef.current && !projectMenuRef.current.contains(target)) {
        setProjectMenuOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", handlePointer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    if (selectedThread) setProjectMenuOpen(false);
  }, [selectedThread]);

  useEffect(() => {
    if (!currentQueueKey) {
      setQueuedCount(0);
      setQueuedPreview(null);
      setQueuedMessages([]);
      return;
    }
    const queue = sendQueueRef.current.get(currentQueueKey);
    setQueuedCount(queue?.length ?? 0);
    setQueuedPreview(describeQueuedSend(queue?.[0]));
    setQueuedMessages((queue ?? []).map((entry) => queueSnapshotFor(entry)));
  }, [currentQueueKey]);

  useEffect(() => {
    if (!apiBase) return;
    const controller = new AbortController();
    const cwd = selectedThread?.cwd ?? draftCwd ?? null;
    const url = new URL(`${apiBase}/api/config`);
    if (cwd) url.searchParams.set("cwd", cwd);
    fetch(url.toString(), { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data || typeof data !== "object") return;
        const nextSteerEnabled = resolveSteerEnabled((data as any).config);
        setSteerEnabled(nextSteerEnabled);
      })
      .catch(() => {
        // ignore config read errors
      });
    return () => controller.abort();
  }, [apiBase, draftCwd, resolveSteerEnabled, selectedThread?.cwd]);

  const togglePinnedThread = useCallback((threadId: string) => {
    setPinnedThreadIds((current) => {
      if (current.includes(threadId)) {
        return current.filter((id) => id !== threadId);
      }
      return [threadId, ...current];
    });
  }, []);

  const setThreadArchiving = useCallback((threadId: string, archiving: boolean): boolean => {
    if (!threadId) return false;
    const current = archivingThreadIdsRef.current;
    if (archiving) {
      if (current.has(threadId)) return false;
      const next = new Set(current);
      next.add(threadId);
      archivingThreadIdsRef.current = next;
      setArchivingThreadIds(next);
      return true;
    }
    if (!current.has(threadId)) return false;
    const next = new Set(current);
    next.delete(threadId);
    archivingThreadIdsRef.current = next;
    setArchivingThreadIds(next);
    return true;
  }, []);

  const archiveThreadById = useCallback(
    async (threadId: string) => {
      if (!apiBase || !threadId) return;
      if (!setThreadArchiving(threadId, true)) return;
      try {
        const response = await fetch(`${apiBase}/api/threads/${encodeURIComponent(threadId)}/archive`, { method: "POST" });
        if (!response.ok) throw new Error("Failed to archive thread");
        setThreads((current) => current.filter((entry) => entry.id !== threadId));
        setPinnedThreadIds((current) => current.filter((id) => id !== threadId));
        setUnreadCompletedThreadIds((current) => {
          if (!current.has(threadId)) return current;
          const next = new Set(current);
          next.delete(threadId);
          return next;
        });
        threadUpdatedAtByIdRef.current.delete(threadId);
        pendingThreadHydrationByIdRef.current.delete(threadId);
        lastWsActivityByThreadRef.current.delete(threadId);
        externalProbeInFlightRef.current.delete(threadId);
        activeTurnsByThreadRef.current.delete(threadId);
        subscribedThreadsRef.current.delete(threadId);
        threadSeqByIdRef.current.delete(threadId);
        setStalledRunByThreadId((current) => {
          if (!current.has(threadId)) return current;
          const next = new Set(current);
          next.delete(threadId);
          return next;
        });
        updateActiveThreadIds(threadId, false);
        try {
          if (wsRef.current && wsReadyRef.current) {
            wsRef.current.send(JSON.stringify({ type: "unsubscribe", threadId }));
          }
        } catch {
          // Ignore websocket unsubscribe failures.
        }
        if (selectedThreadRef.current?.id === threadId) {
          selectionEpochRef.current += 1;
          selectedThreadRef.current = null;
          setSelectedThread(null);
          selectedThreadUpdatedAtRef.current = null;
          selectedThreadSnapshotSignatureRef.current = "0";
          activeTurnsRef.current = new Set<string>();
          activeTurnIdRef.current = null;
          selectedThreadIdForResetRef.current = null;
          resetItems([]);
          setLoading(false);
        }
        setThreadError(null);
        void refreshThreads();
      } catch {
        setThreadError("Failed to archive thread. Is the PocketDex server reachable?");
      } finally {
        setThreadArchiving(threadId, false);
      }
    },
    [apiBase, refreshThreads, resetItems, setThreadArchiving, updateActiveThreadIds],
  );

  const requestArchiveThread = useCallback(
    (thread: Thread) => {
      const threadId = thread.id;
      if (!apiBase || !threadId) return;
      if (archivingThreadIdsRef.current.has(threadId)) return;
      setArchiveConfirmTarget({
        threadId,
        title: threadTitle(thread),
      });
    },
    [apiBase],
  );

  const handleThreadRowTogglePin = useCallback(
    (threadId: string) => {
      setMobileThreadPreviewId(null);
      togglePinnedThread(threadId);
    },
    [togglePinnedThread],
  );

  const handleThreadRowArchive = useCallback(
    (thread: Thread) => {
      setMobileThreadPreviewId(null);
      requestArchiveThread(thread);
    },
    [requestArchiveThread],
  );

  const confirmArchiveThread = useCallback(() => {
    if (!archiveConfirmTarget) return;
    const { threadId } = archiveConfirmTarget;
    setArchiveConfirmTarget(null);
    void archiveThreadById(threadId);
  }, [archiveConfirmTarget, archiveThreadById]);

  const requestInterrupt = useCallback(
    async (
      turnId?: string | null,
      options?: { retry?: boolean; skipOptimisticUi?: boolean; clientActionId?: string | null },
    ) => {
      if (!apiBase) return false;
      const threadId = selectedThreadRef.current?.id;
      if (!threadId) return false;
      const retry = options?.retry === true;
      const skipOptimisticUi = options?.skipOptimisticUi === true;
      const explicitClientActionId =
        typeof options?.clientActionId === "string" && options.clientActionId.trim()
          ? options.clientActionId.trim()
          : null;
      const baseClientActionId =
        explicitClientActionId ??
        (retry ? interruptingActionIdRef.current : null) ??
        createClientId();
      emitInterruptDebug(
        "request_interrupt_called",
        {
          requestedTurnId: turnId ?? null,
          retry,
          skipOptimisticUi,
          clientActionId: baseClientActionId,
          optimisticThinking: optimisticThinkingRef.current,
          optimisticThinkingPending: optimisticThinkingPendingRef.current,
          thinkingCount: thinkingCountRef.current,
        },
        { threadId, turnId: turnId ?? null },
      );

      const clearInterruptState = () => {
        interruptRequestedRef.current = false;
        interruptingTurnIdRef.current = null;
        interruptingActionIdRef.current = null;
        interruptOnNextTurnRef.current = false;
        interruptRetryAtByKeyRef.current.clear();
        if (interruptWatchdogTimerRef.current) {
          clearTimeout(interruptWatchdogTimerRef.current);
          interruptWatchdogTimerRef.current = null;
        }
        emitInterruptDebug("interrupt_state_cleared", { retry, clientActionId: baseClientActionId });
        setInterrupting(false);
      };

      const scheduleInterruptWatchdog = () => {
        if (interruptSingleShotMode) {
          if (interruptWatchdogTimerRef.current) {
            clearTimeout(interruptWatchdogTimerRef.current);
            interruptWatchdogTimerRef.current = null;
          }
          emitInterruptDebug(
            "interrupt_watchdog_skipped_single_shot",
            { retry, clientActionId: baseClientActionId },
            { threadId },
          );
          return;
        }
        if (interruptWatchdogTimerRef.current) {
          clearTimeout(interruptWatchdogTimerRef.current);
        }
        interruptWatchdogTimerRef.current = setTimeout(() => {
          interruptWatchdogTimerRef.current = null;
          if (selectedThreadRef.current?.id !== threadId) return;
          if (!interruptRequestedRef.current) return;
          emitInterruptDebug("interrupt_watchdog_tick", { retry, clientActionId: baseClientActionId }, { threadId });
          void syncSelectedThread(threadId, { force: true }).finally(() => {
            if (selectedThreadRef.current?.id !== threadId) return;
            if (!interruptRequestedRef.current) return;
            scheduleInterruptWatchdog();
          });
        }, 900);
      };

      const applyOptimisticStopUi = (interruptedTurnId?: string | null) => {
        activeTurnsByThreadRef.current.delete(threadId);
        activeTurnsRef.current = new Set<string>();
        activeTurnIdRef.current = null;
        markThreadExternallyCompleted(threadId, { notifyUnread: false });
        patchSelectedThreadRunState(threadId, {
          turnId: interruptedTurnId ?? undefined,
          status: interruptedTurnId ? "completed" : undefined,
          externalRunActive: false,
          externalRunOwner: "none",
          externalRunTurnId: null,
        });
        settleOptimisticThinking();
        syncThinking();
      };
      const selectedThread = selectedThreadRef.current;
      const shouldAttemptServerResolution =
        isExternalRunActive(selectedThread) ||
        activeTurnsRef.current.size > 0 ||
        optimisticThinkingRef.current ||
        optimisticThinkingPendingRef.current;
      const requestedTurnId = normalizeTurnId(turnId);
      const trackedTurnCandidate = activeTurnsRef.current.values().next().value;
      const activeTrackedTurnId = typeof trackedTurnCandidate === "string" ? trackedTurnCandidate : null;
      const effectiveTurnId =
        requestedTurnId ?? activeTurnIdRef.current ?? activeTrackedTurnId ?? (shouldAttemptServerResolution ? "external-run" : null);
      if (!effectiveTurnId) {
        emitInterruptDebug(
          "interrupt_no_effective_turn",
          { retry, shouldAttemptServerResolution, clientActionId: baseClientActionId },
          { threadId },
        );
        if (retry) return false;
        if (activeTurnsRef.current.size > 0 || optimisticThinkingRef.current || optimisticThinkingPendingRef.current) {
          interruptOnNextTurnRef.current = true;
          emitInterruptDebug("interrupt_waiting_next_turn", { retry, clientActionId: baseClientActionId }, { threadId });
          applyOptimisticStopUi();
          return true;
        }
        return false;
      }
      if (
        interruptRequestedRef.current &&
        !retry &&
        turnIdsReferToSameTurn(interruptingTurnIdRef.current, effectiveTurnId)
      ) {
        emitInterruptDebug(
          "interrupt_duplicate_suppressed",
          { retry, clientActionId: baseClientActionId },
          { threadId, turnId: effectiveTurnId },
        );
        return false;
      }
      const inFlightInterruptRequest = interruptHttpInFlightByThreadRef.current.get(threadId);
      if (inFlightInterruptRequest) {
        const inFlightTurnId = inFlightInterruptRequest.turnId;
        const sameInFlightTurn =
          (inFlightTurnId === "external-run" && effectiveTurnId === "external-run") ||
          turnIdsReferToSameTurn(inFlightTurnId, effectiveTurnId);
        emitInterruptDebug(
          "interrupt_http_request_deduped_in_flight",
          {
            retry,
            clientActionId: baseClientActionId,
            inFlightTurnId,
            inFlightActionId: inFlightInterruptRequest.clientActionId,
            inFlightAgeMs: Date.now() - inFlightInterruptRequest.startedAtMs,
            sameInFlightTurn,
          },
          { threadId, turnId: effectiveTurnId },
        );
        if (retry || sameInFlightTurn) {
          scheduleInterruptWatchdog();
          return true;
        }
      }

      const currentInterruptedTurnId = interruptingTurnIdRef.current;
      const activeClientActionId = baseClientActionId;
      interruptRequestedRef.current = true;
      const shouldKeepExternalWildcard =
        retry && currentInterruptedTurnId === "external-run" && effectiveTurnId === "external-run";
      if (
        !shouldKeepExternalWildcard &&
        (
          !currentInterruptedTurnId ||
          !retry ||
          turnIdsReferToSameTurn(currentInterruptedTurnId, effectiveTurnId) ||
          currentInterruptedTurnId === "external-run"
        )
      ) {
        interruptingTurnIdRef.current = effectiveTurnId;
      }
      interruptingActionIdRef.current = activeClientActionId;
      interruptOnNextTurnRef.current = false;
      setInterrupting(true);
      emitInterruptDebug(
        "interrupt_request_dispatching",
        {
          retry,
          skipOptimisticUi,
          clientActionId: activeClientActionId,
          shouldKeepExternalWildcard,
          activeTrackedTurnId,
          currentInterruptedTurnId,
        },
        { threadId, turnId: effectiveTurnId },
      );
      if (!skipOptimisticUi) {
        applyOptimisticStopUi(effectiveTurnId !== "external-run" ? effectiveTurnId : null);
      }
      interruptHttpInFlightByThreadRef.current.set(threadId, {
        turnId: effectiveTurnId,
        clientActionId: activeClientActionId,
        startedAtMs: Date.now(),
      });
      try {
        const response = await fetch(`${apiBase}/api/threads/${threadId}/interrupt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnId: effectiveTurnId, clientActionId: activeClientActionId }),
        });
        if (!response.ok) {
          let errorMessage = "";
          let errorCode = "";
          try {
            const payload = (await response.json()) as { error?: unknown; code?: unknown };
            if (typeof payload?.error === "string" && payload.error.trim()) {
              errorMessage = payload.error.trim();
            }
            if (typeof payload?.code === "string" && payload.code.trim()) {
              errorCode = payload.code.trim();
            }
          } catch {
            // ignore malformed/non-JSON response bodies
          }
          emitInterruptDebug(
            "interrupt_response_not_ok",
            { retry, status: response.status, errorMessage, errorCode, clientActionId: activeClientActionId },
            { threadId, turnId: effectiveTurnId },
          );
          if (errorCode === "EXTERNAL_SURFACE_RUN") {
            throw new Error("You cannot stop the current run because it was started on another Codex surface.");
          }
          const normalizedError = errorMessage.toLowerCase();
          if (response.status === 400 && normalizedError.includes("no active turn")) {
            clearInterruptState();
            emitInterruptDebug(
              "interrupt_response_no_active_turn",
              { retry, clientActionId: activeClientActionId },
              { threadId, turnId: effectiveTurnId },
            );
            return true;
          }
          throw new Error(errorMessage || `Failed to stop (HTTP ${response.status}).`);
        }
        scheduleInterruptWatchdog();
        emitInterruptDebug(
          "interrupt_response_ok",
          { retry, status: response.status, clientActionId: activeClientActionId },
          { threadId, turnId: effectiveTurnId },
        );
        return true;
      } catch (error) {
        emitInterruptDebug(
          "interrupt_request_failed",
          { retry, error: error instanceof Error ? error.message : "unknown", clientActionId: activeClientActionId },
          { threadId, turnId: effectiveTurnId },
        );
        if (retry) {
          scheduleInterruptWatchdog();
          return false;
        }
        clearInterruptState();
        const message =
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : "Failed to stop. Is the PocketDex server running?";
        setSendError(message);
        void syncSelectedThread(threadId, { force: true });
        return false;
      } finally {
        const inFlightInterruptRequestAfter = interruptHttpInFlightByThreadRef.current.get(threadId);
        if (
          inFlightInterruptRequestAfter &&
          inFlightInterruptRequestAfter.clientActionId === activeClientActionId
        ) {
          interruptHttpInFlightByThreadRef.current.delete(threadId);
        }
      }
    },
    [
      apiBase,
      emitInterruptDebug,
      markThreadExternallyCompleted,
      patchSelectedThreadRunState,
      settleOptimisticThinking,
      syncSelectedThread,
      syncThinking,
      interruptSingleShotMode,
    ],
  );

  useEffect(() => {
    requestInterruptInvokerRef.current = requestInterrupt;
    return () => {
      requestInterruptInvokerRef.current = null;
    };
  }, [requestInterrupt]);

  const connectWebSocket = useCallback(() => {
    if (!apiBase) return;
    const wsUrl = apiBase.replace(/^http/, "ws") + "/api/stream";
    const socket = new WebSocket(wsUrl);
    const connectTimeout = setTimeout(() => {
      if (wsRef.current !== socket) return;
      try {
        socket.close();
      } catch {
        // ignore
      }
    }, CONNECTION_ATTEMPT_TIMEOUT_MS);
    wsRef.current = socket;
    wsReadyRef.current = false;
    setStreamConnected(false);

    socket.onopen = () => {
      if (wsRef.current !== socket) return;
      clearTimeout(connectTimeout);
      wsReadyRef.current = true;
      setStreamConnected(true);
      resubscribeAll();
      void refreshThreads();
      const selectedId = selectedThreadRef.current?.id;
      if (selectedId) {
        void syncSelectedThread(selectedId, { force: true });
      }
    };

    socket.onmessage = (event) => {
      if (wsRef.current !== socket) return;
      let payload: any = null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object") return;

      if (payload.type === "thread_snapshot") {
        const threadId = typeof payload.threadId === "string" ? payload.threadId : "";
        if (!threadId) return;
        noteThreadActivity(threadId);
        const seqBase =
          typeof payload.seqBase === "number" && Number.isFinite(payload.seqBase)
            ? Math.max(0, Math.trunc(payload.seqBase))
            : 0;
        rememberThreadSeq(threadId, seqBase);
        if (selectedThreadRef.current?.id === threadId) {
          const snapshotThread = payload.thread && typeof payload.thread === "object" ? (payload.thread as Thread) : null;
          if (snapshotThread) {
            const previousUserMessageCount = countThreadUserMessages(selectedThreadRef.current);
            const snapshotUserMessageCount = countThreadUserMessages(snapshotThread);
            const pendingOptimisticCountBefore =
              optimisticUserMessageIdsByThreadRef.current.get(threadId)?.length ?? 0;
            if (pendingOptimisticCountBefore > 0 && snapshotUserMessageCount > previousUserMessageCount) {
              clearOptimisticUserMessages(threadId, true);
            }
            const hasPendingOptimisticAfterReconcile =
              (optimisticUserMessageIdsByThreadRef.current.get(threadId)?.length ?? 0) > 0;
            const shouldHoldOptimisticProjection =
              hasPendingOptimisticAfterReconcile && snapshotUserMessageCount <= previousUserMessageCount;
            selectedThreadUpdatedAtRef.current =
              typeof snapshotThread.updatedAt === "number" && Number.isFinite(snapshotThread.updatedAt)
                ? snapshotThread.updatedAt
                : selectedThreadUpdatedAtRef.current;
            const snapshotSignature = buildThreadSnapshotSignature(snapshotThread);
            selectedThreadSnapshotSignatureRef.current = snapshotSignature;
            setSelectedThread(snapshotThread);
            if (!shouldHoldOptimisticProjection) {
              resetItems(flattenThreadItems(snapshotThread));
            }
            if (isExternalRunActive(snapshotThread)) {
              const owner = normalizeExternalRunOwner(snapshotThread.externalRun?.owner);
              markThreadExternallyActive(threadId, {
                owner: owner === "none" ? undefined : owner,
                turnId:
                  typeof snapshotThread.externalRun?.turnId === "string" && snapshotThread.externalRun.turnId.trim()
                    ? snapshotThread.externalRun.turnId.trim()
                    : null,
              });
            } else {
              markThreadExternallyCompleted(threadId, { notifyUnread: false });
            }
          } else {
            void syncSelectedThread(threadId);
          }
        }
        void refreshThreads();
        return;
      }

      if (payload.type === "thread_sync") {
        const threadId = typeof payload.threadId === "string" ? payload.threadId : "";
        if (!threadId) return;
        noteThreadActivity(threadId);
        const latestSeq =
          typeof payload.latestSeq === "number" && Number.isFinite(payload.latestSeq)
            ? Math.max(0, Math.trunc(payload.latestSeq))
            : 0;
        rememberThreadSeq(threadId, latestSeq);
        return;
      }

      if (payload.type === "notification") {
        const method = payload.method as string;
        const params = payload.params ?? {};
        const payloadThreadId =
          typeof payload.threadId === "string" && payload.threadId.trim()
            ? payload.threadId.trim()
            : extractThreadId(params);
        const payloadSeq =
          typeof payload.seq === "number" && Number.isFinite(payload.seq)
            ? Math.max(0, Math.trunc(payload.seq))
            : null;
        if (payloadThreadId && payloadSeq !== null) {
          const previousSeq = threadSeqByIdRef.current.get(payloadThreadId) ?? 0;
          if (payloadSeq <= previousSeq) {
            return;
          }
          if (previousSeq > 0 && payloadSeq > previousSeq + 1) {
            ensureSubscribed(payloadThreadId, true, previousSeq);
            if (selectedThreadRef.current?.id === payloadThreadId) {
              void syncSelectedThread(payloadThreadId, { force: true });
            }
            return;
          }
          rememberThreadSeq(payloadThreadId, payloadSeq);
        }
        const resolvedNotificationThreadId = payloadThreadId || extractThreadId(params);
        noteThreadActivity(resolvedNotificationThreadId);

        if (method === "pocketdex/external-run-state") {
          const threadId = payloadThreadId || extractThreadId(params);
          const externalRun = params?.externalRun;
          const active = externalRun?.active === true;
          const owner = normalizeExternalRunOwner(externalRun?.owner);
          const turnId =
            typeof externalRun?.turnId === "string" && externalRun.turnId.trim() ? externalRun.turnId.trim() : null;
          const interruptedTurnId = interruptingTurnIdRef.current;
          const suppressInterruptedExternalRun =
            active &&
            Boolean(threadId) &&
            selectedThreadRef.current?.id === threadId &&
            interruptRequestedRef.current &&
            Boolean(interruptedTurnId) &&
            (interruptedTurnId === "external-run" || !turnId || turnIdsReferToSameTurn(interruptedTurnId, turnId));
          if (threadId) {
            setThreads((current) => {
              const index = current.findIndex((thread) => thread.id === threadId);
              if (index < 0) return current;
              const next = [...current];
              const previous = next[index];
              next[index] = { ...previous, externalRun: externalRun ?? previous.externalRun };
              return next;
            });
            if (active) {
              if (suppressInterruptedExternalRun) {
                emitInterruptDebug(
                  "ws_external_run_suppressed",
                  {
                    owner,
                    externalTurnId: turnId,
                    interruptedTurnId,
                  },
                  { threadId, turnId: turnId ?? interruptedTurnId ?? null },
                );
                const retryTurnId = turnId ?? interruptedTurnId;
                if (retryTurnId) {
                  const key = `${threadId}:${retryTurnId}`;
                  const nowMs = Date.now();
                  const lastRetryAtMs = interruptRetryAtByKeyRef.current.get(key) ?? 0;
                  if (nowMs - lastRetryAtMs >= 250) {
                    interruptRetryAtByKeyRef.current.set(key, nowMs);
                    emitInterruptDebug(
                      "ws_external_run_retry_interrupt",
                      {
                        key,
                        owner,
                        externalTurnId: turnId,
                        interruptedTurnId,
                        clientActionId: interruptingActionIdRef.current ?? null,
                      },
                      { threadId, turnId: retryTurnId },
                    );
                    void requestInterrupt(retryTurnId, { retry: true, skipOptimisticUi: true });
                  }
                }
                return;
              }
              markThreadExternallyActive(threadId, { owner: owner === "none" ? undefined : owner, turnId });
            } else {
              markThreadExternallyCompleted(threadId, { notifyUnread: true });
              if (selectedThreadRef.current?.id === threadId && interruptRequestedRef.current) {
                emitInterruptDebug("ws_external_run_inactive_clears_interrupt", { owner }, { threadId, turnId });
                interruptRequestedRef.current = false;
                interruptingTurnIdRef.current = null;
                interruptingActionIdRef.current = null;
                interruptOnNextTurnRef.current = false;
                interruptRetryAtByKeyRef.current.clear();
                if (interruptWatchdogTimerRef.current) {
                  clearTimeout(interruptWatchdogTimerRef.current);
                  interruptWatchdogTimerRef.current = null;
                }
                setInterrupting(false);
              }
            }
          }
          return;
        }
        if (method === "pocketdex/turn-start-failed") {
          const threadId = payloadThreadId || extractThreadId(params);
          const errorMessage =
            typeof params?.error === "string" && params.error.trim()
              ? params.error.trim()
              : "Failed to start run.";
          const outOfCreditDetected = isOutOfCreditErrorLike({
            message: errorMessage,
            code: typeof params?.code === "string" ? params.code : undefined,
          });
          if (threadId && outOfCreditDetected) {
            forceStopTrackedRun(threadId, { outOfCredit: errorMessage });
          } else if (outOfCreditDetected) {
            setOutOfCreditMessage(formatOutOfCreditBannerMessage(errorMessage));
          }
          if (threadId && selectedThreadRef.current?.id === threadId) {
            settleOptimisticThinking();
            if (interruptRequestedRef.current) {
              interruptRequestedRef.current = false;
              interruptingTurnIdRef.current = null;
              interruptingActionIdRef.current = null;
              interruptOnNextTurnRef.current = false;
              interruptRetryAtByKeyRef.current.clear();
              if (interruptWatchdogTimerRef.current) {
                clearTimeout(interruptWatchdogTimerRef.current);
                interruptWatchdogTimerRef.current = null;
              }
              setInterrupting(false);
            }
            setSendError(errorMessage);
          }
          if (threadId) {
            clearOptimisticUserMessages(threadId);
            markThreadExternallyCompleted(threadId, { notifyUnread: false });
          }
          return;
        }
        if (method.startsWith("codex/event/")) {
          const eventType = typeof params?.msg?.type === "string" ? params.msg.type : "";
          const eventThreadId = extractThreadId(params);
          const eventTurnId = extractTurnId(params);
          const interruptedTurnId = interruptingTurnIdRef.current;
          const suppressInterruptedEventTurn =
            Boolean(eventThreadId) &&
            Boolean(eventTurnId) &&
            selectedThreadRef.current?.id === eventThreadId &&
            interruptRequestedRef.current &&
            Boolean(interruptedTurnId) &&
            (interruptedTurnId === "external-run" || turnIdsReferToSameTurn(interruptedTurnId, eventTurnId));
          const retryInterruptedEventTurn = () => {
            if (!eventThreadId || !eventTurnId) return;
            const key = `${eventThreadId}:${eventTurnId}`;
            const nowMs = Date.now();
            const lastRetryAtMs = interruptRetryAtByKeyRef.current.get(key) ?? 0;
            if (nowMs - lastRetryAtMs < 250) return;
            interruptRetryAtByKeyRef.current.set(key, nowMs);
            emitInterruptDebug(
              "ws_codex_event_retry_interrupt",
              {
                key,
                eventType,
                interruptedTurnId,
                clientActionId: interruptingActionIdRef.current ?? null,
              },
              { threadId: eventThreadId, turnId: eventTurnId },
            );
            void requestInterrupt(eventTurnId, { retry: true, skipOptimisticUi: true });
          };
          if (eventType === "context_compacted") {
            const isSelectedThread = eventThreadId ? selectedThreadRef.current?.id === eventThreadId : true;
            if (isSelectedThread) {
              const rawItemId =
                params?.itemId ??
                params?.item_id ??
                params?.item?.id ??
                params?.msg?.item_id ??
                params?.msg?.id ??
                params?.id;
              const normalizedItemId =
                typeof rawItemId === "string" && rawItemId.trim()
                  ? rawItemId.trim()
                  : typeof rawItemId === "number" || typeof rawItemId === "bigint"
                    ? String(rawItemId)
                    : eventTurnId || String(Date.now());
              upsertItem(
                { type: "contextCompaction", id: `context-compaction-${normalizedItemId}` },
                { status: "completed", turnId: eventTurnId ?? undefined },
              );
            }
          }
          if (
            eventType === "task_started" ||
            eventType === "item_started" ||
            eventType === "agent_message_content_delta" ||
            eventType === "reasoning_content_delta" ||
            eventType === "plan_delta" ||
            eventType === "exec_command_output_delta" ||
            eventType === "mcp_tool_call_begin" ||
            eventType === "patch_apply_begin" ||
            eventType === "web_search_begin"
          ) {
            if (suppressInterruptedEventTurn) {
              emitInterruptDebug(
                "ws_codex_event_suppressed",
                { eventType, interruptedTurnId },
                { threadId: eventThreadId, turnId: eventTurnId },
              );
              retryInterruptedEventTurn();
              return;
            }
            ensureThreadTurnActive(eventThreadId, eventTurnId, `codex-event:${eventType || "unknown"}`);
          } else if (
            eventType === "task_complete" ||
            eventType === "turn_aborted" ||
            eventType === "stream_error" ||
            eventType === "shutdown_complete"
          ) {
            const trackedTurns = eventThreadId ? activeTurnsByThreadRef.current.get(eventThreadId) : null;
            const inferredTrackedTurnId =
              trackedTurns && trackedTurns.size === 1 ? trackedTurns.values().next().value ?? null : null;
            const inferredSelectedTurnId =
              selectedThreadRef.current?.id === eventThreadId
                ? activeTurnIdRef.current ??
                  (activeTurnsRef.current.size === 1 ? activeTurnsRef.current.values().next().value ?? null : null)
                : null;
            const resolvedTerminalTurnId = eventTurnId ?? inferredTrackedTurnId ?? inferredSelectedTurnId;
            if (eventThreadId && resolvedTerminalTurnId) {
              noteTurnCompleted(eventThreadId, resolvedTerminalTurnId);
              if (selectedThreadRef.current?.id === eventThreadId) {
                clearSelectedTurnActivity(resolvedTerminalTurnId);
              }
            }
          }
          return;
        }
        const threadId = extractThreadId(params);
        const isSelectedThread = threadId ? selectedThreadRef.current?.id === threadId : true;
        const isInterruptedTurn = (eventTurnId: string | null): boolean => {
          if (!threadId || !eventTurnId) return false;
          if (selectedThreadRef.current?.id !== threadId) return false;
          if (!interruptRequestedRef.current) return false;
          const interruptedTurnId = interruptingTurnIdRef.current;
          if (!interruptedTurnId) return false;
          return interruptedTurnId === "external-run" || turnIdsReferToSameTurn(interruptedTurnId, eventTurnId);
        };
        const retryInterruptedTurn = (eventTurnId: string | null): void => {
          if (!threadId || !eventTurnId) return;
          const key = `${threadId}:${eventTurnId}`;
          const nowMs = Date.now();
          const lastRetryAtMs = interruptRetryAtByKeyRef.current.get(key) ?? 0;
          if (nowMs - lastRetryAtMs < 250) return;
          interruptRetryAtByKeyRef.current.set(key, nowMs);
          emitInterruptDebug(
            "ws_event_retry_interrupt",
            { key, method, clientActionId: interruptingActionIdRef.current ?? null },
            { threadId, turnId: eventTurnId },
          );
          void requestInterrupt(eventTurnId, { retry: true, skipOptimisticUi: true });
        };
        if (method === "error") {
          const candidateMessages = [
            params?.error,
            params?.message,
            params?.turn?.error,
            params?.item?.error,
            params?.msg?.error,
          ];
          const errorMessage = candidateMessages.find(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          );
          if (isOutOfCreditErrorLike({ message: errorMessage, code: params?.code })) {
            if (threadId) {
              forceStopTrackedRun(threadId, { outOfCredit: errorMessage ?? null });
            } else {
              setOutOfCreditMessage(formatOutOfCreditBannerMessage(errorMessage ?? null));
            }
          }
        }
        if (method === "turn/started") {
          const turnId = extractTurnId(params);
          if (isInterruptedTurn(turnId)) {
            emitInterruptDebug("ws_turn_started_suppressed", { method }, { threadId, turnId });
            retryInterruptedTurn(turnId);
            return;
          }
          if (threadId && turnId) noteTurnStarted(threadId, turnId);
          if (!isSelectedThread) return;
          if (turnId) {
            activeTurnsRef.current.delete("external-run");
            addTurnToSet(activeTurnsRef.current, turnId);
            activeTurnIdRef.current = turnId;
          }
          settleOptimisticThinking();
          if (interruptOnNextTurnRef.current) {
            emitInterruptDebug("ws_turn_started_interrupt_on_next_turn", { method }, { threadId, turnId });
            void requestInterrupt(turnId);
          }
        } else if (method === "item/started") {
          const turnId = extractTurnId(params);
          if (isInterruptedTurn(turnId)) {
            emitInterruptDebug("ws_item_started_suppressed", { method }, { threadId, turnId });
            retryInterruptedTurn(turnId);
            return;
          }
          if (threadId && turnId) noteTurnStarted(threadId, turnId);
          if (turnId && !turnStartedAtMsRef.current.has(turnId)) {
            turnStartedAtMsRef.current.set(turnId, Date.now());
          }
          if (!isSelectedThread) return;
          if (threadId && params?.item?.type === "userMessage") {
            clearOptimisticUserMessages(threadId, true);
          }
          if (turnId) {
            activeTurnsRef.current.delete("external-run");
            addTurnToSet(activeTurnsRef.current, turnId);
            if (!activeTurnIdRef.current) activeTurnIdRef.current = turnId;
          }
          settleOptimisticThinking();
          const startedItem =
            params?.item?.type === "commandExecution" &&
            !normalizeItemStatusValue((params.item as { status?: unknown })?.status)
              ? { ...(params.item as Record<string, unknown>), status: "running" }
              : params.item;
          upsertItem(startedItem as ThreadItem, { status: "started", turnId: turnId ?? undefined });
        } else if (method === "item/completed") {
          const turnId = extractTurnId(params);
          if (isInterruptedTurn(turnId)) {
            emitInterruptDebug("ws_item_completed_suppressed", { method }, { threadId, turnId });
            retryInterruptedTurn(turnId);
            return;
          }
          ensureThreadTurnActive(threadId, turnId, "item/completed");
          if (!isSelectedThread) return;
          if (threadId && params?.item?.type === "userMessage") {
            clearOptimisticUserMessages(threadId, true);
          }
          if (params?.item?.type === "agentMessage" && turnId) {
            lastAgentByTurnRef.current.set(turnId, params.item.id);
          }
          const incomingStatus = normalizeItemStatusValue((params?.item as { status?: unknown } | undefined)?.status);
          const completedItem =
            params?.item?.type === "commandExecution" && (!incomingStatus || isInProgressItemStatus(incomingStatus))
              ? { ...(params.item as Record<string, unknown>), status: "completed" }
              : params.item;
          upsertItem(completedItem as ThreadItem, { status: "completed", turnId: turnId ?? undefined });
          // Item completion (including agentMessage) is not a reliable turn-terminal signal.
          // We only close turn activity on explicit turn terminal events.
        } else if (method === "turn/completed") {
          let turnId = extractTurnId(params);
          if (!turnId && threadId) {
            const trackedTurns = activeTurnsByThreadRef.current.get(threadId);
            if (trackedTurns && trackedTurns.size === 1) {
              turnId = trackedTurns.values().next().value ?? null;
            }
          }
          if (!turnId && isSelectedThread) {
            turnId =
              activeTurnIdRef.current ??
              (activeTurnsRef.current.size === 1 ? activeTurnsRef.current.values().next().value ?? null : null);
          }
          const wasTrackedActiveTurn = turnId ? turnSetHas(activeTurnsRef.current, turnId) : false;
          const turnStartedAtMs = turnId ? turnStartedAtMsRef.current.get(turnId) ?? null : null;
          const workedMs = normalizeWorkedMs(turnStartedAtMs, Date.now());
          if (turnId) turnStartedAtMsRef.current.delete(turnId);
          if (threadId && turnId) noteTurnCompleted(threadId, turnId);
          if (!isSelectedThread) return;
          clearSelectedTurnActivity(turnId);
          const id = turnId ? lastAgentByTurnRef.current.get(turnId) : null;
          if (id && wasTrackedActiveTurn) {
            updateItem(id, (item) => ({
              ...item,
              _meta: { ...item._meta, final: true, ...(workedMs ? { workedMs } : {}) },
            }));
          }
        } else if (method === "item/agentMessage/delta") {
          ensureThreadTurnActive(threadId, extractTurnId(params), "agentMessage/delta");
          if (!isSelectedThread) return;
          updateItem(params.itemId, (item) => {
            if (item.type !== "agentMessage") return item;
            return { ...item, text: `${item.text ?? ""}${params.delta ?? ""}` };
          });
        } else if (method === "item/plan/delta") {
          ensureThreadTurnActive(threadId, extractTurnId(params), "plan/delta");
          if (!isSelectedThread) return;
          updateItem(params.itemId, (item) => {
            if (item.type !== "plan") return item;
            return { ...item, text: `${item.text ?? ""}${params.delta ?? ""}` };
          });
        } else if (method === "item/commandExecution/outputDelta") {
          ensureThreadTurnActive(threadId, extractTurnId(params), "commandExecution/outputDelta");
          if (!isSelectedThread) return;
          updateItem(params.itemId, (item) => {
            if (item.type !== "commandExecution") return item;
            const output = `${item.aggregatedOutput ?? ""}${params.delta ?? ""}`;
            return { ...item, aggregatedOutput: output };
          });
        } else if (method === "item/reasoning/summaryTextDelta") {
          ensureThreadTurnActive(threadId, extractTurnId(params), "reasoning/summaryTextDelta");
          if (!isSelectedThread) return;
          updateItem(params.itemId, (item) => {
            if (item.type !== "reasoning") return item;
            const summary = [...item.summary];
            const index = Number(params.summaryIndex ?? 0);
            while (summary.length <= index) summary.push("");
            summary[index] = `${summary[index]}${params.delta ?? ""}`;
            return { ...item, summary };
          });
        } else if (method === "item/reasoning/textDelta") {
          ensureThreadTurnActive(threadId, extractTurnId(params), "reasoning/textDelta");
          if (!isSelectedThread) return;
          updateItem(params.itemId, (item) => {
            if (item.type !== "reasoning") return item;
            const content = [...item.content];
            const index = Number(params.contentIndex ?? 0);
            while (content.length <= index) content.push("");
            content[index] = `${content[index]}${params.delta ?? ""}`;
            return { ...item, content };
          });
        } else if (method === "turn/diff/updated") {
          ensureThreadTurnActive(threadId, extractTurnId(params), "turn/diff/updated");
          if (!isSelectedThread) return;
          const diff = typeof params?.diff === "string" ? params.diff : "";
          const turnId = typeof params?.turnId === "string" ? params.turnId : "";
          if (turnId && diff) {
            const files = parseUnifiedDiffFiles(diff);
            const hasFileChange = itemsRef.current.some(
              (item) => item.type === "fileChange" && item._meta?.turnId === turnId,
            );
            if (!hasFileChange) {
              upsertItem(
                { type: "turnDiff", id: `turn-diff-${turnId}`, turnId, diff, files },
                { status: "completed", turnId },
              );
            }
          }
        } else if (method === "thread/name/updated" || method === "thread/started") {
          refreshThreads();
        }
        return;
      }

      if (payload.type === "request") {
        const method = payload.method as string;
        if (method === "item/commandExecution/requestApproval") {
          respondToRequest(payload.id, { decision: "accept" });
          return;
        }
        if (method === "item/fileChange/requestApproval") {
          respondToRequest(payload.id, { decision: "accept" });
          return;
        }
        setPendingRequests((current) => [...current, { id: payload.id, method, params: payload.params }]);
        return;
      }

      if (payload.type === "error") {
        // Resume failures can happen transiently; allow retries.
        resumeRequestedAtByThreadRef.current.clear();
        const message =
          typeof payload.message === "string" && payload.message.trim()
            ? payload.message.trim()
            : "";
        if (isOutOfCreditErrorLike({ message, code: payload.code })) {
          const selectedThreadId = selectedThreadRef.current?.id ?? null;
          if (selectedThreadId) {
            forceStopTrackedRun(selectedThreadId, { outOfCredit: message });
          } else {
            setOutOfCreditMessage(formatOutOfCreditBannerMessage(message));
          }
        }
      }
    };

    socket.onclose = () => {
      if (wsRef.current !== socket) return;
      clearTimeout(connectTimeout);
      wsReadyRef.current = false;
      setStreamConnected(false);
    };
    socket.onerror = () => {
      if (wsRef.current !== socket) return;
      clearTimeout(connectTimeout);
    };
  }, [
    apiBase,
    clearSelectedTurnActivity,
    clearOptimisticUserMessages,
    emitInterruptDebug,
    ensureSubscribed,
    ensureThreadTurnActive,
    forceStopTrackedRun,
    markThreadExternallyActive,
    markThreadExternallyCompleted,
    noteThreadActivity,
    noteTurnCompleted,
    noteTurnStarted,
    refreshThreads,
    rememberThreadSeq,
    requestInterrupt,
    resetItems,
    resubscribeAll,
    settleOptimisticThinking,
    syncSelectedThread,
    syncThinking,
    upsertItem,
    updateItem,
  ]);

  useEffect(() => {
    if (!apiBase) return;
    connectWebSocket();
    return () => {
      wsRef.current?.close();
      setStreamConnected(false);
    };
  }, [apiBase]);

  const retryServerConnection = useCallback(() => {
    if (!apiBase || connectionCheckRunning) return;
    void checkServerConnection({ minVisualMs: RETRY_MIN_VISUAL_MS });
    const socket = wsRef.current;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    connectWebSocket();
  }, [apiBase, checkServerConnection, connectWebSocket, connectionCheckRunning]);

  useEffect(() => {
    if (selectedThread?.id) {
      ensureSubscribed(selectedThread.id, true, undefined, true);
    }
  }, [ensureSubscribed, selectedThread?.id]);

  useEffect(() => {
    if (!threads.length) return;
    for (const thread of threads) {
      ensureSubscribed(thread.id);
    }
  }, [ensureSubscribed, threads]);

  useEffect(() => {
    if (!selectedThread || !apiBase) return;
    const threadId = selectedThread.id;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      if (disposed) return;
      void syncSelectedThread(threadId).finally(() => {
        if (disposed) return;
        const hasTrackedActivity =
          (activeTurnsByThreadRef.current.get(threadId)?.size ?? 0) > 0 ||
          activeTurnsRef.current.size > 0 ||
          optimisticThinkingRef.current ||
          optimisticThinkingPendingRef.current;
        const nextDelay =
          optimisticThinkingRef.current || optimisticThinkingPendingRef.current
            ? IDLE_CHECK_SOFT_TIMEOUT_MS
            : hasTrackedActivity
              ? 6000
              : 30000;
        timer = setTimeout(run, nextDelay);
      });
    };
    run();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [selectedThread?.id, apiBase, syncSelectedThread]);

  useEffect(() => {
    const timer = setInterval(() => {
      const selectedId = selectedThreadRef.current?.id ?? null;
      if (!selectedId) return;
      if (stalledRunByThreadRef.current.has(selectedId)) return;
      const selected = selectedThreadRef.current;
      const hasTrackedRunActivity =
        (activeTurnsByThreadRef.current.get(selectedId)?.size ?? 0) > 0 ||
        activeTurnsRef.current.size > 0 ||
        optimisticThinkingRef.current ||
        optimisticThinkingPendingRef.current ||
        Boolean(selected && isExternalRunActive(selected));
      if (!hasTrackedRunActivity) return;
      const optimisticStartedAtMs = optimisticThinkingStartedAtMsRef.current;
      const fallbackActivityAtMs = optimisticStartedAtMs > 0 ? optimisticStartedAtMs : 0;
      const lastActivityAtMs = lastWsActivityByThreadRef.current.get(selectedId) ?? fallbackActivityAtMs;
      if (!lastActivityAtMs) return;
      if (Date.now() - lastActivityAtMs < THINKING_INACTIVITY_TIMEOUT_MS) return;
      forceStopTrackedRun(selectedId, {
        reason: "No updates for over 10 minutes. Stopped the thinking spinner.",
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [forceStopTrackedRun]);

  useEffect(() => {
    const previousThreadId = selectedThreadIdForResetRef.current;
    const nextThreadId = selectedThread?.id ?? null;
    const threadSelectionChanged = previousThreadId !== nextThreadId;
    selectedThreadRef.current = selectedThread;
    if (selectedThread?.id) {
      setUnreadCompletedThreadIds((current) => {
        if (!current.has(selectedThread.id)) return current;
        const next = new Set(current);
        next.delete(selectedThread.id);
        return next;
      });
    }
    if (threadSelectionChanged) {
      settleOptimisticThinking();
      interruptRequestedRef.current = false;
      interruptingTurnIdRef.current = null;
      interruptingActionIdRef.current = null;
      interruptOnNextTurnRef.current = false;
      interruptRetryAtByKeyRef.current.clear();
      if (interruptWatchdogTimerRef.current) {
        clearTimeout(interruptWatchdogTimerRef.current);
        interruptWatchdogTimerRef.current = null;
      }
      queuePausedRef.current = false;
      queueAutoFlushOnRunCompletionKeyRef.current = null;
      setInterrupting(false);
    }
    const activeTurns = selectedThread ? activeTurnsByThreadRef.current.get(selectedThread.id) : null;
    activeTurnsRef.current = new Set(activeTurns ?? []);
    const nextActiveTurnId = activeTurnsRef.current.values().next().value ?? null;
    activeTurnIdRef.current = nextActiveTurnId;
    selectedThreadIdForResetRef.current = nextThreadId;
    syncThinking();
  }, [selectedThread, settleOptimisticThinking, syncThinking]);

  const loadThread = async (thread: Thread) => {
    const selectionEpoch = ++selectionEpochRef.current;
    setMobileThreadPreviewId(null);
    setUnreadCompletedThreadIds((current) => {
      if (!current.has(thread.id)) return current;
      const next = new Set(current);
      next.delete(thread.id);
      return next;
    });
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) {
      setSidebarOpen(false);
    }
    setLoading(true);
    setDraftCwd(null);
    selectedThreadRef.current = thread;
    setSelectedThread(thread);
    try {
      if (!apiBase) throw new Error("Missing apiBase");
      const response = await fetch(`${apiBase}/api/threads/${thread.id}`);
      const data = await response.json();
      if (selectionEpochRef.current !== selectionEpoch) return;
      if (selectedThreadRef.current?.id !== thread.id) return;
      if (data.thread) {
        setSelectedThread(data.thread);
        if (typeof data.thread.updatedAt === "number") {
          selectedThreadUpdatedAtRef.current = data.thread.updatedAt;
        }
        selectedThreadSnapshotSignatureRef.current = buildThreadSnapshotSignature(data.thread);
      }
      const resolvedThread = (data.thread || thread) as Thread;
      resetItems(flattenThreadItems(resolvedThread));
      selectedThreadSnapshotSignatureRef.current = buildThreadSnapshotSignature(resolvedThread);
    } catch {
      if (selectionEpochRef.current !== selectionEpoch) return;
      resetItems([]);
      selectedThreadSnapshotSignatureRef.current = "0";
    } finally {
      if (selectionEpochRef.current !== selectionEpoch) return;
      setLoading(false);
    }
  };

  const handleThreadRowSelect = (thread: Thread) => {
    if (isMobileViewport && mobileThreadPreviewId !== thread.id) {
      setMobileThreadPreviewId(thread.id);
      return;
    }
    setMobileThreadPreviewId(null);
    void loadThread(thread);
  };

  const beginDraftForCwd = useCallback(
    (cwd: string | null) => {
      if (!cwd) return;
      if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) {
        setSidebarOpen(false);
      }
      selectionEpochRef.current += 1;
      setDraftCwd(cwd);
      selectedThreadRef.current = null;
      setSelectedThread(null);
      resetItems([]);
      selectedThreadSnapshotSignatureRef.current = "0";
      setLoading(false);
      setThreadError(null);
    },
    [resetItems],
  );

  const openProjectCreationDialog = useCallback(() => {
    if (!apiBase) return;
    setProjectCreationError(null);
    setNewProjectName("");
    setProjectMenuOpen(false);
    setProjectCreationOpen(true);
  }, [apiBase]);

  const closeProjectCreationDialog = useCallback(() => {
    if (projectCreationPending) return;
    setProjectCreationOpen(false);
    setProjectCreationError(null);
  }, [projectCreationPending]);

  const devServerBase = useMemo<URL | null>(() => {
    if (apiBase) {
      try {
        const parsed = new URL(apiBase);
        return parsed.hostname.trim() ? parsed : null;
      } catch {
        // Ignore malformed apiBase and fallback to window hostname in local dev.
      }
    }

    if (typeof window !== "undefined" && window.location?.hostname) {
      try {
        const parsed = new URL(window.location.href);
        return parsed.hostname.trim() ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }, [apiBase]);

  const openDevServerDialog = useCallback(() => {
    setDevServerPort("");
    setDevServerError(null);
    setDevServerDialogOpen(true);
  }, []);

  const closeDevServerDialog = useCallback(() => {
    setDevServerDialogOpen(false);
    setDevServerError(null);
  }, []);

  const openCodexSettingsDialog = useCallback(() => {
    setCodexSettingsDraft(codexPreferences);
    setCodexSettingsDialogOpen(true);
  }, [codexPreferences]);

  const closeCodexSettingsDialog = useCallback(() => {
    setCodexSettingsDialogOpen(false);
  }, []);

  const saveCodexSettingsDialog = useCallback(() => {
    setCodexPreferences(codexSettingsDraft);
    setCodexSettingsDialogOpen(false);
  }, [codexSettingsDraft]);

  const applyDevServerPortPreset = useCallback((port: string) => {
    setDevServerPort(port);
    setDevServerError(null);
  }, []);

  const submitDevServerAccess = useCallback(() => {
    if (!devServerBase) {
      setDevServerError("Server address unavailable.");
      return;
    }

    const trimmedPort = devServerPort.trim();
    const parsedPort = Number(trimmedPort);
    if (!trimmedPort || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setDevServerError("Enter a valid port between 1 and 65535.");
      return;
    }

    try {
      const targetUrl = new URL(devServerBase.toString());
      targetUrl.port = String(parsedPort);
      targetUrl.pathname = "/";
      targetUrl.search = "";
      targetUrl.hash = "";
      const opened = window.open(targetUrl.toString(), "_blank", "noopener,noreferrer");
      if (!opened) {
        setDevServerError("Popup blocked. Allow popups and try again.");
        return;
      }
      closeDevServerDialog();
    } catch {
      setDevServerError("Could not open this dev server URL.");
    }
  }, [closeDevServerDialog, devServerBase, devServerPort]);

  const canReorderProjects = reorderableProjectIds.length > 1;

  const clearProjectDragState = useCallback(() => {
    setDraggingProjectId(null);
    setProjectDropTarget(null);
  }, []);

  const handleProjectDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>, projectId: string) => {
      if (!canReorderProjects || projectId === "(unknown)") {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", projectId);
      setDraggingProjectId(projectId);
      setProjectDropTarget(null);
    },
    [canReorderProjects],
  );

  const handleProjectDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>, targetProjectId: string) => {
      if (!canReorderProjects || targetProjectId === "(unknown)") return;
      const sourceProjectId = draggingProjectId || event.dataTransfer.getData("text/plain");
      if (!sourceProjectId || sourceProjectId === targetProjectId) {
        if (projectDropTarget?.id === targetProjectId) {
          setProjectDropTarget(null);
        }
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const bounds = event.currentTarget.getBoundingClientRect();
      const placement: ProjectDropPlacement =
        event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
      setProjectDropTarget((current) => {
        if (current?.id === targetProjectId && current.placement === placement) {
          return current;
        }
        return { id: targetProjectId, placement };
      });
    },
    [canReorderProjects, draggingProjectId, projectDropTarget?.id],
  );

  const handleProjectDragLeave = useCallback((event: DragEvent<HTMLDivElement>, targetProjectId: string) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setProjectDropTarget((current) => (current?.id === targetProjectId ? null : current));
  }, []);

  const handleProjectDrop = useCallback(
    (event: DragEvent<HTMLDivElement>, targetProjectId: string) => {
      if (!canReorderProjects || targetProjectId === "(unknown)") {
        clearProjectDragState();
        return;
      }
      event.preventDefault();

      const sourceProjectId = draggingProjectId || event.dataTransfer.getData("text/plain");
      const bounds = event.currentTarget.getBoundingClientRect();
      const placement: ProjectDropPlacement =
        event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
      clearProjectDragState();
      if (!sourceProjectId || sourceProjectId === targetProjectId) return;

      setProjectOrder((current) => {
        const visibleIds = reorderableProjectIds;
        if (!visibleIds.includes(sourceProjectId) || !visibleIds.includes(targetProjectId)) {
          return current;
        }
        const reorderedVisibleIds = reorderVisibleProjectIds(
          visibleIds,
          sourceProjectId,
          targetProjectId,
          placement,
        );
        if (areStringArraysEqual(visibleIds, reorderedVisibleIds)) return current;
        const visibleIdSet = new Set(visibleIds);
        const hiddenIds = current.filter((projectId) => !visibleIdSet.has(projectId));
        return [...reorderedVisibleIds, ...hiddenIds];
      });
    },
    [canReorderProjects, clearProjectDragState, draggingProjectId, reorderableProjectIds],
  );

  const handleProjectDragEnd = useCallback(() => {
    clearProjectDragState();
  }, [clearProjectDragState]);

  const submitProjectCreation = useCallback(async () => {
    if (!apiBase || projectCreationPending) return;
    const trimmedName = newProjectName.trim();
    if (!trimmedName) {
      setProjectCreationError("Project name is required.");
      return;
    }

    setProjectCreationPending(true);
    setProjectCreationError(null);
    try {
      const response = await fetch(`${apiBase}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          typeof payload?.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : "Failed to create project.";
        setProjectCreationError(message);
        return;
      }
      const projectPath = typeof payload?.project?.path === "string" ? payload.project.path.trim() : "";
      if (!projectPath) {
        setProjectCreationError("Project created, but no path was returned.");
        return;
      }

      setProjectCreationOpen(false);
      setNewProjectName("");
      setWorkspaceRoots((current) => {
        const next = new Set(current);
        next.add(projectPath);
        return Array.from(next).sort((left, right) => left.localeCompare(right));
      });
      beginDraftForCwd(projectPath);
      void refreshThreads();
    } catch {
      setProjectCreationError("Failed to create project. Is the PocketDex server reachable?");
    } finally {
      setProjectCreationPending(false);
    }
  }, [apiBase, beginDraftForCwd, newProjectName, projectCreationPending, refreshThreads]);

  const shouldVirtualizeTimeline = !iosSimpleScrollMode && !(thinkingCount > 0 || selectedThreadHasActiveRun);

  const rowVirtualizer = useVirtualizer({
    count: visibleItems.length,
    getScrollElement: () => conversationRef.current,
    getItemKey: (index) => visibleItems[index]?.id ?? index,
    estimateSize: () => 160,
    overscan: 8,
    enabled: shouldVirtualizeTimeline,
    isScrollingResetDelay: 180,
    useScrollendEvent: true,
    useAnimationFrameWithResizeObserver: true,
  });

  const scrollToBottom = useCallback(() => {
    const container = conversationRef.current;
    if (!container) return;
    if (shouldVirtualizeTimeline && visibleItems.length > 0) {
      rowVirtualizer.scrollToIndex(visibleItems.length - 1, { align: "end" });
      return;
    }
    requestAnimationFrame(() => {
      const node = conversationRef.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
    });
  }, [rowVirtualizer, shouldVirtualizeTimeline, visibleItems.length]);

  useLayoutEffect(() => {
    if (!selectedThread) {
      initialThreadBottomLockRef.current = null;
      return;
    }
    autoScrollRef.current = true;
    initialThreadBottomLockRef.current = selectedThread.id;
    requestAnimationFrame(() => {
      scrollToBottom();
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    });
  }, [selectedThread?.id, scrollToBottom]);

  useEffect(() => {
    if (!selectedThread) return;
    const initialLockActive = initialThreadBottomLockRef.current === selectedThread.id;
    if (!autoScrollRef.current && !initialLockActive) return;
    requestAnimationFrame(() => {
      scrollToBottom();
      if (initialLockActive) {
        requestAnimationFrame(() => {
          scrollToBottom();
          initialThreadBottomLockRef.current = null;
          autoScrollRef.current = true;
        });
      }
    });
  }, [itemsVersion, selectedThread?.id, scrollToBottom]);

  useEffect(() => {
    if (!selectedThread) return;
    const initialLockActive = initialThreadBottomLockRef.current === selectedThread.id;
    if (!autoScrollRef.current && !initialLockActive) return;
    requestAnimationFrame(() => {
      scrollToBottom();
      if (initialLockActive) {
        requestAnimationFrame(() => {
          scrollToBottom();
          initialThreadBottomLockRef.current = null;
          autoScrollRef.current = true;
        });
      }
    });
  }, [composerLayout.overlap, queuedCount, selectedThread?.id, scrollToBottom, thinkingCount]);

  const handleTimelineScroll = useCallback(() => {
    const container = conversationRef.current;
    if (!container) return;
    if (selectedThreadRef.current?.id && initialThreadBottomLockRef.current === selectedThreadRef.current.id) {
      return;
    }
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    autoScrollRef.current = distance <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  }, []);

  const uploadAttachmentForThread = useCallback(
    async (
      threadId: string,
      attachment: OutgoingAttachment,
    ): Promise<{ type: "localImage"; path: string } | { type: "mention"; name: string; path: string }> => {
      if (!apiBase) throw new Error("Missing apiBase");
      if (!(attachment.file instanceof File)) throw new Error("Attachment file is missing");
      const fileName = attachment.name?.trim() || attachment.file.name?.trim() || "attachment.bin";
      const kind: "image" | "file" = attachment.kind === "image" ? "image" : "file";
      const uploadUrl =
        `${apiBase}/api/attachments/upload` +
        `?threadId=${encodeURIComponent(threadId)}` +
        `&name=${encodeURIComponent(fileName)}` +
        `&kind=${encodeURIComponent(kind)}`;
      const contentType =
        attachment.mimeType?.trim() || attachment.file.type?.trim() || "application/octet-stream";
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: attachment.file,
      });
      if (!response.ok) {
        throw new Error(`Upload failed (${response.status})`);
      }
      const payload = await response.json();
      const uploaded = payload?.attachment;
      if (!uploaded || typeof uploaded !== "object") {
        throw new Error("Upload response missing attachment");
      }
      if (
        uploaded.type === "localImage" &&
        typeof uploaded.path === "string" &&
        uploaded.path.trim()
      ) {
        return { type: "localImage", path: uploaded.path };
      }
      if (
        uploaded.type === "mention" &&
        typeof uploaded.path === "string" &&
        uploaded.path.trim()
      ) {
        const name =
          typeof uploaded.name === "string" && uploaded.name.trim()
            ? uploaded.name.trim()
            : fileName;
        return { type: "mention", name, path: uploaded.path };
      }
      throw new Error("Upload response has unsupported attachment shape");
    },
    [apiBase],
  );

  const sendNow = useCallback(
    async (
      text: string,
      modelValue: string,
      attachments: OutgoingAttachment[] = [],
      options?: {
        skipOptimistic?: boolean;
        optimisticMessageId?: string | null;
        preserveOptimisticOnFailure?: boolean;
      },
    ) => {
      const trimmedText = text.trim();
      if ((!trimmedText && attachments.length === 0) || !apiBase) return false;
      setSending(true);
      setSendError(null);
      setThreadError(null);
      let creatingThread = false;
      const queueKeyAtSend = currentQueueKey;
      let sendThreadId: string | null = null;
      let optimisticMessageId: string | null = null;
      try {
        const selection = parseModelSelection(modelValue);
        const threadStartSecurity = resolveThreadStartSecurityPreferences(codexPreferences);
        let threadId = selectedThread?.id ?? null;
        if (!threadId) {
          if (!draftCwd) {
            setSendError("Select a project to start a new thread.");
            return false;
          }
          const fallbackCwd = draftCwd;
          creatingThread = true;
          const response = await fetch(`${apiBase}/api/threads`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              cwd: draftCwd,
              model: selection.model ?? undefined,
              approvalPolicy: threadStartSecurity.approvalPolicy,
              sandbox: threadStartSecurity.sandbox,
            }),
          });
          if (!response.ok) {
            throw new Error(`Request failed (${response.status})`);
          }
          const data = await response.json();
          const newThread = data.thread as Thread | null;
          if (!newThread?.id) {
            throw new Error("Missing thread ID");
          }
          const normalizedNewThread = normalizeThreadForImmediateInsertion(newThread, fallbackCwd);
          threadId = normalizedNewThread.id;
          creatingThread = false;
          setDraftCwd(null);
          setSelectedThread(normalizedNewThread);
          rememberPendingThreadHydration(normalizedNewThread);
          upsertThreadForSidebar(normalizedNewThread);
          if (fallbackCwd) {
            setWorkspaceRoots((current) => {
              const normalized = fallbackCwd.trim();
              if (!normalized) return current;
              if (current.includes(normalized)) return current;
              return [...current, normalized].sort((left, right) => left.localeCompare(right));
            });
          }
          resetItems([]);
          if (typeof normalizedNewThread.updatedAt === "number") {
            selectedThreadUpdatedAtRef.current = normalizedNewThread.updatedAt;
          }
          ensureSubscribed(threadId, true, undefined, true);
          migrateQueue(queueKeyAtSend, `thread:${threadId}`);
          refreshThreads();
        }
        sendThreadId = threadId;
        if (!sendThreadId) {
          throw new Error("Missing thread ID");
        }
        if (options?.skipOptimistic) {
          optimisticMessageId = options.optimisticMessageId ?? null;
        } else {
          optimisticMessageId = addOptimisticUserMessage(sendThreadId, trimmedText, attachments);
        }
        beginOptimisticThinking();
        const preparedAttachments: Array<
          { type: "localImage"; path: string } | { type: "mention"; name: string; path: string }
        > = [];
        const encodedAttachments: OutgoingAttachment[] = [];
        for (const attachment of attachments) {
          if (attachment.file instanceof File) {
            const uploaded = await uploadAttachmentForThread(threadId, attachment);
            preparedAttachments.push(uploaded);
            continue;
          }
          const dataBase64 = typeof attachment.dataBase64 === "string" ? attachment.dataBase64.trim() : "";
          if (!dataBase64) continue;
          encodedAttachments.push({
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            kind: attachment.kind,
            dataBase64,
          });
        }
        const response = await fetch(`${apiBase}/api/threads/${threadId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: trimmedText,
            model: selection.model,
            effort: selection.effort,
            approvalPolicy: threadStartSecurity.approvalPolicy,
            sandbox: threadStartSecurity.sandbox,
            attachments: encodedAttachments,
            preparedAttachments,
          }),
        });
        if (!response.ok) {
          let errorMessage = "";
          let errorCode = "";
          try {
            const payload = (await response.json()) as { error?: unknown; code?: unknown };
            if (typeof payload?.error === "string" && payload.error.trim()) {
              errorMessage = payload.error.trim();
            }
            if (typeof payload?.code === "string" && payload.code.trim()) {
              errorCode = payload.code.trim();
            }
          } catch {
            // ignore malformed/non-JSON response bodies
          }
          if (errorCode === "EXTERNAL_SURFACE_RUN") {
            throw new Error(
              "You cannot steer because the current run was started on another Codex surface. The queued message will send when that run completes.",
            );
          }
          throw new Error(errorMessage || `Failed to send (HTTP ${response.status}).`);
        }
        ensureSubscribed(threadId, true, undefined, true);
        if (selectedThreadRef.current?.id === threadId) {
          void syncSelectedThread(threadId, { force: true });
          schedulePostSendThreadHeals(threadId);
        }
        setOutOfCreditMessage(null);
        return true;
      } catch (error) {
        const fallbackMessage = creatingThread
          ? "Failed to start a new thread. Is the PocketDex server reachable?"
          : "Failed to send. Is the PocketDex server running?";
        const resolvedMessage =
          error instanceof Error && error.message.trim() ? error.message.trim() : fallbackMessage;
        if (isOutOfCreditErrorLike({ message: resolvedMessage })) {
          if (sendThreadId) {
            forceStopTrackedRun(sendThreadId, { outOfCredit: resolvedMessage });
          } else {
            setOutOfCreditMessage(formatOutOfCreditBannerMessage(resolvedMessage));
          }
        }
        if (creatingThread) {
          setThreadError(resolvedMessage);
        } else {
          setSendError(resolvedMessage);
        }
        settleOptimisticThinking();
        if (sendThreadId && optimisticMessageId && !options?.preserveOptimisticOnFailure) {
          clearOptimisticUserMessages(sendThreadId, true);
        }
        return false;
      } finally {
        setSending(false);
      }
    },
    [
      apiBase,
      codexPreferences,
      currentQueueKey,
      draftCwd,
      addOptimisticUserMessage,
      beginOptimisticThinking,
      clearOptimisticUserMessages,
      ensureSubscribed,
      forceStopTrackedRun,
      migrateQueue,
      rememberPendingThreadHydration,
      refreshThreads,
      resetItems,
      schedulePostSendThreadHeals,
      selectedThread,
      settleOptimisticThinking,
      syncSelectedThread,
      upsertThreadForSidebar,
      uploadAttachmentForThread,
    ],
  );

  const flushQueue = useCallback(async (options?: { allowBusy?: boolean }) => {
    if (!currentQueueKey || queuePausedRef.current) return;
    const allowBusy = options?.allowBusy === true;
    if (sending) return;
    if (!allowBusy && (thinkingCount > 0 || interrupting || selectedThreadHasActiveRun)) return;
    const queue = sendQueueRef.current.get(currentQueueKey);
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    updateQueueState(currentQueueKey);
    if (!next) return;
    const ok = await sendNow(next.text, next.modelValue, next.attachments, {
      skipOptimistic: Boolean(next.optimisticMessageId),
      optimisticMessageId: next.optimisticMessageId,
      preserveOptimisticOnFailure: true,
    });
    if (!ok) {
      queue.unshift(next);
      queuePausedRef.current = true;
      updateQueueState(currentQueueKey);
    }
  }, [currentQueueKey, interrupting, selectedThreadHasActiveRun, sending, thinkingCount, updateQueueState, sendNow]);

  const handleSend = useCallback(
    (text: string, modelValue: string, attachments: OutgoingAttachment[] = []) => {
      if ((!text.trim() && attachments.length === 0) || !apiBase) return;
      setSendError(null);
      setThreadError(null);
      queuePausedRef.current = false;
      const queueKey = currentQueueKey;
      if (!queueKey) return;
      const queueLength = sendQueueRef.current.get(queueKey)?.length ?? 0;
      const selectedId = selectedThread?.id;
      const isLocallyBusy =
        sending ||
        thinkingCount > 0 ||
        interrupting ||
        selectedThreadHasActiveRun ||
        optimisticThinkingRef.current ||
        optimisticThinkingPendingRef.current ||
        activeTurnsRef.current.size > 0 ||
        (selectedId ? activeThreadIds.has(selectedId) : false);
      if (isLocallyBusy || queueLength > 0) {
        enqueueSend(text, modelValue, attachments, queueKey, {
          threadId: selectedId ?? null,
          addOptimistic: true,
        });
        return;
      }
      void sendNow(text, modelValue, attachments);
    },
    [
      activeThreadIds,
      apiBase,
      currentQueueKey,
      enqueueSend,
      interrupting,
      sendNow,
      sending,
      selectedThread?.id,
      selectedThreadHasActiveRun,
      thinkingCount,
    ],
  );

  useEffect(() => {
    const runBusy = thinkingCount > 0 || interrupting || selectedThreadHasActiveRun;
    if (runBusy) {
      queueAutoFlushOnRunCompletionKeyRef.current = currentQueueKey;
      return;
    }
    const armedQueueKey = queueAutoFlushOnRunCompletionKeyRef.current;
    if (!armedQueueKey || !currentQueueKey || armedQueueKey !== currentQueueKey) return;
    queueAutoFlushOnRunCompletionKeyRef.current = null;
    if (queuePausedRef.current) return;
    const queueLength = sendQueueRef.current.get(currentQueueKey)?.length ?? 0;
    if (queueLength <= 0) return;
    void flushQueue();
  }, [currentQueueKey, flushQueue, interrupting, selectedThreadHasActiveRun, thinkingCount]);

  const handleSteerNow = useCallback(() => {
    if (!currentQueueKey) return;
    const queueLength = sendQueueRef.current.get(currentQueueKey)?.length ?? 0;
    if (queueLength <= 0) return;
    queuePausedRef.current = false;
    if (selectedThreadHasExternalSurfaceRun) {
      setSendError(
        "You cannot steer because the current run was started on another Codex surface. The queued message will send when that run completes.",
      );
      return;
    }
    if (!steerEnabled && (thinkingCount > 0 || selectedThreadHasActiveRun)) {
      setSendError("Steer is disabled in your Codex config. Enable `features.steer` to send during a run.");
      return;
    }
    void flushQueue({ allowBusy: true });
  }, [currentQueueKey, flushQueue, selectedThreadHasActiveRun, selectedThreadHasExternalSurfaceRun, steerEnabled, thinkingCount]);

  const handleRemoveQueuedSend = useCallback(
    (id: string) => {
      if (!currentQueueKey) return;
      removeQueuedSend(id, currentQueueKey);
    },
    [currentQueueKey, removeQueuedSend],
  );

  const handleEditQueuedSend = useCallback(
    (id: string): QueuedComposerDraft | null => {
      if (!currentQueueKey) return null;
      const removed = removeQueuedSend(id, currentQueueKey);
      if (!removed) return null;
      return {
        text: removed.text,
        modelValue: removed.modelValue,
        attachments: removed.attachments,
      };
    },
    [currentQueueKey, removeQueuedSend],
  );

  const respondToRequest = useCallback((requestId: number, result?: unknown, errorMessage?: string) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== 1) return;
    if (errorMessage) {
      socket.send(JSON.stringify({ type: "response_error", id: requestId, message: errorMessage }));
    } else {
      socket.send(JSON.stringify({ type: "response", id: requestId, result: result ?? {} }));
    }
    setPendingRequests((current) => current.filter((req) => req.id !== requestId));
  }, []);

  const handleStop = useCallback(() => {
    queuePausedRef.current = false;
    emitInterruptDebug("stop_button_clicked", {
      thinkingCount,
      interrupting,
      selectedThreadHasActiveRun,
      interruptSingleShotMode,
    });
    void requestInterrupt();
  }, [emitInterruptDebug, interruptSingleShotMode, interrupting, requestInterrupt, selectedThreadHasActiveRun, thinkingCount]);

  useEffect(() => {
    const selectedThreadId = selectedThreadRef.current?.id ?? null;
    if (!selectedThreadId) return;
    const signature = [
      thinkingCount,
      interrupting ? 1 : 0,
      selectedThreadHasActiveRun ? 1 : 0,
      interruptRequestedRef.current ? 1 : 0,
      activeTurnsRef.current.size,
      activeTurnIdRef.current ?? "",
      interruptingTurnIdRef.current ?? "",
    ].join("|");
    if (interruptDebugBusySignatureRef.current === signature) return;
    interruptDebugBusySignatureRef.current = signature;
    emitInterruptDebug(
      "ui_busy_state_changed",
      {
        thinkingCount,
        interrupting,
        selectedThreadHasActiveRun,
      },
      { threadId: selectedThreadId, turnId: activeTurnIdRef.current },
    );
  }, [emitInterruptDebug, interrupting, selectedThreadHasActiveRun, thinkingCount]);

  const isBusy = thinkingCount > 0 || interrupting || selectedThreadHasActiveRun;
  const suppressFinalMarkers = isBusy || Boolean(selectedThread && activeThreadIds.has(selectedThread.id));
  const fallbackFinalMessageId = useMemo(() => {
    if (suppressFinalMarkers || !selectedThread) return null;
    const turns = selectedThread.turns ?? [];
    const latestTurn = turns[turns.length - 1];
    if (!latestTurn?.id || !isTurnTerminalStatus(latestTurn)) return null;
    for (let index = visibleItems.length - 1; index >= 0; index -= 1) {
      const row = visibleItems[index];
      if (row._meta?.turnId !== latestTurn.id) continue;
      if (row.type !== "agentMessage") continue;
      if (row._meta?.final) return null;
      return row.id;
    }
    return null;
  }, [itemsVersion, selectedThread, suppressFinalMarkers, visibleItems]);
  const isThreadActive = (threadId: string) =>
    !stalledRunByThreadId.has(threadId) &&
    (activeThreadIds.has(threadId) ||
      (selectedThread?.id === threadId && (thinkingCount > 0 || selectedThreadHasActiveRun)));
  const isThreadUnreadCompleted = (threadId: string) =>
    unreadCompletedThreadIds.has(threadId) && selectedThread?.id !== threadId;
  const showStartupSync = threadsBootstrapping;
  const startupSyncLabel = "Indexing...";
  const remoteConnected = Boolean(apiBase) && serverReachable === true;
  const remoteChecking = Boolean(apiBase) && (connectionCheckRunning || serverReachable === null);
  const apiHostLabel = useMemo(() => {
    if (!apiBase) return null;
    try {
      const url = new URL(apiBase);
      const host = (url.hostname || "").trim();
      return host ? host.replace(/\.local$/i, "") : null;
    } catch {
      return null;
    }
  }, [apiBase]);
  const remoteDeviceLabel = (serverDeviceName || apiHostLabel || "").replace(/\.local$/i, "");
  const devServerHostLabel = devServerBase?.hostname ?? null;
  const remoteStatusText = !apiBase
    ? "API missing"
    : remoteChecking
      ? "Reconnecting..."
      : remoteConnected
        ? `Connected to ${remoteDeviceLabel || "server"}`
        : "Connection failed";
  const archiveConfirmArchiving =
    archiveConfirmTarget ? archivingThreadIds.has(archiveConfirmTarget.threadId) : false;
  const archiveConfirmTitle = (archiveConfirmTarget?.title || "").trim() || "Untitled conversation";

  const contentWidthClass = sidebarOpen
    ? "w-full md:mx-auto md:max-w-[700px]"
    : "w-full md:mx-auto md:max-w-[750px]";
  const hasTimelineContent = visibleItems.length > 0 || items.length > 0 || loading;
  const conversationStyle = useMemo<CSSProperties | undefined>(() => {
    if (!isMobileViewport) return undefined;

    const composerInset = composerLayout.overlap > 0 ? composerLayout.overlap : composerLayout.height;
    const bottomInset = Math.max(composerInset + MOBILE_TIMELINE_BOTTOM_CLEARANCE_PX, 0);

    const base: CSSProperties = {
      paddingBottom: `${bottomInset}px`,
      scrollPaddingBottom: `${bottomInset}px`,
      WebkitMaskImage: "none",
      maskImage: "none",
    };

    if (!hasTimelineContent) {
      return {
        ...base,
        paddingBottom: "24px",
        scrollPaddingBottom: "24px",
      };
    }
    return base;
  }, [composerLayout.height, composerLayout.overlap, hasTimelineContent, isMobileViewport]);
  const projectMenuId = "project-switcher-menu";
  const resolvedProjectLabel = activeThread ? projectLabelFromThread(activeThread) : grouped[0]?.label ?? null;
  const hasResolvedProjectLabel = Boolean(resolvedProjectLabel);
  const projectLabel = resolvedProjectLabel ?? "";
  const activeProjectId = activeThread ? projectGroupInfo(activeThread).id : null;
  const canSwitchProject = !selectedThread && grouped.length > 0;
  const showSidebarThreadSkeleton = threadsBootstrapping && grouped.length === 0;
  const showProjectDiscoveryLoader = !selectedThread && !projectDiscoverySettled;
  const showNoProjectsFallback = !selectedThread && grouped.length === 0 && projectDiscoverySettled;
  const showChooseProjectHint =
    !showNoProjectsFallback && !selectedThread && !draftCwd && !hasResolvedProjectLabel;
  const letsBuildHintText = showNoProjectsFallback
    ? "Waiting for projects to appear. Keep this page open while syncing."
    : showChooseProjectHint
      ? "Choose a project in the sidebar to set the working directory."
      : null;
  const projectDiscoveryLabel = "Syncing your projects";

  const renderProjectSwitcher = () => {
    if (!canSwitchProject) {
      if (!hasResolvedProjectLabel) {
        if (!projectDiscoverySettled) {
          return <div className="project-label-skeleton mt-2" aria-hidden="true" />;
        }
        return (
          <div className="mt-2 text-[12px] font-mono uppercase tracking-[0.15em] text-white/45">
            No project detected yet
          </div>
        );
      }
      return <div className="mt-2 text-xl font-display text-white/45">{projectLabel}</div>;
    }
    return (
      <div className="relative mt-2 flex justify-center" ref={projectMenuRef}>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={projectMenuOpen}
          aria-controls={projectMenuId}
          aria-label="Change project"
          className="group inline-flex max-w-full items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xl font-display text-white/55 transition hover:border-white/30 hover:bg-white/10 hover:text-white/85 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
          onClick={() => setProjectMenuOpen((value) => !value)}
        >
          <span className="max-w-[260px] truncate">{projectLabel || grouped[0]?.label}</span>
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform duration-150 ${projectMenuOpen ? "-rotate-90" : "rotate-90"}`}
            strokeWidth={2}
          />
        </button>
        {projectMenuOpen ? (
          <div
            id={projectMenuId}
            role="listbox"
            className="absolute left-1/2 top-full z-20 mt-3 w-[280px] -translate-x-1/2 rounded-2xl border border-white/10 bg-black/80 p-2 text-left shadow-xl backdrop-blur"
          >
            {grouped.length ? (
              <div className="space-y-1">
                {grouped.map((group) => {
                  const isActive = activeProjectId === group.id;
                  const isDisabled = !group.cwd;
                  return (
                    <button
                      key={group.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      disabled={isDisabled}
                      className={`flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition ${
                        isDisabled
                          ? "cursor-not-allowed text-white/30"
                          : isActive
                            ? "bg-white/10 text-white"
                            : "text-white/70 hover:bg-white/5 hover:text-white"
                      }`}
                      onClick={() => {
                        if (!group.cwd) return;
                        beginDraftForCwd(group.cwd);
                        setProjectMenuOpen(false);
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold">{group.label}</div>
                        <div
                          className={`mt-1 truncate text-[10px] uppercase tracking-[0.2em] ${
                            group.cwd ? "text-white/35" : "text-white/25"
                          }`}
                        >
                          {group.cwd ? shortenPath(group.cwd) : "Missing working directory"}
                        </div>
                      </div>
                      {isActive ? (
                        <span className="mt-1 text-[10px] uppercase tracking-[0.2em] text-white/50">
                          Active
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-3 py-2 text-[11px] text-white/50">No projects yet</div>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  const renderProjectDiscovery = () => (
    <div className="project-discovery-panel" role="status" aria-live="polite" aria-busy="true">
      <div className="project-discovery-label">{projectDiscoveryLabel}</div>
      <div className="project-discovery-track" aria-hidden="true" />
      <div className="project-discovery-dots" aria-hidden="true">
        <span className="project-discovery-dot" />
        <span className="project-discovery-dot" />
        <span className="project-discovery-dot" />
      </div>
    </div>
  );

  return (
    <div
      className={`relative isolate h-screen min-h-screen w-full max-w-full overflow-hidden overscroll-none md:grid md:transition-[grid-template-columns] md:duration-200 ${
        sidebarOpen ? "md:grid-cols-[300px_1fr]" : "md:grid-cols-[0px_1fr]"
      }`}
    >
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm touch-none md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <aside
        className={`sidebar-gradient fixed inset-y-0 left-0 z-40 flex min-h-0 w-[80vw] max-w-[300px] flex-col gap-5 border-r border-white/10 px-5 pb-6 pt-[calc(env(safe-area-inset-top)+1.5rem)] text-white shadow-lg transition-all duration-200 md:static md:z-auto md:h-full md:w-auto md:max-w-none md:gap-4 md:py-5 ${
          sidebarOpen ? "translate-x-0 opacity-100" : "-translate-x-full opacity-0 pointer-events-none"
        } ${sidebarOpen ? "md:translate-x-0 md:opacity-100 md:pointer-events-auto md:px-[0.875rem]" : "md:-translate-x-3 md:opacity-0 md:pointer-events-none md:px-0"}`}
      >
        <div className="min-w-0 w-full">
          <div className="flex items-center justify-between gap-4 md:gap-3">
            <div className="font-display text-2xl tracking-tight md:text-[22px]">PocketDex</div>
            <button
              type="button"
              aria-label="Collapse sidebar"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/70 transition hover:border-white/30 hover:bg-white/10 hover:text-white"
              onClick={() => setSidebarOpen(false)}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12" strokeLinecap="round" />
                <path d="M18 6l-12 12" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div>
            {showStartupSync ? (
              <div className="mt-1 flex items-center gap-1.5 text-[12px] uppercase tracking-[0.18em] text-white/45 md:text-[13px]">
                <Loader2 className="h-3 w-3 animate-spin text-white/55" style={SYNC_SPINNER_STYLE} strokeWidth={2} />
                <span>{startupSyncLabel}</span>
              </div>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-2 text-[10px] font-normal tracking-[0.01em] text-white/52 md:text-[11px]">
                <span
                  className={`h-1 w-1 rounded-full ${
                    remoteChecking
                      ? "animate-pulse bg-white/50 shadow-[0_0_3px_rgba(255,255,255,0.35)]"
                      : remoteConnected
                        ? "bg-emerald-400 shadow-[0_0_3px_rgba(74,222,128,0.6)]"
                        : "bg-rose-400 shadow-[0_0_3px_rgba(251,113,133,0.45)]"
                  }`}
                />
                <span className="inline-block max-w-[220px] whitespace-normal break-words text-left leading-[1.15] md:max-w-[236px]">
                  {remoteStatusText}
                </span>
              </div>
              <button
                type="button"
                aria-label="Retry connection"
                title="Retry connection"
                className={`inline-flex h-4 w-4 self-center items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-45 ${
                  remoteChecking ? "text-white/22" : "text-white/28 hover:text-white/50"
                }`}
                disabled={!apiBase || connectionCheckRunning}
                onClick={() => retryServerConnection()}
              >
                <RotateCw className={`h-2 w-2 ${connectionCheckRunning ? "animate-spin" : ""}`} strokeWidth={2} />
              </button>
            </div>
          </div>
        </div>

        {pinnedThreads.length ? (
          <div className="space-y-2 md:space-y-1.5">
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45 md:text-[12px]">Pinned Threads</div>
            {pinnedThreads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                pinned
                selected={selectedThread?.id === thread.id}
                active={isThreadActive(thread.id)}
                unreadCompleted={isThreadUnreadCompleted(thread.id)}
                archiving={archivingThreadIds.has(thread.id)}
                isMobileViewport={isMobileViewport}
                previewActive={mobileThreadPreviewId === thread.id}
                onSelect={() => handleThreadRowSelect(thread)}
                onTogglePin={handleThreadRowTogglePin}
                onArchive={handleThreadRowArchive}
              />
            ))}
          </div>
        ) : null}

        <div
          ref={sidebarScrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y pr-1 md:pr-0.5 [-webkit-overflow-scrolling:touch]"
        >
          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              className="group inline-flex flex-1 items-center justify-between gap-3 rounded-xl border border-sky-200/35 bg-sky-200/[0.07] px-3 py-2 text-left text-[12px] text-white/88 transition hover:border-sky-100/55 hover:bg-sky-100/[0.12] hover:text-white md:text-[13px]"
              onClick={() => openDevServerDialog()}
            >
              <span className="font-semibold tracking-[0.01em]">Access dev server</span>
              <span className="text-[10px] uppercase tracking-[0.16em] text-white/55 md:text-[11px]">Open</span>
            </button>
            <button
              type="button"
              aria-label="Codex settings"
              title="Codex settings"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-white/[0.06] text-white/78 transition hover:border-white/35 hover:bg-white/[0.12] hover:text-white"
              onClick={() => openCodexSettingsDialog()}
            >
              <Settings2 className="h-4 w-4" strokeWidth={2.1} />
            </button>
          </div>
          <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.25em] text-white/50 md:text-[12px]">
            <div>Threads</div>
          </div>

          <div className="mt-2 space-y-2 md:mt-1.5 md:space-y-1.5">
            {showSidebarThreadSkeleton ? (
              <div className="thread-skeleton-stack" aria-hidden="true">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div
                    key={`thread-skeleton-${index}`}
                    className="thread-skeleton-row"
                    style={{ animationDelay: `${index * 72}ms` }}
                  >
                    <div className="thread-skeleton-header">
                      <span className="thread-skeleton-dot" />
                      <span className="thread-skeleton-line thread-skeleton-line-title" />
                      <span className="thread-skeleton-line thread-skeleton-line-count" />
                    </div>
                    <span className="thread-skeleton-line thread-skeleton-line-item" />
                    <span className="thread-skeleton-line thread-skeleton-line-item short" />
                  </div>
                ))}
              </div>
            ) : (
              grouped.map((group, groupIndex) => {
                const isExpanded = expandedProjects[group.id] ?? false;
                const isProjectCollapsed = collapsedProjects[group.id] ?? false;
                const visibleLimit = Math.max(0, PROJECT_THREAD_LIMIT - group.pinnedThreads.length);
                const visibleThreads = isExpanded ? group.threads : group.threads.slice(0, visibleLimit);
                const canToggle = group.threads.length > visibleLimit;
                const hasActiveThreadInGroup =
                  group.pinnedThreads.some((thread) => isThreadActive(thread.id)) ||
                  group.threads.some((thread) => isThreadActive(thread.id));
                const showCollapsedGroupSpinner = isProjectCollapsed && hasActiveThreadInGroup;
                const isReorderableGroup = canReorderProjects && group.id !== "(unknown)";
                const isDropBefore =
                  projectDropTarget?.id === group.id &&
                  projectDropTarget.placement === "before" &&
                  draggingProjectId !== group.id;
                const isDropAfter =
                  projectDropTarget?.id === group.id &&
                  projectDropTarget.placement === "after" &&
                  draggingProjectId !== group.id;
                return (
                  <div
                    className="project-group-reveal space-y-1 md:space-y-0.5"
                    key={group.id}
                    style={{ animationDelay: `${Math.min(groupIndex, 10) * 46}ms` }}
                  >
                    <div
                      className={`relative flex min-h-[32px] items-center justify-between gap-2 rounded-md transition-colors md:min-h-[28px] md:gap-1.5 ${
                        isDropBefore || isDropAfter ? "bg-sky-300/[0.05]" : ""
                      }`}
                      onDragOver={(event) => handleProjectDragOver(event, group.id)}
                      onDragLeave={(event) => handleProjectDragLeave(event, group.id)}
                      onDrop={(event) => handleProjectDrop(event, group.id)}
                    >
                      {isDropBefore ? (
                        <div className="pointer-events-none absolute -top-[2px] left-3 right-3 h-[3px] rounded-full bg-sky-200/90 shadow-[0_0_0_1px_rgba(125,211,252,0.55),0_0_18px_rgba(56,189,248,0.55)]" />
                      ) : null}
                      <button
                        className="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-[14px] font-semibold leading-none text-white/90 transition hover:bg-white/5 focus-visible:bg-white/5 md:gap-1.5 md:px-1 md:py-1 md:text-[15px]"
                        onClick={() => setCollapsedProjects((prev) => ({ ...prev, [group.id]: !prev[group.id] }))}
                        draggable={isReorderableGroup}
                        onDragStart={(event) => handleProjectDragStart(event, group.id)}
                        onDragEnd={handleProjectDragEnd}
                        title={group.id}
                      >
                        <span className="relative flex h-4 w-4 items-center justify-center">
                          <FolderOpen
                            className="h-3.5 w-3.5 text-white/45 transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
                            strokeWidth={1.8}
                          />
                          <ChevronRight
                            className={`absolute h-3 w-3 text-white/70 transition-all duration-150 ${
                              isProjectCollapsed ? "rotate-0" : "rotate-90"
                            } opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100`}
                            strokeWidth={2}
                          />
                        </span>
                        <span className="truncate">{group.label}</span>
                        {showCollapsedGroupSpinner ? (
                          <span
                            className="flex h-3.5 w-3.5 items-center justify-center text-white/55"
                            title="Active thread in this project"
                            aria-label="Active thread in this project"
                          >
                            <Loader2 className="h-3 w-3 animate-spin" style={SYNC_SPINNER_STYLE} strokeWidth={2} />
                          </span>
                        ) : null}
                        <span className="text-[12px] tabular-nums text-white/40 md:text-[13px]">{group.totalCount}</span>
                      </button>
                      <div className="flex shrink-0 items-center">
                        <button
                          type="button"
                          aria-label={`New thread in ${group.label}`}
                          title={group.cwd ? `New thread in ${group.cwd}` : "Missing working directory"}
                          disabled={!group.cwd || !apiBase}
                          className={`flex h-6 w-6 items-center justify-center text-[12px] transition-colors md:h-5 md:w-5 md:text-[13px] ${
                            group.cwd && apiBase
                              ? "text-white/55 hover:text-white/85"
                              : "cursor-not-allowed text-white/25"
                          }`}
                          onClick={() => beginDraftForCwd(group.cwd)}
                        >
                          <SquarePen className="h-3.5 w-3.5" strokeWidth={1.7} />
                        </button>
                      </div>
                      {isDropAfter ? (
                        <div className="pointer-events-none absolute -bottom-[2px] left-3 right-3 h-[3px] rounded-full bg-sky-200/90 shadow-[0_0_0_1px_rgba(125,211,252,0.55),0_0_18px_rgba(56,189,248,0.55)]" />
                      ) : null}
                    </div>

                    {!isProjectCollapsed ? (
                      <>
                        {group.pinnedThreads.length ? (
                          <div className="space-y-1 md:space-y-0.5">
                            {group.pinnedThreads.map((thread) => (
                              <ThreadRow
                                key={thread.id}
                                thread={thread}
                                pinned
                                selected={selectedThread?.id === thread.id}
                                active={isThreadActive(thread.id)}
                                unreadCompleted={isThreadUnreadCompleted(thread.id)}
                                archiving={archivingThreadIds.has(thread.id)}
                                isMobileViewport={isMobileViewport}
                                previewActive={mobileThreadPreviewId === thread.id}
                                onSelect={() => handleThreadRowSelect(thread)}
                                onTogglePin={handleThreadRowTogglePin}
                                onArchive={handleThreadRowArchive}
                              />
                            ))}
                          </div>
                        ) : null}
                        {visibleThreads.length ? (
                          <div className={`${group.pinnedThreads.length ? "mt-1.5" : ""} space-y-1 md:space-y-0.5`}>
                            {visibleThreads.map((thread) => (
                              <ThreadRow
                                key={thread.id}
                                thread={thread}
                                pinned={false}
                                selected={selectedThread?.id === thread.id}
                                active={isThreadActive(thread.id)}
                                unreadCompleted={isThreadUnreadCompleted(thread.id)}
                                archiving={archivingThreadIds.has(thread.id)}
                                isMobileViewport={isMobileViewport}
                                previewActive={mobileThreadPreviewId === thread.id}
                                onSelect={() => handleThreadRowSelect(thread)}
                                onTogglePin={handleThreadRowTogglePin}
                                onArchive={handleThreadRowArchive}
                              />
                            ))}
                          </div>
                        ) : null}
                        {canToggle ? (
                          <button
                            type="button"
                            className={`${group.pinnedThreads.length || visibleThreads.length ? "mt-1.5" : ""} text-[13px] font-medium text-white/45 transition hover:text-white/80 md:text-[14px]`}
                            onClick={() =>
                              setExpandedProjects((prev) => ({ ...prev, [group.id]: !isExpanded }))
                            }
                          >
                            {isExpanded ? "Show less" : "Show more"}
                          </button>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                );
              })
            )}
            <button
              type="button"
              aria-label="Create a new project"
              disabled={!apiBase || projectCreationPending}
              className={`mt-2 flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[13px] font-semibold uppercase tracking-[0.16em] transition md:mt-1.5 md:text-[14px] ${
                apiBase && !projectCreationPending
                  ? "border-white/15 bg-white/[0.035] text-white/72 hover:border-white/30 hover:bg-white/[0.08] hover:text-white/92"
                  : "cursor-not-allowed border-white/10 bg-white/[0.02] text-white/30"
              }`}
              onClick={openProjectCreationDialog}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2.1} />
              <span>{projectCreationPending ? "Creating..." : "New Project"}</span>
            </button>
          </div>
        </div>
      </aside>

      <main
        className={`main-surface relative flex h-full min-w-0 flex-col overflow-hidden transition-opacity duration-200 ${
          sidebarOpen ? "opacity-0 pointer-events-none md:opacity-100 md:pointer-events-auto" : "opacity-100"
        }`}
      >
        {!sidebarOpen ? (
          <button
            type="button"
            aria-label="Open sidebar"
            className="fixed left-4 top-[calc(env(safe-area-inset-top)+1rem)] z-20 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white/80 backdrop-blur transition hover:border-white/30 hover:bg-black/60 hover:text-white md:absolute md:left-6 md:top-6"
            onClick={() => setSidebarOpen(true)}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 6h16" strokeLinecap="round" />
              <path d="M4 12h16" strokeLinecap="round" />
              <path d="M4 18h16" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
        <div className={`flex min-h-0 flex-1 flex-col ${contentWidthClass}`}>
          {threadError ? (
            <div className="border-b border-rose-400/20 bg-rose-500/10 px-4 py-2 text-[14px] text-rose-100 md:px-6 md:text-[15px]">
              {threadError}
            </div>
          ) : null}
          {outOfCreditMessage ? (
            <div className="border-b border-rose-300/30 bg-[linear-gradient(135deg,rgba(120,17,32,0.52),rgba(51,20,20,0.72))] px-4 py-2 md:px-6">
              <div className="flex items-center gap-2 text-[14px] text-rose-100 md:text-[15px]">
                <span className="rounded-full border border-rose-200/45 bg-rose-200/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-rose-100">
                  Out of Credit
                </span>
                <span className="min-w-0 truncate">{outOfCreditMessage}</span>
              </div>
            </div>
          ) : null}
          {sendError ? (
            <div className="border-b border-amber-400/20 bg-amber-500/10 px-4 py-2 text-[14px] text-amber-200 md:px-6 md:text-[15px]">
              {sendError}
            </div>
          ) : null}

          {pendingRequests.length ? (
            <div className="border-b border-white/10 bg-white/5 px-4 py-4 text-[14px] text-white/70 md:px-6 md:text-[15px]">
              <div className="text-[13px] uppercase tracking-[0.3em] text-white/50">Approvals</div>
              <div className="mt-3 space-y-3">
                {pendingRequests.map((req) => (
                  <ApprovalCard key={req.id} request={req} onRespond={respondToRequest} />
                ))}
              </div>
            </div>
          ) : null}

          <section
            className={`conversation-scroll flex-1 overflow-x-hidden ${hasTimelineContent ? "overflow-y-auto" : "overflow-y-hidden"} overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] pl-[max(2rem,env(safe-area-inset-left))] pr-[max(2rem,env(safe-area-inset-right))] pt-[calc(1.5rem+env(safe-area-inset-top))] md:pb-8 md:pl-[max(3rem,env(safe-area-inset-left))] md:pr-[max(3rem,env(safe-area-inset-right))] md:pt-6`}
            ref={conversationRef}
            onScroll={handleTimelineScroll}
            style={conversationStyle}
          >
          {!activeThread ? (
            <div className="lets-build-stage mx-auto mt-24 flex max-w-lg flex-col items-center text-center text-white/60">
              <div className="lets-build-title text-lg font-display text-white/85">Let’s build</div>
              <div className="lets-build-switcher-shell">
                {showProjectDiscoveryLoader ? renderProjectDiscovery() : renderProjectSwitcher()}
              </div>
              {!showProjectDiscoveryLoader && letsBuildHintText ? (
                <div className="lets-build-subcopy mt-3 text-[16px] text-white/40">
                  {letsBuildHintText}
                </div>
              ) : null}
            </div>
          ) : selectedThread && loading ? (
            <div className="mx-auto mt-20 text-[16px] text-white/50 md:text-[17px]">Loading conversation…</div>
          ) : items.length === 0 ? (
            <div className="lets-build-stage mx-auto mt-24 flex max-w-lg flex-col items-center text-center text-white/60">
              <div className="lets-build-title text-lg font-display text-white/85">Let’s build</div>
              <div className="lets-build-switcher-shell">
                {showProjectDiscoveryLoader ? renderProjectDiscovery() : renderProjectSwitcher()}
              </div>
              {!showProjectDiscoveryLoader && letsBuildHintText ? (
                <div className="lets-build-subcopy mt-3 text-[16px] text-white/40">
                  {letsBuildHintText}
                </div>
              ) : null}
            </div>
          ) : (
            <>
                {!shouldVirtualizeTimeline ? (
                  <div className="mx-auto w-full max-w-3xl font-body font-medium text-[16px] text-white/85 md:text-[16px]">
                    {visibleItems.map((item, index) => (
                      <TimelineRow
                        key={`${item.id}-${index}`}
                        item={item}
                        apiBase={apiBase}
                        suppressFinalMarkers={suppressFinalMarkers}
                        fallbackFinalMessageId={fallbackFinalMessageId}
                      />
                    ))}
                  </div>
                ) : (
                  <div
                    className="relative mx-auto w-full max-w-3xl font-body font-medium text-[16px] text-white/85 md:text-[16px]"
                    style={{ height: rowVirtualizer.getTotalSize() }}
                  >
                    {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                      const item = visibleItems[virtualRow.index];
                      if (!item) return null;
                      return (
                        <div
                          key={virtualRow.key}
                          data-index={virtualRow.index}
                          ref={rowVirtualizer.measureElement}
                          className="absolute left-0 top-0 w-full"
                          style={{ transform: `translateY(${virtualRow.start}px)` }}
                        >
                          <TimelineRow
                            item={item}
                            apiBase={apiBase}
                            suppressFinalMarkers={suppressFinalMarkers}
                            fallbackFinalMessageId={fallbackFinalMessageId}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
                {thinkingCount > 0 || selectedThreadHasActiveRun ? (
                  <div className="mx-auto mt-3 flex w-full max-w-3xl items-center justify-start gap-3 pb-2">
                    <span className="thinking-sweep">Thinking...</span>
                  </div>
                ) : null}
              </>
            )}
          </section>
          <MessageComposer
            apiBase={apiBase}
            disabled={!selectedThread && !draftCwd}
            contentWidthClass={contentWidthClass}
            placeholder={
              selectedThread
                ? "Ask for follow-up changes"
                : draftCwd
                  ? "Ask Codex anything"
                  : showProjectDiscoveryLoader
                    ? "Syncing your projects"
                    : "Select a project to start…"
            }
            onSend={handleSend}
            onStop={handleStop}
            onSteer={handleSteerNow}
            onRemoveQueued={handleRemoveQueuedSend}
            onEditQueued={handleEditQueuedSend}
            busy={isBusy}
            queuedCount={queuedCount}
            queuedPreview={queuedPreview}
            queuedMessages={queuedMessages}
            steerEnabled={steerEnabled}
            steerBlockedByExternalSurface={selectedThreadHasExternalSurfaceRun}
            modelOptions={modelOptions}
            effortOptionsByModel={effortOptionsByModel}
            defaultEffortByModel={defaultEffortByModel}
            defaultModel={defaultModelValue}
            defaultEffort={defaultEffortValue}
            onHeightChange={setComposerLayout}
          />
        </div>
      </main>
      {archiveConfirmTarget ? (
        <div
          className="fixed inset-0 z-[85] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => {
            if (archiveConfirmArchiving) return;
            setArchiveConfirmTarget(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Archive thread confirmation"
            className="w-full max-w-md rounded-2xl border border-white/15 bg-codex-panel p-5 shadow-[0_22px_70px_rgba(0,0,0,0.55)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.24em] text-white/45">Threads</div>
                <h2 className="mt-1 text-xl font-display text-white/90">Archive thread?</h2>
              </div>
              <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-full border border-amber-300/35 bg-amber-300/10 text-amber-200">
                <Archive className="h-4 w-4" strokeWidth={1.9} />
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[14px] text-white/78">
              <span className="font-medium text-white/90">{archiveConfirmTitle}</span>
              <span className="text-white/55"> will be moved to archives.</span>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-full border border-white/15 px-3 py-1.5 text-[13px] text-white/65 transition hover:border-white/35 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => setArchiveConfirmTarget(null)}
                disabled={archiveConfirmArchiving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center gap-1.5 rounded-full border border-amber-300/35 bg-amber-300/15 px-4 py-1.5 text-[13px] font-semibold text-amber-100 transition hover:border-amber-200/65 hover:bg-amber-200/25 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={confirmArchiveThread}
                disabled={archiveConfirmArchiving}
              >
                {archiveConfirmArchiving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" style={SYNC_SPINNER_STYLE} strokeWidth={2.2} />
                    <span>Archiving...</span>
                  </>
                ) : (
                  <>
                    <Archive className="h-3.5 w-3.5" strokeWidth={2} />
                    <span>Archive</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {projectCreationOpen ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => closeProjectCreationDialog()}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Create new project"
            className="w-full max-w-md rounded-2xl border border-white/15 bg-codex-panel p-5 shadow-[0_22px_70px_rgba(0,0,0,0.55)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.24em] text-white/45">Workspace</div>
                <h2 className="mt-1 text-xl font-display text-white/90">New Project</h2>
              </div>
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/60 transition hover:border-white/30 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Close create project dialog"
                onClick={() => closeProjectCreationDialog()}
                disabled={projectCreationPending}
              >
                <X className="h-4 w-4" strokeWidth={2.2} />
              </button>
            </div>

            <label className="mt-5 block text-[11px] uppercase tracking-[0.2em] text-white/50" htmlFor="new-project-name">
              Project Name
            </label>
            <input
              id="new-project-name"
              value={newProjectName}
              onChange={(event) => {
                setNewProjectName(event.target.value);
                if (projectCreationError) setProjectCreationError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitProjectCreation();
                }
              }}
              autoFocus
              placeholder="ex: My Next App"
              className="mt-2 w-full rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2.5 text-[15px] text-white/90 placeholder:text-white/35 focus:border-white/35 focus:outline-none focus:ring-1 focus:ring-white/20"
              disabled={projectCreationPending}
            />
            {projectCreationError ? (
              <div className="mt-2 text-[13px] text-rose-300">{projectCreationError}</div>
            ) : (
              <div className="mt-2 text-[12px] text-white/45">A folder with this name will be created on your server.</div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-full border border-white/15 px-3 py-1.5 text-[13px] text-white/65 transition hover:border-white/35 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => closeProjectCreationDialog()}
                disabled={projectCreationPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-full bg-white px-4 py-1.5 text-[13px] font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void submitProjectCreation()}
                disabled={projectCreationPending}
              >
                {projectCreationPending ? "Creating..." : "Create Project"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {codexSettingsDialogOpen ? (
        <div
          className="fixed inset-0 z-[88] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => closeCodexSettingsDialog()}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Codex access settings"
            className="w-full max-w-md rounded-2xl border border-white/15 bg-codex-panel p-5 shadow-[0_22px_70px_rgba(0,0,0,0.55)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.24em] text-white/45">Codex</div>
                <h2 className="mt-1 text-xl font-display text-white/90">Access Settings</h2>
              </div>
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/60 transition hover:border-white/30 hover:bg-white/10 hover:text-white"
                aria-label="Close codex settings dialog"
                onClick={() => closeCodexSettingsDialog()}
              >
                <X className="h-4 w-4" strokeWidth={2.2} />
              </button>
            </div>

            <div className="mt-5 flex items-center justify-between gap-4 rounded-xl border border-white/12 bg-white/[0.03] px-3 py-3">
              <div>
                <div className="text-[13px] font-semibold text-white/88">Full access</div>
                <div className="mt-1 text-[11px] text-white/52">
                  {codexSettingsDraft.accessMode === "full-access"
                    ? "No sandbox restrictions for turns sent from PocketDex."
                    : "Disabled: PocketDex sends turns in workspace mode."}
                </div>
              </div>
              <button
                type="button"
                className={`relative inline-flex h-7 w-12 items-center rounded-full border transition ${
                  codexSettingsDraft.accessMode === "full-access"
                    ? "border-emerald-300/45 bg-emerald-300/25"
                    : "border-white/20 bg-white/10"
                }`}
                aria-pressed={codexSettingsDraft.accessMode === "full-access"}
                onClick={() =>
                  setCodexSettingsDraft((current) => ({
                    ...current,
                    accessMode: current.accessMode === "full-access" ? "workspace-write" : "full-access",
                  }))
                }
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                    codexSettingsDraft.accessMode === "full-access" ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            <div className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-white/12 bg-white/[0.03] px-3 py-3">
              <div>
                <div className="text-[13px] font-semibold text-white/88">Internet access</div>
                <div className="mt-1 text-[11px] text-white/52">Applied to turns sent from PocketDex</div>
              </div>
              <button
                type="button"
                className={`relative inline-flex h-7 w-12 items-center rounded-full border transition ${
                  codexSettingsDraft.internetAccess
                    ? "border-emerald-300/45 bg-emerald-300/25"
                    : "border-white/20 bg-white/10"
                }`}
                aria-pressed={codexSettingsDraft.internetAccess}
                onClick={() =>
                  setCodexSettingsDraft((current) => ({
                    ...current,
                    internetAccess: !current.internetAccess,
                  }))
                }
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                    codexSettingsDraft.internetAccess ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            {codexSettingsDraft.accessMode === "workspace-write" && codexSettingsDraft.internetAccess ? (
              <div className="mt-3 text-[12px] text-amber-200/90">
                Workspace mode remains sandboxed on this runtime, so internet access stays restricted.
              </div>
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-full border border-white/15 px-3 py-1.5 text-[13px] text-white/65 transition hover:border-white/35 hover:text-white"
                onClick={() => closeCodexSettingsDialog()}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-full bg-white px-4 py-1.5 text-[13px] font-semibold text-black transition hover:bg-white/90"
                onClick={() => saveCodexSettingsDialog()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {devServerDialogOpen ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => closeDevServerDialog()}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Access development server"
            className="w-full max-w-md rounded-2xl border border-white/15 bg-codex-panel p-5 shadow-[0_22px_70px_rgba(0,0,0,0.55)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.24em] text-white/45">Tools</div>
                <h2 className="mt-1 text-xl font-display text-white/90">Access dev server</h2>
              </div>
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/60 transition hover:border-white/30 hover:bg-white/10 hover:text-white"
                aria-label="Close access dev server dialog"
                onClick={() => closeDevServerDialog()}
              >
                <X className="h-4 w-4" strokeWidth={2.2} />
              </button>
            </div>

            <label className="mt-5 block text-[11px] uppercase tracking-[0.2em] text-white/50" htmlFor="dev-server-port">
              Port
            </label>
            <input
              id="dev-server-port"
              value={devServerPort}
              onChange={(event) => {
                setDevServerPort(event.target.value);
                if (devServerError) setDevServerError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitDevServerAccess();
                }
              }}
              autoFocus
              inputMode="numeric"
              placeholder="ex: 3000"
              className="mt-2 w-full rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2.5 text-[15px] text-white/90 placeholder:text-white/35 focus:border-white/35 focus:outline-none focus:ring-1 focus:ring-white/20"
            />

            <div className="mt-4">
              <div className="text-[11px] uppercase tracking-[0.2em] text-white/50">Quick ports</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {COMMON_DEV_SERVER_PORTS.map((port) => (
                  <button
                    key={port}
                    type="button"
                    className={`rounded-full border px-3 py-1 text-[12px] transition ${
                      devServerPort.trim() === port
                        ? "border-white/45 bg-white/14 text-white"
                        : "border-white/15 bg-white/[0.04] text-white/72 hover:border-white/35 hover:text-white"
                    }`}
                    onClick={() => applyDevServerPortPreset(port)}
                  >
                    {port}
                  </button>
                ))}
              </div>
            </div>

            {devServerError ? (
              <div className="mt-3 text-[13px] text-rose-300">{devServerError}</div>
            ) : (
              <div className="mt-3 text-[12px] text-white/45">
                Open {devServerHostLabel || "the current host"} in a new tab with the selected port.
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-full border border-white/15 px-3 py-1.5 text-[13px] text-white/65 transition hover:border-white/35 hover:text-white"
                onClick={() => closeDevServerDialog()}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-full bg-white px-4 py-1.5 text-[13px] font-semibold text-black transition hover:bg-white/90"
                onClick={() => submitDevServerAccess()}
              >
                Open in new tab
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const ApprovalCard = memo(function ApprovalCard({
  request,
  onRespond,
}: {
  request: PendingRequest;
  onRespond: (id: number, result?: unknown, errorMessage?: string) => void;
}) {
  const method = request.method;
  if (method === "item/commandExecution/requestApproval") {
    const params = request.params ?? {};
    const commandTitle = summarizeCommandTitle(params.command ?? "");
    return (
      <div className="rounded-xl border border-white/10 bg-black/30 p-3">
        <div className="text-[13px] uppercase tracking-[0.25em] text-white/50">Command approval</div>
        <div className="mt-2 text-[15px] text-white/80 md:text-[16px]">{commandTitle}</div>
        {params.cwd ? <div className="mt-1 text-[13px] text-white/40">cwd: {params.cwd}</div> : null}
        {params.reason ? <div className="mt-2 text-[13px] text-white/60">{params.reason}</div> : null}
        <div className="mt-3 flex gap-2">
          <button
            className="rounded-full border border-emerald-300/40 px-3 py-1 text-[13px] text-emerald-200/90 transition hover:bg-emerald-300/10"
            onClick={() => onRespond(request.id, { decision: "accept" })}
          >
            Approve
          </button>
          <button
            className="rounded-full border border-rose-300/40 px-3 py-1 text-[13px] text-rose-200/90 transition hover:bg-rose-300/10"
            onClick={() => onRespond(request.id, { decision: "decline" })}
          >
            Decline
          </button>
        </div>
      </div>
    );
  }

  if (method === "item/fileChange/requestApproval") {
    const params = request.params ?? {};
    return (
      <div className="rounded-xl border border-white/10 bg-black/30 p-3">
        <div className="text-[13px] uppercase tracking-[0.25em] text-white/50">File change approval</div>
        {params.reason ? <div className="mt-2 text-[13px] text-white/60">{params.reason}</div> : null}
        {params.grantRoot ? <div className="mt-1 text-[13px] text-white/40">grant: {params.grantRoot}</div> : null}
        <div className="mt-3 flex gap-2">
          <button
            className="rounded-full border border-emerald-300/40 px-3 py-1 text-[13px] text-emerald-200/90 transition hover:bg-emerald-300/10"
            onClick={() => onRespond(request.id, { decision: "accept" })}
          >
            Approve
          </button>
          <button
            className="rounded-full border border-rose-300/40 px-3 py-1 text-[13px] text-rose-200/90 transition hover:bg-rose-300/10"
            onClick={() => onRespond(request.id, { decision: "decline" })}
          >
            Decline
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-3">
      <div className="text-[13px] uppercase tracking-[0.25em] text-white/50">Unsupported request</div>
      <div className="mt-2 text-[13px] text-white/60">{method}</div>
      <div className="mt-2 text-[12px] text-white/40">{JSON.stringify(request.params)}</div>
      <div className="mt-3">
        <button
          className="rounded-full border border-white/10 px-3 py-1 text-[13px] text-white/70 transition hover:bg-white/10"
          onClick={() => onRespond(request.id, undefined, "Unsupported request")}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
});

const TimelineRow = memo(function TimelineRow({
  item,
  apiBase,
  suppressFinalMarkers,
  fallbackFinalMessageId,
}: {
  item: TimelineItem;
  apiBase: string;
  suppressFinalMarkers: boolean;
  fallbackFinalMessageId: string | null;
}) {
  const RowBlock = ({
    label,
    tone,
    children,
    align,
  }: {
    label: string;
    tone: string;
    children: React.ReactNode;
    align?: "center" | "right";
  }) => (
    <div className={`flex py-2 ${align === "right" ? "justify-end" : "justify-center"}`}>
      <div
        className={`text-safe-wrap min-w-0 overflow-hidden rounded-lg border border-white/10 bg-black/30 px-4 py-3 ${
          align === "right" ? "w-full max-w-[820px] md:w-[92%]" : "w-full max-w-[820px]"
        }`}
      >
        <div className={`mb-2 text-[11px] uppercase tracking-[0.35em] ${tone}`}>{label}</div>
        {children}
      </div>
    </div>
  );

  if (item.type === "userMessage") {
    const { text, attachments } = userInputToText(item.content);
    return (
      <RowBlock label="YOU" tone="text-emerald-200/80" align="right">
        <div className="prose prose-invert max-w-none text-[15px] leading-relaxed prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-pre:bg-[rgba(27,33,41,0.78)] prose-pre:p-2 prose-pre:rounded-md prose-code:text-sky-100 md:text-[15px] [overflow-wrap:anywhere] break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text || "(empty message)"}</ReactMarkdown>
        </div>
        {attachments.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {attachments.map((attachment, index) => {
              const localImageUrl =
                attachment.kind === "localImage"
                  ? buildLocalImageAttachmentUrl(apiBase, attachment.path)
                  : null;
              const imageUrl = attachment.kind === "image" && attachment.url ? attachment.url : localImageUrl;
              return imageUrl ? (
                <img
                  key={`${item.id}-att-${index}`}
                  src={imageUrl}
                  alt="Attachment"
                  className="max-w-[180px] rounded-lg border border-white/10"
                />
              ) : (
                <span
                  key={`${item.id}-att-${index}`}
                  className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/70"
                  title={attachment.path ?? attachment.label}
                >
                  {attachment.kind === "file" ? "File: " : "Local image: "}
                  {shortenPath(attachment.label)}
                </span>
              );
            })}
          </div>
        ) : null}
      </RowBlock>
    );
  }

  if (item.type === "agentMessage") {
    const isFinal =
      !suppressFinalMarkers && (Boolean(item._meta?.final) || item.id === fallbackFinalMessageId);
    const workedDuration = formatWorkedDuration(item._meta?.workedMs);
    const workedLabel = workedDuration ? `Worked for ${workedDuration}` : "Final response";
    const formattedText = linkifyBareFileReferences(item.text);
    return (
      <div className="flex justify-center py-2">
        <div
          className={`text-safe-wrap min-w-0 w-full max-w-[820px] overflow-hidden leading-relaxed text-white ${isFinal ? "text-[16px] md:text-[16px]" : "text-[15px] md:text-[15px]"}`}
        >
          {isFinal ? (
            <div className="mb-4 flex items-center gap-4 text-[13px] text-white/50">
              <div className="h-px flex-1 bg-white/10" />
              <span className="shrink-0 font-medium text-white/55">{workedLabel}</span>
              <div className="h-px flex-1 bg-white/10" />
            </div>
          ) : null}
          <div
            className={`prose prose-invert prose-inherit max-w-none leading-relaxed prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-pre:bg-[rgba(27,33,41,0.78)] prose-pre:p-2 prose-pre:rounded-md prose-code:text-sky-100 prose-p:text-inherit prose-li:text-inherit prose-strong:text-inherit prose-em:text-inherit prose-a:text-inherit [overflow-wrap:anywhere] break-words ${
              isFinal ? "text-[16px] md:text-[16px]" : "text-[15px] md:text-[15px]"
            }`}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              urlTransform={markdownUrlTransform}
              components={markdownComponentsWithFileReferences}
            >
              {formattedText}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }

  if (item.type === "plan") {
    return (
      <RowBlock label="PLAN" tone="text-amber-200/80">
        <div className="prose prose-invert max-w-none text-[15px] prose-p:my-1 md:text-[15px] [overflow-wrap:anywhere] break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text || ""}</ReactMarkdown>
        </div>
      </RowBlock>
    );
  }

  if (item.type === "reasoning") {
    return <ReasoningRow item={item} />;
  }

  if (item.type === "turnDiff") {
    if (!item.files.length) return null;
    return (
      <div className="flex justify-center py-2">
        <div className="w-full max-w-[720px] space-y-1 font-mono text-[12px] text-white/55 md:text-[13px]">
          {item.files.map((file) => (
            <div key={file.path} className="flex items-center gap-2">
              <span className="text-white/40">Edited</span>
              <span className="font-semibold text-sky-200">{basename(file.path)}</span>
              {file.added ? <span className="text-emerald-300">+{file.added}</span> : null}
              {file.removed ? <span className="text-rose-300">-{file.removed}</span> : null}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (item.type === "commandExecution") {
    const actionSummary = formatCommandActionSummary(item.commandActions);
    const summaryLabel = actionSummary || summarizeCommandTitle(item.command);
    return (
      <div className="flex justify-center py-2">
        <div className="w-full max-w-[720px]">
          <div className="flex items-center gap-2 font-mono text-[12px] text-white/55 md:text-[13px]">
            <span className="text-white/40">Action</span>
            <span className="min-w-0 truncate font-semibold text-sky-200" title={summaryLabel}>
              {summaryLabel}
            </span>
            {item.durationMs ? <span className="text-[11px] text-white/35">{Math.round(item.durationMs)}ms</span> : null}
          </div>
        </div>
      </div>
    );
  }

  if (item.type === "fileChange") {
    const total = item.changes.reduce(
      (acc, change) => {
        const counts = countDiffLines(change.diff || "");
        acc.added += counts.added;
        acc.removed += counts.removed;
        return acc;
      },
      { added: 0, removed: 0 },
    );
    return (
      <div className="flex justify-center py-2">
        <div className="w-full max-w-[720px] space-y-3">
          <div className="space-y-1 font-mono text-[13px] text-white/55 md:text-[14px]">
            {item.changes.map((change) => {
              const counts = countDiffLines(change.diff || "");
              return (
                <div key={change.path} className="flex items-center gap-2">
                  <span className="text-white/40">Edited</span>
                  <span className="font-semibold text-sky-200">{basename(change.path)}</span>
                  {counts.added ? <span className="text-emerald-300">+{counts.added}</span> : null}
                  {counts.removed ? <span className="text-rose-300">-{counts.removed}</span> : null}
                </div>
              );
            })}
          </div>
          <div className="text-[11px] text-white/40">
            {total.added ? <span className="text-emerald-300">+{total.added}</span> : null}
            {total.removed ? <span className="ml-2 text-rose-300">-{total.removed}</span> : null}
          </div>
        </div>
      </div>
    );
  }

  if (item.type === "mcpToolCall") {
    const statusTone =
      item.status === "completed"
        ? "text-emerald-300"
        : item.status === "failed"
          ? "text-rose-300"
          : "text-amber-300";
    return (
      <div className="flex justify-center py-2">
        <details className="group text-safe-wrap min-w-0 w-full max-w-[720px] overflow-hidden text-[12px] text-white/60 md:text-[13px]">
          <summary className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.22em] text-white/45 md:text-[12px]">
            <div className="flex items-center gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/55 md:text-[12px]">MCP</span>
              <span className="text-[12px] font-semibold uppercase tracking-[0.2em] text-white/60 md:text-[13px]">
                {item.server}.{item.tool}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-white/35 md:text-[11px]">
              {item.durationMs ? <span>{Math.round(item.durationMs)}ms</span> : null}
              <span className={`${statusTone}`}>{item.status}</span>
              <span className="text-white/40 transition group-open:rotate-180">▾</span>
            </div>
          </summary>
          {item.arguments ? (
            <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/30 p-2 font-mono text-[12px] text-white/70 md:text-[13px] [overflow-wrap:anywhere] break-words">
              {JSON.stringify(item.arguments, null, 2)}
            </pre>
          ) : null}
          {item.result ? (
            <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/30 p-2 font-mono text-[12px] text-white/70 md:text-[13px] [overflow-wrap:anywhere] break-words">
              {JSON.stringify(item.result, null, 2)}
            </pre>
          ) : null}
          {item.error ? (
            <div className="mt-2 text-[12px] text-rose-200">{JSON.stringify(item.error)}</div>
          ) : null}
        </details>
      </div>
    );
  }

  if (item.type === "webSearch") {
    return (
      <div className="flex justify-center py-2">
        <div className="w-full max-w-[720px] rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-[13px] text-white/70 md:text-[14px]">
          Web search: {item.query}
        </div>
      </div>
    );
  }

  if (item.type === "imageView") {
    return (
      <div className="flex justify-center py-2">
        <div className="w-full max-w-[720px] rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-[13px] text-white/70 md:text-[14px]">
          Image viewed: {shortenPath(item.path)}
        </div>
      </div>
    );
  }

  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
    return (
      <div className="flex justify-center py-2">
        <div className="w-full max-w-[720px] rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-[13px] text-white/70 md:text-[14px]">
          {item.type === "enteredReviewMode" ? "Entered review mode" : "Exited review mode"}
        </div>
      </div>
    );
  }

  if (item.type === "contextCompaction") {
    return (
      <div className="flex justify-center py-3">
        <div className="flex w-full max-w-[820px] items-center gap-3 text-white/55">
          <div className="h-px flex-1 bg-white/10" />
          <div className="inline-flex items-center gap-2 text-[13px] font-semibold tracking-[0.01em] text-white/62 md:text-[14px]">
            <ListCollapse className="h-3.5 w-3.5" />
            <span>Context automatically compacted</span>
          </div>
          <div className="h-px flex-1 bg-white/10" />
        </div>
      </div>
    );
  }

  if (item.type === "unknown") {
    return (
    <div className="flex justify-center py-2">
      <details className="group text-safe-wrap min-w-0 w-full max-w-[720px] overflow-hidden text-[11px] text-white/60 md:text-[12px]">
        <summary className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.22em] text-white/45 md:text-[11px]">
          <span>Unknown item</span>
          <span className="text-white/40 transition group-open:rotate-180">▾</span>
        </summary>
        <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/30 p-2 font-mono text-[11px] text-white/70 md:text-[12px] [overflow-wrap:anywhere] break-words">
          {JSON.stringify(item.raw, null, 2)}
        </pre>
      </details>
    </div>
    );
  }

  return null;
});

const ReasoningRow = memo(function ReasoningRow({
  item,
}: {
  item: Extract<TimelineItem, { type: "reasoning" }>;
}) {
  const summary = item.summary?.filter((entry) => entry.trim()) ?? [];
  const content = item.content?.filter((entry) => entry.trim()) ?? [];
  const summaryLineRaw = (summary[0] ?? "").split("\n")[0];
  const contentLineRaw = (content[0] ?? "").split("\n")[0];
  const summaryLine = sanitizeReasoningHeadline(summaryLineRaw);
  const contentLine = sanitizeReasoningHeadline(contentLineRaw);
  const baseLineRaw = summaryLine ? summaryLineRaw : contentLine ? contentLineRaw : "";
  const baseLine = summaryLine || contentLine;
  const [open, setOpen] = useState(false);
  if (!baseLine) return null;
  const words = baseLine.split(/\s+/).filter(Boolean);
  const isTrimmed = words.length > 6;
  const trimmed = isTrimmed ? `${words.slice(0, 6).join(" ")}…` : baseLine;
  const remainder = isTrimmed ? words.slice(6).join(" ").trim() : "";

  const stripFirstLine = (text: string) => {
    const lines = text.split("\n");
    const first = lines[0] ?? "";
    if (first.trim() === baseLineRaw.trim()) {
      return lines.slice(1).join("\n").trim();
    }
    return text;
  };

  const summaryText = summary.join("\n");
  const contentText = content.join("\n");
  const expandedSummary = summaryText ? stripFirstLine(summaryText) : "";
  const expandedContent = contentText ? stripFirstLine(contentText) : "";
  const hasExpandableContent = Boolean(expandedSummary || expandedContent || remainder);

  return (
    <div className="flex justify-center py-2">
      <div className="text-safe-wrap min-w-0 w-full max-w-[820px] overflow-hidden">
        {hasExpandableContent ? (
          <button
            type="button"
            className="group inline-flex max-w-full items-start gap-1.5 text-left text-[12px] text-white/35 transition hover:text-white/75 md:text-[12px]"
            onClick={() => setOpen((prev) => !prev)}
            title={open ? "Hide reasoning details" : "Show reasoning details"}
            aria-expanded={open}
          >
            <span className="min-w-0 text-white/45 group-hover:text-white/85">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{ p: "span", strong: "strong", em: "em", code: "code" }}
              >
                {trimmed}
              </ReactMarkdown>
            </span>
            <ChevronRight
              className={`mt-[1px] h-3.5 w-3.5 shrink-0 text-white/25 transition-all duration-150 group-hover:text-white/70 ${
                open ? "rotate-90" : ""
              }`}
              strokeWidth={2}
            />
          </button>
        ) : (
          <div className="group inline-flex max-w-full items-start gap-1.5 text-left text-[12px] text-white/35 transition hover:text-white/75 md:text-[12px]">
            <span className="min-w-0 text-white/45 group-hover:text-white/85">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{ p: "span", strong: "strong", em: "em", code: "code" }}
              >
                {trimmed}
              </ReactMarkdown>
            </span>
          </div>
        )}
        {hasExpandableContent && open ? (
          <div className="mt-2 text-[12px] text-white/45 md:text-[12px]">
            {expandedSummary ? (
              <div className="prose prose-invert prose-inherit max-w-none text-[12px] prose-p:my-1 md:text-[12px] [overflow-wrap:anywhere] break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{expandedSummary}</ReactMarkdown>
              </div>
            ) : null}
            {expandedContent ? (
              <div className="prose prose-invert prose-inherit mt-2 max-w-none text-[12px] prose-p:my-1 md:text-[12px] [overflow-wrap:anywhere] break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{expandedContent}</ReactMarkdown>
              </div>
            ) : null}
            {!expandedSummary && !expandedContent && remainder ? (
              <div className="prose prose-invert prose-inherit max-w-none text-[12px] prose-p:my-1 md:text-[12px] [overflow-wrap:anywhere] break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{remainder}</ReactMarkdown>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

const MAX_TEXTAREA_LINES = 8;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function createClientId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to timestamp/random fallback
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeCreateObjectUrl(file: File): string | null {
  try {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

function revokePreviewUrl(previewUrl: string | null): void {
  if (!previewUrl) return;
  URL.revokeObjectURL(previewUrl);
}

function hasFilesInDataTransfer(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types ?? []);
  if (types.includes("Files") || types.includes("application/x-moz-file")) return true;
  if ((dataTransfer.files?.length ?? 0) > 0) return true;
  return Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file");
}

function filesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  const items = Array.from(dataTransfer.items ?? []);
  if (items.length) {
    return items
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
  }
  return Array.from(dataTransfer.files ?? []).filter((file): file is File => file instanceof File);
}

const MessageComposer = memo(function MessageComposer({
  apiBase,
  disabled,
  busy,
  onSend,
  onStop,
  onSteer,
  onRemoveQueued,
  onEditQueued,
  queuedCount,
  queuedPreview,
  queuedMessages,
  steerEnabled,
  steerBlockedByExternalSurface,
  modelOptions,
  effortOptionsByModel,
  defaultEffortByModel,
  defaultModel,
  defaultEffort,
  placeholder,
  contentWidthClass,
  onHeightChange,
}: {
  apiBase: string;
  disabled: boolean;
  busy: boolean;
  onSend: (text: string, modelValue: string, attachments: OutgoingAttachment[]) => void;
  onStop: () => void;
  onSteer: () => void;
  onRemoveQueued: (id: string) => void;
  onEditQueued: (id: string) => QueuedComposerDraft | null;
  queuedCount: number;
  queuedPreview: string | null;
  queuedMessages: QueuedSendSnapshot[];
  steerEnabled: boolean;
  steerBlockedByExternalSurface: boolean;
  modelOptions: ModelOption[];
  effortOptionsByModel: Record<string, ReasoningOption[]>;
  defaultEffortByModel: Record<string, string | null>;
  defaultModel: string;
  defaultEffort: string | null;
  placeholder: string;
  contentWidthClass: string;
  onHeightChange?: (layout: { height: number; overlap: number }) => void;
}) {
  const [model, setModel] = useState(defaultModel);
  const [effort, setEffort] = useState<string | null>(defaultEffort);
  const [hasLoadedSelection, setHasLoadedSelection] = useState(false);
  const [hasLoadedRemoteSelection, setHasLoadedRemoteSelection] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputId = useId();
  const valueRef = useRef("");
  const hasTextRef = useRef(false);
  const [hasText, setHasText] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const dragDepthRef = useRef(0);
  const [isDropTargetActive, setIsDropTargetActive] = useState(false);
  const [queueMenuOpenId, setQueueMenuOpenId] = useState<string | null>(null);
  const resizeTextArea = useCallback((textarea: HTMLTextAreaElement) => {
    const computed = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
    const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(computed.paddingBottom) || 0;
    const maxHeight = lineHeight * MAX_TEXTAREA_LINES + paddingTop + paddingBottom;
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);
  const effortOptions = useMemo(
    () => effortOptionsByModel[model] ?? [],
    [effortOptionsByModel, model],
  );
  const hasResolvedEffortOptionsForModel = useMemo(() => {
    if (!model) return false;
    return Object.prototype.hasOwnProperty.call(effortOptionsByModel, model);
  }, [effortOptionsByModel, model]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem("pocketdex.model");
      if (stored) {
        const parsed = parseModelSelection(stored);
        if (parsed.model) setModel(parsed.model);
        if (parsed.effort) setEffort(parsed.effort);
      }
    } catch {
      // ignore
    } finally {
      setHasLoadedSelection(true);
    }
  }, []);

  useEffect(() => {
    if (!apiBase) {
      setHasLoadedRemoteSelection(true);
      return;
    }
    setHasLoadedRemoteSelection(false);
    const controller = new AbortController();
    let cancelled = false;
    const loadRemoteSelection = async () => {
      try {
        const response = await fetch(`${apiBase}/api/ui-state`, { signal: controller.signal });
        if (!response.ok) return;
        const payload = await response.json();
        if (payload?.persisted !== true) return;
        const state = parsePersistedUiState(payload?.data);
        const remoteSelection = state.modelSelection;
        if (!remoteSelection || cancelled) return;
        if (remoteSelection.model) setModel(remoteSelection.model);
        setEffort(remoteSelection.effort ?? null);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setHasLoadedRemoteSelection(true);
      }
    };

    void loadRemoteSelection();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiBase]);

  useEffect(() => {
    if (!defaultModel) return;
    if (!model) setModel(defaultModel);
  }, [defaultModel, model]);

  useEffect(() => {
    if (!modelOptions.length) return;
    if (!modelOptions.some((option) => option.value === model)) {
      const fallback = modelOptions.find((option) => option.value === defaultModel)?.value ?? modelOptions[0].value;
      setModel(fallback);
    }
  }, [modelOptions, model, defaultModel]);

  useEffect(() => {
    if (!model) return;
    if (!hasResolvedEffortOptionsForModel) return;
    if (!effortOptions.length) {
      if (effort !== null) setEffort(null);
      return;
    }
    if (!effortOptions.some((option) => option.value === effort)) {
      const fallback = defaultEffortByModel[model] ?? effortOptions[0]?.value ?? null;
      setEffort(fallback);
    }
  }, [defaultEffortByModel, effort, effortOptions, hasResolvedEffortOptionsForModel, model]);

  useEffect(() => {
    if (!textAreaRef.current) return;
    resizeTextArea(textAreaRef.current);
  }, [resizeTextArea]);

  useEffect(() => {
    if (!onHeightChange) return;
    const node = rootRef.current;
    if (!node) return;
    let frameId = 0;
    const report = () => {
      const rect = node.getBoundingClientRect();
      const visualViewport = window.visualViewport;
      const visibleViewportBottom = visualViewport
        ? visualViewport.offsetTop + visualViewport.height
        : window.innerHeight;
      const layoutViewportBottom = window.innerHeight || document.documentElement.clientHeight || rect.bottom;
      const height = Math.round(node.offsetHeight || rect.height);
      // Use layout viewport overlap so mobile browser chrome/keyboard shifts are fully accounted for.
      const layoutOverlap = Math.max(0, Math.round(layoutViewportBottom - rect.top));
      const visibleOverlap = Math.max(0, Math.round(visibleViewportBottom - rect.top));
      const overlap = Math.max(layoutOverlap, visibleOverlap, height);
      onHeightChange({ height, overlap });
    };
    const scheduleReport = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(report);
    };
    report();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleReport) : null;
    observer?.observe(node);
    window.addEventListener("resize", scheduleReport);
    window.visualViewport?.addEventListener("resize", scheduleReport);
    window.visualViewport?.addEventListener("scroll", scheduleReport);
    return () => {
      cancelAnimationFrame(frameId);
      observer?.disconnect();
      window.removeEventListener("resize", scheduleReport);
      window.visualViewport?.removeEventListener("resize", scheduleReport);
      window.visualViewport?.removeEventListener("scroll", scheduleReport);
    };
  }, [onHeightChange]);

  useEffect(() => {
    if (!hasLoadedSelection) return;
    if (typeof window === "undefined") return;
    try {
      if (model) {
        const storedValue = effort ? `${model}:${effort}` : model;
        window.localStorage.setItem("pocketdex.model", storedValue);
      }
    } catch {
      // ignore
    }
  }, [model, effort, hasLoadedSelection]);

  useEffect(() => {
    if (!apiBase) return;
    if (!hasLoadedSelection || !hasLoadedRemoteSelection) return;
    const timer = setTimeout(() => {
      const payload = {
        modelSelection: model ? ({ model, effort: effort ?? null } as PersistedModelSelection) : null,
      };
      void fetch(`${apiBase}/api/ui-state`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: payload }),
      }).catch(() => {
        // ignore
      });
    }, 220);
    return () => clearTimeout(timer);
  }, [apiBase, effort, hasLoadedRemoteSelection, hasLoadedSelection, model]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      for (const attachment of attachmentsRef.current) {
        revokePreviewUrl(attachment.previewUrl);
      }
    };
  }, []);

  useEffect(() => {
    if (!disabled) return;
    dragDepthRef.current = 0;
    setIsDropTargetActive(false);
  }, [disabled]);

  useEffect(() => {
    if (!queueMenuOpenId) return;
    if (queuedMessages.some((message) => message.id === queueMenuOpenId)) return;
    setQueueMenuOpenId(null);
  }, [queueMenuOpenId, queuedMessages]);

  useEffect(() => {
    if (!queueMenuOpenId) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("[data-queued-menu='true']")) return;
      setQueueMenuOpenId(null);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [queueMenuOpenId]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const next: ComposerAttachment[] = [];
      for (const attachment of current) {
        if (attachment.id === id) {
          revokePreviewUrl(attachment.previewUrl);
          continue;
        }
        next.push(attachment);
      }
      return next;
    });
  }, []);

  const appendFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const nextAttachments: ComposerAttachment[] = [];
    let oversizedCount = 0;
    let unsupportedCount = 0;
    for (const [index, file] of files.entries()) {
      if (!(file instanceof File)) {
        unsupportedCount += 1;
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        oversizedCount += 1;
        continue;
      }
      const mimeType = file.type || "application/octet-stream";
      const kind: "image" | "file" = mimeType.startsWith("image/") ? "image" : "file";
      const fallbackName =
        kind === "image"
          ? `image-${Date.now()}-${index + 1}.png`
          : `file-${Date.now()}-${index + 1}`;
      const previewUrl = kind === "image" ? safeCreateObjectUrl(file) : null;
      nextAttachments.push({
        id: createClientId(),
        name: file.name?.trim() || fallbackName,
        mimeType,
        kind,
        file,
        previewUrl,
      });
    }
    if (oversizedCount || unsupportedCount) {
      const reasons: string[] = [];
      if (oversizedCount) reasons.push(`${oversizedCount} file(s) too large (max 20MB each)`);
      if (unsupportedCount) reasons.push(`${unsupportedCount} file(s) are not supported by this browser`);
      setAttachmentError(`Could not add some files: ${reasons.join(", ")}.`);
    } else {
      setAttachmentError(null);
    }
    if (!nextAttachments.length) return;
    setAttachments((current) => [...current, ...nextAttachments]);
  }, []);

  const resetDropTarget = useCallback(() => {
    dragDepthRef.current = 0;
    setIsDropTargetActive(false);
  }, []);

  const handleComposerDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (disabled || !hasFilesInDataTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current += 1;
      setIsDropTargetActive(true);
    },
    [disabled],
  );

  const handleComposerDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (disabled || !hasFilesInDataTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      if (!isDropTargetActive) {
        setIsDropTargetActive(true);
      }
    },
    [disabled, isDropTargetActive],
  );

  const handleComposerDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!isDropTargetActive) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDropTargetActive(false);
      }
    },
    [isDropTargetActive],
  );

  const handleComposerDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const hasFiles = hasFilesInDataTransfer(event.dataTransfer);
      if (!isDropTargetActive && !hasFiles) return;
      event.preventDefault();
      event.stopPropagation();
      resetDropTarget();
      if (disabled || !hasFiles) return;
      const files = filesFromDataTransfer(event.dataTransfer);
      if (!files.length) return;
      void appendFiles(files);
    },
    [appendFiles, disabled, isDropTargetActive, resetDropTarget],
  );

  const submit = useCallback(() => {
    const text = valueRef.current.trim();
    const outgoingAttachments: OutgoingAttachment[] = attachments.map(
      ({ id, name, mimeType, kind, dataBase64, file }) => ({ id, name, mimeType, kind, dataBase64, file }),
    );
    if (!text && outgoingAttachments.length === 0) return;
    const modelValue = model ? (effort ? `${model}:${effort}` : model) : "";
    onSend(text, modelValue, outgoingAttachments);
    valueRef.current = "";
    hasTextRef.current = false;
    setHasText(false);
    setAttachmentError(null);
    setAttachments((current) => {
      current.forEach((attachment) => revokePreviewUrl(attachment.previewUrl));
      return [];
    });
    if (textAreaRef.current) {
      textAreaRef.current.value = "";
      resizeTextArea(textAreaRef.current);
    }
  }, [attachments, effort, model, onSend, resizeTextArea]);

  const restoreComposerFocus = useCallback(() => {
    const textarea = textAreaRef.current;
    if (!textarea) return;
    requestAnimationFrame(() => {
      textarea.focus({ preventScroll: true });
    });
  }, []);

  const restoreQueuedDraft = useCallback(
    (draft: QueuedComposerDraft) => {
      const nextText = typeof draft.text === "string" ? draft.text : "";
      const restoredAttachments: ComposerAttachment[] = (draft.attachments ?? []).map((attachment) => {
        const nextId = typeof attachment.id === "string" && attachment.id.trim() ? attachment.id : createClientId();
        const previewUrl =
          attachment.kind === "image" && attachment.file instanceof File ? safeCreateObjectUrl(attachment.file) : null;
        return {
          id: nextId,
          name: attachment.name,
          mimeType: attachment.mimeType,
          kind: attachment.kind,
          dataBase64: attachment.dataBase64,
          file: attachment.file,
          previewUrl,
        };
      });
      const selection = parseModelSelection(draft.modelValue ?? "");
      if (selection.model) {
        setModel(selection.model);
        setEffort(selection.effort ?? defaultEffortByModel[selection.model] ?? null);
      }
      valueRef.current = nextText;
      const nextHasText = nextText.trim().length > 0;
      hasTextRef.current = nextHasText;
      setHasText(nextHasText);
      setAttachmentError(null);
      setAttachments((current) => {
        current.forEach((attachment) => revokePreviewUrl(attachment.previewUrl));
        return restoredAttachments;
      });
      const textarea = textAreaRef.current;
      if (textarea) {
        textarea.value = nextText;
        resizeTextArea(textarea);
        requestAnimationFrame(() => {
          textarea.focus({ preventScroll: true });
          const cursorIndex = textarea.value.length;
          textarea.setSelectionRange(cursorIndex, cursorIndex);
        });
      }
    },
    [defaultEffortByModel, resizeTextArea],
  );

  const showStop = busy && !hasText && attachments.length === 0;
  const canSend = (hasText || attachments.length > 0) && !disabled;
  const canSteer = queuedCount > 0 && !disabled && !steerBlockedByExternalSurface && (steerEnabled || !busy);
  const steerButtonDisabled = queuedCount <= 0 || disabled || (!canSteer && !steerBlockedByExternalSurface);
  const steerTitle = steerBlockedByExternalSurface
    ? "You cannot steer because the current run was started on another Codex surface"
    : canSteer
      ? "Send the next queued message immediately"
      : "Enable features.steer to send while a run is active";

  return (
    <div
      ref={rootRef}
      className="fixed inset-x-0 bottom-0 z-30 bg-codex-bg px-4 pb-[max(env(safe-area-inset-bottom),0.875rem)] pt-0 md:mb-5 md:static md:z-20 md:bg-transparent md:px-6 md:pb-0 md:pt-0"
    >
      <div
        onDragEnter={handleComposerDragEnter}
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={handleComposerDrop}
        className={`relative flex ${contentWidthClass} flex-col gap-2 rounded-[24px] border bg-codex-panel p-3 transition ${
          isDropTargetActive
            ? "border-sky-200/80 shadow-[0_0_0_1px_rgba(186,230,253,0.4),0_20px_45px_rgba(14,116,144,0.22),inset_0_0_0_1px_rgba(255,255,255,0.05)]"
            : "border-white/10 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)] hover:border-white/20"
        }`}
      >
        {isDropTargetActive ? (
          <div className="pointer-events-none absolute inset-0 z-20 rounded-[24px] border border-dashed border-sky-100/80 bg-sky-400/10" />
        ) : null}
        <input
          id={fileInputId}
          type="file"
          multiple
          className="sr-only"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            if (!files.length) return;
            void appendFiles(files);
            event.currentTarget.value = "";
          }}
        />
        {attachments.length ? (
          <div className="flex flex-wrap gap-2 px-1">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-[12px] text-white/80"
              >
                {attachment.kind === "image" && attachment.previewUrl ? (
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className="h-7 w-7 rounded object-cover ring-1 ring-white/20"
                  />
                ) : (
                  <span className="text-white/45">FILE</span>
                )}
                <span className="max-w-[200px] truncate">{attachment.name}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.id)}
                  className="flex h-6 w-6 items-center justify-center rounded-full text-white/55 transition hover:bg-white/10 hover:text-white"
                  aria-label={`Remove ${attachment.name}`}
                >
                  <X className="h-4 w-4" strokeWidth={2.2} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {attachmentError ? (
          <div className="px-1 text-[12px] text-rose-300 md:text-[12px]">{attachmentError}</div>
        ) : null}
        {queuedCount > 0 ? (
          <div className="mx-1 flex flex-col gap-1.5 rounded-2xl border border-white/12 bg-white/[0.04] p-2">
            <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/55">
              Queue {queuedCount}
            </div>
            {queuedMessages.slice(0, 3).map((message, index) => {
              const isHead = index === 0;
              return (
                <div
                  key={message.id}
                  className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 ${
                    isHead ? "border-white/18 bg-white/[0.05]" : "border-white/10 bg-black/20"
                  }`}
                >
                  <div className="text-white/35">↳</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-white/82">{message.preview || queuedPreview || "Pending message"}</div>
                    {message.detail ? (
                      <div className="truncate text-[11px] text-white/45">{message.detail}</div>
                    ) : null}
                  </div>
                  {isHead ? (
                    <button
                      type="button"
                      onPointerDown={(event) => {
                        if (!steerBlockedByExternalSurface) return;
                        event.preventDefault();
                      }}
                      onClick={() => {
                        onSteer();
                        if (steerBlockedByExternalSurface) {
                          restoreComposerFocus();
                        }
                      }}
                      disabled={steerButtonDisabled}
                      title={steerTitle}
                      className={`rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/80 transition hover:border-white/35 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40 ${
                        canSteer ? "" : "opacity-40"
                      }`}
                    >
                      Steer
                    </button>
                  ) : null}
                  <div className="relative" data-queued-menu="true">
                    <button
                      type="button"
                      onClick={() => {
                        setQueueMenuOpenId((current) => (current === message.id ? null : message.id));
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/50 transition hover:border-white/25 hover:bg-white/10 hover:text-white"
                      aria-label="Queued message actions"
                      aria-haspopup="menu"
                      aria-expanded={queueMenuOpenId === message.id}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                    {queueMenuOpenId === message.id ? (
                      <div
                        role="menu"
                        className="absolute right-0 top-[calc(100%+0.35rem)] z-20 min-w-[120px] rounded-xl border border-white/15 bg-codex-panel p-1.5 shadow-[0_14px_30px_rgba(0,0,0,0.35)]"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setQueueMenuOpenId(null);
                            const draft = onEditQueued(message.id);
                            if (!draft) {
                              restoreComposerFocus();
                              return;
                            }
                            restoreQueuedDraft(draft);
                          }}
                          className="flex w-full items-center justify-start rounded-lg px-2.5 py-1.5 text-[13px] text-white/82 transition hover:bg-white/10 hover:text-white"
                        >
                          Edit
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setQueueMenuOpenId((current) => (current === message.id ? null : current));
                      onRemoveQueued(message.id);
                    }}
                    className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/50 transition hover:border-white/25 hover:bg-white/10 hover:text-white"
                    aria-label="Remove queued message"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
            {queuedMessages.length > 3 ? (
              <div className="px-1 text-[11px] text-white/45">
                +{queuedMessages.length - 3} more queued
              </div>
            ) : null}
          </div>
        ) : null}
        <textarea
          ref={textAreaRef}
          rows={1}
          placeholder={placeholder}
          onInput={(event) => {
            const next = event.currentTarget.value;
            valueRef.current = next;
            const nextHasText = next.trim().length > 0;
            if (nextHasText !== hasTextRef.current) {
              hasTextRef.current = nextHasText;
              setHasText(nextHasText);
            }
            resizeTextArea(event.currentTarget);
          }}
          onKeyDown={(event) => {
            if ((event.nativeEvent as KeyboardEvent).isComposing) return;
            if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              submit();
            }
          }}
          onPaste={(event) => {
            const items = Array.from(event.clipboardData?.items ?? []);
            if (!items.length) return;
            const files = items
              .filter((item) => item.kind === "file")
              .map((item) => item.getAsFile())
              .filter((file): file is File => Boolean(file));
            if (!files.length) return;
            void appendFiles(files);
          }}
          disabled={disabled}
          className="min-h-[40px] w-full resize-none rounded-2xl bg-transparent px-1 text-[17px] leading-6 text-white/90 placeholder:text-white/40 focus:outline-none disabled:opacity-70 md:text-[17px] md:leading-6"
        />
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 md:gap-2">
            <label
              htmlFor={fileInputId}
              onClick={(event) => {
                if (disabled) {
                  event.preventDefault();
                  return;
                }
                setAttachmentError(null);
              }}
              className={`flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/80 transition ${
                disabled
                  ? "cursor-not-allowed opacity-50"
                  : "cursor-pointer hover:border-white/25 hover:bg-white/10"
              }`}
              aria-disabled={disabled}
              aria-label="Add files"
            >
              <Plus className="h-4 w-4" />
            </label>
            <div className="relative min-w-0 flex-[1.75] md:flex-none">
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={disabled || !modelOptions.length}
                className="h-8 w-full appearance-none rounded-full border border-white/10 bg-white/5 px-2 pr-6 text-[12px] text-white/85 focus:outline-none disabled:opacity-60 md:h-auto md:w-auto md:min-w-[150px] md:px-2.5 md:py-1.5 md:pr-7 md:text-[14px]"
                aria-label="Model"
              >
                {modelOptions.length
                  ? modelOptions.map((option) => (
                      <option key={option.value} value={option.value} className="bg-codex-panel text-white">
                        {option.label}
                      </option>
                    ))
                  : (
                      <option value="" className="bg-codex-panel text-white">
                        No models available
                      </option>
                    )}
              </select>
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-white/50 md:right-3 md:text-[14px]">▾</span>
            </div>
            <div className="relative min-w-[104px] flex-1 md:min-w-[112px] md:flex-none">
              <select
                value={effort ?? ""}
                onChange={(event) => setEffort(event.target.value || null)}
                disabled={disabled || !effortOptions.length}
                className="h-8 w-full appearance-none rounded-full border border-white/10 bg-white/5 px-2 pr-6 text-[12px] text-white/85 focus:outline-none disabled:opacity-60 md:h-auto md:w-auto md:min-w-[112px] md:px-2.5 md:py-1.5 md:pr-7 md:text-[14px]"
                aria-label="Reasoning effort"
              >
                {effortOptions.length ? (
                  effortOptions.map((option) => (
                    <option key={option.value} value={option.value} className="bg-codex-panel text-white">
                      {option.label}
                    </option>
                  ))
                ) : (
                  <option value="" className="bg-codex-panel text-white">
                    Standard
                  </option>
                )}
              </select>
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-white/50 md:right-3 md:text-[14px]">▾</span>
            </div>
          </div>
          <button
            onClick={() => {
              if (showStop) {
                onStop();
              } else {
                submit();
              }
            }}
            disabled={showStop ? disabled : !canSend}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 md:h-9 md:w-9 ${
              showStop ? "bg-white text-black hover:bg-white/90" : "bg-white text-black hover:bg-white/90"
            }`}
            aria-label={showStop ? "Stop" : "Send"}
          >
            {showStop ? (
              <svg viewBox="0 0 24 24" className="h-[15px] w-[15px] md:h-[16px] md:w-[16px]" fill="currentColor">
                <rect x="5" y="5" width="14" height="14" rx="2.4" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-[16px] w-[16px] md:h-[18px] md:w-[18px]" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14" />
                <path d="M6 11l6-6 6 6" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
});
