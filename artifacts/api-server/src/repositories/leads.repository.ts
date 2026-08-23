import { db, leadsTable, leadHistoryTable, contactsTable, usersTable, eventsTable, pipelineStagesTable, teamsTable, assignmentCursorsTable } from "@workspace/db";
import { eq, and, count, ne, desc, asc, inArray, sql } from "drizzle-orm";
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

// 409 conflict check: does this contact already have an OPEN, non-deleted lead
// in this company? Returns the existing open lead id, else undefined.
//
// CLOSED is determined by the tenant's CONFIGURED stage flags (isWon/isLost) —
// custom terminal stages like "closed_success" count as closed. Stages are
// resolved by the lead's stage KEY against the live (non-deleted) configured
// stages — the same rule getPipeline uses — so legacy rows with a NULL or
// stale stageId still classify by flags when their key matches a live stage.
// The literal "won"/"lost" text is only a fallback for keys that resolve to no
// live configured stage (including soft-deleted ones). `excludeLeadId` lets
// the reopen check ignore the lead being reopened itself.
export async function activeLeadIdForContact(
  companyId: number,
  contactId: number,
  excludeLeadId?: number,
): Promise<number | undefined> {
  const closedExpr = sql<boolean>`CASE
    WHEN ${pipelineStagesTable.id} IS NOT NULL THEN (${pipelineStagesTable.isWon} OR ${pipelineStagesTable.isLost})
    ELSE ${leadsTable.stage} IN ('won', 'lost')
  END`;
  const conds = [
    eq(leadsTable.contactId, contactId),
    eq(leadsTable.companyId, companyId),
    notDeleted(leadsTable.deletedAt),
    sql`NOT (${closedExpr})`,
  ];
  if (excludeLeadId != null) conds.push(ne(leadsTable.id, excludeLeadId));
  const [row] = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .leftJoin(
      pipelineStagesTable,
      and(
        eq(pipelineStagesTable.companyId, leadsTable.companyId),
        eq(pipelineStagesTable.key, leadsTable.stage),
        notDeleted(pipelineStagesTable.deletedAt),
      ),
    )
    .where(and(...conds))
    .limit(1);
  return row?.id;
}

// Stage 5E recognition: non-deleted lead counts per contact, tenant-scoped.
// Used to flag "existing lead" on capture-time contact matches. Read-only.
export async function leadCountsByContactIds(companyId: number, contactIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (contactIds.length === 0) return out;
  const rows = await db
    .select({ contactId: leadsTable.contactId, n: count() })
    .from(leadsTable)
    .where(and(eq(leadsTable.companyId, companyId), inArray(leadsTable.contactId, contactIds), notDeleted(leadsTable.deletedAt)))
    .groupBy(leadsTable.contactId);
  for (const r of rows) if (r.contactId != null) out.set(r.contactId, Number(r.n));
  return out;
}

export async function insert(values: typeof leadsTable.$inferInsert): Promise<LeadRow> {
  const [row] = await db.insert(leadsTable).values(values).returning();
  return row;
}

// Bulk import: insert many leads atomically (whole batch commits or none).
// Chunked to stay under Postgres' bound-parameter limit. Returns rows in order.
export async function bulkInsert(rows: (typeof leadsTable.$inferInsert)[], tx?: Executor): Promise<LeadRow[]> {
  if (rows.length === 0) return [];
  const run = async (e: Executor): Promise<LeadRow[]> => {
    const out: LeadRow[] = [];
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const inserted = await e.insert(leadsTable).values(rows.slice(i, i + CHUNK)).returning();
      out.push(...inserted);
    }
    return out;
  };
  return tx ? run(tx) : db.transaction(run);
}

