// =============================================================================
// Batch 25 — provider-neutral object-storage contract. Every product object
// flow (documents, exports, executive reports, scan images, branding logos)
// goes through a StorageDriver via the storage service; no feature talks to a
// provider SDK directly. Drivers:
//   fs      encrypted files on a private filesystem volume (local dev, tests,
//           the Hostinger application VPS)
//   gcs     the existing Google Cloud Storage bucket — TEMPORARY legacy /
//           migration driver only
//   memory  deterministic in-process driver for unit tests
// Errors are sanitized: codes + fixed messages, never host paths, bucket names
// or object keys.
// =============================================================================
import type { Readable } from "node:stream";

export type StorageDriverKind = "fs" | "gcs" | "memory";

export type StorageErrorCode =
  | "STORAGE_NOT_FOUND"
  | "STORAGE_TOO_LARGE"
  | "STORAGE_INVALID_KEY"
  | "STORAGE_CORRUPT"
  | "STORAGE_WRONG_KEY"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_CONFLICT"
  | "STORAGE_INTEGRITY";

/**
 * Sanitized description of any error (B25 Correction 3). Lives here (no
 * imports) so the storage contract, the global error handler and the log
 * sanitizer share one shape: a stable class, a stable code / status, an
 * optional sanitized reason and a retryable hint — never a message, cause,
 * stack, key, path, bucket, token, SQL text or parameter.
 */
export interface ErrorShape {
  class: string;
  code?: string;
  status?: number;
  reason?: string;
  retryable?: boolean;
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const RETRYABLE_ERRNO = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "EBUSY", "EAGAIN"]);

export function describeError(err: unknown): ErrorShape {
  if (typeof err !== "object" || err === null) return { class: err === null ? "null" : typeof err };
  const e = err as { name?: unknown; code?: unknown; severity?: unknown; statusCode?: unknown; reason?: unknown };
  if (err instanceof Error && e.name === "StorageError") {
    const out: ErrorShape = { class: "StorageError", retryable: e.code === "STORAGE_UNAVAILABLE" };
    if (typeof e.code === "string" && SAFE_CODE.test(e.code)) out.code = e.code;
    if (typeof e.reason === "string" && SAFE_CODE.test(e.reason)) out.reason = e.reason;
    return out;
  }
  if (err instanceof Error && e.name === "StorageConfigError") return { class: "StorageConfigError" };
  if (err instanceof Error && e.name === "AppError") {
    const out: ErrorShape = { class: "AppError" };
    if (typeof e.statusCode === "number") out.status = e.statusCode;
    if (typeof e.code === "string" && SAFE_CODE.test(e.code)) out.code = e.code;
    return out;
  }
  if (err instanceof Error && e.name === "EnvelopeError") return { class: "EnvelopeError", code: typeof e.code === "string" && SAFE_CODE.test(e.code) ? e.code : undefined };
  if (typeof e.code === "number" && Number.isFinite(e.code)) {
    // Google / HTTP API errors expose the status as a numeric `code`.
    return { class: "ProviderError", status: e.code, retryable: e.code === 429 || e.code >= 500 };
  }
  if (typeof e.code === "string") {
    if (SQLSTATE.test(e.code) && (typeof e.severity === "string" || /^[0-9]/.test(e.code))) {
      // node-postgres errors: SQLSTATE in `code`, `severity`, and SQL / parameters that are never echoed.
      return { class: "DatabaseError", code: e.code, retryable: e.code.startsWith("08") || e.code === "57P01" || e.code === "40001" || e.code === "40P01" };
    }
    if (SAFE_CODE.test(e.code)) {
      // Node system errors (ENOENT, EACCES, ECONNRESET …): the errno name only — never `path` / `dest` / message.
      return { class: "SystemError", code: e.code, retryable: RETRYABLE_ERRNO.has(e.code) };
    }
  }
  if (err instanceof Error) return { class: typeof e.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(e.name) ? e.name : "Error" };
  return { class: "object" };
}

/** A storage CONFIGURATION problem (fixed, path-free message that startup may print). */
export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigError";
  }
}

export class StorageError extends Error {
  /** Optional sanitized reason code (e.g. NO_READABLE_COPY) — never a path or key. */
  reason?: string;
  /**
   * Sanitized summary of the underlying error (B25 Correction 3). The RAW cause
   * is never retained: pino serializes cause chains, so a provider / filesystem
   * / database error kept here would carry bucket names, host paths, SQL and
   * parameters into any `{ err }` log.
   */
  readonly causeInfo?: ErrorShape;
  constructor(readonly code: StorageErrorCode, message?: string, cause?: unknown, reason?: string) {
    super(message ?? STORAGE_ERROR_MESSAGES[code]);
    this.name = "StorageError";
    if (reason) this.reason = reason;
    if (cause !== undefined) this.causeInfo = describeError(cause);
  }
}

