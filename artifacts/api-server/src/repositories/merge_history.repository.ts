import { db, mergeHistoryTable, usersTable } from "@workspace/db";
import { eq, desc, count, inArray, type SQL } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { tenantOnly } from "./base.js";
import { exec, type Executor } from "./base.js";

export type MergeHistoryRow = typeof mergeHistoryTable.$inferSelect;

export interface ListMergeHistoryOpts {
  entityType?: string;
  limit: number;
  offset: number;
}

export async function list(
  user: AuthUser,
  opts: ListMergeHistoryOpts,
): Promise<{ rows: MergeHistoryRow[]; total: number }> {
  const extra: Array<SQL | undefined> = [
    opts.entityType !== undefined ? eq(mergeHistoryTable.entityType, opts.entityType) : undefined,
  ];
  const where = tenantOnly(user, mergeHistoryTable.companyId, ...extra);
  const rows = await db
    .select()
    .from(mergeHistoryTable)
    .where(where)
    .orderBy(desc(mergeHistoryTable.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);
  const [{ value: total }] = await db.select({ value: count() }).from(mergeHistoryTable).where(where);
  return { rows, total };
}

// Append one merge record. Runs on the shared pool or a provided tx so the write
// can be part of the same transaction as the merge itself.
export async function insert(
  data: typeof mergeHistoryTable.$inferInsert,
  tx?: Executor,
): Promise<MergeHistoryRow> {
  const [row] = await exec(tx).insert(mergeHistoryTable).values(data).returning();
  return row;
}

// Tenant-scoped single fetch — used by undo to load the snapshot for reversal.
export async function findById(user: AuthUser, id: number): Promise<MergeHistoryRow | undefined> {
  const where = tenantOnly(user, mergeHistoryTable.companyId, eq(mergeHistoryTable.id, id));
  const [row] = await db.select().from(mergeHistoryTable).where(where).limit(1);
  return row;
}

export async function usersByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, ids));
}
