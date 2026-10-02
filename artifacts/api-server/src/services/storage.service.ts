// =============================================================================
// Batch 25 — object manager: the ONE boundary every product file flow uses.
//
//   reserve → write → activate   (write-ahead inventory row, then bytes, then
//                                  the feature row + activation in ONE transaction)
//   resolve → open               (only `active` rows are served; tombstoned
//                                  references are never served from anywhere,
//                                  so a deleted object cannot reappear through
//                                  the legacy GCS fallback)
//   tombstone → delete           (state first, file second; a failed physical
//                                  delete stays `deleting` and is retried by the
//                                  durable job / maintenance sweep)
//
// Nothing here ever returns a filesystem path, storage key, bucket name or
// host path to a caller; API responses carry opaque handles and short-lived
// capability URLs only.
// =============================================================================
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { Request } from "express";
import { db, type StorageObjectRow } from "@workspace/db";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { AppError } from "../middlewares/errorHandler.js";
import type { Executor } from "../repositories/base.js";
import * as repo from "../repositories/storage-objects.repository.js";
import { StorageError, readAll, type StorageDriver } from "../storage/contract.js";
import { mintCapability, type CapabilityPayload } from "../storage/capability.js";
import { tenantKey, type StorageKind } from "../storage/keys.js";
import { bump, storageCounters } from "../storage/metrics.js";
import { getLegacyDriver, getMirrorDriver, getPrimaryDriver, legacyFallbackEnabled, storageConfigured, storageMode } from "../storage/registry.js";
import { getQueue } from "../lib/jobs/queue.js";

export const STORAGE_DELETE_OBJECT_JOB = "storage.deleteObject";
export const STORAGE_PURGE_COMPANY_JOB = "storage.purgeCompany";

/** Hard PLAINTEXT ceilings per object kind (bytes). */
export const OBJECT_LIMITS: Record<StorageKind, number> = {
  document: 25 * 1024 * 1024,
  export: 100 * 1024 * 1024,
  report: 50 * 1024 * 1024,
  scan_image: 10 * 1024 * 1024,
  branding_logo: 2 * 1024 * 1024,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Types a browser may render inline without a script-execution risk (no HTML/SVG/XML). */
export const INLINE_SAFE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "text/plain", "text/csv"]);
const HANDLE = /^\/objects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Opaque client-visible handle for a native object. */
export function referenceFor(kind: StorageKind, objectId: string, companyId: number, extension?: string): string {
  if (kind === "branding_logo") return `branding/${companyId}/${objectId.replace(/-/g, "")}.${extension ?? "bin"}`;
  return `/objects/${objectId}`;
}

export function isNativeHandle(reference: string): boolean {
  return HANDLE.test(reference);
}

// ── errors ───────────────────────────────────────────────────────────────────
export function storageUnavailable(): AppError {
  return new AppError(503, "File storage is temporarily unavailable. Please try again later.", { code: "STORAGE_UNAVAILABLE" });
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof StorageError) {
    switch (err.code) {
      case "STORAGE_TOO_LARGE":
        return new AppError(413, "The file exceeds the permitted size", { code: "STORAGE_TOO_LARGE" });
      case "STORAGE_NOT_FOUND":
        return new AppError(404, "File not found in storage", { code: "STORAGE_NOT_FOUND" });
      case "STORAGE_CONFLICT":
        return new AppError(409, "This upload was already completed", { code: "STORAGE_CONFLICT" });
      default:
        return storageUnavailable();
    }
  }
  return storageUnavailable();
}

// ── legacy locations (GCS driver only) ───────────────────────────────────────
/**
 * Where a PRE-B25 reference lives in the legacy bucket, or null when the
 * reference is not a legacy shape for this kind / tenant or GCS is unconfigured.
 * The tenant id embedded in scan / branding keys MUST match the caller's tenant.
 */
