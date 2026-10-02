// Batch 25 — storage_objects inventory access (pure data access; the state
// machine and driver orchestration live in services/storage.service.ts).
// B25 Correction 1: upload leases (CAS claim / release), expired-lease and
// retained-legacy listings, and orphan detection by LIVE FEATURE REFERENCE
// (an object is an orphan only when NO feature row still references it).
import {
  db,
  storageObjectsTable,
  companiesTable,
  documentVersionsTable,
  exportRunsTable,
  executiveReportsTable,
  scansTable,
  type StorageObjectRow,
  type InsertStorageObject,
} from "@workspace/db";
import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql, count, notExists } from "drizzle-orm";
import { exec, type Executor } from "./base.js";

export type StorageObjectState = "pending" | "uploading" | "staged" | "active" | "deleting" | "deleted" | "failed";
export const TOMBSTONE_STATES: StorageObjectState[] = ["deleting", "deleted", "failed"];
export const LIVE_STATES: StorageObjectState[] = ["pending", "uploading", "staged", "active"];
/** Tombstone rows whose legacy bucket object was deliberately kept (OBJECT_STORAGE_LEGACY_DELETE off). */
export const LEGACY_RETAINED = "LEGACY_RETAINED";

export async function insert(values: InsertStorageObject, tx?: Executor): Promise<StorageObjectRow> {
  const [row] = await exec(tx).insert(storageObjectsTable).values(values).returning();
  return row;
}

/** Insert unless a row with the same (company, kind, reference) exists; returns the row that exists afterwards. */
export async function insertIfAbsent(values: InsertStorageObject, tx?: Executor): Promise<StorageObjectRow> {
  const [row] = await exec(tx)
    .insert(storageObjectsTable)
    .values(values)
    .onConflictDoNothing({ target: [storageObjectsTable.companyId, storageObjectsTable.kind, storageObjectsTable.reference] })
    .returning();
  if (row) return row;
  const existing = await findByReference(values.companyId, values.kind, values.reference, tx);
  if (!existing) throw new Error("storage object insert race could not be resolved");
  return existing;
}

export async function findById(id: string, tx?: Executor): Promise<StorageObjectRow | undefined> {
  const [row] = await exec(tx).select().from(storageObjectsTable).where(eq(storageObjectsTable.id, id)).limit(1);
  return row;
}

export async function findByReference(companyId: number, kind: string, reference: string, tx?: Executor): Promise<StorageObjectRow | undefined> {
  const [row] = await exec(tx)
    .select()
    .from(storageObjectsTable)
    .where(and(eq(storageObjectsTable.companyId, companyId), eq(storageObjectsTable.kind, kind), eq(storageObjectsTable.reference, reference)))
    .limit(1);
  return row;
}

export async function update(id: string, data: Partial<InsertStorageObject>, tx?: Executor): Promise<StorageObjectRow | undefined> {
  const [row] = await exec(tx)
    .update(storageObjectsTable)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(storageObjectsTable.id, id))
    .returning();
  return row;
}

/** Conditional state transition; returns undefined when the row was not in one of `from`. */
export async function transition(id: string, from: StorageObjectState[], to: StorageObjectState, data: Partial<InsertStorageObject> = {}, tx?: Executor): Promise<StorageObjectRow | undefined> {
  const [row] = await exec(tx)
    .update(storageObjectsTable)
    .set({ ...data, state: to, updatedAt: new Date() })
    .where(and(eq(storageObjectsTable.id, id), inArray(storageObjectsTable.state, from)))
    .returning();
  return row;
}

/**
 * Upload lease (B25 Correction 1): exactly one writer may own publication of an
 * upload intent. Claims succeed only from pending / failed, or from an
 * `uploading` row whose lease has expired (crash recovery). Returns undefined
 * when another writer holds a live lease or the upload already completed.
 */
export async function claimUpload(id: string, leaseToken: string, leaseMs: number, now: Date = new Date()): Promise<StorageObjectRow | undefined> {
  const [row] = await db
    .update(storageObjectsTable)
    .set({ state: "uploading", leaseToken, leaseExpiresAt: new Date(now.getTime() + leaseMs), lastError: null, updatedAt: now })
    .where(
      and(
        eq(storageObjectsTable.id, id),
        or(
          inArray(storageObjectsTable.state, ["pending", "failed"]),
          and(eq(storageObjectsTable.state, "uploading"), lt(storageObjectsTable.leaseExpiresAt, now)),
        ),
      ),
    )
    .returning();
  return row;
}

/** Finish or abandon an upload ONLY while the caller still holds the lease (CAS on the lease token). */
export async function releaseUpload(id: string, leaseToken: string, to: "staged" | "failed", data: Partial<InsertStorageObject> = {}): Promise<StorageObjectRow | undefined> {
  const [row] = await db
    .update(storageObjectsTable)
    .set({ ...data, state: to, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(storageObjectsTable.id, id), eq(storageObjectsTable.state, "uploading"), eq(storageObjectsTable.leaseToken, leaseToken)))
    .returning();
  return row;
}