// Bulk import: resolve existing contacts by normalized email within a company.
// Returns a map of lowercased email → contactId for linking imported leads to
// their contacts. Excludes soft-deleted contacts.
export async function contactIdsByEmails(companyId: number, emails: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (emails.length === 0) return map;
  const rows = await db
    .select({ id: contactsTable.id, email: contactsTable.email })
    .from(contactsTable)
    .where(and(eq(contactsTable.companyId, companyId), notDeleted(contactsTable.deletedAt), inArray(contactsTable.email, emails)));
  for (const r of rows) {
    if (r.email) {
      const key = r.email.trim().toLowerCase();
      if (!map.has(key)) map.set(key, r.id);
    }
  }
  return map;
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

// ── Configurable-stage + team enrichment lookups (additive).
// Both resolve LIVE stages only: a soft-deleted stage is not a configured
// stage, so it must never supply authoritative isWon/isLost flags (callers
// fall back to the legacy literal won/lost rule when nothing resolves).
export async function stageInfo(stageId: number) {
  const [r] = await db
    .select({
      id: pipelineStagesTable.id,
      name: pipelineStagesTable.name,
      key: pipelineStagesTable.key,
      isWon: pipelineStagesTable.isWon,
      isLost: pipelineStagesTable.isLost,
    })
    .from(pipelineStagesTable)
    .where(and(eq(pipelineStagesTable.id, stageId), notDeleted(pipelineStagesTable.deletedAt)))
    .limit(1);
  return r;
}

export async function stageInfosByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db
    .select({ id: pipelineStagesTable.id, name: pipelineStagesTable.name, key: pipelineStagesTable.key })
    .from(pipelineStagesTable)
    .where(and(inArray(pipelineStagesTable.id, ids), notDeleted(pipelineStagesTable.deletedAt)));
}

export async function teamName(teamId: number) {
  const [r] = await db.select({ name: teamsTable.name }).from(teamsTable).where(eq(teamsTable.id, teamId)).limit(1);
  return r;
}

export async function teamNamesByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db.select({ id: teamsTable.id, name: teamsTable.name }).from(teamsTable).where(inArray(teamsTable.id, ids));
}

// Round-robin-by-load auto-assignment: returns the active, non-deleted member of
// the given team (in the given company) with the fewest OPEN (non-won/lost) leads.
export async function leastLoadedTeamMember(companyId: number, teamId: number): Promise<number | undefined> {
  const members = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.companyId, companyId), eq(usersTable.teamId, teamId), eq(usersTable.isActive, true), notDeleted(usersTable.deletedAt)));
  if (members.length === 0) return undefined;
  const counts = await db
    .select({ assignedToId: leadsTable.assignedToId, total: count() })
    .from(leadsTable)
    .where(and(eq(leadsTable.companyId, companyId), notDeleted(leadsTable.deletedAt), ne(leadsTable.stage, "won"), ne(leadsTable.stage, "lost")))
    .groupBy(leadsTable.assignedToId);
  const countById = new Map<number, number>();
  for (const c of counts) if (c.assignedToId != null) countById.set(c.assignedToId, c.total);
  let best: number | undefined;
  let bestCount = Infinity;
  for (const m of members) {
    const c = countById.get(m.id) ?? 0;
    if (c < bestCount) {
      bestCount = c;
      best = m.id;
    }
  }
  return best;
}

// Open (non-won/lost, non-deleted) lead counts per assignee for a company.
async function openLeadCounts(companyId: number): Promise<Map<number, number>> {
  const counts = await db
    .select({ assignedToId: leadsTable.assignedToId, total: count() })
    .from(leadsTable)
    .where(and(eq(leadsTable.companyId, companyId), notDeleted(leadsTable.deletedAt), ne(leadsTable.stage, "won"), ne(leadsTable.stage, "lost")))
    .groupBy(leadsTable.assignedToId);
  const map = new Map<number, number>();
  for (const c of counts) if (c.assignedToId != null) map.set(c.assignedToId, c.total);
  return map;
}

// Availability-based auto-assignment: least-loaded member of a team that is BOTH
// account-active (isActive) AND currently available (employmentStatus === "active",
// i.e. not on_leave / suspended / offboarded / probation). Returns undefined when
// no available member exists.
export async function availableLeastLoadedMember(companyId: number, teamId: number): Promise<number | undefined> {
  const members = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.companyId, companyId), eq(usersTable.teamId, teamId), eq(usersTable.isActive, true), eq(usersTable.employmentStatus, "active"), notDeleted(usersTable.deletedAt)));
  if (members.length === 0) return undefined;
  const countById = await openLeadCounts(companyId);
  let best: number | undefined;
  let bestCount = Infinity;
  for (const m of members) {
    const c = countById.get(m.id) ?? 0;
    if (c < bestCount) { bestCount = c; best = m.id; }
  }
  return best;
}

