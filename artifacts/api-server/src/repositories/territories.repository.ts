import { db, territoriesTable, usersTable, teamsTable } from "@workspace/db";
import { eq, asc, count, inArray, type SQL } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope } from "./base.js";

export type TerritoryRow = typeof territoriesTable.$inferSelect;

export async function list(user: AuthUser): Promise<{ rows: TerritoryRow[]; total: number }> {
  const where = activeScope(user, territoriesTable.companyId, territoriesTable.deletedAt);
  const rows = await db
    .select()
    .from(territoriesTable)
    .where(where)
    .orderBy(asc(territoriesTable.sortOrder), asc(territoriesTable.id));
  const [{ value: total }] = await db.select({ value: count() }).from(territoriesTable).where(where);
  return { rows, total };
}

// Tenant-scoped, soft-delete-excluding single fetch (undefined for missing,
// deleted, or inaccessible).
export async function findById(user: AuthUser, id: number): Promise<TerritoryRow | undefined> {
  const where = activeScope(user, territoriesTable.companyId, territoriesTable.deletedAt, {
    extra: [eq(territoriesTable.id, id)],
  });
  const [row] = await db.select().from(territoriesTable).where(where).limit(1);
  return row;
}

export async function insert(data: typeof territoriesTable.$inferInsert): Promise<TerritoryRow> {
  const [row] = await db.insert(territoriesTable).values(data).returning();
  return row;
}

export async function update(
  id: number,
  data: Partial<typeof territoriesTable.$inferInsert>,
): Promise<TerritoryRow | undefined> {
  const [row] = await db.update(territoriesTable).set(data).where(eq(territoriesTable.id, id)).returning();
  return row;
}

export async function softDelete(id: number): Promise<void> {
  await db
    .update(territoriesTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(territoriesTable.id, id));
}

// Batched name lookups for response formatting (assignee + team).
export async function usersByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, ids));
}

export async function teamsByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db.select({ id: teamsTable.id, name: teamsTable.name }).from(teamsTable).where(inArray(teamsTable.id, ids));
}
