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
