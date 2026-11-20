// Mapping from a failed scan/OCR request to an i18n key (camera capture, batch
// review, scan review / reprocess). Pure and framework-free, unit-tested.
//
// Phase 2 Batch 1: the classification itself now lives in lib/api-failure.ts,
// shared with the AI Assistant and the offline sync engine, so one server
// answer gives the same advice everywhere. This module keeps the scan-specific
// shape its callers use.
import { classifyApiFailure, classifyHttpFailure, mayShowServerMessage, scanFailureKey, type ApiFailure, type ApiFailureKind } from "./api-failure";

export interface ScanErrorDescriptor {
  /** i18n key under the `capture.` namespace. */
  key: string;
  /** The API's own user-facing sentence, when present AND appropriate to show. */
  serverMessage: string | null;
  /** What went wrong, for callers that decide what to do next (keep for later, retry…). */
  kind: ApiFailureKind;
}

function describe(failure: ApiFailure): ScanErrorDescriptor {
  return {
    key: scanFailureKey(failure.kind),
    serverMessage: mayShowServerMessage(failure.kind) ? failure.serverMessage : null,
    kind: failure.kind,
  };
}

/**
 * Map an HTTP failure from POST /scans (or reprocess / replace) to a message key.
 * `status` is the HTTP status, `data` the parsed error body (may be undefined).
 */
export function describeScanError(status: number, data: unknown): ScanErrorDescriptor {
  return describe(classifyHttpFailure(status, data));
}

/** The same for anything a scan request can throw — including "no connection". */
export function describeScanFailure(err: unknown): ScanErrorDescriptor {
  return describe(classifyApiFailure(err));
}

const ACTION_SPECIFIC: ReadonlySet<ApiFailureKind> = new Set<ApiFailureKind>(["unknown", "upstream", "server", "invalid", "not_found"]);

/**
 * Message key for a failed action on an EXISTING scan (reprocess, replace
 * image, AI re-score). A cause the user can act on — no connection, session
 * ended, AI off / not configured / unavailable / over budget, no card in the
 * image, plan limit — gets its own advice; anything else keeps the wording of
 * the action that failed (`fallbackKey`).
 */
export function scanActionFailureKey(err: unknown, fallbackKey: string): string {
  const failure = classifyApiFailure(err);
  return ACTION_SPECIFIC.has(failure.kind) ? fallbackKey : scanFailureKey(failure.kind);
}
