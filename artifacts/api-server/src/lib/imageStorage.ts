import type { Readable } from "node:stream";
import sharp from "sharp";
import * as storage from "../services/storage.service.js";
import { StorageError } from "../storage/contract.js";

// Batch 25 — scan images go through the object-storage boundary like every
// other product file: the stored value on scans.image_url is the opaque
// `/objects/<id>` handle of an inventory row bound to (tenant, scan). Legacy
// rows still carry the pre-B25 `scans/<companyId>/<scanId>.jpg` bucket key;
// those are served through the legacy fallback only while it is enabled, and
// only when the embedded tenant id matches the caller's tenant.

/**
 * Decode a data-URL or raw base64 string and compress to JPEG ~80 quality.
 * Returns { buffer, contentType }.
 */
async function decodeAndCompress(imageData: string): Promise<{ buffer: Buffer; contentType: string }> {
  const base64 = imageData.startsWith("data:") ? imageData.split(",")[1] : imageData;
  if (!base64) throw new Error("Invalid image data");
  const raw = Buffer.from(base64, "base64");
  // .rotate() with no args applies the EXIF orientation and strips the tag, so the
  // stored image displays upright everywhere (browsers ignore EXIF in some contexts).
  const buffer = await sharp(raw).rotate().jpeg({ quality: 80, progressive: true }).toBuffer();
  return { buffer, contentType: "image/jpeg" };
}

/**
 * Store a base64-encoded scan image (compressed to JPEG) for a scan of the
 * given tenant. Returns the opaque storage handle to persist on the scan row.
 */
export async function uploadScanImage(scanId: number, companyId: number, imageData: string): Promise<string> {
  const { buffer, contentType } = await decodeAndCompress(imageData);
  const stored = await storage.storeBuffer({ companyId, kind: "scan_image", contentType, buffer, entityType: "scan", entityId: scanId });
  return stored.reference;
}

/**
 * Stream a previously stored scan image of the tenant. Rejects with
 * STORAGE_NOT_FOUND when the object is absent (callers map it to 404).
 */
export async function streamScanImage(companyId: number, reference: string): Promise<{ stream: Readable; contentType: string; sizeBytes: number | null }> {
  const opened = await storage.openByReference({ companyId, kind: "scan_image", reference });
  if (!opened) throw new StorageError("STORAGE_NOT_FOUND");
  return { stream: opened.stream, contentType: opened.contentType || "image/jpeg", sizeBytes: opened.sizeBytes };
}

/**
 * Load a stored scan image as base64 (used to re-run OCR on the stored image).
 * Rejects with STORAGE_NOT_FOUND when the object is absent.
 */
export async function loadScanImageBase64(companyId: number, reference: string): Promise<string> {
  const read = await storage.readObjectBuffer({ companyId, kind: "scan_image", reference }, storage.OBJECT_LIMITS.scan_image);
  if (!read) throw new StorageError("STORAGE_NOT_FOUND");
  return read.buffer.toString("base64");
}

/** Tombstone + remove a stored scan image (idempotent; safe for legacy references). */
export async function deleteScanImage(companyId: number, reference: string): Promise<void> {
  await storage.deleteByReference({ companyId, kind: "scan_image", reference });
}