export function legacyLocation(kind: StorageKind, reference: string, companyId: number): string | null {
  const bucket = config.objectStorage.bucketId;
  if (!bucket) return null;
  switch (kind) {
    case "document":
    case "export":
    case "report": {
      const m = /^\/objects\/(uploads\/[0-9a-f-]{36})$/.exec(reference);
      if (!m) return null;
      const dir = config.objectStorage.privateObjectDir.replace(/\/+$/, "");
      if (!dir) return null;
      const parts = `${dir}/${m[1]}`.replace(/^\/+/, "").split("/");
      if (parts.length < 2) return null;
      return `gs://${parts[0]}/${parts.slice(1).join("/")}`;
    }
    case "scan_image": {
      const m = /^scans\/(\d+)\/(\d+)\.jpg$/.exec(reference);
      if (!m || Number(m[1]) !== companyId) return null;
      return `gs://${bucket}/${reference}`;
    }
    case "branding_logo": {
      const m = /^branding\/(\d+)\/[0-9a-f]{32}\.(png|jpg|webp)$/.exec(reference);
      if (!m || Number(m[1]) !== companyId) return null;
      return `gs://${bucket}/${reference}`;
    }
  }
}

function defaultContentType(kind: StorageKind): string {
  return kind === "scan_image" ? "image/jpeg" : "application/octet-stream";
}

// ── base URL for capability links ────────────────────────────────────────────
/**
 * Absolute origin for minted URLs: the request's own origin (honours the
 * forwarded protocol/host the trusted proxy supplies), falling back to the
 * configured application URL for system paths without a request.
 */
export function publicBaseUrl(req?: Request | null): string {
  if (req) {
    const host = req.get("host");
    if (host && /^[A-Za-z0-9.:\-\[\]]+$/.test(host)) return `${req.protocol}://${host}`;
  }
  return config.email.appBaseUrl.replace(/\/+$/, "");
}

function capabilityUrl(base: string, kind: "put" | "get", objectId: string, token: string): string {
  const path = kind === "put" ? `/api/files/uploads/${objectId}` : `/api/files/${objectId}`;
  return `${base.replace(/\/+$/, "")}${path}?t=${encodeURIComponent(token)}`;
}

// ── test hook ────────────────────────────────────────────────────────────────
let failNextPrimaryPut = false;
/** Non-production only: the next primary write fails (rollback tests). */
export function armPrimaryFailureForTests(): boolean {
  if (config.isProduction) return false;
  failNextPrimaryPut = true;
  return true;
}

async function primary(): Promise<StorageDriver> {
  try {
    return await getPrimaryDriver();
  } catch (err) {
    bump("primaryFailures");
    throw err;
  }
}

async function putWithMirror(driver: StorageDriver, row: StorageObjectRow, source: Readable | Buffer, maxBytes: number, allowOverwrite: boolean) {
  if (failNextPrimaryPut) {
    failNextPrimaryPut = false;
    throw new StorageError("STORAGE_UNAVAILABLE", "simulated storage failure");
  }
  const result = await driver.put(row.storageKey, source, { contentType: row.contentType, maxBytes, allowOverwrite });
  const mirror = await getMirrorDriver();
  let mirrorState: string | null = null;
  if (mirror) {
    try {
      const { stream } = await driver.getStream(row.storageKey, { maxBytes });
      await mirror.put(row.storageKey, stream, { contentType: row.contentType, maxBytes, allowOverwrite: true, expectedSha256: result.sha256, expectedSize: result.sizeBytes });
      mirrorState = "ok";
    } catch (err) {
      bump("mirrorFailures");
      logger.error({ err, objectId: row.id, kind: row.kind, companyId: row.companyId }, "Object storage: strict mirror write failed — primary object rolled back");
      await driver.delete(row.storageKey).catch(() => undefined);
      throw new StorageError("STORAGE_UNAVAILABLE", "mirror write failed", err);
    }
  }
  return { ...result, mirrorState };
}

// ── reserve / upload / attach (client uploads) ───────────────────────────────
export interface ReserveUploadInput {
  companyId: number;
  userId: number;
  kind: StorageKind;
  contentType: string;
  declaredSize: number;
}

export interface ReservedUpload {
  objectId: string;
  reference: string;
  uploadURL: string;
}

