import { db, leadActivitiesTable, usersTable } from "@workspace/db";
import { and, eq, desc, gte, isNull, or, inArray, sql, type SQL } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, exec, type Executor } from "./base.js";

export type LeadActivityRow = typeof leadActivitiesTable.$inferSelect;
export type LeadActivityWithUser = Omit<LeadActivityRow, "updatedAt" | "deletedAt"> & { userName: string | null };

function selectWithUser() {
  return db
    .select({
      id: leadActivitiesTable.id,
      companyId: leadActivitiesTable.companyId,
      leadId: leadActivitiesTable.leadId,
      contactId: leadActivitiesTable.contactId,
      userId: leadActivitiesTable.userId,
      userName: usersTable.name,
      type: leadActivitiesTable.type,
      source: leadActivitiesTable.source,
      subject: leadActivitiesTable.subject,
      body: leadActivitiesTable.body,
      outcome: leadActivitiesTable.outcome,
      metadata: leadActivitiesTable.metadata,
      occurredAt: leadActivitiesTable.occurredAt,
      createdAt: leadActivitiesTable.createdAt,
    })
    .from(leadActivitiesTable)
    .leftJoin(usersTable, eq(leadActivitiesTable.userId, usersTable.id));
}

export async function listForLead(user: AuthUser, leadId: number): Promise<LeadActivityWithUser[]> {
  const where = activeScope(user, leadActivitiesTable.companyId, leadActivitiesTable.deletedAt, { extra: [eq(leadActivitiesTable.leadId, leadId)] });
  return selectWithUser().where(where).orderBy(desc(leadActivitiesTable.occurredAt), desc(leadActivitiesTable.id));
}

export async function listForContact(user: AuthUser, contactId: number): Promise<LeadActivityWithUser[]> {
  const where = activeScope(user, leadActivitiesTable.companyId, leadActivitiesTable.deletedAt, { extra: [eq(leadActivitiesTable.contactId, contactId)] });
  return selectWithUser().where(where).orderBy(desc(leadActivitiesTable.occurredAt), desc(leadActivitiesTable.id));
}

// Activities attached to ANY of an org's leads or contacts (Company Detail aggregate).
export async function listForOrg(user: AuthUser, leadIds: number[], contactIds: number[]): Promise<LeadActivityWithUser[]> {
  if (leadIds.length === 0 && contactIds.length === 0) return [];
  const targets: SQL[] = [];
  if (leadIds.length > 0) targets.push(inArray(leadActivitiesTable.leadId, leadIds));
  if (contactIds.length > 0) targets.push(inArray(leadActivitiesTable.contactId, contactIds));
  const where = activeScope(user, leadActivitiesTable.companyId, leadActivitiesTable.deletedAt, { extra: [or(...targets)!] });
  return selectWithUser().where(where).orderBy(desc(leadActivitiesTable.occurredAt), desc(leadActivitiesTable.id));
}

export async function findById(user: AuthUser, id: number): Promise<LeadActivityWithUser | undefined> {
  const where = activeScope(user, leadActivitiesTable.companyId, leadActivitiesTable.deletedAt, { extra: [eq(leadActivitiesTable.id, id)] });
  const [row] = await selectWithUser().where(where).limit(1);
  return row;
}

export async function getByIdWithUser(id: number): Promise<LeadActivityWithUser | undefined> {
  const [row] = await selectWithUser().where(eq(leadActivitiesTable.id, id)).limit(1);
  return row;
}

export async function insert(values: typeof leadActivitiesTable.$inferInsert, tx?: Executor): Promise<LeadActivityRow> {
  const [row] = await exec(tx).insert(leadActivitiesTable).values(values).returning();
  return row;
}

// Advisory-lock namespace for contact-note duplicate-window inserts (must not
// collide with DOC_VERSION_LOCK_NS 74013 / ALERT_LOCK_NS 5_600_012).
const CONTACT_NOTE_LOCK_NS = 74021;

// Idempotency guard for rapid double-submits of the same note (e.g. a double-clicked
// "Save as Note"): atomically checks for a live, identical note by the same author on
// the same contact created within the last `windowMs`, and inserts only if none exists.
// The per-contact advisory lock serializes concurrent saves so two identical requests
// cannot both pass the duplicate check and double-insert.
export async function insertContactNoteDedup(
  values: typeof leadActivitiesTable.$inferInsert & { contactId: number; userId: number; body: string },
  windowMs: number,
): Promise<{ row: LeadActivityRow; duplicate: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CONTACT_NOTE_LOCK_NS}, ${values.contactId})`);
    const since = new Date(Date.now() - windowMs);
    const [existing] = await tx
      .select()
      .from(leadActivitiesTable)
      .where(
        and(
          eq(leadActivitiesTable.companyId, values.companyId),
          eq(leadActivitiesTable.contactId, values.contactId),
          eq(leadActivitiesTable.userId, values.userId),
          eq(leadActivitiesTable.type, "note"),
          eq(leadActivitiesTable.body, values.body),
          isNull(leadActivitiesTable.deletedAt),
          gte(leadActivitiesTable.createdAt, since),
        ),
      )
      .orderBy(desc(leadActivitiesTable.id))
      .limit(1);
    if (existing) return { row: existing, duplicate: true };
    const [row] = await tx.insert(leadActivitiesTable).values(values).returning();
    return { row, duplicate: false };
  });
}

export async function updateRow(id: number, data: Partial<typeof leadActivitiesTable.$inferInsert>): Promise<void> {
  await db.update(leadActivitiesTable).set({ ...data, updatedAt: new Date() }).where(eq(leadActivitiesTable.id, id));
}

export async function softDelete(id: number): Promise<void> {
  await db.update(leadActivitiesTable).set({ deletedAt: new Date() }).where(eq(leadActivitiesTable.id, id));
}
