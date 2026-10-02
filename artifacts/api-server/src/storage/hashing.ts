// Shared streaming helpers for the storage drivers: a byte-limiting, hashing
// pass-through so every driver computes the PLAINTEXT size and SHA-256 the same
// way and enforces the same hard size ceiling without buffering the object.
import { createHash } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { StorageError } from "./contract.js";

export class HashingLimiter extends Transform {
  size = 0;
  private readonly hash = createHash("sha256");
  private digestHex: string | null = null;

  constructor(private readonly maxBytes: number) {
    super();
  }

  get sha256(): string {
    if (this.digestHex === null) this.digestHex = this.hash.digest("hex");
    return this.digestHex;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.size += b.length;
    if (this.size > this.maxBytes) return cb(new StorageError("STORAGE_TOO_LARGE"));
    this.hash.update(b);
    cb(null, b);
  }
}

export function toReadable(source: Readable | Buffer): Readable {
  return Buffer.isBuffer(source) ? Readable.from([source]) : source;
}

export function verifyExpected(result: { sizeBytes: number; sha256: string }, expected: { expectedSha256?: string; expectedSize?: number }): void {
  if (expected.expectedSize !== undefined && expected.expectedSize !== result.sizeBytes) throw new StorageError("STORAGE_INTEGRITY", "size mismatch");
  if (expected.expectedSha256 !== undefined && expected.expectedSha256.toLowerCase() !== result.sha256) throw new StorageError("STORAGE_INTEGRITY", "digest mismatch");
}

/** B25 Correction 3 — a signal that aborts a put after `timeoutMs` (undefined = no bound). */
export function putSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  return timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
}

/** Map an aborted pipeline to the sanitized PUT_TIMEOUT error; null when the error is not an abort. */
export function mapAbort(err: unknown): StorageError | null {
  if (typeof err === "object" && err !== null && ((err as { name?: unknown }).name === "AbortError" || (err as { code?: unknown }).code === "ABORT_ERR")) {
    return new StorageError("STORAGE_UNAVAILABLE", "write exceeded its time bound", undefined, "PUT_TIMEOUT");
  }
  return null;
}

/** B25 Correction 3 — refuse to publish past the deadline (checked immediately before publication). */
export function assertBeforeDeadline(deadline: Date | undefined): void {
  if (deadline && Date.now() > deadline.getTime()) throw new StorageError("STORAGE_UNAVAILABLE", "publication deadline passed", undefined, "PUBLISH_DEADLINE");
}