/** Mint an upload target bound to the authenticated tenant. The inventory row is written BEFORE any byte can land. */
export async function reserveUpload(req: Request, input: ReserveUploadInput): Promise<ReservedUpload> {
  if (!storageConfigured()) throw storageUnavailable();
  const limit = OBJECT_LIMITS[input.kind];
  if (!Number.isInteger(input.declaredSize) || input.declaredSize <= 0 || input.declaredSize > limit) {
    throw new AppError(413, `File exceeds the ${Math.round(limit / (1024 * 1024))}MB limit`);
  }
  const id = randomUUID();
  const row = await repo.insert({
    id,
    companyId: input.companyId,
    kind: input.kind,
    reference: referenceFor(input.kind, id, input.companyId),
    storageKey: tenantKey(input.kind, input.companyId, id),
    driver: storageMode() === "gcs" ? "gcs" : storageMode(),
    legacyKey: storageMode() === "gcs" ? `gs://${config.objectStorage.bucketId}/${tenantKey(input.kind, input.companyId, id)}` : null,
    contentType: input.contentType,
    sizeBytes: null,
    sha256: null,
    state: "pending",
  });
  const exp = Math.floor(Date.now() / 1000) + config.objectStorage.uploadTtlSec;
  const token = mintCapability({ op: "put", o: row.id, c: row.companyId, u: input.userId, exp });
  return { objectId: row.id, reference: row.reference, uploadURL: capabilityUrl(publicBaseUrl(req), "put", row.id, token) };
}

/** Receive the bytes for a reserved upload (capability already verified by the route). */
export async function receiveUpload(payload: CapabilityPayload, body: Readable, declaredBytes?: number): Promise<{ sizeBytes: number; sha256: string }> {
  const row = await repo.findById(payload.o);
  if (!row || row.companyId !== payload.c) throw new AppError(403, "Upload link is invalid or expired", { code: "STORAGE_UPLOAD_INVALID" });
  if (row.state === "staged" || row.state === "active") throw new AppError(409, "This upload was already completed", { code: "STORAGE_CONFLICT" });
  if (row.state !== "pending" && row.state !== "failed") throw new AppError(403, "Upload link is invalid or expired", { code: "STORAGE_UPLOAD_INVALID" });
  const kind = row.kind as StorageKind;
  // A declared Content-Length beyond the ceiling is refused BEFORE any byte is
  // read; chunked / undeclared bodies are capped by the streaming limiter.
  if (declaredBytes !== undefined && Number.isFinite(declaredBytes) && declaredBytes > OBJECT_LIMITS[kind]) {
    throw new AppError(413, "The file exceeds the permitted size", { code: "STORAGE_TOO_LARGE" });
  }
  const driver = await primary();
  let result;
  try {
    result = await putWithMirror(driver, row, body, OBJECT_LIMITS[kind], row.state === "failed");
  } catch (err) {
    const code = err instanceof StorageError ? err.code : "STORAGE_UNAVAILABLE";
    if (code !== "STORAGE_TOO_LARGE") bump("primaryFailures");
    logger.warn({ err, objectId: row.id, kind, companyId: row.companyId, code }, "Object storage: upload write failed");
    await repo.transition(row.id, ["pending", "failed"], "failed", { lastError: code }).catch(() => undefined);
    throw toAppError(err);
  }
  const staged = await repo.transition(row.id, ["pending", "failed"], "staged", { sizeBytes: result.sizeBytes, sha256: result.sha256, mirrorState: result.mirrorState, lastError: null }).catch(async (err) => {
    await driver.delete(row.storageKey).catch(() => undefined);
    throw err;
  });
  if (!staged) {
    await driver.delete(row.storageKey).catch(() => undefined);
    throw new AppError(409, "This upload was already completed", { code: "STORAGE_CONFLICT" });
  }
  return { sizeBytes: result.sizeBytes, sha256: result.sha256 };
}

export interface AttachInput {
  companyId: number;
  kind: StorageKind;
  reference: string;
  entityType: string;
  entityId: number | null;
  /** The declared content type must match what was reserved. */
  contentType?: string;
}

