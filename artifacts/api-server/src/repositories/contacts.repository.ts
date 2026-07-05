import {
  db,
  contactsTable,
  usersTable,
  eventsTable,
  scansTable,
  leadsTable,
  leadNotesTable,
  leadActivitiesTable,
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

// Per-dup child-row ids captured at merge time, keyed by child table then by the
// stringified duplicate contactId → the row ids that were reassigned. Persisted
// in the merge snapshot so undo can re-point EXACTLY those rows back.
export type MergeChildRefs = Record<string, Record<string, number[]>>;
export type CustomFieldValueRow = typeof customFieldValuesTable.$inferSelect;

function groupByContact(rows: Array<{ id: number; contactId: number | null }>): Record<string, number[]> {
  const m: Record<string, number[]> = {};
  for (const r of rows) if (r.contactId != null) (m[String(r.contactId)] ??= []).push(r.id);
  return m;
}

// Merge: reassign EVERY FK-bearing child (scans, leads, lead_notes, tasks,
// lead_activities, follow_ups, meetings, contact_status_history) from the
// duplicates to the primary, update the primary, capture a full pre-merge
// snapshot (primary + dup rows + per-dup child ids + dup custom-field values),
// record the formal merge-history row, delete the duplicates' custom-field values
// (preserved in the snapshot for undo), then hard-delete the duplicates — all in
// ONE transaction so nothing is orphaned and undo can fully reverse it.
export async function mergeTransaction(
  primaryId: number,
  dupIds: number[],
  updates: Partial<typeof contactsTable.$inferInsert>,
  buildHistory: (snap: { childRefs: MergeChildRefs; customFieldValues: CustomFieldValueRow[] }) => typeof mergeHistoryTable.$inferInsert,
): Promise<ContactRow> {
  return db.transaction(async (tx) => {
    // 1. Capture which child rows belong to which dup (for exact undo re-pointing).
    const childRefs: MergeChildRefs = {
      scans: groupByContact(await tx.select({ id: scansTable.id, contactId: scansTable.contactId }).from(scansTable).where(inArray(scansTable.contactId, dupIds))),
      leads: groupByContact(await tx.select({ id: leadsTable.id, contactId: leadsTable.contactId }).from(leadsTable).where(inArray(leadsTable.contactId, dupIds))),
      leadNotes: groupByContact(await tx.select({ id: leadNotesTable.id, contactId: leadNotesTable.contactId }).from(leadNotesTable).where(inArray(leadNotesTable.contactId, dupIds))),
      tasks: groupByContact(await tx.select({ id: tasksTable.id, contactId: tasksTable.contactId }).from(tasksTable).where(inArray(tasksTable.contactId, dupIds))),
      leadActivities: groupByContact(await tx.select({ id: leadActivitiesTable.id, contactId: leadActivitiesTable.contactId }).from(leadActivitiesTable).where(inArray(leadActivitiesTable.contactId, dupIds))),
      followUps: groupByContact(await tx.select({ id: followUpsTable.id, contactId: followUpsTable.contactId }).from(followUpsTable).where(inArray(followUpsTable.contactId, dupIds))),
      meetings: groupByContact(await tx.select({ id: meetingsTable.id, contactId: meetingsTable.contactId }).from(meetingsTable).where(inArray(meetingsTable.contactId, dupIds))),
      contactStatusHistory: groupByContact(await tx.select({ id: contactStatusHistoryTable.id, contactId: contactStatusHistoryTable.contactId }).from(contactStatusHistoryTable).where(inArray(contactStatusHistoryTable.contactId, dupIds))),
    };
    // 2. Capture dup custom-field values (about to be deleted) for undo.
    const customFieldValues = await tx.select().from(customFieldValuesTable).where(and(eq(customFieldValuesTable.entityType, "contact"), inArray(customFieldValuesTable.entityId, dupIds)));

    // 3. Reassign all children to the primary.
    await tx.update(scansTable).set({ contactId: primaryId }).where(inArray(scansTable.contactId, dupIds));
    await tx.update(leadsTable).set({ contactId: primaryId }).where(inArray(leadsTable.contactId, dupIds));
    await tx.update(leadNotesTable).set({ contactId: primaryId }).where(inArray(leadNotesTable.contactId, dupIds));
    await tx.update(tasksTable).set({ contactId: primaryId }).where(inArray(tasksTable.contactId, dupIds));
    await tx.update(leadActivitiesTable).set({ contactId: primaryId }).where(inArray(leadActivitiesTable.contactId, dupIds));
    await tx.update(followUpsTable).set({ contactId: primaryId }).where(inArray(followUpsTable.contactId, dupIds));
    await tx.update(meetingsTable).set({ contactId: primaryId }).where(inArray(meetingsTable.contactId, dupIds));
    await tx.update(contactStatusHistoryTable).set({ contactId: primaryId }).where(inArray(contactStatusHistoryTable.contactId, dupIds));

    // 4. Update the primary, delete dup CF values, record history, delete dups.
    const [updated] = await tx.update(contactsTable).set(updates).where(eq(contactsTable.id, primaryId)).returning();
    await tx.delete(customFieldValuesTable).where(and(eq(customFieldValuesTable.entityType, "contact"), inArray(customFieldValuesTable.entityId, dupIds)));
    await tx.insert(mergeHistoryTable).values(buildHistory({ childRefs, customFieldValues }));
    await tx.delete(contactsTable).where(inArray(contactsTable.id, dupIds));
    return updated;
  });
}

// Undo a merge: re-insert the deleted duplicate rows (with their original ids),
// re-point every captured child row back to its original dup, restore the
// primary's pre-merge field values, re-insert the dups' custom-field values, and
// stamp the merge-history row as undone — all in ONE transaction.
export async function undoMergeTransaction(opts: {
  historyId: number;
  primaryId: number;
  primaryRestore: Partial<typeof contactsTable.$inferInsert>;
  duplicates: Array<typeof contactsTable.$inferInsert & { id: number }>;
  childRefs: MergeChildRefs;
  customFieldValues: Array<typeof customFieldValuesTable.$inferInsert>;
  undoneById: number;
}): Promise<void> {
  const repoint = async (refs: Record<string, number[]> | undefined, update: (dupId: number, ids: number[]) => Promise<unknown>) => {
    for (const [dupId, ids] of Object.entries(refs ?? {})) {
      if (ids.length > 0) await update(Number(dupId), ids);
    }
  };
  await db.transaction(async (tx) => {
    if (opts.duplicates.length > 0) await tx.insert(contactsTable).values(opts.duplicates);
    await repoint(opts.childRefs.scans, (dupId, ids) => tx.update(scansTable).set({ contactId: dupId }).where(inArray(scansTable.id, ids)));
    await repoint(opts.childRefs.leads, (dupId, ids) => tx.update(leadsTable).set({ contactId: dupId }).where(inArray(leadsTable.id, ids)));
    await repoint(opts.childRefs.leadNotes, (dupId, ids) => tx.update(leadNotesTable).set({ contactId: dupId }).where(inArray(leadNotesTable.id, ids)));
    await repoint(opts.childRefs.tasks, (dupId, ids) => tx.update(tasksTable).set({ contactId: dupId }).where(inArray(tasksTable.id, ids)));
    await repoint(opts.childRefs.leadActivities, (dupId, ids) => tx.update(leadActivitiesTable).set({ contactId: dupId }).where(inArray(leadActivitiesTable.id, ids)));
    await repoint(opts.childRefs.followUps, (dupId, ids) => tx.update(followUpsTable).set({ contactId: dupId }).where(inArray(followUpsTable.id, ids)));
    await repoint(opts.childRefs.meetings, (dupId, ids) => tx.update(meetingsTable).set({ contactId: dupId }).where(inArray(meetingsTable.id, ids)));
    await repoint(opts.childRefs.contactStatusHistory, (dupId, ids) => tx.update(contactStatusHistoryTable).set({ contactId: dupId }).where(inArray(contactStatusHistoryTable.id, ids)));
    if (Object.keys(opts.primaryRestore).length > 0) await tx.update(contactsTable).set(opts.primaryRestore).where(eq(contactsTable.id, opts.primaryId));
    if (opts.customFieldValues.length > 0) await tx.insert(customFieldValuesTable).values(opts.customFieldValues);
    await tx.update(mergeHistoryTable).set({ undoneAt: new Date(), undoneById: opts.undoneById }).where(eq(mergeHistoryTable.id, opts.historyId));
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
