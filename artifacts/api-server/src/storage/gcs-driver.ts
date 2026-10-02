// =============================================================================
// Batch 25 — TEMPORARY legacy / migration driver over the existing Google Cloud
// Storage bucket. It exists so that (1) the hosted stack can run the new code
// with reads unchanged, (2) legacy objects can be served through the central
// boundary while they are being migrated, and (3) the migration script can
// copy and verify them. It is scheduled for removal in a later correction
// once every referenced object has been migrated and verified.
//
// Keys accepted:
//   gs://<bucket>/<object>   a legacy location (documents/exports under
//                            PRIVATE_OBJECT_DIR/uploads/<id>, scans/<cid>/<id>.jpg,
//                            branding/<cid>/<hex>.<ext>)
//   tenants/… / health/…     a canonical key inside the configured bucket
// Nothing here mints signed URLs any more: every read is streamed through the
// API after the normal authorization checks.
// =============================================================================
import { randomBytes, randomUUID } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Storage, File } from "@google-cloud/storage";
import { StorageError, readAll, type DeleteOptions, type GetOptions, type ObjectHead, type ObjectStream, type PutOptions, type PutResult, type StorageDriver } from "./contract.js";
import { HashingLimiter, assertBeforeDeadline, mapAbort, putSignal, toReadable, verifyExpected } from "./hashing.js";
import { assertValidStorageKey, healthKey } from "./keys.js";

export interface GcsLocation {
  bucket: string;
  object: string;
}

export function parseGsUri(uri: string): GcsLocation | null {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) return null;
  if (m[2].includes("..") || m[2].startsWith("/") || m[2].includes("\0")) return null;
  return { bucket: m[1], object: m[2] };
}

function gcsStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

/** Custom-metadata key carrying the inventory row id (durable ownership marker, B25 Correction 3). */
export const OWNER_METADATA_KEY = "lcp-object-id";

function generationOf(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const g = (metadata as { generation?: unknown }).generation;
  if (typeof g === "number" && Number.isFinite(g)) return String(g);
  if (typeof g === "string" && /^\d+$/.test(g)) return g;
  return null;
}

export function mapGcsError(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  const status = gcsStatus(err);
  if (status === 404) return new StorageError("STORAGE_NOT_FOUND", undefined, err);
  return new StorageError("STORAGE_UNAVAILABLE", undefined, err);
}

export class GcsStorageDriver implements StorageDriver {
  readonly kind = "gcs" as const;

  constructor(
    private readonly client: Storage,
    private readonly defaultBucket: string,
    private readonly probeTimeoutMs = 2000,
  ) {
    if (!defaultBucket) throw new Error("GCS driver requires a bucket");
  }

  private file(key: string): File {
    const gs = parseGsUri(key);
    if (gs) return this.client.bucket(gs.bucket).file(gs.object);
    assertValidStorageKey(key);
    return this.client.bucket(this.defaultBucket).file(key);
  }

  async put(key: string, source: Readable | Buffer, opts: PutOptions & { allowOverwrite?: boolean }): Promise<PutResult> {
    const f = this.file(key);
    const limiter = new HashingLimiter(opts.maxBytes);
    // B25 Correction 1: a no-overwrite write is published with the atomic
    // generation precondition `ifGenerationMatch: 0` (the object must not exist
    // at commit time) instead of an exists() check followed by an unconditional
    // write. A precondition failure (412) means NOTHING of ours was stored.
    //
    // B25 Correction 2 — generation-safe cleanup: a failed write NEVER deletes
    // by key. We cannot prove which generation (if any) a failed stream left
    // behind — a 412, a transport error, a source-stream abort or a response
    // lost after the server committed all look alike from here — and the key
    // may hold a pre-existing or concurrently committed object. The inventory
    // row that owns the key settles it (its key is attempt-unique), never the
    // driver. Only a write we KNOW succeeded (generation in hand) may remove
    // its own generation again (integrity failure below).
    const preconditionOpts = opts.allowOverwrite ? undefined : { ifGenerationMatch: 0 };
    // B25 Correction 3 — every publication is bounded: never start past the
    // deadline, never run longer than the put time bound (an aborted upload is
    // an AMBIGUOUS outcome handled by the ownership rules, never by a bare
    // delete), and carry the durable ownership marker as object metadata.
    assertBeforeDeadline(opts.publishDeadline);
    const signal = putSignal(opts.timeoutMs);
    const customMetadata = opts.owner ? { [OWNER_METADATA_KEY]: opts.owner } : undefined;
    try {
      await pipeline(
        toReadable(source),
        limiter,
        f.createWriteStream({ contentType: opts.contentType, resumable: false, metadata: { cacheControl: "private, max-age=0", ...(customMetadata ? { metadata: customMetadata } : {}) }, ...(preconditionOpts ? { preconditionOpts } : {}) }),
        signal ? { signal } : {},
      );
    } catch (err) {
      if (gcsStatus(err) === 412) throw new StorageError("STORAGE_CONFLICT", undefined, err);
      throw mapAbort(err) ?? mapGcsError(err);
    }
    const generation = generationOf(f.metadata);
    const result: PutResult = { sizeBytes: limiter.size, sha256: limiter.sha256, ...(generation ? { generation } : {}) };
    try {
      verifyExpected(result, opts);
    } catch (err) {
      // Our own generation only; with no generation reported the object is left
      // for the owning inventory row's cleanup (discoverable, never a blind delete).
      if (generation) await this.delete(key, { ifGeneration: generation }).catch(() => undefined);
      throw err;
    }
    return result;
  }