/**
 * Bind a staged upload to its feature row inside the caller's transaction.
 * Refuses anything that is not a staged object of THIS tenant and kind — a
 * handle belonging to another tenant, an unknown handle, an already attached
 * object or a tombstone all answer 400 (never 404, so the probe reveals nothing).
 */
export async function attachStaged(tx: Executor, input: AttachInput): Promise<StorageObjectRow> {
  if (!isNativeHandle(input.reference)) throw new AppError(400, "Invalid objectPath");
  const row = await repo.findByReference(input.companyId, input.kind, input.reference, tx);
  if (!row || row.state !== "staged") throw new AppError(400, "Invalid objectPath");
  if (input.contentType !== undefined && input.contentType !== row.contentType) throw new AppError(400, "mimeType does not match the uploaded file");
  const active = await repo.transition(row.id, ["staged"], "active", { entityType: input.entityType, entityId: input.entityId }, tx);
  if (!active) throw new AppError(400, "Invalid objectPath");
  return active;
}

export async function bindEntity(tx: Executor | undefined, objectId: string, entityType: string, entityId: number): Promise<void> {
  await repo.setEntity(objectId, entityType, entityId, tx);
}

// ── server-side writes (exports, reports, scan images, logos) ────────────────
export interface StoreBufferInput {
  companyId: number;
  kind: StorageKind;
  contentType: string;
  buffer: Buffer;
  entityType?: string;
  entityId?: number;
  /** branding: file extension carried in the legacy-compatible reference */
  extension?: string;
}

export interface StoredObject {
  objectId: string;
  reference: string;
  sizeBytes: number;
  sha256: string;
}

/** Write-ahead row → bytes → activation. A failed write leaves a `failed` tombstone and no committed reference. */
export async function storeBuffer(input: StoreBufferInput): Promise<StoredObject> {
  if (!storageConfigured()) throw new StorageError("STORAGE_UNAVAILABLE", "object storage is not configured");
  const limit = OBJECT_LIMITS[input.kind];
  if (input.buffer.length > limit) throw new StorageError("STORAGE_TOO_LARGE");
  const id = randomUUID();
  const mode = storageMode();
  const storageKey = tenantKey(input.kind, input.companyId, input.kind === "branding_logo" ? id.replace(/-/g, "") : id, input.kind === "branding_logo" ? input.extension ?? "bin" : undefined);
  const row = await repo.insert({
    id,
    companyId: input.companyId,
    kind: input.kind,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    reference: referenceFor(input.kind, id, input.companyId, input.extension),
    storageKey,
    driver: mode === "gcs" ? "gcs" : mode,
    legacyKey: mode === "gcs" ? `gs://${config.objectStorage.bucketId}/${storageKey}` : null,
    contentType: input.contentType,
    sizeBytes: null,
    sha256: null,
    state: "pending",
  });
  const driver = await primary();
  let result;
  try {
    result = await putWithMirror(driver, row, input.buffer, limit, false);
  } catch (err) {
    const code = err instanceof StorageError ? err.code : "STORAGE_UNAVAILABLE";
    if (code !== "STORAGE_TOO_LARGE") bump("primaryFailures");
    logger.warn({ err, objectId: row.id, kind: row.kind, companyId: row.companyId, code }, "Object storage: write failed");
    await repo.transition(row.id, ["pending"], "failed", { lastError: code }).catch(() => undefined);
    throw err instanceof StorageError ? err : new StorageError("STORAGE_UNAVAILABLE", undefined, err);
  }
  try {
    const active = await repo.transition(row.id, ["pending"], "active", { sizeBytes: result.sizeBytes, sha256: result.sha256, mirrorState: result.mirrorState });
    if (!active) throw new Error("storage object left the pending state unexpectedly");
  } catch (err) {
    // The row stays pending (the sweep removes it); never leave the bytes behind untracked.
    await driver.delete(row.storageKey).catch(() => undefined);
    throw err;
  }
  return { objectId: row.id, reference: row.reference, sizeBytes: result.sizeBytes, sha256: result.sha256 };
}

