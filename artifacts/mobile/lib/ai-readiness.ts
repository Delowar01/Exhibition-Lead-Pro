// MOBILE-R1 — AI card-scanning readiness, derived from GET /ai/health (the tenant's
// provider configuration as the server reports it). Pure and framework-free.
//
// The server decides: `configured` is its credential-presence check for the tenant's
// provider (never a key, never a provider detail reaches the client beyond the name).
// The client only classifies the answer:
//   • ready        — scanning may be offered normally;
//   • unconfigured — the operator has not configured the provider for this
//                    environment: show the notice BEFORE the user takes a photo and
//                    keep every non-AI capture path (QR, NFC, manual) available;
//   • unknown      — no answer yet, a transport failure, a 401/403 or a malformed body:
//                    never block scanning on an unknown state (the scan request itself
//                    still receives the authoritative 503 AI_NOT_CONFIGURED if needed).
export type AiReadiness = "ready" | "unconfigured" | "unknown";

export function aiReadinessFromHealth(data: unknown): AiReadiness {
  if (!data || typeof data !== "object") return "unknown";
  const b = data as Record<string, unknown>;
  if (b.configured === false) return "unconfigured";
  if (b.configured === true) return "ready";
  if (b.status === "unconfigured") return "unconfigured";
  return "unknown";
}

/** i18n key (under `capture.`) for the pre-scan notice, or null when nothing should be shown. */
export function aiReadinessNoticeKey(state: AiReadiness): string | null {
  return state === "unconfigured" ? "capture.aiNotConfiguredBody" : null;
}
