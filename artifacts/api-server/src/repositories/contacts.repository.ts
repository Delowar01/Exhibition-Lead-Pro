import {
  db,
  contactsTable,
  usersTable,
  eventsTable,
  scansTable,
  leadsTable,
  tasksTable,
  meetingsTable,
  followUpsTable,
  contactStatusHistoryTable,
  mergeHistoryTable,
  customFieldValuesTable,
} from "@workspace/db";
import { eq, ne, ilike, and, count, sql, inArray, isNull, isNotNull, desc, asc, type SQL } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, notDeleted, type Executor } from "./base.js";

export type ContactRow = typeof contactsTable.$inferSelect;

// ── Enrichment lookups. Event lookup excludes soft-deleted events.
export async function eventName(eventId: number) {
  const [r] = await db
    .select({ name: eventsTable.name })
    .from(eventsTable)
    .where(and(eq(eventsTable.id, eventId), notDeleted(eventsTable.deletedAt)))
    .limit(1);
  return r;
}

export async function assigneeName(userId: number) {
  const [r] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return r;
}

// Batch event-name lookup for listContacts enrichment (O(1) query, not O(N)).
// Mirrors eventName(): soft-deleted events excluded so a contact never resolves
// a name from a deleted event.
export async function eventNamesByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db
    .select({ id: eventsTable.id, name: eventsTable.name })
    .from(eventsTable)
    .where(and(inArray(eventsTable.id, ids), notDeleted(eventsTable.deletedAt)));
}

export interface ListContactsOpts {
  search?: string;
  status?: string;
  temperature?: string;
  eventId?: number;
  assignedToId?: number;
  excludeDuplicates: boolean;
  followUp?: "has" | "none";
  scheduledMeetingOnly: boolean;
  dateFrom?: string;
  dateTo?: string;
  sort?: string;
  limit: number;
  offset: number;
}

// Tenant-scoped, soft-delete-excluding list with the full filter surface.
export async function list(user: AuthUser, opts: ListContactsOpts): Promise<{ rows: ContactRow[]; total: number }> {
  const extra: Array<SQL | undefined> = [];
  if (opts.search) extra.push(ilike(contactsTable.fullName, `%${opts.search}%`));
  if (opts.status) extra.push(eq(contactsTable.status, opts.status));
  if (opts.temperature) extra.push(eq(contactsTable.leadTemperature, opts.temperature));
  if (opts.eventId !== undefined) extra.push(eq(contactsTable.eventId, opts.eventId));
  if (opts.assignedToId !== undefined) extra.push(eq(contactsTable.assignedToId, opts.assignedToId));
  // Duplicate management: the main list shows originals only (duplicateOfId IS NULL).
  if (opts.excludeDuplicates) extra.push(isNull(contactsTable.duplicateOfId));
  if (opts.followUp === "has") extra.push(isNotNull(contactsTable.followUpDate));
  if (opts.followUp === "none") extra.push(isNull(contactsTable.followUpDate));
  if (opts.scheduledMeetingOnly) extra.push(inArray(contactsTable.id, db.select({ id: meetingsTable.contactId }).from(meetingsTable).where(eq(meetingsTable.status, "scheduled"))));
  if (opts.dateFrom) extra.push(sql`${contactsTable.createdAt} >= ${opts.dateFrom}`);
  if (opts.dateTo) extra.push(sql`${contactsTable.createdAt} <= ${opts.dateTo + " 23:59:59"}`);

  const whereClause = activeScope(user, contactsTable.companyId, contactsTable.deletedAt, { extra });
  const orderBy = opts.sort === "oldest" ? asc(contactsTable.createdAt)
    : opts.sort === "name" ? asc(contactsTable.fullName)
    : desc(contactsTable.createdAt);
  const [{ total }] = await db.select({ total: count() }).from(contactsTable).where(whereClause);
  const rows = await db.select().from(contactsTable).where(whereClause).limit(opts.limit).offset(opts.offset).orderBy(orderBy);
  return { rows, total };
}