// ── resolution / reads ───────────────────────────────────────────────────────
export interface ObjectRef {
  companyId: number;
  kind: StorageKind;
  reference: string;
}

/**
 * The readable inventory row for a reference, or null. A tombstoned or
 * not-yet-active row is null (never served). A reference WITHOUT a row is
 * served from the legacy bucket only while the fallback is enabled, and is
 * registered in the inventory on first use so later reads, deletes and the
 * migration all see one consistent record.
 */
export async function resolveReadable(ref: ObjectRef): Promise<StorageObjectRow | null> {
  const row = await repo.findByReference(ref.companyId, ref.kind, ref.reference);
  if (row) return row.state === "active" ? row : null;
  if (!legacyFallbackEnabled()) return null;
  const loc = legacyLocation(ref.kind, ref.reference, ref.companyId);
  if (!loc) return null;
  const legacy = await getLegacyDriver();
  if (!legacy) return null;
  let head;
  try {
    head = await legacy.head(loc);
  } catch (err) {
    bump("primaryFailures");
    logger.warn({ err, kind: ref.kind, companyId: ref.companyId }, "Object storage: legacy lookup failed");
    return null;
  }
  if (!head) return null;
  const id = randomUUID();
  const registered = await repo.insertIfAbsent({
    id,
    companyId: ref.companyId,
    kind: ref.kind,
    reference: ref.reference,
    storageKey: tenantKey(ref.kind, ref.companyId, id),
    driver: "gcs",
    legacyKey: loc,
    contentType: head.contentType ?? defaultContentType(ref.kind),
    sizeBytes: head.sizeBytes,
    sha256: null,
    state: "active",
  });
  if (registered.state !== "active") return null;
  bump("legacyFallbackReads");
  logger.info({ objectId: registered.id, kind: ref.kind, companyId: ref.companyId }, "Object storage: legacy fallback read (object registered for migration)");
  return registered;
}

export interface OpenedObject {
  stream: Readable;
  sizeBytes: number | null;
  contentType: string;
  sha256: string | null;
  row: StorageObjectRow;
}

/** Driver for a row: native rows use the primary driver, legacy rows the GCS driver. */
async function driverFor(row: StorageObjectRow): Promise<{ driver: StorageDriver; key: string }> {
  if (row.driver === "gcs") {
    const legacy = await getLegacyDriver();
    if (!legacy) throw new StorageError("STORAGE_UNAVAILABLE", "legacy storage is not configured");
    return { driver: legacy, key: row.legacyKey ?? row.storageKey };
  }
  const p = await primary();
  if (p.kind !== row.driver) throw new StorageError("STORAGE_UNAVAILABLE", "object was written by a different driver");
  return { driver: p, key: row.storageKey };
}

export async function openObject(row: StorageObjectRow, opts: { maxBytes?: number } = {}): Promise<OpenedObject> {
  const maxBytes = opts.maxBytes ?? OBJECT_LIMITS[row.kind as StorageKind];
  const { driver, key } = await driverFor(row);
  try {
    const s = await driver.getStream(key, { maxBytes });
    return { stream: s.stream, sizeBytes: row.sizeBytes ?? s.sizeBytes, contentType: row.contentType || s.contentType || "application/octet-stream", sha256: row.sha256, row };
  } catch (err) {
    const notFound = err instanceof StorageError && err.code === "STORAGE_NOT_FOUND";
    if (!notFound) bump("primaryFailures");
    // Transitional mode "fs-first reads with GCS fallback": a migrated object
    // whose primary copy is missing may still be served from its legacy
    // location while the fallback is enabled. Only ACTIVE rows reach this
    // function, so a tombstoned object is never resurrected this way.
    if (row.driver !== "gcs" && row.legacyKey && legacyFallbackEnabled()) {
      const legacy = await getLegacyDriver().catch(() => null);
      if (legacy) {
        try {
          const s = await legacy.getStream(row.legacyKey, { maxBytes });
          bump("legacyFallbackReads");
          logger.warn({ objectId: row.id, kind: row.kind, companyId: row.companyId, primaryMissing: notFound }, "Object storage: served from the legacy location (primary read failed)");
          return { stream: s.stream, sizeBytes: row.sizeBytes ?? s.sizeBytes, contentType: row.contentType || s.contentType || "application/octet-stream", sha256: row.sha256, row };
        } catch (legacyErr) {
          logger.warn({ err: legacyErr, objectId: row.id, kind: row.kind, companyId: row.companyId }, "Object storage: legacy fallback read failed");
        }
      }
    }
    logger.warn({ err, objectId: row.id, kind: row.kind, companyId: row.companyId, driver: row.driver }, "Object storage: read failed");
    throw err instanceof StorageError ? err : new StorageError("STORAGE_UNAVAILABLE", undefined, err);
  }
}

