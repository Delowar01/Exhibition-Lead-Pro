// =============================================================================
// Batch 18 — managed logo object store. Objects are tenant-scoped by key prefix
// (`branding/<companyId>/<random>.<ext>`); the database keeps ONLY that key.
// Drivers:
//   gcs     the configured bucket (DEFAULT_OBJECT_STORAGE_BUCKET_ID) — production
//   memory  in-process map, non-production only when no bucket is configured, so
//           local development and the integration suites never touch live GCS
//   none    production without a bucket: every operation answers 503
// Nothing here ever returns a bucket path, a signed URL or credentials.
// =============================================================================
import { randomBytes } from "node:crypto";
import { objectStorageClient } from "../objectStorage.js";
import { config } from "../../config.js";
import { logger } from "../logger.js";
import { AppError } from "../../middlewares/errorHandler.js";

export interface StoredLogo {
  buffer: Buffer;
  contentType: string;
}

export interface LogoObjectStore {
  readonly kind: "gcs" | "memory" | "none";
  put(key: string, buffer: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredLogo | null>;
  delete(key: string): Promise<void>;
}

export function storageUnavailable(): AppError {
  return new AppError(503, "Logo storage is not available right now. Colors and theme were not changed.", { code: "BRANDING_STORAGE_UNAVAILABLE" });
}

export function newLogoKey(companyId: number, extension: "png" | "jpg" | "webp"): string {
  return `branding/${companyId}/${randomBytes(16).toString("hex")}.${extension}`;
}

/** A key belongs to exactly one tenant; refuse anything that does not carry its prefix. */
export function keyBelongsTo(companyId: number, key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith(`branding/${companyId}/`);
}

class GcsLogoStore implements LogoObjectStore {
  readonly kind = "gcs" as const;
  constructor(private readonly bucketId: string) {}
  private file(key: string) {
    return objectStorageClient.bucket(this.bucketId).file(key);
  }
  async put(key: string, buffer: Buffer, contentType: string) {
    await this.file(key).save(buffer, { contentType, resumable: false, metadata: { cacheControl: "private, max-age=0" } });
  }
  async get(key: string) {
    const f = this.file(key);
    const [exists] = await f.exists();
    if (!exists) return null;
    const [buffer] = await f.download();
    const [meta] = await f.getMetadata();
    return { buffer, contentType: (meta.contentType as string) || "application/octet-stream" };
  }
  async delete(key: string) {
    await this.file(key).delete({ ignoreNotFound: true });
  }
}

class MemoryLogoStore implements LogoObjectStore {
  readonly kind = "memory" as const;
  private readonly objects = new Map<string, StoredLogo>();
  /** Non-production test hook: the next `put` fails when set (see routes/branding.ts). */
  failNextPut = false;
  async put(key: string, buffer: Buffer, contentType: string) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("simulated storage failure");
    }
    this.objects.set(key, { buffer: Buffer.from(buffer), contentType });
  }
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? { buffer: o.buffer, contentType: o.contentType } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

class UnavailableLogoStore implements LogoObjectStore {
  readonly kind = "none" as const;
  async put(): Promise<void> {
    throw storageUnavailable();
  }
  async get(): Promise<StoredLogo | null> {
    return null;
  }
  async delete(): Promise<void> {
    throw storageUnavailable();
  }
}

let store: LogoObjectStore | null = null;

export function logoStore(): LogoObjectStore {
  if (store) return store;
  const bucketId = config.objectStorage.bucketId;
  if (bucketId) {
    store = new GcsLogoStore(bucketId);
  } else if (config.branding.storageStub) {
    store = new MemoryLogoStore();
    logger.warn("Branding logo storage: in-process memory stub (no object-storage bucket configured; non-production only)");
  } else {
    store = new UnavailableLogoStore();
    logger.warn("Branding logo storage: NOT configured — logo upload/remove will answer 503");
  }
  return store;
}

/** Non-production only: make the memory store fail its next write (storage-failure rollback tests). */
export function armStorageFailureForTests(): boolean {
  const s = logoStore();
  if (config.isProduction || s.kind !== "memory") return false;
  (s as MemoryLogoStore).failNextPut = true;
  return true;
}
