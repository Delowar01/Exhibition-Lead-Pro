import { db, scansTable, companiesTable } from "@workspace/db";
import { eq, count, sql } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { tenantOnly } from "./base.js";

export type ScanRow = typeof scansTable.$inferSelect;

// Tenant-scoped list. scans has no soft-delete column, so tenantOnly is used.
export async function list(user: AuthUser, opts: { limit: number; offset: number }): Promise<{ rows: ScanRow[]; total: number }> {
  const where = tenantOnly(user, scansTable.companyId);
  const [{ total }] = await db.select({ total: count() }).from(scansTable).where(where);
  const rows = await db.select().from(scansTable).where(where).limit(opts.limit).offset(opts.offset).orderBy(scansTable.createdAt);
  return { rows, total };
}

// Tenant-scoped single fetch. Returns undefined when the row does not exist or
// is not accessible to the caller (both map to a 404 in the service).
export async function findById(user: AuthUser, id: number): Promise<ScanRow | undefined> {
  const where = tenantOnly(user, scansTable.companyId, eq(scansTable.id, id));
  const [row] = await db.select().from(scansTable).where(where).limit(1);
  return row;
}

// Increment the company's scan usage counter. Raw sql expression preserved intact.
export async function incrementScansUsed(companyId: number): Promise<void> {
  await db.update(companiesTable).set({ scansUsed: sql`${companiesTable.scansUsed} + 1` }).where(eq(companiesTable.id, companyId));
}

export async function insert(values: typeof scansTable.$inferInsert): Promise<ScanRow> {
  const [row] = await db.insert(scansTable).values(values).returning();
  return row;
}

export async function update(id: number, data: Partial<typeof scansTable.$inferInsert>): Promise<ScanRow | undefined> {
  const [row] = await db.update(scansTable).set(data).where(eq(scansTable.id, id)).returning();
  return row;
}

export async function setImageUrl(scanId: number, objectKey: string): Promise<void> {
  await db.update(scansTable).set({ imageUrl: objectKey }).where(eq(scansTable.id, scanId));
}
