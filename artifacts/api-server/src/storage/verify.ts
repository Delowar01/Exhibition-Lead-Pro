// =============================================================================
// B25 Correction 2 — streaming integrity verification for copies the API does
// not decrypt itself (GCS legacy / mirror / native objects). The inventory row
// knows the plaintext size and SHA-256 of every natively written, migrated or
// strictly mirrored object; a copy read from the bucket is checked against
// them WHILE it streams, in bounded memory:
//   • the transform hashes and counts the bytes as they pass;
//   • exactly ONE chunk is held back at any time, so the final chunk of a copy
//     whose digest or size disagrees is never released — a mismatch can never
//     complete a byte-exact response, only a truncated one that ends in a
//     sanitized STORAGE_INTEGRITY error;
//   • a copy that grows beyond the expected size is refused immediately.
// Rows without a stored digest (pre-B25 legacy objects not yet copied and
// verified) are streamed on provider-level integrity only — documented in
// docs/B25_OBJECT_STORAGE.md.
// =============================================================================
import { createHash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { StorageError } from "./contract.js";

export interface ExpectedIntegrity {
  sizeBytes: number | null;
  sha256: string | null;
}

export function needsVerification(expected: ExpectedIntegrity): boolean {
  return expected.sizeBytes !== null || (typeof expected.sha256 === "string" && expected.sha256.length > 0);
}

export class VerifyingStream extends Transform {
  /** Largest chunk held back at any one time (bounded-buffering proof for tests). */
  maxHeld = 0;
  private held: Buffer | null = null;
  private size = 0;
  private readonly hash = createHash("sha256");
  private readonly expectedSize: number | null;
  private readonly expectedSha: string | null;

  constructor(expected: ExpectedIntegrity) {
    super();
    this.expectedSize = expected.sizeBytes;
    this.expectedSha = expected.sha256 ? expected.sha256.toLowerCase() : null;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.size += b.length;
    if (this.expectedSize !== null && this.size > this.expectedSize) return cb(new StorageError("STORAGE_INTEGRITY", "copy size disagrees with the inventory", undefined, "SIZE_MISMATCH"));
    this.hash.update(b);
    const previous = this.held;
    this.held = b;
    if (b.length > this.maxHeld) this.maxHeld = b.length;
    if (previous) this.push(previous);
    cb();
  }

  override _flush(cb: TransformCallback): void {
    if (this.expectedSize !== null && this.size !== this.expectedSize) return cb(new StorageError("STORAGE_INTEGRITY", "copy size disagrees with the inventory", undefined, "SIZE_MISMATCH"));
    if (this.expectedSha !== null && this.hash.digest("hex") !== this.expectedSha) return cb(new StorageError("STORAGE_INTEGRITY", "copy digest disagrees with the inventory", undefined, "DIGEST_MISMATCH"));
    if (this.held) this.push(this.held);
    this.held = null;
    cb();
  }
}
