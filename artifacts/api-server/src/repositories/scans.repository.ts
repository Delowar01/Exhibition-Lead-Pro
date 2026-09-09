import { db, scansTable, companiesTable, usersTable, eventsTable, contactsTable } from "@workspace/db";
import { eq, count, sql, and, inArray, isNull, desc } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { tenantOnly, notDeleted } from "./base.js";

export type ScanRow = typeof scansTable.$inferSelect;

// Tenant-scoped list, soft-deleted rows excluded.
export async function list(user: AuthUser, opts: { limit: number; offset: number }): Promise<{ rows: ScanRow[]; total: number }> {
  const where = tenantOnly(user, scansTable.companyId, notDeleted(scansTable.deletedAt));
  const [{ total }] = await db.select({ total: count() }).from(scansTable).where(where);
  const rows = await db.select().from(scansTable).where(where).limit(opts.limit).offset(opts.offset).orderBy(scansTable.createdAt);
  return { rows, total };
}

// Stage 5E duplicate-card recognition: recent completed scans (newest first),
// tenant-scoped, with just the fields needed to compare extracted identifiers.
export async function recentCompleted(
  user: AuthUser,
  limit: number,
): Promise<Array<{ id: number; extractedData: string | null; createdAt: Date }>> {
  const where = tenantOnly(user, scansTable.companyId, and(eq(scansTable.status, "completed"), notDeleted(scansTable.deletedAt)));
  return db
    .select({ id: scansTable.id, extractedData: scansTable.extractedData, createdAt: scansTable.createdAt })
    .from(scansTable)
    .where(where)
    .orderBy(sql`${scansTable.createdAt} DESC`)
    .limit(limit);
}

// Tenant-scoped single fetch. Returns undefined when the row does not exist, is
// soft-deleted, or is not accessible to the caller (all map to a 404 in the service).
export async function findById(user: AuthUser, id: number): Promise<ScanRow | undefined> {
  const where = tenantOnly(user, scansTable.companyId, and(eq(scansTable.id, id), notDeleted(scansTable.deletedAt)));
  const [row] = await db.select().from(scansTable).where(where).limit(1);
  return row;
}

// ── Interaction model ────────────────────────────────────────────────────────
export type InteractionRow = ScanRow & { userName: string | null; eventName: string | null };

// Full interaction (capture) history for one contact, newest first, with the
// employee + event names resolved. Tenant scoping is done by the caller via the
// contact fetch; the query itself is companyId-scoped for defense in depth.
export async function interactionsForContact(companyId: number, contactId: number): Promise<InteractionRow[]> {
  const rows = await db
    .select({ scan: scansTable, userName: usersTable.name, eventName: eventsTable.name })
    .from(scansTable)
    .leftJoin(usersTable, eq(scansTable.userId, usersTable.id))
    .leftJoin(eventsTable, eq(scansTable.eventId, eventsTable.id))
    .where(and(eq(scansTable.companyId, companyId), eq(scansTable.contactId, contactId), notDeleted(scansTable.deletedAt)))
    .orderBy(desc(scansTable.createdAt));
  return rows.map((r) => ({ ...r.scan, userName: r.userName ?? null, eventName: r.eventName ?? null }));
}

// Interaction summary for one contact: count, last date, distinct event names
// (newest first). Used for the existing-contact-found (409) payload.
export async function interactionSummary(companyId: number, contactId: number): Promise<{ count: number; lastAt: Date | null; eventNames: string[] }> {
  const rows = await db
    .select({ createdAt: scansTable.createdAt, eventName: eventsTable.name })
    .from(scansTable)
    .leftJoin(eventsTable, eq(scansTable.eventId, eventsTable.id))
    .where(and(eq(scansTable.companyId, companyId), eq(scansTable.contactId, contactId), notDeleted(scansTable.deletedAt)))
    .orderBy(desc(scansTable.createdAt));
  const eventNames = [...new Set(rows.map((r) => r.eventName).filter((n): n is string => n != null))];
  return { count: rows.length, lastAt: rows[0]?.createdAt ?? null, eventNames };
}

// Organization interaction stats across a set of contact ids: total interactions,
// distinct events attended, last interaction date, and the org's people most
// recently met (per-contact latest interaction, newest first).
export async function orgInteractionStats(companyId: number, contactIds: number[]): Promise<{
  interactionCount: number;
  eventsAttended: number;
  lastInteractionDate: Date | null;
  recentEmployeesMet: Array<{ contactId: number; fullName: string | null; jobTitle: string | null; lastInteractionDate: Date | null }>;
}> {
  if (contactIds.length === 0) return { interactionCount: 0, eventsAttended: 0, lastInteractionDate: null, recentEmployeesMet: [] };
  const base = and(eq(scansTable.companyId, companyId), inArray(scansTable.contactId, contactIds), notDeleted(scansTable.deletedAt));
  const [agg] = await db
    .select({
      interactionCount: count(),
      eventsAttended: sql<number>`count(distinct ${scansTable.eventId})`,
      lastInteractionDate: sql<Date | null>`max(${scansTable.createdAt})`,
    })
    .from(scansTable)
    .where(base);
  const recent = await db
    .select({
      contactId: scansTable.contactId,
      fullName: contactsTable.fullName,
      jobTitle: contactsTable.jobTitle,
      lastInteractionDate: sql<Date | null>`max(${scansTable.createdAt})`,
    })
    .from(scansTable)
    .innerJoin(contactsTable, eq(scansTable.contactId, contactsTable.id))
    .where(and(base, isNull(contactsTable.deletedAt)))
    .groupBy(scansTable.contactId, contactsTable.fullName, contactsTable.jobTitle)
    .orderBy(sql`max(${scansTable.createdAt}) DESC`)
    .limit(5);
  return {
    interactionCount: agg?.interactionCount ?? 0,
    eventsAttended: Number(agg?.eventsAttended ?? 0),
    lastInteractionDate: agg?.lastInteractionDate ? new Date(agg.lastInteractionDate) : null,
    recentEmployeesMet: recent.map((r) => ({
      contactId: r.contactId!,
      fullName: r.fullName,
      jobTitle: r.jobTitle,
      lastInteractionDate: r.lastInteractionDate ? new Date(r.lastInteractionDate) : null,
    })),
  };
}

// Link an existing scan to a contact as its permanent interaction record.
// Tenant-guarded: only updates a scan in the same company that is not deleted.
export async function linkScanToContact(companyId: number, scanId: number, contactId: number, extra?: Partial<typeof scansTable.$inferInsert>): Promise<ScanRow | undefined> {
  const [row] = await db
    .update(scansTable)
    .set({ contactId, ...(extra ?? {}) })
    .where(and(eq(scansTable.id, scanId), eq(scansTable.companyId, companyId), notDeleted(scansTable.deletedAt)))
    .returning();
  return row;
}

// Batch 20: the legacy companies.scans_used counter is DEPRECATED — scan usage is
// measured from scan rows + usage reservations by the entitlement service.

export async function insert(values: typeof scansTable.$inferInsert): Promise<ScanRow> {
  const [row] = await db.insert(scansTable).values(values).returning();
  return row;
}

export async function update(id: number, data: Partial<typeof scansTable.$inferInsert>): Promise<ScanRow | undefined> {
  const [row] = await db.update(scansTable).set(data).where(eq(scansTable.id, id)).returning();
  return row;
}

export async function setImageUrl(scanId: number, objectKey: string): Promise<void> {
  await db.update(scansTable).set({ imageUrl: objectKey }).where(eq(scansTable.id, scanId));
}
