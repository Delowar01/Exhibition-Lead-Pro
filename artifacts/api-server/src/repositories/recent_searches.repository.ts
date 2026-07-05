import { db, recentSearchesTable } from "@workspace/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";

export type RecentSearchRow = typeof recentSearchesTable.$inferSelect;

// Recent searches are per-user + per-entity, newest first. No soft-delete: the
// list is pruned by age (keep the most recent N).
export async function listForUser(user: AuthUser, entityType: string, limit: number): Promise<RecentSearchRow[]> {
  return db
    .select()
    .from(recentSearchesTable)
    .where(and(eq(recentSearchesTable.companyId, user.companyId!), eq(recentSearchesTable.userId, user.id), eq(recentSearchesTable.entityType, entityType)))
    .orderBy(desc(recentSearchesTable.createdAt), desc(recentSearchesTable.id))
    .limit(limit);
}

export async function insert(values: typeof recentSearchesTable.$inferInsert): Promise<RecentSearchRow> {
  const [row] = await db.insert(recentSearchesTable).values(values).returning();
  return row;
}

// Keep only the most recent `keep` rows for this user+entity; delete the rest.
export async function prune(user: AuthUser, entityType: string, keep: number): Promise<void> {
  const rows = await db
    .select({ id: recentSearchesTable.id, createdAt: recentSearchesTable.createdAt })
    .from(recentSearchesTable)
    .where(and(eq(recentSearchesTable.companyId, user.companyId!), eq(recentSearchesTable.userId, user.id), eq(recentSearchesTable.entityType, entityType)))
    .orderBy(desc(recentSearchesTable.createdAt), desc(recentSearchesTable.id))
    .offset(keep)
    .limit(1000);
  if (rows.length === 0) return;
  await db.delete(recentSearchesTable).where(inArray(recentSearchesTable.id, rows.map((r) => r.id)));
}

export async function clearForUser(user: AuthUser, entityType: string): Promise<void> {
  await db
    .delete(recentSearchesTable)
    .where(and(eq(recentSearchesTable.companyId, user.companyId!), eq(recentSearchesTable.userId, user.id), eq(recentSearchesTable.entityType, entityType)));
}
