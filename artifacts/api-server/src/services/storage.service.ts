// =============================================================================
// Batch 25 — object manager: the ONE boundary every product file flow uses.
//
//   reserve → claim → write → stage/activate   (write-ahead inventory row, then an
//                                  exclusive upload LEASE, then bytes, then the
//                                  feature row + activation in ONE transaction)
//   resolve → locate → open      (only `active` rows are served; every readable
//                                  COPY of an object is located from the row —
//                                  primary, strict-mirror or legacy — so a
//                                  configuration rollback keeps migrated and
//                                  mirrored objects readable, and a tombstoned
//                                  reference is never served from anywhere)
//   tombstone → delete           (state first, bytes second — all copies; a
//                                  failed physical delete stays `deleting` and is
//                                  retried by the durable job / maintenance sweep)
//
// B25 Correction 1:
//   • pre-B25 references stay readable while the legacy bucket IS the primary
//     driver (hosted environment unchanged) — `legacyReadMode()` = primary;
//     fs/memory primaries read legacy copies only when the fallback is enabled
//   • one idempotent write-attempt rollback removes BOTH primary and mirror copies
//   • upload publication is race-free (database lease + atomic no-replace write)
//   • private bytes are never served on the strength of a URL: callers pass the
//     authenticated user and the route re-checks tenant, state and permission
//
// B25 Correction 2:
//   • ONE publication attempt per upload intent: an expired / failed intent is
//     never reclaimed (clients reserve a fresh object), so no two attempts ever
//     share a row, a primary key or a mirror key; every writer transition is a
//     CAS fenced by state = uploading + its lease token (staging also requires
//     an unexpired lease), and a stale attempt cleans ONLY its own copies — by
//     provider generation where the provider has one — never by a shared key
//   • company deletion / the sweep fence in-flight writers by clearing the
//     lease; bytes published after that are removed by the writer itself or
//     flagged CLEANUP_PENDING for the sweep (never left untracked)
//   • private downloads re-prove the LIVE feature association (liveAssociation)
//   • GCS legacy / mirror copies are verified against the inventory digest while
//     streaming (storage/verify.ts)
//   • company deletion fails closed on references that cannot be inventoried
//   • every logged / persisted storage error is sanitized (storage/log-safety.ts)
//
// Nothing here ever returns a filesystem path, storage key, bucket name or host
// path to a caller; API responses carry opaque handles and credential-free URLs.
// =============================================================================
import { randomBytes, randomUUID } from "node:crypto";
import { pipeline as streamPipeline, type Readable } from "node:stream";
import type { Request } from "express";
import { db, companiesTable, documentsTable, documentVersionsTable, executiveReportsTable, exportRunsTable, scansTable, type StorageObjectRow } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { AppError } from "../middlewares/errorHandler.js";
import { canAccessCompany, type AuthUser } from "../middlewares/requireAuth.js";
import type { Executor } from "../repositories/base.js";
import * as repo from "../repositories/storage-objects.repository.js";
import { StorageError, readAll, type StorageDriver } from "../storage/contract.js";
import { mintCapability, verifyCapability, type CapabilityPayload } from "../storage/capability.js";
import { tenantKey, type StorageKind } from "../storage/keys.js";
import { isNativeHandle, legacyLocation, mirrorLocation } from "../storage/legacy.js";
import { bump, storageCounters } from "../storage/metrics.js";
import { getLegacyDriver, getMirrorDriver, getPrimaryDriver, storageConfigured, storageMode } from "../storage/registry.js";
import { sanitizeStorageError } from "../storage/log-safety.js";
import { VerifyingStream, needsVerification } from "../storage/verify.js";
import { getQueue } from "../lib/jobs/queue.js";

export { isNativeHandle, legacyLocation } from "../storage/legacy.js";

export const STORAGE_DELETE_OBJECT_JOB = "storage.deleteObject";
export const STORAGE_PURGE_COMPANY_JOB = "storage.purgeCompany";
/** Dedicated, redacted request header carrying the upload capability (never a query string). */
export const CAPABILITY_HEADER = "x-storage-capability";

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

/** Opaque client-visible handle for a native object. */
export function referenceFor(kind: StorageKind, objectId: string, companyId: number, extension?: string): string {
  if (kind === "branding_logo") return `branding/${companyId}/${objectId.replace(/-/g, "")}.${extension ?? "bin"}`;
  return `/objects/${objectId}`;
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

// ── legacy compatibility state ───────────────────────────────────────────────
export type LegacyReadMode = "primary" | "fallback" | "off";

/**
 * Whether references WITHOUT an inventory row may be served from the legacy
 * bucket, and why:
 *   primary   the bucket IS the configured primary driver (the hosted
 *             environment unchanged) — pre-B25 objects are read as before and
 *             registered on first use; no new environment variable needed
 *   fallback  a non-GCS primary with OBJECT_STORAGE_LEGACY_FALLBACK=true
 *             (transition window only)
 *   off       no bucket, or a non-GCS primary without the explicit fallback —
 *             never a silent broad fallback once the filesystem is primary
 */
export function legacyReadMode(): LegacyReadMode {
  if (!config.objectStorage.bucketId) return "off";
  if (storageMode() === "gcs") return "primary";
  return config.objectStorage.legacyFallback ? "fallback" : "off";
}

function mirrorConfigured(): boolean {
  return config.objectStorage.mirror && storageMode() !== "gcs" && storageMode() !== "none" && !!config.objectStorage.bucketId;
}

function defaultContentType(kind: StorageKind): string {
  return kind === "scan_image" ? "image/jpeg" : "application/octet-stream";
}

// ── base URL for credential-free file links ──────────────────────────────────
/**
 * Absolute origin for file URLs: the request's own origin (honours the
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

function fileUrl(base: string, objectId: string): string {
  return `${base.replace(/\/+$/, "")}/api/files/${objectId}`;
}
function uploadUrl(base: string, objectId: string): string {
  return `${base.replace(/\/+$/, "")}/api/files/uploads/${objectId}`;
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

// ── write attempt + fenced rollback ─────────────────────────────────────────
interface Copy {
  driver: StorageDriver;
  key: string;
  role: "primary" | "mirror";
  /** Provider generation created by this attempt's write (GCS / fake adapter); fs keys are attempt-unique instead. */
  generation?: string;
}

