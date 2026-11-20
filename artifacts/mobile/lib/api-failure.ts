// Phase 2 Batch 1 — ONE classification of a failed API call for the whole
// mobile app. Camera capture, batch scanning, scan review / reprocess, the AI
// Assistant and the offline sync engine all ask this module what went wrong,
// so the same server answer produces the same advice on every screen.
//
// Pure and framework-free (unit-tested in node). It reads only the HTTP status
// and the machine `code` the API attaches to its error bodies. It never returns
// provider names, model names, request ids or raw provider text: the only
// server text it may pass on is the API's own user-facing `error` sentence, and
// only for the kinds listed in `mayShowServerMessage`.

export type ApiFailureKind =
  /** The request never got an answer (no connection, DNS, timeout, aborted). */
  | "network"
  /** 401 — the session is no longer valid; the user has to sign in again. */
  | "session_expired"
  /** 403 FEATURE_NOT_ENTITLED — the plan does not include this feature. */
  | "not_entitled"
  /** 403 — this user may not do this. */
  | "permission"
  /** AI is switched off for the company (AI_DISABLED / AI_FEATURE_DISABLED). */
  | "ai_disabled"
  /** The AI provider has no credential on the server (AI_NOT_CONFIGURED). */
  | "ai_not_configured"
  /** The provider — and its fallback, where one is allowed — did not answer (AI_PROVIDER_UNAVAILABLE). */
  | "ai_unavailable"
  /** The platform's AI spending limit is reached (AI_PLATFORM_LIMIT_REACHED). */
  | "ai_platform_limit"
  /** The company's monthly AI budget is used up (AI_BUDGET_EXCEEDED). */
  | "ai_budget"
  /** Too many requests in a short time (AI_RATE_LIMITED or a plain 429). */
  | "rate_limited"
  /** No readable business card in the image (SCAN_NO_CARD / 422). */
  | "no_card"
  /** The image is too large for the server (SCAN_IMAGE_TOO_LARGE / 413). */
  | "image_too_large"
  /** HEIC image the server cannot decode (SCAN_IMAGE_HEIC_UNSUPPORTED). */
  | "image_heic"
  /** 400 — the request was refused as invalid. */
  | "invalid"
  /** 409 existing_contact_found — a matching contact already exists; a person decides. */
  | "duplicate"
  /** 409 LIMIT_EXCEEDED — the subscription's limit for this resource is reached. */
  | "limit"
  /** 404 — the record no longer exists. */
  | "not_found"
  /** 502 / 503 / 504 without a machine code — the service behind the API did not answer (retrying may help). */
  | "upstream"
  /** Any other 5xx, or an answer that is not what the API returns. */
  | "server"
  | "unknown";

export interface ApiFailure {
  kind: ApiFailureKind;
  status: number | null;
  /** Machine code from the error body (never shown to the user). */
  code: string | null;
  /** The API's own user-facing sentence, when the body carries one. */
  serverMessage: string | null;
}

function readBody(data: unknown): { error: string | null; code: string | null } {
  if (!data || typeof data !== "object") return { error: null, code: null };
  const b = data as Record<string, unknown>;
  const text = typeof b.error === "string" && b.error.trim().length > 0 ? b.error : typeof b.message === "string" && b.message.trim().length > 0 ? b.message : null;
  return { error: text, code: typeof b.code === "string" && b.code.length > 0 ? b.code : null };
}

/** Classify an HTTP failure from its status and parsed error body. */
export function classifyHttpFailure(status: number, data: unknown): ApiFailure {
  const { error, code } = readBody(data);
  const make = (kind: ApiFailureKind): ApiFailure => ({ kind, status, code, serverMessage: error });

  // Machine codes first: they are more precise than the status they travel with.
  switch (code) {
    case "AI_BUDGET_EXCEEDED":
      return make("ai_budget");
    case "AI_RATE_LIMITED":
      return make("rate_limited");
    case "AI_DISABLED":
    case "AI_FEATURE_DISABLED":
      return make("ai_disabled");
    case "AI_NOT_CONFIGURED":
      return make("ai_not_configured");
    case "AI_PROVIDER_UNAVAILABLE":
      return make("ai_unavailable");
    case "AI_PLATFORM_LIMIT_REACHED":
      return make("ai_platform_limit");
    case "SCAN_NO_CARD":
      return make("no_card");
    case "SCAN_IMAGE_TOO_LARGE":
      return make("image_too_large");
    case "SCAN_IMAGE_HEIC_UNSUPPORTED":
      return make("image_heic");
    case "FEATURE_NOT_ENTITLED":
      return make("not_entitled");
    case "existing_contact_found":
      return make("duplicate");
    case "LIMIT_EXCEEDED":
      return make("limit");
    default:
      break;
  }

  if (status === 401) return make("session_expired");
  if (status === 403) return make("permission");
  if (status === 404) return make("not_found");
  if (status === 413) return make("image_too_large");
  if (status === 422) return make("no_card");
  if (status === 429) return make("rate_limited");
  if (status === 400) return make("invalid");
  if (status === 502 || status === 503 || status === 504) return make("upstream");
  if (status >= 500) return make("server");
  return make("unknown");
}

/** True for the errors `fetch` raises when no answer arrived at all. */
export function isTransportError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const name = err && typeof err === "object" ? (err as { name?: unknown }).name : null;
  if (name === "AbortError" || name === "TimeoutError") return true;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /network request failed|failed to fetch|network error|networkerror|timed? ?out|aborted|connection (was )?(lost|reset|refused)/i.test(msg);
}