export async function ownsLease(id: string, leaseToken: string): Promise<boolean> {
  const [row] = await db
    .select({ id: storageObjectsTable.id })
    .from(storageObjectsTable)
    .where(and(eq(storageObjectsTable.id, id), eq(storageObjectsTable.state, "uploading"), eq(storageObjectsTable.leaseToken, leaseToken)))
    .limit(1);
  return !!row;
}

/** `uploading` rows whose lease expired (crashed / abandoned writers). */
export async function listExpiredUploading(now: Date, limit: number): Promise<StorageObjectRow[]> {
  return db
    .select()
    .from(storageObjectsTable)
    .where(and(eq(storageObjectsTable.state, "uploading"), lt(storageObjectsTable.leaseExpiresAt, now)))
    .orderBy(storageObjectsTable.updatedAt)
    .limit(limit);
}

export async function setEntity(id: string, entityType: string, entityId: number, tx?: Executor): Promise<void> {
  await exec(tx).update(storageObjectsTable).set({ entityType, entityId, updatedAt: new Date() }).where(eq(storageObjectsTable.id, id));
}

export async function remove(id: string, tx?: Executor): Promise<void> {
  await exec(tx).delete(storageObjectsTable).where(eq(storageObjectsTable.id, id));
}

export async function listByCompany(companyId: number, states: StorageObjectState[], limit: number, tx?: Executor): Promise<StorageObjectRow[]> {
  return exec(tx)
    .select()
    .from(storageObjectsTable)
    .where(and(eq(storageObjectsTable.companyId, companyId), inArray(storageObjectsTable.state, states)))
    .orderBy(storageObjectsTable.createdAt)
    .limit(limit);
}

/** Tombstone every live object of a company (company deletion). Returns the number of rows marked. */
export async function markCompanyDeleting(companyId: number, tx?: Executor): Promise<number> {
  const rows = await exec(tx)
    .update(storageObjectsTable)
    .set({ state: "deleting", deletedAt: new Date(), updatedAt: new Date(), leaseToken: null, leaseExpiresAt: null })
    .where(and(eq(storageObjectsTable.companyId, companyId), inArray(storageObjectsTable.state, LIVE_STATES)))
    .returning({ id: storageObjectsTable.id });
  return rows.length;
}

export async function listStale(state: StorageObjectState, olderThan: Date, limit: number): Promise<StorageObjectRow[]> {
  return db
    .select()
    .from(storageObjectsTable)
    .where(and(eq(storageObjectsTable.state, state), lt(storageObjectsTable.updatedAt, olderThan)))
    .orderBy(storageObjectsTable.updatedAt)
    .limit(limit);
}

/** Migration cursor: active rows with a legacy location, in id order, strictly after `afterId`. */
export async function listMigratable(afterId: string | null, limit: number): Promise<StorageObjectRow[]> {
  const conds = [eq(storageObjectsTable.state, "active"), isNotNull(storageObjectsTable.legacyKey)];
  if (afterId) conds.push(gt(storageObjectsTable.id, afterId));
  return db.select().from(storageObjectsTable).where(and(...conds)).orderBy(storageObjectsTable.id).limit(limit);
}

export async function listDeleting(limit: number): Promise<StorageObjectRow[]> {
  return db.select().from(storageObjectsTable).where(eq(storageObjectsTable.state, "deleting")).orderBy(storageObjectsTable.updatedAt).limit(limit);
}

/** Live objects whose owning company no longer exists. */
export async function listCompanyOrphans(limit: number): Promise<StorageObjectRow[]> {
  const rows = await db
    .select({ obj: storageObjectsTable })
    .from(storageObjectsTable)
    .leftJoin(companiesTable, eq(storageObjectsTable.companyId, companiesTable.id))
    .where(and(inArray(storageObjectsTable.state, ["pending", "staged", "active"]), isNull(companiesTable.id)))
    .limit(limit);
  return rows.map((r) => r.obj);
}

/**
 * Active objects that NO live feature row references any more (B25 Correction 1:
 * decided by the reference value across the whole feature table of the
 * tenant, not by the single bound entity — a reference shared by two versions
 * stays alive while either version exists). Crash-window objects (a scan /
 * logo whose row points elsewhere) are included because nothing references them.
 */
