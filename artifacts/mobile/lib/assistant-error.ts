// Classifies a failed AI Assistant send so the UI can show a useful, translated
// message instead of silently dropping the user's text. UI-free, unit-tested.
//
// Phase 2 Batch 1: the classification is shared with card scanning and the
// offline sync engine (lib/api-failure.ts), so "AI is not configured", "AI is
// temporarily unavailable" and "session expired" read the same in the Assistant
// as on the camera screen. No provider detail ever reaches the message.
import { assistantCanRetry, assistantFailureKey, classifyApiFailure, type ApiFailureKind } from "./api-failure";

export type SendErrorKind =
  | "network"
  | "session_expired"
  | "permission"
  | "not_entitled"
  | "rate_limited"
  | "budget_exceeded"
  | "ai_unavailable"
  | "ai_not_configured"
  | "ai_disabled"
  | "server";

const FROM_FAILURE: Partial<Record<ApiFailureKind, SendErrorKind>> = {
  network: "network",
  session_expired: "session_expired",
  permission: "permission",
  not_entitled: "not_entitled",
  rate_limited: "rate_limited",
  ai_budget: "budget_exceeded",
  ai_unavailable: "ai_unavailable",
  ai_platform_limit: "ai_unavailable",
  upstream: "ai_unavailable",
  ai_not_configured: "ai_not_configured",
  ai_disabled: "ai_disabled",
};

const TO_FAILURE: Record<SendErrorKind, ApiFailureKind> = {
  network: "network",
  session_expired: "session_expired",
  permission: "permission",
  not_entitled: "not_entitled",
  rate_limited: "rate_limited",
  budget_exceeded: "ai_budget",
  ai_unavailable: "ai_unavailable",
  ai_not_configured: "ai_not_configured",
  ai_disabled: "ai_disabled",
  server: "server",
};

export function classifySendError(err: unknown): SendErrorKind {
  return FROM_FAILURE[classifyApiFailure(err).kind] ?? "server";
}

// i18n key for the error message shown under a failed send bubble.
export function sendErrorMessageKey(kind: SendErrorKind): string {
  return assistantFailureKey(TO_FAILURE[kind] ?? "server");
}

/** Whether "Retry" can help. It cannot while AI is switched off, unconfigured or over budget, or after the session ended. */
export function canRetrySend(kind: SendErrorKind): boolean {
  return assistantCanRetry(TO_FAILURE[kind] ?? "server");
}