  async getStream(key: string, opts: GetOptions = {}): Promise<ObjectStream> {
    const f = this.file(key);
    const head = await this.head(key);
    if (!head) throw new StorageError("STORAGE_NOT_FOUND");
    if (opts.maxBytes !== undefined && head.sizeBytes !== null && head.sizeBytes > opts.maxBytes) throw new StorageError("STORAGE_TOO_LARGE");
    const rs = f.createReadStream();
    const out = new PassThrough();
    let emitted = 0;
    rs.on("error", (err) => {
      if (!out.destroyed) out.destroy(mapGcsError(err));
    });
    rs.on("data", (chunk: Buffer) => {
      emitted += chunk.length;
      if (opts.maxBytes !== undefined && emitted > opts.maxBytes) {
        rs.destroy();
        if (!out.destroyed) out.destroy(new StorageError("STORAGE_TOO_LARGE"));
      }
    });
    out.on("close", () => rs.destroy());
    rs.pipe(out);
    return { stream: out, sizeBytes: head.sizeBytes, contentType: head.contentType };
  }

  async head(key: string): Promise<ObjectHead | null> {
    const f = this.file(key);
    try {
      const [meta] = await f.getMetadata();
      const size = meta.size === undefined ? null : Number(meta.size);
      const custom = (meta as { metadata?: Record<string, unknown> }).metadata;
      const owner = custom && typeof custom[OWNER_METADATA_KEY] === "string" ? (custom[OWNER_METADATA_KEY] as string) : null;
      return { sizeBytes: Number.isFinite(size as number) ? (size as number) : null, contentType: (meta.contentType as string | undefined) ?? null, generation: generationOf(meta), owner };
    } catch (err) {
      if (gcsStatus(err) === 404) return null;
      throw mapGcsError(err);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const [exists] = await this.file(key).exists();
      return exists;
    } catch (err) {
      throw mapGcsError(err);
    }
  }

  async delete(key: string, opts: DeleteOptions = {}): Promise<void> {
    try {
      await this.file(key).delete({ ignoreNotFound: true, ...(opts.ifGeneration !== undefined ? { ifGenerationMatch: Number(opts.ifGeneration) } : {}) });
    } catch (err) {
      // Precondition failed: the object at this key is a DIFFERENT generation —
      // not ours to remove. Report it; never fall back to an unconditional delete.
      if (opts.ifGeneration !== undefined && gcsStatus(err) === 412) throw new StorageError("STORAGE_CONFLICT", "object generation changed", err, "GENERATION_MISMATCH");
      if (gcsStatus(err) === 404) return;
      throw mapGcsError(err);
    }
  }

  /**
   * Least-privilege reachability probe (unchanged from the pre-B25 readiness
   * check): a single-object LIST, which a bucket-scoped Storage Object Admin
   * grant permits; bucket metadata is deliberately never requested.
   */
  async probe(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StorageError("STORAGE_UNAVAILABLE", "storage probe timed out")), this.probeTimeoutMs);
      });
      const probe = this.client.bucket(this.defaultBucket).getFiles({ maxResults: 1, prefix: ".private/", autoPaginate: false });
      await Promise.race([probe, timeout]);
    } catch (err) {
      throw mapGcsError(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Write/read/delete probe under the health namespace (used only by explicit verification tooling, never by readiness). */
  async roundTripProbe(): Promise<void> {
    const key = healthKey(`probe-${randomUUID()}`);
    const payload = randomBytes(512);
    try {
      await this.put(key, payload, { contentType: "application/octet-stream", maxBytes: 512 });
      const { stream } = await this.getStream(key, { maxBytes: 512 });
      const back = await readAll(stream, 512);
      if (!back.equals(payload)) throw new StorageError("STORAGE_INTEGRITY");
    } finally {
      await this.delete(key).catch(() => undefined);
    }
  }
}