/** Classify anything a request can throw (ApiError, parse error, transport error). */
export function classifyApiFailure(err: unknown): ApiFailure {
  if (err && typeof err === "object") {
    const e = err as { status?: unknown; data?: unknown; name?: unknown };
    // An answer that could not be parsed as what the API returns (for example a
    // sign-in page from a public Wi-Fi portal) is NOT a success and NOT the
    // user's fault.
    if (e.name === "ResponseParseError") {
      return { kind: "server", status: typeof e.status === "number" ? e.status : null, code: null, serverMessage: null };
    }
    if (typeof e.status === "number") return classifyHttpFailure(e.status, e.data);
  }
  if (isTransportError(err)) return { kind: "network", status: null, code: null, serverMessage: null };
  return { kind: "unknown", status: null, code: null, serverMessage: null };
}

const AI_WIDE: ReadonlySet<ApiFailureKind> = new Set<ApiFailureKind>([
  "ai_disabled",
  "ai_not_configured",
  "ai_unavailable",
  "ai_platform_limit",
  "ai_budget",
]);

/**
 * AI is unavailable for EVERY card right now, not just this image: retaking the
 * photo cannot help, while QR, NFC and manual capture keep working.
 */
export function isAiWideFailure(kind: ApiFailureKind): boolean {
  return AI_WIDE.has(kind);
}

/**
 * A capture that failed for one of these reasons is worth keeping on the device:
 * nothing is wrong with the photo, and sending it again later can succeed.
 * (A card that could not be read, an oversized image or a refusal is reported
 * instead, so the user can retake the photo straight away.)
 */
export function worthKeepingForLater(kind: ApiFailureKind): boolean {
  return kind === "network" || kind === "session_expired" || kind === "rate_limited" || kind === "ai_unavailable" || kind === "ai_platform_limit" || kind === "ai_budget" || kind === "ai_not_configured";
}

/**
 * The API localizes its own sentence for a refused or unreadable image; that
 * text may be shown as is. Every other kind is explained with the app's own
 * localized wording.
 */
export function mayShowServerMessage(kind: ApiFailureKind): boolean {
  return kind === "invalid" || kind === "upstream";
}

/** i18n key of the message for a failed card scan / reprocess (camera, batch, scan review). */
export function scanFailureKey(kind: ApiFailureKind): string {
  switch (kind) {
    case "network":
      return "capture.errNetwork";
    case "session_expired":
      return "capture.errAuth";
    case "not_entitled":
      return "capture.errNotEntitled";
    case "permission":
      return "capture.errPermission";
    case "ai_disabled":
      return "capture.errAiDisabled";
    case "ai_not_configured":
      return "capture.errAiNotConfigured";
    // A provider outage and a reached platform spending limit get the SAME
    // sentence: both mean "AI is unavailable for now, other capture modes
    // work", and the platform's own limits are not a customer's concern.
    case "ai_unavailable":
    case "ai_platform_limit":
      return "capture.errAiUnavailable";
    case "ai_budget":
      return "capture.errBudget";
    case "rate_limited":
      return "capture.errRateLimit";
    case "no_card":
      return "capture.errNoCard";
    case "image_too_large":
      return "capture.errTooLarge";
    case "image_heic":
      return "capture.errHeic";
    case "invalid":
      return "capture.errInvalid";
    case "upstream":
      return "capture.errOcr";
    case "limit":
      return "capture.errLimit";
    case "server":
      return "capture.errServer";
    default:
      return "capture.captureFailed";
  }
}

/** i18n key of the message under a failed AI Assistant message. */
export function assistantFailureKey(kind: ApiFailureKind): string {
  switch (kind) {
    case "network":
      return "assistant.sendFailedNetwork";
    case "session_expired":
      return "assistant.sendFailedSession";
    case "not_entitled":
      return "assistant.sendFailedNotEntitled";
    case "permission":
      return "assistant.sendFailedPermission";
    case "ai_disabled":
      return "assistant.sendFailedDisabled";
    case "ai_not_configured":
      return "assistant.sendFailedNotConfigured";
    case "ai_unavailable":
    case "ai_platform_limit":
    case "upstream":
      return "assistant.sendFailedUnavailable";
    case "ai_budget":
      return "assistant.sendFailedBudget";
    case "rate_limited":
      return "assistant.sendFailedRateLimited";
    default:
      return "assistant.sendFailed";
  }
}

/** Should the Assistant offer "Retry" for this failure? (Pointless while AI is unavailable for the company.) */
export function assistantCanRetry(kind: ApiFailureKind): boolean {
  return kind !== "session_expired" && kind !== "not_entitled" && kind !== "permission" && kind !== "ai_disabled" && kind !== "ai_not_configured" && kind !== "ai_budget";
}

/**
 * A save that failed because no answer arrived, or because the session ended
 * while it was under way. Nothing is wrong with what the user entered: it is
 * kept on the device and sent later instead of being lost with the screen.
 */
export function lostConnectionOrSession(err: unknown): boolean {
  const kind = classifyApiFailure(err).kind;
  return kind === "network" || kind === "session_expired";
}

/**
 * The request went out and NO answer came back, so the server may or may not
 * have handled it. (An expired session is a definite answer: nothing was done.)
 */
export function answerWasLost(err: unknown): boolean {
  return classifyApiFailure(err).kind === "network";
}