export async function openByReference(ref: ObjectRef, opts: { maxBytes?: number } = {}): Promise<OpenedObject | null> {
  const row = await resolveReadable(ref);
  if (!row) return null;
  return openObject(row, opts);
}

/** Small objects only (logos, scan images): bounded full read. Null when the object is absent. */
export async function readObjectBuffer(ref: ObjectRef, maxBytes: number): Promise<{ buffer: Buffer; contentType: string; row: StorageObjectRow } | null> {
  const opened = await openByReference(ref, { maxBytes });
  if (!opened) return null;
  const buffer = await readAll(opened.stream, maxBytes);
  return { buffer, contentType: opened.contentType, row: opened.row };
}

export interface DownloadLinkInput extends ObjectRef {
  userId: number | null;
  fileName?: string | null;
  disposition?: "inline" | "attachment";
  ttlSec?: number;
}

/** Short-lived download capability for an active object; null when the object does not exist. */
export async function mintDownloadUrl(base: string, input: DownloadLinkInput): Promise<string | null> {
  const row = await resolveReadable(input);
  if (!row) return null;
  const exp = Math.floor(Date.now() / 1000) + (input.ttlSec ?? config.objectStorage.downloadTtlSec);
  const fn = input.fileName ? sanitizeFileName(input.fileName) : undefined;
  const token = mintCapability({ op: "get", o: row.id, c: row.companyId, u: input.userId, exp, ...(fn ? { fn } : {}), ...(input.disposition ? { d: input.disposition } : {}) });
  return capabilityUrl(base, "get", row.id, token);
}

/** The row a verified `get` capability refers to, or null when it is no longer active / owned by that tenant. */
export async function loadForDownload(payload: CapabilityPayload): Promise<StorageObjectRow | null> {
  const row = await repo.findById(payload.o);
  if (!row || row.companyId !== payload.c || row.state !== "active") return null;
  return row;
}

// ── file names / headers ─────────────────────────────────────────────────────
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .replace(/"/g, "'")
    .trim()
    .slice(0, 255);
  return cleaned || "download";
}