/** Everything one write attempt put into a store, so a failed commit can remove exactly those copies. */
export interface WriteAttempt {
  rowId: string;
  copies: Copy[];
}

/** Sanitized log fields for a storage error (never the raw error). */
function safe(err: unknown) {
  return sanitizeStorageError(err);
}

/**
 * Remove exactly the copies `attempt` wrote — by generation where the provider
 * reports one, otherwise by the attempt-unique key. Idempotent: an absent copy
 * is fine; a copy whose generation changed is NOT ours and is left untouched.
 * Returns true when nothing of this attempt remains.
 */
export async function discardCopies(attempt: WriteAttempt): Promise<boolean> {
  let clean = true;
  for (const copy of attempt.copies) {
    try {
      await copy.driver.delete(copy.key, copy.generation ? { ifGeneration: copy.generation } : undefined);
    } catch (err) {
      if (err instanceof StorageError && err.code === "STORAGE_CONFLICT" && err.reason === "GENERATION_MISMATCH") {
        logger.info({ objectId: attempt.rowId, role: copy.role, driver: copy.driver.kind }, "Object storage: copy generation changed — not this attempt's object, left in place");
        continue;
      }
      clean = false;
      bump("deleteFailures");
      logger.warn({ error: safe(err), objectId: attempt.rowId, role: copy.role, driver: copy.driver.kind }, "Object storage: rollback could not remove a copy (will retry)");
    }
  }
  return clean;
}

export type LeasedRollbackOutcome = "released" | "lease_lost";

/**
 * Rollback of a LEASED client upload attempt. Ownership is proven FIRST with a
 * fenced CAS (state = uploading AND this lease token → failed); only then are
 * the attempt's copies removed. When the lease was lost (expired and swept,
 * tombstoned by company deletion / the sweep) the row is never touched: a
 * tombstoned row's leftover copies — which belong to this attempt alone,
 * because an intent is never reclaimed — are removed as garbage, and a failed
 * removal is flagged CLEANUP_PENDING without changing the row's state; a
 * staged / active row is never regressed and its copies are never deleted.
 */
export async function rollbackLeasedAttempt(attempt: WriteAttempt, leaseToken: string, reason: string): Promise<LeasedRollbackOutcome> {
  const released = await repo.releaseUpload(attempt.rowId, leaseToken, "failed", { lastError: reason }).catch((err) => {
    logger.error({ error: safe(err), objectId: attempt.rowId }, "Object storage: rollback could not release the lease (sweep will settle the row)");
    return undefined;
  });
  if (released) {
    const clean = await discardCopies(attempt);
    if (!clean) await repo.flagCleanupPending(attempt.rowId).catch(() => undefined);
    return "released";
  }
  const row = await repo.findById(attempt.rowId).catch(() => undefined);
  if (row && (row.state === "failed" || row.state === "deleting" || row.state === "deleted")) {
    // Fenced out by the sweep or company deletion: our late copies are garbage.
    const clean = await discardCopies(attempt);
    if (!clean) await repo.flagCleanupPending(attempt.rowId).catch(() => undefined);
    logger.warn({ objectId: attempt.rowId, state: row.state, reason }, "Object storage: upload lease lost — late copies of the stale attempt removed");
  } else {
    logger.warn({ objectId: attempt.rowId, state: row?.state ?? "unknown", reason }, "Object storage: upload lease lost — row left untouched");
  }
  return "lease_lost";
}

/**
 * Rollback of an UNLEASED server-side write (storeBuffer): the row is private
 * to this call and its key random, so the copies are discarded and the row
 * moved pending → failed with a fenced CAS. If the row was tombstoned in the
 * meantime (company deletion), the state is never regressed; a copy that could
 * not be removed is flagged CLEANUP_PENDING for the sweep.
 */
export async function rollbackServerAttempt(attempt: WriteAttempt, reason: string): Promise<void> {
  const clean = await discardCopies(attempt);
  const failed = await repo.transition(attempt.rowId, ["pending"], "failed", { lastError: clean ? reason : repo.CLEANUP_PENDING }).catch((err) => {
    logger.error({ error: safe(err), objectId: attempt.rowId }, "Object storage: rollback could not mark the row (sweep will settle it)");
    return undefined;
  });
  if (!failed && !clean) await repo.flagCleanupPending(attempt.rowId).catch(() => undefined);
}

/**
 * Primary write, then (when strict mirroring is on) the mirror write from the
 * primary copy. Both publications are no-replace (attempt-unique keys; a mirror
 * location becomes authoritative only through the fenced database commit that
 * records mirror_state = "ok"). On failure the error carries the copies written
 * so far; the CALLER rolls back with the helper that matches its ownership
 * model (leased client upload vs. server-side write).
 */