// True round-robin assignment, race-safe. Serialized per (companyId, teamId) via
// a transaction-scoped Postgres advisory lock so concurrent assigns can't both
// pick the same slot. The rotation cursor is PERSISTENT: assignment_cursors holds
// a monotonic `position` per pool that is read, used (members[position % n]), and
// incremented inside the locked transaction. Unlike deriving the cursor from a
// lead count, this rotates strictly on every call — robust to reassignment,
// unassignment, and lead deletion. The lock + cursor read/increment + update all
// run in ONE transaction so the next caller sees this write.
export async function assignByRoundRobin(
  companyId: number,
  teamId: number,
  leadId: number,
  makeHistory: (assigneeId: number) => Array<typeof leadHistoryTable.$inferInsert>,
): Promise<{ lead: LeadRow; assigneeId: number } | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${companyId}, ${teamId})`);
    const members = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.companyId, companyId), eq(usersTable.teamId, teamId), eq(usersTable.isActive, true), notDeleted(usersTable.deletedAt)))
      .orderBy(asc(usersTable.id));
    if (members.length === 0) return undefined;
    // Read the current rotation position for this pool (0 if the pool has never
    // been used), pick the member at that slot, then persist position+1.
    const [cursor] = await tx
      .select({ position: assignmentCursorsTable.position })
      .from(assignmentCursorsTable)
      .where(and(eq(assignmentCursorsTable.companyId, companyId), eq(assignmentCursorsTable.teamId, teamId)));
    const position = cursor?.position ?? 0;
    const assigneeId = members[position % members.length].id;
    await tx
      .insert(assignmentCursorsTable)
      .values({ companyId, teamId, position: position + 1 })
      .onConflictDoUpdate({
        target: [assignmentCursorsTable.companyId, assignmentCursorsTable.teamId],
        set: { position: position + 1 },
      });
    const historyRows = makeHistory(assigneeId);
    if (historyRows.length > 0) await tx.insert(leadHistoryTable).values(historyRows);
    const [lead] = await tx.update(leadsTable).set({ assignedToId: assigneeId, teamId }).where(eq(leadsTable.id, leadId)).returning();
    return lead ? { lead, assigneeId } : undefined;
  });
}

// Candidate assignees for AI recommendation / load display: active members of a
// team (or the whole company when teamId is null), each with their open-lead load.
export interface AssignmentCandidateRow { id: number; name: string; jobTitle: string | null; openLeads: number }
export async function assignmentCandidates(companyId: number, teamId?: number | null): Promise<AssignmentCandidateRow[]> {
  const conds = [eq(usersTable.companyId, companyId), eq(usersTable.isActive, true), notDeleted(usersTable.deletedAt)];
  if (teamId != null) conds.push(eq(usersTable.teamId, teamId));
  const members = await db
    .select({ id: usersTable.id, name: usersTable.name, jobTitle: usersTable.jobTitle })
    .from(usersTable)
    .where(and(...conds))
    .orderBy(asc(usersTable.id));
  if (members.length === 0) return [];
  const countById = await openLeadCounts(companyId);
  return members.map((m) => ({ id: m.id, name: m.name, jobTitle: m.jobTitle ?? null, openLeads: countById.get(m.id) ?? 0 }));
}

// Contact attributes used for territory matching + AI assignment context.
export async function contactForAssignment(contactId: number) {
  const [r] = await db
    .select({
      fullName: contactsTable.fullName,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
      contactCompany: contactsTable.contactCompany,
      jobTitle: contactsTable.jobTitle,
      email: contactsTable.email,
      country: contactsTable.country,
      industry: contactsTable.industry,
    })
    .from(contactsTable)
    .where(and(eq(contactsTable.id, contactId), notDeleted(contactsTable.deletedAt)))
    .limit(1);
  return r;
}
