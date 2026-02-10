type InterruptProjectionInput = {
  runningTurnIds: ReadonlySet<string>;
  interruptRequested: boolean;
  interruptedTurnId: string | null;
};

type InterruptProjection = {
  uiRunningTurnIds: Set<string>;
  interruptedTurnStillRunning: boolean;
};

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

function normalizeNumericIdentity(value: string): string {
  const trimmed = value.replace(/^0+(?=\d)/, "");
  return trimmed || "0";
}

function normalizeComparableTurnId(value: unknown): string | null {
  const normalized = normalizeTurnId(value);
  if (!normalized) return null;
  if (normalized === "external-run") return normalized;
  if (/^\d+$/.test(normalized)) {
    return normalizeNumericIdentity(normalized);
  }
  const prefixedNumeric = normalized.match(/^turn[-_:]?(\d+)$/i);
  if (prefixedNumeric?.[1]) {
    return normalizeNumericIdentity(prefixedNumeric[1]);
  }
  return normalized;
}

export function turnIdsReferToSameTurn(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeTurnId(left);
  const normalizedRight = normalizeTurnId(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  const comparableLeft = normalizeComparableTurnId(normalizedLeft);
  const comparableRight = normalizeComparableTurnId(normalizedRight);
  return Boolean(comparableLeft && comparableRight && comparableLeft === comparableRight);
}

function hasMatchingTurnId(runningTurnIds: ReadonlySet<string>, interruptedTurnId: string): boolean {
  for (const runningTurnId of runningTurnIds) {
    if (turnIdsReferToSameTurn(runningTurnId, interruptedTurnId)) return true;
  }
  return false;
}

function deleteMatchingTurnIds(target: Set<string>, interruptedTurnId: string): void {
  for (const runningTurnId of Array.from(target)) {
    if (turnIdsReferToSameTurn(runningTurnId, interruptedTurnId)) {
      target.delete(runningTurnId);
    }
  }
}

export function projectRunningTurnsForUi({
  runningTurnIds,
  interruptRequested,
  interruptedTurnId,
}: InterruptProjectionInput): InterruptProjection {
  const uiRunningTurnIds = new Set(runningTurnIds);
  if (!interruptRequested || !interruptedTurnId) {
    return {
      uiRunningTurnIds,
      interruptedTurnStillRunning: false,
    };
  }

  const interruptedTurnStillRunning =
    interruptedTurnId === "external-run"
      ? runningTurnIds.size > 0
      : hasMatchingTurnId(runningTurnIds, interruptedTurnId);

  if (!interruptedTurnStillRunning) {
    return {
      uiRunningTurnIds,
      interruptedTurnStillRunning: false,
    };
  }

  if (interruptedTurnId === "external-run") {
    uiRunningTurnIds.clear();
  } else {
    deleteMatchingTurnIds(uiRunningTurnIds, interruptedTurnId);
  }

  return {
    uiRunningTurnIds,
    interruptedTurnStillRunning: true,
  };
}