async function writeWithMirror(driver: StorageDriver, row: StorageObjectRow, source: Readable | Buffer, maxBytes: number): Promise<{ result: { sizeBytes: number; sha256: string }; attempt: WriteAttempt; mirrorState: string | null }> {
  const attempt: WriteAttempt = { rowId: row.id, copies: [] };
  if (failNextPrimaryPut) {
    failNextPrimaryPut = false;
    throw Object.assign(new StorageError("STORAGE_UNAVAILABLE", "simulated storage failure"), { attempt });
  }
  let result;
  try {
    result = await driver.put(row.storageKey, source, { contentType: row.contentType, maxBytes, allowOverwrite: false });
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new StorageError("STORAGE_UNAVAILABLE", undefined, err), { attempt });
  }
  attempt.copies.push({ driver, key: row.storageKey, role: "primary", generation: result.generation });
  const mirror = await getMirrorDriver();
  let mirrorState: string | null = null;
  if (mirror) {
    const mirrorKey = row.mirrorKey ?? mirrorLocation(row.storageKey);
    if (!mirrorKey) throw Object.assign(new StorageError("STORAGE_UNAVAILABLE", "mirror location unavailable", undefined, "MIRROR_UNCONFIGURED"), { attempt });
    try {
      const { stream } = await driver.getStream(row.storageKey, { maxBytes });
      const copied = await mirror.put(mirrorKey, stream, { contentType: row.contentType, maxBytes, allowOverwrite: false, expectedSha256: result.sha256, expectedSize: result.sizeBytes });
      attempt.copies.push({ driver: mirror, key: mirrorKey, role: "mirror", generation: copied.generation });
      mirrorState = "ok";
    } catch (err) {
      bump("mirrorFailures");
      logger.error({ error: safe(err), objectId: row.id, kind: row.kind, companyId: row.companyId }, "Object storage: strict mirror write failed — the attempt is rolled back");
      throw Object.assign(new StorageError("STORAGE_UNAVAILABLE", "mirror write failed", err, "MIRROR_FAILED"), { attempt });
    }
  }
  return { result: { sizeBytes: result.sizeBytes, sha256: result.sha256 }, attempt, mirrorState };
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
  /** Credential-free absolute URL of the byte route. */
  uploadURL: string;
  /** Capability bound to (user, tenant, object, PUT); sent in the X-Storage-Capability header, never in the URL. */
  uploadToken: string;
}

/** Mint an upload target bound to the authenticated tenant + user. The inventory row is written BEFORE any byte can land. */
export async function reserveUpload(req: Request | null, input: ReserveUploadInput): Promise<ReservedUpload> {
  if (!storageConfigured()) throw storageUnavailable();
  const limit = OBJECT_LIMITS[input.kind];
  if (!Number.isInteger(input.declaredSize) || input.declaredSize <= 0 || input.declaredSize > limit) {
    throw new AppError(413, `File exceeds the ${Math.round(limit / (1024 * 1024))}MB limit`);
  }
  const id = randomUUID();
  const mode = storageMode();
  const storageKey = tenantKey(input.kind, input.companyId, id);
  const row = await repo.insert({
    id,
    companyId: input.companyId,
    kind: input.kind,
    reference: referenceFor(input.kind, id, input.companyId),
    storageKey,
    driver: mode === "gcs" ? "gcs" : mode,
    legacyKey: mode === "gcs" ? mirrorLocation(storageKey) : null,
    mirrorKey: mirrorConfigured() ? mirrorLocation(storageKey) : null,
    contentType: input.contentType,
    sizeBytes: null,
    sha256: null,
    state: "pending",
  });
  const exp = Math.floor(Date.now() / 1000) + config.objectStorage.uploadTtlSec;
  const uploadToken = mintCapability({ op: "put", o: row.id, c: row.companyId, u: input.userId, exp });
  return { objectId: row.id, reference: row.reference, uploadURL: uploadUrl(publicBaseUrl(req), row.id), uploadToken };
}

// ── authorization helpers (byte routes) ──────────────────────────────────────
export type ByteOp = "put" | "get";

/** The feature permission a tenant user needs for the bytes of an object kind (null = tenant membership is enough). */
export function permissionForKind(kind: StorageKind, op: ByteOp): { module: string; actions: string[] } | null {
  if (op === "put") return kind === "document" ? { module: "documents", actions: ["create", "edit"] } : null;
  switch (kind) {
    case "export":
      return { module: "reports", actions: ["view"] };
    case "report":
      return { module: "ai_executive", actions: ["view"] };
    default:
      return null; // documents: open tenant-scoped reads; scan images / logos: tenant-only
  }
}

export function userHasPermission(user: AuthUser, required: { module: string; actions: string[] } | null): boolean {
  if (!required) return true;
  if (user.role === "platform_owner" || user.role === "primary_admin") return true;
  const granted = user.permissions?.[required.module] ?? [];
  return required.actions.some((a) => granted.includes(a));
}

/**
 * The inventory row a CURRENTLY authenticated tenant user may act on: it must
 * exist, be owned by a company the user can access and (for reads) be active.
 * Foreign or unknown objects answer null → 404 (no existence disclosure).
 */
export async function authorizeObject(companyIdOrUser: number | AuthUser, objectId: string, op: ByteOp = "get"): Promise<StorageObjectRow | null> {
  if (!UUID.test(objectId)) return null;
  const row = await repo.findById(objectId);
  if (!row) return null;
  const allowed = typeof companyIdOrUser === "number" ? row.companyId === companyIdOrUser : canAccessCompany(companyIdOrUser, row.companyId);
  if (!allowed) return null;
  if (op === "get" && row.state !== "active") return null;
  return row;
}

