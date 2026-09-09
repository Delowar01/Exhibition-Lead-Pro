import { db, eventsTable, contactsTable, leadsTable } from "@workspace/db";
import { eq, ilike, and, count, sum, isNull, inArray } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, notDeleted } from "./base.js";
import { exec, type Executor } from "./base.js";

export type EventRow = typeof eventsTable.$inferSelect;

// Per-event aggregate counts. Excludes soft-deleted contacts/leads so counts
// match the rest of the API after soft-delete groundwork.
export async function counts(eventId: number): Promise<{ contactCount: number; leadCount: number }> {
  const [contactCount] = await db
    .select({ count: count() })
    .from(contactsTable)
    .where(and(eq(contactsTable.eventId, eventId), isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt)));
  const [leadCount] = await db
    .select({ count: count() })
    .from(leadsTable)
    .where(and(eq(leadsTable.eventId, eventId), notDeleted(leadsTable.deletedAt)));
  return { contactCount: contactCount.count, leadCount: leadCount.count };
}

// Tenant-scoped, soft-delete-excluding list with optional name search.
export async function list(
  user: AuthUser,
  opts: { search?: string; limit: number; offset: number },
): Promise<{ rows: EventRow[]; total: number }> {
  const where = activeScope(user, eventsTable.companyId, eventsTable.deletedAt, {
    extra: opts.search ? [ilike(eventsTable.name, `%${opts.search}%`)] : [],
  });
  const [{ total }] = await db.select({ total: count() }).from(eventsTable).where(where);
  const rows = await db
    .select()
    .from(eventsTable)
    .where(where)
    .limit(opts.limit)
    .offset(opts.offset)
    .orderBy(eventsTable.createdAt);
  return { rows, total };
}

// Tenant-scoped, soft-delete-excluding fetch of a specific set of events (used by
// the Company Detail aggregate, which derives event ids from an org's contacts).
export async function listByIds(user: AuthUser, ids: number[]): Promise<EventRow[]> {
  if (ids.length === 0) return [];
  const where = activeScope(user, eventsTable.companyId, eventsTable.deletedAt, { extra: [inArray(eventsTable.id, ids)] });
  return db.select().from(eventsTable).where(where).orderBy(eventsTable.startDate);
}

// Tenant-scoped, soft-delete-excluding single fetch. Returns undefined when the
// row does not exist, is soft-deleted, or is not accessible to the caller.
export async function findById(user: AuthUser, id: number): Promise<EventRow | undefined> {
  const where = activeScope(user, eventsTable.companyId, eventsTable.deletedAt, { extra: [eq(eventsTable.id, id)] });
  const [row] = await db.select().from(eventsTable).where(where).limit(1);
  return row;
}

export async function insert(values: typeof eventsTable.$inferInsert, tx?: Executor): Promise<EventRow> {
  const [row] = await exec(tx).insert(eventsTable).values(values).returning();
  return row;
}

export async function update(id: number, data: Partial<typeof eventsTable.$inferInsert>): Promise<EventRow | undefined> {
  const [row] = await db.update(eventsTable).set(data).where(eq(eventsTable.id, id)).returning();
  return row;
}

// Soft-delete. Replicates the table's prior onDelete cascade EXACTLY (events were
// referenced by contacts.eventId & leads.eventId with onDelete: "set null"), then
// stamps deletedAt — so observable behavior is identical to the old hard delete.
export async function softDelete(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(contactsTable).set({ eventId: null }).where(eq(contactsTable.eventId, id));
    await tx.update(leadsTable).set({ eventId: null }).where(eq(leadsTable.eventId, id));
    await tx.update(eventsTable).set({ deletedAt: new Date() }).where(eq(eventsTable.id, id));
  });
}

// Stats aggregates for a single event. Excludes soft-deleted contacts/leads.
export async function statsAggregates(id: number) {
  const [contactCount] = await db
    .select({ count: count() })
    .from(contactsTable)
    .where(and(eq(contactsTable.eventId, id), isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt)));
  const [qualifiedCountRow] = await db
    .select({ count: count() })
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.eventId, id),
        isNull(contactsTable.duplicateOfId),
        notDeleted(contactsTable.deletedAt),
        inArray(contactsTable.status, ["qualified", "interested"]),
      ),
    );
  const [leadCount] = await db
    .select({ count: count() })
    .from(leadsTable)
    .where(and(eq(leadsTable.eventId, id), notDeleted(leadsTable.deletedAt)));
  const wonLeads = await db
    .select({ count: count(), total: sum(leadsTable.value) })
    .from(leadsTable)
    .where(and(eq(leadsTable.eventId, id), eq(leadsTable.stage, "won"), notDeleted(leadsTable.deletedAt)));
  const byStage = await db
    .select({ stage: leadsTable.stage, count: count() })
    .from(leadsTable)
    .where(and(eq(leadsTable.eventId, id), notDeleted(leadsTable.deletedAt)))
    .groupBy(leadsTable.stage);
  return { contactCount, qualifiedCountRow, leadCount, wonLeads, byStage };
}