export async function insert(values: typeof contactsTable.$inferInsert): Promise<ContactRow> {
  const [row] = await db.insert(contactsTable).values(values).returning();
  return row;
}

// Bulk import: insert many contacts atomically (whole batch commits or none).
// Chunked to keep a single INSERT's parameter count well under Postgres' 65535
// bound param limit. Returns rows in input order.
export async function bulkInsert(rows: (typeof contactsTable.$inferInsert)[], tx?: Executor): Promise<ContactRow[]> {
  if (rows.length === 0) return [];
  const run = async (e: Executor): Promise<ContactRow[]> => {
    const out: ContactRow[] = [];
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const inserted = await e.insert(contactsTable).values(rows.slice(i, i + CHUNK)).returning();
      out.push(...inserted);
    }
    return out;
  };
  return tx ? run(tx) : db.transaction(run);
}

export async function insertStatusHistory(values: typeof contactStatusHistoryTable.$inferInsert): Promise<void> {
  await db.insert(contactStatusHistoryTable).values(values);
}

// Candidate originals (same company, not a duplicate, not soft-deleted) for the
// scan-time auto-link match. The matching logic itself lives in the service.
export async function originalCandidates(companyId: number, excludeId: number): Promise<ContactRow[]> {
  return db
    .select()
    .from(contactsTable)
    .where(and(eq(contactsTable.companyId, companyId), isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt), ne(contactsTable.id, excludeId)))
    .limit(2000);
}

export async function linkAsDuplicate(id: number, originalId: number): Promise<ContactRow | undefined> {
  const [row] = await db.update(contactsTable).set({ duplicateOfId: originalId, updatedAt: new Date() }).where(eq(contactsTable.id, id)).returning();
  return row;
}

// Background AI score write — only applies while the row is still a live original.
// The deletedAt guard preserves the prior hard-delete parity: if the contact was
// deleted/merged-away before scoring finished, the update matches no row (so no
// stale score write and no hot-lead notification fires).
export async function updateScoreIfOriginal(id: number, data: Partial<typeof contactsTable.$inferInsert>): Promise<ContactRow | undefined> {
  const [row] = await db.update(contactsTable).set(data).where(and(eq(contactsTable.id, id), isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt))).returning();
  return row;
}

// Stats over originals only (duplicateOfId IS NULL), tenant-scoped, soft-delete excluded.
export async function stats(user: AuthUser, since: Date) {
  const statsWhere = activeScope(user, contactsTable.companyId, contactsTable.deletedAt, { extra: [isNull(contactsTable.duplicateOfId)] });
  const [{ total }] = await db.select({ total: count() }).from(contactsTable).where(statsWhere);
  const [today] = await db.select({ count: count() }).from(contactsTable).where(and(statsWhere, sql`${contactsTable.createdAt} >= ${since}`));
  const byStatus = await db.select({ status: contactsTable.status, count: count() }).from(contactsTable).where(statsWhere).groupBy(contactsTable.status);
  return { total, todayCount: today?.count ?? 0, byStatus };
}

// Linked duplicates (duplicateOfId IS NOT NULL), tenant-scoped, soft-delete excluded.
export async function duplicatesLinked(user: AuthUser): Promise<ContactRow[]> {
  const where = activeScope(user, contactsTable.companyId, contactsTable.deletedAt, { extra: [isNotNull(contactsTable.duplicateOfId)] });
  return db.select().from(contactsTable).where(where).limit(2000);
}

// Unlinked originals (duplicateOfId IS NULL), tenant-scoped, soft-delete excluded.
export async function duplicatesUnlinked(user: AuthUser): Promise<ContactRow[]> {
  const where = activeScope(user, contactsTable.companyId, contactsTable.deletedAt, { extra: [isNull(contactsTable.duplicateOfId)] });
  return db.select().from(contactsTable).where(where).limit(2000);
}

// Fetch a set of contacts by id (soft-deleted excluded). Used for the "originals"
// lookup in duplicate grouping and for merge duplicate validation.
export async function byIds(ids: number[]): Promise<ContactRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(contactsTable).where(and(inArray(contactsTable.id, ids), notDeleted(contactsTable.deletedAt)));
}