/** Receive the bytes for a reserved upload on behalf of the authenticated user (route-level auth already passed). */
export async function receiveUpload(user: AuthUser, objectId: string, capability: string | undefined, body: Readable, declaredBytes?: number): Promise<{ sizeBytes: number; sha256: string }> {
  const invalid = () => new AppError(403, "Upload authorization is invalid or expired", { code: "STORAGE_UPLOAD_INVALID" });
  const expired = () => new AppError(409, "This upload target expired or failed; request a new upload target", { code: "STORAGE_UPLOAD_EXPIRED" });
  const completed = () => new AppError(409, "This upload was already completed", { code: "STORAGE_CONFLICT" });
  const inProgress = () => new AppError(409, "This upload is already in progress", { code: "STORAGE_UPLOAD_IN_PROGRESS" });
  const refuse = (row: StorageObjectRow | undefined, now: Date): AppError => {
    if (!row) return invalid();
    if (row.state === "staged" || row.state === "active") return completed();
    if (row.state === "uploading") return row.leaseExpiresAt && row.leaseExpiresAt <= now ? expired() : inProgress();
    if (row.state === "failed") return expired();
    return invalid(); // deleting / deleted
  };
  // Order: a syntactically valid, unexpired capability is required first; the
  // object is then resolved under the CURRENT user's tenant scope (unknown or
  // foreign → 404, no disclosure); only then is the capability's binding to
  // this object / tenant / user enforced.
  const payload = verifyCapability(capability, "put");
  if (!payload) throw invalid();
  const row = await authorizeObject(user, objectId, "put");
  if (!row) throw new AppError(404, "File not found");
  if (payload.o !== objectId || payload.c !== row.companyId || payload.u !== user.id) throw invalid();
  const kind = row.kind as StorageKind;
  if (!userHasPermission(user, permissionForKind(kind, "put"))) throw new AppError(403, "Missing permission for this upload");
  const now = new Date();
  if (row.state !== "pending") throw refuse(row, now);
  // A declared Content-Length beyond the ceiling is refused BEFORE any byte is
  // read; chunked / undeclared bodies are capped by the streaming limiter.
  if (declaredBytes !== undefined && Number.isFinite(declaredBytes) && declaredBytes > OBJECT_LIMITS[kind]) {
    throw new AppError(413, "The file exceeds the permitted size", { code: "STORAGE_TOO_LARGE" });
  }

  // Exclusive publication lease (database CAS from `pending` only): exactly one
  // attempt per intent — an expired or failed intent is never reclaimed.
  const leaseToken = randomBytes(16).toString("hex");
  const claimed = await repo.claimUpload(row.id, leaseToken, config.objectStorage.uploadLeaseMs, now);
  if (!claimed) throw refuse(await repo.findById(row.id), now);

  const driver = await primary();
  let written;
  try {
    written = await writeWithMirror(driver, claimed, body, OBJECT_LIMITS[kind]);
  } catch (err) {
    const code = err instanceof StorageError ? (err.reason === "MIRROR_FAILED" ? "MIRROR_FAILED" : err.code) : "STORAGE_UNAVAILABLE";
    if (code !== "STORAGE_TOO_LARGE") bump("primaryFailures");
    logger.warn({ error: safe(err), objectId: row.id, kind, companyId: row.companyId, code }, "Object storage: upload write failed");
    const attempt = (err as { attempt?: WriteAttempt }).attempt ?? { rowId: row.id, copies: [] };
    await rollbackLeasedAttempt(attempt, leaseToken, code);
    throw toAppError(err);
  }
  const finished = await finishUpload(row.id, leaseToken, written);
  if (!finished) {
    // The lease was lost (expired, swept or tombstoned): the attempt's own
    // copies were removed by the fenced rollback; nothing else was touched.
    throw new AppError(409, "This upload was superseded or expired; request a new upload target", { code: "STORAGE_UPLOAD_LEASE_LOST" });
  }
  return { sizeBytes: written.result.sizeBytes, sha256: written.result.sha256 };
}

/**
 * Stage the row ONLY while this writer still holds an UNEXPIRED lease (CAS on
 * state + token + expiry). A lost lease rolls the attempt back through the
 * fenced helper (own copies only). A database failure during the release is
 * resolved by re-reading ownership: when still owned, the attempt is rolled
 * back; when ownership cannot be proven, the copies are left for the lease
 * expiry sweep (the row's keys are attempt-unique, so the sweep's removal is
 * ownership-proven too).
 */
async function finishUpload(rowId: string, leaseToken: string, written: { result: { sizeBytes: number; sha256: string }; attempt: WriteAttempt; mirrorState: string | null }): Promise<boolean> {
  let staged: StorageObjectRow | undefined;
  try {
    staged = await repo.releaseUpload(rowId, leaseToken, "staged", { sizeBytes: written.result.sizeBytes, sha256: written.result.sha256, mirrorState: written.mirrorState, lastError: null });
  } catch (err) {
    logger.error({ error: safe(err), objectId: rowId }, "Object storage: could not stage the upload (database)");
    const own = await repo.ownsLease(rowId, leaseToken).catch(() => false);
    if (own) await rollbackLeasedAttempt(written.attempt, leaseToken, "DB_FAILURE");
    else logger.warn({ objectId: rowId }, "Object storage: lease ownership unknown — copies left for the lease-expiry sweep");
    throw err;
  }
  if (!staged) {
    await rollbackLeasedAttempt(written.attempt, leaseToken, "LEASE_EXPIRED");
    return false;
  }
  return true;
}

/** Test support: the stage step with a given lease token (stale writers must be refused without touching the object). */
export async function finishUploadForTests(rowId: string, leaseToken: string, result: { sizeBytes: number; sha256: string }): Promise<boolean> {
  if (config.isProduction) return false;
  return finishUpload(rowId, leaseToken, { result, attempt: { rowId, copies: [] }, mirrorState: null });
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

/** Write-ahead row → bytes (+ mirror) → activation. A failed write or commit leaves a `failed` tombstone, no copies and no committed reference. */
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
    legacyKey: mode === "gcs" ? mirrorLocation(storageKey) : null,
    mirrorKey: mirrorConfigured() ? mirrorLocation(storageKey) : null,
    contentType: input.contentType,
    sizeBytes: null,
    sha256: null,
    state: "pending",
  });
  const driver = await primary();
  let written;
  try {
    written = await writeWithMirror(driver, row, input.buffer, limit);
  } catch (err) {
    const code = err instanceof StorageError ? (err.reason === "MIRROR_FAILED" ? "MIRROR_FAILED" : err.code) : "STORAGE_UNAVAILABLE";
    if (code !== "STORAGE_TOO_LARGE") bump("primaryFailures");
    logger.warn({ error: safe(err), objectId: row.id, kind: row.kind, companyId: row.companyId, code }, "Object storage: write failed");
    await rollbackServerAttempt((err as { attempt?: WriteAttempt }).attempt ?? { rowId: row.id, copies: [] }, code);
    throw err instanceof StorageError ? err : new StorageError("STORAGE_UNAVAILABLE", undefined, err);
  }
  let active: StorageObjectRow | undefined;
  try {
    active = await repo.transition(row.id, ["pending"], "active", { sizeBytes: written.result.sizeBytes, sha256: written.result.sha256, mirrorState: written.mirrorState });
  } catch (err) {
    // Never leave untracked bytes behind: remove exactly the copies this attempt wrote.
    logger.error({ error: safe(err), objectId: row.id, kind: row.kind, companyId: row.companyId }, "Object storage: could not activate the object (database)");
    await rollbackServerAttempt(written.attempt, "DB_FAILURE");
    throw err;
  }
  if (!active) {
    // Fenced out (the row was tombstoned by company deletion meanwhile): the state is never regressed, the copies go.
    await rollbackServerAttempt(written.attempt, "SUPERSEDED");
    throw new StorageError("STORAGE_UNAVAILABLE", "object was tombstoned before activation", undefined, "ROW_TOMBSTONED");
  }
  return { objectId: row.id, reference: row.reference, sizeBytes: written.result.sizeBytes, sha256: written.result.sha256 };
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
 * served from the legacy bucket only while `legacyReadMode()` allows it (the
 * bucket is the primary, or the explicit transition fallback), and is
 * registered in the inventory on first use so later reads, deletes and the
 * migration all see one consistent record.
 */
