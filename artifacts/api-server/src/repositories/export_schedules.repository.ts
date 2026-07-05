import { db, exportSchedulesTable } from "@workspace/db";
import { and, eq, lte, isNull, count, desc, asc, type SQL } from "drizzle-orm";

import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope } from "./base.js";

export type ExportScheduleRow = typeof exportSchedulesTable.$inferSelect;

// Tenant-scoped, soft-delete-excluding list of export schedules.
export async function list(user: AuthUser, opts: { limit: number; offset: number }): Promise<{ rows: ExportScheduleRow[]; total: number }> {
  const where = activeScope(user, exportSchedulesTable.companyId, exportSchedulesTable.deletedAt);
  const [{ total }] = await db.select({ total: count() }).from(exportSchedulesTable).where(where);
  const rows = await db
    .select()
    .from(exportSchedulesTable)
    .where(where)
    .orderBy(desc(exportSchedulesTable.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);
  return { rows, total };
}

// Tenant-scoped single fetch (undefined for missing/deleted/inaccessible).
export async function findById(user: AuthUser, id: number): Promise<ExportScheduleRow | undefined> {
  const where = activeScope(user, exportSchedulesTable.companyId, exportSchedulesTable.deletedAt, { extra: [eq(exportSchedulesTable.id, id)] });
  const [row] = await db.select().from(exportSchedulesTable).where(where).limit(1);
  return row;
}

export async function insert(values: typeof exportSchedulesTable.$inferInsert): Promise<ExportScheduleRow> {
  const [row] = await db.insert(exportSchedulesTable).values(values).returning();
  return row;
}

export async function update(id: number, data: Partial<typeof exportSchedulesTable.$inferInsert>): Promise<ExportScheduleRow | undefined> {
  const [row] = await db.update(exportSchedulesTable).set({ ...data, updatedAt: new Date() }).where(eq(exportSchedulesTable.id, id)).returning();
  return row;
}

export async function softDelete(id: number): Promise<void> {
  await db.update(exportSchedulesTable).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(exportSchedulesTable.id, id));
}

// Due schedules across ALL tenants: active, not deleted, nextRunAt <= now. Used
// by the recurring scheduler tick (system-wide, not tenant-scoped) to produce
// scheduled export files.
export async function dueSchedules(now: Date, limit = 50): Promise<ExportScheduleRow[]> {
  const conds: Array<SQL | undefined> = [
    eq(exportSchedulesTable.active, true),
    isNull(exportSchedulesTable.deletedAt),
    lte(exportSchedulesTable.nextRunAt, now),
  ];
  return db
    .select()
    .from(exportSchedulesTable)
    .where(and(...conds.filter((c): c is SQL => c !== undefined)))
    .orderBy(asc(exportSchedulesTable.nextRunAt))
    .limit(limit);
}

// Advance a schedule after a run: record lastRunAt + the next due time.
export async function markRun(id: number, lastRunAt: Date, nextRunAt: Date): Promise<void> {
  await db.update(exportSchedulesTable).set({ lastRunAt, nextRunAt, updatedAt: new Date() }).where(eq(exportSchedulesTable.id, id));
}
