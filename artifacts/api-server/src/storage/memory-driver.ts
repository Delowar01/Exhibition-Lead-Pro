// Batch 25 — deterministic in-process driver for unit tests and, with
// `kind: "gcs"` + `looseKeys`, the FAKE legacy-bucket adapter used by the
// rollback / migration / concurrency / generation tests. Never used in
// production (config refuses it). Publication is an atomic check-and-set AFTER
// the bytes were read (and after the optional test barrier), which models the
// real drivers' no-replace publication (filesystem hard link / GCS generation
// precondition).
//
// B25 Correction 2 — the fake models object GENERATIONS the way the GCS driver
// relies on them: every successful put creates a new generation, `put` reports
// it, and `delete(key, { ifGeneration })` removes only that generation (a
// mismatch rejects with STORAGE_CONFLICT / GENERATION_MISMATCH and leaves the
// object untouched). Every delete is recorded for the fault-injection suites,
// and the failure hooks can carry an arbitrary (secret-laden) error object so
// the log-sanitization suite can prove nothing of it leaks.
//
// B25 Correction 3 — the fake also keeps the OWNERSHIP MARKER a write carries
// (`owner` → object metadata, reported by `head`), honours the publication
// deadline and the put time bound, and can simulate a write that the provider
// committed although the client saw a failure (`commitThenFailNextPut`).
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PassThrough } from "node:stream";
import { StorageError, type DeleteOptions, type GetOptions, type ObjectHead, type ObjectStream, type PutOptions, type PutResult, type StorageDriver, type StorageDriverKind } from "./contract.js";
import { HashingLimiter, assertBeforeDeadline, mapAbort, putSignal, toReadable, verifyExpected } from "./hashing.js";
import { assertValidStorageKey } from "./keys.js";

interface StoredObject {
  bytes: Buffer;
  contentType: string;
  sha256: string;
  /** Monotonic per-driver object generation (string, like the GCS metadata value). */
  generation: string;
  /** Ownership marker stored with the object (inventory row id), when the write carried one. */
  owner: string | null;
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
  /** Every delete request seen by this driver (key + generation precondition), for the cleanup proofs. */
  readonly deleteCalls: Array<{ key: string; ifGeneration?: string }> = [];
  /** Test hooks: the next put / get / head / delete fails with STORAGE_UNAVAILABLE … */
  failNextPut = false;
  failNextGet = false;
  failNextDelete = false;
  /** … or with exactly this (possibly secret-laden, provider-shaped) error object. */
  failNextPutWith: unknown = undefined;
  failNextGetWith: unknown = undefined;
  failNextHeadWith: unknown = undefined;
  failNextDeleteWith: unknown = undefined;
  /** The next put is COMMITTED by the store but reported as failed to the caller (lost response). */
  commitThenFailNextPut = false;
  private generationCounter = 0;

  constructor(private readonly opts: MemoryDriverOptions = {}) {
    this.kind = opts.kind ?? "memory";
  }

  private check(key: string): void {
    if (!this.opts.looseKeys) assertValidStorageKey(key);
    else if (typeof key !== "string" || key.length === 0) throw new StorageError("STORAGE_INVALID_KEY");
  }

  private takeInjected(flag: "failNextPut" | "failNextGet" | "failNextDelete" | null, withField: "failNextPutWith" | "failNextGetWith" | "failNextHeadWith" | "failNextDeleteWith"): void {
    const injected = this[withField];
    if (injected !== undefined) {
      this[withField] = undefined;
      throw injected;
    }
    if (flag && this[flag]) {
      this[flag] = false;
      throw new StorageError("STORAGE_UNAVAILABLE", "simulated storage failure");
    }
  }

  async put(key: string, source: Readable | Buffer, opts: PutOptions & { allowOverwrite?: boolean }): Promise<PutResult> {
    this.check(key);
    this.takeInjected("failNextPut", "failNextPutWith");
    assertBeforeDeadline(opts.publishDeadline);
    const limiter = new HashingLimiter(opts.maxBytes);
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (c: Buffer) => chunks.push(c));
    const signal = putSignal(opts.timeoutMs);
    try {
      await pipeline(toReadable(source), limiter, sink, signal ? { signal } : {});
    } catch (err) {
      throw mapAbort(err) ?? err;
    }
    const result = { sizeBytes: limiter.size, sha256: limiter.sha256 };
    verifyExpected(result, opts);
    if (this.opts.beforePublish) await this.opts.beforePublish(key);
    assertBeforeDeadline(opts.publishDeadline);
    // Atomic publication: the existence check and the set happen in one
    // synchronous step (no await in between) — like ifGenerationMatch: 0.
    if (!opts.allowOverwrite && this.objects.has(key)) throw new StorageError("STORAGE_CONFLICT");
    const generation = String(++this.generationCounter);
    this.objects.set(key, { bytes: Buffer.concat(chunks), contentType: opts.contentType, sha256: result.sha256, generation, owner: opts.owner ?? null });
    if (this.commitThenFailNextPut) {
      this.commitThenFailNextPut = false;
      throw new StorageError("STORAGE_UNAVAILABLE", "simulated lost response after commit");
    }
    return { ...result, generation };
  }

  async getStream(key: string, opts: GetOptions = {}): Promise<ObjectStream> {
    this.check(key);
    this.takeInjected("failNextGet", "failNextGetWith");
    const o = this.objects.get(key);
    if (!o) throw new StorageError("STORAGE_NOT_FOUND");
    if (opts.maxBytes !== undefined && o.bytes.length > opts.maxBytes) throw new StorageError("STORAGE_TOO_LARGE");
    return { stream: Readable.from([Buffer.from(o.bytes)]), sizeBytes: o.bytes.length, contentType: o.contentType };
  }

  async head(key: string): Promise<ObjectHead | null> {
    this.check(key);
    this.takeInjected(null, "failNextHeadWith");
    const o = this.objects.get(key);
    return o ? { sizeBytes: o.bytes.length, contentType: o.contentType, generation: o.generation, owner: o.owner } : null;
  }

  async exists(key: string): Promise<boolean> {
    this.check(key);
    return this.objects.has(key);
  }

  async delete(key: string, opts: DeleteOptions = {}): Promise<void> {
    this.check(key);
    // B25 Correction 6 — the fake legacy adapter enforces the real driver's invariant: no generationless delete.
    if (this.kind === "gcs" && opts.ifGeneration === undefined) throw new StorageError("STORAGE_UNAVAILABLE", "a GCS delete requires the exact generation to remove", undefined, "GENERATION_REQUIRED");
    this.deleteCalls.push({ key, ...(opts.ifGeneration !== undefined ? { ifGeneration: opts.ifGeneration } : {}) });
    this.takeInjected("failNextDelete", "failNextDeleteWith");
    const o = this.objects.get(key);
    if (!o) return;
    if (opts.ifGeneration !== undefined && o.generation !== opts.ifGeneration) throw new StorageError("STORAGE_CONFLICT", "object generation changed", undefined, "GENERATION_MISMATCH");
    this.objects.delete(key);
  }

  async probe(): Promise<void> {
    /* always healthy */
  }
}
