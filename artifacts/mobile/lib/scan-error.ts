// Batch 7 — shared mapping from a failed scan/OCR API response to an i18n key.
// Pure and framework-free so it is unit-testable. Callers translate the key and
// prefer `serverMessage` only where the descriptor allows it (the server localizes
// its scan errors by appLanguage for 400/502 bodies).

export interface ScanErrorDescriptor {
  /** i18n key under the `capture.` namespace (or `capture.captureFailed`). */
  key: string;
  /** Server-provided human message, when present AND appropriate to show. */
  serverMessage: string | null;
}

function readBody(data: unknown): { error: string | null; code: string | null } {
  if (!data || typeof data !== "object") return { error: null, code: null };
  const b = data as Record<string, unknown>;
  return {
    error: typeof b.error === "string" && b.error.length > 0 ? b.error : null,
    code: typeof b.code === "string" ? b.code : null,
  };
}

/**
 * Map an HTTP failure from POST /scans (or reprocess/replace) to a message key.
 * `status` is the HTTP status, `data` the parsed error body (may be undefined).
 */
export function describeScanError(status: number, data: unknown): ScanErrorDescriptor {
  const { error, code } = readBody(data);
  // Machine codes take priority over raw status mapping.
  if (code === "AI_BUDGET_EXCEEDED") return { key: "capture.errBudget", serverMessage: null };
  if (code === "AI_RATE_LIMITED") return { key: "capture.errRateLimit", serverMessage: null };
  if (code === "AI_DISABLED") return { key: "capture.errAiDisabled", serverMessage: null };
  if (code === "SCAN_NO_CARD" || status === 422) return { key: "capture.errNoCard", serverMessage: null };
  if (code === "SCAN_IMAGE_TOO_LARGE" || status === 413) return { key: "capture.errTooLarge", serverMessage: null };
  // Batch 8 — HEIC (HEVC) cannot be decoded server-side; tell the user to use JPEG.
  if (code === "SCAN_IMAGE_HEIC_UNSUPPORTED") return { key: "capture.errHeic", serverMessage: null };

  if (status === 429) return { key: "capture.errRateLimit", serverMessage: null };
  if (status === 502 || status === 503 || status === 504) return { key: "capture.errOcr", serverMessage: error };
  if (status === 400) return { key: "capture.errInvalid", serverMessage: error };
  if (status === 401 || status === 403) return { key: "capture.errAuth", serverMessage: null };
  if (status >= 500) return { key: "capture.errServer", serverMessage: null };
  return { key: "capture.captureFailed", serverMessage: error };
}
