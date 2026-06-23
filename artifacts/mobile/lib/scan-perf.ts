// Developer performance store — records pipeline metrics for every scan.
// In-memory only (no disk persistence); lost on app restart. Dev builds only.
// Gate all call sites with `if (__DEV__)` — this module is harmless in
// production (empty arrays, no-op subscribers) but should never be visible to
// end users, so don't add navigation to it outside of __DEV__ blocks.

export type ScanMode = "single" | "rapid" | "batch";
export type ScanSource = "card" | "signature";

export type ScanMetric = {
  id: string;
  ts: number;              // epoch ms at shutter press
  mode: ScanMode;
  source: ScanSource;

  // Stage timings (ms) ----------------------------------------
  captureRawMs: number;    // takePictureAsync (native, off JS thread)
  processMs: number;       // resize + compress + base64 encode (native)
  uploadAndOcrMs: number;  // POST /scans round-trip = network upload + server OCR inference
  contactMs: number | null; // POST /contacts; null for single (saved in review) + batch
  totalMs: number;         // shutter press → contact saved (or → review screen for single)

  // Image dimensions ------------------------------------------
  captureW: number;        // source width from camera
  captureH: number;        // source height from camera
  uploadW: number;         // final width sent to server (after resize clamp)
  payloadKb: number;       // upload body size in KB

  // OCR quality -----------------------------------------------
  confidence: number | null;

  // Threshold violations (populated by addScanMetric) ---------
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Configurable thresholds — adjust as needed after APK field testing.
// A violation does NOT block the scan; it surfaces in the Dev Performance UI.
// ---------------------------------------------------------------------------
export const PERF_THRESHOLDS = {
  captureRawMs: 1_000,     // camera shutter > 1s
  processMs:    1_000,     // resize/compress/encode > 1s
  uploadAndOcrMs: 5_000,   // upload + OCR > 5s
  contactMs:    1_000,     // contact POST > 1s
  totalMs:      8_000,     // full end-to-end > 8s
} as const satisfies Record<string, number>;

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------
const MAX_ENTRIES = 20;

let _entries: ScanMetric[] = [];
const _subscribers = new Set<() => void>();

function _notify(): void {
  for (const sub of _subscribers) sub();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Record a completed scan metric. Computes threshold warnings automatically. */
export function addScanMetric(metric: Omit<ScanMetric, "warnings">): void {
  const warnings: string[] = [];

  if (metric.captureRawMs > PERF_THRESHOLDS.captureRawMs)
    warnings.push(`Capture > ${PERF_THRESHOLDS.captureRawMs / 1000}s (${metric.captureRawMs}ms)`);
  if (metric.processMs > PERF_THRESHOLDS.processMs)
    warnings.push(`Process > ${PERF_THRESHOLDS.processMs / 1000}s (${metric.processMs}ms)`);
  if (metric.uploadAndOcrMs > PERF_THRESHOLDS.uploadAndOcrMs)
    warnings.push(`Upload+OCR > ${PERF_THRESHOLDS.uploadAndOcrMs / 1000}s (${metric.uploadAndOcrMs}ms)`);
  if (metric.contactMs != null && metric.contactMs > PERF_THRESHOLDS.contactMs)
    warnings.push(`Contact > ${PERF_THRESHOLDS.contactMs / 1000}s (${metric.contactMs}ms)`);
  if (metric.totalMs > PERF_THRESHOLDS.totalMs)
    warnings.push(`Total > ${PERF_THRESHOLDS.totalMs / 1000}s (${metric.totalMs}ms)`);

  _entries = [{ ...metric, warnings }, ..._entries].slice(0, MAX_ENTRIES);
  _notify();
}

/** Clear all stored metrics. */
export function clearScanMetrics(): void {
  _entries = [];
  _notify();
}

/** Snapshot of current entries (newest first). */
export function getScanMetrics(): readonly ScanMetric[] {
  return _entries;
}

/** Subscribe to store changes. Returns an unsubscribe function. */
export function subscribe(cb: () => void): () => void {
  _subscribers.add(cb);
  return () => _subscribers.delete(cb);
}
