import { db, tagsTable, leadTagsTable } from "@workspace/db";
import { eq, and, asc, inArray } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, notDeleted } from "./base.js";

export type TagRow = typeof tagsTable.$inferSelect;

export async function listForCompany(user: AuthUser): Promise<TagRow[]> {
  const where = activeScope(user, tagsTable.companyId, tagsTable.deletedAt);
  return db.select().from(tagsTable).where(where).orderBy(asc(tagsTable.name));
}

export async function findById(user: AuthUser, id: number): Promise<TagRow | undefined> {
  const where = activeScope(user, tagsTable.companyId, tagsTable.deletedAt, { extra: [eq(tagsTable.id, id)] });
  const [row] = await db.select().from(tagsTable).where(where).limit(1);
  return row;
}

export async function findByNameActive(companyId: number, name: string): Promise<TagRow | undefined> {
  const [row] = await db
    .select()
    .from(tagsTable)
    .where(and(eq(tagsTable.companyId, companyId), eq(tagsTable.name, name), notDeleted(tagsTable.deletedAt)))
    .limit(1);
  return row;
}

export async function insert(values: typeof tagsTable.$inferInsert): Promise<TagRow> {
  const [row] = await db.insert(tagsTable).values(values).returning();
  return row;
}

export async function update(id: number, data: Partial<typeof tagsTable.$inferInsert>): Promise<TagRow | undefined> {
  const [row] = await db.update(tagsTable).set({ ...data, updatedAt: new Date() }).where(eq(tagsTable.id, id)).returning();
  return row;
}

// Soft-delete the tag and hard-remove its lead join rows (the join carries no
// history worth keeping; leaving them would orphan filter results).
export async function softDelete(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(leadTagsTable).where(eq(leadTagsTable.tagId, id));
    await tx.update(tagsTable).set({ deletedAt: new Date() }).where(eq(tagsTable.id, id));
  });
}

// ── lead_tags join
export async function tagsForLead(leadId: number): Promise<TagRow[]> {
  const rows = await db
    .select({ tag: tagsTable })
    .from(leadTagsTable)
    .innerJoin(tagsTable, eq(leadTagsTable.tagId, tagsTable.id))
    .where(and(eq(leadTagsTable.leadId, leadId), notDeleted(tagsTable.deletedAt)))
    .orderBy(asc(tagsTable.name));
  return rows.map((r) => r.tag);
}

export async function tagsForLeads(leadIds: number[]): Promise<Map<number, TagRow[]>> {
  const m = new Map<number, TagRow[]>();
  if (leadIds.length === 0) return m;
  const rows = await db
    .select({ leadId: leadTagsTable.leadId, tag: tagsTable })
    .from(leadTagsTable)
    .innerJoin(tagsTable, eq(leadTagsTable.tagId, tagsTable.id))
    .where(and(inArray(leadTagsTable.leadId, leadIds), notDeleted(tagsTable.deletedAt)))
    .orderBy(asc(tagsTable.name));
  for (const r of rows) {
    const arr = m.get(r.leadId) ?? [];
    arr.push(r.tag);
    m.set(r.leadId, arr);
  }
  return m;
}

export async function attach(companyId: number, leadId: number, tagId: number): Promise<void> {
  await db.insert(leadTagsTable).values({ companyId, leadId, tagId }).onConflictDoNothing();
}

export async function detach(leadId: number, tagId: number): Promise<void> {
  await db.delete(leadTagsTable).where(and(eq(leadTagsTable.leadId, leadId), eq(leadTagsTable.tagId, tagId)));
}