export function contentDisposition(disposition: "inline" | "attachment", fileName: string): string {
  const safe = sanitizeFileName(fileName);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

// ── deletion / tombstones ────────────────────────────────────────────────────
/** Remove the bytes of a row from wherever they live. True when nothing remains (or nothing had to be removed). */
export async function physicallyDelete(row: StorageObjectRow): Promise<boolean> {
  try {
    if (row.driver === "gcs") {
      if (!config.objectStorage.legacyDelete) return true; // legacy objects are never deleted in this phase; the tombstone protects
      const legacy = await getLegacyDriver();
      if (!legacy) return true;
      await legacy.delete(row.legacyKey ?? row.storageKey);
      return true;
    }
    const p = await primary();
    if (p.kind === row.driver) await p.delete(row.storageKey);
    const mirror = await getMirrorDriver();
    if (mirror && row.mirrorState === "ok") await mirror.delete(row.storageKey);
    return true;
  } catch (err) {
    bump("deleteFailures");
    logger.warn({ err, objectId: row.id, kind: row.kind, companyId: row.companyId, driver: row.driver }, "Object storage: physical delete failed (will retry)");
    return false;
  }
}

async function enqueueDeleteRetry(objectId: string): Promise<void> {
  try {
    await getQueue().enqueue(STORAGE_DELETE_OBJECT_JOB, { objectId }, { dedupeKey: `storage.delete:${objectId}`, maxAttempts: 8 });
  } catch (err) {
    logger.error({ err, objectId }, "Object storage: could not enqueue delete retry (maintenance sweep will retry)");
  }
}

/**
 * Tombstone first, bytes second. Unknown / legacy references get a `deleted`
 * tombstone row so the legacy fallback can never resurrect them.
 */
export async function deleteByReference(ref: ObjectRef, tx?: Executor): Promise<void> {
  const row = await repo.findByReference(ref.companyId, ref.kind, ref.reference, tx);
  if (!row) {
    const loc = legacyLocation(ref.kind, ref.reference, ref.companyId);
    const id = randomUUID();
    await repo.insertIfAbsent(
      {
        id,
        companyId: ref.companyId,
        kind: ref.kind,
        reference: ref.reference,
        storageKey: tenantKey(ref.kind, ref.companyId, id),
        driver: loc ? "gcs" : storageMode() === "none" ? "fs" : storageMode(),
        legacyKey: loc,
        contentType: defaultContentType(ref.kind),
        state: "deleted",
        deletedAt: new Date(),
      },
      tx,
    );
    return;
  }
  if (row.state === "deleted") return;
  const marked = await repo.transition(row.id, ["pending", "staged", "active", "deleting", "failed"], "deleting", { deletedAt: row.deletedAt ?? new Date() }, tx);
  if (!marked) return;
  await finishDelete(marked);
}

/** Second half of a delete: remove the bytes and settle the row; retried durably on failure. */
export async function finishDelete(row: StorageObjectRow): Promise<boolean> {
  const ok = await physicallyDelete(row);
  if (ok) {
    await repo.transition(row.id, ["deleting"], "deleted", { lastError: null });
    return true;
  }
  await repo.update(row.id, { lastError: "DELETE_RETRY" }).catch(() => undefined);
  await enqueueDeleteRetry(row.id);
  return false;
}

/** Durable retry handler (idempotent: a settled row is a no-op). */
export async function runDeleteObjectJob(payload: { objectId: string }): Promise<void> {
  if (!payload || typeof payload.objectId !== "string" || !UUID.test(payload.objectId)) return;
  const row = await repo.findById(payload.objectId);
  if (!row || row.state !== "deleting") return;
  const ok = await physicallyDelete(row);
  if (!ok) throw new Error("storage object delete failed (retrying)");
  await repo.transition(row.id, ["deleting"], "deleted", { lastError: null });
}

/** Company deletion: tombstone every object of the tenant inside the deletion transaction. */
export async function tombstoneCompany(tx: Executor, companyId: number): Promise<number> {
  return repo.markCompanyDeleting(companyId, tx);
}

export async function enqueueCompanyPurge(companyId: number): Promise<void> {
  try {
    await getQueue().enqueue(STORAGE_PURGE_COMPANY_JOB, { companyId }, { dedupeKey: `storage.purge:${companyId}:${Date.now()}`, maxAttempts: 8 });
  } catch (err) {
    logger.error({ err, companyId }, "Object storage: could not enqueue company purge (maintenance sweep will finish it)");
  }
}

/** Durable purge handler: removes the files of a tombstoned company in bounded batches (re-enqueues itself while rows remain). */
export async function runPurgeCompanyJob(payload: { companyId: number }): Promise<void> {
  if (!payload || !Number.isInteger(payload.companyId)) return;
  const batch = config.objectStorage.sweepBatchSize;
  const rows = await repo.listByCompany(payload.companyId, ["deleting", "pending", "staged", "active"], batch);
  let failed = 0;
  for (const row of rows) {
    const marked = row.state === "deleting" ? row : await repo.transition(row.id, ["pending", "staged", "active"], "deleting", { deletedAt: new Date() });
    if (!marked) continue;
    const ok = await physicallyDelete(marked);
    if (ok) await repo.transition(marked.id, ["deleting"], "deleted", { lastError: null });
    else failed += 1;
  }
  const remaining = await repo.listByCompany(payload.companyId, ["deleting", "pending", "staged", "active"], 1);
  if (failed > 0) throw new Error(`storage purge: ${failed} object(s) could not be removed yet (retrying)`);
  if (remaining.length > 0) await enqueueCompanyPurge(payload.companyId);
}

// ── maintenance sweep ────────────────────────────────────────────────────────
export interface SweepSummary {
  stalePending: number;
  staleStaged: number;
  retriedDeletes: number;
  companyOrphans: number;
  entityOrphans: number;
  purgedTombstones: number;
}

/** Idempotent, bounded repair pass (runs inside the recurring maintenance sweep). */
export async function sweepStorage(now: Date = new Date()): Promise<SweepSummary> {
  const batch = config.objectStorage.sweepBatchSize;
  const summary: SweepSummary = { stalePending: 0, staleStaged: 0, retriedDeletes: 0, companyOrphans: 0, entityOrphans: 0, purgedTombstones: 0 };
  if (!storageConfigured()) return summary;

  const settle = async (row: StorageObjectRow): Promise<boolean> => {
    const marked = row.state === "deleting" ? row : await repo.transition(row.id, ["pending", "staged", "active", "failed"], "deleting", { deletedAt: new Date() });
    if (!marked) return false;
    const ok = await physicallyDelete(marked);
    if (ok) await repo.transition(marked.id, ["deleting"], "deleted", { lastError: null });
    return ok;
  };

  for (const row of await repo.listStale("pending", new Date(now.getTime() - config.objectStorage.pendingTtlMs), batch)) {
    if (await settle(row)) summary.stalePending += 1;
  }
  for (const row of await repo.listStale("staged", new Date(now.getTime() - config.objectStorage.stagedTtlMs), batch)) {
    if (await settle(row)) summary.staleStaged += 1;
  }
  for (const row of await repo.listStale("failed", new Date(now.getTime() - config.objectStorage.pendingTtlMs), batch)) {
    await settle(row);
  }
  for (const row of await repo.listDeleting(batch)) {
    if (await settle(row)) summary.retriedDeletes += 1;
  }
  for (const row of await repo.listCompanyOrphans(batch)) {
    if (await settle(row)) summary.companyOrphans += 1;
  }
  for (const row of await repo.listEntityOrphans(batch)) {
    if (await settle(row)) summary.entityOrphans += 1;
  }
  for (const row of await repo.listPurgeableTombstones(new Date(now.getTime() - 24 * 60 * 60 * 1000), batch)) {
    await repo.remove(row.id);
    summary.purgedTombstones += 1;
  }
  return summary;
}

// ── observability ────────────────────────────────────────────────────────────
export interface StorageMetricsSnapshot {
  driver: string;
  legacyFallback: boolean;
  mirror: boolean;
  primaryFailures: number;
  legacyFallbackReads: number;
  mirrorFailures: number;
  migrationVerifyFailures: number;
  deleteFailures: number;
  /** Inventory backlog; null when the inventory could not be read (never a fabricated 0). */
  pendingUploads: number | null;
  pendingDeletes: number | null;
}

export async function storageMetrics(): Promise<StorageMetricsSnapshot> {
  const c = storageCounters();
  let pendingUploads: number | null = null;
  let pendingDeletes: number | null = null;
  try {
    const counts = await repo.countByStates();
    pendingUploads = (counts.pending ?? 0) + (counts.staged ?? 0);
    pendingDeletes = counts.deleting ?? 0;
  } catch (err) {
    logger.warn({ err }, "Object storage: inventory counts unavailable for metrics");
  }
  return {
    driver: storageMode(),
    legacyFallback: legacyFallbackEnabled(),
    mirror: config.objectStorage.mirror && storageMode() !== "gcs" && storageMode() !== "none" && !!config.objectStorage.bucketId,
    ...c,
    pendingUploads,
    pendingDeletes,
  };
}

export { db as storageDb };
