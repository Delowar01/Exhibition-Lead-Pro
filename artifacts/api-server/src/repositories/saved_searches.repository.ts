import { db, savedSearchesTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope } from "./base.js";

export type SavedSearchRow = typeof savedSearchesTable.$inferSelect;

// Saved searches are per-USER (not shared across a tenant): every query is
// scoped to companyId AND userId so one user never sees another's saved items.
export async function listForUser(user: AuthUser, opts: { entityType?: string; kind?: string }): Promise<SavedSearchRow[]> {
  const extra = [eq(savedSearchesTable.userId, user.id)];
  if (opts.entityType) extra.push(eq(savedSearchesTable.entityType, opts.entityType));
  if (opts.kind) extra.push(eq(savedSearchesTable.kind, opts.kind));
  const where = activeScope(user, savedSearchesTable.companyId, savedSearchesTable.deletedAt, { extra });
  return db.select().from(savedSearchesTable).where(where).orderBy(desc(savedSearchesTable.updatedAt), desc(savedSearchesTable.id));
}

export async function findById(user: AuthUser, id: number): Promise<SavedSearchRow | undefined> {
  const where = activeScope(user, savedSearchesTable.companyId, savedSearchesTable.deletedAt, {
    extra: [eq(savedSearchesTable.id, id), eq(savedSearchesTable.userId, user.id)],
  });
  const [row] = await db.select().from(savedSearchesTable).where(where).limit(1);
  return row;
}

export async function insert(values: typeof savedSearchesTable.$inferInsert): Promise<SavedSearchRow> {
  const [row] = await db.insert(savedSearchesTable).values(values).returning();
  return row;
}

export async function updateRow(id: number, userId: number, data: Partial<typeof savedSearchesTable.$inferInsert>): Promise<void> {
  await db
    .update(savedSearchesTable)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(savedSearchesTable.id, id), eq(savedSearchesTable.userId, userId)));
}

export async function softDelete(id: number, userId: number): Promise<void> {
  await db
    .update(savedSearchesTable)
    .set({ deletedAt: new Date() })
    .where(and(eq(savedSearchesTable.id, id), eq(savedSearchesTable.userId, userId)));
}
