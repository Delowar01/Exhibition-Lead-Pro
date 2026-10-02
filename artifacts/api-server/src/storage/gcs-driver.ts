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
//
// B25 Correction 6 — generation invariant: a successful put ALWAYS returns the
// generation it created (recovered through a HEAD that also proves the
// ownership marker when the write stream does not expose it), and the public
// delete REFUSES to run without an exact generation precondition. No code path
// can issue a bare provider delete.
//
// B25 Correction 7 — a generation is an OPAQUE DECIMAL STRING. The provider
// reports a 64-bit integer as a decimal string; JavaScript numbers are exact
// only up to 2^53 − 1, so the value is never parsed, coerced, rounded or
// converted to a number anywhere: it travels verbatim from the provider's
// metadata (FileMetadata.generation → ObjectHead / PutResult) to the delete
// precondition (`ifGenerationMatch: opts.ifGeneration`). The create-only
// precondition `ifGenerationMatch: 0` is the sole numeric value in this file.
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

/** A GCS object generation exactly as the JSON API reports it: a canonical decimal string (a positive 64-bit integer; most real values exceed Number.MAX_SAFE_INTEGER). */
const CANONICAL_GENERATION = /^[1-9]\d*$/;

/**
 * The generation carried by provider metadata, as the exact string — or null
 * when nothing exact is available (the caller then recovers it through HEAD or
 * fails closed). B25 Correction 7: the SDK types the field as string | number;
 * a number is accepted only while it is still exact (a safe integer, rendered
 * as its decimal text) — a larger number has already lost precision and is
 * never stringified into a wrong generation.
 */
function generationOf(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const g = (metadata as { generation?: unknown }).generation;
  if (typeof g === "string") return CANONICAL_GENERATION.test(g) ? g : null;
  if (typeof g === "number" && Number.isSafeInteger(g) && g > 0) return String(g);
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
    // B25 Correction 6 — the generation is mandatory. The write stream normally
    // exposes it; when it does not (the SDK contract makes it optional) it is
    // recovered through a bounded HEAD that must also show this write's
    // ownership marker. Nothing provable → fail closed: the put is NOT reported
    // as a completed copy, nothing is deleted, and the owning inventory row
    // (publication-uncertain since before the request) keeps the location
    // discoverable for the sweep's marker + generation cleanup.
    const generation = generationOf(f.metadata) ?? (await this.proveWrittenGeneration(key, opts.owner));
    const result: PutResult = { sizeBytes: limiter.size, sha256: limiter.sha256, generation };
    try {
      verifyExpected(result, opts);
    } catch (err) {
      // Our own generation only — never a bare delete.
      await this.delete(key, { ifGeneration: generation }).catch(() => undefined);
      throw err;
    }
    return result;
  }

  /** HEAD after a write whose stream reported no generation: the object must exist, carry the expected marker and report a generation. */
  private async proveWrittenGeneration(key: string, expectedOwner: string | undefined): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    let head: ObjectHead | null;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StorageError("STORAGE_UNAVAILABLE", "written object could not be observed in time", undefined, "GENERATION_UNPROVEN")), Math.max(this.probeTimeoutMs, 5000));
      });
      head = await Promise.race([this.head(key), timeout]);
    } catch (err) {
      throw err instanceof StorageError && err.reason ? err : new StorageError("STORAGE_UNAVAILABLE", "written object could not be observed", err, "GENERATION_UNPROVEN");
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!head) throw new StorageError("STORAGE_UNAVAILABLE", "written object is not observable", undefined, "GENERATION_UNPROVEN");
    if (expectedOwner !== undefined && head.owner !== expectedOwner) throw new StorageError("STORAGE_UNAVAILABLE", "written object does not carry this write's ownership marker", undefined, "OWNERSHIP_UNPROVEN");
    if (!head.generation) throw new StorageError("STORAGE_UNAVAILABLE", "provider reported no generation for the written object", undefined, "GENERATION_UNPROVEN");
    return head.generation;
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

  /**
   * Delete ONLY the exact generation named by the caller (B25 Correction 6):
   * without one the provider is never contacted. Every caller proves the
   * generation first (its own put result, or a HEAD that showed the ownership
   * marker); there is no bare-key delete anywhere.
   *
   * B25 Correction 7: the generation is passed to the SDK VERBATIM as the
   * caller's string. A value that is not a canonical decimal string (or not a
   * string at all) fails closed before the provider is contacted — it is never
   * parsed into a number, which would silently round every generation above
   * Number.MAX_SAFE_INTEGER onto a neighbouring one.
   */
  async delete(key: string, opts: DeleteOptions = {}): Promise<void> {
    if (opts.ifGeneration === undefined) throw new StorageError("STORAGE_UNAVAILABLE", "a GCS delete requires the exact generation to remove", undefined, "GENERATION_REQUIRED");
    if (typeof opts.ifGeneration !== "string" || !CANONICAL_GENERATION.test(opts.ifGeneration)) throw new StorageError("STORAGE_UNAVAILABLE", "a GCS delete requires a canonical decimal generation string", undefined, "GENERATION_INVALID");
    try {
      await this.file(key).delete({ ignoreNotFound: true, ifGenerationMatch: opts.ifGeneration });
    } catch (err) {
      // Precondition failed: the object at this key is a DIFFERENT generation —
      // not ours to remove. Report it; never fall back to an unconditional delete.
      if (gcsStatus(err) === 412) throw new StorageError("STORAGE_CONFLICT", "object generation changed", err, "GENERATION_MISMATCH");
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

  /**
   * Write/read/delete probe under the health namespace (used only by explicit
   * verification tooling, never by readiness). B25 Correction 6: the health
   * object is removed only at the generation its own put returned; a put that
   * cannot prove its generation fails before the read and leaves the object
   * for explicit health-namespace cleanup — never a bare delete.
   */
  async roundTripProbe(): Promise<void> {
    const key = healthKey(`probe-${randomUUID()}`);
    const payload = randomBytes(512);
    const written = await this.put(key, payload, { contentType: "application/octet-stream", maxBytes: 512 });
    try {
      const { stream } = await this.getStream(key, { maxBytes: 512 });
      const back = await readAll(stream, 512);
      if (!back.equals(payload)) throw new StorageError("STORAGE_INTEGRITY");
    } finally {
      if (written.generation) await this.delete(key, { ifGeneration: written.generation }).catch(() => undefined);
    }
  }
}
