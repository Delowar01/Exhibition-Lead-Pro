// Batch 25 — storage_objects inventory access (pure data access; the state
// machine and driver orchestration live in services/storage.service.ts).
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
import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, sql, count } from "drizzle-orm";
import { exec, type Executor } from "./base.js";

export type StorageObjectState = "pending" | "staged" | "active" | "deleting" | "deleted" | "failed";
export const TOMBSTONE_STATES: StorageObjectState[] = ["deleting", "deleted", "failed"];

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
    .set({ state: "deleting", deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(storageObjectsTable.companyId, companyId), inArray(storageObjectsTable.state, ["pending", "staged", "active"])))
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

/** Active objects whose owning company no longer exists. */
export async function listCompanyOrphans(limit: number): Promise<StorageObjectRow[]> {
  const rows = await db
    .select({ obj: storageObjectsTable })
    .from(storageObjectsTable)
    .leftJoin(companiesTable, eq(storageObjectsTable.companyId, companiesTable.id))
    .where(and(inArray(storageObjectsTable.state, ["pending", "staged", "active"]), isNull(companiesTable.id)))
    .limit(limit);
  return rows.map((r) => r.obj);
}

/** Active objects bound to a feature row that no longer exists (hard-deleted version/run/report/scan) or a replaced logo. */
export async function listEntityOrphans(limit: number): Promise<StorageObjectRow[]> {
  const out: StorageObjectRow[] = [];
  const take = async (rows: Array<{ obj: StorageObjectRow }>) => {
    for (const r of rows) if (out.length < limit) out.push(r.obj);
  };
  await take(
    await db
      .select({ obj: storageObjectsTable })
      .from(storageObjectsTable)
      .leftJoin(documentVersionsTable, eq(storageObjectsTable.entityId, documentVersionsTable.id))
      .where(and(eq(storageObjectsTable.state, "active"), eq(storageObjectsTable.entityType, "document_version"), isNull(documentVersionsTable.id)))
      .limit(limit),
  );
  await take(
    await db
      .select({ obj: storageObjectsTable })
      .from(storageObjectsTable)
      .leftJoin(exportRunsTable, eq(storageObjectsTable.entityId, exportRunsTable.id))
      .where(and(eq(storageObjectsTable.state, "active"), eq(storageObjectsTable.entityType, "export_run"), isNull(exportRunsTable.id)))
      .limit(limit),
  );
  await take(
    await db
      .select({ obj: storageObjectsTable })
      .from(storageObjectsTable)
      .leftJoin(executiveReportsTable, eq(storageObjectsTable.entityId, executiveReportsTable.id))
      .where(and(eq(storageObjectsTable.state, "active"), eq(storageObjectsTable.entityType, "executive_report"), isNull(executiveReportsTable.id)))
      .limit(limit),
  );
  await take(
    await db
      .select({ obj: storageObjectsTable })
      .from(storageObjectsTable)
      .leftJoin(scansTable, eq(storageObjectsTable.entityId, scansTable.id))
      .where(and(eq(storageObjectsTable.state, "active"), eq(storageObjectsTable.entityType, "scan"), isNull(scansTable.id)))
      .limit(limit),
  );
  // A logo whose company now points at a different key (replacement whose delete failed).
  await take(
    await db
      .select({ obj: storageObjectsTable })
      .from(storageObjectsTable)
      .innerJoin(companiesTable, eq(storageObjectsTable.companyId, companiesTable.id))
      .where(
        and(
          eq(storageObjectsTable.state, "active"),
          eq(storageObjectsTable.kind, "branding_logo"),
          sql`${companiesTable.brandLogoKey} is distinct from ${storageObjectsTable.reference}`,
        ),
      )
      .limit(limit),
  );
  return out;
}

/** Tombstones of companies that no longer exist, deleted long enough ago to drop the row. */
export async function listPurgeableTombstones(olderThan: Date, limit: number): Promise<StorageObjectRow[]> {
  const rows = await db
    .select({ obj: storageObjectsTable })
    .from(storageObjectsTable)
    .leftJoin(companiesTable, eq(storageObjectsTable.companyId, companiesTable.id))
    .where(and(eq(storageObjectsTable.state, "deleted"), isNull(companiesTable.id), lt(storageObjectsTable.updatedAt, olderThan)))
    .limit(limit);
  return rows.map((r) => r.obj);
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
