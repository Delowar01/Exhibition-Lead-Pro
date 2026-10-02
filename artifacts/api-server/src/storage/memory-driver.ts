// Batch 25 — deterministic in-process driver for unit tests and, with
// `kind: "gcs"` + `looseKeys`, the FAKE legacy-bucket adapter used by the
// rollback / migration / concurrency tests. Never used in production (config
// refuses it). Publication is an atomic check-and-set AFTER the bytes were
// read (and after the optional test barrier), which models the real drivers'
// no-replace publication (filesystem hard link / GCS generation precondition).
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PassThrough } from "node:stream";
import { StorageError, type GetOptions, type ObjectHead, type ObjectStream, type PutOptions, type PutResult, type StorageDriver, type StorageDriverKind } from "./contract.js";
import { HashingLimiter, toReadable, verifyExpected } from "./hashing.js";
import { assertValidStorageKey } from "./keys.js";

interface StoredObject {
  bytes: Buffer;
  contentType: string;
  sha256: string;
}

export interface MemoryDriverOptions {
  /** When true (fake legacy bucket), keys are not validated against the canonical grammar. */
  looseKeys?: boolean;
  /** Reported driver kind: "memory" (default) or "gcs" for the fake legacy adapter. */
  kind?: Extract<StorageDriverKind, "memory" | "gcs">;
  /** Test barrier awaited right before publication (concurrency tests). */
  beforePublish?: (key: string) => Promise<void>;
}

export class MemoryStorageDriver implements StorageDriver {
  readonly kind: StorageDriverKind;
  readonly objects = new Map<string, StoredObject>();
  /** Test hooks: the next put / get / delete fails with STORAGE_UNAVAILABLE. */
  failNextPut = false;
  failNextGet = false;
  failNextDelete = false;

  constructor(private readonly opts: MemoryDriverOptions = {}) {
    this.kind = opts.kind ?? "memory";
  }

  private check(key: string): void {
    if (!this.opts.looseKeys) assertValidStorageKey(key);
    else if (typeof key !== "string" || key.length === 0) throw new StorageError("STORAGE_INVALID_KEY");
  }

  async put(key: string, source: Readable | Buffer, opts: PutOptions & { allowOverwrite?: boolean }): Promise<PutResult> {
    this.check(key);
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new StorageError("STORAGE_UNAVAILABLE", "simulated storage failure");
    }
    const limiter = new HashingLimiter(opts.maxBytes);
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (c: Buffer) => chunks.push(c));
    await pipeline(toReadable(source), limiter, sink);
    const result = { sizeBytes: limiter.size, sha256: limiter.sha256 };
    verifyExpected(result, opts);
    if (this.opts.beforePublish) await this.opts.beforePublish(key);
    // Atomic publication: the existence check and the set happen in one
    // synchronous step (no await in between) — like ifGenerationMatch: 0.
    if (!opts.allowOverwrite && this.objects.has(key)) throw new StorageError("STORAGE_CONFLICT");
    this.objects.set(key, { bytes: Buffer.concat(chunks), contentType: opts.contentType, sha256: result.sha256 });
    return result;
  }

  async getStream(key: string, opts: GetOptions = {}): Promise<ObjectStream> {
    this.check(key);
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new StorageError("STORAGE_UNAVAILABLE", "simulated storage failure");
    }
    const o = this.objects.get(key);
    if (!o) throw new StorageError("STORAGE_NOT_FOUND");
    if (opts.maxBytes !== undefined && o.bytes.length > opts.maxBytes) throw new StorageError("STORAGE_TOO_LARGE");
    return { stream: Readable.from([Buffer.from(o.bytes)]), sizeBytes: o.bytes.length, contentType: o.contentType };
  }

  async head(key: string): Promise<ObjectHead | null> {
    this.check(key);
    const o = this.objects.get(key);
    return o ? { sizeBytes: o.bytes.length, contentType: o.contentType } : null;
  }

  async exists(key: string): Promise<boolean> {
    this.check(key);
    return this.objects.has(key);
  }

  async delete(key: string): Promise<void> {
    this.check(key);
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new StorageError("STORAGE_UNAVAILABLE", "simulated storage failure");
    }
    this.objects.delete(key);
  }

  async probe(): Promise<void> {
    /* always healthy */
  }
}
