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
import { StorageError, readAll, type GetOptions, type ObjectHead, type ObjectStream, type PutOptions, type PutResult, type StorageDriver } from "./contract.js";
import { HashingLimiter, toReadable, verifyExpected } from "./hashing.js";
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
    if (!opts.allowOverwrite) {
      try {
        const [exists] = await f.exists();
        if (exists) throw new StorageError("STORAGE_CONFLICT");
      } catch (err) {
        throw mapGcsError(err);
      }
    }
    const limiter = new HashingLimiter(opts.maxBytes);
    try {
      await pipeline(toReadable(source), limiter, f.createWriteStream({ contentType: opts.contentType, resumable: false, metadata: { cacheControl: "private, max-age=0" } }));
    } catch (err) {
      await f.delete({ ignoreNotFound: true }).catch(() => undefined);
      throw mapGcsError(err);
    }
    const result = { sizeBytes: limiter.size, sha256: limiter.sha256 };
    try {
      verifyExpected(result, opts);
    } catch (err) {
      await f.delete({ ignoreNotFound: true }).catch(() => undefined);
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
      return { sizeBytes: Number.isFinite(size as number) ? (size as number) : null, contentType: (meta.contentType as string | undefined) ?? null };
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

  async delete(key: string): Promise<void> {
    try {
      await this.file(key).delete({ ignoreNotFound: true });
    } catch (err) {
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
