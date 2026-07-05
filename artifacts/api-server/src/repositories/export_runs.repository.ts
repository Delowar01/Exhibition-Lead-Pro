import { db, exportRunsTable } from "@workspace/db";
import { eq, count, desc, type SQL } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { tenantOnly } from "./base.js";

export type ExportRunRow = typeof exportRunsTable.$inferSelect;

// Tenant-scoped list of produced export files, newest first.
export async function list(
  user: AuthUser,
  opts: { entityType?: string; scheduleId?: number; limit: number; offset: number },
): Promise<{ rows: ExportRunRow[]; total: number }> {
  const extra: Array<SQL | undefined> = [
    opts.entityType !== undefined ? eq(exportRunsTable.entityType, opts.entityType) : undefined,
    opts.scheduleId !== undefined ? eq(exportRunsTable.scheduleId, opts.scheduleId) : undefined,
  ];
  const where = tenantOnly(user, exportRunsTable.companyId, ...extra);
  const [{ total }] = await db.select({ total: count() }).from(exportRunsTable).where(where);
  const rows = await db
    .select()
    .from(exportRunsTable)
    .where(where)
    .orderBy(desc(exportRunsTable.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);
  return { rows, total };
}

// Tenant-scoped single fetch (undefined for missing/inaccessible).
export async function findById(user: AuthUser, id: number): Promise<ExportRunRow | undefined> {
  const where = tenantOnly(user, exportRunsTable.companyId, eq(exportRunsTable.id, id));
  const [row] = await db.select().from(exportRunsTable).where(where).limit(1);
  return row;
}

export async function insert(values: typeof exportRunsTable.$inferInsert): Promise<ExportRunRow> {
  const [row] = await db.insert(exportRunsTable).values(values).returning();
  return row;
}
