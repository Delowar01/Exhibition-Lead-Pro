// Classifies a failed AI assistant send so the UI can show a useful, translated
// error instead of silently dropping the user's message. Kept UI-free so it can
// be unit-tested in the node vitest environment.

export type SendErrorKind = "network" | "permission" | "server";

export function classifySendError(err: unknown): SendErrorKind {
  // ApiError (and any HTTP-shaped error) carries a numeric status.
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number") {
      if (status === 401 || status === 403) return "permission";
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
    default:
      return "assistant.sendFailed";
  }
}
