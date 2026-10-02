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

export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, message?: string, readonly cause?: unknown) {
    super(message ?? STORAGE_ERROR_MESSAGES[code]);
    this.name = "StorageError";
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
}

export interface PutResult {
  /** PLAINTEXT byte count. */
  sizeBytes: number;
  /** PLAINTEXT SHA-256, lowercase hex. */
  sha256: string;
}

export interface ObjectHead {
  /** PLAINTEXT size when the driver knows it (gcs/memory); null when only ciphertext size is known (fs). */
  sizeBytes: number | null;
  contentType: string | null;
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
  /** Idempotent: deleting an absent object succeeds. */
  delete(key: string): Promise<void>;
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