export const STORAGE_ERROR_MESSAGES: Record<StorageErrorCode, string> = {
  STORAGE_NOT_FOUND: "Object not found",
  STORAGE_TOO_LARGE: "Object exceeds the permitted size",
  STORAGE_INVALID_KEY: "Invalid storage key",
  STORAGE_CORRUPT: "Stored object is corrupt or was tampered with",
  STORAGE_WRONG_KEY: "Stored object was encrypted with a different key",
  STORAGE_UNAVAILABLE: "Object storage is unavailable",
  STORAGE_CONFLICT: "Object already exists",
  STORAGE_INTEGRITY: "Stored object failed integrity verification",
};

export function isStorageError(err: unknown, code?: StorageErrorCode): err is StorageError {
  return err instanceof StorageError && (code === undefined || err.code === code);
}

export interface PutOptions {
  contentType: string;
  /** Hard ceiling on PLAINTEXT bytes; the write fails with STORAGE_TOO_LARGE beyond it. */
  maxBytes: number;
  /** When set, the write fails with STORAGE_INTEGRITY if the computed digest/size differ. */
  expectedSha256?: string;
  expectedSize?: number;
  /**
   * B25 Correction 3 — durable ownership marker: the inventory row id, stored
   * as object metadata by providers that keep metadata (GCS: custom metadata
   * `lcp-object-id`). Automated cleanup deletes a bucket object only when the
   * marker names the row (and only the generation it observed).
   */
  owner?: string;
  /** B25 Correction 3 — never publish after this instant (checked right before publication). */
  publishDeadline?: Date;
  /** B25 Correction 3 — abort the write when it runs longer than this (bounds every publication). */
  timeoutMs?: number;
}

export interface PutResult {
  /** PLAINTEXT byte count. */
  sizeBytes: number;
  /** PLAINTEXT SHA-256, lowercase hex. */
  sha256: string;
  /**
   * Provider object generation / version created by THIS write when the
   * provider reports one (GCS, the fake adapter). Cleanup of a failed attempt
   * targets exactly this generation — never a bare key (B25 Correction 2).
   */
  generation?: string;
}

export interface DeleteOptions {
  /**
   * Delete only when the object's current generation equals this value
   * (ownership-proven cleanup). REQUIRED by the GCS driver (B25 Correction 6:
   * a provider delete without it is refused before the SDK is called). A mismatch rejects with STORAGE_CONFLICT /
   * reason GENERATION_MISMATCH and leaves the object untouched; drivers
   * without generations (fs) ignore it because their keys are attempt-unique.
   */
  ifGeneration?: string;
}

export interface ObjectHead {
  /** PLAINTEXT size when the driver knows it (gcs/memory); null when only ciphertext size is known (fs). */
  sizeBytes: number | null;
  contentType: string | null;
  /** Provider object generation when the provider has one (gcs / fake adapter). */
  generation?: string | null;
  /** Ownership marker (inventory row id) stored with the object, when the provider keeps metadata. */
  owner?: string | null;
}

export interface GetOptions {
  /** Hard ceiling on PLAINTEXT bytes emitted; the stream errors with STORAGE_TOO_LARGE beyond it. */
  maxBytes?: number;
}

export interface ObjectStream {
  stream: Readable;
  /** PLAINTEXT size when known up front (gcs/memory); null for fs (known only after the authenticated final frame). */
  sizeBytes: number | null;
  contentType: string | null;
}

export interface StorageDriver {
  readonly kind: StorageDriverKind;
  /** Write an object atomically. Existing objects are replaced only when `allowOverwrite` is true. */
  put(key: string, source: Readable | Buffer, opts: PutOptions & { allowOverwrite?: boolean }): Promise<PutResult>;
  /** Bounded streaming read; rejects with STORAGE_NOT_FOUND when absent. */
  getStream(key: string, opts?: GetOptions): Promise<ObjectStream>;
  /** Metadata lookup; null when absent. */
  head(key: string): Promise<ObjectHead | null>;
  exists(key: string): Promise<boolean>;
  /** Idempotent: deleting an absent object succeeds. With `ifGeneration`, only that generation is removed. */
  delete(key: string, opts?: DeleteOptions): Promise<void>;
  /** Bounded reachability probe (write/read/verify/delete under the health namespace for fs). Rejects when unhealthy. */
  probe(): Promise<void>;
}

/** Read a bounded object fully into memory (small objects only: logos, scan images). */
export async function readAll(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new StorageError("STORAGE_TOO_LARGE");
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
