import { db, leadsTable, leadHistoryTable, contactsTable, usersTable, eventsTable } from "@workspace/db";
import { eq, and, count, ne, desc, inArray } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, notDeleted, type Executor } from "./base.js";

export type LeadRow = typeof leadsTable.$inferSelect;

// ── Enrichment lookups (FK name resolution). Contact/event lookups exclude
// soft-deleted rows so a lead never resolves a name from a deleted target.
export async function contactSummary(contactId: number) {
  const [r] = await db
    .select({ firstName: contactsTable.firstName, lastName: contactsTable.lastName, fullName: contactsTable.fullName, email: contactsTable.email, contactCompany: contactsTable.contactCompany })
    .from(contactsTable)
    .where(and(eq(contactsTable.id, contactId), notDeleted(contactsTable.deletedAt)))
    .limit(1);
  return r;
}

export async function assigneeName(userId: number) {
  const [r] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return r;
}

export async function eventName(eventId: number) {
  const [r] = await db
    .select({ name: eventsTable.name })
    .from(eventsTable)
    .where(and(eq(eventsTable.id, eventId), notDeleted(eventsTable.deletedAt)))
    .limit(1);
  return r;
}

// ── Batch enrichment lookups for list/pipeline (O(1) queries, not O(N)).
// Mirror the per-row lookups above: contacts/events exclude soft-deleted rows.
export async function contactSummariesByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db
    .select({ id: contactsTable.id, firstName: contactsTable.firstName, lastName: contactsTable.lastName, fullName: contactsTable.fullName, email: contactsTable.email, contactCompany: contactsTable.contactCompany })
    .from(contactsTable)
    .where(and(inArray(contactsTable.id, ids), notDeleted(contactsTable.deletedAt)));
}

export async function userNamesByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, ids));
}

export async function eventNamesByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db
    .select({ id: eventsTable.id, name: eventsTable.name })
    .from(eventsTable)
    .where(and(inArray(eventsTable.id, ids), notDeleted(eventsTable.deletedAt)));
}

export async function history(leadId: number) {
  return db
    .select({
      id: leadHistoryTable.id,
      leadId: leadHistoryTable.leadId,
      changedBy: leadHistoryTable.changedBy,
      changedByName: usersTable.name,
      fieldName: leadHistoryTable.fieldName,
      oldValue: leadHistoryTable.oldValue,
      newValue: leadHistoryTable.newValue,
      changedAt: leadHistoryTable.changedAt,
    })
    .from(leadHistoryTable)
    .leftJoin(usersTable, eq(leadHistoryTable.changedBy, usersTable.id))
    .where(eq(leadHistoryTable.leadId, leadId))
    .orderBy(desc(leadHistoryTable.changedAt));
}

// ── Tenant-scoped, soft-delete-excluding list with filters.
export async function list(
  user: AuthUser,
  opts: { stage?: string; assignedToId?: number; eventId?: number; contactId?: number; limit: number; offset: number },
): Promise<{ rows: LeadRow[]; total: number }> {
  const extra = [
    opts.stage !== undefined ? eq(leadsTable.stage, opts.stage) : undefined,
    opts.assignedToId !== undefined ? eq(leadsTable.assignedToId, opts.assignedToId) : undefined,
    opts.eventId !== undefined ? eq(leadsTable.eventId, opts.eventId) : undefined,
    opts.contactId !== undefined ? eq(leadsTable.contactId, opts.contactId) : undefined,
  ];
  const where = activeScope(user, leadsTable.companyId, leadsTable.deletedAt, { extra });
  const [{ total }] = await db.select({ total: count() }).from(leadsTable).where(where);
  const rows = await db.select().from(leadsTable).where(where).limit(opts.limit).offset(opts.offset).orderBy(leadsTable.createdAt);
  return { rows, total };
}

// All tenant leads (soft-delete excluded), ordered, for pipeline aggregation.
export async function pipelineLeads(user: AuthUser): Promise<LeadRow[]> {
  const where = activeScope(user, leadsTable.companyId, leadsTable.deletedAt);
  return db.select().from(leadsTable).where(where).orderBy(leadsTable.createdAt);
}

// Tenant-scoped, soft-delete-excluding single fetch (undefined for missing,
// deleted, or inaccessible).
export async function findById(user: AuthUser, id: number): Promise<LeadRow | undefined> {
  const where = activeScope(user, leadsTable.companyId, leadsTable.deletedAt, { extra: [eq(leadsTable.id, id)] });
  const [row] = await db.select().from(leadsTable).where(where).limit(1);
  return row;
}

// 409 conflict check: does this contact already have a non-lost, non-deleted lead
// in this company? Returns the existing lead id, else undefined.
export async function activeLeadIdForContact(companyId: number, contactId: number): Promise<number | undefined> {
  const [row] = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(and(eq(leadsTable.contactId, contactId), eq(leadsTable.companyId, companyId), ne(leadsTable.stage, "lost"), notDeleted(leadsTable.deletedAt)))
    .limit(1);
  return row?.id;
}

export async function insert(values: typeof leadsTable.$inferInsert): Promise<LeadRow> {
  const [row] = await db.insert(leadsTable).values(values).returning();
  return row;
}

// Atomic update: write any tracked history rows then update the lead.
export async function updateWithHistory(
  id: number,
  updateData: Partial<typeof leadsTable.$inferInsert>,
  historyRows: Array<typeof leadHistoryTable.$inferInsert>,
): Promise<LeadRow | undefined> {
  const [lead] = await db.transaction(async (tx) => {
    if (historyRows.length > 0) await tx.insert(leadHistoryTable).values(historyRows);
    return tx.update(leadsTable).set(updateData).where(eq(leadsTable.id, id)).returning();
  });
  return lead;
}

// Soft-delete. Replicates the prior onDelete cascade EXACTLY (lead_history.leadId
// was onDelete: "cascade"), then stamps deletedAt.
export async function softDelete(id: number, tx?: Executor): Promise<void> {
  const run = async (t: Executor) => {
    await t.delete(leadHistoryTable).where(eq(leadHistoryTable.leadId, id));
    await t.update(leadsTable).set({ deletedAt: new Date() }).where(eq(leadsTable.id, id));
  };
  if (tx) return run(tx);
  await db.transaction(run);
}
