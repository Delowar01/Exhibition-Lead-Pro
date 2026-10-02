// =============================================================================
// Batch 18 / Batch 25 — managed logo storage. Logo VALIDATION (lib/branding/
// logo.ts) is unchanged; the BYTES now pass through the provider-neutral
// object-storage boundary (services/storage.service.ts) like every other
// product file. The database keeps ONLY the tenant-scoped reference
// (`branding/<companyId>/<32 hex>.<ext>`), which is also the id used by the
// public randomized logo route. Nothing here ever returns a bucket path, a
// filesystem path, a signed URL or credentials.
// =============================================================================
import { logger } from "../logger.js";
import { AppError } from "../../middlewares/errorHandler.js";
import { StorageError } from "../../storage/contract.js";
import { sanitizeStorageError } from "../../storage/log-safety.js";
import { storageConfigured } from "../../storage/registry.js";
import * as storage from "../../services/storage.service.js";

export interface StoredLogo {
  buffer: Buffer;
  contentType: string;
}

export function storageUnavailable(): AppError {
  return new AppError(503, "Logo storage is not available right now. Colors and theme were not changed.", { code: "BRANDING_STORAGE_UNAVAILABLE" });
}

/** A key belongs to exactly one tenant; refuse anything that does not carry its prefix. */
export function keyBelongsTo(companyId: number, key: string | null | undefined): boolean {
  return typeof key === "string" && /^branding\/\d+\/[0-9a-f]{32}\.(png|jpg|webp)$/.test(key) && key.startsWith(`branding/${companyId}/`);
}

export function logoStorageAvailable(): boolean {
  return storageConfigured();
}

/** Store a validated logo for the tenant; returns the new reference key. Any storage failure answers 503. */
export async function putLogo(companyId: number, buffer: Buffer, contentType: string, extension: "png" | "jpg" | "webp"): Promise<string> {
  if (!storageConfigured()) throw storageUnavailable();
  try {
    const stored = await storage.storeBuffer({ companyId, kind: "branding_logo", contentType, buffer, entityType: "company", entityId: companyId, extension });
    return stored.reference;
  } catch (err) {
    logger.error({ error: sanitizeStorageError(err), companyId }, "Branding logo upload: storage write failed (branding unchanged)");
    throw storageUnavailable();
  }
}

/** Read a tenant's logo bytes; null when the key is not the tenant's or the object is gone. */
export async function getLogo(companyId: number, key: string): Promise<StoredLogo | null> {
  if (!keyBelongsTo(companyId, key)) return null;
  try {
    const read = await storage.readObjectBuffer({ companyId, kind: "branding_logo", reference: key }, storage.OBJECT_LIMITS.branding_logo);
    return read ? { buffer: read.buffer, contentType: read.contentType } : null;
  } catch (err) {
    if (err instanceof StorageError && err.code === "STORAGE_NOT_FOUND") return null;
    logger.warn({ error: sanitizeStorageError(err), companyId }, "Branding logo read failed");
    throw storageUnavailable();
  }
}

/** Tombstone + delete a tenant's logo object (idempotent; the tombstone makes the old id unservable immediately). */
export async function deleteLogo(companyId: number, key: string): Promise<void> {
  if (!keyBelongsTo(companyId, key)) return;
  await storage.deleteByReference({ companyId, kind: "branding_logo", reference: key });
}

/** Non-production only: make the next storage write fail (storage-failure rollback tests). */
export function armStorageFailureForTests(): boolean {
  return storage.armPrimaryFailureForTests();
}