export async function listEntityOrphans(olderThan: Date, limit: number): Promise<StorageObjectRow[]> {
  const so = storageObjectsTable;
  const referenced = {
    document: notExists(
      db.select({ one: sql`1` }).from(documentVersionsTable).where(and(eq(documentVersionsTable.companyId, so.companyId), eq(documentVersionsTable.objectPath, so.reference))),
    ),
    export: notExists(db.select({ one: sql`1` }).from(exportRunsTable).where(and(eq(exportRunsTable.companyId, so.companyId), eq(exportRunsTable.objectPath, so.reference)))),
    report: notExists(
      db.select({ one: sql`1` }).from(executiveReportsTable).where(and(eq(executiveReportsTable.companyId, so.companyId), eq(executiveReportsTable.objectPath, so.reference))),
    ),
    scan_image: notExists(db.select({ one: sql`1` }).from(scansTable).where(and(eq(scansTable.companyId, so.companyId), eq(scansTable.imageUrl, so.reference)))),
    branding_logo: notExists(db.select({ one: sql`1` }).from(companiesTable).where(and(eq(companiesTable.id, so.companyId), eq(companiesTable.brandLogoKey, so.reference)))),
  };
  return db
    .select()
    .from(so)
    .where(
      and(
        eq(so.state, "active"),
        // Grace window: a freshly activated object may be bound by the feature
        // transaction that follows activation (scan images, documents).
        lt(so.updatedAt, olderThan),
        or(
          and(eq(so.kind, "document"), referenced.document),
          and(eq(so.kind, "export"), referenced.export),
          and(eq(so.kind, "report"), referenced.report),
          and(eq(so.kind, "scan_image"), referenced.scan_image),
          and(eq(so.kind, "branding_logo"), referenced.branding_logo),
        ),
      ),
    )
    .orderBy(so.updatedAt)
    .limit(limit);
}

/**
 * Whether a feature row of THIS tenant still carries the value as its storage
 * reference. Pre-B25 document / export / report handles (`/objects/uploads/…`)
 * are not tenant-namespaced in the legacy bucket, so a reference without an
 * inventory row is only served (and registered) when the caller's tenant owns
 * a feature row pointing at it. Scan / branding keys embed the tenant id and
 * are shape-bound in legacy.ts; they are still cross-checked here.
 */
export async function legacyReferenceOwned(companyId: number, kind: string, reference: string): Promise<boolean> {
  const one = { one: sql`1` };
  switch (kind) {
    case "document": {
      const rows = await db.select(one).from(documentVersionsTable).where(and(eq(documentVersionsTable.companyId, companyId), eq(documentVersionsTable.objectPath, reference))).limit(1);
      return rows.length > 0;
    }
    case "export": {
      const rows = await db.select(one).from(exportRunsTable).where(and(eq(exportRunsTable.companyId, companyId), eq(exportRunsTable.objectPath, reference))).limit(1);
      return rows.length > 0;
    }
    case "report": {
      const rows = await db.select(one).from(executiveReportsTable).where(and(eq(executiveReportsTable.companyId, companyId), eq(executiveReportsTable.objectPath, reference))).limit(1);
      return rows.length > 0;
    }
    case "scan_image": {
      const rows = await db.select(one).from(scansTable).where(and(eq(scansTable.companyId, companyId), eq(scansTable.imageUrl, reference))).limit(1);
      return rows.length > 0;
    }
    case "branding_logo": {
      const rows = await db.select(one).from(companiesTable).where(and(eq(companiesTable.id, companyId), eq(companiesTable.brandLogoKey, reference))).limit(1);
      return rows.length > 0;
    }
    default:
      return false;
  }
}

/** Tombstones of companies that no longer exist, deleted long enough ago to drop the row — never a retained legacy record. */
export async function listPurgeableTombstones(olderThan: Date, limit: number): Promise<StorageObjectRow[]> {
  const rows = await db
    .select({ obj: storageObjectsTable })
    .from(storageObjectsTable)
    .leftJoin(companiesTable, eq(storageObjectsTable.companyId, companiesTable.id))
    .where(
      and(
        eq(storageObjectsTable.state, "deleted"),
        isNull(companiesTable.id),
        lt(storageObjectsTable.updatedAt, olderThan),
        or(isNull(storageObjectsTable.lastError), ne(storageObjectsTable.lastError, LEGACY_RETAINED)),
      ),
    )
    .limit(limit);
  return rows.map((r) => r.obj);
}

/** Legacy bucket objects whose tombstone kept the bytes (discoverable for a later, approved GCS cleanup). */
export async function listRetainedLegacyObjects(limit: number): Promise<StorageObjectRow[]> {
  return db
    .select()
    .from(storageObjectsTable)
    .where(and(eq(storageObjectsTable.state, "deleted"), eq(storageObjectsTable.lastError, LEGACY_RETAINED), isNotNull(storageObjectsTable.legacyKey)))
    .orderBy(storageObjectsTable.updatedAt)
    .limit(limit);
}

export async function countRetainedLegacyObjects(): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(storageObjectsTable)
    .where(and(eq(storageObjectsTable.state, "deleted"), eq(storageObjectsTable.lastError, LEGACY_RETAINED), isNotNull(storageObjectsTable.legacyKey)));
  return Number(r?.n ?? 0);
}

export async function countByStates(): Promise<Record<string, number>> {
  const rows = await db.select({ state: storageObjectsTable.state, n: count() }).from(storageObjectsTable).groupBy(storageObjectsTable.state);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.state] = Number(r.n);
  return out;
}

export async function countLiveForCompany(companyId: number): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(storageObjectsTable)
    .where(and(eq(storageObjectsTable.companyId, companyId), ne(storageObjectsTable.state, "deleted")));
  return Number(r?.n ?? 0);
}