// Tenant-scoped, soft-delete-excluding single fetch (undefined for missing,
// deleted, or inaccessible).
export async function findById(user: AuthUser, id: number): Promise<ContactRow | undefined> {
  const where = activeScope(user, contactsTable.companyId, contactsTable.deletedAt, { extra: [eq(contactsTable.id, id)] });
  const [row] = await db.select().from(contactsTable).where(where).limit(1);
  return row;
}

// makeOriginal swap: re-point siblings, promote duplicate, demote old original.
export async function makeOriginalSwap(duplicateId: number, groupOriginalId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(contactsTable).set({ duplicateOfId: duplicateId, updatedAt: new Date() }).where(and(eq(contactsTable.duplicateOfId, groupOriginalId), ne(contactsTable.id, duplicateId)));
    await tx.update(contactsTable).set({ duplicateOfId: null, updatedAt: new Date() }).where(eq(contactsTable.id, duplicateId));
    await tx.update(contactsTable).set({ duplicateOfId: duplicateId, updatedAt: new Date() }).where(eq(contactsTable.id, groupOriginalId));
  });
}

// Merge: reassign FK-bearing scans/leads to the primary, update the primary,
// record the formal merge-history row, clean up the duplicates' custom-field
// values, then hard-delete the duplicates — all in ONE transaction so nothing is
// orphaned and the audit row is written atomically with the merge.
export async function mergeTransaction(
  primaryId: number,
  dupIds: number[],
  updates: Partial<typeof contactsTable.$inferInsert>,
  history: typeof mergeHistoryTable.$inferInsert,
): Promise<ContactRow> {
  return db.transaction(async (tx) => {
    await tx.update(scansTable).set({ contactId: primaryId }).where(inArray(scansTable.contactId, dupIds));
    await tx.update(leadsTable).set({ contactId: primaryId }).where(inArray(leadsTable.contactId, dupIds));
    const [updated] = await tx.update(contactsTable).set(updates).where(eq(contactsTable.id, primaryId)).returning();
    // Drop the merged-away contacts' custom-field values (their owner rows are
    // about to be hard-deleted; values have no soft-delete to preserve).
    await tx
      .delete(customFieldValuesTable)
      .where(and(eq(customFieldValuesTable.entityType, "contact"), inArray(customFieldValuesTable.entityId, dupIds)));
    await tx.insert(mergeHistoryTable).values(history);
    await tx.delete(contactsTable).where(inArray(contactsTable.id, dupIds));
    return updated;
  });
}

export async function update(id: number, data: Partial<typeof contactsTable.$inferInsert>): Promise<ContactRow | undefined> {
  const [row] = await db.update(contactsTable).set(data).where(eq(contactsTable.id, id)).returning();
  return row;
}

// Soft-delete. Replicates the prior onDelete cascade EXACTLY:
//  - meetings / follow_ups / contact_status_history (onDelete cascade) → delete
//  - leads.contactId / tasks.contactId / scans.contactId (onDelete set null) → null
// then stamps deletedAt.
export async function softDelete(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(meetingsTable).where(eq(meetingsTable.contactId, id));
    await tx.delete(followUpsTable).where(eq(followUpsTable.contactId, id));
    await tx.delete(contactStatusHistoryTable).where(eq(contactStatusHistoryTable.contactId, id));
    await tx.update(leadsTable).set({ contactId: null }).where(eq(leadsTable.contactId, id));
    await tx.update(tasksTable).set({ contactId: null }).where(eq(tasksTable.contactId, id));
    await tx.update(scansTable).set({ contactId: null }).where(eq(scansTable.contactId, id));
    await tx.update(contactsTable).set({ deletedAt: new Date() }).where(eq(contactsTable.id, id));
  });
}

export async function statusHistoryRows(contactId: number) {
  return db.select().from(contactStatusHistoryTable).where(eq(contactStatusHistoryTable.contactId, contactId)).orderBy(desc(contactStatusHistoryTable.createdAt));
}

export async function usersByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, ids));
}