export async function resolveReadable(ref: ObjectRef): Promise<StorageObjectRow | null> {
  const row = await repo.findByReference(ref.companyId, ref.kind, ref.reference);
  if (row) return row.state === "active" ? row : null;
  const mode = legacyReadMode();
  if (mode === "off") return null;
  const loc = legacyLocation(ref.kind, ref.reference, ref.companyId);
  if (!loc) return null;
  // A pre-B25 handle is served only to the tenant whose feature row carries it
  // (document / export / report handles are not tenant-namespaced in the bucket).
  if (!(await repo.legacyReferenceOwned(ref.companyId, ref.kind, ref.reference))) return null;
  const legacy = await getLegacyDriver();
  if (!legacy) return null;
  let head;
  try {
    head = await legacy.head(loc);
  } catch (err) {
    bump("primaryFailures");
    logger.warn({ error: safe(err), kind: ref.kind, companyId: ref.companyId }, "Object storage: legacy lookup failed");
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
  bump("legacyRegistrations");
  if (mode === "fallback") bump("legacyFallbackReads");
  logger.info({ objectId: registered.id, kind: ref.kind, companyId: ref.companyId, legacyReads: mode }, "Object storage: pre-B25 reference registered in the inventory");
  return registered;
}

export interface OpenedObject {
  stream: Readable;
  sizeBytes: number | null;
  contentType: string;
  sha256: string | null;
  row: StorageObjectRow;
}

export interface LocatedCopy {
  driver: StorageDriver;
  key: string;
  role: "primary" | "mirror" | "legacy";
}

/**
 * Every copy of a row that is readable under the CURRENT configuration, in
 * preference order, from persisted locations only (never from a client value):
 *   • the primary copy when the configured primary driver matches the row
 *   • under the GCS driver (rollback) or the explicit transition fallback:
 *     the strict-mirror copy (only when the mirror completed) and the
 *     legacy / migration-source copy
 * With a non-GCS primary and the fallback off, only the primary copy is used.
 */
export async function locateCopies(row: StorageObjectRow): Promise<LocatedCopy[]> {
  const copies: LocatedCopy[] = [];
  const mode = storageMode();
  const p = storageConfigured() ? await primary().catch(() => null) : null;
  const legacy = config.objectStorage.bucketId ? await getLegacyDriver().catch(() => null) : null;
  if (p && p.kind === row.driver) copies.push({ driver: p, key: row.storageKey, role: "primary" });
  if (row.driver === "gcs" && legacy && (mode === "gcs" || legacyReadMode() !== "off")) {
    const key = row.legacyKey ?? mirrorLocation(row.storageKey);
    if (key && !copies.some((c) => c.key === key && c.driver === legacy)) copies.push({ driver: legacy, key, role: mode === "gcs" ? "primary" : "legacy" });
  }
  if (row.driver !== "gcs" && legacy && (mode === "gcs" || legacyReadMode() === "fallback")) {
    if (row.mirrorState === "ok" && row.mirrorKey) copies.push({ driver: legacy, key: row.mirrorKey, role: "mirror" });
    if (row.legacyKey) copies.push({ driver: legacy, key: row.legacyKey, role: "legacy" });
  }
  return copies;
}

/**
 * B25 Correction 2 — a copy read from the legacy bucket (legacy, mirror or a
 * natively written GCS object) is verified against the inventory size / digest
 * while it streams; the filesystem driver authenticates its own envelope. A
 * row with no stored digest (pre-B25 legacy object not yet copied + verified)
 * streams on provider-level integrity only.
 */
function verifiedStream(row: StorageObjectRow, copy: LocatedCopy, source: Readable): Readable {
  const expected = { sizeBytes: row.sizeBytes, sha256: row.sha256 };
  if (copy.driver.kind !== "gcs" || !needsVerification(expected)) return source;
  const verifier = new VerifyingStream(expected);
  // Registered BEFORE any consumer: counted and logged synchronously with the
  // stream error, so a mismatch is observable the moment the consumer fails.
  verifier.once("error", (err) => {
    if (err instanceof StorageError && err.code === "STORAGE_INTEGRITY") {
      bump("integrityFailures");
      logger.error({ error: safe(err), objectId: row.id, kind: row.kind, companyId: row.companyId, role: copy.role, driver: copy.driver.kind }, "Object storage: copy failed integrity verification");
    }
  });
  streamPipeline(source, verifier, (err) => {
    if (err && !verifier.destroyed) verifier.destroy(err);
  });
  return verifier;
}

export async function openObject(row: StorageObjectRow, opts: { maxBytes?: number } = {}): Promise<OpenedObject> {
  const maxBytes = opts.maxBytes ?? OBJECT_LIMITS[row.kind as StorageKind];
  const copies = await locateCopies(row);
  let lastErr: unknown = null;
  for (const copy of copies) {
    try {
      const s = await copy.driver.getStream(copy.key, { maxBytes });
      if (copy.role !== "primary") {
        bump("legacyFallbackReads");
        logger.warn({ objectId: row.id, kind: row.kind, companyId: row.companyId, role: copy.role, driver: copy.driver.kind }, "Object storage: served from a non-primary copy");
      }
      return { stream: verifiedStream(row, copy, s.stream), sizeBytes: row.sizeBytes ?? s.sizeBytes, contentType: row.contentType || s.contentType || "application/octet-stream", sha256: row.sha256, row };
    } catch (err) {
      lastErr = err;
      if (!(err instanceof StorageError && err.code === "STORAGE_NOT_FOUND") && copy.role === "primary") bump("primaryFailures");
      logger.warn({ error: safe(err), objectId: row.id, kind: row.kind, companyId: row.companyId, role: copy.role, driver: copy.driver.kind }, "Object storage: copy not readable");
    }
  }
  if (lastErr instanceof StorageError && lastErr.code === "STORAGE_NOT_FOUND" && copies.length === 1) throw lastErr;
  throw new StorageError("STORAGE_UNAVAILABLE", "no readable copy of this object under the current configuration", lastErr, "NO_READABLE_COPY");
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

/**
 * Credential-free absolute URL of the byte route for an active object (null
 * when the object does not exist). The route re-checks the CURRENT session,
 * tenant access, state and feature permission on every request.
 */
export async function mintDownloadUrl(base: string, input: DownloadLinkInput): Promise<string | null> {
  const row = await resolveReadable(input);
  if (!row) return null;
  return fileUrl(base, row.id);
}

/** Compatibility for the capability-shaped payload (tests): the row when active and owned by `payload.c`. */
export async function loadForDownload(payload: Pick<CapabilityPayload, "o" | "c">): Promise<StorageObjectRow | null> {
  return authorizeObject(payload.c, payload.o, "get");
}

/** Human file name for a download, from the owning feature row (never from a client value). */
export async function displayFileName(row: StorageObjectRow): Promise<string> {
  try {
    if (row.entityType === "document_version" && row.entityId != null) {
      const [v] = await db.select({ name: documentVersionsTable.fileName }).from(documentVersionsTable).where(and(eq(documentVersionsTable.id, row.entityId), eq(documentVersionsTable.companyId, row.companyId))).limit(1);
      if (v?.name) return sanitizeFileName(v.name);
    } else if (row.entityType === "export_run" && row.entityId != null) {
      const [r] = await db.select({ name: exportRunsTable.fileName }).from(exportRunsTable).where(and(eq(exportRunsTable.id, row.entityId), eq(exportRunsTable.companyId, row.companyId))).limit(1);
      if (r?.name) return sanitizeFileName(r.name);
    } else if (row.entityType === "executive_report" && row.entityId != null) {
      const [r] = await db.select({ name: executiveReportsTable.fileName }).from(executiveReportsTable).where(and(eq(executiveReportsTable.id, row.entityId), eq(executiveReportsTable.companyId, row.companyId))).limit(1);
      if (r?.name) return sanitizeFileName(r.name);
    } else if (row.kind === "document" && !isNativeHandle(row.reference)) {
      const [v] = await db.select({ name: documentVersionsTable.fileName }).from(documentVersionsTable).where(and(eq(documentVersionsTable.objectPath, row.reference), eq(documentVersionsTable.companyId, row.companyId))).limit(1);
      if (v?.name) return sanitizeFileName(v.name);
    }
  } catch (err) {
    logger.warn({ error: safe(err), objectId: row.id }, "Object storage: file name lookup failed");
  }
  const ext = row.contentType === "image/jpeg" ? ".jpg" : row.contentType === "image/png" ? ".png" : row.contentType === "application/pdf" ? ".pdf" : row.contentType === "text/csv" ? ".csv" : "";
  return `${row.kind}-${row.id.slice(0, 8)}${ext}`;
}

// ── live feature association (B25 Correction 2) ──────────────────────────────
/**
 * Whether a CURRENT feature row of the object's tenant still carries the object
 * as its current file. A stable, credential-free file URL is served only while
 * this holds — a soft-deleted document, a replaced scan image or logo, a failed
 * export run or a report that is not ready all answer 404 at byte time:
 *   document       a document_versions row with this object_path whose parent
 *                  document exists, belongs to the same company and is not
 *                  soft-deleted
 *   export         a completed export_runs row with this object_path
 *   report         a ready executive_reports row with this object_path
 *   scan_image     a live (not deleted) scan of the tenant with this image_url
 *   branding_logo  the company's current brand_logo_key
 */
export async function liveAssociation(row: StorageObjectRow): Promise<boolean> {
  const one = { one: documentVersionsTable.id };
  switch (row.kind) {
    case "document": {
      const rows = await db
        .select({ one: documentVersionsTable.id })
        .from(documentVersionsTable)
        .innerJoin(documentsTable, eq(documentsTable.id, documentVersionsTable.documentId))
        .where(and(eq(documentVersionsTable.companyId, row.companyId), eq(documentVersionsTable.objectPath, row.reference), eq(documentsTable.companyId, row.companyId), isNull(documentsTable.deletedAt)))
        .limit(1);
      return rows.length > 0;
    }
    case "export": {
      const rows = await db.select({ one: exportRunsTable.id }).from(exportRunsTable).where(and(eq(exportRunsTable.companyId, row.companyId), eq(exportRunsTable.objectPath, row.reference), eq(exportRunsTable.status, "completed"))).limit(1);
      return rows.length > 0;
    }
    case "report": {
      const rows = await db.select({ one: executiveReportsTable.id }).from(executiveReportsTable).where(and(eq(executiveReportsTable.companyId, row.companyId), eq(executiveReportsTable.objectPath, row.reference), eq(executiveReportsTable.status, "ready"))).limit(1);
      return rows.length > 0;
    }
    case "scan_image": {
      const rows = await db.select({ one: scansTable.id }).from(scansTable).where(and(eq(scansTable.companyId, row.companyId), eq(scansTable.imageUrl, row.reference), isNull(scansTable.deletedAt))).limit(1);
      return rows.length > 0;
    }
    case "branding_logo": {
      const rows = await db.select({ one: companiesTable.id }).from(companiesTable).where(and(eq(companiesTable.id, row.companyId), eq(companiesTable.brandLogoKey, row.reference))).limit(1);
      return rows.length > 0;
    }
    default:
      void one;
      return false;
  }
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
export interface DeleteOutcome {
  /** Every copy that had to go is gone (or never existed). */
  ok: boolean;
  /** The legacy bucket object was deliberately kept (OBJECT_STORAGE_LEGACY_DELETE off). */
  retained: boolean;
}

/**
 * Remove every copy of a row from wherever it lives — primary (only when the
 * configured primary driver matches the row), the persisted mirror copy and,
 * only when legacy deletion is enabled, the legacy bucket object. A copy that
 * cannot be removed now keeps the row in `deleting` for a later retry.
 */
export async function physicallyDelete(row: StorageObjectRow): Promise<DeleteOutcome> {
  let ok = true;
  let retained = false;
  const legacy = config.objectStorage.bucketId ? await getLegacyDriver().catch(() => null) : null;
  const tryDelete = async (driver: StorageDriver | null, key: string | null, what: string) => {
    if (!key) return;
    if (!driver) {
      ok = false;
      logger.warn({ objectId: row.id, kind: row.kind, companyId: row.companyId, copy: what }, "Object storage: copy unreachable under the current configuration (delete will retry)");
      return;
    }
    try {
      await driver.delete(key);
    } catch (err) {
      ok = false;
      bump("deleteFailures");
      logger.warn({ error: safe(err), objectId: row.id, kind: row.kind, companyId: row.companyId, copy: what, driver: driver.kind }, "Object storage: physical delete failed (will retry)");
    }
  };
  if (row.driver === "gcs") {
    if (config.objectStorage.legacyDelete) await tryDelete(legacy, row.legacyKey ?? mirrorLocation(row.storageKey), "legacy");
    else retained = true; // never deleted in this phase; the tombstone protects and stays discoverable
  } else {
    const p = storageConfigured() ? await primary().catch(() => null) : null;
    await tryDelete(p && p.kind === row.driver ? p : null, row.storageKey, "primary");
    if (row.mirrorKey) await tryDelete(legacy, row.mirrorKey, "mirror");
    if (row.legacyKey) {
      if (config.objectStorage.legacyDelete) await tryDelete(legacy, row.legacyKey, "legacy");
      else retained = true;
    }
  }
  return { ok, retained };
}

async function enqueueDeleteRetry(objectId: string): Promise<void> {
  try {
    await getQueue().enqueue(STORAGE_DELETE_OBJECT_JOB, { objectId }, { dedupeKey: `storage.delete:${objectId}`, maxAttempts: 8 });
  } catch (err) {
    logger.error({ error: safe(err), objectId }, "Object storage: could not enqueue delete retry (maintenance sweep will retry)");
  }
}

/** Settled tombstone bookkeeping. Persisted locations (storage_key, mirror_key, legacy_key) are KEPT: a fenced-out writer may still publish a late copy at them, and only the persisted location lets the sweep remove it. */
function settledData(outcome: DeleteOutcome) {
  return { lastError: outcome.retained ? repo.LEGACY_RETAINED : null };
}

/**
 * Tombstone first, bytes second. Unknown / legacy references get a tombstone
 * row so the legacy bucket can never resurrect them.
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
        lastError: loc && !config.objectStorage.legacyDelete ? repo.LEGACY_RETAINED : null,
        deletedAt: new Date(),
      },
      tx,
    );
    return;
  }
  if (row.state === "deleted") return;
  const marked = await repo.transition(row.id, ["pending", "uploading", "staged", "active", "deleting", "failed"], "deleting", { deletedAt: row.deletedAt ?? new Date(), leaseToken: null, leaseExpiresAt: null }, tx);
  if (!marked) return;
  await finishDelete(marked);
}

/** Second half of a delete: remove the bytes and settle the row; retried durably on failure. */
export async function finishDelete(row: StorageObjectRow): Promise<boolean> {
  const outcome = await physicallyDelete(row);
  if (outcome.ok) {
    await repo.transition(row.id, ["deleting"], "deleted", settledData(outcome));
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
  const outcome = await physicallyDelete(row);
  if (!outcome.ok) throw new Error("storage object delete failed (retrying)");
  await repo.transition(row.id, ["deleting"], "deleted", settledData(outcome));
}

/**
 * Company deletion: register every supported pre-B25 reference of the tenant
 * as a tombstone (so the legacy objects stay discoverable for cleanup even
 * after the feature rows are cascaded away) and tombstone every live object —
 * all inside the deletion transaction.
 */
export async function tombstoneCompany(tx: Executor, companyId: number): Promise<number> {
  const { discoverLegacyReferences } = await import("../storage/migration-db.js");
  const { candidates, unattributable, unattributableKinds } = await discoverLegacyReferences({ companyId, tx, requireInventory: true });
  if (unattributable > 0) {
    // B25 Correction 2 — fail closed: a reference that cannot be inventoried
    // would lose its last pointer in the cascade and leave an undiscoverable
    // provider object. Nothing is committed; only sanitized counts are reported.
    logger.warn({ companyId, unattributable, kinds: unattributableKinds }, "Object storage: company deletion refused — stored file references cannot be inventoried");
    throw new AppError(409, "Company deletion refused: some stored file references cannot be inventoried", { code: "STORAGE_INVENTORY_INCOMPLETE", details: { unattributable, kinds: unattributableKinds } });
  }
  let registered = 0;
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.kind}|${c.reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = randomUUID();
    const row = await repo.insertIfAbsent(
      {
        id,
        companyId,
        kind: c.kind,
        entityType: c.entityType,
        entityId: c.entityId,
        reference: c.reference,
        storageKey: tenantKey(c.kind, companyId, id),
        driver: "gcs",
        legacyKey: c.legacyKey,
        contentType: c.contentType ?? defaultContentType(c.kind),
        state: "deleting",
        deletedAt: new Date(),
      },
      tx,
    );
    if (row.id === id) registered += 1;
  }
  const marked = await repo.markCompanyDeleting(companyId, tx);
  return marked + registered;
}

export async function enqueueCompanyPurge(companyId: number): Promise<void> {
  try {
    await getQueue().enqueue(STORAGE_PURGE_COMPANY_JOB, { companyId }, { dedupeKey: `storage.purge:${companyId}:${Date.now()}`, maxAttempts: 8 });
  } catch (err) {
    logger.error({ error: safe(err), companyId }, "Object storage: could not enqueue company purge (maintenance sweep will finish it)");
  }
}

/** Durable purge handler: removes the files of a tombstoned company in bounded batches (re-enqueues itself while rows remain). */
export async function runPurgeCompanyJob(payload: { companyId: number }): Promise<void> {
  if (!payload || !Number.isInteger(payload.companyId)) return;
  const batch = config.objectStorage.sweepBatchSize;
  const states: repo.StorageObjectState[] = ["deleting", "pending", "uploading", "staged", "active"];
  const rows = await repo.listByCompany(payload.companyId, states, batch);
  let failed = 0;
  for (const row of rows) {
    const marked = row.state === "deleting" ? row : await repo.transition(row.id, ["pending", "uploading", "staged", "active"], "deleting", { deletedAt: new Date(), leaseToken: null, leaseExpiresAt: null });
    if (!marked) continue;
    const outcome = await physicallyDelete(marked);
    if (outcome.ok) await repo.transition(marked.id, ["deleting"], "deleted", settledData(outcome));
    else failed += 1;
  }
  const remaining = await repo.listByCompany(payload.companyId, states, 1);
  if (failed > 0) throw new Error(`storage purge: ${failed} object(s) could not be removed yet (retrying)`);
  if (remaining.length > 0) await enqueueCompanyPurge(payload.companyId);
}

// ── maintenance sweep ────────────────────────────────────────────────────────
export interface SweepSummary {
  stalePending: number;
  staleStaged: number;
  expiredLeases: number;
  retriedDeletes: number;
  /** Tombstoned / failed rows whose flagged leftover copies were removed on retry (B25 Correction 2). */
  cleanupRetries: number;
  companyOrphans: number;
  entityOrphans: number;
  purgedTombstones: number;
}

/** Idempotent, bounded repair pass (runs inside the recurring maintenance sweep). */
export async function sweepStorage(now: Date = new Date()): Promise<SweepSummary> {
  const batch = config.objectStorage.sweepBatchSize;
  const summary: SweepSummary = { stalePending: 0, staleStaged: 0, expiredLeases: 0, retriedDeletes: 0, cleanupRetries: 0, companyOrphans: 0, entityOrphans: 0, purgedTombstones: 0 };
  if (!storageConfigured()) return summary;

  const settle = async (row: StorageObjectRow): Promise<boolean> => {
    const marked = row.state === "deleting" ? row : await repo.transition(row.id, ["pending", "uploading", "staged", "active", "failed"], "deleting", { deletedAt: new Date(), leaseToken: null, leaseExpiresAt: null });
    if (!marked) return false;
    const outcome = await physicallyDelete(marked);
    if (outcome.ok) await repo.transition(marked.id, ["deleting"], "deleted", settledData(outcome));
    return outcome.ok;
  };

  // Crashed / abandoned writers: an expired lease is fenced out (`failed`,
  // lease cleared — a writer that resumes later can no longer stage) and its
  // attempt-unique copies are removed at once. A writer still alive removes its
  // own late copies as well; both removals are idempotent.
  for (const row of await repo.listExpiredUploading(now, batch)) {
    const released = await repo.transition(row.id, ["uploading"], "failed", { leaseToken: null, leaseExpiresAt: null, lastError: "LEASE_EXPIRED" });
    if (!released) continue;
    summary.expiredLeases += 1;
    await settle(released);
  }
  // Leftover copies flagged by a fenced-out writer (CLEANUP_PENDING): retried
  // from the persisted locations without ever changing a tombstone's state.
  for (const row of await repo.listCleanupPending(batch)) {
    if (row.state === "deleted") {
      const outcome = await physicallyDelete(row);
      if (outcome.ok && (await repo.clearCleanupPending(row.id, outcome.retained ? repo.LEGACY_RETAINED : null))) summary.cleanupRetries += 1;
    } else if (await settle(row)) summary.cleanupRetries += 1;
  }
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
  for (const row of await repo.listEntityOrphans(new Date(now.getTime() - config.objectStorage.pendingTtlMs), batch)) {
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
  /** Whether references without an inventory row are served from the legacy bucket, and why. */
  legacyReads: LegacyReadMode;
  primaryFailures: number;
  legacyFallbackReads: number;
  mirrorFailures: number;
  migrationVerifyFailures: number;
  deleteFailures: number;
  legacyRegistrations: number;
  /** Inventory backlog; null when the inventory could not be read (never a fabricated 0). */
  pendingUploads: number | null;
  pendingDeletes: number | null;
  /** Tombstoned legacy bucket objects whose bytes were deliberately kept (await an approved GCS cleanup). */
  retainedLegacyObjects: number | null;
}

export async function storageMetrics(): Promise<StorageMetricsSnapshot> {
  const c = storageCounters();
  let pendingUploads: number | null = null;
  let pendingDeletes: number | null = null;
  let retainedLegacyObjects: number | null = null;
  try {
    const counts = await repo.countByStates();
    pendingUploads = (counts.pending ?? 0) + (counts.uploading ?? 0) + (counts.staged ?? 0);
    pendingDeletes = counts.deleting ?? 0;
    retainedLegacyObjects = await repo.countRetainedLegacyObjects();
  } catch (err) {
    logger.warn({ error: safe(err) }, "Object storage: inventory counts unavailable for metrics");
  }
  return {
    driver: storageMode(),
    legacyFallback: config.objectStorage.legacyFallback && !!config.objectStorage.bucketId,
    mirror: mirrorConfigured(),
    legacyReads: legacyReadMode(),
    ...c,
    pendingUploads,
    pendingDeletes,
    retainedLegacyObjects,
  };
}

export { db as storageDb };
