// Classifies a failed AI assistant send so the UI can show a useful, translated
// error instead of silently dropping the user's message. Kept UI-free so it can
// be unit-tested in the node vitest environment.

export type SendErrorKind = "network" | "permission" | "rate_limited" | "budget_exceeded" | "server";

// Reads the machine-readable error code the API attaches to AI errors
// (e.g. AI_RATE_LIMITED vs AI_BUDGET_EXCEEDED — both HTTP 429, very different advice).
function errorCodeOf(err: object): string {
  const data = (err as { data?: unknown }).data;
  if (data && typeof data === "object" && typeof (data as { code?: unknown }).code === "string") {
    return (data as { code: string }).code;
  }
  return "";
}

export function classifySendError(err: unknown): SendErrorKind {
  // ApiError (and any HTTP-shaped error) carries a numeric status.
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number") {
      if (status === 401 || status === 403) return "permission";
      if (status === 429) {
        const code = errorCodeOf(err);
        if (code === "AI_BUDGET_EXCEEDED") return "budget_exceeded";
        return "rate_limited";
      }
      return "server";
    }
  }
  // fetch() throws TypeError on connectivity failures (RN: "Network request failed").
  if (err instanceof TypeError) return "network";
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (/network request failed|failed to fetch|network error|abort/i.test(msg)) return "network";
  return "server";
}

// i18n key for the error message shown under a failed send bubble.
export function sendErrorMessageKey(kind: SendErrorKind): string {
  switch (kind) {
    case "network":
      return "assistant.sendFailedNetwork";
    case "permission":
      return "assistant.sendFailedPermission";
    case "rate_limited":
      return "assistant.sendFailedRateLimited";
    case "budget_exceeded":
      return "assistant.sendFailedBudget";
    default:
      return "assistant.sendFailed";
  }
}
